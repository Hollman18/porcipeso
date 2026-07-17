import React from "react";
import { C, F } from "../theme";

/** Display LED estilo indicador de báscula (copiado del .ledbox/.led de la UI real). */
export const LedBox: React.FC<{
  value: string;
  unit?: string;
  width?: number;
  fontSize?: number;
  pad?: number;
  glow?: number;
  style?: React.CSSProperties;
}> = ({ value, unit = "kg", width, fontSize = 130, pad = 26, glow = 1, style }) => (
  <div
    style={{
      background: C.panelDeep,
      border: `2px solid ${C.panelEdge}`,
      borderRadius: 14,
      padding: `${pad}px ${pad * 1.4}px`,
      width,
      textAlign: "center",
      boxShadow: "inset 0 0 40px rgba(0,0,0,0.7)",
      ...style,
    }}
  >
    <span
      style={{
        fontFamily: F.mono,
        fontVariantNumeric: "tabular-nums",
        fontWeight: 700,
        fontSize,
        color: C.led,
        textShadow: `0 0 ${22 * glow}px rgba(255,74,46,${0.55 * glow}), 0 0 ${
          60 * glow
        }px rgba(255,74,46,${0.25 * glow})`,
        letterSpacing: 2,
        lineHeight: 1,
      }}
    >
      {value}
      {unit && (
        <span style={{ fontSize: fontSize * 0.28, opacity: 0.85, marginLeft: 10 }}>{unit}</span>
      )}
    </span>
  </div>
);

/** Indicador de peso genérico (cajita con LED, botones y patas). */
export const Indicator: React.FC<{
  value?: string;
  label?: string;
  scale?: number;
}> = ({ value = "88.8", label, scale = 1 }) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 10 * scale,
      transform: `scale(${scale})`,
      transformOrigin: "center",
    }}
  >
    <div
      style={{
        background: C.panel,
        border: `3px solid ${C.panelEdge}`,
        borderRadius: 18,
        padding: 22,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        boxShadow: "0 12px 30px rgba(0,0,0,0.25)",
      }}
    >
      <LedBox value={value} unit="kg" fontSize={64} pad={14} glow={0.8} />
      <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
        {["ZERO", "TARE", "PRINT", "F"].map((b) => (
          <div
            key={b}
            style={{
              background: "#2C352E",
              border: `1px solid ${C.panelEdge}`,
              color: "#AAB8AD",
              borderRadius: 8,
              padding: "6px 14px",
              fontFamily: F.body,
              fontSize: 15,
              fontWeight: 700,
            }}
          >
            {b}
          </div>
        ))}
      </div>
    </div>
    {label && (
      <div
        style={{
          fontFamily: F.body,
          fontWeight: 700,
          fontSize: 24,
          color: C.muted,
          letterSpacing: 1,
        }}
      >
        {label}
      </div>
    )}
  </div>
);

/** Marco de celular Android vertical (bordes redondeados + cámara punch-hole). */
export const PhoneFrame: React.FC<{
  width?: number;
  height?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ width = 440, height = 920, children, style }) => (
  <div
    style={{
      width,
      height,
      background: "#0B0D0C",
      borderRadius: 54,
      border: "4px solid #2A2F2B",
      boxShadow: "0 30px 80px rgba(0,0,0,0.55), inset 0 0 0 3px #000",
      padding: 14,
      position: "relative",
      ...style,
    }}
  >
    {/* botones laterales */}
    <div
      style={{
        position: "absolute",
        right: -8,
        top: height * 0.22,
        width: 5,
        height: 90,
        borderRadius: 4,
        background: "#2A2F2B",
      }}
    />
    <div
      style={{
        position: "absolute",
        right: -8,
        top: height * 0.34,
        width: 5,
        height: 56,
        borderRadius: 4,
        background: "#2A2F2B",
      }}
    />
    {/* pantalla */}
    <div
      style={{
        width: "100%",
        height: "100%",
        borderRadius: 42,
        overflow: "hidden",
        background: C.hueso,
        position: "relative",
      }}
    >
      {children}
      {/* cámara punch-hole */}
      <div
        style={{
          position: "absolute",
          top: 12,
          left: "50%",
          transform: "translateX(-50%)",
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "#0B0D0C",
          boxShadow: "inset 0 0 4px #333",
          zIndex: 30,
        }}
      />
    </div>
  </div>
);

/** Marco de laptop con base. */
export const LaptopFrame: React.FC<{
  screenW?: number;
  screenH?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ screenW = 1280, screenH = 720, children, style }) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", ...style }}>
    <div
      style={{
        width: screenW,
        height: screenH,
        background: "#0B0D0C",
        border: "4px solid #2A2F2B",
        borderRadius: "22px 22px 0 0",
        padding: 16,
        paddingBottom: 18,
        boxShadow: "0 30px 70px rgba(0,0,0,0.35)",
      }}
    >
      <div
        style={{
          width: "100%",
          height: "100%",
          borderRadius: 10,
          overflow: "hidden",
          background: C.hueso,
          position: "relative",
        }}
      >
        {children}
      </div>
    </div>
    <div
      style={{
        width: screenW * 1.16,
        height: 26,
        background: "linear-gradient(180deg, #3A423C 0%, #232823 100%)",
        borderRadius: "0 0 22px 22px",
        boxShadow: "0 14px 30px rgba(0,0,0,0.3)",
        position: "relative",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 0,
          transform: "translateX(-50%)",
          width: 170,
          height: 11,
          borderRadius: "0 0 12px 12px",
          background: "#181D19",
        }}
      />
    </div>
  </div>
);

/** Monitor de escritorio con base. */
export const MonitorFrame: React.FC<{
  screenW?: number;
  screenH?: number;
  children: React.ReactNode;
}> = ({ screenW = 560, screenH = 340, children }) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
    <div
      style={{
        width: screenW,
        height: screenH,
        background: "#0B0D0C",
        border: "4px solid #2A2F2B",
        borderRadius: 16,
        padding: 12,
        boxShadow: "0 20px 50px rgba(0,0,0,0.3)",
      }}
    >
      <div
        style={{
          width: "100%",
          height: "100%",
          borderRadius: 8,
          overflow: "hidden",
          background: C.hueso,
          position: "relative",
        }}
      >
        {children}
      </div>
    </div>
    <div style={{ width: 26, height: 52, background: "#232823" }} />
    <div style={{ width: 200, height: 14, borderRadius: 7, background: "#232823" }} />
  </div>
);
