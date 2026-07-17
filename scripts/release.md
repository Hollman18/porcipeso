# PorciPeso — Proceso de release

Guía para humanos. Publicar una versión son **5 pasos**; todo lo demás
(compilar, firmar, adjuntar binarios al Release) lo hace CI solo.

## Cómo fluye la versión (mecanismo)

La **fuente única de verdad es el archivo `VERSION`** en la raíz del repo
(ej. `2.1.0`). Nadie hardcodea versiones en otro lado:

- **Workflows** (`.github/workflows/android.yml` y `desktop.yml`): un paso
  inicial lee `VERSION` y exporta `PORCIPESO_VERSION` (y en Android también
  `PORCIPESO_VERSION_CODE = git rev-list --count HEAD`, un entero que crece
  con cada commit — por eso el checkout usa `fetch-depth: 0`).
- **Android** (`mobile/android/app/build.gradle`): gradle lee las env
  `PORCIPESO_VERSION` → `versionName` y `PORCIPESO_VERSION_CODE` →
  `versionCode`. Sin env (build local) usa defaults y no rompe nada.
- **Firma Android**: solo en tags `v*`. CI decodifica el secret
  `ANDROID_KEYSTORE_BASE64` a un archivo temporal y gradle firma leyendo
  las env `PORCIPESO_KEYSTORE_FILE/_PASSWORD`, `PORCIPESO_KEY_ALIAS/_PASSWORD`
  (vienen de los secrets `ANDROID_*` del repo). El keystore original vive
  **fuera del repo** en `~/porcipeso_secrets/` del operador (ver su README:
  si se pierde, no hay más actualizaciones firmadas).
- **Desktop** (`packaging/installer.iss`): CI pasa
  `/DMyAppVersion=$PORCIPESO_VERSION` a ISCC; el `#define` del .iss es solo
  fallback local.
- **Nombres publicados**: `porcipeso-vX.Y.Z.apk`,
  `PorciPeso-Setup-vX.Y.Z.exe`, `PorciPeso-macos-vX.Y.Z.zip`
  (+ `PorciPeso-windows-vX.Y.Z.zip`), adjuntos al GitHub Release del tag.

## Feed de actualización para clientes (`config/app-config.json`)

El repo es **PRIVADO**: los clientes NO pueden consultar
`api.github.com/.../releases/latest` ni URLs raw del repo (necesitarían un
token). En su lugar, `config/app-config.json` es la config remota global y
**se sirve vía el cloud**: el endpoint `GET /config/app` del servicio en la
nube hace fallback a este archivo. Los clientes solo hablan con el cloud —
**nunca** con GitHub.

Campos: `latest_version` (última publicada), `min_version` (por debajo de
esto la app exige actualizar), `apk_url` (URL de descarga directa del APK,
hospedada por el cloud u otro hosting público, JAMÁS una URL raw del repo)
y `banners` (avisos con vigencia `desde`/`hasta`; `solo_sin_nube` los
muestra solo a clientes sin servicio de nube).

**En cada release** se actualizan `latest_version` y `apk_url` en este
archivo (mismo commit que `VERSION`).

## Los 5 pasos

1. **Editar versión y config**: poner la nueva versión (ej. `2.2.0`) en
   `VERSION` y actualizar `latest_version` + `apk_url` (y `min_version` si
   la release rompe compatibilidad) en `config/app-config.json`.
2. **Commit**: `git add VERSION config/app-config.json && git commit -m "release: v2.2.0"` y `git push`.
3. **Tag**: `git tag v2.2.0` (el tag SIEMPRE `v` + contenido de VERSION).
4. **Push del tag**: `git push origin v2.2.0` → dispara `android-apk`
   (APK firmado) y `Desktop builds`; ambos adjuntan sus binarios al mismo
   GitHub Release `v2.2.0`.
5. **Verificar**: `gh release view v2.2.0` debe listar
   `porcipeso-v2.2.0.apk`, `PorciPeso-Setup-v2.2.0.exe` y
   `PorciPeso-macos-v2.2.0.zip`. Probar instalación del APK sobre la
   versión anterior (misma firma = actualiza sin desinstalar).

## Deploy de la nube (PorciPeso Cloud)

El servidor nube (`python -m porcipeso.cloud`) se empaqueta con
`Dockerfile.cloud` (raíz del repo) y se despliega con Docker Compose desde
`deploy/cloud/`. Hoy corre en el VPS en `/opt/porcipeso/` (contenedor
`porcipeso-cloud`, puerto **8090**, datos en el volumen
`porcipeso_cloud_data`).

**Flujo normal (con CI):**

1. **Build + push de la imagen**: cada push a `main` que toque
   `porcipeso/cloud/**` o `Dockerfile.cloud` dispara
   `.github/workflows/cloud-image.yml`, que publica
   `ghcr.io/hollman18/porcipeso-cloud:latest` (y `:sha`). También se puede
   lanzar a mano (workflow_dispatch).
2. **Deploy en el servidor**: `ssh` al VPS y correr
   `/opt/porcipeso/deploy.sh` (idempotente: `docker compose pull` + `up -d`
   + health-check). El compose y el `.env` (secretos, `chmod 600`) viven en
   `/opt/porcipeso/`.

**Fallback sin ghcr** (paquete privado / pull anónimo denegado — el modo en
uso hoy): subir el contexto al VPS (`/opt/porcipeso/src/`: `pyproject.toml`,
`porcipeso/`, `VERSION`, `config/`, `Dockerfile.cloud`), construir allá
`docker build -f Dockerfile.cloud -t porcipeso-cloud:local .` y dejar
`PORCIPESO_CLOUD_IMAGE=porcipeso-cloud:local` en el `.env`; `deploy.sh`
tolera el pull fallido y usa la imagen local.

Variables obligatorias del `.env` (ver `deploy/cloud/.env.example`):
`CLOUD_JWT_SECRET` (el servidor no arranca sin él) y, para el primer
arranque, `CLOUD_SUPERADMIN_EMAIL`/`CLOUD_SUPERADMIN_PASSWORD` (bootstrap
idempotente). Las credenciales reales están en el `.env` del servidor y en
`~/porcipeso_secrets/README.md` del operador.

> ⚠️ **ADVERTENCIA — sin TLS**: hoy la nube sirve por **HTTP plano en el
> puerto 8090** (`http://31.97.147.124:8090`). Los tokens y contraseñas
> viajan **sin cifrar** hasta que haya TLS: apto para pilotos, **no para
> producción sensible**. Paso siguiente recomendado: un **dominio propio**
> de PorciPeso + proxy inverso con certificado (Caddy/nginx + Let's
> Encrypt). **NO** usar los dominios ni el Traefik del otro negocio que
> vive en el mismo VPS.
