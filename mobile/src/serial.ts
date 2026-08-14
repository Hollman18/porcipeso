/**
 * Puente al plugin nativo local `PorciSerial` (mobile/android/app/src/
 * main/java/com/porcipeso/app/PorciSerialPlugin.java):
 *
 *  - Bluetooth: lista de EMPAREJADOS (getBondedDevices) + canal SPP CRUDO
 *    (bytes en base64). El plugin @e-is/capacitor-bluetooth-serial decodifica
 *    el stream como texto UTF-8 y destruye los bytes >= 0x80 — justamente los
 *    que produce una señal TTL invertida — así que la operación con
 *    `invert_bits` y el detector de polaridad usan ESTE canal crudo.
 *  - USB/OTG: enumeración + puerto serial vía usb-serial-for-android
 *    (mik3y), la librería de referencia para CDC/FTDI/CH340/PL2303/CP210x.
 *
 * Por qué plugin local y no uno de npm: capacitor-usb-serial (1.0.3) es un
 * wrapper de un solo mantenedor sobre la misma librería, @nexcom/usb-serial
 * no existe en npm y @adeunis/capacitor-serial exige Capacitor 7. El plugin
 * local usa usb-serial-for-android directo de Maven/JitPack (la vía más
 * sólida) y de paso expone lo que a @e-is le falta (emparejados + bytes
 * crudos).
 *
 * En web/escritorio el plugin no existe: todo degrada con error legible
 * ("disponible en la app Android") sin romper la UI.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

export interface PairedDevice {
  name: string;
  address: string;
}

export interface UsbDeviceInfo {
  deviceId: number;
  vid: number;
  pid: number;
  name: string;
  driver: string;
}

export interface PorciSerialPlugin {
  /** Bluetooth emparejados (BLUETOOTH_CONNECT runtime en Android 12+). */
  listPaired(): Promise<{ devices: PairedDevice[] }>;
  /**
   * Discovery clásico PROPIO de cercanos no emparejados (bug de campo
   * Xiaomi/MIUI: el scan() de @e-is no los surtía). startDiscovery inicia
   * el ciclo (~12 s); discoveryPoll devuelve el acumulado sin duplicados
   * + finished; cancelDiscovery lo corta (Buscar de nuevo = cancel+start).
   * Errores: "location_off" (Android ≤11 con Ubicación apagada),
   * "permission_denied", "bluetooth_off".
   */
  startDiscovery(): Promise<{ started: boolean }>;
  discoveryPoll(): Promise<{ devices: PairedDevice[]; finished: boolean }>;
  cancelDiscovery(): Promise<void>;
  /** Aviso accionable: abre los ajustes de Ubicación del sistema. */
  openLocationSettings(): Promise<void>;
  /** Canal SPP crudo: bytes sin decodificar (base64). */
  btConnect(o: { address: string }): Promise<void>;
  /**
   * Drena el buffer (base64) Y reporta el estado REAL del enlace: `connected`
   * cae a false en cuanto el socket muere (el driver reconecta sin depender de
   * una excepción). Opcional por compat con APKs anteriores al endurecimiento.
   */
  btRead(): Promise<{ data: string; connected?: boolean }>; // base64 + enlace
  /** Estado REAL del enlace SPP (socket abierto + hilo lector vivo). */
  btStatus(): Promise<{ connected: boolean }>;
  btDisconnect(): Promise<void>;
  /** Dispositivos USB serial conectados por OTG. */
  usbDevices(): Promise<{ devices: UsbDeviceInfo[] }>;
  usbConnect(o: {
    deviceId: number;
    baudRate: number;
    dataBits?: number;
    stopBits?: number;
    parity?: string; // N | E | O
  }): Promise<void>;
  usbRead(): Promise<{ data: string }>; // base64
  usbDisconnect(): Promise<void>;
}

const PorciSerial = registerPlugin<PorciSerialPlugin>("PorciSerial");

export function nativeSerialAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("PorciSerial");
}

export const NOT_ANDROID_MSG =
  "Esta función está disponible en la app Android (instalada en el teléfono).";

function requireNative(): PorciSerialPlugin {
  if (!nativeSerialAvailable()) throw new Error(NOT_ANDROID_MSG);
  return PorciSerial;
}

export function base64ToBytes(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

/** Errores del plugin → mensaje en humano (permisos, BT apagado…). */
export const LOCATION_OFF_MSG =
  "Para buscar dispositivos cercanos, Android exige la Ubicación encendida — " +
  "actívala un momento y vuelve a buscar.";

export function humanizeSerialError(e: unknown): string {
  const raw = String(e instanceof Error ? e.message : e);
  if (/not implemented|unimplemented|not available on web/i.test(raw)) {
    return NOT_ANDROID_MSG;
  }
  if (/location_off/i.test(raw)) {
    return LOCATION_OFF_MSG;
  }
  if (/permission|permiso|denied/i.test(raw)) {
    return (
      "Permiso de Bluetooth denegado. Ve a Ajustes → Aplicaciones → PorciPeso → " +
      "Permisos y activa «Dispositivos cercanos» (en Android 11 o menos: «Ubicación»)."
    );
  }
  if (/bluetooth_off|not enabled|disabled/i.test(raw)) {
    return "El Bluetooth del teléfono está apagado — enciéndelo e intenta de nuevo.";
  }
  if (/usb_permission/i.test(raw)) {
    return "No autorizaste el acceso al dispositivo USB. Conéctalo de nuevo y acepta el permiso.";
  }
  if (/no_device|not found/i.test(raw)) {
    return "No encuentro el dispositivo. Revisa que siga conectado/emparejado.";
  }
  return raw;
}

// ------------------------------------------------------------ transportes

/** Estado REAL de un enlace de transporte (para el indicador HONESTO). */
export type LinkStatus = "connecting" | "connected" | "reconnecting" | "closed";

/**
 * Transporte de BYTES: mismo rol que porcipeso/drivers/transports.py.
 * read() drena lo disponible (puede devolver vacío); nunca bloquea largo.
 */
export interface ByteTransport {
  readonly label: string;
  open(): Promise<void>;
  read(): Promise<Uint8Array>;
  close(): Promise<void>;
  /** Estado del enlace (opcional): el driver lo expone para el indicador. */
  status?(): LinkStatus;
}

const EMPTY_BYTES = new Uint8Array(0);

/** Backoff de reconexión (ms): 0.5→1→2→5 s; el último se repite indefinido. */
export const DEFAULT_BACKOFF_MS = [500, 1000, 2000, 5000];
/** Sin un solo byte por más de esto aunque "conectado" → enlace zombi. */
export const DEFAULT_NO_DATA_TIMEOUT_MS = 4000;
/** Fallos de btRead seguidos que disparan reconexión. */
export const DEFAULT_MAX_READ_FAILS = 3;

/** Resiliencia del SPP (inyectable en tests). */
export interface RawBtOptions {
  plugin?: PorciSerialPlugin;
  backoffMs?: number[];
  noDataTimeoutMs?: number;
  maxReadFails?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Aviso de cambio de estado del enlace (logs/UI). */
  onStatus?: (status: LinkStatus) => void;
}

/**
 * SPP crudo vía plugin local (bytes intactos, apto para señal invertida) CON
 * RECONEXIÓN AUTOMÁTICA TRANSPARENTE. En campo el HC-05/BC04 pierde el socket
 * (alimentación floja que reinicia el módulo, el celular se aleja, ruido): sin
 * esto el driver dejaba de leer y no reintentaba ("no toma bien los datos").
 *
 * Ahora read() NUNCA lanza por una caída: si el socket muere (el plugin
 * reporta connected=false), si no llegan bytes en X s aunque "conectado", o si
 * btRead falla N veces seguidas, el transporte cierra limpio y REINTENTA
 * conectar al MISMO dispositivo con backoff, indefinidamente, hasta lograrlo o
 * hasta que el usuario desconecte. El parser vive por ENCIMA (SerialScaleDriver)
 * y es tolerante a fragmentación, así que no se pierden bytes entre reintentos.
 */
export class RawBtTransport implements ByteTransport {
  readonly label: string;
  private plugin: PorciSerialPlugin;
  private linkStatus: LinkStatus = "connecting";
  private lastDataAt = 0;
  private readFails = 0;
  private reconnecting = false;

  private readonly backoffMs: number[];
  private readonly noDataTimeoutMs: number;
  private readonly maxReadFails: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onStatus: (status: LinkStatus) => void;

  constructor(private address: string, opts: RawBtOptions | PorciSerialPlugin = {}) {
    this.label = `bluetooth ${address}`;
    // Compat: el 2º arg histórico era el plugin directo (new RawBtTransport(a, plugin)).
    const o: RawBtOptions =
      opts && typeof (opts as PorciSerialPlugin).btConnect === "function"
        ? { plugin: opts as PorciSerialPlugin }
        : (opts as RawBtOptions);
    this.plugin = o.plugin ?? requireNative();
    this.backoffMs = o.backoffMs && o.backoffMs.length ? o.backoffMs : DEFAULT_BACKOFF_MS;
    this.noDataTimeoutMs = o.noDataTimeoutMs ?? DEFAULT_NO_DATA_TIMEOUT_MS;
    this.maxReadFails = o.maxReadFails ?? DEFAULT_MAX_READ_FAILS;
    this.now = o.now ?? (() => Date.now());
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onStatus = o.onStatus ?? (() => {});
  }

  status(): LinkStatus {
    return this.linkStatus;
  }

  private setStatus(s: LinkStatus): void {
    if (this.linkStatus === s) return;
    this.linkStatus = s;
    try {
      this.onStatus(s);
    } catch {
      /* un listener roto no rompe el enlace */
    }
  }

  async open(): Promise<void> {
    this.setStatus("connecting");
    await this.plugin.btConnect({ address: this.address });
    this.lastDataAt = this.now();
    this.readFails = 0;
    this.setStatus("connected");
  }

  async read(): Promise<Uint8Array> {
    // Mientras el enlace está caído/reconectando, el bucle de reconexión es el
    // ÚNICO dueño del socket: no competimos con btRead/btConnect.
    if (this.linkStatus === "closed" || this.reconnecting) return EMPTY_BYTES;
    try {
      const r = await this.plugin.btRead();
      const bytes = base64ToBytes(r.data ?? "");
      if (bytes.length) {
        this.lastDataAt = this.now();
        this.readFails = 0;
      }
      // El plugin nuevo informa el estado REAL del socket: si el hilo lector
      // nativo murió reconectamos aunque btRead no haya lanzado. (undefined =
      // APK viejo → se ignora este camino y queda el watchdog SIN DATOS.)
      if (r.connected === false) {
        this.triggerReconnect();
        return bytes; // no perdemos los últimos bytes drenados
      }
      this.readFails = 0;
      // Watchdog SIN DATOS: "conectado" pero sin un byte en X s → enlace zombi
      // (el SPP intermitente clásico); forzamos reconexión limpia.
      if (!bytes.length && this.now() - this.lastDataAt > this.noDataTimeoutMs) {
        this.triggerReconnect();
      }
      return bytes;
    } catch {
      // Fallo puntual del puente: uno no tumba el enlace; N seguidos sí.
      if (++this.readFails >= this.maxReadFails) this.triggerReconnect();
      return EMPTY_BYTES;
    }
  }

  private triggerReconnect(): void {
    if (this.reconnecting || this.linkStatus === "closed") return;
    this.reconnecting = true;
    this.setStatus("reconnecting");
    void this.reconnectLoop();
  }

  /**
   * Reintenta conectar al MISMO dispositivo con backoff, indefinidamente, hasta
   * lograrlo o hasta que el usuario desconecte (close() → "closed"). Cierra
   * limpio antes de cada intento para no acumular sockets zombis.
   */
  private async reconnectLoop(): Promise<void> {
    let attempt = 0;
    // this.status() (no la propiedad) para que el narrowing de TS no descarte
    // "closed": close() puede cambiarlo DURANTE los await de este bucle.
    while (this.status() !== "closed") {
      try {
        await this.plugin.btDisconnect();
      } catch {
        /* ya caído */
      }
      const wait = this.backoffMs[Math.min(attempt, this.backoffMs.length - 1)];
      await this.sleep(wait);
      if (this.status() === "closed") break;
      try {
        await this.plugin.btConnect({ address: this.address });
        this.lastDataAt = this.now();
        this.readFails = 0;
        this.reconnecting = false;
        this.setStatus("connected");
        return;
      } catch {
        attempt++;
      }
    }
    this.reconnecting = false;
  }

  async close(): Promise<void> {
    this.setStatus("closed");
    this.reconnecting = false;
    try {
      await this.plugin.btDisconnect();
    } catch {
      /* ya cerrado */
    }
  }
}

export interface UsbOpenParams {
  deviceId: number;
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: string;
}

/** Serial USB/OTG vía plugin local. */
export class UsbTransport implements ByteTransport {
  readonly label: string;
  private plugin: PorciSerialPlugin;

  constructor(private params: UsbOpenParams, plugin?: PorciSerialPlugin) {
    this.label = `usb #${params.deviceId} @${params.baudRate}`;
    this.plugin = plugin ?? requireNative();
  }

  async open(): Promise<void> {
    await this.plugin.usbConnect({
      deviceId: this.params.deviceId,
      baudRate: this.params.baudRate,
      dataBits: this.params.dataBits ?? 8,
      stopBits: this.params.stopBits ?? 1,
      parity: this.params.parity ?? "N",
    });
  }

  async read(): Promise<Uint8Array> {
    const r = await this.plugin.usbRead();
    return base64ToBytes(r.data ?? "");
  }

  async close(): Promise<void> {
    try {
      await this.plugin.usbDisconnect();
    } catch {
      /* ya cerrado */
    }
  }
}

// ------------------------------------------------------- listados (shim)

export interface BtDeviceInfo {
  name: string;
  address: string;
  paired: boolean;
}

/**
 * EMPAREJADOS (getBondedDevices, instantáneo) → GET /api/bt/devices.
 * Los CERCANOS ya no salen de aquí: van llegando EN VIVO por el discovery
 * propio del plugin (startDiscovery/discoveryPoll — ver mergeBtDevices).
 */
export async function listBtDevices(): Promise<BtDeviceInfo[]> {
  const res = await requireNative().listPaired(); // puede lanzar: permiso denegado
  return (res.devices ?? [])
    .map((d) => ({ name: d.name ?? "", address: d.address, paired: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Arranca el ciclo de discovery nativo (cancel implícito del anterior). */
export async function startBtDiscovery(): Promise<void> {
  await requireNative().startDiscovery();
}

export async function pollBtDiscovery(): Promise<{
  devices: PairedDevice[];
  finished: boolean;
}> {
  const res = await requireNative().discoveryPoll();
  return { devices: res.devices ?? [], finished: Boolean(res.finished) };
}

export async function cancelBtDiscovery(): Promise<void> {
  await requireNative().cancelDiscovery();
}

export async function openLocationSettings(): Promise<void> {
  await requireNative().openLocationSettings();
}

/**
 * Merge EN VIVO emparejados + cercanos, sin duplicados por MAC, con los
 * sin nombre como "Dispositivo BT (MAC)". Emparejados primero, luego los
 * cercanos en orden de hallazgo. Puro → testeable en vitest.
 */
export function mergeBtDevices(
  paired: Array<{ name?: string; address: string }>,
  found: Array<{ name?: string; address: string }>,
): BtDeviceInfo[] {
  const out = new Map<string, BtDeviceInfo>();
  for (const d of paired) {
    if (!d?.address) continue;
    out.set(d.address, {
      name: d.name || `Dispositivo BT (${d.address})`,
      address: d.address,
      paired: true,
    });
  }
  for (const d of found) {
    if (!d?.address || out.has(d.address)) continue; // dedupe por MAC
    out.set(d.address, {
      name: d.name || `Dispositivo BT (${d.address})`,
      address: d.address,
      paired: false,
    });
  }
  return Array.from(out.values());
}

/** Clase Java del driver → nombre de chip que la gente reconoce. */
const DRIVER_CHIP: Record<string, string> = {
  Ch34xSerialDriver: "CH340/CH341",
  FtdiSerialDriver: "FTDI",
  Cp21xxSerialDriver: "CP210x",
  ProlificSerialDriver: "PL2303",
  CdcAcmSerialDriver: "CDC-ACM",
  ChromeCcdSerialDriver: "Chrome CCD",
  GsmModemSerialDriver: "GSM modem",
};

export async function listUsbDevices(): Promise<UsbDeviceInfo[]> {
  const res = await requireNative().usbDevices();
  return (res.devices ?? []).map((d) => ({
    ...d,
    driver: DRIVER_CHIP[d.driver] ?? d.driver,
  }));
}
