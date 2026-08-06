/**
 * Persistencia móvil — espejo de porcipeso/db/schema.sql + repo.py.
 *
 * Mismas tablas y CAMPOS EXACTOS que el backend Python (sesiones,
 * eventos_pesaje, lecturas_crudas con retención 200k) más `sync_outbox`
 * (uuid) para la sincronización 1:1 futura contra el servidor.
 *
 * Backend nativo: @capacitor-community/sqlite (Android).
 * Fallback dev web / tests: sql.js (SQLite WASM) con persistencia en
 * IndexedDB (export de bytes debounced).
 */
import type { WeighEvent } from "./models";

// ------------------------------------------------------------------ schema

/** DDL idéntico a porcipeso/db/schema.sql (sin PRAGMAs, que van aparte). */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sesiones (
  id                       INTEGER PRIMARY KEY,
  uuid                     TEXT UNIQUE,
  granja                   TEXT,
  lote                     TEXT,
  corral_origen            TEXT,
  destino                  TEXT,
  placa                    TEXT,
  conductor                TEXT,
  operador                 TEXT,
  bascula_id               TEXT,
  peso_ref_inicial         REAL,
  hora_entrada             TEXT,
  hora_salida              TEXT,
  total_kg                 REAL,
  total_animales           INTEGER,
  promedio_final           REAL,
  conteo_fisico            INTEGER,
  diferencia_conciliacion  INTEGER,
  estado                   TEXT NOT NULL DEFAULT 'abierta'
                           CHECK (estado IN ('abierta', 'cerrada', 'anulada')),
  modo                     TEXT NOT NULL DEFAULT 'lote',
  es_demo                  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS eventos_pesaje (
  id                    INTEGER PRIMARY KEY,
  sesion_id             INTEGER NOT NULL REFERENCES sesiones(id),
  ts_ms                 INTEGER NOT NULL,
  peso_antes            REAL NOT NULL,
  peso_despues          REAL NOT NULL,
  delta_kg              REAL NOT NULL,
  animales_estimados    INTEGER NOT NULL,
  animales_confirmados  INTEGER,
  estab_ms              INTEGER NOT NULL DEFAULT 0,
  tipo                  TEXT NOT NULL
                        CHECK (tipo IN ('referencia', 'subida', 'bajada', 'reingreso', 'ajuste')),
  ambiguo               INTEGER NOT NULL DEFAULT 0,
  opciones              TEXT,
  motivo_bajada         TEXT,
  evento_relacionado_id INTEGER REFERENCES eventos_pesaje(id),
  confirmado_por        TEXT
);

CREATE TABLE IF NOT EXISTS lecturas_crudas (
  ts_ms     INTEGER NOT NULL,
  kg        REAL NOT NULL,
  sesion_id INTEGER REFERENCES sesiones(id)
);

CREATE TABLE IF NOT EXISTS sync_outbox (
  id         INTEGER PRIMARY KEY,
  uuid       TEXT UNIQUE NOT NULL,
  tipo       TEXT NOT NULL,
  ref_id     INTEGER,
  payload    TEXT,
  created_at TEXT NOT NULL,
  synced_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_eventos_sesion    ON eventos_pesaje(sesion_id, ts_ms);
CREATE INDEX IF NOT EXISTS idx_eventos_ambiguo   ON eventos_pesaje(sesion_id, ambiguo)
  WHERE ambiguo = 1;
CREATE INDEX IF NOT EXISTS idx_lecturas_sesion   ON lecturas_crudas(sesion_id, ts_ms);
CREATE INDEX IF NOT EXISTS idx_sesiones_estado   ON sesiones(estado);
CREATE INDEX IF NOT EXISTS idx_sesiones_hora_entrada ON sesiones(hora_entrada);
CREATE INDEX IF NOT EXISTS idx_outbox_pendiente  ON sync_outbox(synced_at) WHERE synced_at IS NULL;
`;

// ------------------------------------------------------------------ driver

export type Row = Record<string, unknown>;

export interface SqlDriver {
  /** Ejecuta un script DDL (varias sentencias). */
  executeScript(sql: string): Promise<void>;
  /** INSERT/UPDATE/DELETE. Retorna lastId y filas afectadas. */
  run(sql: string, params?: unknown[]): Promise<{ lastId: number; changes: number }>;
  /** SELECT → filas como objetos {col: valor}. */
  query(sql: string, params?: unknown[]): Promise<Row[]>;
  close(): Promise<void>;
}

// ------------------------------------------------- sql.js (web/dev/tests)

export interface SqlJsOptions {
  /** Ruta del wasm (web: '/sql-wasm.wasm'; node: path absoluto). */
  locateFile?: (file: string) => string;
  /** Persistencia: recibe los bytes exportados (IndexedDB en web). */
  persist?: (bytes: Uint8Array) => void | Promise<void>;
  /** Bytes previos para restaurar la base. */
  restore?: Uint8Array | null;
  /** Debounce del persist en ms (default 500). */
  persistDebounceMs?: number;
}

export async function createSqlJsDriver(opts: SqlJsOptions = {}): Promise<SqlDriver> {
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs(opts.locateFile ? { locateFile: opts.locateFile } : {});
  const db = opts.restore ? new SQL.Database(opts.restore) : new SQL.Database();

  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedulePersist = () => {
    if (!opts.persist) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void opts.persist!(db.export());
    }, opts.persistDebounceMs ?? 500);
  };

  return {
    async executeScript(sql: string) {
      db.exec(sql);
      schedulePersist();
    },
    async run(sql: string, params: unknown[] = []) {
      db.run(sql, params as never);
      const lastId = (db.exec("SELECT last_insert_rowid()")[0]?.values?.[0]?.[0] as number) ?? 0;
      const changes = db.getRowsModified();
      schedulePersist();
      return { lastId, changes };
    },
    async query(sql: string, params: unknown[] = []) {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params as never);
        const rows: Row[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject() as Row);
        return rows;
      } finally {
        stmt.free();
      }
    },
    async close() {
      if (timer) clearTimeout(timer);
      if (opts.persist) await opts.persist(db.export());
      db.close();
    },
  };
}

/** Persistencia IndexedDB para el fallback web de sql.js. */
export const idb = {
  DB_NAME: "porcipeso",
  STORE: "sqljs",
  KEY: "porcipeso.db",

  open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(idb.DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(idb.STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async load(): Promise<Uint8Array | null> {
    const db = await idb.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(idb.STORE, "readonly");
      const req = tx.objectStore(idb.STORE).get(idb.KEY);
      req.onsuccess = () => resolve(req.result ? new Uint8Array(req.result) : null);
      req.onerror = () => reject(req.error);
    });
  },

  async save(bytes: Uint8Array): Promise<void> {
    const db = await idb.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(idb.STORE, "readwrite");
      tx.objectStore(idb.STORE).put(bytes, idb.KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};

// ------------------------------------- @capacitor-community/sqlite (nativo)

export async function createCapacitorDriver(dbName = "porcipeso"): Promise<SqlDriver> {
  const { CapacitorSQLite, SQLiteConnection } = await import("@capacitor-community/sqlite");
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  const conn = await sqlite.createConnection(dbName, false, "no-encryption", 1, false);
  await conn.open();

  return {
    async executeScript(sql: string) {
      await conn.execute(sql, false);
    },
    async run(sql: string, params: unknown[] = []) {
      const res = await conn.run(sql, params as never, false);
      return {
        lastId: Number(res.changes?.lastId ?? 0),
        changes: Number(res.changes?.changes ?? 0),
      };
    },
    async query(sql: string, params: unknown[] = []) {
      const res = await conn.query(sql, params as never);
      return (res.values ?? []) as Row[];
    },
    async close() {
      await sqlite.closeConnection(dbName, false);
    },
  };
}

// --------------------------------------------------------------------- Repo

/** ISO igual a datetime.now(timezone.utc).isoformat(timespec="seconds"). */
export function nowIso(): string {
  return new Date().toISOString().slice(0, 19) + "+00:00";
}

function uuid4(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Campos que POST /api/sessions puede fijar (igual que repo.py). */
export const SESSION_FIELDS = [
  "granja", "lote", "corral_origen", "destino", "placa",
  "conductor", "operador", "bascula_id", "peso_ref_inicial",
] as const;

export interface RepoOptions {
  storeReadings?: boolean;
  maxRawReadings?: number;
  pruneCheckEvery?: number;
}

export class Repo {
  static readonly DEFAULT_MAX_RAW_READINGS = 200_000;
  static readonly DEFAULT_PRUNE_CHECK_EVERY = 500;

  private drv: SqlDriver;
  readonly storeReadings: boolean;
  readonly maxRawReadings: number;
  readonly pruneCheckEvery: number;
  private insertsSincePrune = 0;

  private constructor(drv: SqlDriver, opts: RepoOptions) {
    this.drv = drv;
    this.storeReadings = opts.storeReadings ?? true;
    this.maxRawReadings = opts.maxRawReadings ?? Repo.DEFAULT_MAX_RAW_READINGS;
    this.pruneCheckEvery = Math.max(1, opts.pruneCheckEvery ?? Repo.DEFAULT_PRUNE_CHECK_EVERY);
  }

  static async create(drv: SqlDriver, opts: RepoOptions = {}): Promise<Repo> {
    await drv.executeScript(SCHEMA_SQL);
    // Migración v2 (espejo de repo.init_db): DBs creadas antes del motor
    // v2 no tienen sesiones.modo (el CREATE usa IF NOT EXISTS y no la
    // agrega); se detecta con PRAGMA table_info y se agrega con ALTER.
    const cols = await drv.query("PRAGMA table_info(sesiones)");
    if (!cols.some((c) => c["name"] === "modo")) {
      await drv.run("ALTER TABLE sesiones ADD COLUMN modo TEXT NOT NULL DEFAULT 'lote'");
    }
    // Migración v3 (espejo de repo.init_db): sesiones.es_demo — marca de
    // práctica con la báscula simulada (chip DEMO, fuera de stats,
    // autodestruida tras 1 h de cerrada).
    if (!cols.some((c) => c["name"] === "es_demo")) {
      await drv.run("ALTER TABLE sesiones ADD COLUMN es_demo INTEGER NOT NULL DEFAULT 0");
    }
    return new Repo(drv, opts);
  }

  async close(): Promise<void> {
    await this.drv.close();
  }

  // ------------------------------------------------------------- sesiones

  async createSession(data: Record<string, unknown>): Promise<number> {
    const cols: Record<string, unknown> = {};
    for (const k of SESSION_FIELDS) cols[k] = data[k] ?? null;
    cols["modo"] = (data["modo"] as string) || "lote";
    // Práctica con la báscula simulada: lo fija el backend (apishim)
    // según el perfil conectado, nunca el formulario de la UI.
    cols["es_demo"] = data["es_demo"] ? 1 : 0;
    const uuid = (data["uuid"] as string) || uuid4();
    cols["uuid"] = uuid;
    cols["hora_entrada"] = (data["hora_entrada"] as string) || nowIso();
    cols["estado"] = "abierta";
    const names = Object.keys(cols).join(", ");
    const marks = Object.keys(cols).map(() => "?").join(", ");
    const { lastId } = await this.drv.run(
      `INSERT INTO sesiones (${names}) VALUES (${marks})`,
      Object.values(cols),
    );
    await this.outboxAdd("sesion", lastId, { uuid, op: "create" });
    return lastId;
  }

  async getSession(sessionId: number): Promise<Row | null> {
    const rows = await this.drv.query("SELECT * FROM sesiones WHERE id = ?", [sessionId]);
    return rows[0] ?? null;
  }

  private sessionFilters(
    desde?: string | null, hasta?: string | null, q?: string | null,
  ): { where: string; params: unknown[] } {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (desde) {
      conds.push("date(hora_entrada) >= date(?)");
      params.push(desde);
    }
    if (hasta) {
      conds.push("date(hora_entrada) <= date(?)");
      params.push(hasta);
    }
    if (q) {
      conds.push("(lote LIKE ? OR corral_origen LIKE ? OR destino LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    return { where: conds.length ? ` WHERE ${conds.join(" AND ")}` : "", params };
  }

  async listSessions(desde?: string | null, hasta?: string | null, q?: string | null): Promise<Row[]> {
    const { where, params } = this.sessionFilters(desde, hasta, q);
    return this.drv.query(`SELECT * FROM sesiones${where} ORDER BY id DESC`, params);
  }

  async closeSession(
    sessionId: number,
    snapshot: Record<string, unknown>,
    conteoFisico: number | null = null,
  ): Promise<Row | null> {
    const totalKg = snapshot["total_kg"] ?? null;
    const totalAnimales = (snapshot["count"] ?? snapshot["total_animales"]) ?? null;
    const promedio = (snapshot["avg_kg"] ?? snapshot["promedio_final"]) ?? null;
    let diferencia: number | null = null;
    if (conteoFisico !== null && conteoFisico !== undefined && totalAnimales != null) {
      diferencia = Math.trunc(conteoFisico) - Math.trunc(totalAnimales as number);
    }
    await this.drv.run(
      `UPDATE sesiones SET hora_salida = ?, total_kg = ?,
           total_animales = ?, promedio_final = ?,
           conteo_fisico = ?, diferencia_conciliacion = ?,
           estado = 'cerrada'
       WHERE id = ? AND estado = 'abierta'`,
      [nowIso(), totalKg, totalAnimales, promedio, conteoFisico, diferencia, sessionId],
    );
    const session = await this.getSession(sessionId);
    if (session) await this.outboxAdd("sesion", sessionId, { uuid: session["uuid"], op: "close" });
    return session;
  }

  // -------------------------------------------------------------- eventos

  async insertEvent(event: WeighEvent): Promise<number> {
    const { lastId } = await this.drv.run(
      `INSERT INTO eventos_pesaje
           (sesion_id, ts_ms, peso_antes, peso_despues, delta_kg,
            animales_estimados, animales_confirmados, estab_ms,
            tipo, ambiguo, opciones, motivo_bajada,
            evento_relacionado_id, confirmado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.session_id,
        event.ts_ms,
        event.peso_antes,
        event.peso_despues,
        event.delta_kg,
        event.animales_estimados,
        event.animales_confirmados,
        event.estab_ms,
        event.tipo,
        event.ambiguo ? 1 : 0,
        event.opciones && event.opciones.length ? JSON.stringify(event.opciones) : null,
        event.motivo_bajada,
        null, // evento_relacionado_id (interno del engine, igual que Python)
        event.confirmado_por,
      ],
    );
    await this.outboxAdd("evento", lastId, { op: "create" });
    return lastId;
  }

  async getEvent(eventId: number): Promise<Row | null> {
    const rows = await this.drv.query("SELECT * FROM eventos_pesaje WHERE id = ?", [eventId]);
    return rows[0] ? this.eventRow(rows[0]) : null;
  }

  async updateEventConfirm(eventId: number, n: number, confirmadoPor: string | null = null): Promise<void> {
    await this.drv.run(
      `UPDATE eventos_pesaje
       SET animales_confirmados = ?, ambiguo = 0, confirmado_por = ?
       WHERE id = ?`,
      [n, confirmadoPor, eventId],
    );
    await this.outboxAdd("evento", eventId, { op: "confirm", n });
  }

  async setEventMotivo(eventId: number, motivo: string): Promise<void> {
    await this.drv.run(
      "UPDATE eventos_pesaje SET motivo_bajada = ? WHERE id = ?",
      [motivo, eventId],
    );
    await this.outboxAdd("evento", eventId, { op: "motivo", motivo });
  }

  async listEvents(sessionId: number): Promise<Row[]> {
    const rows = await this.drv.query(
      "SELECT * FROM eventos_pesaje WHERE sesion_id = ? ORDER BY ts_ms, id",
      [sessionId],
    );
    return rows.map((r) => this.eventRow(r));
  }

  private eventRow(row: Row): Row {
    const d = { ...row };
    d["ambiguo"] = Boolean(d["ambiguo"]);
    d["opciones"] = d["opciones"] ? JSON.parse(d["opciones"] as string) : [];
    return d;
  }

  // ------------------------------------------------------------- lecturas

  async insertReading(sesionId: number | null, tsMs: number, kg: number): Promise<void> {
    if (!this.storeReadings) return;
    await this.drv.run(
      "INSERT INTO lecturas_crudas (ts_ms, kg, sesion_id) VALUES (?, ?, ?)",
      [tsMs, kg, sesionId],
    );
    this.insertsSincePrune += 1;
    if (this.insertsSincePrune >= this.pruneCheckEvery) {
      this.insertsSincePrune = 0;
      await this.pruneReadings();
    }
  }

  /** Retención: borra las más viejas de sesiones NO abiertas (igual que repo.py). */
  async pruneReadings(): Promise<number> {
    const [{ total }] = (await this.drv.query(
      "SELECT COUNT(*) AS total FROM lecturas_crudas",
    )) as [{ total: number }];
    const excess = Number(total) - this.maxRawReadings;
    if (excess <= 0) return 0;
    const { changes } = await this.drv.run(
      `DELETE FROM lecturas_crudas WHERE rowid IN (
           SELECT lc.rowid FROM lecturas_crudas lc
           LEFT JOIN sesiones s ON s.id = lc.sesion_id
           WHERE s.id IS NULL OR s.estado != 'abierta'
           ORDER BY lc.ts_ms, lc.rowid
           LIMIT ?
       )`,
      [excess],
    );
    return changes;
  }

  async countReadings(sesionId: number): Promise<number> {
    const rows = await this.drv.query(
      "SELECT COUNT(*) AS n FROM lecturas_crudas WHERE sesion_id = ?",
      [sesionId],
    );
    return Number(rows[0]?.["n"] ?? 0);
  }

  // ------------------------------------------------- mantenimiento/espacio
  // "🧹 Liberar espacio" — mismo contrato que porcipeso/db/repo.py
  // (storage_usage / cleanup_readings / cleanup_sessions).

  private async scalar(sql: string, params: unknown[] = []): Promise<unknown> {
    const rows = await this.drv.query(sql, params);
    const first = rows[0];
    return first ? Object.values(first)[0] : null;
  }

  async storageUsage(): Promise<Record<string, unknown>> {
    const pages = Number(await this.scalar("PRAGMA page_count"));
    const pageSize = Number(await this.scalar("PRAGMA page_size"));
    return {
      db_bytes: pages * pageSize,
      lecturas_total: Number(await this.scalar("SELECT COUNT(*) FROM lecturas_crudas")),
      lecturas_borrables: Number(
        await this.scalar(
          `SELECT COUNT(*) FROM lecturas_crudas lc
             LEFT JOIN sesiones s ON s.id = lc.sesion_id
            WHERE s.id IS NULL OR s.estado != 'abierta'`,
        ),
      ),
      pesajes_cerrados: Number(
        await this.scalar("SELECT COUNT(*) FROM sesiones WHERE estado != 'abierta'"),
      ),
      pesajes_abiertos: Number(
        await this.scalar("SELECT COUNT(*) FROM sesiones WHERE estado = 'abierta'"),
      ),
      pesaje_mas_viejo: (await this.scalar(
        "SELECT MIN(hora_entrada) FROM sesiones WHERE estado != 'abierta'",
      )) as string | null,
    };
  }

  /** Borra TODAS las lecturas crudas salvo las de sesiones ABIERTAS (seguro). */
  async cleanupReadings(): Promise<number> {
    const { changes } = await this.drv.run(
      `DELETE FROM lecturas_crudas WHERE rowid IN (
           SELECT lc.rowid FROM lecturas_crudas lc
           LEFT JOIN sesiones s ON s.id = lc.sesion_id
           WHERE s.id IS NULL OR s.estado != 'abierta'
       )`,
    );
    if (changes) await this.vacuum();
    return changes;
  }

  /**
   * Borra pesajes CERRADOS/ANULADOS anteriores a `antes` (YYYY-MM-DD) con
   * sus eventos, lecturas y pendientes de sync. Las sesiones abiertas
   * JAMÁS se tocan. `dryRun` solo cuenta (confirmación doble de la UI).
   */
  async cleanupSessions(
    antes: string,
    dryRun = false,
  ): Promise<{ pesajes: number; eventos: number; lecturas: number; dry_run: boolean }> {
    const rows = await this.drv.query(
      "SELECT id FROM sesiones WHERE estado != 'abierta' AND hora_entrada < ?",
      [antes],
    );
    const ids = rows.map((r) => Number(r["id"]));
    const marks = ids.map(() => "?").join(",") || "NULL";
    const eventos = Number(
      await this.scalar(
        `SELECT COUNT(*) FROM eventos_pesaje WHERE sesion_id IN (${marks})`, ids,
      ),
    );
    const lecturas = Number(
      await this.scalar(
        `SELECT COUNT(*) FROM lecturas_crudas WHERE sesion_id IN (${marks})`, ids,
      ),
    );
    const result = { pesajes: ids.length, eventos, lecturas, dry_run: dryRun };
    if (dryRun || !ids.length) return result;
    await this.purgeSessions(ids);
    return result;
  }

  /** Borra sesiones con sus eventos, lecturas y pendientes de sync. */
  private async purgeSessions(ids: number[]): Promise<void> {
    const marks = ids.map(() => "?").join(",") || "NULL";
    await this.drv.run(
      `DELETE FROM lecturas_crudas WHERE sesion_id IN (${marks})`, ids);
    await this.drv.run(
      `DELETE FROM sync_outbox WHERE (tipo = 'evento' AND ref_id IN (
           SELECT id FROM eventos_pesaje WHERE sesion_id IN (${marks})
       ))`, ids);
    await this.drv.run(
      `DELETE FROM sync_outbox WHERE tipo = 'sesion' AND ref_id IN (${marks})`, ids);
    await this.drv.run(
      `UPDATE eventos_pesaje SET evento_relacionado_id = NULL
        WHERE sesion_id IN (${marks})`, ids);
    await this.drv.run(`DELETE FROM eventos_pesaje WHERE sesion_id IN (${marks})`, ids);
    await this.drv.run(`DELETE FROM sesiones WHERE id IN (${marks})`, ids);
    await this.vacuum();
  }

  /** Vida máxima de una sesión DEMO después de cerrada (espejo repo.py). */
  static readonly DEMO_TTL_MINUTES = 60;

  /**
   * AUTODESTRUCCIÓN de las sesiones DEMO (báscula simulada) — espejo
   * exacto de repo.cleanup_demo_sessions: borra las es_demo=1 NO
   * abiertas cuyo cierre (hora_salida; hora_entrada si falta) ocurrió
   * hace más de `maxAgeMinutes`, con la misma maquinaria de "Liberar
   * espacio". Jamás toca sesiones reales (es_demo=0) ni abiertas.
   */
  async cleanupDemoSessions(maxAgeMinutes: number = Repo.DEMO_TTL_MINUTES): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000);
    const cutoffIso = cutoff.toISOString().slice(0, 19) + "+00:00";
    const rows = await this.drv.query(
      `SELECT id FROM sesiones
        WHERE es_demo = 1 AND estado != 'abierta'
          AND COALESCE(hora_salida, hora_entrada) < ?`,
      [cutoffIso],
    );
    const ids = rows.map((r) => Number(r["id"]));
    if (!ids.length) return 0;
    await this.purgeSessions(ids);
    return ids.length;
  }

  private async vacuum(): Promise<void> {
    try {
      await this.drv.run("VACUUM");
    } catch {
      /* DB ocupada: el espacio libre se reutiliza igual */
    }
  }

  // --------------------------------------------------------------- outbox

  private async outboxAdd(tipo: string, refId: number, payload: Record<string, unknown>): Promise<void> {
    await this.drv.run(
      `INSERT INTO sync_outbox (uuid, tipo, ref_id, payload, created_at, synced_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      [uuid4(), tipo, refId, JSON.stringify(payload), nowIso()],
    );
  }

  async outboxPending(): Promise<Row[]> {
    return this.drv.query(
      "SELECT * FROM sync_outbox WHERE synced_at IS NULL ORDER BY id",
    );
  }

  // ---------------------------------------------------------------- stats

  async statsGlobal(desde?: string | null, hasta?: string | null): Promise<Record<string, unknown>> {
    // Las sesiones DEMO (es_demo=1) quedan EXCLUIDAS del agregado (se
    // ven en la tabla con su chip, pero no contaminan los totales).
    const filters = this.sessionFilters(desde, hasta);
    const where = filters.where ? `${filters.where} AND es_demo = 0` : " WHERE es_demo = 0";
    const params = filters.params;
    const [g] = await this.drv.query(
      `SELECT COUNT(*)                        AS sesiones,
              COALESCE(SUM(total_animales), 0) AS total_animales,
              COALESCE(SUM(total_kg), 0.0)     AS total_kg
       FROM sesiones${where}`,
      params,
    );
    const lotes = await this.drv.query(
      `SELECT COALESCE(lote, '(sin lote)')      AS lote,
              COUNT(*)                          AS sesiones,
              COALESCE(SUM(total_animales), 0)  AS animales,
              COALESCE(SUM(total_kg), 0.0)      AS kg,
              MAX(hora_entrada)                 AS ultima_fecha
       FROM sesiones${where}
       GROUP BY COALESCE(lote, '(sin lote)')
       ORDER BY ultima_fecha DESC`,
      params,
    );
    const prom = (kg: number, animales: number): number | null =>
      animales ? round3(kg / animales) : null;
    return {
      sesiones: Number(g["sesiones"]),
      total_animales: Number(g["total_animales"]),
      total_kg: round3(Number(g["total_kg"])),
      promedio_global: prom(Number(g["total_kg"]), Number(g["total_animales"])),
      por_lote: lotes.map((r) => ({
        lote: r["lote"],
        sesiones: Number(r["sesiones"]),
        animales: Number(r["animales"]),
        kg: round3(Number(r["kg"])),
        promedio: prom(Number(r["kg"]), Number(r["animales"])),
        ultima_fecha: r["ultima_fecha"],
      })),
    };
  }

  /** Estadística por sesión — port EXACTO de Repo.stats (SPEC §6, v2).
   *
   * Totales sobre TODOS los eventos (con signo). La dispersión
   * (desviación estándar MUESTRAL n-1, varianza muestral, mediana, CV%,
   * uniformidad ±10 %) se calcula sobre los pesos individuales conocidos:
   * - modo "unidades": todos los eventos son SUBIDA n=1 → muestra COMPLETA.
   * - modo "lote": subidas de 1 animal + la REFERENCIA → ESTIMADA.
   */
  async stats(sessionId: number): Promise<Record<string, unknown>> {
    const session = await this.getSession(sessionId);
    const modo = (session?.["modo"] as string) || "lote";
    const events = await this.listEvents(sessionId);
    let totalKg = 0.0;
    let totalAnimales = 0;
    const singles: number[] = [];
    for (const ev of events) {
      if (ev["tipo"] === "ajuste" && Number(ev["delta_kg"]) === 0) continue;
      if (ev["tipo"] === "referencia") {
        // Motor v2: la REFERENCIA es el cerdo de prueba que se BAJÓ al
        // terminar la calibración — no integra los totales del lote
        // (count arranca en 0), pero su peso SÍ es una muestra
        // individual conocida.
        singles.push(Number(ev["delta_kg"]));
        continue;
      }
      let n = ev["animales_confirmados"] as number | null;
      if (n === null || n === undefined) n = ev["animales_estimados"] as number;
      n = Math.abs(Math.trunc(Number(n)));
      const delta = Number(ev["delta_kg"]);
      const sign = delta < 0 ? -1 : 1;
      totalKg += delta;
      totalAnimales += sign * n;
      if (sign > 0 && n === 1) singles.push(delta);
    }
    const promedio = totalAnimales ? totalKg / totalAnimales : null;

    const nMuestras = singles.length;
    // Desviación estándar / varianza MUESTRALES (n-1, Bessel):
    // 0 si n < 2 (con una sola muestra no hay dispersión medible).
    let desviacionStd = 0.0;
    let varianza = 0.0;
    if (nMuestras >= 2) {
      const media = singles.reduce((a, b) => a + b, 0) / nMuestras;
      varianza = singles.reduce((a, b) => a + (b - media) ** 2, 0) / (nMuestras - 1);
      desviacionStd = Math.sqrt(varianza);
    }
    const mediana = nMuestras ? median(singles) : null;

    let cvPct: number | null = null;
    let uniformidadPct: number | null = null;
    if (singles.length) {
      const mediaSingles = singles.reduce((a, b) => a + b, 0) / singles.length;
      if (mediaSingles) {
        cvPct = (desviacionStd / mediaSingles) * 100.0;
        const dentro = singles.filter((kg) => Math.abs(kg - mediaSingles) <= 0.1 * mediaSingles);
        uniformidadPct = (dentro.length / singles.length) * 100.0;
      }
    }

    return {
      total_kg: round3(totalKg),
      total_animales: totalAnimales,
      promedio: promedio !== null ? round3(promedio) : null,
      n_eventos: events.length,
      n_muestras: nMuestras,
      // alias legado (pre-v2); mismo valor que n_muestras
      n_muestras_individuales: nMuestras,
      min_delta: singles.length ? Math.min(...singles) : null,
      max_delta: singles.length ? Math.max(...singles) : null,
      mediana: mediana !== null ? round3(mediana) : null,
      varianza: round3(varianza),
      desviacion_std: round3(desviacionStd),
      cv_pct: cvPct !== null ? round2(cvPct) : null,
      uniformidad_pct: uniformidadPct !== null ? round2(uniformidadPct) : null,
      modo,
      // completa = cada animal pesado individualmente (unidades);
      // estimada = solo las subidas de 1 animal aportan muestra (lote)
      tipo_muestra: modo === "unidades" ? "completa" : "estimada",
    };
  }
}

/** statistics.median de Python: mediana clásica (promedio de las dos
 *  centrales con n par). */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
