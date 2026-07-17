import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, F } from "../theme";
import { LedBox, PhoneFrame } from "../components/Devices";
import { Pop, Subtitles } from "../components/Common";

// ---- línea de tiempo de la demo dentro del celular (frames de escena) ----
// P0 0-92: listo, PASO 1 · P1 92-200: cerdo de prueba + calibrado
// P2 200-300: sube el lote, cuenta solo · P3 300-395: duda → pregunta [1][2]
// P4 400-600: pesaje terminado + informe

const lerp = (frame: number, r: [number, number], v: [number, number]) =>
  interpolate(frame, r, v, { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

const useDemo = (f: number) => {
  // peso en el LED
  let kg = 0;
  if (f < 100) kg = 0;
  else if (f < 145) kg = lerp(f, [100, 138], [0, 102.5]);
  else if (f < 215) kg = 102.5;
  else if (f < 250) kg = lerp(f, [215, 232], [102.5, 208.0]);
  else if (f < 305) kg = lerp(f, [250, 266], [208.0, 312.4]);
  else kg = lerp(f, [305, 318], [312.4, 521.6]);

  const cerdos = f < 150 ? 0 : f < 232 ? 1 : f < 266 ? 2 : f < 372 ? 3 : 5;
  const total = f < 150 ? 0 : f < 232 ? 102.5 : f < 266 ? 208.0 : f < 372 ? 312.4 : 521.6;

  let paso = { n: "PASO 1", t: "Sube UN cerdo de prueba, solo" };
  if (f >= 200) paso = { n: "PASO 2", t: "Sube el lote como quieras" };

  let narr: { txt: string; mode: "calm" | "busy" | "ask" } = {
    txt: "Listo. Espero el cerdo de prueba…",
    mode: "busy",
  };
  if (f >= 100 && f < 150) narr = { txt: "Pesando…", mode: "busy" };
  else if (f >= 150 && f < 215)
    narr = { txt: "Cerdo de prueba: 102,5 kg. Quedé calibrado ✓", mode: "calm" };
  else if (f >= 215 && f < 250) narr = { txt: "Subió 1 cerdo más ✓ Van 2.", mode: "calm" };
  else if (f >= 250 && f < 305) narr = { txt: "Subió otro ✓ Van 3.", mode: "calm" };
  else if (f >= 305 && f < 372)
    narr = { txt: "Subieron varios de golpe… ¿cuántos fueron?", mode: "ask" };
  else if (f >= 372) narr = { txt: "Anotado ✓ Van 5 cerdos.", mode: "calm" };

  return { kg, cerdos, total, paso, narr };
};

const NARR_COLOR = { calm: C.calm, busy: C.amberTxt, ask: C.amber } as const;

/** Recreación fiel de la pantalla del operador (UI móvil real de porcipeso/ui). */
const MobileWeighUI: React.FC<{ f: number }> = ({ f }) => {
  const { kg, cerdos, total, paso, narr } = useDemo(f);
  const prom = cerdos > 0 ? total / cerdos : null;
  const btn2Press = f >= 356 && f < 372;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        fontFamily: F.body,
        background: C.hueso,
      }}
    >
      {/* cabecera móvil */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "26px 18px 10px",
          borderBottom: `1px solid ${C.border}`,
          background: C.card,
        }}
      >
        <span style={{ fontSize: 26 }}>🐷</span>
        <b style={{ fontFamily: F.title, fontSize: 24, color: C.ink }}>PorciPeso</b>
        <div style={{ flexGrow: 1 }} />
        <span
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: C.verdeInk,
            background: C.verdeSoft,
            border: `1px solid ${C.verde}`,
            borderRadius: 999,
            padding: "3px 10px",
          }}
        >
          Báscula ✓
        </span>
      </div>

      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12, flexGrow: 1 }}>
        {/* LED */}
        <LedBox
          value={kg.toFixed(1).replace(".", ",")}
          unit="kg"
          fontSize={62}
          pad={16}
          glow={0.9}
        />

        {/* guía de pasos */}
        <div
          style={{
            background: C.verdeSoft,
            border: `1px solid ${C.verde}`,
            color: C.verdeInk,
            borderRadius: 10,
            padding: "9px 14px",
            fontSize: 18,
            fontWeight: 600,
          }}
        >
          <b style={{ letterSpacing: 1.5 }}>{paso.n}</b> · {paso.t}
        </div>

        {/* narración — la firma de PorciPeso */}
        <div
          style={{
            background: narr.mode === "ask" ? C.amberSoft : C.panel,
            border: narr.mode === "ask" ? `2px solid ${C.amber}` : `1px solid ${C.panelEdge}`,
            borderRadius: 12,
            padding: "14px 16px",
            minHeight: 108,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 10,
          }}
        >
          <div
            style={{
              fontSize: 21,
              fontWeight: 600,
              lineHeight: 1.3,
              color: NARR_COLOR[narr.mode],
            }}
          >
            {narr.txt}
          </div>
          {narr.mode === "ask" && (
            <div style={{ display: "flex", gap: 10 }}>
              {[1, 2].map((v) => (
                <div
                  key={v}
                  style={{
                    flexGrow: 1,
                    textAlign: "center",
                    borderRadius: 10,
                    padding: "9px 0",
                    fontSize: 22,
                    fontWeight: 800,
                    background: v === 2 && btn2Press ? C.verde : C.card,
                    color: v === 2 && btn2Press ? "#fff" : C.ink,
                    border: `2px solid ${v === 2 && btn2Press ? C.verde : C.border}`,
                    transform: v === 2 && btn2Press ? "scale(0.94)" : "scale(1)",
                  }}
                >
                  {v}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* tarjetas CERDOS / TOTAL / PROMEDIO */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
          {[
            { k: "CERDOS", v: `${cerdos}`, em: "" },
            { k: "TOTAL", v: total.toFixed(1).replace(".", ","), em: "kg" },
            { k: "PROMEDIO", v: prom ? prom.toFixed(1).replace(".", ",") : "—", em: "kg" },
          ].map((c) => (
            <div
              key={c.k}
              style={{
                background: C.darkCard,
                border: `1px solid ${C.panelEdge}`,
                borderRadius: 10,
                padding: "10px 8px",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  letterSpacing: 1.6,
                  color: C.darkMuted,
                  fontWeight: 700,
                }}
              >
                {c.k}
              </div>
              <div
                style={{
                  fontFamily: F.mono,
                  fontVariantNumeric: "tabular-nums",
                  fontSize: 27,
                  fontWeight: 700,
                  color: "#fff",
                  marginTop: 3,
                }}
              >
                {c.v} {c.em && <em style={{ fontStyle: "normal", fontSize: 13, color: C.darkMuted }}>{c.em}</em>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* pestañas inferiores */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3,1fr)",
          borderTop: `1px solid ${C.border}`,
          background: C.card,
          padding: "8px 0 14px",
        }}
      >
        {[
          { ic: "⚖", t: "Pesaje", on: true },
          { ic: "📊", t: "Datos", on: false },
          { ic: "⚙", t: "Báscula", on: false },
        ].map((b) => (
          <div
            key={b.t}
            style={{
              textAlign: "center",
              fontSize: 15,
              fontWeight: 700,
              color: b.on ? C.verdeInk : C.muted,
            }}
          >
            <div style={{ fontSize: 21 }}>{b.ic}</div>
            {b.t}
          </div>
        ))}
      </div>
    </div>
  );
};

/** Pantalla de resultados (pvDone de la UI real). */
const MobileDoneUI: React.FC<{ f: number }> = ({ f }) => (
  <div
    style={{
      width: "100%",
      height: "100%",
      background: C.hueso,
      fontFamily: F.body,
      padding: "40px 16px 16px",
      display: "flex",
      flexDirection: "column",
      gap: 14,
    }}
  >
    <div style={{ textAlign: "center" }}>
      <div style={{ fontFamily: F.title, fontWeight: 700, fontSize: 34, color: C.ink }}>
        Pesaje terminado ✓
      </div>
      <div style={{ fontSize: 17, color: C.muted, marginTop: 2 }}>Lote 47 — corral C-2</div>
    </div>

    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
      {[
        { v: "27", k: "cerdos", at: 415 },
        { v: "2.812", k: "kg en total", at: 430 },
        { v: "104,1", k: "kg promedio", at: 445 },
        { v: "92%", k: "uniformidad", at: 460 },
      ].map((c) => (
        <Pop key={c.k} at={c.at} fromY={22}>
          <div
            style={{
              background: C.card,
              border: `1px solid ${C.border}`,
              borderRadius: 14,
              padding: "18px 10px",
              textAlign: "center",
            }}
          >
            <div
              style={{
                fontFamily: F.mono,
                fontVariantNumeric: "tabular-nums",
                fontSize: 40,
                fontWeight: 700,
                color: C.verdeInk,
              }}
            >
              {c.v}
            </div>
            <div style={{ fontSize: 16, color: C.muted, fontWeight: 600 }}>{c.k}</div>
          </div>
        </Pop>
      ))}
    </div>

    <Pop at={470} fromY={16}>
      <div
        style={{
          background: C.verdeSoft,
          border: `1px solid ${C.verde}`,
          color: C.verdeInk,
          borderRadius: 12,
          padding: "13px 12px",
          textAlign: "center",
          fontSize: 20,
          fontWeight: 700,
        }}
      >
        Lote parejo ✓ — listo para el camión
      </div>
    </Pop>

    <Pop at={492} fromY={16}>
      <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 6 }}>
        <div
          style={{
            background: C.verde,
            color: "#fff",
            borderRadius: 10,
            padding: "12px 20px",
            fontSize: 18,
            fontWeight: 700,
          }}
        >
          📊 Excel
        </div>
        <div
          style={{
            background: C.card,
            color: C.ink,
            border: `2px solid ${C.border}`,
            borderRadius: 10,
            padding: "12px 20px",
            fontSize: 18,
            fontWeight: 700,
          }}
        >
          📄 PDF con tu marca
        </div>
      </div>
    </Pop>
    <div style={{ flexGrow: 1 }} />
    <div style={{ textAlign: "center", fontSize: 14, color: C.muted, opacity: f > 500 ? 1 : 0 }}>
      PorciPeso · la báscula que te habla claro
    </div>
  </div>
);

const Callout: React.FC<{ at: number; icon: string; text: string }> = ({ at, icon, text }) => (
  <Pop at={at} fromY={26}>
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        background: "rgba(255,255,255,0.06)",
        border: `1px solid ${C.panelEdge}`,
        borderRadius: 16,
        padding: "18px 24px",
        width: 460,
      }}
    >
      <span style={{ fontSize: 44 }}>{icon}</span>
      <span style={{ fontFamily: F.body, fontSize: 30, fontWeight: 700, color: "#fff" }}>
        {text}
      </span>
    </div>
  </Pop>
);

/** E4 — CÓMO FUNCIONA: la pantalla del operador DENTRO de un celular. */
export const E4Celular: React.FC = () => {
  const frame = useCurrentFrame();
  const toDone = interpolate(frame, [398, 412], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse at 62% 40%, ${C.darkCard} 0%, ${C.darkBg} 75%)`,
      }}
    >
      {/* título */}
      <Pop at={6} fromY={18} style={{ position: "absolute", top: 56, left: 120 }}>
        <div style={{ fontFamily: F.title, fontWeight: 700, fontSize: 58, color: "#fff" }}>
          En el corral: <span style={{ color: C.calm }}>tu celular</span> 📱
        </div>
      </Pop>

      {/* celular con la app */}
      <div
        style={{
          position: "absolute",
          right: 250,
          top: 90,
          transform: "rotate(0.6deg)",
        }}
      >
        <PhoneFrame width={430} height={880}>
          <div style={{ position: "absolute", inset: 0, opacity: 1 - toDone }}>
            <MobileWeighUI f={frame} />
          </div>
          <div style={{ position: "absolute", inset: 0, opacity: toDone }}>
            {frame > 396 && <MobileDoneUI f={frame} />}
          </div>
        </PhoneFrame>
      </div>

      {/* callouts */}
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 250,
          display: "flex",
          flexDirection: "column",
          gap: 30,
        }}
      >
        <Callout at={150} icon="🎯" text="Se calibra solo" />
        <Callout at={230} icon="🔢" text="Cuenta y descuenta solo" />
        <Callout at={315} icon="🙋" text="Si duda… te pregunta" />
        <Callout at={490} icon="📄" text="Informe Excel y PDF con tu marca" />
      </div>

      <Subtitles scene="e4" />
    </AbsoluteFill>
  );
};
