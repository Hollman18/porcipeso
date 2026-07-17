-- PorciPeso — esquema SQLite (append-only, WAL)
-- DDL según docs/ARQUITECTURA.md §3 + campos de conciliación/bajadas (SPEC §4.1, §5).
-- Idempotente: todo CREATE usa IF NOT EXISTS.

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

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
  -- Modo de pesaje del motor v2: 'lote' (acumulado con cerdo de prueba)
  -- o 'unidades' (uno a uno). En DBs viejas la columna se agrega en
  -- init_db() vía PRAGMA table_info + ALTER TABLE (ver repo.init_db).
  modo                     TEXT NOT NULL DEFAULT 'lote'
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
  opciones              TEXT,               -- JSON: candidatos si ambiguo, ej. "[2, 3]"
  motivo_bajada         TEXT,               -- estres | lesion | rechazo | muerte | ...
  evento_relacionado_id INTEGER REFERENCES eventos_pesaje(id),
  confirmado_por        TEXT
);

CREATE TABLE IF NOT EXISTS lecturas_crudas (
  ts_ms     INTEGER NOT NULL,
  kg        REAL NOT NULL,
  sesion_id INTEGER REFERENCES sesiones(id)
);

CREATE INDEX IF NOT EXISTS idx_eventos_sesion    ON eventos_pesaje(sesion_id, ts_ms);
CREATE INDEX IF NOT EXISTS idx_eventos_ambiguo   ON eventos_pesaje(sesion_id, ambiguo)
  WHERE ambiguo = 1;
CREATE INDEX IF NOT EXISTS idx_lecturas_sesion   ON lecturas_crudas(sesion_id, ts_ms);
CREATE INDEX IF NOT EXISTS idx_sesiones_estado   ON sesiones(estado);
CREATE INDEX IF NOT EXISTS idx_sesiones_hora_entrada ON sesiones(hora_entrada);
