import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, F } from "../theme";
import { Indicator, MonitorFrame, PhoneFrame } from "../components/Devices";
import { Chip, Pop, Subtitles } from "../components/Common";

const Half: React.FC<{
  at: number;
  title: string;
  chipAt: number;
  chip: string;
  children: React.ReactNode;
}> = ({ at, title, chipAt, chip, children }) => (
  <div
    style={{
      flex: 1,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 26,
      paddingTop: 150,
    }}
  >
    <Pop at={at} fromY={18}>
      <div style={{ fontFamily: F.title, fontWeight: 700, fontSize: 50, color: C.ink }}>
        {title}
      </div>
    </Pop>
    <Pop at={at + 12} fromY={40}>
      {children}
    </Pop>
    <Pop at={chipAt}>
      <Chip size={28}>{chip}</Chip>
    </Pop>
  </div>
);

/** E5 — INSTALACIÓN: PC de granja por cable / celular por Bluetooth; sin internet. */
export const E5Instalacion: React.FC = () => {
  const frame = useCurrentFrame();
  const wave = (i: number) =>
    interpolate((frame - 130 + i * 14) % 42, [0, 42], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

  return (
    <AbsoluteFill style={{ background: C.hueso }}>
      <div style={{ display: "flex", height: "100%" }}>
        <Half at={26} title="En el computador de la granja" chipAt={128} chip="🔌 Por cable">
          <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
            <Indicator value="104.1" scale={0.72} />
            {/* cable */}
            <svg width={130} height={80}>
              <path
                d="M 4 40 C 45 70, 85 10, 126 40"
                stroke={C.panel}
                strokeWidth={9}
                fill="none"
                strokeLinecap="round"
                strokeDasharray={220}
                strokeDashoffset={interpolate(frame, [64, 110], [220, 0], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                })}
              />
            </svg>
            <MonitorFrame screenW={420} screenH={270}>
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 4,
                }}
              >
                <div style={{ fontSize: 52 }}>🐷</div>
                <div style={{ fontFamily: F.title, fontWeight: 700, fontSize: 32, color: C.ink }}>
                  PORCI<span style={{ color: C.verde }}>PESO</span>
                </div>
                <div style={{ fontSize: 17, color: C.muted, fontWeight: 600 }}>
                  Windows · Linux
                </div>
              </div>
            </MonitorFrame>
          </div>
        </Half>

        {/* divisor */}
        <div style={{ width: 2, background: C.border, margin: "120px 0 200px" }} />

        <Half at={70} title="…o en tu celular" chipAt={140} chip="📶 Por Bluetooth">
          <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
            <Indicator value="104.1" scale={0.72} />
            {/* ondas bluetooth */}
            <svg width={150} height={120}>
              {[0, 1, 2].map((i) => {
                const t = wave(i);
                return (
                  <path
                    key={i}
                    d={`M ${30 + t * 60} 25 A ${28 + t * 18} ${28 + t * 18} 0 0 1 ${
                      30 + t * 60
                    } 95`}
                    stroke="#2E6FD6"
                    strokeWidth={7}
                    fill="none"
                    strokeLinecap="round"
                    opacity={frame > 130 ? 0.85 * (1 - t) : 0}
                  />
                );
              })}
            </svg>
            <PhoneFrame width={210} height={420} style={{ borderRadius: 34, padding: 8 }}>
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
                <div style={{ fontSize: 56 }}>🐷</div>
                <div style={{ fontFamily: F.title, fontWeight: 700, fontSize: 26, color: C.ink }}>
                  PORCI<span style={{ color: C.verde }}>PESO</span>
                </div>
                <div style={{ fontSize: 15, color: C.muted, fontWeight: 600 }}>Android</div>
              </div>
            </PhoneFrame>
          </div>
        </Half>
      </div>

      {/* banner sin internet */}
      <Pop
        at={192}
        fromY={50}
        style={{
          position: "absolute",
          bottom: 150,
          width: "100%",
          display: "flex",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            background: C.panel,
            border: `2px solid ${C.panelEdge}`,
            borderRadius: 999,
            padding: "20px 48px",
            display: "flex",
            alignItems: "center",
            gap: 18,
            boxShadow: "0 20px 44px rgba(27,35,31,0.3)",
          }}
        >
          <span style={{ fontSize: 44 }}>📵</span>
          <span style={{ fontFamily: F.body, fontWeight: 700, fontSize: 34, color: "#fff" }}>
            Funciona <span style={{ color: C.calm }}>sin internet</span> — en pleno corral no se
            pierde ni un kilo
          </span>
        </div>
      </Pop>

      <Subtitles scene="e5" />
    </AbsoluteFill>
  );
};
