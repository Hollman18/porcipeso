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
import { BigText, EndCard, Flash, Punch, SHORT_AUDIO_DELAY, WordCaps } from "./ShortCommon";

const PainCard: React.FC<{ at: number; tilt: number; children: React.ReactNode }> = ({
  at,
  tilt,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - at, fps, config: { damping: 10, mass: 0.5 } });
  if (frame < at) return null;
  return (
    <div
      style={{
        background: "#FFF9E8",
        border: `4px solid ${C.red}`,
        borderRadius: 22,
        padding: "34px 40px",
        transform: `rotate(${tilt}deg) scale(${0.5 + s * 0.5})`,
        boxShadow: "0 24px 50px rgba(0,0,0,0.25)",
        fontFamily: F.body,
        fontWeight: 700,
        fontSize: 52,
        color: C.ink,
        textAlign: "center",
        lineHeight: 1.25,
      }}
    >
      {children}
    </div>
  );
};

const FeedCard: React.FC<{ at: number; good?: boolean; children: React.ReactNode }> = ({
  at,
  good = true,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - at, fps, config: { damping: 11, mass: 0.5 } });
  if (frame < at) return null;
  return (
    <div
      style={{
        background: good ? C.verdeSoft : C.amberSoft,
        border: `3px solid ${good ? C.verde : C.amber}`,
        color: good ? C.verdeInk : C.amber,
        borderRadius: 16,
        padding: "20px 24px",
        fontFamily: F.body,
        fontWeight: 800,
        fontSize: 34,
        transform: `translateY(${(1 - s) * 40}px) scale(${0.7 + s * 0.3})`,
        opacity: Math.min(1, s * 1.4),
      }}
    >
      {children}
    </div>
  );
};

/** SHORT 2 — "DEJA DE CONTAR A MANO". */
export const S2Mano: React.FC = () => {
  const frame = useCurrentFrame();
  const toPhone = interpolate(frame, [198, 212], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ background: C.hueso }}>
      {/* fondo oscuro entra con la fase del celular */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at 50% 40%, ${C.darkCard} 0%, ${C.darkBg} 75%)`,
          opacity: toPhone,
        }}
      />

      <Punch beats={[74, 141, 202, 265, 293, 351, 390]}>
        {/* HOOK */}
        <div style={{ position: "absolute", top: 300, width: "100%", opacity: 1 - toPhone }}>
          <BigText size={124} color={C.ink} shake style={{ textShadow: "0 4px 0 rgba(0,0,0,0.15)" }}>
            Deja de contar <span style={{ color: C.red }}>a mano</span> ✋
          </BigText>
        </div>

        {/* dolor: papelitos */}
        {frame < 200 && (
          <div
            style={{
              position: "absolute",
              top: 720,
              width: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 44,
            }}
          >
            <PainCard at={74} tilt={-3}>
              📝 ¿Eran <s>26</s>… <s>27</s>… <span style={{ color: C.red }}>28?</span>
            </PainCard>
            <PainCard at={141} tilt={2.5}>
              🐷💨 Se te bajó UNO…
              <br />y nadie lo vio
            </PainCard>
          </div>
        )}

        {/* alivio: el celular cuenta solo */}
        {frame >= 200 && (
          <>
            <div style={{ position: "absolute", top: 300, width: "100%" }}>
              <BigText at={202} size={92}>
                El celular cuenta <span style={{ color: C.eleia }}>solo</span>
              </BigText>
            </div>
            <div
              style={{
                position: "absolute",
                top: 470,
                width: "100%",
                display: "flex",
                justifyContent: "center",
              }}
            >
              <PhoneFrame width={470} height={710} style={{ borderRadius: 48 }}>
                <div
                  style={{
                    width: "100%",
                    height: "100%",
                    background: C.hueso,
                    padding: "44px 22px 20px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 18,
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
                      color: C.ink,
                    }}
                  >
                    🐷 PorciPeso
                    <span
                      style={{
                        marginLeft: "auto",
                        fontFamily: F.mono,
                        fontSize: 26,
                        color: C.verdeInk,
                        fontWeight: 700,
                      }}
                    >
                      {frame < 265 ? 2 : frame < 317 ? 5 : 4} 🐷
                    </span>
                  </div>
                  <FeedCard at={265} good>
                    ✓ Subieron 3 — van 5
                  </FeedCard>
                  <FeedCard at={293} good={false}>
                    ↩ Uno se bajó…
                  </FeedCard>
                  <FeedCard at={317} good>
                    ✓ Ya lo desconté — van 4
                  </FeedCard>
                </div>
              </PhoneFrame>
            </div>
          </>
        )}
      </Punch>

      <Flash beats={[141]} color={C.led} peak={0.28} />
      <Flash beats={[202]} color={C.eleia} peak={0.55} />

      <WordCaps
        scene="s2"
        keywords={["mano", "bajó", "celular", "solo", "desconté", "cuenta", "decides", "Escríbenos"]}
        y={1250}
        size={72}
        hideBefore={48}
        keyColor={frame < 198 ? C.red : C.eleia}
        color={frame < 198 ? C.ink : "#fff"}
      />

      <EndCard at={434} />

      <Sequence from={SHORT_AUDIO_DELAY}>
        <Audio src={staticFile("audio/s2.mp3")} />
      </Sequence>
    </AbsoluteFill>
  );
};
