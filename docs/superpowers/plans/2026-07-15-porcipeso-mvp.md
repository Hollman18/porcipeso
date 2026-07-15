# PorciPeso MVP — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Un agente por módulo, en paralelo; los módulos son directorios disjuntos que codifican contra los contratos congelados de `porcipeso/core/`.

**Goal:** MVP funcional del sistema de pesaje porcino por lote (Modo A + Modo B) leyendo cualquier indicador serial, según `docs/SPEC.md` y `docs/ARQUITECTURA.md`.

**Architecture:** Python 3.12+ · FastAPI + WebSocket · sqlite3 stdlib (WAL, append-only) · pyserial · UI estática vanilla JS servida por FastAPI · simulador TCP de indicadores para e2e.

**Tech Stack:** fastapi, uvicorn, pyserial, pyyaml, openpyxl; dev: pytest, httpx, websockets. Venv en `.venv/` (ya instalado).

## Global Constraints

- Python `>=3.12`; correr tests con `./.venv/bin/pytest`.
- **CONTRATO CONGELADO:** `porcipeso/core/models.py` y `porcipeso/core/interfaces.py` NO se modifican. Todo módulo importa de ahí.
- Cada módulo es dueño exclusivo de su directorio (ver tareas); nadie toca directorios ajenos.
- TDD: test primero dentro de cada módulo; sin mocks de la DB (sqlite en tmp_path).
- Sin dependencias nuevas sin actualizar pyproject y este plan.
- Textos de UI en español.

---

### Task 1: Drivers — todo indicador serial (`porcipeso/drivers/`, `tests/drivers/`)

**Produces:**
- `transports.py`: `SerialTransport(profile)`, `TcpTransport(profile)`, `make_transport(profile) -> Transport`.
- `parsers.py`: implementaciones de `FrameParser` + `PARSER_REGISTRY: dict[str, type[FrameParser]]` con claves: `matrix` (Adr 00 y 99 vía `extra.reversed`), `xk3190_a12e`, `tuxon_ascii`, `modbus_rtu` (registro en `extra`), `sics` (MT-SICS SI/SIR), `toledo_cont` (STX status), `cardinal_738`, `sma`, `and_stream` (A&D), `dini_argeo`, `rinstrum_r320`, `nci` (Avery/NCI 3835), `generic_regex` (regex en `extra.pattern`).
- `profiles.yaml`: catálogo comercial ≥ 20 perfiles (marca, modelo, parser, framing por defecto) cubriendo LatAm: Lexus/Trumax Matrix, Yaohua XK3190-A12E/A9/A27, GMT Tuxon S/C, Rhino I-QY, T-Scale, Rice Lake, Cardinal 205/738, Mettler-Toledo (SICS), Ohaus (SICS), A&D, Dini Argeo, Rinstrum, Sensocar SCA31, Avery NCI, Prometálicos, genérico regex, genérico TCP.
- `catalog.py`: `load_profiles() -> list[ScaleProfile]`, `get_profile(id)`.
- `runner.py`: `run_driver(profile, on_reading, stop)` — loop transporte→parser→callback con watchdog.

**Tests:** cada parser con bytes reales de manual (fragmentados y con basura); catálogo carga y valida.

### Task 2: Engine (`porcipeso/engine/`, `tests/engine/`)

**Produces:** `engine.py`: `WeighingEngine(config, on_event, on_state=None)` implementando `core.interfaces.Engine` con la lógica de SPEC §4: ventana de estabilidad, escalones ± con signo, referencia = primer escalón, promedio auto-corregido, ambiguos (opciones floor/ceil) + `confirm()`, `EngineSnapshot`, watchdog SIN_SENAL.

**Tests:** streams sintéticos: subida limpia, 2 a la vez, bajada+reingreso (neto correcto), ambiguo→confirm, cerdo inquieto (ruido largo), sin señal.

### Task 3: DB + API (`porcipeso/db/`, `porcipeso/api/`, `tests/api/`)

**Produces:**
- `db/schema.sql` + `db/repo.py`: `init_db(path)`, repos sesiones/eventos/lecturas (append-only; DDL de ARQUITECTURA §3 + campos `conteo_fisico`, `diferencia_conciliacion`, `motivo_bajada`, `evento_relacionado_id`).
- `api/app.py`: `create_app(db_path=…) -> FastAPI`:
  - `GET /api/profiles` · `POST /api/scale/connect {profile_id, port?}` · `GET /api/scale/status`
  - `POST /api/sessions` (payload: lote, corral, destino, placa, conductor, operador) · `GET /api/sessions` · `GET /api/sessions/{id}` · `POST /api/sessions/{id}/close {conteo_fisico?}`
  - `GET /api/sessions/{id}/events` · `POST /api/events/{id}/confirm {n}` · `POST /api/events/{id}/motivo {motivo}`
  - `GET /api/sessions/{id}/export.xlsx` (openpyxl)
  - `WS /ws`: mensajes `{"type":"reading","kg":…,"ts_ms":…,"state":…}`, `{"type":"event",…}`, `{"type":"snapshot",…}`
  - Sirve `porcipeso/ui/static/` en `/`.
- Wiring: hilo `run_driver` → `WeighingEngine.feed` → persistencia + broadcast WS. Perfil `sim` disponible sin hardware.

**Tests:** httpx TestClient: ciclo sesión completa con engine alimentado a mano; export xlsx válido.

### Task 4: UI operador + dashboard (`porcipeso/ui/static/`)

**Produces:** `index.html` (+ `app.js`, `styles.css`): pantalla del operador conectada a `/ws` y API — réplica del diseño de `docs/mvp.html` (LED, tarjetas, curva canvas, cola ámbar, tiquete al cerrar) pero SIN simulador embebido: los datos vienen del WebSocket. Selector de báscula/perfil (GET /api/profiles → connect). `historial.html`: lista de sesiones + detalle con estadística (CV%, uniformidad ±10 %) + botón export.

### Task 5: Simulador + E2E (`porcipeso/sim/`, `tests/e2e/`)

**Produces:** `sim/indicator_sim.py`: servidor TCP que emite tramas (Matrix/A12E/SICS elegible) siguiendo un guion (`Scenario`: subidas, bajada, inquieto, silencio); CLI `python -m porcipeso.sim`.
**Tests e2e:** guion completo → TcpTransport+parser → engine → asserts de conteo/total/promedio y del caso devuelto (SPEC §4.1).

### Task 6 (integración, sesión principal): pytest completo verde, arranque real `uvicorn`, humo con simulador, commit.
