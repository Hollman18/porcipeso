# ARQUITECTURA — PorciPeso

**Fecha:** 2026-07-15 · **Estado:** Borrador para aprobación

---

## 1. Vista general

```
┌─────────────┐  RS-232/RS-485   ┌──────────────────────────────┐   WebSocket/HTTPS   ┌────────────────┐
│  INDICADOR  │ ───────────────▶ │   PC GRANJA (PorciPeso Core) │ ──────────────────▶ │ DASHBOARD REMOTO│
│ (Matrix /   │  trama continua  │  1. Adquisición serial       │   tiempo real +     │ (los de "allá") │
│  Tuxon S /  │  10 lecturas/s   │  2. Motor de pesaje (FSM)    │   store-and-forward │  peso vivo,     │
│  A12E)      │                  │  3. SQLite append-only       │                     │  lotes, stats   │
└─────────────┘                  │  4. UI operador (pantalla)   │                     └────────────────┘
      │ opcional                 │  5. API + sync               │
      └── conversor USR-TCP232 ──▶ (lee socket TCP como COM)    │
                                 └──────────────────────────────┘
```

Principio rector: **el indicador es tonto, el software es listo**. Cualquier indicador que escupa peso por serial se soporta con un perfil de trama.

## 2. Capas

### Capa 1 — Adquisición (`acquisition/`)
- Un **reader** por báscula: `SerialReader` (pyserial / serialport) o `TcpReader` (socket).
- **Parser por perfil** (estrategia): `MatrixParser`, `A12EParser`, `TuxonAsciiParser`, `TuxonModbusParser`, `RegexParser`.
- Salida normalizada: `Reading { ts_ms, kg, bascula_id }` a 10 Hz en un bus interno.
- Watchdog: si no llegan tramas en 3 s → estado `SIN_SEÑAL` visible en UI y evento de auditoría.

### Capa 2 — Motor de pesaje (`engine/`)
Máquina de estados por sesión:

```
IDLE ──peso > umbral──▶ MOVIMIENTO ──varianza<ε por N s──▶ ESTABLE
  ▲                          ▲                                │
  │                          └────── peso cambia ─────────────┤ registra escalón
  └───── peso ≈ 0 (plataforma vacía, cierre) ◀────────────────┘ (delta, n animales)
```

- Ventana deslizante de 2 s (20 lecturas); estable si `max-min ≤ 2 divisiones`.
- Cada transición a ESTABLE con `|delta| > peso_ref×0.5` genera un `WeighEvent` — **con signo**: delta positivo = `subida`, negativo = `bajada` (cerdo que se devuelve; descuenta del conteo). El conteo siempre refleja lo que está físicamente en plataforma → doble conteo imposible por diseño (ver SPEC §4.1).
- Conteo: `n = round(delta / promedio_movil)`; ambiguo si el residuo supera la tolerancia (20% config) → cola de confirmación. Patrón sube-baja dentro de la misma ventana → evento congelado como ambiguo (cruce simultáneo).
- El motor es **puro y determinista**: recibe lecturas, emite eventos. Se testea con streams grabados (fixtures de lecturas crudas reales).

### Capa 3 — Persistencia (`db/`)
SQLite (WAL). Tablas: `sesiones`, `eventos_pesaje`, `lecturas_crudas` (opcional), `lotes`, `corrales`, `basculas`, `operadores`, `sync_outbox`.
Append-only: correcciones = eventos tipo `ajuste` referenciando al original.

### Capa 4 — Tiempo real y sync (`sync/`)
- WebSocket local: la UI del operador y el dashboard remoto se suscriben al mismo stream de eventos + peso vivo (throttled a 5 Hz para red).
- `sync_outbox`: cada evento se encola; un worker lo empuja al servidor remoto con reintentos exponenciales. Sin internet, nada se pierde.

### Capa 5 — UI
- **Operador (local)**: pantalla única — peso vivo gigante, conteo, promedio, botón sesión, cola de ambiguos. Web app servida por el mismo proceso (kiosk en el navegador).
- **Dashboard remoto**: lista de sesiones en vivo, detalle con estadística y gráficos, histórico por lote, exportes.

## 3. Modelo de datos (DDL resumido)

```sql
CREATE TABLE sesiones (
  id INTEGER PRIMARY KEY, uuid TEXT UNIQUE, granja_id INT, lote_id INT,
  corral_origen TEXT, destino TEXT, placa TEXT, conductor TEXT,
  operador_id INT, bascula_id INT, peso_ref_inicial REAL,
  hora_entrada TEXT, hora_salida TEXT,
  total_kg REAL, total_animales INT, promedio_final REAL,
  estado TEXT CHECK(estado IN ('abierta','cerrada','anulada'))
);
CREATE TABLE eventos_pesaje (
  id INTEGER PRIMARY KEY, sesion_id INT REFERENCES sesiones(id),
  ts_ms INTEGER, peso_antes REAL, peso_despues REAL, delta_kg REAL,
  animales_estimados INT, animales_confirmados INT,
  estab_ms INT, tipo TEXT, ambiguo INT DEFAULT 0, confirmado_por INT
);
CREATE TABLE lecturas_crudas (ts_ms INTEGER, kg REAL, sesion_id INT);
CREATE TABLE sync_outbox (id INTEGER PRIMARY KEY, tabla TEXT, fila_uuid TEXT,
  payload TEXT, intentos INT DEFAULT 0, enviado INT DEFAULT 0);
```

## 4. Opciones de stack evaluadas

| | A (recomendada) | B | C |
|---|---|---|---|
| Stack | **Python 3.12 + FastAPI + pyserial + SQLite + web UI (React/MUI)** | Node.js + Electron | C#/.NET WinForms |
| Pro | pyserial maduro, prototipo rápido, mismo proceso sirve UI local y API, corre en Windows y mini-PC Linux | UI empaquetada de escritorio | Nativo Windows |
| Contra | requiere runtime Python (se empaqueta con PyInstaller) | Electron pesado para un mini-PC | ata a Windows, menos reutilizable para el dashboard web |

**Recomendación: A.** Un solo binario empaquetado, la misma base de código sirve la pantalla del operador (kiosk) y el dashboard remoto, y los fixtures de streams se testean trivial en pytest. El frontend reutiliza los patrones MUI que ya manejamos.

## 5. Testing

- **Unit**: parsers de trama (bytes reales grabados → kg esperado); FSM con streams sintéticos (subida limpia, doble subida, cerdo inquieto, bajada parcial).
- **Replay**: toda sesión con `lecturas_crudas` activado puede re-procesarse; regresión del algoritmo contra sesiones reales.
- **E2E**: simulador de indicador (script que emite tramas Matrix por un puerto serial virtual `socat`/com0com) → verifica conteo y dashboard.

## 6. Riesgos

1. **Cerdos en movimiento constante** → la plataforma nunca "estabiliza" perfecto. Mitigación: umbral de estabilidad configurable + media recortada (descarta picos) en la ventana.
2. **Trama sin flag de estabilidad** (Matrix) → la detección es 100% nuestra; el replay de crudas permite tunear sin volver a la granja.
3. **Deltas ambiguos** con cerdos muy dispares → cola de confirmación; el Modo B (muestreo individual) reduce la varianza del `peso_ref`.
4. **Ruido eléctrico/RS-232 largo** → limitar a 15 m; más allá, RS-485 o conversor TCP junto al indicador.
