/**
 * Telemetría del APK — espejo de porcipeso/ui/static/telemetry.js con
 * plataforma "android". Se invoca desde main.ts SOLO en Capacitor
 * nativo (main.ts marca window.__porcipesoTelemetryNative para que el
 * telemetry.js de la UI no envíe un segundo ping).
 *
 * Envía 1 ping al abrir la app, máximo 1 por día, con POST directo a
 * {cloud}/telemetry. La URL de la nube vive en UN solo lugar:
 * localStorage `porcipeso_cloud_url` — vacía = no hace nada.
 *
 * PRIVACIDAD — payload EXACTO (sin datos personales: sin nombres, sin
 * correos, sin ubicación, sin contenido de pesajes):
 *   {
 *     "device_id":  "<uuid aleatorio persistente, no derivado del equipo>",
 *     "plataforma": "android",
 *     "version_app": "<APP_VERSION, p.ej. 2.1.0>",
 *     "tenant":     "<slug opcional, solo si el cliente lo configuró>",
 *     "datos": {
 *       "pesajes_total": <número de sesiones locales>,
 *       "pesajes_mes":   <sesiones del mes en curso>,
 *       "nube_activa":   false   // sync de nube aún no construido
 *     }
 *   }
 * Los conteos salen de GET /api/stats/global (el shim los resuelve
 * contra la DB local). Todo error se traga en silencio.
 */
import { APP_VERSION, getCloudUrl, getTenant } from "./update";

export const DEVICE_ID_KEY = "porcipeso_device_id";
export const LAST_PING_KEY = "porcipeso_telemetry_last";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export interface TelemetryDeps {
  fetchImpl?: typeof fetch;
  storage?: StorageLike | null;
  now?: () => Date;
  plataforma?: string;
  versionApp?: string;
}

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

function lsSet(storage: StorageLike | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    /* cuota / incógnito */
  }
}

export function getDeviceId(storage: StorageLike | null = defaultStorage()): string {
  let id = lsGet(storage, DEVICE_ID_KEY);
  if (!id) {
    id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : "pp-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    lsSet(storage, DEVICE_ID_KEY, id);
  }
  return id;
}

/**
 * Envía el ping diario si aplica. Retorna true si se envió.
 * Nunca lanza: cualquier fallo degrada a "no se envió" (y se
 * reintentará en la próxima apertura, porque el día solo se marca
 * tras un envío exitoso).
 */
export async function maybeSendTelemetry(deps: TelemetryDeps = {}): Promise<boolean> {
  try {
    const storage = deps.storage !== undefined ? deps.storage : defaultStorage();
    const fetchImpl = deps.fetchImpl ?? fetch;
    const cloud = getCloudUrl(storage);
    if (!cloud) return false; // sin nube configurada: apagado silencioso

    const today = (deps.now ? deps.now() : new Date()).toISOString().slice(0, 10);
    if (lsGet(storage, LAST_PING_KEY) === today) return false; // máx. 1/día

    const firstOfMonth = today.slice(0, 8) + "01";
    const j = async (url: string): Promise<Record<string, unknown>> => {
      const r = await fetchImpl(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as Record<string, unknown>;
    };
    // /api/stats/global lo resuelve el shim contra la DB local
    const [total, mes] = await Promise.all([
      j("/api/stats/global"),
      j("/api/stats/global?desde=" + firstOfMonth),
    ]);

    const payload: Record<string, unknown> = {
      device_id: getDeviceId(storage),
      plataforma: deps.plataforma ?? "android",
      version_app: deps.versionApp ?? APP_VERSION,
      datos: {
        pesajes_total: Number(total["sesiones"]) || 0,
        pesajes_mes: Number(mes["sesiones"]) || 0,
        nube_activa: false,
      },
    };
    const tenant = getTenant(storage);
    if (tenant) payload["tenant"] = tenant;

    const resp = await fetchImpl(cloud.replace(/\/+$/, "") + "/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) return false;
    lsSet(storage, LAST_PING_KEY, today); // solo tras envío exitoso
    return true;
  } catch {
    return false; // la telemetría jamás rompe la app
  }
}
