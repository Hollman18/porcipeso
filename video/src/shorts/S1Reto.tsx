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
import { FotoBg } from "../components/Common";
import {
  BigText,
  EndCard,
  Flash,
  Punch,
  SHORT_AUDIO_DELAY,
  WordCaps,
  useRoll,
} from "./ShortCommon";

/** Número adivinanza que aparece y se descarta con ✗ rojo. */
const Guess: React.FC<{ at: number; kill: number; label: string }> = ({ at, kill, label }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - at, fps, config: { damping: 10, mass: 0.5 } });
  if (frame < at) return null;
  const dead = frame >= kill;
  return (
    <div style={{ position: "relative", transform: `scale(${0.5 + s * 0.5})` }}>
      <div
        style={{
          fontFamily: F.title,
          fontWeight: 700,
          fontSize: 150,
          color: dead ? "rgba(255,255,255,0.28)" : "#fff",
          textShadow: "0 5px 0 rgba(0,0,0,0.8)",
          lineHeight: 1,
        }}
      >
        {label}
      </div>
      {dead && (
        <div
          style={{
            position: "absolute",
            inset: -20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 170,
            color: C.led,
            fontWeight: 900,
            transform: `rotate(-12deg) scale(${
              0.5 +
              spring({ frame: frame - kill, fps, config: { damping: 9, mass: 0.4 } }) * 0.5
            })`,
            textShadow: "0 0 30px rgba(255,74,46,0.8)",
          }}
        >
          ✗
        </div>
      )}
    </div>
  );
};

/** SHORT 1 — "EL RETO": ¿cuántos cerdos hay en esta báscula? */
export const S1Reto: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const kg = useRoll(4, 180, 2847);
  const reveal = frame >= 180;
  const ring = spring({ frame: frame - 180, fps, config: { damping: 14, mass: 0.8 } });

  return (
    <AbsoluteFill
      style={{
        background: C.darkBg,
      }}
    >
      <FotoBg src="fotos/tres-cerdos.jpg" dur={400} overlay={0.66} zoomFrom={1.1} zoomTo={1.24} panY={-20} />
      <Punch beats={[71, 89, 117, 180, 212]}>
        {/* HOOK — visible desde el frame 0 */}
        <div style={{ position: "absolute", top: 320, width: "100%" }}>
          <BigText size={118} shake={!reveal}>
            ¿Cuántos <span style={{ color: C.eleia }}>cerdos</span> hay? 🤔
          </BigText>
        </div>

        {/* LED rodando como loco */}
        <div
          style={{
            position: "absolute",
            top: 590,
            width: "100%",
            display: "flex",
            justifyContent: "center",
          }}
        >
          <LedBox
            value={kg.toFixed(reveal ? 0 : 0)}
            unit="kg"
            fontSize={150}
            pad={30}
            glow={reveal ? 1.2 : 0.9}
          />
        </div>

        {/* adivinanzas descartadas / reveal */}
        {!reveal ? (
          <div
            style={{
              position: "absolute",
              top: 880,
              width: "100%",
              display: "flex",
              justifyContent: "center",
              gap: 70,
            }}
          >
            <Guess at={71} kill={89} label="¿20?" />
            <Guess at={89} kill={117} label="¿25?" />
            <Guess at={117} kill={160} label="¿30?" />
          </div>
        ) : (
          <div
            style={{
              position: "absolute",
              top: 830,
              width: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
            }}
          >
            {/* anillo de explosión */}
            <div
              style={{
                position: "absolute",
                top: -30,
                width: 460,
                height: 460,
                borderRadius: "50%",
                border: `6px solid ${C.eleia}`,
                transform: `scale(${ring * 1.6})`,
                opacity: Math.max(0, 1 - ring * 1.1),
              }}
            />
            <div
              style={{
                fontFamily: F.title,
                fontWeight: 700,
                fontSize: 250,
                lineHeight: 1,
                color: C.eleia,
                textShadow: "0 0 60px rgba(118,184,42,0.6), 0 6px 0 rgba(0,0,0,0.8)",
                transform: `scale(${0.5 + ring * 0.5})`,
              }}
            >
              27 ✓
            </div>
            <div
              style={{
                fontFamily: F.body,
                fontWeight: 700,
                fontSize: 44,
                color: "#fff",
                textShadow: "0 3px 8px rgba(0,0,0,0.8)",
              }}
            >
              El sistema YA lo sabe
            </div>
          </div>
        )}
      </Punch>

      <Flash beats={[180]} color={C.eleia} peak={0.75} />
      <Flash beats={[71, 89, 117]} color={C.led} peak={0.22} />

      <WordCaps
        scene="s1"
        keywords={["cerdos", "báscula", "veintisiete", "PorciPeso", "serial", "Escríbenos"]}
        y={1210}
        hideBefore={55}
      />

      <EndCard at={334} />

      <Sequence from={SHORT_AUDIO_DELAY}>
        <Audio src={staticFile("audio/s1.mp3")} />
      </Sequence>
    </AbsoluteFill>
  );
};
