import React from "react";
import { AbsoluteFill, Audio, Sequence, Series, staticFile } from "remotion";
import { AUDIO_DELAY } from "./theme";
import { E1Hook } from "./scenes/E1Hook";
import { E2Problema } from "./scenes/E2Problema";
import { E3Solucion } from "./scenes/E3Solucion";
import { E4Celular } from "./scenes/E4Celular";
import { E4bAnalitica } from "./scenes/E4bAnalitica";
import { E5Instalacion } from "./scenes/E5Instalacion";
import { E6Nube } from "./scenes/E6Nube";

// Duración de cada escena en frames (30 fps). La voz arranca en AUDIO_DELAY (8).
// Audios JorgeNeural +5% con silencios comprimidos (tools/gen_audio.py):
// e1 209f, e2 247f, e3 486f, e4 516f, e4b 207f, e5 313f, e6 416f.
// Cada escena = 8f de entrada + voz + ~8f de aire (e6 sostiene el cierre CTA).
export const SCENES = [
  { key: "e1", frames: 225, Comp: E1Hook },
  { key: "e2", frames: 264, Comp: E2Problema },
  { key: "e3", frames: 502, Comp: E3Solucion },
  { key: "e4", frames: 532, Comp: E4Celular },
  { key: "e4b", frames: 224, Comp: E4bAnalitica },
  { key: "e5", frames: 330, Comp: E5Instalacion },
  { key: "e6", frames: 470, Comp: E6Nube },
] as const;

export const TOTAL_FRAMES = SCENES.reduce((a, s) => a + s.frames, 0); // 2547 = 84.9s

export const Main: React.FC = () => (
  <AbsoluteFill style={{ background: "#0F1411" }}>
    <Series>
      {SCENES.map(({ key, frames, Comp }) => (
        <Series.Sequence key={key} durationInFrames={frames} name={key}>
          <Comp />
          <Sequence from={AUDIO_DELAY} name={`voz-${key}`}>
            <Audio src={staticFile(`audio/${key}.mp3`)} />
          </Sequence>
        </Series.Sequence>
      ))}
    </Series>
  </AbsoluteFill>
);
