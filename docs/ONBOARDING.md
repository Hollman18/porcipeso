# 📚 PorciPeso — Guía de instalación y primeros pasos

Esta guía está escrita para una persona que **nunca ha visto el sistema**. Si algo aquí no se entiende, es un error nuestro — repórtalo.

---

## 1 · Instalar

### 🪟 Windows (computador de la granja u oficina)
1. Descarga `PorciPeso-Setup.exe` (pestaña Actions de este repositorio → build más reciente → artifact "PorciPeso-windows").
2. Doble clic. Si Windows muestra *"Windows protegió tu PC"*: clic en **"Más información"** → **"Ejecutar de todas formas"** (pasa porque el software aún no tiene firma comercial — es seguro, es tuyo).
3. Siguiente → Instalar → queda el icono 🐷 en el escritorio y el menú Inicio.
4. Al abrirlo se abre tu navegador con la aplicación. **No cierres la ventana negra** (es el motor del sistema); minimízala.

### 🍎 Mac
1. Descarga y descomprime el zip (artifact "PorciPeso-macos").
2. Arrastra `PorciPeso.app` a Aplicaciones.
3. La primera vez: **clic derecho → Abrir → Abrir** (por la firma, igual que en Windows).

### 🤖 Android (celular o tablet — para pesar en el corral con Bluetooth)
1. Descarga `porcipeso.apk` en el celular (artifact "porcipeso-debug-apk").
2. Ábrelo → si Android pregunta, permite "instalar apps de origen desconocido" para esta descarga.
3. Instalar → aparece el icono 🐷 PorciPeso.
4. Al abrirla por primera vez, acepta el permiso de **Bluetooth** (lo necesita para hablar con la báscula).

---

## 2 · Primera vez: practica sin báscula (5 minutos)

No necesitas ningún equipo para aprender a usarlo:

1. Abre PorciPeso → **"Empezar a pesar"**.
2. La app detecta que no hay báscula y te ofrece **"Usar báscula simulada"** → acéptala.
3. Lee el tutorial de 3 pasos (sale solo la primera vez; después vive en "¿Cómo funciona?").
4. Ponle nombre al pesaje (ya viene sugerido) → **Comenzar**.
5. Usa el **🎛 Corral de prueba**: toca "Sube 1" (es el cerdo de prueba — espera el mensaje *"Calibrado"*), luego "Suben 3", "Se baja 1", "Inestabilidad"… y mira cómo la app narra todo lo que pasa.
6. Si te pregunta *"¿Cuántos subieron?"* — responde con los botones. Nunca adivina sola.
7. **"Terminar pesaje"** → resultados → ve al módulo **📊 Datos**: tu pesaje quedó guardado con toda su estadística.

**Regla de oro que hay que enseñarle a todo operador:** el primer cerdo SIEMPRE sube solo. Los demás, como quieran.

---

## 3 · Conectar la báscula real (lo hace el técnico, UNA vez)

### Qué necesitas
- Tu **indicador de peso** con salida serial RS-232 (los 25 modelos soportados aparecen en ⚙ Báscula; los más comunes: Lexus/Trumax Matrix, Yaohua XK3190-A12E, GMT Tuxon).
- Una de estas conexiones:

| Escenario | Pieza | Va con |
|---|---|---|
| PC al lado de la báscula | Cable serial directo o **adaptador USB-serial** (~$30.000 COP) | Windows/Mac |
| Báscula lejos del PC (misma red) | Conversor **serial→Ethernet/WiFi** tipo USR-TCP232 (~USD 25) | Windows/Mac |
| **Celular en el corral** (recomendado) | Adaptador **Bluetooth BLU2-RS232** conectado al indicador | Android |

### Pasos
1. **Configura el indicador en modo de transmisión continua** (una vez, con su teclado):
   - Trumax/Lexus Matrix: parámetro `Adr 00` (manual sección 7).
   - Yaohua XK3190-A12E: modo de envío continuo (manual del fabricante).
   - Otros: busca "continuous output / envío continuo" en el manual del modelo.
2. Conecta la pieza física (cable, conversor o BLU2) al puerto serial del indicador.
3. En PorciPeso: **⚙ Báscula** → elige marca y modelo → escribe la dirección:
   - Cable USB en Windows: `COM3` (aparece en el Administrador de dispositivos)
   - Cable USB en Mac/Linux: `/dev/ttyUSB0` o similar
   - Conversor de red: `192.168.0.50:8899` (la IP que configuraste en el conversor)
   - Bluetooth BLU2 en Android: la dirección del adaptador, ej. `00:14:03:05:59:02` (empareja primero el BLU2 en los ajustes Bluetooth del celular; PIN típico `1234`)
4. **"Probar conexión"** → pon algo de peso en la plataforma → debe decir *"La báscula responde: X kg ✓"*.
5. **Guardar**. Desde ahora "Empezar a pesar" usa tu báscula real. Listo para siempre.

---

## 4 · Problemas frecuentes

| Síntoma | Causa probable | Solución |
|---|---|---|
| "Probar conexión" falla | El indicador no está en modo continuo | Revisa el paso 3.1 (parámetro del indicador) |
| | Puerto equivocado | Windows: mira el COM real en Administrador de dispositivos |
| | Cable serial cruzado/derecho | Prueba con un cable null-modem (o al revés) |
| "⚠ Perdí la señal de la báscula" en pleno pesaje | Cable flojo / BLU2 sin energía / fuera de alcance BT (~15 m) | Revisa conexión física; el pesaje continúa donde iba al volver la señal |
| El peso salta como loco y nunca calibra | Cerdos en movimiento constante | Normal: la app espera sola. Si NUNCA calma, revisa que la plataforma no roce con nada |
| Los números no cuadraron con tu conteo | Algún cerdo se bajó sin que el sistema pudiera verlo claro | Al cerrar, la app compara tu conteo con el de ella y te muestra dónde revisar |
| Windows/Mac: "editor desconocido" al instalar | Falta firma comercial de código | "Más información → Ejecutar de todas formas" (Win) / clic derecho → Abrir (Mac) |
| Android: no encuentra el BLU2 | No está emparejado | Ajustes → Bluetooth → emparejar BLU2 (PIN 1234) y reintenta |

## 5 · ¿Dónde quedan mis datos?

- **Windows**: `%APPDATA%\PorciPeso\porcipeso.db` · **Mac**: `~/Library/Application Support/PorciPeso/` · **Android**: almacenamiento interno de la app.
- Nada se borra nunca: cada pesaje, cada movimiento y cada corrección quedan con fecha y hora.
- El Excel de cada lote se descarga desde los resultados o desde 📊 Datos.
- Cuando se active el servicio de **nube** (próxima fase), estos mismos datos se subirán automáticamente apenas haya internet — sin cambiar nada de lo que ya sabes hacer.
