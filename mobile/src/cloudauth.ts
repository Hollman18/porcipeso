/**
 * Autenticación contra PorciPeso Cloud — lado móvil (shim).
 *
 * Espejo de porcipeso/api/cloudauth.py: login/refresh/logout contra el
 * cloud + TokenBox dueño único del par access/refresh (el refresh es
 * ROTATIVO: un solo refrescador o se pisan). El access vive SOLO en
 * memoria; el refresh se persiste en localStorage (porcipeso_refresh)
 * vía el callback onRefreshRotated.
 *
 * La UI (auth.js) nunca habla directo con el cloud: llama a
 * /api/cloud/* y el shim (sync.ts) resuelve con este módulo.
 * Nunca se loguean tokens.
 */

export const REFRESH_KEY = "porcipeso_refresh";
export const PERFIL_KEY = "porcipeso_perfil";
export const LAST_PUSH_KEY = "porcipeso_last_push";

export const HTTP_TIMEOUT_MS = 6_000;
/** Margen para refrescar ANTES de que expire el access (ms). */
export const REFRESH_SKEW_MS = 60_000;

export interface Perfil {
  email?: string | null;
  nombre?: string | null;
  rol?: string | null;
  tenant_id?: number | null;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export class CloudError extends Error {
  readonly status: number;
  constructor(status: number, detail = "") {
    super(detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`);
    this.status = status;
  }
}

/** status 0 = sin red / timeout. */
export class CloudOffline extends CloudError {
  constructor(detail = "sin conexión con la nube") {
    super(0, detail);
  }
}

/** El refresh ya no sirve: hay que iniciar sesión de nuevo. */
export class SessionExpired extends CloudError {
  constructor(detail = "sesión vencida") {
    super(401, detail);
  }
}

const base = (cloudUrl: string): string => String(cloudUrl ?? "").trim().replace(/\/+$/, "");

async function post(
  url: string,
  body: unknown,
  fetchImpl: typeof fetch,
  headers: Record<string, string> = {},
): Promise<Response> {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS) : null;
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl?.signal,
    });
  } catch (e) {
    throw new CloudOffline(e instanceof Error ? e.name : String(e));
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function detail(resp: Response): Promise<string> {
  try {
    const j = (await resp.json()) as Record<string, unknown>;
    return String(j["detail"] ?? "");
  } catch {
    return "";
  }
}

// ------------------------------------------------------------------ claims

/** Payload del JWT SIN verificar firma — solo UX (nombre/rol). */
export function decodeClaims(accessToken: string): Record<string, unknown> {
  try {
    let part = accessToken.split(".")[1] ?? "";
    part = part.replace(/-/g, "+").replace(/_/g, "/");
    part += "=".repeat((4 - (part.length % 4)) % 4);
    const raw =
      typeof atob !== "undefined"
        ? atob(part)
        : Buffer.from(part, "base64").toString("binary");
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    const data = JSON.parse(json) as unknown;
    return data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function perfilFromToken(accessToken: string, email = ""): Perfil {
  const c = decodeClaims(accessToken);
  return {
    email,
    nombre: (c["nombre"] as string | null) ?? null,
    rol: (c["rol"] as string | null) ?? null,
    tenant_id: (c["tenant_id"] as number | null) ?? null,
  };
}

// ------------------------------------------------------------------ probe

async function getWithTimeout(url: string, fetchImpl: typeof fetch): Promise<Response> {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS) : null;
  try {
    return await fetchImpl(url, { signal: ctrl?.signal });
  } catch (e) {
    throw new CloudOffline(e instanceof Error ? e.name : String(e));
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * GET /health + GET /config/app?tenant=… — misma forma que el endpoint
 * POST /api/cloud/probe del escritorio: {ok, health, config, error}.
 */
export async function cloudProbeShape(
  cloudUrl: string,
  tenant: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; health: boolean; config: unknown; error: string | null }> {
  const out = { ok: false, health: false, config: null as unknown, error: null as string | null };
  try {
    const r = await getWithTimeout(`${base(cloudUrl)}/health`, fetchImpl);
    out.health = r.status === 200;
    const q = tenant ? `?tenant=${encodeURIComponent(tenant.trim().toLowerCase())}` : "";
    const rc = await getWithTimeout(`${base(cloudUrl)}/config/app${q}`, fetchImpl);
    if (rc.status === 200) out.config = await rc.json();
    out.ok = out.health && rc.status === 200;
    if (!out.ok) out.error = `health=${r.status} config=${rc.status}`;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  return out;
}

// ------------------------------------------------------------- operaciones

function toPair(j: Record<string, unknown>): TokenPair {
  return {
    access_token: String(j["access_token"] ?? ""),
    refresh_token: String(j["refresh_token"] ?? ""),
    expires_in: Number(j["expires_in"] ?? 1800) || 1800,
  };
}

export async function cloudLogin(
  cloudUrl: string,
  email: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenPair> {
  const resp = await post(`${base(cloudUrl)}/auth/login`, { email, password }, fetchImpl);
  if (resp.status !== 200) throw new CloudError(resp.status, await detail(resp));
  return toPair((await resp.json()) as Record<string, unknown>);
}

export async function cloudRefresh(
  cloudUrl: string,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenPair> {
  const resp = await post(
    `${base(cloudUrl)}/auth/refresh`,
    { refresh_token: refreshToken },
    fetchImpl,
  );
  if (resp.status === 401) throw new SessionExpired(await detail(resp));
  if (resp.status !== 200) throw new CloudError(resp.status, await detail(resp));
  return toPair((await resp.json()) as Record<string, unknown>);
}

/** Revoca el refresh — best-effort: jamás lanza. */
export async function cloudLogout(
  cloudUrl: string,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await post(`${base(cloudUrl)}/auth/logout`, { refresh_token: refreshToken }, fetchImpl);
  } catch {
    /* offline: el token expira solo a los 30 días */
  }
}

// --------------------------------------------------------------- TokenBox

export interface TokenBoxDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Persiste el refresh rotado (localStorage porcipeso_refresh). */
  onRefreshRotated?: (refreshToken: string) => void;
}

export class TokenBox {
  cloudUrl = "";
  private access = "";
  private refresh = "";
  private expiresAt = 0;
  private refreshing: Promise<string> | null = null;
  private deps: TokenBoxDeps;

  constructor(deps: TokenBoxDeps = {}) {
    this.deps = deps;
  }

  get configured(): boolean {
    return !!(this.cloudUrl && this.refresh);
  }

  setSession(
    cloudUrl: string,
    accessToken: string,
    refreshToken: string,
    expiresIn?: number,
  ): void {
    const now = this.deps.now ?? Date.now;
    this.cloudUrl = base(cloudUrl);
    this.access = accessToken || "";
    this.refresh = refreshToken || "";
    this.expiresAt = accessToken ? now() + (expiresIn ?? 1800) * 1000 : 0;
  }

  /** Borra la sesión y retorna el refresh que había (para revocarlo). */
  clear(): string {
    const old = this.refresh;
    this.access = "";
    this.refresh = "";
    this.expiresAt = 0;
    return old;
  }

  snapshot(): TokenPair {
    const now = this.deps.now ?? Date.now;
    return {
      access_token: this.access,
      refresh_token: this.refresh,
      expires_in: Math.max(0, Math.floor((this.expiresAt - now()) / 1000)),
    };
  }

  /** Access vigente; refresca si expiró. Lanza SessionExpired/CloudOffline. */
  async getAccess(): Promise<string> {
    const now = this.deps.now ?? Date.now;
    if (this.access && now() < this.expiresAt - REFRESH_SKEW_MS) return this.access;
    return this.forceRefresh();
  }

  /** Refresca YA (p. ej. tras un 401). Serializado: un refresh a la vez. */
  async forceRefresh(): Promise<string> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<string> {
    if (!this.configured) throw new SessionExpired("sin sesión de nube");
    const now = this.deps.now ?? Date.now;
    const pair = await cloudRefresh(this.cloudUrl, this.refresh, this.deps.fetchImpl ?? fetch);
    this.access = pair.access_token;
    if (pair.refresh_token) {
      this.refresh = pair.refresh_token;
      try {
        this.deps.onRefreshRotated?.(pair.refresh_token);
      } catch {
        /* persistir jamás rompe el flujo */
      }
    }
    this.expiresAt = now() + pair.expires_in * 1000;
    return this.access;
  }
}
