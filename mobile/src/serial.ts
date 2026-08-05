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
  /** Canal SPP crudo: bytes sin decodificar (base64). */
  btConnect(o: { address: string }): Promise<void>;
  btRead(): Promise<{ data: string }>; // base64
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
export function humanizeSerialError(e: unknown): string {
  const raw = String(e instanceof Error ? e.message : e);
  if (/not implemented|unimplemented|not available on web/i.test(raw)) {
    return NOT_ANDROID_MSG;
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

/**
 * Transporte de BYTES: mismo rol que porcipeso/drivers/transports.py.
 * read() drena lo disponible (puede devolver vacío); nunca bloquea largo.
 */
export interface ByteTransport {
  readonly label: string;
  open(): Promise<void>;
  read(): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** SPP crudo vía plugin local (bytes intactos, apto para señal invertida). */
export class RawBtTransport implements ByteTransport {
  readonly label: string;
  private plugin: PorciSerialPlugin;

  constructor(private address: string, plugin?: PorciSerialPlugin) {
    this.label = `bluetooth ${address}`;
    this.plugin = plugin ?? requireNative();
  }

  async open(): Promise<void> {
    await this.plugin.btConnect({ address: this.address });
  }

  async read(): Promise<Uint8Array> {
    const r = await this.plugin.btRead();
    return base64ToBytes(r.data ?? "");
  }

  async close(): Promise<void> {
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

/** Emparejados + cercanos → forma del endpoint GET /api/bt/devices. */
export async function listBtDevices(): Promise<
  Array<{ name: string; address: string; paired: boolean }>
> {
  const out = new Map<string, { name: string; address: string; paired: boolean }>();
  let anySource = false;

  // 1) EMPAREJADOS (plugin local; los indicadores ya emparejados aparecen
  //    aunque estén fuera de alcance o sin anunciar).
  if (nativeSerialAvailable()) {
    const res = await PorciSerial.listPaired(); // puede lanzar: permiso denegado
    anySource = true;
    for (const d of res.devices ?? []) {
      out.set(d.address, { name: d.name ?? "", address: d.address, paired: true });
    }
  }

  // 2) CERCANOS no emparejados: discovery del plugin @e-is (~5 s).
  //    La API de @e-is NO tiene list()/discoverUnpaired() del cordova viejo:
  //    su scan() ES el discovery clásico (ACTION_FOUND durante 5 s).
  try {
    const mod = await import("@e-is/capacitor-bluetooth-serial");
    const bt = mod.BluetoothSerial;
    const enabled = await bt.isEnabled();
    if (!enabled.enabled) await bt.enable();
    const res = await bt.scan();
    anySource = true;
    for (const d of res.devices ?? []) {
      if (!out.has(d.address)) {
        out.set(d.address, { name: d.name ?? "", address: d.address, paired: false });
      }
    }
  } catch (e) {
    // Sin emparejados Y sin discovery → propagar (la UI muestra el motivo).
    if (!anySource) throw e;
  }

  // Emparejados primero, luego por nombre.
  return Array.from(out.values()).sort(
    (a, b) => Number(b.paired) - Number(a.paired) || a.name.localeCompare(b.name),
  );
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
