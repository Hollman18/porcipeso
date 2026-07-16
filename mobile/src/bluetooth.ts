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
 * Limitación del plugin: las notificaciones entregan Strings troceados
 * por un DELIMITADOR (readUntil interno, delimitador INCLUIDO al final
 * del chunk). Concatenar los chunks reproduce el stream byte a byte,
 * y nuestros parsers toleran fragmentación arbitraria, así que basta
 * elegir un delimitador que ocurra en el protocolo:
 *  - matrix / xk3190_a12e: '=' (inicio de cada trama de 8 bytes)
 *  - generic_regex: extra.line_terminator o '\n'
 * Ajustable por perfil con extra.bt_delimiter.
 */
import type { PluginListenerHandle } from "@capacitor/core";
import { Reading, ScaleProfile } from "./models";
import { FrameParser, isParserSupported, PARSER_REGISTRY, stringToBytes } from "./parsers";

export interface BtDevice {
  name: string;
  address: string;
}

type BluetoothSerialLike = {
  isEnabled(): Promise<{ enabled: boolean }>;
  enable(): Promise<{ enabled: boolean }>;
  scan(): Promise<{ devices: Array<{ name: string; address: string }> }>;
  connect(o: { address: string }): Promise<void>;
  disconnect(o: { address: string }): Promise<void>;
  isConnected(o: { address: string }): Promise<{ connected: boolean }>;
  startNotifications(o: { address: string; delimiter: string }): Promise<void>;
  stopNotifications(o: { address: string }): Promise<void>;
  addListener(
    eventName: "onRead",
    fn: (result: { value: string }) => void,
  ): Promise<PluginListenerHandle>;
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
  private listener: PluginListenerHandle | null = null;
  private connected = false;

  constructor(
    profile: ScaleProfile,
    address: string,
    onReading: (r: Reading) => void,
    onError: (msg: string) => void = () => {},
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
    const bt = await loadPlugin();
    const enabled = await bt.isEnabled();
    if (!enabled.enabled) await bt.enable();
    await bt.connect({ address: this.address });
    this.connected = true;
    this.listener = await bt.addListener("onRead", (result) => {
      try {
        const readings = this.parser.push(stringToBytes(result.value ?? ""));
        for (const r of readings) this.onReading(r);
      } catch (e) {
        this.onError(String(e));
      }
    });
    await bt.startNotifications({
      address: this.address,
      delimiter: delimiterFor(this.profile),
    });
  }

  async disconnect(): Promise<void> {
    const bt = await loadPlugin();
    try {
      await bt.stopNotifications({ address: this.address });
    } catch {
      /* ya detenidas */
    }
    if (this.listener) {
      await this.listener.remove();
      this.listener = null;
    }
    try {
      await bt.disconnect({ address: this.address });
    } catch {
      /* ya desconectado */
    }
    this.connected = false;
  }

  async isConnected(): Promise<boolean> {
    if (!this.connected) return false;
    try {
      const bt = await loadPlugin();
      const res = await bt.isConnected({ address: this.address });
      return res.connected;
    } catch {
      return false;
    }
  }
}
