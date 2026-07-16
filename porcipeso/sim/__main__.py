"""CLI del simulador de indicadores.

Uso:
    python -m porcipeso.sim --port 9999 --encoder matrix --demo

Emite tramas TCP del guion demo (ref 1 cerdo, suben 2, se devuelve 1,
reingresa, suben 3, cierre) a 10 Hz hasta Ctrl-C.
"""
from __future__ import annotations

import argparse
import sys
import time

from .indicator_sim import FrameEncoder, IndicatorSimServer, Scenario, demo_scenario


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m porcipeso.sim",
        description="Simulador TCP de indicadores de pesaje (PorciPeso).",
    )
    ap.add_argument("--host", default="127.0.0.1", help="host de escucha (default 127.0.0.1)")
    ap.add_argument("--port", type=int, default=9999, help="puerto TCP (default 9999; 0 = libre)")
    ap.add_argument("--encoder", default="matrix", choices=FrameEncoder.KINDS,
                    help="protocolo de trama a emitir (default matrix)")
    ap.add_argument("--hz", type=int, default=10, help="frecuencia de emisión (default 10)")
    ap.add_argument("--seed", type=int, default=0, help="semilla del ruido físico")
    ap.add_argument("--demo", action="store_true",
                    help="corre el guion demo (ref 1, suben 2, se devuelve 1, "
                         "reingresa, suben 3, cierre)")
    args = ap.parse_args(argv)

    if args.demo:
        scenario = demo_scenario(seed=args.seed)
    else:
        # sin --demo: plataforma vacía y estable (peso 0) por una hora
        scenario = Scenario([("wait", 3600.0)], seed=args.seed)

    server = IndicatorSimServer(host=args.host, port=args.port,
                                encoder=args.encoder, scenario=scenario, hz=args.hz)
    server.start()
    print(f"[sim] escuchando en {args.host}:{server.port} · encoder={args.encoder} · {args.hz} Hz")
    print(f"[sim] guion: {'demo' if args.demo else 'plataforma vacía'} · Ctrl-C para salir")
    try:
        while True:
            time.sleep(1.0)
            kg = scenario.kg_now
            estado = "SILENCIO" if kg is None else f"{kg:8.1f} kg"
            print(f"[sim] peso={estado} · cerdos={scenario.pigs_count} "
                  f"· físico={scenario.total_physical_kg:.1f} kg"
                  f"{' · guion terminado' if scenario.done else ''}")
    except KeyboardInterrupt:
        print("\n[sim] deteniendo…")
    finally:
        server.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
