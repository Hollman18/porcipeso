# SPEC — Sistema de Pesaje Porcino por Lote ("PorciPeso")

**Fecha:** 2026-07-15 · **Estado:** Borrador para aprobación · **Autor:** spec generado con Claude

---

## 1. Objetivo

Software propio que convierte una **báscula estática + indicador serial económico** (Lexus/Trumax Matrix, XK3190-A12E o GMT Tuxon S) en un **sistema de análisis de pesaje porcino de clase comercial**, replicando y superando el envelope funcional del **PTM Advance Control Weight** (referencia funcional elegida por el cliente).

El indicador solo transmite el **peso crudo en tiempo real** (RS-232 / RS-485). Toda la inteligencia — conteo, estadística, lotes, trazabilidad, transmisión remota — vive en el software.

## 2. Referencia funcional: PTM Advance Control Weight

> ⚠️ La ficha técnica completa de PTM está tras login en [ptmsrl.com](https://ptmsrl.com/es/prodotto/advance-control-weight/). Lo confirmado público: *"sistema electrónico de adquisición y procesamiento de datos de pesaje para animales en movimiento"*, con *"muestreo periódico para control de ganancia de peso, tasa de conversión y uniformidad por corral (box)"* y *"gestión y control de salud y bienestar animal"*. La familia Advance añade: display gráfico, exportación USB, software PC (PTM Management), impresora/repetidor opcionales.
> El resto del envelope se completó con el estándar de la categoría (CIMA Control Pig, Osborne, Big Dutchman). **Pendiente:** si el cliente consigue la ficha PDF de PTM, contrastar y ajustar este spec.

Funcionalidad que el software DEBE cubrir (paridad PTM):

| # | Función PTM | En nuestro software |
|---|---|---|
| F1 | Pesaje de animales en movimiento | Motor de estabilización por ventana estadística sobre el stream serial |
| F2 | Muestreo periódico de ganancia de peso | Sesiones de pesaje recurrentes por lote/corral con comparación histórica |
| F3 | Uniformidad por corral (box) | CV%, desviación estándar, % dentro de banda ±10% del promedio |
| F4 | Tasa de conversión alimenticia | Fase 2 (requiere registrar consumo de alimento) |
| F5 | Salud/bienestar (alertas) | Alertas por peso fuera de rango y caída de ganancia diaria |
| F6 | Registro y memoria de pesajes | Base de datos local append-only, ilimitada |
| F7 | Exportación de datos / software PC | Export Excel/PDF + dashboard web remoto en tiempo real |
| F8 | Impresión de tiquete | Tiquete PDF/impresora térmica por sesión |

## 3. Modos de pesaje

### Modo A — Lote acumulado (el caso principal del cliente)
1. El operador abre una **sesión**: lote, corral origen, destino, placa camión, conductor.
2. **Seteo del peso de referencia**: se pesa 1 cerdo solo → ese valor queda como `peso_ref` (editable manualmente).
3. Suben cerdos a la plataforma (de a 1, 2, 3…). El software detecta cada **escalón estable** de peso y calcula cuántos subieron: `animales = round(Δpeso / peso_ref_actualizado)`.
4. En pantalla, en vivo: peso acumulado total, conteo total de cerdos, promedio real.
5. Al cerrar la sesión: totales, estadística completa, tiquete.

### Modo B — Báscula de paso / muestreo individual (paridad PTM "animales en movimiento")
Un animal a la vez cruza la plataforma (0 → estable → 0); cada captura estable es un registro individual. Alimenta la estadística de uniformidad con datos reales (no estimados).

**⚠ Anti-doble-conteo (cerdo que se devuelve y re-cruza):** en báscula de paso la celda de carga NO puede distinguir dirección — la curva de peso es idéntica en ambos sentidos. La dirección se resuelve por fuera de la celda, en este orden de preferencia:

1. **Puerta antirretorno mecánica** a la salida de la báscula (recomendada; estándar ganadero). Elimina el problema en el fierro: todo cruce es hacia adelante por construcción. El software no requiere lógica adicional.
2. **Par de fotoceldas IR** (sensor A entrada, sensor B salida, ~USD 50 total + placa USB de entradas): orden de corte A→B = adelante (+1), B→A = atrás (evento `devuelto`, −1). El software casa cada pesaje con su par de cortes.
3. **Red de seguridad en software (siempre activa, con o sin 1/2):**
   - *Detector de sospechosos:* cruce con peso ≈ (±3%) a otro registrado hace < 60 s (config) → flag `posible_devuelto` en ámbar → confirmación del operador.
   - *Conciliación al cierre:* el sistema muestra su conteo y pide el conteo físico del camión; si difieren, se revisan los eventos ámbar antes de emitir el tiquete. Campo `conteo_fisico` y `diferencia_conciliacion` en la sesión.

Nota: en Modo A (plataforma que acumula) este problema no existe — el conteo se deriva del peso neto en plataforma (§4.1). El video de la operación real del cliente definirá el modo por defecto.

### Modo C — Manual
El operador digita/ajusta un evento (correcciones, animal caído, doble conteo). Todo ajuste queda auditado (quién, cuándo, valor anterior).

## 4. Algoritmo de conteo y promedio (Modo A) — "cómo funciona en promedio"

```
peso_ref = peso del primer cerdo seteado          # ej. 102.5 kg
promedio_movil = peso_ref                          # se refina con cada escalón

por cada escalón estable detectado:
    delta = peso_estable_nuevo - peso_estable_anterior
    n = round(delta / promedio_movil)              # cerdos que subieron
    si |delta/n - promedio_movil| > TOLERANCIA(20%):
        marcar evento como AMBIGUO → pedir confirmación del operador
    conteo_total += n
    promedio_movil = peso_acumulado / conteo_total # el promedio se auto-corrige
```

- **Estable** = varianza del stream < umbral durante N segundos (config: 2 s, ±2 divisiones).
- El **promedio móvil auto-corregido** es la clave de la precisión: cada escalón confirmado recalibra el divisor, así el error no se acumula aunque los cerdos varíen de peso.
- Los eventos ambiguos (ej. delta=250 kg con promedio=100 → ¿2 o 3 cerdos?) nunca se resuelven en silencio: quedan en cola de confirmación.

### 4.1 Bajadas y reingresos (cerdo que se devuelve)

El algoritmo es **bidireccional**: el conteo se deriva del peso neto en plataforma, no de "entradas". Es imposible el doble conteo por diseño.

- **Delta negativo estable** = evento `bajada`: descuenta `round(|delta| / promedio_movil)` del conteo y registra el peso aproximado del que bajó.
- **Reingreso**: cuando vuelve a subir es un escalón positivo normal (+1). Neto del ciclo bajada+reingreso = 0 — el cerdo cuenta exactamente una vez.
- **Correlación**: el sistema sugiere el match entre la bajada (−101.2 kg) y el escalón previo más cercano en peso (98.5 kg de las 10:05) para trazabilidad del reingreso.
- **Bajada definitiva** (lesión/estrés/rechazo): el conteo ya quedó correcto; el operador etiqueta el evento con `motivo_bajada` (catálogo: estrés, lesión, rechazo, muerte) → aparece en el reporte del lote.
- **Cruce simultáneo** (uno baja mientras otros suben): el residuo del delta neto no cuadra con el promedio → flag `ambiguo` + cola de confirmación. Recomendación operativa: manga de un solo sentido durante el cargue.
- Nuevos valores de `tipo` en `eventos_pesaje`: `subida | bajada | reingreso | ajuste`; campo nuevo `motivo_bajada` (nullable) y `evento_relacionado_id` (para vincular bajada↔reingreso).

## 5. Datos a registrar (todo al detalle)

### Sesión (cabecera de lote)
`id, granja, lote, corral_origen, destino, placa_vehiculo, conductor, operador, bascula_id, peso_ref_inicial, hora_entrada (primer escalón), hora_salida (cierre), total_kg, total_animales, promedio_final, estado (abierta/cerrada/anulada)`

### Evento de pesaje (cada escalón)
`id, sesion_id, timestamp_ms, peso_antes, peso_despues, delta_kg, animales_estimados, animales_confirmados, duracion_estabilizacion_ms, tipo (subida/bajada/ajuste), flag_ambiguo, confirmado_por`

### Lecturas crudas (opcional, activable)
`timestamp_ms, peso, sesion_id` — a 10 Hz para auditoría/replay y para re-procesar sesiones con otro algoritmo.

### Catálogos
`granjas, corrales, lotes (con fecha nacimiento/entrada → edad en días), operadores, básculas (perfil de trama, puerto, calibración), destinos/clientes`.

## 6. Analítica (dashboard)

**Por sesión:** total kg, nº animales, promedio, min/max delta, desviación estándar, **CV%**, **uniformidad** (% animales dentro de ±10% del promedio), histograma de pesos, duración del cargue, kg/minuto.

**Por lote (histórico):** curva de crecimiento (peso promedio vs edad en días), **GDP — ganancia diaria promedio** entre pesajes, proyección de fecha a peso objetivo (ej. 110 kg), comparativo entre lotes/corrales, merma de transporte (pesaje origen vs destino si hay doble pesaje).

**Alertas (F5):** peso individual estimado fuera de rango configurable, GDP por debajo del umbral, CV% > umbral (lote desuniforme).

## 7. Comunicación

| Canal | Uso | Detalle |
|---|---|---|
| **RS-232** | Báscula → PC local (< 15 m) | 9600 8N1 típico; perfiles de trama por indicador |
| **RS-485** | Báscula(s) → PC (hasta 1.200 m, multidrop 32 nodos) | Vía Tuxon S nativo o conversor RS232↔485; Modbus RTU o ASCII |
| **Serial→TCP** | Báscula remota → software por red/internet | Conversor tipo USR-TCP232 (~USD 25); el software lee un socket TCP igual que un COM |
| **WebSocket** | Software → dashboard remoto en tiempo real | Peso vivo + eventos, con buffer offline (store-and-forward) si cae internet |

**Perfiles de trama incluidos (parser configurable):**
1. `MATRIX`: 8 bytes `= X6..X1 SP` (Adr 00 normal / Adr 99 invertido), continuo.
2. `XK3190-A12E`: ASCII continuo, paridad par.
3. `TUXON-ASCII` y `TUXON-MODBUS` (RTU, registro de peso bruto).
4. `GENERICO`: regex configurable (encabezado, nº dígitos, terminador) para cualquier indicador futuro.

## 8. Requisitos no funcionales

- **Offline-first**: la granja opera sin internet; sincroniza al volver.
- **Append-only + auditoría**: nada se borra; correcciones son eventos nuevos.
- **Arranque < 10 s, operable con guantes** (botones grandes, alto contraste).
- Español como idioma base. Export Excel (.xlsx) y PDF.
- PC granja: Windows 10+ o mini-PC Linux; navegador moderno para el dashboard remoto.

## 9. Fases

- **MVP (Fase 1):** Modo A completo + RS-232/TCP + sesión/eventos/estadística de sesión + tiquete + dashboard remoto de solo-lectura.
- **Fase 2:** Modo B, RS-485/Modbus multidrop, curvas de crecimiento/GDP/proyección, alertas, conversión alimenticia, multi-granja.

## 10. Decisiones abiertas (para el cliente)

1. ¿El pesaje se usa para **facturar la venta** (→ exige indicador Clase III certificado, ej. Sensocar SCA31) o solo control interno?
2. ¿PC en la granja será Windows o sirve un mini-PC dedicado (~USD 150, más robusto)?
3. ¿Cuántas básculas simultáneas se prevén? (define si RS-485 multidrop entra en el MVP)
4. ¿Conseguir la ficha PDF de PTM para contrastar paridad exacta?
