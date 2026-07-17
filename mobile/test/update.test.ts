/**
 * Tests de mobile/src/update.ts — fetch mockeado (sin red):
 * semver compare, min_version, config remota OK, timeout → degradación,
 * cache 6 h, nube apagada, y descarga+instalador con deps inyectadas.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_VERSION,
  buildStatus,
  CACHE_TTL_MS,
  clearUpdateCache,
  downloadAndInstallApk,
  fetchRemoteConfig,
  fetchUpdateStatus,
  parseSemver,
  semverCmp,
  type RemoteConfig,
} from "../src/update";
import { maybeSendTelemetry } from "../src/telemetry";

const REMOTE: RemoteConfig = {
  latest_version: "2.2.0",
  min_version: "2.0.0",
  apk_url: "https://cdn.example.com/porcipeso-2.2.0.apk",
  banners: [
    { id: "promo1", texto: "Nueva función", boton: "Ver", url: "https://x", solo_sin_nube: true },
  ],
};

function fakeStorage(init: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

function jsonFetch(payload: unknown, calls?: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    calls?.push(String(input));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(() => clearUpdateCache());

// ------------------------------------------------------------------ semver

describe("semver", () => {
  it("parsea versiones normales y raras", () => {
    expect(parseSemver("2.1.0")).toEqual([2, 1, 0]);
    expect(parseSemver("v2.1")).toEqual([2, 1, 0]);
    expect(parseSemver("3")).toEqual([3, 0, 0]);
    expect(parseSemver("2.10.1")).toEqual([2, 10, 1]);
    expect(parseSemver("basura")).toEqual([0, 0, 0]);
    expect(parseSemver("")).toEqual([0, 0, 0]);
  });

  it("compara numéricamente, no lexicográficamente", () => {
    expect(semverCmp("2.1.0", "2.2.0")).toBe(-1);
    expect(semverCmp("2.2.0", "2.1.0")).toBe(1);
    expect(semverCmp("2.1.0", "2.1.0")).toBe(0);
    expect(semverCmp("2.10.0", "2.2.0")).toBe(1);
    expect(semverCmp("2.1", "2.1.0")).toBe(0);
  });
});

// ------------------------------------------------------------------ status

describe("fetchUpdateStatus", () => {
  it("nube sin configurar → apagado silencioso (sin fetch)", async () => {
    const fetchImpl = vi.fn();
    const status = await fetchUpdateStatus({
      storage: fakeStorage(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(status).toEqual({
      current: APP_VERSION,
      latest: null,
      update_available: false,
      min_version_ok: true,
      apk_url: null,
      banners: [],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("config remota OK → update_available + banners passthrough", async () => {
    const calls: string[] = [];
    const status = await fetchUpdateStatus({
      storage: fakeStorage({
        porcipeso_cloud_url: "https://nube.example.com/",
        porcipeso_tenant: "granja1",
      }),
      fetchImpl: jsonFetch(REMOTE, calls),
      currentVersion: "2.1.0",
    });
    expect(status.latest).toBe("2.2.0");
    expect(status.update_available).toBe(true);
    expect(status.min_version_ok).toBe(true); // 2.1.0 >= 2.0.0
    expect(status.apk_url).toBe(REMOTE.apk_url);
    expect(status.banners).toEqual(REMOTE.banners);
    // contrato: GET {cloud}/config/app?tenant=slug
    expect(calls[0]).toBe("https://nube.example.com/config/app?tenant=granja1");
  });

  it("min_version no cumplida → min_version_ok=false", async () => {
    const status = await fetchUpdateStatus({
      storage: fakeStorage({ porcipeso_cloud_url: "https://n" }),
      fetchImpl: jsonFetch(REMOTE),
      currentVersion: "1.5.0",
    });
    expect(status.update_available).toBe(true);
    expect(status.min_version_ok).toBe(false); // 1.5.0 < 2.0.0
  });

  it("ya en la última versión → update_available=false", async () => {
    const status = await fetchUpdateStatus({
      storage: fakeStorage({ porcipeso_cloud_url: "https://n" }),
      fetchImpl: jsonFetch(REMOTE),
      currentVersion: "2.2.0",
    });
    expect(status.update_available).toBe(false);
    expect(status.min_version_ok).toBe(true);
  });

  it("timeout/red caída → degradación {update_available:false}", async () => {
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const status = await fetchUpdateStatus({
      storage: fakeStorage({ porcipeso_cloud_url: "https://n" }),
      fetchImpl: failing,
    });
    expect(status.update_available).toBe(false);
    expect(status.min_version_ok).toBe(true);
    expect(status.latest).toBeNull();
    expect(status.banners).toEqual([]);
  });

  it("HTTP 500 → degradación", async () => {
    const bad = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const status = await fetchUpdateStatus({
      storage: fakeStorage({ porcipeso_cloud_url: "https://n" }),
      fetchImpl: bad,
    });
    expect(status.update_available).toBe(false);
  });
});

// ------------------------------------------------------------------- cache

describe("cache 6 h", () => {
  it("no refetchea dentro del TTL y sirve cache viejo si el refetch falla", async () => {
    let now = 1_000_000;
    const calls: string[] = [];
    const deps = {
      fetchImpl: jsonFetch(REMOTE, calls),
      now: () => now,
    };
    expect(await fetchRemoteConfig("https://n", "", deps)).toEqual(REMOTE);
    expect(await fetchRemoteConfig("https://n", "", deps)).toEqual(REMOTE);
    expect(calls.length).toBe(1); // la segunda sale del cache

    // vencido + refetch fallido → conserva la config vieja
    now += CACHE_TTL_MS + 1;
    const failing = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const cfg = await fetchRemoteConfig("https://n", "", { fetchImpl: failing, now: () => now });
    expect(cfg).toEqual(REMOTE);
  });
});

// ------------------------------------------------------------- buildStatus

describe("buildStatus", () => {
  it("config null → forma degradada estable", () => {
    expect(buildStatus("2.1.0", null)).toEqual({
      current: "2.1.0",
      latest: null,
      update_available: false,
      min_version_ok: true,
      apk_url: null,
      banners: [],
    });
  });

  it("sin min_version → min_version_ok=true", () => {
    const st = buildStatus("0.1.0", { latest_version: "2.2.0" });
    expect(st.update_available).toBe(true);
    expect(st.min_version_ok).toBe(true);
  });
});

// -------------------------------------------------- descarga + instalador

describe("downloadAndInstallApk", () => {
  it("descarga y abre el instalador con el mime de APK", async () => {
    const download = vi.fn(async () => "/cache/porcipeso-update.apk");
    const open = vi.fn(async () => undefined);
    const path = await downloadAndInstallApk(REMOTE.apk_url as string, { download, open });
    expect(path).toBe("/cache/porcipeso-update.apk");
    expect(download).toHaveBeenCalledWith(REMOTE.apk_url, "porcipeso-update.apk");
    expect(open).toHaveBeenCalledWith("/cache/porcipeso-update.apk");
  });

  it("sin apk_url → lanza", async () => {
    await expect(downloadAndInstallApk("")).rejects.toThrow(/apk_url/);
  });

  it("propaga el fallo de descarga (el shim responde 502)", async () => {
    const download = vi.fn(async () => {
      throw new Error("404 del CDN");
    });
    await expect(
      downloadAndInstallApk("https://x/apk", { download, open: vi.fn() }),
    ).rejects.toThrow(/404/);
  });
});

// -------------------------------------------------------------- telemetría

describe("maybeSendTelemetry (android)", () => {
  const stats = { sesiones: 7, total_animales: 100, total_kg: 1000 };
  const statsMes = { sesiones: 3, total_animales: 40, total_kg: 400 };

  function telemetryFetch(posts: Array<{ url: string; body: unknown }>): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response("{}", { status: 200 });
      }
      const payload = url.includes("desde=") ? statsMes : stats;
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as typeof fetch;
  }

  it("envía el payload EXACTO del contrato y marca el día", async () => {
    const storage = fakeStorage({
      porcipeso_cloud_url: "https://nube.example.com",
      porcipeso_tenant: "granja1",
    });
    const posts: Array<{ url: string; body: unknown }> = [];
    const sent = await maybeSendTelemetry({
      storage,
      fetchImpl: telemetryFetch(posts),
      now: () => new Date("2026-07-17T10:00:00Z"),
    });
    expect(sent).toBe(true);
    expect(posts.length).toBe(1);
    expect(posts[0].url).toBe("https://nube.example.com/telemetry");
    const body = posts[0].body as Record<string, unknown>;
    expect(body.plataforma).toBe("android");
    expect(body.version_app).toBe(APP_VERSION);
    expect(body.tenant).toBe("granja1");
    expect(typeof body.device_id).toBe("string");
    expect(body.datos).toEqual({ pesajes_total: 7, pesajes_mes: 3, nube_activa: false });
    expect(storage.data.get("porcipeso_telemetry_last")).toBe("2026-07-17");
    expect(storage.data.get("porcipeso_device_id")).toBe(body.device_id);

    // segundo intento el mismo día → no envía (máx. 1/día)
    const again = await maybeSendTelemetry({
      storage,
      fetchImpl: telemetryFetch(posts),
      now: () => new Date("2026-07-17T18:00:00Z"),
    });
    expect(again).toBe(false);
    expect(posts.length).toBe(1);
  });

  it("sin nube configurada → no hace nada", async () => {
    const fetchImpl = vi.fn();
    const sent = await maybeSendTelemetry({
      storage: fakeStorage(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fallo del POST → no marca el día (reintenta en la próxima apertura)", async () => {
    const storage = fakeStorage({ porcipeso_cloud_url: "https://n" });
    const failing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return new Response("x", { status: 503 });
      return new Response(JSON.stringify(stats), { status: 200 });
    }) as typeof fetch;
    const sent = await maybeSendTelemetry({ storage, fetchImpl: failing });
    expect(sent).toBe(false);
    expect(storage.data.has("porcipeso_telemetry_last")).toBe(false);
  });
});
