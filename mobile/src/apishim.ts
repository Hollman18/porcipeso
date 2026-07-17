/**
 * Backend embebido — resuelve el MISMO contrato HTTP/WS de
 * porcipeso/api/app.py contra engine + db + bluetooth LOCALES, sin
 * servidor Python. La UI (porcipeso/ui/static) no se toca: installShim()
 * intercepta fetch(), WebSocket y window.open para las rutas /api/* y /ws.
 *
 * Mensajes WS idénticos: {"type":"reading",kg,ts_ms,state} ·
 * {"type":"event",…fila DB…} · {"type":"snapshot",…EngineSnapshot…}.
 *
 * Diferencia documentada: /api/sessions/{id}/export.xlsx exporta CSV
 * (no XLSX) — en nativo vía Filesystem+Share, en web como descarga.
 */
import { WeighingEngine } from "./engine";
import type { Repo } from "./db";
import {
  DEFAULT_ENGINE_CONFIG,
  EngineSnapshot,
  Reading,
  ScaleProfile,
  WeighEvent,
} from "./models";
import { isParserSupported } from "./parsers";
import { SimLiveScale, SimLiveOptions } from "./simlive";
import { downloadAndInstallApk, fetchUpdateStatus } from "./update";
import type { BluetoothScaleDriver } from "./bluetooth";

export const READING_BROADCAST_MIN_S = 0.2; // throttle ~5 msgs/s (igual que app.py)

export const SIM_PROFILE: ScaleProfile = {
  id: "simulador",
  name: "Báscula simulada (interactiva)",
  brand: "PorciPeso",
  parser: "sim",
  transport: "sim",
  extra: {},
};

// ----------------------------------------------------------------- WS shim

type WsLikeEvent = { data: string };

/** WebSocket local: mismo shape que usa app.js (onopen/onmessage/onclose). */
export class ShimWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = ShimWebSocket.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: WsLikeEvent) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  private hub: Hub;

  constructor(hub: Hub, url: string) {
    this.hub = hub;
    this.url = url;
    hub.register(this);
    queueMicrotask(() => {
      if (this.readyState === ShimWebSocket.CONNECTING) {
        this.readyState = ShimWebSocket.OPEN;
        this.onopen?.({ type: "open" });
      }
    });
  }

  send(_data: string): void {
    /* keepalive de la UI; se ignora (igual que el endpoint /ws) */
  }

  close(): void {
    this.hub.unregister(this);
    if (this.readyState !== ShimWebSocket.CLOSED) {
      this.readyState = ShimWebSocket.CLOSED;
      this.onclose?.({ type: "close" });
    }
  }
}

export class Hub {
  private sockets = new Set<ShimWebSocket>();

  register(ws: ShimWebSocket): void {
    this.sockets.add(ws);
  }

  unregister(ws: ShimWebSocket): void {
    this.sockets.delete(ws);
  }

  get count(): number {
    return this.sockets.size;
  }

  broadcast(payload: Record<string, unknown>): string {
    const msg = JSON.stringify(payload);
    for (const ws of Array.from(this.sockets)) {
      queueMicrotask(() => {
        if (ws.readyState === ShimWebSocket.OPEN) {
          try {
            ws.onmessage?.({ data: msg });
          } catch {
            /* un socket roto no tumba el hub */
          }
        }
      });
    }
    return msg;
  }
}

// ------------------------------------------------------------ tipos backend

export interface BackendDeps {
  repo: Repo;
  profiles: ScaleProfile[];
  /** Hub compartido (permite instalar el shim de WS antes del init async). */
  hub?: Hub;
  simOptions?: SimLiveOptions;
  /** Fábrica del driver BT (inyectable; en tests se mockea). */
  createBtDriver?: (
    profile: ScaleProfile,
    address: string,
    onReading: (r: Reading) => void,
    onError: (msg: string) => void,
  ) => Promise<BluetoothScaleDriver>;
  /** Exportador nativo (Filesystem+Share); si falta, descarga web. */
  shareCsv?: (filename: string, csv: string) => Promise<void>;
  /** Sync a la nube (opcional): resuelve /api/cloud/* y recibe el aviso
   *  de cierre de sesión de pesaje para empujar sin esperar el timer. */
  cloud?: {
    route(
      method: string,
      path: string,
      body: Record<string, unknown>,
    ): Promise<JsonResponse | null>;
    onSessionClosed?: () => void;
  };
}

export interface JsonResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function ok(body: unknown, status = 200): JsonResponse {
  return { status, body };
}

function err(status: number, detail: string): JsonResponse {
  return { status, body: { detail } };
}

// ---------------------------------------------------------------- backend

export class LocalBackend {
  readonly hub: Hub;
  readonly repo: Repo;
  private profiles: ScaleProfile[];
  private simOptions: SimLiveOptions;
  private createBtDriver: BackendDeps["createBtDriver"];
  private shareCsvFn: BackendDeps["shareCsv"];
  private cloud: BackendDeps["cloud"];

  engine: WeighingEngine | null = null;
  currentSessionId: number | null = null;
  sim: SimLiveScale | null = null;
  btDriver: BluetoothScaleDriver | null = null;
  driverProfile: ScaleProfile | null = null;
  driverError: string | null = null;
  lastReading: Reading | null = null;
  private lastReadingBroadcast = 0;
  private eventIdMap = new Map<number, number>(); // id de DB -> id interno engine
  /** Cadena que serializa escrituras DB + broadcasts (orden de app.py). */
  private chain: Promise<void> = Promise.resolve();

  constructor(deps: BackendDeps) {
    this.hub = deps.hub ?? new Hub();
    this.repo = deps.repo;
    this.profiles = deps.profiles;
    this.simOptions = deps.simOptions ?? {};
    this.createBtDriver = deps.createBtDriver;
    this.shareCsvFn = deps.shareCsv;
    this.cloud = deps.cloud;
  }

  /** Espera a que terminen las escrituras/broadcasts en vuelo (tests). */
  async flush(): Promise<void> {
    await this.chain;
  }

  private enqueue(job: () => Promise<void>): void {
    this.chain = this.chain.then(job).catch(() => {});
  }

  // ----------------------------------------------------------- wiring motor

  private snapshotDict(snap: EngineSnapshot): Record<string, unknown> {
    return { ...snap };
  }

  private broadcastSnapshot(): void {
    if (this.engine === null) return;
    let snap: Record<string, unknown>;
    try {
      snap = this.snapshotDict(this.engine.snapshot());
    } catch {
      return;
    }
    this.hub.broadcast({ type: "snapshot", ...snap });
  }

  private onEngineEvent = (event: WeighEvent): void => {
    if (this.currentSessionId !== null && !event.session_id) {
      event.session_id = this.currentSessionId;
    }
    // NO se pisa event.id: el engine usa su id interno en confirm();
    // el mapa traduce el id de DB (el que ve la API) al del engine.
    const engineId = event.id;
    const copy = { ...event, opciones: [...event.opciones] };
    this.enqueue(async () => {
      const dbId = await this.repo.insertEvent(copy);
      this.eventIdMap.set(dbId, engineId ?? dbId);
      const stored = await this.repo.getEvent(dbId);
      if (stored !== null) this.hub.broadcast({ type: "event", ...stored });
      this.broadcastSnapshot();
    });
  };

  private onEngineState = (_state: string): void => {
    this.broadcastSnapshot();
  };

  ensureEngine(): WeighingEngine {
    if (this.engine === null) {
      this.engine = new WeighingEngine(
        { ...DEFAULT_ENGINE_CONFIG },
        this.onEngineEvent,
        this.onEngineState,
      );
    }
    return this.engine;
  }

  // ---------------------------------------------------------- lecturas

  onReading = (reading: Reading): void => {
    this.lastReading = reading;
    if (this.engine !== null) {
      try {
        this.engine.feed(reading);
      } catch {
        /* paridad con app.py: un feed roto no corta el stream */
      }
    }
    if (this.currentSessionId !== null) {
      const sid = this.currentSessionId;
      this.enqueue(() => this.repo.insertReading(sid, reading.ts_ms, reading.kg));
    }
    const now = Date.now() / 1000.0;
    if (now - this.lastReadingBroadcast >= READING_BROADCAST_MIN_S) {
      this.lastReadingBroadcast = now;
      let state = "idle";
      let fase = "lote";
      if (this.engine !== null) {
        try {
          const snap = this.engine.snapshot();
          state = snap.state;
          fase = snap.fase ?? "lote";
        } catch {
          /* estado por defecto */
        }
      }
      this.hub.broadcast({
        type: "reading",
        kg: reading.kg,
        ts_ms: reading.ts_ms,
        state,
        fase,
      });
    }
  };

  async stopDriver(): Promise<void> {
    if (this.sim !== null) {
      this.sim.stop();
      this.sim = null;
    }
    if (this.btDriver !== null) {
      try {
        await this.btDriver.disconnect();
      } catch {
        /* ya caído */
      }
      this.btDriver = null;
    }
    this.driverProfile = null;
  }

  // -------------------------------------------------------------- routing

  /**
   * Resuelve una petición /api/*. Retorna una Response estándar con la
   * MISMA forma de payloads que FastAPI (errores = {"detail": msg}).
   */
  async handleFetch(method: string, url: string, bodyText: string | null): Promise<Response> {
    const u = new URL(url, "http://localhost");
    const path = u.pathname;
    let body: Record<string, unknown> = {};
    if (bodyText) {
      try {
        body = JSON.parse(bodyText) as Record<string, unknown>;
      } catch {
        return this.toResponse(err(422, "JSON inválido"));
      }
    }
    let res: JsonResponse;
    try {
      res = await this.route(method.toUpperCase(), path, u.searchParams, body);
    } catch (e) {
      res = err(500, String(e));
    }
    return this.toResponse(res);
  }

  private toResponse(r: JsonResponse): Response {
    if (typeof r.body === "string") {
      return new Response(r.body, {
        status: r.status,
        headers: r.headers ?? { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json", ...(r.headers ?? {}) },
    });
  }

  private async route(
    method: string,
    path: string,
    q: URLSearchParams,
    body: Record<string, unknown>,
  ): Promise<JsonResponse> {
    let m: RegExpExecArray | null;

    // Nube (login/roles/sync): delega en el CloudSync inyectado.
    if (path.startsWith("/api/cloud/")) {
      if (this.cloud) {
        const r = await this.cloud.route(method, path, body);
        if (r !== null) return r;
      }
      return err(404, `nube no disponible: ${method} ${path}`);
    }

    if (method === "GET" && path === "/api/profiles") return this.getProfiles();
    if (method === "POST" && path === "/api/scale/connect") return this.scaleConnect(body);
    if (method === "GET" && path === "/api/scale/status") return this.scaleStatus();
    if (method === "GET" && path === "/api/bt/devices") return this.btDevices();

    // Auto-actualización: mismo contrato que porcipeso/api/updatecheck.py
    if (method === "GET" && path === "/api/update/status") return ok(await fetchUpdateStatus());
    if (method === "POST" && path === "/api/update/download") return this.updateDownload(body);

    if (method === "POST" && path === "/api/sim/start") return this.simStart();
    if (method === "POST" && path === "/api/sim/action") return this.simAction(body);
    if (method === "POST" && path === "/api/sim/stop") return this.simStop();

    if (method === "POST" && path === "/api/sessions") return this.createSession(body);
    if (method === "GET" && path === "/api/sessions") {
      return ok(await this.repo.listSessions(q.get("desde"), q.get("hasta"), q.get("q")));
    }
    if (method === "GET" && path === "/api/stats/global") {
      return ok(await this.repo.statsGlobal(q.get("desde"), q.get("hasta")));
    }

    if ((m = /^\/api\/sessions\/(\d+)$/.exec(path)) && method === "GET") {
      const session = await this.repo.getSession(Number(m[1]));
      return session === null ? err(404, "sesión no encontrada") : ok(session);
    }
    if ((m = /^\/api\/sessions\/(\d+)\/close$/.exec(path)) && method === "POST") {
      return this.closeSession(Number(m[1]), body);
    }
    if ((m = /^\/api\/sessions\/(\d+)\/events$/.exec(path)) && method === "GET") {
      const id = Number(m[1]);
      if ((await this.repo.getSession(id)) === null) return err(404, "sesión no encontrada");
      return ok(await this.repo.listEvents(id));
    }
    if ((m = /^\/api\/sessions\/(\d+)\/stats$/.exec(path)) && method === "GET") {
      const id = Number(m[1]);
      if ((await this.repo.getSession(id)) === null) return err(404, "sesión no encontrada");
      return ok(await this.repo.stats(id));
    }
    if ((m = /^\/api\/sessions\/(\d+)\/export\.xlsx$/.exec(path)) && method === "GET") {
      return this.exportCsv(Number(m[1]));
    }
    // DIFERENCIA DOCUMENTADA: en escritorio esta ruta devuelve un PDF
    // real (reportlab, porcipeso/api/reports.py). reportlab no corre en
    // el APK, así que aquí respondemos un HTML imprimible con la MISMA
    // estructura y marca; la UI lo abre y window.print() genera el PDF
    // nativo en Android (ver reportview.ts).
    if ((m = /^\/api\/sessions\/(\d+)\/report\.pdf$/.exec(path)) && method === "GET") {
      return this.reportPrintView(Number(m[1]));
    }
    if ((m = /^\/api\/events\/(\d+)\/confirm$/.exec(path)) && method === "POST") {
      return this.confirmEvent(Number(m[1]), body);
    }
    if ((m = /^\/api\/events\/(\d+)\/motivo$/.exec(path)) && method === "POST") {
      return this.eventMotivo(Number(m[1]), body);
    }
    return err(404, `ruta desconocida: ${method} ${path}`);
  }

  // -------------------------------------------------------- actualización

  /** Descarga el APK nuevo y abre el instalador (solo Android). */
  private async updateDownload(body: Record<string, unknown>): Promise<JsonResponse> {
    let apkUrl = body["apk_url"] != null ? String(body["apk_url"]) : "";
    if (!apkUrl) {
      apkUrl = (await fetchUpdateStatus()).apk_url ?? ""; // cacheado 6 h
    }
    if (!apkUrl) return err(404, "no hay apk_url: no hay actualización disponible");
    try {
      const path = await downloadAndInstallApk(apkUrl);
      return ok({ ok: true, path });
    } catch (e) {
      return err(502, `descarga/instalación falló: ${String(e instanceof Error ? e.message : e)}`);
    }
  }

  // ------------------------------------------------------------- báscula

  private getProfiles(): JsonResponse {
    // Perfiles del catálogo (copiados de drivers/profiles.yaml); los que
    // usan parsers aún no portados a TS se marcan en el nombre.
    const out = this.profiles.map((p) => ({
      ...p,
      name: isParserSupported(p.parser) ? p.name : `${p.name} — próximamente en móvil`,
    }));
    return ok(out);
  }

  private async btDevices(): Promise<JsonResponse> {
    try {
      const { BluetoothScaleDriver } = await import("./bluetooth");
      return ok(await BluetoothScaleDriver.listDevices());
    } catch (e) {
      return err(503, `Bluetooth no disponible: ${String(e)}`);
    }
  }

  private async scaleConnect(body: Record<string, unknown>): Promise<JsonResponse> {
    const profileId = String(body["profile_id"] ?? "");
    if (profileId === "sim" || profileId === "simulador") return this.simStart();

    const found = this.profiles.find((p) => p.id === profileId);
    if (!found) return err(404, `perfil desconocido: ${profileId}`);
    const profile: ScaleProfile = { ...found, extra: { ...found.extra } };
    if (body["port"]) profile.port = String(body["port"]);

    if (!isParserSupported(profile.parser)) {
      return err(
        400,
        `el perfil '${profile.id}' aún no está soportado en la app móvil ` +
          "(usa Matrix, XK3190 o el genérico regex, o la báscula simulada)",
      );
    }
    // En el teléfono el "puerto" es la dirección MAC Bluetooth del
    // conversor SPP (ej. 00:14:03:05:59:02) — va en el campo Puerto de
    // la vista Báscula.
    const address = (profile.port ?? "").trim();
    if (!address) {
      return err(400, "el perfil requiere 'port': la dirección Bluetooth (MAC) del indicador");
    }

    await this.stopDriver();
    this.ensureEngine();
    this.driverError = null;
    try {
      const factory = this.createBtDriver ?? (await defaultBtFactory());
      const driver = await factory(
        profile,
        address,
        this.onReading,
        (msg) => {
          this.driverError = msg;
        },
      );
      this.btDriver = driver;
      this.driverProfile = profile;
    } catch (e) {
      this.driverError = String(e instanceof Error ? e.message : e);
      return err(400, this.driverError);
    }
    return ok({ connected: true, profile_id: profile.id, transport: "bluetooth" });
  }

  private async scaleStatus(): Promise<JsonResponse> {
    let connected = this.sim !== null && this.sim.running;
    if (!connected && this.btDriver !== null) {
      connected = await this.btDriver.isConnected();
    }
    const reading = this.lastReading;
    let state = "idle";
    if (this.engine !== null) {
      try {
        state = this.engine.snapshot().state;
      } catch {
        /* estado por defecto */
      }
    }
    return ok({
      connected,
      profile_id: this.driverProfile ? this.driverProfile.id : null,
      last_kg: reading ? reading.kg : null,
      last_ts_ms: reading ? reading.ts_ms : null,
      state,
      error: this.driverError,
    });
  }

  // ------------------------------------------------------- simulador vivo

  private async simStart(): Promise<JsonResponse> {
    await this.stopDriver();
    this.ensureEngine();
    const sim = new SimLiveScale(this.onReading, this.simOptions).start();
    this.sim = sim;
    this.driverError = null;
    this.driverProfile = SIM_PROFILE;
    return ok({
      connected: true,
      profile_id: SIM_PROFILE.id,
      transport: SIM_PROFILE.transport,
      ...sim.status(),
    });
  }

  private simAction(body: Record<string, unknown>): JsonResponse {
    const sim = this.sim;
    if (sim === null || !sim.running) {
      return err(409, "el simulador no está iniciado: llama primero a POST /api/sim/start");
    }
    const action = String(body["action"] ?? "");
    try {
      let estado: Record<string, unknown>;
      if (action === "pigs_on") {
        estado = sim.pigsOn(
          Number(body["n"] ?? 1) || 1,
          body["kg_each"] != null ? (body["kg_each"] as number | number[]) : null,
        );
      } else if (action === "pig_off") {
        estado = sim.pigOff();
      } else if (action === "nervous") {
        estado = sim.nervous(body["seconds"] != null ? Number(body["seconds"]) : 3.0);
      } else if (action === "silence") {
        estado = sim.silence(body["seconds"] != null ? Number(body["seconds"]) : 4.0);
      } else {
        return err(422, `acción desconocida: ${action}`);
      }
      return ok({ action, ...estado });
    } catch (e) {
      return err(400, String(e instanceof Error ? e.message : e));
    }
  }

  private async simStop(): Promise<JsonResponse> {
    const wasRunning = this.sim !== null;
    await this.stopDriver();
    return ok({ connected: false, stopped: wasRunning });
  }

  // --------------------------------------------------------------- sesiones

  private async createSession(body: Record<string, unknown>): Promise<JsonResponse> {
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (v !== null && v !== undefined) data[k] = v;
    }
    if ("corral" in data && !("corral_origen" in data)) {
      data["corral_origen"] = data["corral"];
    }
    delete data["corral"];
    const modo = String(data["modo"] ?? "") || "lote";
    if (modo !== "lote" && modo !== "unidades") {
      // mismo contrato que app.py: validado ANTES de insertar la fila
      return err(400, `modo desconocido: '${modo}' (esperado: ('lote', 'unidades'))`);
    }
    data["modo"] = modo;
    const engine = this.ensureEngine();
    const sessionId = await this.repo.createSession(data);
    engine.openSession(sessionId, modo);
    this.currentSessionId = sessionId;
    this.broadcastSnapshot();
    const session = await this.repo.getSession(sessionId);
    return ok(session, 201);
  }

  private async closeSession(sessionId: number, body: Record<string, unknown>): Promise<JsonResponse> {
    const session = await this.repo.getSession(sessionId);
    if (session === null) return err(404, "sesión no encontrada");
    if (session["estado"] !== "abierta") return err(409, `la sesión está ${session["estado"]}`);

    await this.flush(); // eventos en vuelo quedan persistidos antes del cierre

    let snap: Record<string, unknown>;
    if (this.engine !== null && this.currentSessionId === sessionId) {
      snap = this.snapshotDict(this.engine.closeSession());
      this.currentSessionId = null;
      this.eventIdMap = new Map(); // los ids internos del engine se resetean
    } else {
      const stats = await this.repo.stats(sessionId);
      snap = {
        total_kg: stats["total_kg"],
        count: stats["total_animales"],
        avg_kg: stats["promedio"],
      };
    }
    const conteo = body["conteo_fisico"] != null ? Number(body["conteo_fisico"]) : null;
    const closed = await this.repo.closeSession(sessionId, snap, conteo);
    this.hub.broadcast({
      type: "snapshot",
      state: "idle",
      kg_now: 0.0,
      ref_kg: null,
      avg_kg: closed?.["promedio_final"] ?? null,
      count: (closed?.["total_animales"] as number) ?? 0,
      total_kg: (closed?.["total_kg"] as number) ?? 0.0,
      pending: 0,
      fase: "lote",
    });
    // nube: empuja el cierre sin esperar el timer de 5 min
    try {
      this.cloud?.onSessionClosed?.();
    } catch {
      /* el sync jamás rompe el cierre */
    }
    return ok(closed);
  }

  private async confirmEvent(eventId: number, body: Record<string, unknown>): Promise<JsonResponse> {
    await this.flush(); // asegura que el evento ya esté en DB y en el mapa
    if ((await this.repo.getEvent(eventId)) === null) return err(404, "evento no encontrado");
    const n = Number(body["n"]);
    if (!Number.isInteger(n)) return err(422, "n debe ser entero");
    if (this.engine !== null) {
      // el engine indexa por SU id de evento, no por el rowid de DB
      const engineEventId = this.eventIdMap.get(eventId) ?? eventId;
      try {
        this.engine.confirm(engineEventId, n);
      } catch {
        /* paridad con app.py: suppress */
      }
    }
    const confirmadoPor = body["confirmado_por"] != null ? String(body["confirmado_por"]) : null;
    await this.repo.updateEventConfirm(eventId, n, confirmadoPor);
    const updated = await this.repo.getEvent(eventId);
    this.hub.broadcast({ type: "event", ...(updated as Record<string, unknown>) });
    this.broadcastSnapshot();
    return ok(updated);
  }

  private async eventMotivo(eventId: number, body: Record<string, unknown>): Promise<JsonResponse> {
    await this.flush();
    if ((await this.repo.getEvent(eventId)) === null) return err(404, "evento no encontrado");
    const motivo = String(body["motivo"] ?? "");
    if (!motivo) return err(422, "motivo requerido");
    await this.repo.setEventMotivo(eventId, motivo);
    const updated = await this.repo.getEvent(eventId);
    this.hub.broadcast({ type: "event", ...(updated as Record<string, unknown>) });
    return ok(updated);
  }

  // ----------------------------------------------------------------- export

  /**
   * En móvil el export es CSV (no hay openpyxl): mismas dos secciones
   * del XLSX del backend (Resumen + Eventos) en un solo archivo.
   */
  async buildCsv(sessionId: number): Promise<string | null> {
    const session = await this.repo.getSession(sessionId);
    if (session === null) return null;
    const events = await this.repo.listEvents(sessionId);
    const stats = await this.repo.stats(sessionId);
    return buildCsv(session, events, stats);
  }

  private async exportCsv(sessionId: number): Promise<JsonResponse> {
    const csv = await this.buildCsv(sessionId);
    if (csv === null) return err(404, "sesión no encontrada");
    return {
      status: 200,
      body: csv,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="sesion_${sessionId}.csv"`,
      },
    };
  }

  /**
   * Print-view del informe (ruta report.pdf en móvil): HTML imprimible
   * con la marca "PorciPeso · una solución ELEIA" (ver reportview.ts).
   */
  async buildReportHtml(sessionId: number): Promise<string | null> {
    const session = await this.repo.getSession(sessionId);
    if (session === null) return null;
    const events = await this.repo.listEvents(sessionId);
    const stats = await this.repo.stats(sessionId);
    const { buildReportHtml } = await import("./reportview");
    const { APP_VERSION } = await import("./update");
    return buildReportHtml(session, events, stats, APP_VERSION);
  }

  private async reportPrintView(sessionId: number): Promise<JsonResponse> {
    const html = await this.buildReportHtml(sessionId);
    if (html === null) return err(404, "sesión no encontrada");
    return {
      status: 200,
      body: html,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    };
  }

  /**
   * Informe para window.open(): abre el print-view y lanza
   * window.print() — en Android el diálogo del sistema genera el PDF
   * nativo (equivalente móvil del PDF reportlab del escritorio).
   */
  async reportAndPrint(sessionId: number): Promise<boolean> {
    const html = await this.buildReportHtml(sessionId);
    if (html === null) return false;
    if (typeof document === "undefined") return false;
    const { openPrintView } = await import("./reportview");
    openPrintView(html);
    return true;
  }

  /** Export para window.open(): comparte en nativo o descarga en web. */
  async exportAndShare(sessionId: number): Promise<boolean> {
    const csv = await this.buildCsv(sessionId);
    if (csv === null) return false;
    const filename = `sesion_${sessionId}.csv`;
    if (this.shareCsvFn) {
      await this.shareCsvFn(filename, csv);
      return true;
    }
    if (typeof document !== "undefined") {
      const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      return true;
    }
    return false;
  }
}

async function defaultBtFactory(): Promise<NonNullable<BackendDeps["createBtDriver"]>> {
  const { BluetoothScaleDriver } = await import("./bluetooth");
  return async (profile, address, onReading, onError) => {
    const driver = new BluetoothScaleDriver(profile, address, onReading, onError);
    await driver.connect();
    return driver;
  };
}

// ------------------------------------------------------------------- CSV

/** Columnas idénticas a EVENT_COLUMNS de app.py. */
export const EVENT_COLUMNS = [
  "id", "ts_ms", "tipo", "peso_antes", "peso_despues", "delta_kg",
  "animales_estimados", "animales_confirmados", "estab_ms", "ambiguo",
  "opciones", "motivo_bajada", "evento_relacionado_id", "confirmado_por",
] as const;

const RESUMEN_ROWS: Array<[string, string]> = [
  ["Granja", "granja"], ["Lote", "lote"], ["Corral origen", "corral_origen"],
  ["Destino", "destino"], ["Placa", "placa"], ["Conductor", "conductor"],
  ["Operador", "operador"], ["Báscula", "bascula_id"],
  ["Peso ref. inicial (kg)", "peso_ref_inicial"],
  ["Hora entrada", "hora_entrada"], ["Hora salida", "hora_salida"],
  ["Total kg", "total_kg"], ["Total animales", "total_animales"],
  ["Promedio final (kg)", "promedio_final"],
  ["Conteo físico", "conteo_fisico"],
  ["Diferencia conciliación", "diferencia_conciliacion"],
  ["Estado", "estado"],
];

const STATS_ROWS: Array<[string, string]> = [
  ["Desviación estándar (kg)", "desviacion_std"],
  ["CV %", "cv_pct"],
  ["Uniformidad ±10% (%)", "uniformidad_pct"],
  ["Delta mínimo (kg)", "min_delta"],
  ["Delta máximo (kg)", "max_delta"],
];

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

export function buildCsv(
  session: Record<string, unknown>,
  events: Array<Record<string, unknown>>,
  stats: Record<string, unknown>,
): string {
  const lines: string[] = [];
  lines.push(csvRow(["Sesión", session["id"]]));
  lines.push(csvRow(["UUID", session["uuid"]]));
  for (const [label, key] of RESUMEN_ROWS) lines.push(csvRow([label, session[key]]));
  lines.push("");
  lines.push(csvRow(["— Estadística —", ""]));
  for (const [label, key] of STATS_ROWS) lines.push(csvRow([label, stats[key]]));
  lines.push("");
  lines.push(csvRow([...EVENT_COLUMNS]));
  for (const ev of events) {
    const row = EVENT_COLUMNS.map((col) => {
      let value = ev[col];
      if (col === "opciones") {
        value = value && (value as unknown[]).length ? JSON.stringify(value) : null;
      } else if (col === "ambiguo") {
        value = value ? 1 : 0;
      }
      return value;
    });
    lines.push(csvRow(row));
  }
  return lines.join("\r\n") + "\r\n";
}

// ------------------------------------------------------------ instalación

/**
 * Parchea fetch(), WebSocket y window.open ANTES de que corra app.js:
 * las rutas /api/* y /ws se resuelven contra el backend local; todo lo
 * demás sigue su camino nativo.
 *
 * El hub se pasa aparte para que el parcheo sea SÍNCRONO aunque el
 * backend (sqlite) todavía esté inicializándose: los WebSocket de la UI
 * quedan registrados desde el primer instante y las peticiones /api
 * esperan al init.
 */
export function installShim(
  hub: Hub,
  getBackend: () => Promise<LocalBackend>,
  w: typeof globalThis & Window = window,
): void {
  const origFetch = w.fetch.bind(w);
  w.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let path: string;
    try {
      path = new URL(url, w.location.href).pathname;
    } catch {
      return origFetch(input as RequestInfo, init);
    }
    if (!path.startsWith("/api/")) return origFetch(input as RequestInfo, init);
    const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    let bodyText: string | null = null;
    if (init?.body != null) bodyText = String(init.body);
    else if (typeof input === "object" && "text" in input && (input as Request).body) {
      bodyText = await (input as Request).text();
    }
    const backend = await getBackend();
    return backend.handleFetch(method || "GET", url, bodyText);
  }) as typeof fetch;

  const NativeWS = w.WebSocket;
  function PatchedWebSocket(this: unknown, url: string | URL, protocols?: string | string[]) {
    let pathname = "";
    try {
      pathname = new URL(String(url), w.location.href).pathname;
    } catch {
      /* URL rara: WS nativo */
    }
    if (pathname === "/ws" || pathname.endsWith("/ws")) {
      return new ShimWebSocket(hub, String(url));
    }
    return new NativeWS(url, protocols);
  }
  PatchedWebSocket.prototype = NativeWS?.prototype ?? ShimWebSocket.prototype;
  Object.assign(PatchedWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  (w as { WebSocket: unknown }).WebSocket = PatchedWebSocket;

  const origOpen = w.open ? w.open.bind(w) : null;
  w.open = ((url?: string | URL, target?: string, features?: string) => {
    const s = url != null ? String(url) : "";
    const path = s.split("?")[0] ?? "";
    const m = /\/api\/sessions\/(\d+)\/export\.xlsx$/.exec(path);
    if (m) {
      void getBackend().then((b) => b.exportAndShare(Number(m[1])));
      return null;
    }
    // report.pdf → print-view + window.print() (PDF nativo de Android;
    // ver reportview.ts para la diferencia con el reportlab de escritorio)
    const mp = /\/api\/sessions\/(\d+)\/report\.pdf$/.exec(path);
    if (mp) {
      void getBackend().then((b) => b.reportAndPrint(Number(mp[1])));
      return null;
    }
    return origOpen ? origOpen(url, target, features) : null;
  }) as typeof window.open;
}
