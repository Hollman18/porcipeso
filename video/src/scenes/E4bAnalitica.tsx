import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, F } from "../theme";
import { LaptopFrame } from "../components/Devices";
import { Fade, Pop, Subtitles, fmtMiles, useCount } from "../components/Common";

const ROWS = [
  { fecha: "Hoy · 6:40", lote: "Lote 47 — corral C-2", cerdos: 27, kg: "2.812", prom: "104,1", uni: "92%" },
  { fecha: "Ayer · 15:12", lote: "Lote 46 — corral B-1", cerdos: 31, kg: "3.198", prom: "103,2", uni: "89%" },
  { fecha: "Ayer · 7:05", lote: "Lote 45 — destete", cerdos: 44, kg: "1.276", prom: "29,0", uni: "94%" },
  { fecha: "Lun · 16:30", lote: "Lote 44 — corral A-3", cerdos: 29, kg: "3.016", prom: "104,0", uni: "91%" },
];

const LOTES = [
  { n: "Lote 47", kg: 104.1, pct: 0.98 },
  { n: "Lote 46", kg: 103.2, pct: 0.97 },
  { n: "Lote 44", kg: 104.0, pct: 0.98 },
  { n: "Lote 45", kg: 29.0, pct: 0.28 },
];

/** E4b — LA ANALÍTICA: módulo Datos real en un computador. */
export const E4bAnalitica: React.FC = () => {
  const frame = useCurrentFrame();
  const stats = [
    { k: "Pesajes", v: useCount(35, 115, 0, 128), fmt: (n: number) => fmtMiles(n) },
    { k: "Cerdos", v: useCount(35, 115, 0, 3442), fmt: (n: number) => fmtMiles(n) },
    { k: "Kg totales", v: useCount(35, 115, 0, 356900), fmt: (n: number) => fmtMiles(n) },
    {
      k: "Promedio",
      v: useCount(35, 115, 0, 103.7),
      fmt: (n: number) => n.toFixed(1).replace(".", ",") + " kg",
    },
  ];

  return (
    <AbsoluteFill style={{ background: C.hueso, alignItems: "center" }}>
      <Pop at={5} fromY={16} style={{ marginTop: 40 }}>
        <div style={{ fontFamily: F.title, fontWeight: 700, fontSize: 56, color: C.ink }}>
          En la oficina: <span style={{ color: C.verde }}>toda la analítica</span> 💻
        </div>
      </Pop>

      <Pop at={14} fromY={40} style={{ marginTop: 26 }}>
        <LaptopFrame screenW={1300} screenH={730}>
          <div
            style={{
              width: "100%",
              height: "100%",
              padding: "22px 28px",
              fontFamily: F.body,
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            {/* cabecera del módulo Datos */}
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 24 }}>🐷</span>
              <b style={{ fontFamily: F.title, fontSize: 26, color: C.ink }}>PorciPeso</b>
              <span style={{ color: C.border }}>|</span>
              <span style={{ fontSize: 22, fontWeight: 700, color: C.verdeInk }}>📊 Datos</span>
              <div style={{ flexGrow: 1 }} />
              <span style={{ fontSize: 16, color: C.muted }}>Últimos 30 días</span>
            </div>

            {/* tarjetas resumen */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
              {stats.map((s) => (
                <div
                  key={s.k}
                  style={{
                    background: C.card,
                    border: `1px solid ${C.border}`,
                    borderRadius: 14,
                    padding: "16px 18px",
                  }}
                >
                  <div
                    style={{
                      fontSize: 14,
                      letterSpacing: 1.4,
                      textTransform: "uppercase",
                      color: C.muted,
                      fontWeight: 700,
                    }}
                  >
                    {s.k}
                  </div>
                  <div
                    style={{
                      fontFamily: F.mono,
                      fontVariantNumeric: "tabular-nums",
                      fontSize: 40,
                      fontWeight: 700,
                      color: C.verdeInk,
                      marginTop: 4,
                    }}
                  >
                    {s.fmt(s.v)}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 18, flexGrow: 1 }}>
              {/* tabla de pesajes */}
              <div
                style={{
                  flexGrow: 1,
                  background: C.card,
                  border: `1px solid ${C.border}`,
                  borderRadius: 14,
                  padding: "14px 18px",
                }}
              >
                <div style={{ fontSize: 19, fontWeight: 700, color: C.ink, marginBottom: 10 }}>
                  Pesajes
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "160px 1fr 100px 100px 120px 130px 80px",
                    fontSize: 16,
                    color: C.muted,
                    fontWeight: 700,
                    borderBottom: `2px solid ${C.border}`,
                    paddingBottom: 8,
                  }}
                >
                  <span>Fecha</span><span>Lote</span><span>Cerdos</span><span>Kg</span>
                  <span>Promedio</span><span>Uniformidad</span><span>Estado</span>
                </div>
                {ROWS.map((r, i) => (
                  <Fade key={r.lote} at={120 + i * 18} dur={10}>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "160px 1fr 100px 100px 120px 130px 80px",
                        fontSize: 17,
                        color: C.ink,
                        padding: "11px 0",
                        borderBottom: `1px solid ${C.border}`,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      <span style={{ color: C.muted }}>{r.fecha}</span>
                      <span style={{ fontWeight: 600 }}>{r.lote}</span>
                      <span>{r.cerdos}</span><span>{r.kg}</span><span>{r.prom}</span>
                      <span>{r.uni}</span>
                      <span style={{ color: C.verde, fontWeight: 800 }}>✓</span>
                    </div>
                  </Fade>
                ))}
              </div>

              {/* por lote + tendencia */}
              <div
                style={{
                  width: 330,
                  background: C.card,
                  border: `1px solid ${C.border}`,
                  borderRadius: 14,
                  padding: "14px 18px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 19, fontWeight: 700, color: C.ink }}>
                  Por lote · promedio
                </div>
                {LOTES.map((l, i) => {
                  const w = interpolate(frame, [140 + i * 12, 185 + i * 12], [0, l.pct], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  });
                  return (
                    <div key={l.n}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          fontSize: 16,
                          fontWeight: 600,
                          color: C.ink,
                        }}
                      >
                        <span>{l.n}</span>
                        <span style={{ fontVariantNumeric: "tabular-nums", color: C.verdeInk }}>
                          {l.kg.toFixed(1).replace(".", ",")} kg
                        </span>
                      </div>
                      <div
                        style={{
                          height: 14,
                          background: C.verdeSoft,
                          borderRadius: 7,
                          marginTop: 4,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            width: `${w * 100}%`,
                            height: "100%",
                            background: C.verde,
                            borderRadius: 7,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
                <Fade at={200} style={{ marginTop: "auto" }}>
                  <div
                    style={{
                      background: C.verdeSoft,
                      border: `1px solid ${C.verde}`,
                      borderRadius: 10,
                      padding: "10px 12px",
                      fontSize: 16,
                      fontWeight: 700,
                      color: C.verdeInk,
                      textAlign: "center",
                    }}
                  >
                    📈 Tendencia al alza — lista para decidir
                  </div>
                </Fade>
              </div>
            </div>
          </div>
        </LaptopFrame>
      </Pop>

      <Subtitles scene="e4b" />
    </AbsoluteFill>
  );
};
