# 🐷 PorciPeso — la báscula que te habla claro

Software de pesaje porcino por lote. Se conecta a **cualquier indicador de peso con puerto serial** (25 modelos de catálogo: Lexus/Trumax, Yaohua, GMT, Mettler-Toledo, Cardinal…), cuenta los cerdos automáticamente, te pregunta cuando duda y te entrega la estadística del lote en lenguaje humano.

**[📚 GUÍA DE INSTALACIÓN Y PRIMEROS PASOS → docs/ONBOARDING.md](docs/ONBOARDING.md)** ← empieza aquí

---

## Instalar en 1 minuto

| Tu equipo | Qué descargar | Cómo |
|---|---|---|
| 🪟 **Windows** | `PorciPeso-Setup.exe` | Doble clic → Siguiente → listo (icono en el escritorio) |
| 🍎 **Mac** | `PorciPeso.app` (zip) | Arrastrar a Aplicaciones y abrir |
| 🤖 **Android** (celular/tablet) | `porcipeso.apk` | Abrir el APK → Instalar |

Los instaladores se descargan de la pestaña **[Actions](../../actions)** de este repositorio (el build más reciente → sección "Artifacts").

> ⚠ La primera vez, Windows/Mac muestran "editor desconocido" (el software aún no tiene firma comercial). En Windows: "Más información" → "Ejecutar de todas formas". En Mac: clic derecho → "Abrir". Detalle en [packaging/README.md](packaging/README.md).

## Los primeros 5 minutos (sin báscula)

1. Abre PorciPeso → botón gigante **"Empezar a pesar"**.
2. Como no hay báscula conectada, la app te ofrece **"Usar báscula simulada"** — acéptala.
3. Sigue el tutorial de 3 pasos y usa el **Corral de prueba** (Sube 1, Suben 3, Se baja 1, Inestabilidad…).
4. **"Terminar pesaje"** → mira los resultados y luego el módulo **📊 Datos**: todo quedó guardado de verdad.

## Conectar tu báscula real (una sola vez, lo hace el técnico)

1. Conecta el indicador al equipo: **cable serial directo** (PC), **adaptador USB-serial**, **conversor serial→red** (USR-TCP232) o **adaptador Bluetooth BLU2-RS232** (celular Android).
2. En la app: **⚙ Báscula** → elige marca y modelo del catálogo → escribe el puerto (`COM3`, `/dev/ttyUSB0`, IP:puerto, o la dirección Bluetooth del BLU2).
3. Toca **"Probar conexión"** → debe decir *"La báscula responde: X kg ✓"* → **Guardar**.
4. Configura el indicador en **modo de transmisión continua** (ver el manual de tu modelo; para el Trumax Matrix: parámetro `Adr 00`).

La guía detallada con diagramas de cableado, solución de problemas y preguntas frecuentes está en **[docs/ONBOARDING.md](docs/ONBOARDING.md)**.

## Cómo funciona (lo que le explicas a cualquiera)

1. **Sube UN cerdo solo** — es el cerdo de prueba; el sistema se calibra con su peso.
2. **Sube los demás como quieras** — de a 1, 2 o 3; el sistema ve cuánto sube el peso y calcula cuántos entraron.
3. **Él cuenta, tú supervisas** — las bajadas no descuentan (en báscula de paso el cerdo sigue al camión): si uno se devuelve y vuelve a pasar, tú lo descuentas con un toque; si duda ("¿subieron 1 o 2?") te pregunta con botones grandes; al final: cerdos, kilos, promedio y si el lote es parejo.

## Para desarrolladores

- Backend: Python 3.12+ · FastAPI · SQLite (WAL, append-only) · `python -m porcipeso.api`
- App móvil: Capacitor 6 con motor embebido en TS (paridad verificada contra el motor Python) · `mobile/`
- Tests: `./.venv/bin/pytest` (141) · `cd mobile && npm test` (41)
- Specs y arquitectura: [docs/SPEC.md](docs/SPEC.md) · [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md)
- Builds: GitHub Actions ([desktop.yml](.github/workflows/desktop.yml) · [android.yml](.github/workflows/android.yml))
