import React from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { C, F } from "../theme";
import { LedBox } from "../components/Devices";
import { BigText, EndCard, Flash, Punch, SHORT_AUDIO_DELAY, WordCaps, useRoll } from "./ShortCommon";

const MARCAS = [
  "Yaohua", "Trumax", "Cardinal", "Mettler", "A&D", "Ohaus",
  "Rinstrum", "Torrey", "CAS", "Dini Argeo", "Keli", "Sartorius",
  "Avery", "Radwag", "Baykon", "Flintec", "Zemic", "Utilcell",
  "Precia", "GSE", "Lexus", "Gama", "Excell", "+ más",
];

/** Conector DB9 (RS-232) gigante, vectorial. */
const DB9: React.FC<{ at: number }> = ({ at }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - at, fps, config: { damping: 12, mass: 0.7 } });
  const zoom = 1 + interpolate(frame, [at, at + 120], [0, 0.14], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  if (frame < at) return null;
  return (
    <svg
      width={760}
      height={420}
      viewBox="0 0 760 420"
      style={{ transform: `scale(${(0.6 + s * 0.4) * zoom})` }}
    >
      {/* carcasa exterior */}
      <rect x={30} y={60} width={700} height={300} rx={40} fill="#38403A" stroke="#1E2420" strokeWidth={8} />
      {/* tornillos */}
      <circle cx={90} cy={210} r={34} fill="#252B26" stroke="#141814" strokeWidth={6} />
      <circle cx={670} cy={210} r={34} fill="#252B26" stroke="#141814" strokeWidth={6} />
      {/* trapecio DB9 */}
      <path
        d="M 200 120 L 560 120 Q 585 120 578 145 L 545 275 Q 538 300 512 300 L 248 300 Q 222 300 215 275 L 182 145 Q 175 120 200 120 Z"
        fill="#B9C2BB"
        stroke="#5A655C"
        strokeWidth={8}
      />
      {/* 9 pines: 5 arriba, 4 abajo */}
      {[0, 1, 2, 3, 4].map((i) => (
        <circle key={`t${i}`} cx={250 + i * 65} cy={175} r={17} fill="#232823" />
      ))}
      {[0, 1, 2, 3].map((i) => (
        <circle key={`b${i}`} cx={283 + i * 65} cy={245} r={17} fill="#232823" />
      ))}
    </svg>
  );
};

const Stamp: React.FC<{ at: number; tilt: number; children: React.ReactNode }> = ({
  at,
  tilt,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - at, fps, config: { damping: 9, mass: 0.5 } });
  if (frame < at) return null;
  return (
    <div
      style={{
        border: `7px solid ${C.led}`,
        color: C.led,
        borderRadius: 18,
        padding: "16px 36px",
        fontFamily: F.title,
        fontWeight: 700,
        fontSize: 66,
        textTransform: "uppercase",
        letterSpacing: 2,
        transform: `rotate(${tilt}deg) scale(${2.2 - s * 1.2})`,
        opacity: Math.min(1, s * 1.5),
        textShadow: "0 0 26px rgba(255,74,46,0.5)",
        background: "rgba(10,14,11,0.55)",
      }}
    >
      {children}
    </div>
  );
};

/** SHORT 3 — "NO COMPRES BÁSCULA NUEVA". */
export const S3NoCompres: React.FC = () => {
  const frame = useCurrentFrame();
  const n = useRoll(216, 268, 25);
  const phase = frame < 64 ? 0 : frame < 205 ? 1 : frame < 312 ? 2 : 3;

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse at 50% 35%, ${C.darkCard} 0%, ${C.darkBg} 72%)`,
      }}
    >
      <Punch beats={[68, 129, 208, 261, 316, 406, 457]}>
        {/* HOOK — frame 0 */}
        {phase <= 1 && (
          <div style={{ position: "absolute", top: 300, width: "100%" }}>
            {phase === 0 ? (
              <BigText size={128} shake>
                🛑 NO compres
                <br />
                <span style={{ color: C.led }}>báscula nueva</span>
              </BigText>
            ) : (
              <BigText at={68} size={100}>
                ¿Tu indicador tiene
                <br />
                <span style={{ color: C.eleia }}>ESTE puerto?</span>
              </BigText>
            )}
          </div>
        )}

        {/* DB9 gigante */}
        {phase === 1 && (
          <div
            style={{
              position: "absolute",
              top: 660,
              width: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 20,
            }}
          >
            <DB9 at={72} />
            {frame >= 133 && (
              <BigText at={133} size={130} color={C.eleia}>
                ✓
              </BigText>
            )}
          </div>
        )}

        {/* lluvia de marcas + contador */}
        {phase === 2 && (
          <>
            <div
              style={{
                position: "absolute",
                top: 330,
                width: "100%",
                display: "flex",
                justifyContent: "center",
                alignItems: "baseline",
                gap: 22,
              }}
            >
              <span
                style={{
                  fontFamily: F.title,
                  fontWeight: 700,
                  fontSize: 210,
                  color: C.eleia,
                  lineHeight: 1,
                  fontVariantNumeric: "tabular-nums",
                  textShadow: "0 0 50px rgba(118,184,42,0.5), 0 6px 0 rgba(0,0,0,0.8)",
                }}
              >
                {Math.round(n)}
              </span>
              <span
                style={{
                  fontFamily: F.title,
                  fontWeight: 700,
                  fontSize: 74,
                  color: "#fff",
                  textShadow: "0 4px 0 rgba(0,0,0,0.8)",
                }}
              >
                marcas
              </span>
            </div>
            <div
              style={{
                position: "absolute",
                top: 590,
                left: 60,
                right: 60,
                display: "flex",
                flexWrap: "wrap",
                justifyContent: "center",
                gap: 16,
              }}
            >
              {MARCAS.map((m, i) => {
                const at = 212 + i * 3;
                const grow = interpolate(frame, [at, at + 7], [0.3, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                });
                const op = interpolate(frame, [at, at + 5], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                });
                return (
                  <span
                    key={m}
                    style={{
                      background: i === MARCAS.length - 1 ? C.eleia : "rgba(255,255,255,0.94)",
                      color: C.ink,
                      borderRadius: 999,
                      padding: "12px 26px",
                      fontFamily: F.body,
                      fontWeight: 800,
                      fontSize: 32,
                      transform: `scale(${grow})`,
                      opacity: op,
                      boxShadow: "0 8px 20px rgba(0,0,0,0.4)",
                    }}
                  >
                    {m}
                  </span>
                );
              })}
            </div>
          </>
        )}

        {/* convierte la que YA tienes */}
        {phase === 3 && (
          <>
            <div style={{ position: "absolute", top: 320, width: "100%" }}>
              <BigText at={316} size={92}>
                Convierte la báscula
                <br />
                que <span style={{ color: C.eleia }}>YA tienes</span>
              </BigText>
            </div>
            <div
              style={{
                position: "absolute",
                top: 640,
                width: "100%",
                display: "flex",
                justifyContent: "center",
              }}
            >
              <LedBox value="104.1" unit="kg" fontSize={120} pad={26} />
            </div>
            <div
              style={{
                position: "absolute",
                top: 900,
                width: "100%",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 26,
              }}
            >
              <Stamp at={406} tilt={-5}>
                Sin importaciones
              </Stamp>
              <Stamp at={457} tilt={3}>
                Sin esperas
              </Stamp>
            </div>
          </>
        )}
      </Punch>

      <Flash beats={[68]} color={C.led} peak={0.3} />
      <Flash beats={[129, 208]} color={C.eleia} peak={0.55} />

      <WordCaps
        scene="s3"
        keywords={[
          "compres", "nueva", "puerto", "inteligente", "Veinticinco", "marcas",
          "PorciPeso", "convierte", "tienes", "importaciones", "esperas", "Escríbenos",
        ]}
        y={1250}
        size={70}
        hideBefore={45}
      />

      <EndCard at={500} />

      <Sequence from={SHORT_AUDIO_DELAY}>
        <Audio src={staticFile("audio/s3.mp3")} />
      </Sequence>
    </AbsoluteFill>
  );
};
