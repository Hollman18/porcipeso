/**
 * Bluetooth Low Energy (BLE) — transporte GATT-notify + scan, PARA convivir
 * con el Bluetooth Clásico SPP (serial.ts:RawBtTransport). Problema de campo:
 * el módulo del cliente es BLE (o dual-mode que solo ANUNCIA por BLE), la app
 * solo reconocía/conectaba dispositivos CLÁSICOS → lo veía cerca pero no
 * conectaba.
 *
 * Plugin: @capacitor-community/bluetooth-le (BleClient) — el estándar de la
 * comunidad para Capacitor 6: maneja scan LE + GATT + notificaciones nativas
 * en Android/iOS, mucho más rápido y probado que reimplementar GATT en el
 * PorciSerialPlugin.java. La báscula solo TRANSMITE, así que basta suscribirse
 * a NOTIFY: cada paquete de bytes entra al MISMO pipeline de parsers que el
 * clásico (invert_bits / reverse_frame / detector), vía SerialScaleDriver.
 *
 * BleTransport mantiene la MISMA resiliencia que el SPP (reconexión con
 * backoff + watchdog sin-bytes + estado "reconectando"): BLE se cae seguido,
 * el auto-reconnect es clave.
 *
 * El plugin real se carga con import() dinámico DENTRO de los métodos: así
 * evaluar este módulo (y por tanto serial.ts) en web/tests NO toca el plugin
 * nativo. Los tests inyectan un GATT falso por el constructor (opción `client`).
 */
import { Capacitor } from "@capacitor/core";
import type { ByteTransport, LinkStatus } from "./serial";

// ------------------------------------------------------- UUIDs UART-serial

/** Nordic UART Service (NUS): TX = notify (báscula→app), RX = write. */
export const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
export const NUS_TX_NOTIFY = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
export const NUS_RX_WRITE = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
/** HM-10 / CC2541: una sola característica notify+write. */
export const HM10_SERVICE = "0000ffe0-0000-1000-8000-00805f9b34fb";
export const HM10_CHAR = "0000ffe1-0000-1000-8000-00805f9b34fb";

// --------------------------------------------- contrato GATT (inyectable)

/** Propiedades de una característica GATT (subset de BleCharacteristicProperties). */
export interface BleCharProps {
  read?: boolean;
  write?: boolean;
  writeWithoutResponse?: boolean;
  notify?: boolean;
  indicate?: boolean;
}
export interface BleCharacteristicInfo {
  uuid: string;
  properties: BleCharProps;
}
export interface BleServiceInfo {
  uuid: string;
  characteristics: BleCharacteristicInfo[];
}

/**
 * Cliente GATT mínimo (subset estructural de BleClient). El real lo satisface
 * tal cual; los tests inyectan un fake controlable.
 */
export interface BleClientLike {
  initialize(options?: { androidNeverForLocation?: boolean }): Promise<void>;
  connect(deviceId: string, onDisconnect?: (deviceId: string) => void): Promise<void>;
  disconnect(deviceId: string): Promise<void>;
  getServices(deviceId: string): Promise<BleServiceInfo[]>;
  startNotifications(
    deviceId: string,
    service: string,
    characteristic: string,
    callback: (value: DataView) => void,
  ): Promise<void>;
  stopNotifications(deviceId: string, service: string, characteristic: string): Promise<void>;
}

// ------------------------------------------ descubrimiento de la característica

/** Característica UART-serial elegida: notify obligatoria; write si existe. */
export interface DiscoveredUart {
  service: string;
  notifyChar: string;
  writeChar?: string;
}

/** 16-bit ("ffe0") / 32-bit → 128-bit; siempre minúsculas para comparar. */
export function normalizeUuid(u: string): string {
  const s = (u || "").toLowerCase().replace(/[{}\s]/g, "");
  if (/^[0-9a-f]{4}$/.test(s)) return `0000${s}-0000-1000-8000-00805f9b34fb`;
  if (/^[0-9a-f]{8}$/.test(s)) return `${s}-0000-1000-8000-00805f9b34fb`;
  return s;
}

function canNotify(c: BleCharacteristicInfo): boolean {
  return Boolean(c.properties?.notify || c.properties?.indicate);
}
function canWrite(c: BleCharacteristicInfo): boolean {
  return Boolean(c.properties?.write || c.properties?.writeWithoutResponse);
}

/**
 * Elige la característica tipo UART-serial probando EN ORDEN:
 *   (a) Nordic UART Service (NUS): TX notify + RX write.
 *   (b) HM-10/CC2541: FFE0/FFE1 (notify+write).
 *   (c) fallback: la PRIMERA característica con NOTIFY (o INDICATE) de
 *       cualquier servicio (y una con WRITE del mismo servicio para TX si
 *       hiciera falta). Puro → testeable por los 3 caminos.
 */
export function pickUartCharacteristic(services: BleServiceInfo[]): DiscoveredUart | null {
  const byUuid = new Map<string, BleServiceInfo>();
  for (const s of services ?? []) byUuid.set(normalizeUuid(s.uuid), s);

  // (a) Nordic UART Service
  const nus = byUuid.get(NUS_SERVICE);
  if (nus) {
    const tx = nus.characteristics.find(
      (c) => normalizeUuid(c.uuid) === NUS_TX_NOTIFY && canNotify(c),
    );
    if (tx) {
      const rx = nus.characteristics.find(
        (c) => normalizeUuid(c.uuid) === NUS_RX_WRITE && canWrite(c),
      );
      return { service: nus.uuid, notifyChar: tx.uuid, writeChar: rx?.uuid };
    }
  }

  // (b) HM-10 / CC2541
  const hm = byUuid.get(HM10_SERVICE);
  if (hm) {
    const c = hm.characteristics.find((x) => normalizeUuid(x.uuid) === HM10_CHAR && canNotify(x));
    if (c) {
      return { service: hm.uuid, notifyChar: c.uuid, writeChar: canWrite(c) ? c.uuid : undefined };
    }
  }

  // (c) fallback: primera NOTIFY de cualquier servicio
  for (const s of services ?? []) {
    const notif = s.characteristics.find(canNotify);
    if (notif) {
      const w = s.characteristics.find(canWrite);
      return { service: s.uuid, notifyChar: notif.uuid, writeChar: w?.uuid };
    }
  }
  return null;
}

// --------------------------------------------------------------- transporte

const EMPTY_BYTES = new Uint8Array(0);
/** Backoff de reconexión (ms): 0.5→1→2→5 s; el último se repite indefinido. */
export const BLE_DEFAULT_BACKOFF_MS = [500, 1000, 2000, 5000];
/** Sin un solo byte por más de esto aunque "conectado" → enlace zombi. */
export const BLE_DEFAULT_NO_DATA_TIMEOUT_MS = 6000;

export interface BleOptions {
  /** Cliente GATT (inyectable en tests); por defecto el plugin real. */
  client?: BleClientLike;
  backoffMs?: number[];
  noDataTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onStatus?: (status: LinkStatus) => void;
}

function dataViewToBytes(value: DataView): Uint8Array {
  const out = new Uint8Array(value.byteLength);
  for (let i = 0; i < value.byteLength; i++) out[i] = value.getUint8(i);
  return out;
}

/**
 * Transporte de BYTES por BLE (GATT-notify) CON RECONEXIÓN AUTOMÁTICA
 * TRANSPARENTE — mismo contrato ByteTransport que RawBtTransport/UsbTransport,
 * así el SerialScaleDriver, el detector y la referencia manual funcionan
 * IGUAL encima. Los bytes llegan por notificaciones (push) y se acumulan en un
 * buffer que read() drena; nunca bloquea.
 */
export class BleTransport implements ByteTransport {
  readonly label: string;
  private client: BleClientLike;
  private linkStatus: LinkStatus = "connecting";
  private buffer: number[] = [];
  private lastDataAt = 0;
  private reconnecting = false;
  /** El plugin avisó una desconexión inesperada del GATT → reconectar. */
  private linkDown = false;
  private uart: DiscoveredUart | null = null;

  private readonly backoffMs: number[];
  private readonly noDataTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onStatus: (status: LinkStatus) => void;

  constructor(
    private deviceId: string,
    opts: BleOptions = {},
  ) {
    this.label = `ble ${deviceId}`;
    this.client = opts.client ?? realBleClient();
    this.backoffMs =
      opts.backoffMs && opts.backoffMs.length ? opts.backoffMs : BLE_DEFAULT_BACKOFF_MS;
    this.noDataTimeoutMs = opts.noDataTimeoutMs ?? BLE_DEFAULT_NO_DATA_TIMEOUT_MS;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onStatus = opts.onStatus ?? (() => {});
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
    await this.connectAndSubscribe();
    this.lastDataAt = this.now();
    this.linkDown = false;
    this.setStatus("connected");
  }

  /** Conecta el GATT, descubre la característica UART y se suscribe a NOTIFY. */
  private async connectAndSubscribe(): Promise<void> {
    await this.client.initialize({ androidNeverForLocation: true });
    await this.client.connect(this.deviceId, () => {
      // desconexión inesperada del GATT → el próximo read dispara la reconexión
      this.linkDown = true;
    });
    const services = await this.client.getServices(this.deviceId);
    const uart = pickUartCharacteristic(services);
    if (!uart) {
      // sin NOTIFY no hay forma de recibir el peso: cierra limpio y avisa
      try {
        await this.client.disconnect(this.deviceId);
      } catch {
        /* ya caído */
      }
      throw new Error(
        "no_uart: el dispositivo BLE no expone una característica de notificación " +
          "(¿es realmente una báscula serial-BLE?)",
      );
    }
    this.uart = uart;
    await this.client.startNotifications(
      this.deviceId,
      uart.service,
      uart.notifyChar,
      (value) => this.onNotify(value),
    );
  }

  private onNotify(value: DataView): void {
    const bytes = dataViewToBytes(value);
    if (!bytes.length) return;
    for (const b of bytes) this.buffer.push(b);
    this.lastDataAt = this.now();
  }

  private drain(): Uint8Array {
    if (!this.buffer.length) return EMPTY_BYTES;
    const out = Uint8Array.from(this.buffer);
    this.buffer.length = 0;
    return out;
  }

  async read(): Promise<Uint8Array> {
    // Mientras el enlace está caído/reconectando, el bucle de reconexión es el
    // ÚNICO dueño del GATT: no competimos con connect/disconnect.
    if (this.linkStatus === "closed" || this.reconnecting) return EMPTY_BYTES;
    // El plugin reportó una desconexión del GATT: reconectar sin perder lo
    // que quedó en el buffer justo antes de la caída.
    if (this.linkDown) {
      const pending = this.drain();
      this.triggerReconnect();
      return pending;
    }
    const bytes = this.drain();
    if (bytes.length) return bytes;
    // Watchdog SIN DATOS: "conectado" pero sin un byte en X s → enlace zombi
    // (BLE también se queda mudo tras un corte); fuerza reconexión limpia.
    if (this.now() - this.lastDataAt > this.noDataTimeoutMs) {
      this.triggerReconnect();
    }
    return EMPTY_BYTES;
  }

  private triggerReconnect(): void {
    if (this.reconnecting || this.linkStatus === "closed") return;
    this.reconnecting = true;
    this.linkDown = false;
    this.setStatus("reconnecting");
    void this.reconnectLoop();
  }

  /**
   * Reintenta conectar+suscribir al MISMO dispositivo con backoff,
   * indefinidamente, hasta lograrlo o hasta que el usuario desconecte
   * (close() → "closed"). Cierra el GATT antes de cada intento.
   */
  private async reconnectLoop(): Promise<void> {
    let attempt = 0;
    // this.status() (no la propiedad) para que el narrowing de TS no descarte
    // "closed": close() puede cambiarlo DURANTE los await de este bucle.
    while (this.status() !== "closed") {
      try {
        await this.client.disconnect(this.deviceId);
      } catch {
        /* ya caído */
      }
      const wait = this.backoffMs[Math.min(attempt, this.backoffMs.length - 1)];
      await this.sleep(wait);
      if (this.status() === "closed") break;
      try {
        await this.connectAndSubscribe();
        this.lastDataAt = this.now();
        this.linkDown = false;
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
    const uart = this.uart;
    if (uart) {
      try {
        await this.client.stopNotifications(this.deviceId, uart.service, uart.notifyChar);
      } catch {
        /* ya cortado */
      }
    }
    try {
      await this.client.disconnect(this.deviceId);
    } catch {
      /* ya cerrado */
    }
  }
}

// ------------------------------------------------- cliente real + scan LE

/** BLE está disponible en plataforma nativa (Android/iOS). */
export function bleAvailable(): boolean {
  return Capacitor.isNativePlatform();
}

/** Tipo laxo del BleClient real (cargado por import dinámico). */
interface RealBleModule {
  BleClient: BleClientLike & {
    isEnabled(): Promise<boolean>;
    requestLEScan(
      options: { allowDuplicates?: boolean; services?: string[] },
      callback: (result: { device: { deviceId: string; name?: string }; localName?: string }) => void,
    ): Promise<void>;
    stopLEScan(): Promise<void>;
  };
}

let realModule: Promise<RealBleModule["BleClient"]> | null = null;
async function loadRealBle(): Promise<RealBleModule["BleClient"]> {
  realModule ??= import("@capacitor-community/bluetooth-le").then(
    (m) => m.BleClient as unknown as RealBleModule["BleClient"],
  );
  return realModule;
}

/** Envuelve el BleClient real como BleClientLike (import dinámico perezoso). */
function realBleClient(): BleClientLike {
  return {
    initialize: async (o) => (await loadRealBle()).initialize(o),
    connect: async (id, cb) => (await loadRealBle()).connect(id, cb),
    disconnect: async (id) => (await loadRealBle()).disconnect(id),
    getServices: async (id) => (await loadRealBle()).getServices(id),
    startNotifications: async (id, s, c, cb) =>
      (await loadRealBle()).startNotifications(id, s, c, cb),
    stopNotifications: async (id, s, c) => (await loadRealBle()).stopNotifications(id, s, c),
  };
}

// --- Scan LE en vivo (mismo patrón start/poll/stop del discovery clásico) ---
// requestLEScan corre hasta stopLEScan(): acumulamos en un mapa por deviceId
// (dedupe) que la UI sondea con pollBleScan mientras dura el ciclo.
const bleFound = new Map<string, { name: string; address: string }>();
let bleScanning = false;

/** Arranca el scan LE (limpia el ciclo anterior). Lanza si el BT está apagado. */
export async function startBleScan(): Promise<void> {
  const client = await loadRealBle();
  await client.initialize({ androidNeverForLocation: true });
  const enabled = await client.isEnabled();
  if (!enabled) throw new Error("bluetooth_off");
  if (bleScanning) {
    try {
      await client.stopLEScan();
    } catch {
      /* no había scan activo */
    }
  }
  bleFound.clear();
  bleScanning = true;
  await client.requestLEScan({ allowDuplicates: false }, (result) => {
    const id = result?.device?.deviceId;
    if (!id) return;
    const name = result.device.name || result.localName || "";
    bleFound.set(id, { name, address: id }); // dedupe por id
  });
}

/** Acumulado del scan LE hasta ahora (sin duplicados). */
export async function pollBleScan(): Promise<{ devices: Array<{ name: string; address: string }> }> {
  return { devices: Array.from(bleFound.values()) };
}

/** Detiene el scan LE (idempotente). */
export async function stopBleScan(): Promise<void> {
  bleScanning = false;
  try {
    const client = await loadRealBle();
    await client.stopLEScan();
  } catch {
    /* no había scan / plugin ausente */
  }
}
