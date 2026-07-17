import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C } from "../theme";
import { LedBox } from "../components/Devices";
import { FotoBg, Lockup, Subtitles } from "../components/Common";

/** E1 — LOGO+HOOK: cerdo real de fondo, el LED rojo despierta y aparece el lockup. */
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
        background: C.darkBg,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <FotoBg src="fotos/cerdo-oscuro.jpg" dur={225} overlay={0.58} zoomFrom={1.05} zoomTo={1.16} panX={-24} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 56,
          position: "relative",
          zIndex: 1,
        }}
      >
        <div style={{ opacity: flicker }}>
          <LedBox value="0.0" width={620} fontSize={150} glow={glow} />
        </div>
        <Lockup at={62} dark eleiaAt={140} />
      </div>
      <Subtitles scene="e1" />
    </AbsoluteFill>
  );
};
