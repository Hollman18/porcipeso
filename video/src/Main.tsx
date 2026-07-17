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

// Duración de cada escena en frames (30 fps). La voz arranca en AUDIO_DELAY (15).
// Duraciones de los mp3 (ffprobe): e1 7.82s, e2 8.76s, e3 17.66s, e4 18.79s,
// e4b 7.30s, e5 11.06s, e6 15.58s — cada escena deja aire después de la voz.
export const SCENES = [
  { key: "e1", frames: 285, Comp: E1Hook },
  { key: "e2", frames: 315, Comp: E2Problema },
  { key: "e3", frames: 585, Comp: E3Solucion },
  { key: "e4", frames: 600, Comp: E4Celular },
  { key: "e4b", frames: 270, Comp: E4bAnalitica },
  { key: "e5", frames: 390, Comp: E5Instalacion },
  { key: "e6", frames: 540, Comp: E6Nube },
] as const;

export const TOTAL_FRAMES = SCENES.reduce((a, s) => a + s.frames, 0); // 2985 = 99.5s

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
