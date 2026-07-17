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
import { PhoneFrame } from "../components/Devices";
import { BigText, EndCard, Flash, Punch, SHORT_AUDIO_DELAY, WordCaps, useRoll } from "./ShortCommon";

const Stat: React.FC<{ label: string; value: string; big?: boolean }> = ({
  label,
  value,
  big = false,
}) => (
  <div
    style={{
      background: C.darkCard,
      border: `2px solid ${C.panelEdge}`,
      borderRadius: 16,
      padding: big ? "22px 20px" : "16px 20px",
      textAlign: "center",
    }}
  >
    <div
      style={{
        fontSize: 20,
        letterSpacing: 2,
        color: C.darkMuted,
        fontWeight: 700,
        textTransform: "uppercase",
      }}
    >
      {label}
    </div>
    <div
      style={{
        fontFamily: F.mono,
        fontVariantNumeric: "tabular-nums",
        fontSize: big ? 62 : 44,
        fontWeight: 700,
        color: big ? C.eleia : "#fff",
        marginTop: 4,
      }}
    >
      {value}
    </div>
  </div>
);

/** SHORT 4 — "DESDE DONDE SEA": la nube en tu bolsillo. */
export const S4Hamaca: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const kgHoy = useRoll(174, 250, 12845);
  const cerdos = useRoll(174, 250, 214);
  const hookOut = interpolate(frame, [50, 64], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const cloudS = spring({ frame: frame - 286, fps, config: { damping: 12, mass: 0.7 } });
  const palmSway = Math.sin(frame / 11) * 4;

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(180deg, #0E1A12 0%, ${C.darkBg} 55%, ${C.darkCard} 100%)`,
      }}
    >
      {/* palmera decorativa que se mece */}
      <div
        style={{
          position: "absolute",
          top: 120,
          right: -30,
          fontSize: 210,
          transform: `rotate(${8 + palmSway}deg)`,
          opacity: 0.9,
        }}
      >
        🌴
      </div>

      <Punch beats={[66, 174, 286, 339]}>
        {/* HOOK */}
        <div style={{ position: "absolute", top: 320, width: "100%", opacity: hookOut }}>
          <BigText size={122} shake>
            Míralo desde
            <br />
            tu <span style={{ color: C.eleia }}>hamaca</span> 🌴
          </BigText>
        </div>

        {/* celular con dashboard EN VIVO */}
        {frame >= 20 && (
          <div
            style={{
              position: "absolute",
              top: 330,
              width: "100%",
              display: "flex",
              justifyContent: "center",
              transform: `translateY(${
                interpolate(frame, [20, 66], [1250, 0], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                })
              }px)`,
            }}
          >
            <PhoneFrame width={470} height={830} style={{ borderRadius: 50 }}>
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  background: "#0E1310",
                  padding: "46px 22px 20px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 16,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    fontFamily: F.title,
                    fontWeight: 700,
                    fontSize: 30,
                    color: "#fff",
                  }}
                >
                  🐷 PorciPeso
                  <span
                    style={{
                      marginLeft: "auto",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontFamily: F.body,
                      fontSize: 22,
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
                        opacity: frame % 26 < 16 ? 1 : 0.25,
                      }}
                    />
                    EN VIVO
                  </span>
                </div>
                <Stat label="Granjas conectadas" value="3" />
                <Stat label="Kg pesados hoy" value={`${Math.round(kgHoy).toLocaleString("es-CO")}`} big />
                <Stat label="Cerdos hoy" value={`${Math.round(cerdos)}`} />
                {/* barras subiendo */}
                <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexGrow: 1, padding: "6px 8px 4px" }}>
                  {[0.45, 0.7, 0.55, 0.85, 0.65, 1].map((h, i) => {
                    const grow = interpolate(frame, [190 + i * 8, 226 + i * 8], [0, h], {
                      extrapolateLeft: "clamp",
                      extrapolateRight: "clamp",
                    });
                    return (
                      <div
                        key={i}
                        style={{
                          flexGrow: 1,
                          height: `${grow * 100}%`,
                          background: i === 5 ? C.eleia : C.verde,
                          borderRadius: 8,
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            </PhoneFrame>
          </div>
        )}

        {/* nube */}
        {frame >= 286 && (
          <div
            style={{
              position: "absolute",
              top: 236,
              width: "100%",
              textAlign: "center",
              transform: `scale(${0.5 + cloudS * 0.5})`,
            }}
          >
            <span
              style={{
                fontSize: 150,
                filter: "drop-shadow(0 0 40px rgba(118,184,42,0.55))",
              }}
            >
              ☁️
            </span>
          </div>
        )}
      </Punch>

      <Flash beats={[66, 286]} color={C.eleia} peak={0.5} />

      <WordCaps
        scene="s4"
        keywords={["hamaca", "granjas", "real", "bolsillo", "nube", "PorciPeso", "ELEIA", "Escríbenos"]}
        y={1250}
        size={72}
        hideBefore={48}
      />

      <EndCard at={399} />

      <Sequence from={SHORT_AUDIO_DELAY}>
        <Audio src={staticFile("audio/s4.mp3")} />
      </Sequence>
    </AbsoluteFill>
  );
};
