#!/bin/zsh
# Doble clic para abrir PorciPeso — arranca el software completo (servidor + base de datos).
cd "$(dirname "$0")"
# Apagar el servidor viejo de solo-páginas si quedó corriendo
pkill -f "http.server 8477" 2>/dev/null
# Arrancar el backend real si no está corriendo
if ! curl -s -o /dev/null http://localhost:8477/api/profiles; then
  PORCIPESO_PORT=8477 nohup ./.venv/bin/python -m porcipeso.api >/tmp/porcipeso.log 2>&1 &
  for i in {1..20}; do
    curl -s -o /dev/null http://localhost:8477/api/profiles && break
    sleep 0.5
  done
fi
open "http://localhost:8477/"
