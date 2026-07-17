/**
 * Auto-actualización del APK — réplica en TS de porcipeso/api/updatecheck.py.
 *
 * El shim expone GET /api/update/status con el MISMO contrato que el
 * backend de escritorio, así la UI (banners.js) pregunta en UN solo
 * lugar sin importar la plataforma:
 *
 *   {current, latest, update_available, min_version_ok, apk_url,
 *    banners: [{id, texto, boton, url, desde, hasta, solo_sin_nube}]}
 *
 * Contrato del cloud (en construcción):
 *   GET {cloud}/config/app?tenant=slug
 *   → {latest_version, min_version, apk_url, banners: [...]}
 *
 * La URL base de la nube vive en UN solo lugar por cliente:
 * localStorage `porcipeso_cloud_url`; DEFAULT_CLOUD_URL="" (vacía) =
 * features remotas APAGADAS en silencio.
 *
 * En Android la descarga usa @capacitor/filesystem (downloadFile) y el
 * instalador se abre con @capacitor-community/file-opener (intent VIEW
 * application/vnd.android.package-archive). Requiere el permiso
 * REQUEST_INSTALL_PACKAGES (AndroidManifest.xml).
 */

/** Mantener en sync con el archivo VERSION de la raíz del repo. */
export const APP_VERSION = "2.1.0";

/** Vacía = features remotas apagadas silenciosamente. */
export const DEFAULT_CLOUD_URL = "";

export const CLOUD_URL_KEY = "porcipeso_cloud_url";
export const TENANT_KEY = "porcipeso_tenant";

export const FETCH_TIMEOUT_MS = 3_000;
export const CACHE_TTL_MS = 6 * 3600 * 1000; // 6 horas

// ------------------------------------------------------------------ tipos

export interface RemoteBanner {
  id: string;
  texto: string;
  boton?: string | null;
  url?: string | null;
  desde?: string | null;
  hasta?: string | null;
  solo_sin_nube?: boolean;
}

export interface RemoteConfig {
  latest_version?: string | null;
  min_version?: string | null;
  apk_url?: string | null;
  banners?: RemoteBanner[];
}

export interface UpdateStatus {
  current: string;
  latest: string | null;
  update_available: boolean;
  min_version_ok: boolean;
  apk_url: string | null;
  banners: RemoteBanner[];
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export interface UpdateDeps {
  fetchImpl?: typeof fetch;
  storage?: StorageLike | null;
  now?: () => number;
  currentVersion?: string;
  /** Override de la URL de la nube (default: localStorage). */
  cloudUrl?: string;
  tenant?: string;
}

// ----------------------------------------------------------------- semver

/** "2.1.0" -> [2, 1, 0]; lo no parseable cuenta como [0, 0, 0]. */
export function parseSemver(version: string): [number, number, number] {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(version ?? ""));
  if (!m) return [0, 0, 0];
  return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** -1 si a < b, 0 si iguales, 1 si a > b (comparación numérica). */
export function semverCmp(a: string, b: string): number {
  const ta = parseSemver(a);
  const tb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (ta[i] !== tb[i]) return ta[i] < tb[i] ? -1 : 1;
  }
  return 0;
}

// ------------------------------------------------------------------- deps

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function lsGet(storage: StorageLike | null, key: string): string {
  try {
    return storage?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function getCloudUrl(storage: StorageLike | null = defaultStorage()): string {
  const v = lsGet(storage, CLOUD_URL_KEY).trim();
  return v || DEFAULT_CLOUD_URL;
}

export function getTenant(storage: StorageLike | null = defaultStorage()): string {
  return lsGet(storage, TENANT_KEY).trim();
}

// ------------------------------------------------------------------- cache

interface CacheEntry {
  ts: number;
  config: RemoteConfig;
}

/** cache en memoria: `${cloudUrl}|${tenant}` -> {ts, config} */
const cache = new Map<string, CacheEntry>();

/** Limpia el cache (tests). */
export function clearUpdateCache(): void {
  cache.clear();
}

// ------------------------------------------------------------------- fetch

/**
 * GET {cloud}/config/app (timeout 3 s, cache 6 h). null si falla; si
 * había cache vencido, se conserva (mejor config vieja que nada).
 */
export async function fetchRemoteConfig(
  cloudUrl: string,
  tenant: string,
  deps: UpdateDeps = {},
): Promise<RemoteConfig | null> {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const key = `${cloudUrl}|${tenant}`;
  const cached = cache.get(key);
  if (cached && now() - cached.ts < CACHE_TTL_MS) return cached.config;

  const base = cloudUrl.replace(/\/+$/, "");
  const url = base + "/config/app" + (tenant ? `?tenant=${encodeURIComponent(tenant)}` : "");
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS) : null;
  try {
    const resp = await fetchImpl(url, { signal: ctrl?.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const config = (await resp.json()) as RemoteConfig;
    if (config === null || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("config remota no es un objeto JSON");
    }
    cache.set(key, { ts: now(), config });
    return config;
  } catch {
    return cached ? cached.config : null; // degradación silenciosa
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ status

export function buildStatus(current: string, config: RemoteConfig | null): UpdateStatus {
  if (config === null) {
    return {
      current,
      latest: null,
      update_available: false,
      min_version_ok: true,
      apk_url: null,
      banners: [],
    };
  }
  const latest = config.latest_version || null;
  const minVersion = config.min_version || null;
  return {
    current,
    latest,
    update_available: !!latest && semverCmp(current, latest) < 0,
    min_version_ok: !minVersion || semverCmp(current, minVersion) >= 0,
    apk_url: config.apk_url || null,
    banners: Array.isArray(config.banners) ? config.banners : [],
  };
}

/** Estado de actualización — misma respuesta que GET /api/update/status. */
export async function fetchUpdateStatus(deps: UpdateDeps = {}): Promise<UpdateStatus> {
  const storage = deps.storage !== undefined ? deps.storage : defaultStorage();
  const current = deps.currentVersion ?? APP_VERSION;
  const cloudUrl = (deps.cloudUrl ?? getCloudUrl(storage)).trim();
  if (!cloudUrl) return buildStatus(current, null); // apagado silencioso
  const tenant = deps.tenant ?? getTenant(storage);
  const config = await fetchRemoteConfig(cloudUrl, tenant, deps);
  return buildStatus(current, config);
}

// ------------------------------------------------ descarga + instalador

export interface InstallerDeps {
  /** Descarga el APK y retorna la ruta/URI local (inyectable en tests). */
  download?: (apkUrl: string, filename: string) => Promise<string>;
  /** Abre el instalador de Android sobre esa ruta (inyectable en tests). */
  open?: (filePath: string) => Promise<void>;
}

const APK_MIME = "application/vnd.android.package-archive";

async function nativeDownload(apkUrl: string, filename: string): Promise<string> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const res = await Filesystem.downloadFile({
    url: apkUrl,
    path: filename,
    directory: Directory.Cache,
  });
  if (!res.path) throw new Error("descarga sin ruta local");
  return res.path;
}

async function nativeOpenInstaller(filePath: string): Promise<void> {
  const { FileOpener } = await import("@capacitor-community/file-opener");
  await FileOpener.open({ filePath, contentType: APK_MIME });
}

/**
 * Descarga el APK (apk_url) al cache de la app y abre el instalador
 * (intent VIEW application/vnd.android.package-archive). Lanza si algo
 * falla — el llamador decide cómo mostrarlo.
 */
export async function downloadAndInstallApk(
  apkUrl: string,
  deps: InstallerDeps = {},
): Promise<string> {
  if (!apkUrl) throw new Error("sin apk_url: no hay nada que descargar");
  const download = deps.download ?? nativeDownload;
  const open = deps.open ?? nativeOpenInstaller;
  const path = await download(apkUrl, "porcipeso-update.apk");
  await open(path);
  return path;
}
