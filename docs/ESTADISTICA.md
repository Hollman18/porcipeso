# Estadística de PorciPeso

Cómo se calculan las métricas de `GET /api/sessions/{id}/stats` (y las
que viajan en la hoja **Resumen** del export `.xlsx`). Implementación:
`porcipeso/db/repo.py → Repo.stats()`, con la `statistics` de la
librería estándar de Python.

## La muestra: de dónde salen los pesos individuales

Toda la dispersión se calcula sobre la lista de **pesos individuales
conocidos** de la sesión ("singles"): los deltas de eventos de subida
con exactamente **1 animal** (incluida la `REFERENCIA` del cerdo de
prueba en modo lote). Las bajadas y los eventos grupales no aportan
muestra. El tamaño de esa lista es `n_muestras`.

La calidad de la muestra depende del **modo** de la sesión (columna
`sesiones.modo`, campo `modo` del stats):

| Modo | Qué es la muestra | Campo `tipo_muestra` |
|---|---|---|
| `unidades` | **Censo completo**: cada animal cruza solo la báscula y genera un evento `SUBIDA n=1` con su peso exacto. `n_muestras == total_animales` pesados. Máxima precisión: la estadística describe al lote entero, no a un subconjunto. | `"completa"` |
| `lote` | **Estimación**: solo los animales que subieron de a uno (más el cerdo de prueba de la calibración) dejan un peso individual. Los que subieron en grupo aportan al total pero no a la dispersión. La estadística es una estimación del lote a partir de ese subconjunto — de ahí que se use la corrección muestral (n−1). | `"estimada"` |

## Métricas y fórmulas

Sea `x₁ … xₙ` la muestra (`n = n_muestras`) y `x̄` su media aritmética.

### Totales (sobre TODOS los eventos, con signo)

- **`total_kg`** = Σ `delta_kg` de todos los eventos (las bajadas restan).
- **`total_animales`** = Σ ±n de cada evento (confirmados si existen,
  estimados si no; las bajadas restan).
- **`promedio`** = `total_kg / total_animales` (kg por animal). Es el
  promedio *real* del lote pesado, no el de la muestra.

### Posición (sobre la muestra)

- **`mediana`** = valor central de la muestra ordenada (promedio de los
  dos centrales si `n` es par). Robusta frente a un animal atípico que
  desplazaría la media.

### Dispersión (sobre la muestra, MUESTRAL: divisor n−1)

- **`varianza`** — varianza muestral (`statistics.variance`):

  s² = Σ(xᵢ − x̄)² / (n − 1)

- **`desviacion_std`** — desviación estándar muestral
  (`statistics.stdev`):

  s = √s²

  Se usa el divisor **n−1** (corrección de Bessel) y no `n` (pstdev)
  porque los pesos individuales son una *muestra* con la que se infiere
  la dispersión del lote — con divisor `n` la varianza queda sesgada a
  la baja, y el sesgo es mayor justo cuando la muestra es chica (el caso
  típico del modo lote). En modo `unidades` la muestra es el censo del
  lote pesado y la diferencia n vs n−1 se vuelve despreciable al crecer
  `n`; se mantiene n−1 por consistencia y porque el lote pesado suele
  ser a su vez muestra de una población mayor (el corral/la granja).

  **Convención `n < 2`**: con 0 o 1 muestras no existe dispersión
  medible (n−1 = 0) → `desviacion_std = 0.0` y `varianza = 0.0`.

- **`cv_pct`** — coeficiente de variación:

  CV% = (s / x̄) × 100

- **`uniformidad_pct`** — % de la muestra dentro de ±10 % de la media:

  Uniformidad = |{ xᵢ : |xᵢ − x̄| ≤ 0.10·x̄ }| / n × 100

- **`min_delta` / `max_delta`** = mínimo y máximo de la muestra.

`cv_pct` y `uniformidad_pct` son `null` si no hay muestra (`n = 0`).

## Por qué CV% + uniformidad ±10 % (estándar porcino)

Son las dos métricas de uniformidad usadas de forma generalizada en
producción porcina comercial (integradoras, casas de genética y
software de granja las reportan así):

- **CV%** es adimensional: permite comparar la variabilidad de lotes
  con pesos medios distintos (destete vs engorde vs salida a planta).
  En la práctica comercial, un CV bajo (en torno a un dígito alto) se
  considera un lote parejo y un CV alto dispara manejo (separar colas,
  ajustar alimentación).
- **Uniformidad ±10 %** ("% dentro de la banda") es la forma operativa
  en que granja y planta hablan de homogeneidad: qué fracción de los
  animales cae en la ventana de peso objetivo. La banda de ±10 % de la
  media es la convención habitual del sector para clasificar lotes y
  liquidar con menos castigos por pesos fuera de rango.

Ambas se conservan con su definición de siempre; el cambio v2 es que la
desviación que las alimenta pasó de poblacional (`pstdev`) a
**muestral** (`stdev`, n−1), y se agregan `mediana`, `varianza` y
`n_muestras` para dar el cuadro completo.

## Resumen de campos nuevos/cambiados en v2

| Campo | Nuevo/Cambiado | Nota |
|---|---|---|
| `n_muestras` | nuevo | tamaño de la muestra individual |
| `n_muestras_individuales` | sin cambio | alias legado, mismo valor |
| `mediana` | nuevo | kg |
| `varianza` | nuevo | kg², muestral (n−1) |
| `desviacion_std` | cambiado | ahora muestral (n−1); `0.0` si n<2 |
| `modo` | nuevo | `lote` \| `unidades` (de la sesión) |
| `tipo_muestra` | nuevo | `completa` (unidades) \| `estimada` (lote) |
