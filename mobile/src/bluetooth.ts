/**
 * Captura por Bluetooth Clásico SPP — reemplaza al transporte serial de
 * porcipeso/drivers/transports.py en el teléfono.
 *
 * Plugin elegido: @e-is/capacitor-bluetooth-serial (v6.x).
 * Por qué:
 *  - Es el único plugin de Bluetooth CLÁSICO/SPP con releases activos
 *    para Capacitor 6 (los indicadores de peso usan SPP, no BLE, así
 *    que @capacitor-community/bluetooth-le NO sirve).
 *  - Mantenido por E-IS (fork institucional del capacitor-bluetooth-serial
 *    original, abandonado en Capacitor 2); versiona en lockstep con
 *    Capacitor (5.x/6.x) y declara los permisos Android 12+
 *    (BLUETOOTH_CONNECT/SCAN) en su manifest.
 *  - API suficiente: scan() (emparejados + descubrimiento), connect,
 *    startNotifications con delimitador y evento 'onRead'.
 *
 * Se usa `read()` por sondeo en vez de notificaciones delimitadas. Así
 * recibimos todo lo disponible aunque la trama sea fija, binaria, llegue
 * fragmentada o todavía no contenga CR/LF. Los parsers ya reconstruyen el
 * stream y resincronizan ante basura.
 */
import { Reading, ScaleProfile } from "./models";
import { FrameParser, isParserSupported, PARSER_REGISTRY, stringToBytes } from "./parsers";

export interface BtDevice {
  name: string;
  address: string;
}

export type BluetoothSerialLike = {
  isEnabled(): Promise<{ enabled: boolean }>;
  enable(): Promise<{ enabled: boolean }>;
  scan(): Promise<{ devices: Array<{ name: string; address: string }> }>;
  connect(o: { address: string }): Promise<void>;
  disconnect(o: { address: string }): Promise<void>;
  isConnected(o: { address: string }): Promise<{ connected: boolean }>;
  read(o: { address: string }): Promise<{ value: string }>;
};

async function loadPlugin(): Promise<BluetoothSerialLike> {
  const mod = await import("@e-is/capacitor-bluetooth-serial");
  return mod.BluetoothSerial as unknown as BluetoothSerialLike;
}

export function delimiterFor(profile: ScaleProfile): string {
  const custom = profile.extra["bt_delimiter"] as string | undefined;
  if (custom && custom.length) return custom;
  if (profile.parser === "matrix" || profile.parser === "xk3190_a12e") return "=";
  const term = profile.extra["line_terminator"] as string | undefined;
  return term && term.length ? term[term.length - 1] : "\n";
}

/**
 * Driver BT: conecta al indicador, trocea el stream con el parser del
 * perfil y entrega Reading normalizados — mismo rol que run_driver() en
 * porcipeso/drivers/runner.py.
 */
export class BluetoothScaleDriver {
  readonly profile: ScaleProfile;
  readonly address: string;
  private onReading: (r: Reading) => void;
  private onError: (msg: string) => void;
  private parser: FrameParser;
  private bt: BluetoothSerialLike | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pluginLoader: () => Promise<BluetoothSerialLike>;
  private corruptReported = false;
  private connected = false;

  constructor(
    profile: ScaleProfile,
    address: string,
    onReading: (r: Reading) => void,
    onError: (msg: string) => void = () => {},
    pluginLoader: () => Promise<BluetoothSerialLike> = loadPlugin,
  ) {
    if (!isParserSupported(profile.parser)) {
      throw new Error(
        `el perfil '${profile.id}' usa el parser '${profile.parser}', ` +
          "aún no soportado en la app móvil (soportados: " +
          Object.keys(PARSER_REGISTRY).join(", ") + ")",
      );
    }
    this.profile = profile;
    this.address = address;
    this.onReading = onReading;
    this.onError = onError;
    this.pluginLoader = pluginLoader;
    this.parser = new PARSER_REGISTRY[profile.parser](profile);
  }

  /** Lista dispositivos emparejados/visibles (requiere BLUETOOTH_SCAN). */
  static async listDevices(): Promise<BtDevice[]> {
    const bt = await loadPlugin();
    const enabled = await bt.isEnabled();
    if (!enabled.enabled) await bt.enable();
    const res = await bt.scan();
    return (res.devices ?? []).map((d) => ({ name: d.name ?? "", address: d.address }));
  }

  async connect(): Promise<void> {
    const bt = await this.pluginLoader();
    const enabled = await bt.isEnabled();
    if (!enabled.enabled) await bt.enable();
    await bt.connect({ address: this.address });
    this.bt = bt;
    this.connected = true;
    this.schedulePoll(0);
  }

  /**
   * `read()` vacía todo el buffer disponible y conserva la fragmentación real.
   * Es más robusto que las notificaciones del plugin, que no emiten nada hasta
   * encontrar un delimitador y por eso se bloquean con tramas fijas o corruptas.
   */
  private schedulePoll(delayMs = 40): void {
    if (!this.connected) return;
    this.pollTimer = setTimeout(() => void this.pollOnce(), delayMs);
  }

  private async pollOnce(): Promise<void> {
    const bt = this.bt;
    if (!this.connected || bt === null) return;
    try {
      const result = await bt.read({ address: this.address });
      const value = result.value ?? "";
      if (value.length) {
        // El plugin Android decodifica el UART como texto. U+FFFD significa que
        // recibió bytes no válidos: casi siempre baud/paridad RS-232 incorrectos.
        if (value.includes("\ufffd")) {
          if (!this.corruptReported) {
            this.corruptReported = true;
            this.onError(
              "Datos RS-232 ilegibles. El BLU2 y el indicador deben usar la misma " +
                `configuración serial (${this.profile.baudrate ?? 9600} baudios, ` +
                `${this.profile.bytesize ?? 8}${this.profile.parity ?? "N"}` +
                `${this.profile.stopbits ?? 1}). Charset no corrige este problema. ` +
                "También puede ser señal invertida: usa 🪄 Detectar en ⚙ Báscula.",
            );
          }
        } else {
          const readings = this.parser.push(stringToBytes(value));
          if (readings.length) this.corruptReported = false;
          for (const reading of readings) this.onReading(reading);
        }
      }
    } catch (e) {
      this.connected = false;
      this.onError(`Error leyendo Bluetooth: ${String(e)}`);
    } finally {
      this.schedulePoll();
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    const bt = this.bt ?? (await this.pluginLoader());
    try {
      await bt.disconnect({ address: this.address });
    } catch {
      /* ya desconectado */
    }
    this.bt = null;
  }

  async isConnected(): Promise<boolean> {
    if (!this.connected) return false;
    try {
      const bt = this.bt ?? (await this.pluginLoader());
      const res = await bt.isConnected({ address: this.address });
      return res.connected;
    } catch {
      return false;
    }
  }
}
