import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { C, F, AUDIO_DELAY } from "../theme";
import { SUBS, Cue } from "../subs";

/**
 * Foto real de granja a pantalla completa con Ken Burns (zoom/pan lento)
 * + overlay gradiente oscuro #202722 para que el texto siga reventando.
 */
export const FotoBg: React.FC<{
  src: string;
  dur: number; // duración de la escena en frames (para el ritmo del Ken Burns)
  overlay?: number; // opacidad base del overlay (0.55–0.75)
  zoomFrom?: number;
  zoomTo?: number;
  panX?: number; // px de paneo horizontal a lo largo de la escena
  panY?: number;
  opacity?: number;
}> = ({
  src,
  dur,
  overlay = 0.65,
  zoomFrom = 1.06,
  zoomTo = 1.18,
  panX = 0,
  panY = 0,
  opacity = 1,
}) => {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [0, dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const s = zoomFrom + (zoomTo - zoomFrom) * t;
  const a1 = Math.max(0, overlay - 0.12);
  const a2 = Math.min(0.92, overlay + 0.1);
  return (
    <AbsoluteFill style={{ overflow: "hidden", opacity }}>
      <Img
        src={staticFile(src)}
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${s}) translate(${panX * t}px, ${panY * t}px)`,
        }}
      />
      <AbsoluteFill
        style={{
          background: `linear-gradient(180deg, rgba(32,39,34,${a1}) 0%, rgba(32,39,34,${overlay}) 45%, rgba(32,39,34,${a2}) 100%)`,
        }}
      />
    </AbsoluteFill>
  );
};

/** Entrada con spring (escala + subida) a partir del frame `at`. */
export const Pop: React.FC<{
  at: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
  fromY?: number;
}> = ({ at, children, style, fromY = 28 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - at, fps, config: { damping: 14, mass: 0.7 } });
  const o = interpolate(frame - at, [0, 10], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        opacity: o,
        transform: `translateY(${(1 - s) * fromY}px) scale(${0.92 + s * 0.08})`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/** Fade simple a partir de `at` durante `dur` frames. */
export const Fade: React.FC<{
  at: number;
  dur?: number;
  out?: boolean;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ at, dur = 12, out = false, children, style }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [at, at + dur], out ? [1, 0] : [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return <div style={{ opacity: o, ...style }}>{children}</div>;
};

/** Número que cuenta de a→b entre los frames f0→f1. */
export const useCount = (f0: number, f1: number, a: number, b: number): number => {
  const frame = useCurrentFrame();
  return interpolate(frame, [f0, f1], [a, b], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
};

export const fmtMiles = (n: number): string =>
  Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");

/** Título de escena, condensed bold. */
export const SceneTitle: React.FC<{
  children: React.ReactNode;
  dark?: boolean;
  at?: number;
  size?: number;
}> = ({ children, dark = false, at = 6, size = 58 }) => (
  <Pop at={at} fromY={18}>
    <div
      style={{
        fontFamily: F.title,
        fontWeight: 700,
        fontSize: size,
        letterSpacing: 0.5,
        color: dark ? "#FFFFFF" : C.ink,
        textAlign: "center",
      }}
    >
      {children}
    </div>
  </Pop>
);

/** Chip / píldora. */
export const Chip: React.FC<{
  children: React.ReactNode;
  bg?: string;
  color?: string;
  border?: string;
  size?: number;
}> = ({ children, bg = C.verdeSoft, color = C.verdeInk, border = C.verde, size = 26 }) => (
  <span
    style={{
      background: bg,
      color,
      border: `2px solid ${border}`,
      borderRadius: 999,
      padding: "8px 24px",
      fontFamily: F.body,
      fontWeight: 700,
      fontSize: size,
      whiteSpace: "nowrap",
    }}
  >
    {children}
  </span>
);

/** Lockup de marca: cerdo + PORCIPESO + tagline. */
export const Lockup: React.FC<{
  at?: number;
  scale?: number;
  dark?: boolean;
  eleiaAt?: number;
}> = ({ at = 0, scale = 1, dark = true, eleiaAt }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - at, fps, config: { damping: 13, mass: 0.8 } });
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6 * scale,
        transform: `scale(${(0.9 + s * 0.1) * scale})`,
        opacity: interpolate(frame - at, [0, 10], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        }),
      }}
    >
      <div style={{ fontSize: 120, lineHeight: 1 }}>🐷</div>
      <div
        style={{
          fontFamily: F.title,
          fontWeight: 700,
          fontSize: 110,
          letterSpacing: 3,
          color: dark ? "#FFFFFF" : C.ink,
          lineHeight: 1.05,
        }}
      >
        PORCI<span style={{ color: C.verde }}>PESO</span>
      </div>
      <div
        style={{
          fontFamily: F.body,
          fontSize: 34,
          fontWeight: 600,
          color: dark ? C.calm : C.verdeInk,
        }}
      >
        La báscula que te habla claro
      </div>
      {eleiaAt !== undefined && (
        <Fade at={eleiaAt} style={{ marginTop: 18 }}>
          <div
            style={{
              fontFamily: F.body,
              fontSize: 28,
              fontWeight: 600,
              color: dark ? C.darkMuted : C.muted,
            }}
          >
            una solución{" "}
            <span style={{ color: C.eleia, fontWeight: 800, letterSpacing: 1 }}>ELEIA</span>
          </div>
        </Fade>
      )}
    </div>
  );
};

/** Subtítulos quemados, sincronizados con los SRT de edge-tts. */
export const Subtitles: React.FC<{ scene: keyof typeof SUBS }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const t = frame - AUDIO_DELAY; // los cues son relativos al inicio del audio
  const cue: Cue | undefined = SUBS[scene].find((c) => t >= c.from && t < c.to);
  if (!cue) return null;
  const o =
    interpolate(t, [cue.from, cue.from + 4], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }) *
    interpolate(t, [cue.to - 3, cue.to], [1, 0.85], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  return (
    <div
      style={{
        position: "absolute",
        bottom: 44,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          background: "rgba(10,14,11,0.78)",
          color: "#FFFFFF",
          fontFamily: F.body,
          fontWeight: 600,
          fontSize: 36,
          lineHeight: 1.3,
          padding: "12px 30px",
          borderRadius: 14,
          maxWidth: 1300,
          textAlign: "center",
          opacity: o,
        }}
      >
        {cue.text}
      </div>
    </div>
  );
};
