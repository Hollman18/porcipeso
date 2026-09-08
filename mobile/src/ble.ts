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
/** HM-10 / CC2541 / CC41-A (TI CC254x): una sola característica notify+write. */
export const HM10_SERVICE = "0000ffe0-0000-1000-8000-00805f9b34fb";
export const HM10_CHAR = "0000ffe1-0000-1000-8000-00805f9b34fb";
/**
 * Microchip / ISSC "Transparent UART" (RN4870/71, BM70/71) — EL PERFIL MÁS
 * PROBABLE en adaptadores RS232-BLE de campo. TX = notify (báscula→app),
 * RX = write (con respuesta) o su variante write-sin-respuesta.
 */
export const MICROCHIP_SERVICE = "49535343-fe7d-4ae5-8fa9-9fafd205e455";
export const MICROCHIP_TX_NOTIFY = "49535343-1e4d-4bd9-ba61-23c647249616";
export const MICROCHIP_RX_WRITE = "49535343-8841-43f4-a8d4-ecbe34729bb3";
/** Variante write-sin-respuesta del RX de Microchip/ISSC (algunos firmwares). */
export const MICROCHIP_RX_WRITE_NR = "49535343-4c8a-39b3-2f49-511cff073b7e";

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
export interface BleScanHit {
  device: { deviceId: string; name?: string };
  localName?: string;
}

export interface BleClientLike {
  initialize(options?: { androidNeverForLocation?: boolean }): Promise<void>;
  connect(
    deviceId: string,
    onDisconnect?: (deviceId: string) => void,
    options?: { timeout?: number },
  ): Promise<void>;
  disconnect(deviceId: string): Promise<void>;
  getServices(deviceId: string): Promise<BleServiceInfo[]>;
  startNotifications(
    deviceId: string,
    service: string,
    characteristic: string,
    callback: (value: DataView) => void,
  ): Promise<void>;
  stopNotifications(deviceId: string, service: string, characteristic: string): Promise<void>;
  /**
   * OPCIONALES — scan LE para "PRESENTAR" el dispositivo al stack de Android
   * antes de conectar (ver BleTransport.prescanForDevice). El cliente real los
   * tiene; los fakes de tests pueden omitirlos y el prescan se salta.
   */
  requestLEScan?(
    options: { allowDuplicates?: boolean; services?: string[] },
    callback: (result: BleScanHit) => void,
  ): Promise<void>;
  stopLEScan?(): Promise<void>;
}

/** MAC/id comparable: mayúsculas, sin espacios. */
export function normalizeMac(id: string): string {
  return (id || "").trim().toUpperCase();
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
 * Elige la característica tipo UART-serial probando EN ORDEN los perfiles
 * "vendor GATT / transparent UART" que soporta la app de referencia (Serial
 * Bluetooth Terminal):
 *   (1) Nordic UART Service (NUS): TX notify + RX write.
 *   (2) TI CC254x / HM-10 / CC41-A: FFE0/FFE1 (notify+write).
 *   (3) Microchip / ISSC "Transparent UART" (RN4870/71, BM70/71): TX notify +
 *       RX write (con respuesta) o su variante write-sin-respuesta. EL MÁS
 *       PROBABLE para adaptadores RS232-BLE.
 *   (4) Telit Bluemod y perfiles definidos por el usuario: cubiertos por (5).
 *   (5) FALLBACK GENÉRICO ROBUSTO: la PRIMERA característica con NOTIFY (o
 *       INDICATE) de CUALQUIER servicio (para RX del peso) y, si existe, una
 *       con WRITE/WRITE_NO_RESPONSE del mismo servicio (para TX). Las
 *       notificaciones/indicaciones se habilitan según la propiedad real.
 * Puro → testeable por los 5 caminos.
 */
export function pickUartCharacteristic(services: BleServiceInfo[]): DiscoveredUart | null {
  const byUuid = new Map<string, BleServiceInfo>();
  for (const s of services ?? []) byUuid.set(normalizeUuid(s.uuid), s);

  // (1) Nordic UART Service
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

  // (2) TI CC254x / HM-10 / CC41-A
  const hm = byUuid.get(HM10_SERVICE);
  if (hm) {
    const c = hm.characteristics.find((x) => normalizeUuid(x.uuid) === HM10_CHAR && canNotify(x));
    if (c) {
      return { service: hm.uuid, notifyChar: c.uuid, writeChar: canWrite(c) ? c.uuid : undefined };
    }
  }

  // (3) Microchip / ISSC "Transparent UART" (RN4870/71, BM70/71)
  const mc = byUuid.get(MICROCHIP_SERVICE);
  if (mc) {
    const tx = mc.characteristics.find(
      (c) => normalizeUuid(c.uuid) === MICROCHIP_TX_NOTIFY && canNotify(c),
    );
    if (tx) {
      // RX preferido: write CON respuesta; si no, la variante write-sin-respuesta.
      const rx =
        mc.characteristics.find(
          (c) => normalizeUuid(c.uuid) === MICROCHIP_RX_WRITE && canWrite(c),
        ) ??
        mc.characteristics.find(
          (c) => normalizeUuid(c.uuid) === MICROCHIP_RX_WRITE_NR && canWrite(c),
        );
      return { service: mc.uuid, notifyChar: tx.uuid, writeChar: rx?.uuid };
    }
  }

  // (4)+(5) fallback genérico: primera NOTIFY/INDICATE de cualquier servicio
  //  (Telit Bluemod y perfiles a medida caen aquí). WRITE del mismo servicio.
  for (const s of services ?? []) {
    const notif = s.characteristics.find(canNotify);
    if (notif) {
      const w = s.characteristics.find(canWrite);
      return { service: s.uuid, notifyChar: notif.uuid, writeChar: w?.uuid };
    }
  }
  return null;
}

// ------------------------------------------------ diagnóstico GATT (soporte)

/** Propiedades legibles de una característica GATT (para el volcado). */
export interface GattCharDump {
  uuid: string;
  properties: string[];
}
export interface GattServiceDump {
  uuid: string;
  characteristics: GattCharDump[];
}

function charPropList(c: BleCharacteristicInfo): string[] {
  const p = c.properties ?? {};
  const out: string[] = [];
  if (p.read) out.push("read");
  if (p.write) out.push("write");
  if (p.writeWithoutResponse) out.push("writeNoResp");
  if (p.notify) out.push("notify");
  if (p.indicate) out.push("indicate");
  return out;
}

/**
 * Vuelca los servicios/características GATT (UUID normalizado + propiedades)
 * para DIAGNÓSTICO: cuando ningún perfil UART matchea, esto revela el UUID
 * EXACTO que expone el módulo — así se puede clavar un perfil exótico sin
 * tener el hardware a mano. Puro → testeable.
 */
export function describeGatt(services: BleServiceInfo[]): GattServiceDump[] {
  return (services ?? []).map((s) => ({
    uuid: normalizeUuid(s.uuid),
    characteristics: (s.characteristics ?? []).map((c) => ({
      uuid: normalizeUuid(c.uuid),
      properties: charPropList(c),
    })),
  }));
}

/** Texto COPIABLE del volcado GATT ("Detalle técnico del módulo" para soporte). */
export function formatGattDump(services: BleServiceInfo[]): string {
  const dump = describeGatt(services);
  if (!dump.length) return "(el módulo no expuso ningún servicio GATT)";
  const lines: string[] = [];
  for (const s of dump) {
    lines.push(`Servicio ${s.uuid}`);
    if (!s.characteristics.length) lines.push("  (sin características)");
    for (const c of s.characteristics) {
      lines.push(`  · ${c.uuid} [${c.properties.join(", ") || "sin propiedades"}]`);
    }
  }
  return lines.join("\n");
}

/**
 * Error de "sin característica UART usable" que ADEMÁS carga el volcado GATT
 * (estructurado + texto) para diagnóstico en la UI y en los logs. El apishim
 * lo detecta y devuelve `gatt`/`gatt_text` en la respuesta del connect.
 */
export class BleNoUartError extends Error {
  readonly gatt: GattServiceDump[];
  readonly gattText: string;
  constructor(services: BleServiceInfo[]) {
    const text = formatGattDump(services);
    super(
      "no_uart: el dispositivo BLE no expone una característica de notificación " +
        "usable (¿es realmente una báscula serial-BLE?). Servicios GATT:\n" +
        text,
    );
    this.name = "BleNoUartError";
    this.gatt = describeGatt(services);
    this.gattText = text;
  }
}

// --------------------------------------------------------------- transporte

const EMPTY_BYTES = new Uint8Array(0);
/** Backoff de reconexión (ms): 0.5→1→2→5 s; el último se repite indefinido. */
export const BLE_DEFAULT_BACKOFF_MS = [500, 1000, 2000, 5000];
/** Sin un solo byte por más de esto aunque "conectado" → enlace zombi. */
export const BLE_DEFAULT_NO_DATA_TIMEOUT_MS = 6000;
/**
 * Límite DURO para conectar+descubrir+suscribir el GATT. Sin esto el connect
 * BLE puede quedarse "esperando" para siempre (módulo dormido, fuera de rango,
 * o stack MIUI colgado). Al vencer, open() falla claro y el detector/connect
 * cae al siguiente modo o avisa — nunca se cuelga.
 */
export const BLE_CONNECT_TIMEOUT_MS = 15000;
/**
 * Tiempo máximo del scan LE PREVIO al connect (ver prescanForDevice). Un módulo
 * BLE anuncia cada ~100 ms–1 s; 8 s sobran para verlo si está encendido y
 * cerca. Si no aparece, igual se intenta conectar, pero el error lo dirá.
 */
export const BLE_PRESCAN_TIMEOUT_MS = 8000;

/** Corre `p` con tope de tiempo; si vence, rechaza con `label` (no cuelga). */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Fases del connect BLE para que la UI NUNCA parezca congelada. */
export type BlePhase = "ble_prescan" | "ble_connect" | "ble_subscribed";

export interface BleOptions {
  /** Cliente GATT (inyectable en tests); por defecto el plugin real. */
  client?: BleClientLike;
  backoffMs?: number[];
  noDataTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onStatus?: (status: LinkStatus) => void;
  /** Aviso de fase (scan previo → conectando → escuchando) para la UI. */
  onPhase?: (phase: BlePhase, detail?: string) => void;
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
  /** Resultado del scan previo del último intento (diagnóstico): null = no corrió. */
  private prescanFound: boolean | null = null;

  private readonly backoffMs: number[];
  private readonly noDataTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onStatus: (status: LinkStatus) => void;
  private readonly onPhase: (phase: BlePhase, detail?: string) => void;

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
    this.onPhase = opts.onPhase ?? (() => {});
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

  /** Conecta el GATT, descubre la característica UART y se suscribe a NOTIFY.
   *  Con tope de tiempo DURO (BLE_CONNECT_TIMEOUT_MS) para no quedarse colgado. */
  private async connectAndSubscribe(): Promise<void> {
    await withTimeout(
      this.doConnectAndSubscribe(),
      BLE_CONNECT_TIMEOUT_MS,
      "ble_timeout: el módulo BLE no respondió a tiempo (¿encendido y cerca?)",
    );
  }

  /**
   * "PRESENTA" el dispositivo al stack BLE de Android ANTES de conectar.
   *
   * CAUSA RAÍZ de campo: el plugin, si la MAC no salió de un scan LE (la nuestra
   * viene del discovery CLÁSICO), cae a getRemoteDevice(mac) + connectGatt, que
   * asume DIRECCIÓN PÚBLICA. Los adaptadores RS232-BLE suelen anunciar con
   * dirección ALEATORIA → ese connectGatt falla o vence por timeout, siempre.
   * Un scan LE que VEA el módulo registra su tipo de dirección (y lo mete en el
   * deviceMap del plugin), y entonces el connect sí funciona. Es exactamente lo
   * que hace la app de referencia (Serial Bluetooth Terminal: la pestaña LE es
   * un scan y de ahí conecta).
   *
   * Devuelve true si lo vio. Si no aparece, igual se intenta conectar (podría
   * estar bondeado / ser pública), pero el error final dirá que NO se vio en
   * el aire — dato clave para diagnosticar (apagado, lejos, tomado por otro).
   */
  private async prescanForDevice(): Promise<boolean> {
    const c = this.client;
    if (!c.requestLEScan || !c.stopLEScan) return false; // fake sin scan (tests)
    const target = normalizeMac(this.deviceId);
    this.onPhase("ble_prescan");
    let found = false;
    let markSeen: () => void = () => {};
    const seen = new Promise<void>((r) => {
      markSeen = r;
    });
    try {
      await c.requestLEScan({ allowDuplicates: false }, (r) => {
        if (normalizeMac(r?.device?.deviceId ?? "") === target) {
          found = true;
          markSeen();
        }
      });
      await Promise.race([seen, this.sleep(BLE_PRESCAN_TIMEOUT_MS)]);
    } catch {
      /* scan no disponible / BT apagado: el connect reportará el fallo real */
    } finally {
      try {
        await c.stopLEScan();
      } catch {
        /* no había scan activo */
      }
    }
    return found;
  }

  private async doConnectAndSubscribe(): Promise<void> {
    await this.client.initialize({ androidNeverForLocation: true });
    this.prescanFound = await this.prescanForDevice();
    this.onPhase(
      "ble_connect",
      this.prescanFound ? "módulo visto en el aire" : "no apareció en el scan; intento igual",
    );
    try {
      await this.client.connect(
        this.deviceId,
        () => {
          // desconexión inesperada del GATT → el próximo read dispara la reconexión
          this.linkDown = true;
        },
        { timeout: BLE_CONNECT_TIMEOUT_MS },
      );
    } catch (e) {
      // El motivo del fallo cambia TODO el diagnóstico: distinto es "no está en
      // el aire" (apagado/lejos/tomado por otro teléfono) que "lo veo pero el
      // GATT no conecta" (bloqueo del stack / módulo que rechaza).
      const why = this.prescanFound
        ? "el módulo SÍ apareció en el scan BLE pero el GATT no conectó"
        : "el módulo NO apareció en el scan BLE (¿apagado, lejos, o ya conectado a OTRO teléfono?)";
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(`ble_connect: ${why} · detalle: ${detail}`);
    }
    const services = await this.client.getServices(this.deviceId);
    const uart = pickUartCharacteristic(services);
    if (!uart) {
      // sin NOTIFY no hay forma de recibir el peso: cierra limpio y avisa
      try {
        await this.client.disconnect(this.deviceId);
      } catch {
        /* ya caído */
      }
      // DIAGNÓSTICO GATT: en vez de solo fallar, recopila la lista de servicios
      // y características (UUID + propiedades) que el módulo expone. Se loguea y
      // viaja con el error para mostrarla copiable en la UI ("envíaselo a
      // soporte") — así se clava el UUID exacto de un perfil raro sin hardware.
      const e = new BleNoUartError(services);
      try {
        console.warn("[PorciPeso BLE] " + e.message);
      } catch {
        /* consola ausente */
      }
      throw e;
    }
    this.uart = uart;
    await this.client.startNotifications(
      this.deviceId,
      uart.service,
      uart.notifyChar,
      (value) => this.onNotify(value),
    );
    this.onPhase("ble_subscribed");
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
    connect: async (id, cb, opts) => (await loadRealBle()).connect(id, cb, opts),
    disconnect: async (id) => (await loadRealBle()).disconnect(id),
    // scan LE para el prescan (presentar el dispositivo al stack antes del connect)
    requestLEScan: async (o, cb) => (await loadRealBle()).requestLEScan(o, cb),
    stopLEScan: async () => (await loadRealBle()).stopLEScan(),
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
