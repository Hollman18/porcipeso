import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { C, F } from "../theme";
import { WORDS, Word } from "../shortsWords";

export const SHORT_AUDIO_DELAY = 8; // la voz arranca casi de una — hook inmediato

/** Agrupa palabras en tarjetas de máx 3 palabras (o corte por pausa >14f). */
const groupWords = (words: Word[]): Word[][] => {
  const groups: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (cur.length >= 3 || (prev && w.from - prev.to > 14)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  return groups;
};

/** Captions estilo TikTok: palabra por palabra, pop + keyword en color. */
export const WordCaps: React.FC<{
  scene: keyof typeof WORDS;
  keywords: string[];
  y?: number;
  size?: number;
  color?: string;
  keyColor?: string;
  hideBefore?: number; // no dupliques el hook: oculta captions antes de este frame
}> = ({
  scene,
  keywords,
  y = 1180,
  size = 78,
  color = "#FFFFFF",
  keyColor = C.eleia,
  hideBefore = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame - SHORT_AUDIO_DELAY;
  const groups = React.useMemo(() => groupWords(WORDS[scene]), [scene]);
  const keys = React.useMemo(() => new Set(keywords.map((k) => k.toLowerCase())), [keywords]);
  if (frame < hideBefore) return null;

  const g = groups.find(
    (grp, i) =>
      t >= grp[0].from &&
      t < (i + 1 < groups.length ? groups[i + 1][0].from : grp[grp.length - 1].to + 20),
  );
  if (!g) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: y,
        left: 40,
        right: 40,
        display: "flex",
        justifyContent: "center",
        flexWrap: "wrap",
        gap: "0 22px",
        pointerEvents: "none",
        zIndex: 40,
      }}
    >
      {g.map((w) => {
        const s = spring({ frame: t - w.from, fps, config: { damping: 11, mass: 0.4 } });
        const isKey = keys.has(w.w.toLowerCase());
        if (t < w.from) return null;
        return (
          <span
            key={`${w.w}-${w.from}`}
            style={{
              fontFamily: F.title,
              fontWeight: 700,
              fontSize: isKey ? size * 1.12 : size,
              textTransform: "uppercase",
              letterSpacing: 1,
              color: isKey ? keyColor : color,
              transform: `scale(${0.5 + s * 0.5}) rotate(${(1 - s) * -4}deg)`,
              textShadow:
                "0 3px 0 rgba(0,0,0,0.85), 0 0 26px rgba(0,0,0,0.6), 3px 3px 8px rgba(0,0,0,0.9)",
              lineHeight: 1.25,
              display: "inline-block",
            }}
          >
            {w.w}
          </span>
        );
      })}
    </div>
  );
};

/** Punch-in de cámara: zoom con decaimiento en cada beat. */
export const Punch: React.FC<{
  beats: number[];
  amount?: number;
  children: React.ReactNode;
}> = ({ beats, amount = 0.09, children }) => {
  const frame = useCurrentFrame();
  let s = 1;
  for (const b of beats) {
    if (frame >= b) s += amount * Math.exp(-(frame - b) / 6);
  }
  return (
    <AbsoluteFill style={{ transform: `scale(${s})`, transformOrigin: "50% 46%" }}>
      {children}
    </AbsoluteFill>
  );
};

/** Flash de color a pantalla completa en beats. */
export const Flash: React.FC<{ beats: number[]; color?: string; peak?: number }> = ({
  beats,
  color = C.eleia,
  peak = 0.7,
}) => {
  const frame = useCurrentFrame();
  let o = 0;
  for (const b of beats) {
    if (frame >= b) o = Math.max(o, peak * Math.exp(-(frame - b) / 3.5));
  }
  if (o < 0.01) return null;
  return <AbsoluteFill style={{ background: color, opacity: o, zIndex: 60 }} />;
};

/** Número que RUEDA rápido (con jitter mientras rueda). */
export const useRoll = (f0: number, f1: number, target: number): number => {
  const frame = useCurrentFrame();
  const v = interpolate(frame, [f0, f1], [0, target], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  if (frame >= f0 && frame < f1) {
    // jitter pseudo-aleatorio determinista mientras rueda
    const j = Math.sin(frame * 13.7) * 0.5 + 0.5;
    return v + j * Math.max(1, target * 0.02);
  }
  return v;
};

/** Texto gigante de hook/beat, uppercase condensed con sombra dura. */
export const BigText: React.FC<{
  at?: number;
  children: React.ReactNode;
  size?: number;
  color?: string;
  style?: React.CSSProperties;
  shake?: boolean;
}> = ({ at = 0, children, size = 110, color = "#fff", style, shake = false }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - at, fps, config: { damping: 10, mass: 0.5 } });
  if (frame < at) return null;
  const sh = shake ? Math.sin(frame * 2.2) * 3 : 0;
  return (
    <div
      style={{
        fontFamily: F.title,
        fontWeight: 700,
        fontSize: size,
        textTransform: "uppercase",
        textAlign: "center",
        color,
        lineHeight: 1.08,
        letterSpacing: 1,
        transform: `scale(${0.6 + s * 0.4}) rotate(${sh * 0.15}deg) translateX(${sh}px)`,
        textShadow: "0 5px 0 rgba(0,0,0,0.8), 4px 6px 14px rgba(0,0,0,0.85)",
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/** Cierre loop-friendly: lockup corto + CTA. */
export const EndCard: React.FC<{ at: number; cta?: string }> = ({ at, cta = "Escríbenos 🐷" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - at, fps, config: { damping: 12, mass: 0.6 } });
  const s2 = spring({ frame: frame - at - 8, fps, config: { damping: 9, mass: 0.5 } });
  if (frame < at) return null;
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse at 50% 42%, ${C.darkCard} 0%, ${C.darkBg} 75%)`,
        justifyContent: "center",
        alignItems: "center",
        zIndex: 50,
        opacity: interpolate(frame, [at, at + 8], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        }),
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 26,
          transform: `scale(${0.85 + s * 0.15})`,
          marginTop: -80,
        }}
      >
        <div style={{ fontSize: 150, lineHeight: 1 }}>🐷</div>
        <div
          style={{
            fontFamily: F.title,
            fontWeight: 700,
            fontSize: 108,
            color: "#fff",
            letterSpacing: 2,
          }}
        >
          PORCI<span style={{ color: C.verde }}>PESO</span>
        </div>
        <div
          style={{
            transform: `scale(${0.6 + s2 * 0.4})`,
            background: C.verde,
            color: "#fff",
            fontFamily: F.body,
            fontWeight: 800,
            fontSize: 54,
            padding: "24px 66px",
            borderRadius: 999,
            boxShadow: "0 0 70px rgba(23,138,80,0.6)",
          }}
        >
          {cta}
        </div>
        <div
          style={{
            fontFamily: F.body,
            fontSize: 34,
            fontWeight: 600,
            color: C.darkMuted,
            marginTop: 8,
          }}
        >
          una solución <span style={{ color: C.eleia, fontWeight: 800 }}>ELEIA</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
