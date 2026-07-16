#!/bin/zsh
# Doble clic para abrir PorciPeso en modo práctica (báscula imaginaria).
cd "$(dirname "$0")/porcipeso/ui/static"
# Si el servidor no está corriendo, arrancarlo
if ! curl -s -o /dev/null http://localhost:8477/index.html; then
  nohup python3 -m http.server 8477 >/dev/null 2>&1 &
  sleep 1
fi
open "http://localhost:8477/index.html?demo=1"
