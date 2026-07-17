import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, F } from "../theme";
import { Indicator, MonitorFrame, PhoneFrame } from "../components/Devices";
import { Chip, Fade, Pop, Subtitles, useCount } from "../components/Common";

const MARCAS = [
  "Yaohua", "Trumax", "Cardinal", "Mettler Toledo", "A&D",
  "Ohaus", "Rinstrum", "Torrey", "CAS", "Dini Argeo",
  "Keli", "Sartorius", "Avery W-T", "Radwag", "Baykon",
  "Flintec", "Zemic", "Utilcell", "Precia Molen", "GSE",
  "Lexus", "Gama", "Excell", "Prometálico", "+ las que vengan",
];

/** Fase A: cable RS-232 animado del indicador al computador/celular. */
const CablePhase: React.FC = () => {
  const frame = useCurrentFrame();
  const draw = interpolate(frame, [40, 104], [1200, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const pulse = (offset: number) =>
    interpolate((frame - 108 + offset) % 60, [0, 60], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  const fadeOut = interpolate(frame, [218, 236], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const path = "M 470 560 C 660 710, 950 660, 1085 480";
  return (
    <AbsoluteFill style={{ opacity: fadeOut, transform: `translateY(${(1 - fadeOut) * -50}px)` }}>
      <Pop at={4} fromY={20} style={{ position: "absolute", top: 72, width: "100%" }}>
        <div
          style={{
            fontFamily: F.title,
            fontWeight: 700,
            fontSize: 66,
            color: C.ink,
            textAlign: "center",
          }}
        >
          PorciPeso es <span style={{ color: C.verde }}>software</span>
        </div>
        <div
          style={{
            fontFamily: F.body,
            fontSize: 30,
            color: C.muted,
            textAlign: "center",
            marginTop: 10,
          }}
        >
          Se conecta a CUALQUIER indicador con puerto serial
        </div>
      </Pop>

      {/* indicador genérico a la izquierda */}
      <Pop at={14} style={{ position: "absolute", left: 170, top: 300 }}>
        <div
          style={{
            fontFamily: F.body,
            fontWeight: 700,
            fontSize: 24,
            color: C.muted,
            letterSpacing: 1,
            textAlign: "center",
            marginBottom: 12,
          }}
        >
          CUALQUIER INDICADOR
        </div>
        <Indicator value="88.8" />
      </Pop>

      {/* computador + celular a la derecha */}
      <Pop at={26} style={{ position: "absolute", right: 150, top: 330 }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 26 }}>
          <MonitorFrame screenW={480} screenH={300}>
            <div
              style={{
                width: "100%",
                height: "100%",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
            >
              <div style={{ fontSize: 64 }}>🐷</div>
              <div
                style={{ fontFamily: F.title, fontWeight: 700, fontSize: 38, color: C.ink }}
              >
                PORCI<span style={{ color: C.verde }}>PESO</span>
              </div>
            </div>
          </MonitorFrame>
          <PhoneFrame width={150} height={300} style={{ borderRadius: 26, padding: 6 }}>
            <div
              style={{
                width: "100%",
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 52,
              }}
            >
              🐷
            </div>
          </PhoneFrame>
        </div>
      </Pop>

      {/* cable serial */}
      <svg
        width={1920}
        height={1080}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      >
        <path
          d={path}
          stroke={C.panel}
          strokeWidth={13}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={1200}
          strokeDashoffset={draw}
        />
        {/* conectores DB9 */}
        <g opacity={interpolate(frame, [40, 52], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}>
          <rect x={438} y={538} width={56} height={40} rx={8} fill={C.panelEdge} stroke={C.panel} strokeWidth={3} />
          <rect x={1058} y={458} width={56} height={40} rx={8} fill={C.panelEdge} stroke={C.panel} strokeWidth={3} />
        </g>
        {/* pulsos de datos viajando por el cable */}
        {frame > 110 &&
          [0, 20, 40].map((o) => {
            const t = pulse(o);
            const x = 470 + t * 615;
            const y = (1 - t) * 560 + t * 480 + Math.sin(t * Math.PI) * 110;
            return <circle key={o} cx={x} cy={y} r={9} fill={C.verde} opacity={0.9} />;
          })}
      </svg>

      {/* etiqueta del cable */}
      <Fade at={106} style={{ position: "absolute", top: 700, width: "100%", textAlign: "center" }}>
        <Chip>🔌 RS-232 · puerto serial · Conectado ✓</Chip>
      </Fade>
    </AbsoluteFill>
  );
};

/** Fase B: lluvia de marcas integradas. */
const BrandsPhase: React.FC = () => {
  const frame = useCurrentFrame();
  const n = useCount(236, 290, 0, 25);
  const inOp = interpolate(frame, [230, 244], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  if (frame < 228) return null;
  return (
    <AbsoluteFill style={{ opacity: inOp, alignItems: "center" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 24, marginTop: 66 }}>
        <span
          style={{
            fontFamily: F.title,
            fontWeight: 700,
            fontSize: 150,
            color: C.verde,
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1,
          }}
        >
          {Math.round(n)}
        </span>
        <span style={{ fontFamily: F.title, fontWeight: 700, fontSize: 62, color: C.ink }}>
          marcas ya integradas
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, auto)",
          gap: "20px 22px",
          marginTop: 54,
          justifyContent: "center",
        }}
      >
        {MARCAS.map((m, i) => (
          <Pop key={m} at={244 + i * 4} fromY={-70}>
            <div
              style={{
                background: i === MARCAS.length - 1 ? C.verdeSoft : C.card,
                border: `2px solid ${i === MARCAS.length - 1 ? C.verde : C.border}`,
                borderRadius: 999,
                padding: "12px 30px",
                fontFamily: F.body,
                fontWeight: 700,
                fontSize: 27,
                color: i === MARCAS.length - 1 ? C.verdeInk : C.ink,
                boxShadow: "0 8px 18px rgba(27,35,31,0.10)",
                whiteSpace: "nowrap",
              }}
            >
              {m}
            </div>
          </Pop>
        ))}
      </div>

      <Fade at={305} style={{ marginTop: 48, textAlign: "center" }}>
        <div style={{ fontFamily: F.body, fontSize: 34, fontWeight: 600, color: C.muted }}>
          Usa la báscula que <b style={{ color: C.verdeInk }}>ya tienes</b> — sin esperar
          importaciones
        </div>
      </Fade>
      <div style={{ display: "flex", gap: 26, marginTop: 30 }}>
        <Pop at={421}>
          <Chip size={30}>💰 Más barato</Chip>
        </Pop>
        <Pop at={452}>
          <Chip size={30}>📈 Crece contigo</Chip>
        </Pop>
      </div>
    </AbsoluteFill>
  );
};

/** E3 — LA SOLUCIÓN: software + cualquier indicador serial + 25 marcas. */
export const E3Solucion: React.FC = () => (
  <AbsoluteFill style={{ background: C.hueso }}>
    <CablePhase />
    <BrandsPhase />
    <Subtitles scene="e3" />
  </AbsoluteFill>
);
