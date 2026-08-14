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
  type InitSqlJs,
  Repo,
  SqlDriver,
} from "./db";
import type { ScaleProfile } from "./models";
import profilesJson from "./profiles.json";
import { CloudSync } from "./sync";
import { getDeviceId, maybeSendTelemetry } from "./telemetry";

const PROFILES = profilesJson as unknown as ScaleProfile[];

/**
 * Motor SQLite que terminó usando la app EN ESTE teléfono:
 *  - "native"           → @capacitor-community/sqlite (plugin nativo).
 *  - "sqljs-fallback"   → sql.js (WebAssembly) + IndexedDB (persiste).
 *  - "memoria-degradada"→ sql.js asm.js (JS puro, SIN WebAssembly) EN
 *                          MEMORIA: la app abre y el Bluetooth funciona,
 *                          pero los pesajes NO se guardan al cerrar.
 */
export type DbBackend = "native" | "sqljs-fallback" | "memoria-degradada";

/** Estado publicado en window.__PORCIPESO_SHIM__ (lo lee app.js). */
export interface ShimState {
  native: boolean;
  dbBackend: DbBackend | null;
  initError?: string;
}

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

async function nativeSharePdf(filename: string, pdfBytes: Uint8Array): Promise<void> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const { Share } = await import("@capacitor/share");
  // Mismo mecanismo del CSV, pero con un PDF REAL (jsPDF, ver report-pdf.ts):
  // escribimos los bytes crudos del PDF como base64 SIN `encoding` (Capacitor
  // los decodifica y guarda tal cual) y compartimos el archivo. La extensión
  // .pdf hace que Share/visores lo traten como application/pdf.
  const res = await Filesystem.writeFile({
    path: filename,
    data: bytesToBase64(pdfBytes),
    directory: Directory.Cache,
  });
  await Share.share({ title: filename, files: [res.uri] });
}

function errMsg(e: unknown): string {
  return String(e instanceof Error ? e.message : e);
}

/**
 * Nivel 2 — sql.js (WebAssembly) + IndexedDB. Es el MISMO motor del path
 * web y persiste entre reinicios. El wasm (sql-wasm[-browser].wasm) lo copió
 * el build a www/, junto a index.html, así que "./"+f lo resuelve igual en
 * el navegador y en el WebView nativo.
 */
async function createSqlJsWithIdb(): Promise<SqlDriver> {
  let restore: Uint8Array | null = null;
  try {
    restore = await idb.load();
  } catch {
    restore = null;
  }
  return createSqlJsDriver({
    locateFile: (f) => "./" + f,
    restore,
    persist: async (bytes) => {
      try {
        await idb.save(bytes);
      } catch {
        /* modo incógnito / cuota: seguimos en memoria */
      }
    },
  });
}

/**
 * Carga la build asm.js de sql.js (JavaScript puro, SIN WebAssembly) por
 * <script> desde www/ y devuelve su initSqlJs. Se hace en runtime (NO se
 * empaqueta en shim.js) para no inflar la app en los teléfonos modernos que
 * jamás la necesitan; solo la piden los WebViews viejos que no soportan WASM.
 */
function loadSqlAsm(): Promise<InitSqlJs> {
  return new Promise((resolve, reject) => {
    const w = window as unknown as { initSqlJs?: InitSqlJs };
    if (w.initSqlJs) return resolve(w.initSqlJs);
    const s = document.createElement("script");
    s.src = "./sql-asm.js"; // copiado a www/ por scripts/build.mjs
    s.onload = () =>
      w.initSqlJs
        ? resolve(w.initSqlJs)
        : reject(new Error("sql-asm.js cargó pero no expuso initSqlJs"));
    s.onerror = () => reject(new Error("no se pudo cargar sql-asm.js"));
    document.head.appendChild(s);
  });
}

/**
 * Nivel 3 — SQLite puro-JS (asm.js) EN MEMORIA. Última red de seguridad
 * para WebViews viejos sin WebAssembly: NO se conecta a IndexedDB a
 * propósito (modo degradado), la app abre y el Bluetooth funciona pero los
 * pesajes no sobreviven al cierre (se avisa en pantalla, ver app.js).
 */
async function createMemoryDriver(): Promise<SqlDriver> {
  return createSqlJsDriver({ init: loadSqlAsm }); // sin locateFile/persist/restore → en memoria
}

/** Fábricas inyectables del driver (tests) — por defecto las reales. */
export interface DriverFactories {
  isNative?: () => boolean;
  hasWebAssembly?: () => boolean;
  makeNative?: (name: string) => Promise<SqlDriver>;
  makeSqlJs?: () => Promise<SqlDriver>;
  makeMemory?: () => Promise<SqlDriver>;
  /** Reporta el motor elegido (y el detalle de los que fallaron). */
  onState?: (dbBackend: DbBackend, initError?: string) => void;
  /** Ni siquiera el nivel 3 levantó: caso extremo → banner honesto. */
  onFatal?: (initError: string) => void;
}

/**
 * Elige el driver SQLite con degradación GRADUAL y NUNCA deja la app sin
 * backend por culpa del plugin nativo o de un WebView viejo:
 *   1) SQLite nativo (@capacitor-community/sqlite).
 *   2) si falla → sql.js (WebAssembly) + IndexedDB, SI el WebView soporta WASM.
 *   3) si no hay WASM o sql.js también falla → sql.js asm.js EN MEMORIA.
 * En plataforma nativa el flag `native` se conserva en TODOS los niveles:
 * Bluetooth (SPP) y Filesystem/Share son plugins independientes del SQLite,
 * así que deben seguir activos aunque el SQLite nativo no cargue.
 * Solo si NI EL NIVEL 3 levanta se propaga el error (→ banner honesto).
 */
export async function createDriver(
  f: DriverFactories = {},
): Promise<{ driver: SqlDriver; native: boolean }> {
  const isNative = f.isNative ?? (() => Capacitor.isNativePlatform());
  const hasWasm = f.hasWebAssembly ?? (() => typeof WebAssembly !== "undefined");
  const makeNative = f.makeNative ?? ((name) => createCapacitorDriver(name));
  const makeSqlJs = f.makeSqlJs ?? (() => createSqlJsWithIdb());
  const makeMemory = f.makeMemory ?? (() => createMemoryDriver());
  const report = f.onState ?? publishDbBackend;
  const reportFatal = f.onFatal ?? publishInitError;

  const native = isNative();
  const problems: string[] = [];

  // Nivel 1 — SQLite nativo (solo en plataforma nativa).
  if (native) {
    try {
      const driver = await makeNative("porcipeso");
      report("native");
      return { driver, native: true };
    } catch (e) {
      const msg = errMsg(e);
      problems.push(`SQLite nativo: ${msg}`);
      console.warn("[PorciPeso] SQLite nativo no disponible; intento respaldo sql.js:", msg);
    }
  }

  // Nivel 2 — sql.js (WebAssembly) + IndexedDB. Se comprueba WASM ANTES de
  // intentarlo para saltar directo al nivel 3 en WebViews sin WebAssembly.
  if (hasWasm()) {
    try {
      const driver = await makeSqlJs();
      report("sqljs-fallback", problems.length ? problems.join(" · ") : undefined);
      return { driver, native };
    } catch (e) {
      const msg = errMsg(e);
      problems.push(`sql.js (WASM): ${msg}`);
      console.warn("[PorciPeso] sql.js (WASM) falló; caigo a memoria pura (asm.js):", msg);
    }
  } else {
    problems.push("sql.js (WASM): WebAssembly no está disponible en este WebView");
    console.warn("[PorciPeso] WebAssembly ausente; salto directo a memoria pura (asm.js).");
  }

  // Nivel 3 — SQLite puro-JS (asm.js) EN MEMORIA (sin persistencia).
  try {
    const driver = await makeMemory();
    report("memoria-degradada", problems.length ? problems.join(" · ") : undefined);
    return { driver, native };
  } catch (e) {
    problems.push(`memoria (asm.js): ${errMsg(e)}`);
    const detail = problems.join(" · ");
    reportFatal(detail);
    throw new Error(detail);
  }
}

export async function initBackend(
  hub: Hub,
  factories: DriverFactories = {},
): Promise<LocalBackend> {
  const { driver, native } = await createDriver(factories);
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
    shareReport: native ? nativeSharePdf : undefined,
    cloud: {
      route: (method, path, body) => sync.route(method, path, body),
      onSessionClosed: () => sync.pushSoon(),
    },
  });
  // Autodestrucción DEMO: al abrir la app y cada hora (60 min tras cierre).
  backend.startDemoReaper();
  return backend;
}

// Estado compartido con app.js. Se crea en bootstrap(); en tests unitarios
// (node, sin window) queda null y createDriver usa el onState inyectado.
let shimState: ShimState | null = null;

function publishDbBackend(dbBackend: DbBackend, initError?: string): void {
  if (!shimState) return;
  shimState.dbBackend = dbBackend;
  if (initError) shimState.initError = initError;
}

function publishInitError(initError: string): void {
  if (shimState) shimState.initError = initError;
}

/**
 * Gancho de PRUEBA (solo con `?__dbfail=…` en la URL): simula fallos del
 * driver para verificar la degradación en el navegador/Playwright, donde no
 * corre el plugin nativo ni falta WebAssembly de verdad.
 *   · native  → estamos en nativo y el SQLite del plugin LANZA → cae a sql.js.
 *   · wasm-off→ el WebView no soporta WebAssembly → cae a memoria (asm.js).
 *   · fatal   → ni el nivel 3 levanta → banner honesto.
 */
function debugFactories(): DriverFactories {
  let mode = "";
  try {
    mode = new URLSearchParams(window.location.search).get("__dbfail") ?? "";
  } catch {
    /* URL rara */
  }
  if (mode === "native") {
    return {
      isNative: () => true,
      makeNative: async () => {
        throw new Error("simulado: @capacitor-community/sqlite no cargó");
      },
    };
  }
  if (mode === "wasm-off") {
    return { hasWebAssembly: () => false };
  }
  if (mode === "fatal") {
    return {
      isNative: () => true,
      hasWebAssembly: () => false,
      makeNative: async () => {
        throw new Error("simulado: sqlite nativo caído");
      },
      makeMemory: async () => {
        throw new Error("simulado: ni asm.js cargó");
      },
    };
  }
  return {};
}

function bootstrap(): void {
  const hub = new Hub();
  const factories = debugFactories();
  let ready: Promise<LocalBackend> | null = null;
  const getBackend = (): Promise<LocalBackend> => (ready ??= initBackend(hub, factories));

  // Estado SÍNCRONO para app.js (corre después de este bundle): shim presente
  // = app móvil; `native` = plugins Bluetooth/USB reales; `dbBackend` se
  // rellena en cuanto el init elige motor (nativo / respaldo / memoria).
  shimState = { native: Capacitor.isNativePlatform(), dbBackend: null };
  (window as unknown as Record<string, unknown>)["__PORCIPESO_SHIM__"] = shimState;

  installShim(hub, getBackend);
  void getBackend(); // warm-up: la DB queda lista antes del primer toque

  // Telemetría nativa (plataforma "android"): la envía este bundle y se
  // marca el flag para que el telemetry.js de la UI no mande otro ping.
  if (Capacitor.isNativePlatform()) {
    (window as unknown as Record<string, unknown>)["__porcipesoTelemetryNative"] = true;
    void maybeSendTelemetry();
  }
}

// Arranque real (navegador / WebView). En tests unitarios (node, sin window)
// NO corre, así createDriver/initBackend se importan y prueban aislados.
if (typeof window !== "undefined") {
  bootstrap();
}
