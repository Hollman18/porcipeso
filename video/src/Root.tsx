import React from "react";
import { Composition } from "remotion";
import { Main, TOTAL_FRAMES } from "./Main";
import { S1Reto } from "./shorts/S1Reto";
import { S2Mano } from "./shorts/S2Mano";
import { S3NoCompres } from "./shorts/S3NoCompres";
import { S4Hamaca } from "./shorts/S4Hamaca";

// Duraciones: voz (+15%) s1 14.06s, s2 15.48s, s3 17.69s, s4 14.26s + cierre CTA
const SHORTS = [
  { id: "short1", Comp: S1Reto, frames: 480 },
  { id: "short2", Comp: S2Mano, frames: 510 },
  { id: "short3", Comp: S3NoCompres, frames: 570 },
  { id: "short4", Comp: S4Hamaca, frames: 470 },
] as const;

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="comercial"
      component={Main}
      durationInFrames={TOTAL_FRAMES}
      fps={30}
      width={1920}
      height={1080}
    />
    {SHORTS.map(({ id, Comp, frames }) => (
      <Composition
        key={id}
        id={id}
        component={Comp}
        durationInFrames={frames}
        fps={30}
        width={1080}
        height={1920}
      />
    ))}
  </>
);
