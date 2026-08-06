/**
 * Entrypoint del bundle móvil (shim.js) — se inyecta ANTES de app.js.
 *
 * Instala SÍNCRONAMENTE el shim de fetch/WebSocket/window.open y arma
 * el backend embebido en segundo plano:
 *  - Android nativo: @capacitor-community/sqlite + Bluetooth SPP.
 *  - Web dev (npx vite/servidor cualquiera): sql.js + IndexedDB, sin BT
 *    (la báscula simulada funciona completa).
 */
import { Capacitor } from "@capacitor/core";
import { bytesToBase64, csvToUtf8Bytes, Hub, installShim, LocalBackend } from "./apishim";
import {
  createCapacitorDriver,
  createSqlJsDriver,
  idb,
  Repo,
  SqlDriver,
} from "./db";
import type { ScaleProfile } from "./models";
import profilesJson from "./profiles.json";
import { CloudSync } from "./sync";
import { getDeviceId, maybeSendTelemetry } from "./telemetry";

const PROFILES = profilesJson as unknown as ScaleProfile[];

async function nativeShareCsv(filename: string, csv: string): Promise<void> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const { Share } = await import("@capacitor/share");
  // Escribimos los BYTES UTF-8 reales (BOM una sola vez) como base64 y SIN
  // `encoding`: Capacitor los decodifica y escribe tal cual. Pasar el
  // string con Encoding.UTF8 + BOM incrustado re-codificaba en el puente
  // y Excel mostraba "SesiÃ³n"; con bytes crudos abre "Sesión" bien.
  const res = await Filesystem.writeFile({
    path: filename,
    data: bytesToBase64(csvToUtf8Bytes(csv)),
    directory: Directory.Cache,
  });
  await Share.share({ title: filename, files: [res.uri] });
}

async function nativeShareReport(filename: string, html: string): Promise<void> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const { Share } = await import("@capacitor/share");
  // Mismo mecanismo del CSV para el informe: archivo real + Share. Bytes
  // UTF-8 crudos (base64, sin `encoding`) → sin mojibake; el <meta charset>
  // del HTML hace el resto. El usuario abre en Chrome/visor y usa
  // "Imprimir → Guardar como PDF", o lo comparte.
  const res = await Filesystem.writeFile({
    path: filename,
    data: bytesToBase64(new TextEncoder().encode(html)),
    directory: Directory.Cache,
  });
  await Share.share({ title: filename, files: [res.uri] });
}

async function createDriver(): Promise<{ driver: SqlDriver; native: boolean }> {
  if (Capacitor.isNativePlatform()) {
    return { driver: await createCapacitorDriver("porcipeso"), native: true };
  }
  let restore: Uint8Array | null = null;
  try {
    restore = await idb.load();
  } catch {
    restore = null;
  }
  const driver = await createSqlJsDriver({
    locateFile: (f) => "./" + f, // sql-wasm.wasm copiado a www/ por el build
    restore,
    persist: async (bytes) => {
      try {
        await idb.save(bytes);
      } catch {
        /* modo incógnito / cuota: seguimos en memoria */
      }
    },
  });
  return { driver, native: false };
}

async function initBackend(hub: Hub): Promise<LocalBackend> {
  const { driver, native } = await createDriver();
  const repo = await Repo.create(driver);
  // Sync a la nube: dormido hasta que auth.js configura la nube e
  // inicia sesión (POST /api/cloud/login|session vía el shim).
  const sync = new CloudSync({ repo, deviceId: () => getDeviceId() });
  sync.start(); // timer 5 min + push al recuperar red (window "online")
  const backend = new LocalBackend({
    repo,
    profiles: PROFILES,
    hub,
    shareCsv: native ? nativeShareCsv : undefined,
    shareReport: native ? nativeShareReport : undefined,
    cloud: {
      route: (method, path, body) => sync.route(method, path, body),
      onSessionClosed: () => sync.pushSoon(),
    },
  });
  // Autodestrucción DEMO: al abrir la app y cada hora (60 min tras cierre).
  backend.startDemoReaper();
  return backend;
}

const hub = new Hub();
let ready: Promise<LocalBackend> | null = null;
const getBackend = (): Promise<LocalBackend> => (ready ??= initBackend(hub));

// Bandera SÍNCRONA para app.js (corre después de este bundle): estamos en
// la app móvil (shim presente) y, si native, con plugins Bluetooth/USB
// reales. app.js la usa para el wizard (buscar BT, OTG, detector de señal).
(window as unknown as Record<string, unknown>)["__PORCIPESO_SHIM__"] = {
  native: Capacitor.isNativePlatform(),
};

installShim(hub, getBackend);
void getBackend(); // warm-up: la DB queda lista antes del primer toque

// Telemetría nativa (plataforma "android"): la envía este bundle y se
// marca el flag para que el telemetry.js de la UI no mande otro ping.
if (Capacitor.isNativePlatform()) {
  (window as unknown as Record<string, unknown>)["__porcipesoTelemetryNative"] = true;
  void maybeSendTelemetry();
}
