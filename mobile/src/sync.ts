/**
 * Sync móvil local→nube — espejo de porcipeso/api/syncworker.py dentro
 * del shim.
 *
 * - La UI (auth.js) llama a /api/cloud/* y el shim delega aquí
 *   (LocalBackend deps.cloud): probe/login/session/token/status/logout.
 * - Timer de 5 min + push inmediato al cerrar un pesaje (pushSoon desde
 *   apishim) + al recuperar red (window "online").
 * - Estado en localStorage: porcipeso_cloud_url / porcipeso_tenant (los
 *   mismos de update.ts), porcipeso_refresh (rotativo, dueño único =
 *   este TokenBox), porcipeso_perfil, porcipeso_last_push.
 * - device_id: el MISMO de telemetry.ts (getDeviceId) — un solo id por
 *   equipo.
 * - Push idempotente: POST /sync/push del cloud es UPSERT por uuid
 *   (last-write-wins); los eventos locales no tienen uuid → se deriva
 *   determinístico `{uuid_sesion}:ev:{id_local}`.
 * - 401 con access vigente → UN refresh + reintento; refresh muerto →
 *   "sesión vencida" (la UI pide login; los datos locales no se tocan).
 * - Nunca se loguean tokens; el access va solo en Authorization.
 */
import {
  CloudError,
  CloudOffline,
  cloudLogin,
  cloudLogout,
  cloudProbeShape,
  HTTP_TIMEOUT_MS,
  LAST_PUSH_KEY,
  Perfil,
  PERFIL_KEY,
  perfilFromToken,
  REFRESH_KEY,
  SessionExpired,
  TokenBox,
} from "./cloudauth";
import { CLOUD_URL_KEY, TENANT_KEY } from "./update";

/** Máximo de sesiones por POST /sync/push (contrato cloud: ≤500). */
export const PUSH_BATCH_SESIONES = 200;
/** Máximo de eventos por POST /sync/push (contrato cloud: ≤5000). */
export const PUSH_BATCH_EVENTOS = 5000;
/** Timer periódico del móvil. */
export const SYNC_INTERVAL_MS = 5 * 60 * 1000;

const PUSH_KEY_KEY = "porcipeso_push_key";
const ULTIMO_PUSH_KEY = "porcipeso_ultimo_push";

type Row = Record<string, unknown>;

/** Lo único que el sync necesita del Repo del shim. */
export interface SyncRepo {
  listSessions(desde?: string | null, hasta?: string | null, q?: string | null): Promise<Row[]>;
  listEvents(sessionId: number): Promise<Row[]>;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface CloudSyncDeps {
  repo: SyncRepo;
  deviceId: string | (() => string);
  storage?: StorageLike | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface RouteResult {
  status: number;
  body: unknown;
}

const ok = (body: unknown, status = 200): RouteResult => ({ status, body });
const err = (status: number, detail: string): RouteResult => ({ status, body: { detail } });

/** uuid determinístico del evento (los locales no tienen uuid). */
export function eventUuid(sesionUuid: string, eventId: unknown): string {
  return `${sesionUuid}:ev:${eventId}`;
}

function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 19) + "+00:00";
}

/** Campos de la sesión local que acepta SesionSync del cloud. */
export const SESION_SYNC_FIELDS = [
  "uuid", "granja", "lote", "corral_origen", "destino", "placa",
  "conductor", "operador", "bascula_id", "peso_ref_inicial",
  "hora_entrada", "hora_salida", "total_kg", "total_animales",
  "promedio_final", "conteo_fisico", "diferencia_conciliacion",
  "estado", "modo",
] as const;

export class CloudSync {
  private deps: CloudSyncDeps;
  readonly tokens: TokenBox;

  private conectado = false;
  private sesionVencida = false;
  private ultimoError: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private soonTimer: ReturnType<typeof setTimeout> | null = null;
  private cycling: Promise<Record<string, unknown>> | null = null;

  constructor(deps: CloudSyncDeps) {
    this.deps = deps;
    this.tokens = new TokenBox({
      fetchImpl: deps.fetchImpl,
      now: deps.now,
      onRefreshRotated: (r) => this.lsSet(REFRESH_KEY, r),
    });
    this.restore();
  }

  // -------------------------------------------------------- storage utils

  private storage(): StorageLike | null {
    if (this.deps.storage !== undefined) return this.deps.storage;
    try {
      return typeof localStorage !== "undefined" ? localStorage : null;
    } catch {
      return null;
    }
  }

  private lsGet(key: string): string {
    try {
      return this.storage()?.getItem(key) ?? "";
    } catch {
      return "";
    }
  }

  private lsSet(key: string, value: string | null): void {
    try {
      const s = this.storage();
      if (!s) return;
      if (value === null) s.removeItem(key);
      else s.setItem(key, value);
    } catch {
      /* cuota / incógnito */
    }
  }

  private get deviceId(): string {
    const d = this.deps.deviceId;
    return typeof d === "function" ? d() : d;
  }

  private get fetchImpl(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  private nowMs(): number {
    return (this.deps.now ?? Date.now)();
  }

  private cloudUrl(): string {
    return this.lsGet(CLOUD_URL_KEY).trim().replace(/\/+$/, "");
  }

  private tenant(): string {
    return this.lsGet(TENANT_KEY).trim().toLowerCase();
  }

  private restore(): void {
    const url = this.cloudUrl();
    const refresh = this.lsGet(REFRESH_KEY);
    if (url && refresh) this.tokens.setSession(url, "", refresh);
  }

  private perfil(): Perfil | null {
    try {
      const raw = this.lsGet(PERFIL_KEY);
      return raw ? (JSON.parse(raw) as Perfil) : null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------- sesión

  setSession(
    cloudUrl: string,
    tenant: string,
    accessToken: string,
    refreshToken: string,
    expiresIn?: number,
    perfil?: Perfil | null,
  ): void {
    const url = String(cloudUrl ?? "").trim().replace(/\/+$/, "");
    const slug = String(tenant ?? "").trim().toLowerCase();
    // Cambiar de nube/tenant resetea el marcador (re-push idempotente).
    const key = `${url}|${slug}`;
    if (this.lsGet(PUSH_KEY_KEY) !== key) {
      this.lsSet(PUSH_KEY_KEY, key);
      this.lsSet(LAST_PUSH_KEY, null);
    }
    this.lsSet(CLOUD_URL_KEY, url);
    this.lsSet(TENANT_KEY, slug);
    this.lsSet(REFRESH_KEY, refreshToken);
    if (perfil) this.lsSet(PERFIL_KEY, JSON.stringify(perfil));
    this.tokens.setSession(url, accessToken, refreshToken, expiresIn);
    this.sesionVencida = false;
    this.ultimoError = null;
    this.pushSoon();
  }

  async clearSession(): Promise<void> {
    const url = this.tokens.cloudUrl || this.cloudUrl();
    const old = this.tokens.clear();
    if (url && old) await cloudLogout(url, old, this.fetchImpl);
    this.lsSet(REFRESH_KEY, null);
    this.lsSet(PERFIL_KEY, null);
    this.conectado = false;
    this.sesionVencida = false;
  }

  get configured(): boolean {
    return this.tokens.configured;
  }

  // -------------------------------------------------------------- payload

  private async pendingSessions(lastPushTs: string): Promise<Row[]> {
    const out: Row[] = [];
    for (const s of await this.deps.repo.listSessions()) {
      if (!s["uuid"]) continue; // filas legado sin uuid
      // DEMO (es_demo=1, báscula simulada): JAMÁS sube a la nube — se
      // autodestruye local en 1 h y el cloud no debe quedarse con datos
      // de práctica disfrazados de reales (espejo de syncworker.py).
      if (s["es_demo"]) continue;
      if (s["estado"] === "abierta" || !lastPushTs) {
        out.push(s);
        continue;
      }
      const salida = String(s["hora_salida"] ?? "");
      const entrada = String(s["hora_entrada"] ?? "");
      if (salida >= lastPushTs || entrada >= lastPushTs) out.push(s);
    }
    return out;
  }

  private sesionPayload(s: Row): Row {
    const out: Row = {};
    for (const k of SESION_SYNC_FIELDS) out[k] = s[k] ?? null;
    return out;
  }

  private async eventosPayload(s: Row): Promise<Row[]> {
    const sesionUuid = String(s["uuid"]);
    const events = await this.deps.repo.listEvents(Number(s["id"]));
    return events.map((ev) => {
      const opciones = ev["opciones"];
      const rel = ev["evento_relacionado_id"];
      return {
        uuid: eventUuid(sesionUuid, ev["id"]),
        sesion_uuid: sesionUuid,
        ts_ms: ev["ts_ms"],
        peso_antes: ev["peso_antes"],
        peso_despues: ev["peso_despues"],
        delta_kg: ev["delta_kg"],
        animales_estimados: ev["animales_estimados"],
        animales_confirmados: ev["animales_confirmados"] ?? null,
        estab_ms: ev["estab_ms"] ?? 0,
        tipo: ev["tipo"],
        ambiguo: Boolean(ev["ambiguo"]),
        opciones: Array.isArray(opciones) && opciones.length ? opciones : null,
        motivo_bajada: ev["motivo_bajada"] ?? null,
        evento_relacionado_uuid:
          rel !== null && rel !== undefined ? eventUuid(sesionUuid, rel) : null,
        confirmado_por: ev["confirmado_por"] ?? null,
      };
    });
  }

  // ---------------------------------------------------------------- push

  private async postPush(payload: Row): Promise<Row> {
    let access = await this.tokens.getAccess();
    for (let intento = 1; intento <= 2; intento++) {
      let resp: Response;
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS) : null;
      try {
        resp = await this.fetchImpl(`${this.tokens.cloudUrl}/sync/push`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${access}`,
          },
          body: JSON.stringify(payload),
          signal: ctrl?.signal,
        });
      } catch (e) {
        throw new CloudOffline(e instanceof Error ? e.name : String(e));
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
      if (resp.status === 401 && intento === 1) {
        access = await this.tokens.forceRefresh(); // SessionExpired si muere
        continue;
      }
      if (resp.status !== 200) throw new CloudError(resp.status, "");
      return (await resp.json()) as Row;
    }
    throw new CloudError(401, "no autorizado tras refresh"); // inalcanzable
  }

  /** Un ciclo de sync. Nunca lanza (reporta en el objeto de retorno). */
  async runCycle(): Promise<Record<string, unknown>> {
    if (this.cycling) return this.cycling; // sin ciclos solapados
    this.cycling = this.doCycle().finally(() => {
      this.cycling = null;
    });
    return this.cycling;
  }

  private async doCycle(): Promise<Record<string, unknown>> {
    if (!this.configured) return { configurada: false, pushed: 0 };
    const cycleStart = nowIso(this.nowMs());
    const lastPushTs = this.lsGet(LAST_PUSH_KEY);
    try {
      const pendientes = await this.pendingSessions(lastPushTs);
      let aceptadas = 0;
      let duplicadas = 0;
      for (let i = 0; i < pendientes.length; i += PUSH_BATCH_SESIONES) {
        const lote = pendientes.slice(i, i + PUSH_BATCH_SESIONES);
        const sesiones = lote.map((s) => this.sesionPayload(s));
        const eventos: Row[] = [];
        for (const s of lote) eventos.push(...(await this.eventosPayload(s)));
        for (let j = 0; j < Math.max(1, eventos.length); j += PUSH_BATCH_EVENTOS) {
          const r = await this.postPush({
            device_id: this.deviceId,
            sesiones: j === 0 ? sesiones : [],
            eventos: eventos.slice(j, j + PUSH_BATCH_EVENTOS),
          });
          aceptadas += Number(r["aceptadas"] ?? 0);
          duplicadas += Number(r["duplicadas"] ?? 0);
        }
      }
      this.lsSet(LAST_PUSH_KEY, cycleStart);
      this.lsSet(ULTIMO_PUSH_KEY, cycleStart);
      this.conectado = true;
      this.sesionVencida = false;
      this.ultimoError = null;
      return { configurada: true, ok: true, pushed: pendientes.length, aceptadas, duplicadas };
    } catch (e) {
      this.conectado = false;
      if (e instanceof SessionExpired) {
        this.sesionVencida = true;
        this.ultimoError = e.message;
        return { configurada: true, ok: false, sesion_vencida: true };
      }
      this.ultimoError = e instanceof Error ? e.message : String(e);
      return { configurada: true, ok: false, error: this.ultimoError };
    }
  }

  // --------------------------------------------------------------- timers

  /** Timer 5 min + push al recuperar red. Idempotente. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      if (this.configured && !this.sesionVencida) void this.runCycle();
    }, SYNC_INTERVAL_MS);
    try {
      window.addEventListener("online", () => this.pushSoon());
    } catch {
      /* sin window (tests node) */
    }
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.soonTimer !== null) clearTimeout(this.soonTimer);
    this.soonTimer = null;
  }

  /** Push inmediato (debounced ~1 s) — p. ej. al cerrar un pesaje. */
  pushSoon(): void {
    if (!this.configured || this.sesionVencida) return;
    if (this.soonTimer !== null) clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      void this.runCycle();
    }, 1_000);
  }

  // --------------------------------------------------------------- status

  async status(): Promise<Record<string, unknown>> {
    const configurada = this.configured;
    let pendientes = 0;
    if (configurada) {
      try {
        pendientes = (await this.pendingSessions(this.lsGet(LAST_PUSH_KEY))).length;
      } catch {
        pendientes = 0;
      }
    }
    return {
      configurada,
      conectado: this.conectado,
      sesion_vencida: this.sesionVencida,
      ultimo_push: this.lsGet(ULTIMO_PUSH_KEY) || null,
      pendientes,
      device_id: configurada ? this.deviceId : null,
      tenant: this.tenant() || null,
      cloud_url: this.cloudUrl() || null,
      error: this.ultimoError,
      perfil: this.perfil(),
    };
  }

  // -------------------------------------------------- rutas /api/cloud/*

  /**
   * Resuelve las rutas /api/cloud/* del shim (mismo contrato que los
   * endpoints de porcipeso/api/app.py). Retorna null si la ruta no es
   * de la nube.
   */
  async route(
    method: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<RouteResult | null> {
    if (!path.startsWith("/api/cloud/")) return null;
    const m = method.toUpperCase();

    if (m === "POST" && path === "/api/cloud/probe") {
      return ok(await this.probe(String(body["cloud_url"] ?? ""), String(body["tenant"] ?? "")));
    }

    if (m === "POST" && path === "/api/cloud/login") {
      const cloudUrl = String(body["cloud_url"] ?? "");
      const tenant = String(body["tenant"] ?? "");
      try {
        const pair = await cloudLogin(
          cloudUrl,
          String(body["email"] ?? ""),
          String(body["password"] ?? ""),
          this.fetchImpl,
        );
        const perfil = perfilFromToken(pair.access_token, String(body["email"] ?? ""));
        this.setSession(
          cloudUrl, tenant, pair.access_token, pair.refresh_token,
          pair.expires_in, perfil,
        );
        return ok({ perfil, ...pair });
      } catch (e) {
        if (e instanceof CloudOffline) return err(504, "sin conexión con la nube");
        if (e instanceof CloudError) return err(e.status || 502, e.message);
        return err(502, String(e));
      }
    }

    if (m === "POST" && path === "/api/cloud/session") {
      this.setSession(
        String(body["cloud_url"] ?? ""),
        String(body["tenant"] ?? ""),
        String(body["access_token"] ?? ""),
        String(body["refresh_token"] ?? ""),
        body["expires_in"] != null ? Number(body["expires_in"]) : undefined,
        (body["perfil"] as Perfil | undefined) ?? null,
      );
      return ok({ ok: true, device_id: this.deviceId });
    }

    if (m === "DELETE" && path === "/api/cloud/session") {
      await this.clearSession();
      return ok({ ok: true });
    }

    if (m === "GET" && path === "/api/cloud/token") {
      if (!this.configured) return err(409, "nube sin sesión");
      try {
        await this.tokens.getAccess();
      } catch (e) {
        if (e instanceof SessionExpired) {
          this.sesionVencida = true;
          return err(401, "sesión vencida: inicia sesión de nuevo");
        }
        if (e instanceof CloudOffline) return err(504, "sin conexión con la nube");
        if (e instanceof CloudError) return err(e.status || 502, e.message);
        return err(502, String(e));
      }
      return ok({ ...this.tokens.snapshot(), perfil: this.perfil() });
    }

    if (m === "GET" && path === "/api/cloud/status") {
      return ok(await this.status());
    }

    return err(404, `ruta desconocida: ${method} ${path}`);
  }

  private async probe(cloudUrl: string, tenant: string): Promise<Record<string, unknown>> {
    return cloudProbeShape(cloudUrl, tenant, this.fetchImpl);
  }
}
