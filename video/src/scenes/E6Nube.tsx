import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { C, F } from "../theme";
import { FotoBg, Fade, Lockup, Pop, Subtitles } from "../components/Common";

const Node: React.FC<{
  at: number;
  icon: string;
  label: string;
  sub?: string;
}> = ({ at, icon, label, sub }) => (
  <Pop at={at} fromY={30}>
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        width: 260,
      }}
    >
      <div
        style={{
          fontSize: 84,
          lineHeight: 1,
          filter: "drop-shadow(0 8px 18px rgba(0,0,0,0.4))",
        }}
      >
        {icon}
      </div>
      <div style={{ fontFamily: F.title, fontWeight: 700, fontSize: 34, color: "#fff" }}>
        {label}
      </div>
      {sub && (
        <div style={{ fontFamily: F.body, fontSize: 21, color: C.darkMuted, fontWeight: 600 }}>
          {sub}
        </div>
      )}
    </div>
  </Pop>
);

/** Línea punteada animada hacia la nube, con pulso de datos. */
const Link: React.FC<{
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  at: number;
  frame: number;
}> = ({ x1, y1, x2, y2, at, frame }) => {
  const o = interpolate(frame, [at, at + 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const t = ((frame - at) % 45) / 45;
  return (
    <g opacity={o}>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={C.eleia}
        strokeWidth={5}
        strokeDasharray="4 14"
        strokeDashoffset={-frame * 1.6}
        strokeLinecap="round"
        opacity={0.65}
      />
      {frame > at + 14 && (
        <circle
          cx={x1 + (x2 - x1) * t}
          cy={y1 + (y2 - y1) * t}
          r={8}
          fill={C.eleia}
          opacity={0.95}
        />
      )}
    </g>
  );
};

/** E6 — NUBE + CIERRE: celular → nube ← computador, granjas en vivo, lockup final. */
export const E6Nube: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const netOut = interpolate(frame, [300, 322], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const cloudPulse = 1 + Math.sin(frame / 9) * 0.03;
  const ctaS = spring({ frame: frame - 378, fps, config: { damping: 12, mass: 0.7 } });

  return (
    <AbsoluteFill
      style={{
        background: C.darkBg,
      }}
    >
      <FotoBg src="fotos/lechones-mama.jpg" dur={470} overlay={0.72} zoomFrom={1.03} zoomTo={1.14} panX={16} />
      {/* ---- fase red: dispositivos + granjas → nube ---- */}
      <AbsoluteFill style={{ opacity: netOut }}>
        <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
          <Link x1={490} y1={430} x2={860} y2={330} at={90} frame={frame} />
          <Link x1={1430} y1={430} x2={1060} y2={330} at={145} frame={frame} />
          <Link x1={560} y1={790} x2={880} y2={380} at={195} frame={frame} />
          <Link x1={960} y1={810} x2={960} y2={400} at={207} frame={frame} />
          <Link x1={1360} y1={790} x2={1040} y2={380} at={219} frame={frame} />
        </svg>

        {/* nube central */}
        <Pop
          at={56}
          style={{ position: "absolute", left: 960 - 130, top: 150, width: 260, textAlign: "center" }}
        >
          <div
            style={{
              fontSize: 190,
              lineHeight: 1,
              transform: `scale(${cloudPulse})`,
              filter: `drop-shadow(0 0 44px rgba(118,184,42,0.45))`,
            }}
          >
            ☁️
          </div>
          <div
            style={{
              fontFamily: F.title,
              fontWeight: 700,
              fontSize: 34,
              color: C.eleia,
              marginTop: -8,
            }}
          >
            LA NUBE
          </div>
        </Pop>

        <div style={{ position: "absolute", left: 360, top: 360 }}>
          <Node at={90} icon="📱" label="El celular" sub="en el corral" />
        </div>
        <div style={{ position: "absolute", left: 1300, top: 360 }}>
          <Node at={145} icon="💻" label="El computador" sub="en la oficina" />
        </div>
        <div style={{ position: "absolute", left: 430, top: 790 }}>
          <Node at={195} icon="🐷" label="Granja La María" />
        </div>
        <div style={{ position: "absolute", left: 830, top: 810 }}>
          <Node at={207} icon="🐷" label="Granja El Roble" />
        </div>
        <div style={{ position: "absolute", left: 1230, top: 790 }}>
          <Node at={219} icon="🐷" label="Granja Santa Ana" />
        </div>

        {/* tarjeta en vivo */}
        <Pop at={258} fromY={24} style={{ position: "absolute", right: 150, top: 130 }}>
          <div
            style={{
              background: "rgba(255,255,255,0.06)",
              border: `2px solid ${C.eleia}`,
              borderRadius: 18,
              padding: "20px 28px",
              fontFamily: F.body,
              color: "#fff",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 20,
                fontWeight: 800,
                color: C.eleia,
                letterSpacing: 2,
              }}
            >
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: "50%",
                  background: C.eleia,
                  opacity: frame % 30 < 18 ? 1 : 0.3,
                }}
              />
              EN VIVO
            </div>
            <div
              style={{
                fontFamily: F.mono,
                fontVariantNumeric: "tabular-nums",
                fontSize: 27,
                fontWeight: 700,
                marginTop: 8,
                lineHeight: 1.5,
              }}
            >
              3 granjas · 214 cerdos hoy
              <br />
              22.240 kg registrados
            </div>
          </div>
        </Pop>
      </AbsoluteFill>

      {/* ---- cierre ---- */}
      {frame > 305 && (
        <Fade at={310} dur={16}>
          <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 30,
                marginTop: -30,
              }}
            >
              <Lockup at={312} dark />
              <Fade at={322}>
                <div
                  style={{
                    fontFamily: F.body,
                    fontSize: 44,
                    fontWeight: 600,
                    color: "#fff",
                  }}
                >
                  una solución{" "}
                  <span style={{ color: C.eleia, fontWeight: 800, letterSpacing: 2 }}>ELEIA</span>
                </div>
              </Fade>
              <div
                style={{
                  transform: `scale(${0.8 + ctaS * 0.2})`,
                  opacity: interpolate(frame, [378, 388], [0, 1], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  }),
                  background: C.verde,
                  color: "#fff",
                  fontFamily: F.body,
                  fontWeight: 800,
                  fontSize: 40,
                  padding: "22px 60px",
                  borderRadius: 999,
                  boxShadow: `0 0 60px rgba(23,138,80,0.5)`,
                  marginTop: 14,
                }}
              >
                Agenda tu demostración
              </div>
            </div>
          </AbsoluteFill>
        </Fade>
      )}

      <Subtitles scene="e6" />
    </AbsoluteFill>
  );
};
