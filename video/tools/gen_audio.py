#!/usr/bin/env python
"""Regenera TODOS los audios de PorciPeso con es-MX-JorgeNeural (+5%),
comprime silencios (>0.28s -> ~0.24s) con el ffmpeg de remotion,
remapea los word-boundaries al audio comprimido y emite:
  - public/audio/{e1..e6,e4b,s1..s4}.mp3  (comprimidos)
  - src/subs.ts        (cues del comercial, en frames 30fps)
  - src/shortsWords.ts (timings palabra-a-palabra de los shorts)
  - tools/timings.json (duraciones y palabras clave para retimear escenas)
"""
import asyncio, json, re, subprocess, sys, os

VIDEO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO_DIR = os.path.join(VIDEO, "public", "audio")
RAW_DIR = os.path.join(VIDEO, "tools", "raw_audio")
os.makedirs(RAW_DIR, exist_ok=True)

VOICE = "es-MX-JorgeNeural"
RATE = "+5%"
FPS = 30
THRESH = "-38dB"
MIN_SIL = 0.28   # silencios mayores a esto se comprimen
KEEP_SIL = 0.24  # aire que queda (≈7 frames)
LEAD_KEEP = 0.06
TAIL_KEEP = 0.30

# ---- GUIONES reescritos para fluidez oral: frases hiladas con comas y
# puntos suspensivos (el TTS pausa menos), mismo contenido. Los del
# comercial van como lista de "cues" (subtítulo por trozo).
COMERCIAL = {
    "e1": [
        "¿Cuántos cerdos subieron,",
        "y cuánto pesan de verdad?",
        "Porque si todavía lo llevas a mano...",
        "esto te va a cambiar la operación.",
    ],
    "e2": [
        "El pesaje inteligente tradicional",
        "es un indicador importado,",
        "costoso, con meses de espera,",
        "y que te amarra a una sola marca de báscula.",
    ],
    "e3": [
        "PorciPeso es distinto, porque es software,",
        "y se conecta a cualquier indicador con puerto serial,",
        "del más económico al más costoso...",
        "son veinticinco marcas ya integradas,",
        "así que usas la báscula que ya tienes,",
        "sin esperar importaciones,",
        "más barato, y creciendo contigo.",
    ],
    "e4": [
        "En el corral todo pasa en tu celular,",
        "subes un cerdo de prueba y el sistema se calibra solo,",
        "después subes el lote como quieras,",
        "que él cuenta, descuenta al que se baja,",
        "y si duda... te pregunta,",
        "y al final te da total, promedio, uniformidad,",
        "y tu informe en Excel y PDF con tu marca.",
    ],
    "e4b": [
        "Y en el computador tienes toda la analítica,",
        "cada lote, cada pesaje, cada tendencia...",
        "lista para decidir.",
    ],
    "e5": [
        "Se instala en el computador de la granja o en un celular,",
        "conectado por cable o por Bluetooth,",
        "y funciona sin internet...",
        "en pleno corral, sin señal,",
        "no se pierde ni un kilo.",
    ],
    "e6": [
        "¿Y cuando quieras más?",
        "Activas la nube,",
        "y tienes el celular en el corral,",
        "el computador en la oficina,",
        "y todas tus granjas en tiempo real,",
        "con la información centralizada...",
        "PorciPeso, una solución ELEIA,",
        "agenda tu demostración.",
    ],
}

SHORTS = {
    "s1": "¿Cuántos cerdos hay en esta báscula... veinte, veinticinco, treinta? "
          "El sistema ya lo sabe, son veintisiete... PorciPeso cuenta por ti, "
          "en cualquier báscula con puerto serial... escríbenos.",
    "s2": "Deja de contar cerdos a mano... ¿eran veintiséis, o veintisiete, "
          "y el que se bajó y nadie lo vio? El celular en el corral cuenta solo... "
          "subieron tres, uno se bajó, ya lo desconté... él cuenta, tú decides, escríbenos.",
    "s3": "No compres báscula nueva... ¿tu indicador tiene este puerto? "
          "Entonces ya tienes un sistema inteligente... veinticinco marcas integradas, "
          "del más barato al más caro... PorciPeso convierte la báscula que ya tienes, "
          "sin importaciones, sin esperas... escríbenos.",
    "s4": "Míralo desde tu hamaca... todas tus granjas en tiempo real, en tu bolsillo... "
          "tres granjas, doce mil ochocientos kilos hoy, y subiendo... "
          "la nube de PorciPeso, una solución ELEIA, escríbenos.",
}


def ff(*args):
    return subprocess.run(["npx", "remotion", "ffmpeg", *args], cwd=VIDEO,
                          capture_output=True, text=True)


def ffprobe_dur(path):
    r = subprocess.run(["npx", "remotion", "ffprobe", "-v", "error", "-show_entries",
                        "format=duration", "-of", "csv=p=0", path],
                       cwd=VIDEO, capture_output=True, text=True)
    return float(r.stdout.strip().splitlines()[-1])


async def tts(text, out_mp3):
    import edge_tts
    words = []
    com = edge_tts.Communicate(text, VOICE, rate=RATE, boundary="WordBoundary")
    with open(out_mp3, "wb") as f:
        async for chunk in com.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                words.append({
                    "w": chunk["text"],
                    "t0": chunk["offset"] / 1e7,
                    "t1": (chunk["offset"] + chunk["duration"]) / 1e7,
                })
    return words


def detect_silences(path):
    r = ff("-i", path, "-af", f"silencedetect=noise={THRESH}:d={MIN_SIL}", "-f", "null", "-")
    log = r.stderr
    starts = [float(m) for m in re.findall(r"silence_start: ([\d.]+)", log)]
    ends = [float(m) for m in re.findall(r"silence_end: ([\d.]+)", log)]
    return list(zip(starts, ends[:len(starts)] + [None] * (len(starts) - len(ends))))


def build_cuts(silences, dur):
    """Devuelve lista de tramos [a,b) a ELIMINAR."""
    cuts = []
    for i, (s, e) in enumerate(silences):
        if e is None:
            e = dur
        length = e - s
        leading = s < 0.02
        trailing = e > dur - 0.05
        if leading:
            # deja solo LEAD_KEEP al final del silencio inicial
            if length > LEAD_KEEP:
                cuts.append((0.0, e - LEAD_KEEP))
        elif trailing:
            if length > TAIL_KEEP:
                cuts.append((s + TAIL_KEEP, dur))
        else:
            if length > KEEP_SIL:
                cuts.append((s + KEEP_SIL, e))
    return cuts


def apply_cuts(src, dst, cuts, dur):
    """Concatena los tramos que se conservan."""
    keeps, t = [], 0.0
    for a, b in cuts:
        if a > t:
            keeps.append((t, a))
        t = b
    if t < dur:
        keeps.append((t, dur))
    parts, chains = [], []
    for i, (a, b) in enumerate(keeps):
        chains.append(f"[0:a]atrim=start={a:.4f}:end={b:.4f},asetpts=PTS-STARTPTS[p{i}];")
        parts.append(f"[p{i}]")
    fc = "".join(chains) + "".join(parts) + f"concat=n={len(keeps)}:v=0:a=1[out]"
    r = ff("-y", "-i", src, "-filter_complex", fc, "-map", "[out]", "-b:a", "112k", dst)
    if r.returncode != 0:
        print(r.stderr[-2000:]); sys.exit(1)
    return keeps


def remap(t, cuts):
    """tiempo original -> tiempo comprimido"""
    removed = 0.0
    for a, b in cuts:
        if t >= b:
            removed += b - a
        elif t > a:
            removed += t - a  # dentro de un corte: colapsa al inicio
    return t - removed


TOKEN = re.compile(r"[a-záéíóúüñA-ZÁÉÍÓÚÜÑ0-9]+", re.UNICODE)


def align_cues(cues, words):
    """Asigna a cada cue (texto) su rango de word-boundaries por conteo de tokens."""
    out, wi = [], 0
    for cue in cues:
        n = len(TOKEN.findall(cue))
        if n == 0:
            continue
        chunk = words[wi:wi + n]
        assert len(chunk) == n, f"align: faltan palabras para {cue!r} ({len(chunk)}/{n})"
        out.append({"text": cue.strip().rstrip(','), "t0": chunk[0]["t0"], "t1": chunk[-1]["t1"]})
        wi += n
    assert wi == len(words), f"align: sobran {len(words)-wi} palabras"
    return out


async def main():
    report = {}
    jobs = [(k, " ".join(v)) for k, v in COMERCIAL.items()] + list(SHORTS.items())
    for key, text in jobs:
        raw = os.path.join(RAW_DIR, f"{key}.mp3")
        final = os.path.join(AUDIO_DIR, f"{key}.mp3")
        words = await tts(text, raw)
        dur = ffprobe_dur(raw)
        sil = detect_silences(raw)
        cuts = build_cuts(sil, dur)
        apply_cuts(raw, final, cuts, dur)
        ndur = ffprobe_dur(final)
        nwords = [{"w": TOKEN.findall(w["w"])[0] if TOKEN.findall(w["w"]) else w["w"],
                   "from": round(remap(w["t0"], cuts) * FPS),
                   "to": round(remap(w["t1"], cuts) * FPS)} for w in words]
        report[key] = {"dur": ndur, "frames": round(ndur * FPS), "words": nwords}
        if key in COMERCIAL:
            cues = align_cues(COMERCIAL[key], words)
            report[key]["cues"] = [{"text": c["text"],
                                    "from": round(remap(c["t0"], cuts) * FPS),
                                    "to": round(remap(c["t1"], cuts) * FPS)} for c in cues]
        print(f"{key}: {dur:.2f}s -> {ndur:.2f}s ({round(ndur*FPS)} frames), "
              f"{len(cuts)} cortes de silencio")

    # extiende el 'to' de cada cue hasta el arranque del siguiente (lectura cómoda)
    for key in COMERCIAL:
        cues = report[key]["cues"]
        for i, c in enumerate(cues):
            nxt = cues[i + 1]["from"] if i + 1 < len(cues) else c["to"] + 12
            c["to"] = max(c["to"] + 3, min(nxt, c["to"] + 18))

    with open(os.path.join(VIDEO, "tools", "timings.json"), "w") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)

    # ---- subs.ts
    subs = {k: report[k]["cues"] for k in COMERCIAL}
    with open(os.path.join(VIDEO, "src", "subs.ts"), "w") as f:
        f.write("// AUTO-GENERADO por tools/gen_audio.py — cues en frames (30fps), "
                "relativos al inicio del AUDIO\n")
        f.write("export type Cue = { from: number; to: number; text: string };\n")
        f.write("export const SUBS: Record<string, Cue[]> = ")
        f.write(json.dumps({k: [{"from": c["from"], "to": c["to"], "text": c["text"]}
                                for c in v] for k, v in subs.items}, ensure_ascii=False, indent=1)
                if False else json.dumps({k: [{"from": c["from"], "to": c["to"], "text": c["text"]}
                                              for c in v] for k, v in subs.items()},
                                         ensure_ascii=False, indent=1))
        f.write(";\n")

    # ---- shortsWords.ts
    with open(os.path.join(VIDEO, "src", "shortsWords.ts"), "w") as f:
        f.write("// AUTO-GENERADO por tools/gen_audio.py — timings de palabra (30fps) "
                "relativos al inicio del audio\n")
        f.write("export type Word = { w: string; from: number; to: number };\n")
        f.write("export const WORDS: Record<string, Word[]> = ")
        f.write(json.dumps({k: report[k]["words"] for k in SHORTS}, ensure_ascii=False))
        f.write(";\n")

    print("\nRESUMEN frames de audio:")
    for k in report:
        print(f"  {k}: {report[k]['frames']} frames ({report[k]['dur']:.2f}s)")


if __name__ == "__main__":
    asyncio.run(main())
