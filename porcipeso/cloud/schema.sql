-- PorciPeso Cloud — esquema SQLite (WAL, multi-tenant).
-- Aislamiento por tenant_id en TODA query (fail-closed en la capa API).
-- Idempotente: todo CREATE usa IF NOT EXISTS.

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS tenants (
  id        INTEGER PRIMARY KEY,
  uuid      TEXT NOT NULL UNIQUE,
  nombre    TEXT NOT NULL,
  slug      TEXT NOT NULL UNIQUE,
  activo    INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  uuid          TEXT NOT NULL UNIQUE,
  -- NULL = superadmin (usuario de plataforma, sin tenant)
  tenant_id     INTEGER REFERENCES tenants(id),
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nombre        TEXT,
  password_hash TEXT NOT NULL,
  rol           TEXT NOT NULL CHECK (rol IN ('superadmin', 'admin', 'operador')),
  activo        INTEGER NOT NULL DEFAULT 1,
  creado_en     TEXT NOT NULL,
  creado_por    TEXT
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expira_en  TEXT NOT NULL,
  revocado   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);

-- Configuración remota: tenant_id NULL = global. La unicidad de clave se
-- garantiza con DOS índices parciales porque en SQLite un UNIQUE(tenant_id,
-- clave) trata cada NULL como distinto (permitiría claves globales repetidas).
CREATE TABLE IF NOT EXISTS config_remota (
  id             INTEGER PRIMARY KEY,
  tenant_id      INTEGER REFERENCES tenants(id),
  clave          TEXT NOT NULL,
  valor_json     TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_config_tenant
  ON config_remota(tenant_id, clave) WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_config_global
  ON config_remota(clave) WHERE tenant_id IS NULL;

CREATE TABLE IF NOT EXISTS telemetria (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER REFERENCES tenants(id),  -- NULL = anónimo/sin tenant
  device_id   TEXT NOT NULL,
  plataforma  TEXT,
  version_app TEXT,
  payload_json TEXT,
  recibido_en TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telemetria_tenant ON telemetria(tenant_id, recibido_en);

-- Fallos de login (persistencia del rate limit; el limitador también
-- mantiene un espejo en memoria para no pagar un COUNT por request).
CREATE TABLE IF NOT EXISTS login_fallos (
  email TEXT NOT NULL COLLATE NOCASE,
  ts    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_fallos ON login_fallos(email, ts);

-- Espejo nube de `sesiones` del schema local (porcipeso/db/schema.sql)
-- + tenant_id + device_id. Idempotencia por (tenant_id, uuid).
CREATE TABLE IF NOT EXISTS sync_sesiones (
  id                       INTEGER PRIMARY KEY,
  tenant_id                INTEGER NOT NULL REFERENCES tenants(id),
  device_id                TEXT,
  uuid                     TEXT NOT NULL,
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
  actualizado_en           TEXT NOT NULL,
  UNIQUE (tenant_id, uuid)
);

CREATE INDEX IF NOT EXISTS idx_sync_sesiones_entrada
  ON sync_sesiones(tenant_id, hora_entrada);

-- Espejo nube de `eventos_pesaje`. Los eventos referencian la sesión por
-- sesion_uuid (los ids enteros locales difieren por dispositivo).
CREATE TABLE IF NOT EXISTS sync_eventos (
  id                      INTEGER PRIMARY KEY,
  tenant_id               INTEGER NOT NULL REFERENCES tenants(id),
  device_id               TEXT,
  uuid                    TEXT NOT NULL,
  sesion_uuid             TEXT NOT NULL,
  ts_ms                   INTEGER NOT NULL,
  peso_antes              REAL NOT NULL,
  peso_despues            REAL NOT NULL,
  delta_kg                REAL NOT NULL,
  animales_estimados      INTEGER NOT NULL,
  animales_confirmados    INTEGER,
  estab_ms                INTEGER NOT NULL DEFAULT 0,
  tipo                    TEXT NOT NULL
                          CHECK (tipo IN ('referencia', 'subida', 'bajada', 'reingreso', 'ajuste')),
  ambiguo                 INTEGER NOT NULL DEFAULT 0,
  opciones                TEXT,
  motivo_bajada           TEXT,
  evento_relacionado_uuid TEXT,
  confirmado_por          TEXT,
  actualizado_en          TEXT NOT NULL,
  UNIQUE (tenant_id, uuid)
);

CREATE INDEX IF NOT EXISTS idx_sync_eventos_sesion
  ON sync_eventos(tenant_id, sesion_uuid, ts_ms);
