import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C } from "../theme";
import { LedBox } from "../components/Devices";
import { Lockup, Subtitles } from "../components/Common";

/** E1 — LOGO+HOOK: el LED rojo despierta en "0.0 kg" y aparece el lockup. */
export const E1Hook: React.FC = () => {
  const frame = useCurrentFrame();

  // el LED "despierta": parpadeo los primeros ~26 frames
  const flicker =
    frame < 26 ? (frame % 8 < 3 ? 0.15 : frame % 8 < 5 ? 0.6 : 1) : 1;
  const glow = interpolate(frame, [8, 30], [0.1, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse at 50% 35%, ${C.darkCard} 0%, ${C.darkBg} 70%)`,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 56 }}>
        <div style={{ opacity: flicker }}>
          <LedBox value="0.0" width={620} fontSize={150} glow={glow} />
        </div>
        <Lockup at={62} dark eleiaAt={150} />
      </div>
      <Subtitles scene="e1" />
    </AbsoluteFill>
  );
};
