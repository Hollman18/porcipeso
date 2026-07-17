import React from "react";
import { AbsoluteFill } from "remotion";
import { C, F } from "../theme";
import { Pop, SceneTitle, Subtitles } from "../components/Common";

const PainCard: React.FC<{
  at: number;
  icon: string;
  title: string;
  sub: string;
  tilt: number;
  accent: string;
}> = ({ at, icon, title, sub, tilt, accent }) => (
  <Pop at={at} fromY={60}>
    <div
      style={{
        width: 430,
        background: C.card,
        border: `1px solid ${C.border}`,
        borderTop: `10px solid ${accent}`,
        borderRadius: 20,
        padding: "48px 36px 42px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 18,
        transform: `rotate(${tilt}deg)`,
        boxShadow: "0 24px 50px rgba(27,35,31,0.14)",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 96, lineHeight: 1 }}>{icon}</div>
      <div style={{ fontFamily: F.title, fontWeight: 700, fontSize: 42, color: C.ink }}>
        {title}
      </div>
      <div style={{ fontFamily: F.body, fontSize: 26, color: C.muted, lineHeight: 1.35 }}>
        {sub}
      </div>
    </div>
  </Pop>
);

/** E2 — EL PROBLEMA: indicadores importados costosos, lentos y amarrados. */
export const E2Problema: React.FC = () => (
  <AbsoluteFill style={{ background: C.hueso, justifyContent: "center", alignItems: "center" }}>
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 64,
        marginTop: -40,
      }}
    >
      <SceneTitle at={8} size={64}>
        El pesaje &ldquo;inteligente&rdquo; tradicional…
      </SceneTitle>
      <div style={{ display: "flex", gap: 44, alignItems: "center" }}>
        <PainCard
          at={30}
          icon="💸"
          title="Indicador importado"
          sub="Hardware especializado que cuesta una fortuna"
          tilt={-2}
          accent={C.red}
        />
        <PainCard
          at={150}
          icon="⏳"
          title="Meses de espera"
          sub="Importación, aduana, instalación…"
          tilt={1.4}
          accent={C.amber}
        />
        <PainCard
          at={208}
          icon="🔒"
          title="Atado a una marca"
          sub="Solo funciona con SU báscula"
          tilt={-1.2}
          accent={C.red}
        />
      </div>
    </div>
    <Subtitles scene="e2" />
  </AbsoluteFill>
);
