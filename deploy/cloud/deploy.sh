#!/usr/bin/env bash
# =============================================================================
# PorciPeso Cloud — deploy/actualización idempotente EN EL SERVIDOR.
#
# Uso (en el servidor, dentro del directorio con docker-compose.yml + .env):
#   ./deploy.sh
#
# Hace: docker compose pull (tolerante a imágenes locales) + up -d, y
# muestra el estado + un health-check local. Correrlo N veces es seguro.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  echo "ERROR: falta .env — copia .env.example, rellénalo y chmod 600 .env" >&2
  exit 1
fi

# Pull de la imagen. --ignore-pull-failures: si la imagen es un tag local
# (PORCIPESO_CLOUD_IMAGE=porcipeso-cloud:local) o ghcr es privado, el pull
# falla pero el deploy sigue con la imagen ya presente en el host.
docker compose pull --ignore-pull-failures || \
  echo "aviso: pull falló; se usa la imagen ya presente en el host"

docker compose up -d

echo
echo "== Estado =="
docker compose ps

echo
echo "== Health (127.0.0.1:8090) =="
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 3 http://127.0.0.1:8090/health 2>/dev/null; then
    echo
    echo "OK: PorciPeso Cloud responde."
    exit 0
  fi
  sleep 2
done
echo "ERROR: el servicio no respondió /health tras ~20 s. Revisa:" >&2
echo "  docker compose logs --tail 50 porcipeso-cloud" >&2
exit 1
