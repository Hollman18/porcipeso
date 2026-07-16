# PorciPeso — Aplicación de escritorio

PorciPeso corre como una aplicación de escritorio normal: al abrirla arranca
el servidor local (solo en su computador, `127.0.0.1`) y se abre la app en su
navegador. Los datos quedan guardados en su computador:

| Sistema | Base de datos |
|---|---|
| macOS | `~/Library/Application Support/PorciPeso/porcipeso.db` |
| Windows | `%APPDATA%\PorciPeso\porcipeso.db` |
| Linux | `~/.local/share/PorciPeso/porcipeso.db` |

En esa misma carpeta se escribe `current_url.txt` con la URL de la app mientras
está corriendo (útil si cerró la pestaña del navegador).

---

## Para el usuario final

### Instalar en Windows

1. Descargue `PorciPeso-Setup.exe` (o `PorciPeso-windows.zip`).
2. **Con instalador**: doble clic en `PorciPeso-Setup.exe` → Siguiente →
   Instalar. Queda un icono "PorciPeso" en el menú Inicio (y en el escritorio
   si lo marcó).
3. **Con zip**: descomprima el zip donde quiera (p. ej. `C:\PorciPeso`) y haga
   doble clic en `PorciPeso.exe` dentro de la carpeta.
4. Al abrirlo aparece una ventana negra con mensajes (es el servidor — no la
   cierre mientras usa la app) y se abre el navegador con PorciPeso.
5. Para salir: cierre la ventana negra.
6. Windows puede mostrar "Windows protegió su PC" (la app no está firmada):
   clic en **Más información → Ejecutar de todas formas**.

### Instalar en macOS

1. Descargue `PorciPeso-macos.zip` y haga doble clic para descomprimir.
2. Arrastre `PorciPeso.app` a la carpeta **Aplicaciones**.
3. La **primera vez**: clic derecho sobre PorciPeso → **Abrir** → **Abrir**
   (la app no está firmada con certificado de Apple; esto solo se hace una
   vez). Si macOS insiste en bloquearla: Ajustes del Sistema → Privacidad y
   seguridad → "Abrir de todas formas". Alternativa por terminal:
   `xattr -dr com.apple.quarantine /Applications/PorciPeso.app`
4. La app abre el navegador con PorciPeso automáticamente.
5. Para salir: clic derecho sobre el icono de PorciPeso en el Dock → Salir.

### Si el navegador no se abre solo

Abra el archivo `current_url.txt` (en la carpeta de datos de la tabla de
arriba) y copie esa dirección en su navegador.

---

## Para desarrolladores

### Construir local (macOS o Windows)

```bash
# desde la raíz del repo, con el venv del proyecto
./.venv/bin/pip install -r packaging/requirements-build.txt
./.venv/bin/pyinstaller packaging/porcipeso.spec --noconfirm
```

Resultado en `dist/`:

- macOS: `dist/PorciPeso.app` (bundle) y `dist/PorciPeso/` (onedir crudo).
- Windows: `dist\PorciPeso\PorciPeso.exe` (onedir). El instalador se genera
  aparte con Inno Setup: `iscc packaging\installer.iss` → `dist\PorciPeso-Setup.exe`.

Los iconos `.icns`/`.ico` se generan automáticamente en `packaging/icons/`
desde `porcipeso/ui/static/icons/icon-512.png` (con Pillow) al correr el spec.

Notas:

- **ONEDIR a propósito** (no onefile): arranca más rápido y no desempaca a
  temp en cada arranque.
- Verificado localmente con Python 3.14 + PyInstaller 6.21. En CI se usa
  Python 3.12 por estabilidad.
- Variables útiles para pruebas: `PORCIPESO_PORT` (puerto fijo),
  `PORCIPESO_NO_BROWSER=1` (no abrir navegador), `PORCIPESO_DB` (otra base).

### Smoke test local

```bash
PORCIPESO_NO_BROWSER=1 ./dist/PorciPeso.app/Contents/MacOS/PorciPeso &
# espera el "listo — http://127.0.0.1:<puerto>/" y luego:
curl -i "$(cat ~/Library/Application\ Support/PorciPeso/current_url.txt)api/profiles"
kill %1   # apagado limpio
```

### Construir por CI

Workflow: `.github/workflows/desktop.yml`.

- Se dispara manualmente (**Actions → Desktop builds → Run workflow**) o al
  pushear un tag `v*` (p. ej. `git tag v0.1.0 && git push origin v0.1.0`).
- Matrix `macos-latest` + `windows-latest`, Python 3.12, mismo spec.
- Cada job corre un smoke test (arranca el binario y verifica
  `/api/profiles` y `/` → 200) antes de empaquetar.
- Artifacts: `PorciPeso-macos` (zip del .app) y `PorciPeso-windows`
  (zip onedir + `PorciPeso-Setup.exe` de Inno Setup). Se descargan desde la
  página del run en Actions.

### Archivos de esta carpeta

| Archivo | Qué es |
|---|---|
| `desktop_launcher.py` | Entrypoint de escritorio (uvicorn + navegador) |
| `porcipeso.spec` | Spec de PyInstaller (onedir, datos, iconos, .app) |
| `make_icons.py` | Genera `.icns`/`.ico` desde el icono PWA |
| `installer.iss` | Instalador Inno Setup para Windows |
| `requirements-build.txt` | Dependencias exactas de build |
| `icons/` | Iconos generados (no se versionan) |

### Pendientes conocidos

- **Firma de código**: ni el `.app` ni el `.exe` están firmados/notarizados;
  de ahí las advertencias de Gatekeeper/SmartScreen documentadas arriba.
- **Puertos seriales**: en macOS/Windows no requieren permisos especiales;
  en Linux el usuario debe pertenecer al grupo `dialout`.
