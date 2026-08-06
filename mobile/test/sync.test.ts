/**
 * Tests de mobile/src/sync.ts + cloudauth.ts — espejo de
 * tests/api/test_sync_cloud.py con fetch MOCKEADO (sin red):
 *
 * - ciclo → push de sesiones+eventos con device_id y uuids derivados
 * - idempotencia (2 ciclos: lo cerrado y ya subido no se re-manda)
 * - sesión abierta se re-sube y el cierre posterior también
 * - 401 → refresh (rotativo, persistido) → reintento OK
 * - offline → no crashea, queda pendiente y reanuda al volver la red
 * - refresh muerto → sesión vencida (sin perder datos locales)
 * - rutas /api/cloud/* del shim (login/session/token/status/logout)
 */
import { describe, expect, it } from "vitest";
import {
  decodeClaims,
  perfilFromToken,
  REFRESH_KEY,
  LAST_PUSH_KEY,
} from "../src/cloudauth";
import { CloudSync, eventUuid, type SyncRepo } from "../src/sync";
import { CLOUD_URL_KEY, TENANT_KEY } from "../src/update";

const CLOUD = "https://nube.test";

type Row = Record<string, unknown>;

// ------------------------------------------------------------- fixtures

function fakeStorage(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

function sesion(id: number, estado: "abierta" | "cerrada", extra: Row = {}): Row {
  return {
    id,
    uuid: `uuid-sesion-${id}`,
    lote: `L-${id}`,
    granja: "La Esperanza",
    // fechas FIJAS en el pasado: el marcador de push (hora real) debe
    // quedar después del cierre para que la idempotencia sea observable
    hora_entrada: "2026-01-05T08:00:00+00:00",
    hora_salida: estado === "cerrada" ? "2026-01-05T09:00:00+00:00" : null,
    total_kg: estado === "cerrada" ? 104.2 : null,
    total_animales: estado === "cerrada" ? 1 : null,
    estado,
    modo: "lote",
    ...extra,
  };
}

function evento(id: number, sesionId: number): Row {
  return {
    id,
    sesion_id: sesionId,
    ts_ms: 1000 + id,
    peso_antes: 0,
    peso_despues: 104.2,
    delta_kg: 104.2,
    animales_estimados: 1,
    animales_confirmados: null,
    estab_ms: 800,
    tipo: "subida",
    ambiguo: false,
    opciones: [],
    motivo_bajada: null,
    evento_relacionado_id: null,
    confirmado_por: null,
  };
}

function fakeRepo(sesiones: Row[], eventos: Map<number, Row[]>): SyncRepo {
  return {
    listSessions: async () => sesiones,
    listEvents: async (sid: number) => eventos.get(sid) ?? [],
  };
}

/** JWT sin firmar con claims de UX (el shim no verifica firma). */
function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64(claims)}.firma`;
}

interface CloudCall {
  url: string;
  method: string;
  auth: string;
  body: Row;
}

/** Mini-cloud mockeado: /auth/login|refresh|logout + /sync/push. */
function fakeCloud(opts: {
  accessOk?: string;
  refreshOk?: string;
  failFirstPush401?: boolean;
  offline?: boolean;
} = {}) {
  const accessOk = opts.accessOk ?? fakeJwt({ sub: "u1", rol: "admin", nombre: "Ana" });
  let refreshOk = opts.refreshOk ?? "refresh-1";
  const calls: CloudCall[] = [];
  let push401Left = opts.failFirstPush401 ? 1 : 0;
  const state = { offline: opts.offline ?? false, accessOk, get refreshOk() { return refreshOk; } };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (state.offline) throw new TypeError("fetch failed");
    const body = init?.body ? (JSON.parse(String(init.body)) as Row) : {};
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? "GET", auth: headers["Authorization"] ?? "", body });

    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status });

    if (url.endsWith("/auth/login")) {
      if (body["password"] !== "clave-admin-1") return json(401, { detail: "credenciales inválidas" });
      return json(200, { access_token: accessOk, refresh_token: refreshOk, expires_in: 1800 });
    }
    if (url.endsWith("/auth/refresh")) {
      if (body["refresh_token"] !== refreshOk) return json(401, { detail: "refresh token inválido" });
      refreshOk = `${refreshOk}-rot`; // rotación
      return json(200, { access_token: accessOk, refresh_token: refreshOk, expires_in: 1800 });
    }
    if (url.endsWith("/auth/logout")) return json(200, { ok: true });
    if (url.endsWith("/health")) return json(200, { ok: true });
    if (url.includes("/config/app")) return json(200, { banners: [] });
    if (url.endsWith("/sync/push")) {
      if (headers["Authorization"] !== `Bearer ${accessOk}` || push401Left-- > 0) {
        if (headers["Authorization"] !== `Bearer ${accessOk}`) return json(401, { detail: "token inválido" });
        return json(401, { detail: "token inválido" });
      }
      const ses = (body["sesiones"] as Row[]) ?? [];
      const evs = (body["eventos"] as Row[]) ?? [];
      return json(200, { aceptadas: ses.length + evs.length, duplicadas: 0 });
    }
    return json(404, { detail: `ruta ${url}` });
  }) as typeof fetch;

  return { fetchImpl, calls, state };
}

function pushes(calls: CloudCall[]): CloudCall[] {
  return calls.filter((c) => c.url.endsWith("/sync/push"));
}

function newSync(repo: SyncRepo, fetchImpl: typeof fetch, storage = fakeStorage()) {
  const sync = new CloudSync({
    repo,
    deviceId: "dev-movil-1",
    storage,
    fetchImpl,
  });
  return { sync, storage };
}

// ------------------------------------------------------------------ tests

describe("CloudSync.runCycle", () => {
  it("sin configurar → no-op silencioso (standalone intacto)", async () => {
    const cloud = fakeCloud();
    const { sync } = newSync(fakeRepo([], new Map()), cloud.fetchImpl);
    const out = await sync.runCycle();
    expect(out).toEqual({ configurada: false, pushed: 0 });
    expect(cloud.calls.length).toBe(0);
  });

  it("un ciclo sube sesiones + eventos con device_id y uuids derivados", async () => {
    const cloud = fakeCloud();
    const eventos = new Map([[1, [evento(10, 1), evento(11, 1)]]]);
    const { sync } = newSync(
      fakeRepo([sesion(1, "cerrada")], eventos), cloud.fetchImpl,
    );
    sync.setSession(CLOUD, "granja-a", cloud.state.accessOk, "refresh-1", 1800);

    const out = await sync.runCycle();
    expect(out["ok"]).toBe(true);
    expect(out["pushed"]).toBe(1);

    const p = pushes(cloud.calls);
    expect(p.length).toBe(1);
    expect(p[0].auth).toBe(`Bearer ${cloud.state.accessOk}`);
    expect(p[0].body["device_id"]).toBe("dev-movil-1");
    const ses = p[0].body["sesiones"] as Row[];
    const evs = p[0].body["eventos"] as Row[];
    expect(ses.length).toBe(1);
    expect(ses[0]["uuid"]).toBe("uuid-sesion-1");
    expect(ses[0]["estado"]).toBe("cerrada");
    expect(evs.map((e) => e["uuid"])).toEqual([
      eventUuid("uuid-sesion-1", 10),
      eventUuid("uuid-sesion-1", 11),
    ]);
    expect(evs[0]["sesion_uuid"]).toBe("uuid-sesion-1");
    expect(evs[0]["opciones"]).toBeNull(); // [] local → null en el push
  });

  it("idempotencia: 2º ciclo no re-manda lo cerrado ya subido", async () => {
    const cloud = fakeCloud();
    const { sync } = newSync(
      fakeRepo([sesion(1, "cerrada")], new Map([[1, [evento(10, 1)]]])),
      cloud.fetchImpl,
    );
    sync.setSession(CLOUD, "granja-a", cloud.state.accessOk, "refresh-1", 1800);
    // hora de "hoy" para que el marcador quede DESPUÉS del cierre viejo
    expect((await sync.runCycle())["pushed"]).toBe(1);
    const out2 = await sync.runCycle();
    expect(out2["ok"]).toBe(true);
    expect(out2["pushed"]).toBe(0); // nada cambió → nada que subir
    expect(pushes(cloud.calls).length).toBe(1);
  });

  it("abierta se re-sube cada ciclo y el cierre posterior también", async () => {
    const cloud = fakeCloud();
    const rows = [sesion(1, "abierta")];
    const { sync } = newSync(fakeRepo(rows, new Map()), cloud.fetchImpl);
    sync.setSession(CLOUD, "granja-a", cloud.state.accessOk, "refresh-1", 1800);

    expect((await sync.runCycle())["pushed"]).toBe(1);
    expect((await sync.runCycle())["pushed"]).toBe(1); // abierta: SIEMPRE

    // se cierra AHORA (hora_salida futura respecto al marcador)
    rows[0] = sesion(1, "cerrada", {
      hora_salida: new Date(Date.now() + 60_000).toISOString().slice(0, 19) + "+00:00",
    });
    const out = await sync.runCycle();
    expect(out["pushed"]).toBe(1);
    const all = pushes(cloud.calls);
    const last = all[all.length - 1];
    expect((last.body["sesiones"] as Row[])[0]["estado"]).toBe("cerrada");
  });

  it("401 → refresh rotativo (persistido) → reintento OK", async () => {
    const cloud = fakeCloud();
    const storage = fakeStorage();
    const { sync } = newSync(
      fakeRepo([sesion(1, "cerrada")], new Map()), cloud.fetchImpl, storage,
    );
    // access basura "vigente" → el push da 401 de verdad
    sync.setSession(CLOUD, "granja-a", "token-basura", "refresh-1", 9999);

    const out = await sync.runCycle();
    expect(out["ok"]).toBe(true);
    expect(pushes(cloud.calls).length).toBe(2); // 401 + reintento
    expect(cloud.calls.some((c) => c.url.endsWith("/auth/refresh"))).toBe(true);
    // el refresh rotado quedó persistido para sobrevivir reinicios
    expect(storage.data.get(REFRESH_KEY)).toBe("refresh-1-rot");
  });

  it("offline → no crashea, queda pendiente y reanuda al volver", async () => {
    const cloud = fakeCloud({ offline: true });
    const { sync } = newSync(
      fakeRepo([sesion(1, "cerrada")], new Map()), cloud.fetchImpl,
    );
    sync.setSession(CLOUD, "granja-a", cloud.state.accessOk, "refresh-1", 1800);

    const out = await sync.runCycle();
    expect(out["ok"]).toBe(false);
    expect(out["sesion_vencida"]).toBeUndefined();
    let st = await sync.status();
    expect(st["configurada"]).toBe(true);
    expect(st["conectado"]).toBe(false);
    expect(st["pendientes"]).toBe(1); // nada se perdió

    cloud.state.offline = false; // vuelve la señal
    expect((await sync.runCycle())["ok"]).toBe(true);
    st = await sync.status();
    expect(st["conectado"]).toBe(true);
    expect(st["pendientes"]).toBe(0);
  });

  it("refresh muerto → sesión vencida sin perder datos", async () => {
    const cloud = fakeCloud();
    const { sync } = newSync(
      fakeRepo([sesion(1, "cerrada")], new Map()), cloud.fetchImpl,
    );
    sync.setSession(CLOUD, "granja-a", "", "refresh-que-no-existe");
    const out = await sync.runCycle();
    expect(out["sesion_vencida"]).toBe(true);
    const st = await sync.status();
    expect(st["sesion_vencida"]).toBe(true);
    expect(st["pendientes"]).toBe(1);
  });

  it("lotes de máx 200 sesiones por push", async () => {
    const cloud = fakeCloud();
    const muchas = Array.from({ length: 250 }, (_, i) => sesion(i + 1, "cerrada"));
    const { sync } = newSync(fakeRepo(muchas, new Map()), cloud.fetchImpl);
    sync.setSession(CLOUD, "granja-a", cloud.state.accessOk, "refresh-1", 1800);
    expect((await sync.runCycle())["pushed"]).toBe(250);
    const p = pushes(cloud.calls);
    expect(p.length).toBe(2);
    expect((p[0].body["sesiones"] as Row[]).length).toBe(200);
    expect((p[1].body["sesiones"] as Row[]).length).toBe(50);
  });

  it("las sesiones DEMO (es_demo=1) JAMÁS suben a la nube", async () => {
    // Regresión: la demo se autodestruye local en 1 h; si subiera, el
    // cloud quedaría con datos de práctica disfrazados de reales.
    const cloud = fakeCloud();
    const filas = [
      sesion(1, "cerrada"),                          // real → sube
      sesion(2, "cerrada", { es_demo: 1 }),          // demo cerrada → NO
      sesion(3, "abierta", { es_demo: 1 }),          // demo abierta → NO
    ];
    const eventos = new Map([
      [1, [evento(10, 1)]],
      [2, [evento(20, 2)]],
      [3, [evento(30, 3)]],
    ]);
    const { sync } = newSync(fakeRepo(filas, eventos), cloud.fetchImpl);
    sync.setSession(CLOUD, "granja-a", cloud.state.accessOk, "refresh-1", 1800);

    expect((await sync.runCycle())["pushed"]).toBe(1);
    const p = pushes(cloud.calls);
    expect(p.length).toBe(1);
    const ses = p[0].body["sesiones"] as Row[];
    expect(ses.map((s) => s["uuid"])).toEqual(["uuid-sesion-1"]);
    const evs = p[0].body["eventos"] as Row[];
    expect(evs.map((e) => e["sesion_uuid"])).toEqual(["uuid-sesion-1"]);
    // 2º ciclo (marcador viejo, demo abierta seguía subiendo antes): tampoco
    expect((await sync.runCycle())["pushed"]).toBe(0);
    expect(pushes(cloud.calls).length).toBe(1);
  });
});

// ------------------------------------------------------ rutas /api/cloud/*

describe("rutas /api/cloud/* del shim", () => {
  it("probe → login → status → token → logout (contrato del escritorio)", async () => {
    const cloud = fakeCloud();
    const storage = fakeStorage();
    const { sync } = newSync(
      fakeRepo([sesion(1, "cerrada")], new Map()), cloud.fetchImpl, storage,
    );

    const probe = await sync.route("POST", "/api/cloud/probe", {
      cloud_url: CLOUD, tenant: "granja-a",
    });
    expect(probe!.status).toBe(200);
    expect((probe!.body as Row)["ok"]).toBe(true);

    const login = await sync.route("POST", "/api/cloud/login", {
      cloud_url: CLOUD, tenant: "granja-a",
      email: "admin@granja-a.test", password: "clave-admin-1",
    });
    expect(login!.status).toBe(200);
    const lb = login!.body as Row;
    expect((lb["perfil"] as Row)["rol"]).toBe("admin");
    expect((lb["perfil"] as Row)["nombre"]).toBe("Ana");
    // config + refresh + perfil persistidos en localStorage
    expect(storage.data.get(CLOUD_URL_KEY)).toBe(CLOUD);
    expect(storage.data.get(TENANT_KEY)).toBe("granja-a");
    expect(storage.data.get(REFRESH_KEY)).toBe("refresh-1");

    const st = await sync.route("GET", "/api/cloud/status", {});
    expect((st!.body as Row)["configurada"]).toBe(true);
    expect(((st!.body as Row)["perfil"] as Row)["rol"]).toBe("admin");

    const tk = await sync.route("GET", "/api/cloud/token", {});
    expect(tk!.status).toBe(200);
    expect((tk!.body as Row)["access_token"]).toBe(cloud.state.accessOk);

    const out = await sync.route("DELETE", "/api/cloud/session", {});
    expect((out!.body as Row)["ok"]).toBe(true);
    expect(storage.data.has(REFRESH_KEY)).toBe(false);
    const tk2 = await sync.route("GET", "/api/cloud/token", {});
    expect(tk2!.status).toBe(409); // nube sin sesión
    expect(cloud.calls.some((c) => c.url.endsWith("/auth/logout"))).toBe(true);
  });

  it("login con credenciales malas → 401; nube caída → 504", async () => {
    const cloud = fakeCloud();
    const { sync } = newSync(fakeRepo([], new Map()), cloud.fetchImpl);
    const bad = await sync.route("POST", "/api/cloud/login", {
      cloud_url: CLOUD, tenant: "granja-a",
      email: "x@y.z", password: "mala-mala-1",
    });
    expect(bad!.status).toBe(401);

    cloud.state.offline = true;
    const off = await sync.route("POST", "/api/cloud/login", {
      cloud_url: CLOUD, tenant: "granja-a",
      email: "x@y.z", password: "clave-admin-1",
    });
    expect(off!.status).toBe(504);
  });

  it("POST /api/cloud/session re-siembra tokens y GET token refresca solo", async () => {
    const cloud = fakeCloud();
    const storage = fakeStorage();
    const { sync } = newSync(fakeRepo([], new Map()), cloud.fetchImpl, storage);
    // sin access (arranque offline-first): solo refresh cacheado
    const r = await sync.route("POST", "/api/cloud/session", {
      cloud_url: CLOUD, tenant: "granja-a", refresh_token: "refresh-1",
    });
    expect((r!.body as Row)["ok"]).toBe(true);
    const tk = await sync.route("GET", "/api/cloud/token", {});
    expect(tk!.status).toBe(200); // refrescó con el refresh cacheado
    expect((tk!.body as Row)["refresh_token"]).toBe("refresh-1-rot");
    expect(storage.data.get(REFRESH_KEY)).toBe("refresh-1-rot");
  });

  it("ruta desconocida de nube → 404 y no-nube → null", async () => {
    const cloud = fakeCloud();
    const { sync } = newSync(fakeRepo([], new Map()), cloud.fetchImpl);
    const r = await sync.route("GET", "/api/cloud/nada", {});
    expect(r!.status).toBe(404);
    expect(await sync.route("GET", "/api/sessions", {})).toBeNull();
  });
});

// -------------------------------------------------------------- cloudauth

describe("cloudauth", () => {
  it("decodeClaims / perfilFromToken (sin verificar firma: solo UX)", () => {
    const jwt = fakeJwt({ sub: "u-1", rol: "operador", nombre: "José", tenant_id: 7 });
    expect(decodeClaims(jwt)["rol"]).toBe("operador");
    const p = perfilFromToken(jwt, "jose@granja.test");
    expect(p).toEqual({
      email: "jose@granja.test", nombre: "José", rol: "operador", tenant_id: 7,
    });
    expect(decodeClaims("basura")).toEqual({});
  });

  it("marcador de push se resetea al cambiar de nube/tenant", async () => {
    const cloud = fakeCloud();
    const storage = fakeStorage();
    const { sync } = newSync(
      fakeRepo([sesion(1, "cerrada")], new Map()), cloud.fetchImpl, storage,
    );
    sync.setSession(CLOUD, "granja-a", cloud.state.accessOk, "refresh-1", 1800);
    await sync.runCycle();
    expect(storage.data.get(LAST_PUSH_KEY)).toBeTruthy();
    // otra nube/tenant → re-push completo (marcador borrado)
    sync.setSession(CLOUD, "granja-b", cloud.state.accessOk, cloud.state.refreshOk, 1800);
    expect(storage.data.get(LAST_PUSH_KEY) ?? "").toBe("");
  });
});
