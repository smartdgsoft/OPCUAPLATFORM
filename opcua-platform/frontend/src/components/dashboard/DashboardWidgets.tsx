import React, { useEffect, useRef } from "react";
import { useBinding, useAlarmsData, useAssetsData, type ResolvedData } from "../../hooks/useBinding";
import type { DashboardWidget } from "../../services/api";

// ---- NEXUS theme tokens ----
export const T = {
  bgCard: "#151820", bgElevated: "#1c2029", border: "#252a36", borderLight: "#2f3545",
  textPri: "#f0ece4", textSec: "#9a958a", textMuted: "#5a5650",
  gold: "#e8a830", teal: "#2dd4a8", red: "#ef4444", amber: "#f59e0b", cyan: "#22d3ee", rose: "#f472b6",
};
const card: React.CSSProperties = {
  background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 10, padding: 14,
  height: "100%", display: "flex", flexDirection: "column", boxSizing: "border-box", overflow: "hidden",
};
const titleRow: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 };
const titleTxt: React.CSSProperties = { fontFamily: "'Rajdhani',sans-serif", fontSize: 12, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: T.textSec };

const DemoBadge = () => (
  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.05em", padding: "2px 6px", borderRadius: 4,
    background: "rgba(154,149,138,0.15)", color: T.textMuted, textTransform: "uppercase" }}>demo</span>
);
const LiveDot = () => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, color: T.teal }}>
    <span style={{ width: 6, height: 6, borderRadius: "50%", background: T.teal, boxShadow: `0 0 6px ${T.teal}` }} />live
  </span>
);

const fmt = (v: any, decimals = 0, suffix = "") => {
  if (v === undefined || v === null || v === "") return "—";
  const n = Number(v);
  if (isNaN(n)) return String(v);
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix;
};

// ============ Sparkline canvas ============
function Spark({ data, color }: { data: number[]; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current; if (!c || !data.length) return;
    const ctx = c.getContext("2d"); if (!ctx) return;
    const w = c.width, h = c.height; ctx.clearRect(0, 0, w, h);
    const mn = Math.min(...data), mx = Math.max(...data), rng = mx - mn || 1;
    ctx.beginPath();
    data.forEach((v, i) => { const x = (i / (data.length - 1)) * w, y = h - ((v - mn) / rng) * (h - 4) - 2; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    ctx.fillStyle = color + "22"; ctx.fill();
  }, [data, color]);
  return <canvas ref={ref} width={90} height={26} style={{ width: 90, height: 26 }} />;
}

// ============ KPI ============
function KpiWidget({ w }: { w: DashboardWidget }) {
  const r = useBinding(w.binding, w.demo);
  const color = w.options?.color ?? T.gold;
  const value = r.isDemo ? w.demo?.value : r.live?.value;
  const series = w.demo?.series ?? [];
  const spec = w.binding?.spec;
  const inSpec = spec && value != null && (spec.min == null || Number(value) >= spec.min) && (spec.max == null || Number(value) <= spec.max);
  return (
    <div style={{ ...card, position: "relative" }}>
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 2, background: color, opacity: 0.5 }} />
      <div style={titleRow}><span style={titleTxt}>{w.title}</span>{r.isDemo ? <DemoBadge /> : <LiveDot />}</div>
      <div style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 30, fontWeight: 700, color: T.textPri, lineHeight: 1 }}>
        {fmt(value, w.options?.decimals ?? 0, w.options?.suffix ?? "")}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: "auto" }}>
        {series.length ? <Spark data={series} color={color} /> : null}
        <span style={{ fontSize: 11, color: T.textMuted }}>
          {spec?.unit}{spec && (spec.min != null || spec.max != null) ?
            ` (${spec.min != null ? spec.min : ""}${spec.min != null && spec.max != null ? "–" : ""}${spec.max != null ? spec.max : spec.min != null ? "+" : ""})` : ""}
        </span>
        {spec && value != null ? <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, marginLeft: "auto",
          background: inSpec ? "rgba(45,212,168,0.12)" : "rgba(239,68,68,0.12)", color: inSpec ? T.teal : T.red }}>{inSpec ? "SPEC" : "OUT"}</span> : null}
      </div>
    </div>
  );
}

// ============ Gauge ============
function GaugeWidget({ w }: { w: DashboardWidget }) {
  const r = useBinding(w.binding, w.demo);
  const ref = useRef<HTMLCanvasElement>(null);
  const color = w.options?.color ?? T.gold;
  const spec = w.binding?.spec ?? {};
  const value = Number(r.isDemo ? w.demo?.value : r.live?.value) || 0;
  useEffect(() => {
    const c = ref.current; if (!c) return; const ctx = c.getContext("2d"); if (!ctx) return;
    const s = 120, cx = s / 2, cy = s / 2, rad = 44, lw = 8;
    ctx.clearRect(0, 0, s, s);
    const sa = Math.PI * 0.75, ea = Math.PI * 2.25, ta = ea - sa;
    const mn = spec.min ?? 0, mx = spec.max ?? 100;
    const pct = Math.max(0, Math.min(1, (value - mn) / (mx - mn || 1)));
    ctx.beginPath(); ctx.arc(cx, cy, rad, sa, ea); ctx.strokeStyle = T.border; ctx.lineWidth = lw; ctx.lineCap = "round"; ctx.stroke();
    const crit = spec.crit != null && value >= spec.crit, warn = spec.warn != null && value >= spec.warn;
    const arcColor = crit ? T.red : warn ? T.amber : color;
    ctx.beginPath(); ctx.arc(cx, cy, rad, sa, sa + ta * pct); ctx.strokeStyle = arcColor; ctx.lineWidth = lw; ctx.lineCap = "round"; ctx.stroke();
  }, [value, color, spec.min, spec.max, spec.warn, spec.crit]);
  return (
    <div style={{ ...card, alignItems: "center", justifyContent: "center", padding: 8 }}>
      <div style={{ ...titleRow, width: "100%" }}><span style={{ ...titleTxt, fontSize: 10 }}>{w.title}</span>{r.isDemo ? <DemoBadge /> : null}</div>
      <div style={{ position: "relative", width: 120, height: 120 }}>
        <canvas ref={ref} width={120} height={120} style={{ width: 120, height: 120 }} />
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 20, fontWeight: 700, color: T.textPri }}>{fmt(value, value < 10 ? 1 : 0)}</span>
          <span style={{ fontSize: 10, color: T.textMuted }}>{spec.unit}</span>
        </div>
      </div>
    </div>
  );
}

// ============ Trend (multi-series) ============
function TrendWidget({ w }: { w: DashboardWidget }) {
  const r = useBinding(w.binding, w.demo);
  const ref = useRef<HTMLCanvasElement>(null);
  const series = w.binding?.series ?? [{ label: w.title ?? "", color: T.gold }];
  useEffect(() => {
    const c = ref.current; if (!c) return; const ctx = c.getContext("2d"); if (!ctx) return;
    const parent = c.parentElement!; c.width = parent.clientWidth; c.height = parent.clientHeight;
    const w0 = c.width, h0 = c.height; ctx.clearRect(0, 0, w0, h0);
    const pad = { l: 8, r: 8, t: 8, b: 8 };
    // demo: synthesize smooth series; live/history: use resolved history for first series
    const n = w.demo?.points ?? 30;
    const mkDemo = (seed: number) => Array.from({ length: n }, (_, i) => 0.5 + 0.35 * Math.sin(i / 4 + seed) + (Math.random() - 0.5) * 0.06);
    const datasets = r.isDemo || !r.history
      ? series.map((_, si) => mkDemo(si * 1.7))
      : [normalize(r.history.map((p) => p.v))];
    // grid
    ctx.strokeStyle = T.border; ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) { const y = pad.t + ((h0 - pad.t - pad.b) * g) / 4; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w0 - pad.r, y); ctx.stroke(); }
    datasets.forEach((data, si) => {
      const col = series[si]?.color ?? T.gold;
      ctx.beginPath();
      data.forEach((v, i) => { const x = pad.l + ((w0 - pad.l - pad.r) * i) / (data.length - 1); const y = pad.t + (h0 - pad.t - pad.b) * (1 - v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.strokeStyle = col; ctx.lineWidth = 1.8; ctx.stroke();
    });
    function normalize(arr: number[]) { const mn = Math.min(...arr), mx = Math.max(...arr), rg = mx - mn || 1; return arr.map((v) => (v - mn) / rg); }
  });
  return (
    <div style={card}>
      <div style={titleRow}>
        <span style={titleTxt}>{w.title}</span>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {series.map((s, i) => <span key={i} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: T.textMuted }}>
            <span style={{ width: 10, height: 3, background: s.color, borderRadius: 2 }} />{s.label}</span>)}
          {r.isDemo ? <DemoBadge /> : <LiveDot />}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 120, position: "relative" }}><canvas ref={ref} style={{ width: "100%", height: "100%" }} /></div>
    </div>
  );
}

// ============ Alarm list ============
const SEV = (s: string) => s === "critical" ? T.red : s === "warning" ? T.amber : T.cyan;
function AlarmListWidget({ w }: { w: DashboardWidget }) {
  const bound = w.binding?.mode === "alarms";
  const { data } = useAlarmsData(bound);
  const live = data && data.length ? data.map((e: any) => ({
    id: e.id ?? e.event_id, tag: e.tag ?? e.tag_id, desc: e.message ?? e.description ?? "",
    severity: (e.severity ?? 500) <= 250 ? "critical" : (e.severity ?? 500) <= 500 ? "warning" : "info",
    time: (e.raised_at ?? e.ts ?? "").slice(11, 19), acked: e.acknowledged ?? e.acked ?? false,
  })) : null;
  const rows = live ?? w.demo?.rows ?? [];
  const isDemo = !live;
  return (
    <div style={{ ...card, padding: 0 }}>
      <div style={{ ...titleRow, padding: "14px 14px 6px" }}>
        <span style={titleTxt}>{w.title}
          <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 8, background: "rgba(239,68,68,0.15)", color: T.red }}>{rows.length}</span>
        </span>
        {isDemo ? <DemoBadge /> : <LiveDot />}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 6px 6px" }}>
        {rows.map((a: any, i: number) => (
          <div key={i} style={{ borderLeft: `3px solid ${SEV(a.severity)}`, padding: "7px 10px", marginBottom: 3, background: "rgba(255,255,255,0.015)", borderRadius: "0 6px 6px 0", opacity: a.acked ? 0.55 : 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: SEV(a.severity), fontFamily: "monospace" }}>{a.tag}</span>
              <span style={{ fontSize: 10, color: T.textMuted }}>{a.time}</span>
            </div>
            <div style={{ fontSize: 11, color: T.textSec, marginTop: 2 }}>{a.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============ Equipment list ============
const STATUS_COLOR: Record<string, string> = { running: T.teal, batching: T.gold, warning: T.amber, fault: T.red, stopped: T.textMuted };
function EquipmentListWidget({ w }: { w: DashboardWidget }) {
  const bound = w.binding?.mode === "assets";
  const { data } = useAssetsData(bound);
  const live = data && data.length ? data.map((a: any) => ({
    tag: a.code ?? a.tag ?? a.name, name: a.name, type: a.asset_type ?? a.type ?? "",
    status: a.status ?? "running", load: a.load ?? 0,
  })) : null;
  const rows = live ?? w.demo?.rows ?? [];
  const isDemo = !live;
  return (
    <div style={{ ...card, padding: 0 }}>
      <div style={{ ...titleRow, padding: "14px 14px 6px" }}>
        <span style={titleTxt}>{w.title} <span style={{ fontSize: 10, color: T.textMuted }}>· {rows.length} assets</span></span>
        {isDemo ? <DemoBadge /> : <LiveDot />}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 8px" }}>
        {rows.map((e: any, i: number) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderBottom: `1px solid ${T.border}` }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: STATUS_COLOR[e.status] ?? T.textMuted, flexShrink: 0, boxShadow: e.status !== "stopped" ? `0 0 6px ${STATUS_COLOR[e.status]}` : "none" }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: T.textPri, fontWeight: 500 }}>{e.tag} <span style={{ color: T.textMuted, fontWeight: 400 }}>· {e.name}</span></div>
            </div>
            <div style={{ width: 46, height: 4, borderRadius: 2, background: T.border, overflow: "hidden", flexShrink: 0 }}>
              <div style={{ width: `${e.load}%`, height: "100%", background: STATUS_COLOR[e.status] ?? T.textMuted }} />
            </div>
            <span style={{ fontSize: 10, color: T.textMuted, width: 30, textAlign: "right" }}>{e.load}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============ Batch bar ============
function BatchBarWidget({ w }: { w: DashboardWidget }) {
  const d = w.demo ?? {};
  return (
    <div style={{ ...card, flexDirection: "row", alignItems: "center", gap: 16, padding: "12px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 190 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: T.gold, boxShadow: `0 0 6px ${T.gold}` }} />
        <div>
          <span style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 14, fontWeight: 600, color: T.gold }}>Batch {d.batch_id}</span>
          <span style={{ fontSize: 11, marginLeft: 8, color: T.textMuted }}>Phase: {d.phase}</span>
        </div>
        <DemoBadge />
      </div>
      <div style={{ flex: 1, height: 8, background: T.bgElevated, borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${d.progress ?? 0}%`, height: "100%", background: `linear-gradient(90deg,${T.gold},${T.amber})` }} />
      </div>
      <div style={{ display: "flex", gap: 16, fontSize: 11, color: T.textMuted }}>
        <span>Elapsed: <b style={{ color: T.textSec }}>{d.elapsed}</b></span>
        <span>Remaining: <b style={{ color: T.textSec }}>{d.remaining}</b></span>
        <span>Yield: <b style={{ color: T.teal }}>{d.yield}</b></span>
      </div>
    </div>
  );
}

// ============ Rich P&ID schematic (drawn node/edge graph) ============
const KIND_STYLE: Record<string, { fill: string; icon: string }> = {
  tank: { fill: "#1c2733", icon: "▭" }, reactor: { fill: "#2a2416", icon: "◯" },
  pump: { fill: "#16262a", icon: "▷" }, filler: { fill: "#241a26", icon: "▤" }, valve: { fill: "#1a1e28", icon: "◇" },
};
function SchematicWidget({ w }: { w: DashboardWidget }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const nodes = w.options?.nodes ?? [];
  const edges = w.options?.edges ?? [];
  useEffect(() => {
    const c = ref.current; if (!c) return; const ctx = c.getContext("2d"); if (!ctx) return;
    const parent = c.parentElement!; c.width = parent.clientWidth; c.height = parent.clientHeight;
    const W = c.width, H = c.height; ctx.clearRect(0, 0, W, H);
    // fit the authored coordinate space (approx 620x210) into the canvas
    const spanX = 640, spanY = 220; const sx = W / spanX, sy = H / spanY; const s = Math.min(sx, sy);
    const ox = (W - spanX * s) / 2, oy = (H - spanY * s) / 2;
    const P = (x: number, y: number) => [ox + x * s, oy + y * s] as [number, number];
    const byId: Record<string, any> = {}; nodes.forEach((n: any) => (byId[n.id] = n));
    // edges (pipes)
    edges.forEach((e: any) => {
      const a = byId[e.from], b = byId[e.to]; if (!a || !b) return;
      const [ax, ay] = P(a.x + 26, a.y + 14), [bx, by] = P(b.x - 4, b.y + 14);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo((ax + bx) / 2, ay); ctx.lineTo((ax + bx) / 2, by); ctx.lineTo(bx, by);
      ctx.strokeStyle = T.borderLight; ctx.lineWidth = 2; ctx.stroke();
      // flow dot
      const t = (Date.now() / 900 % 1); const fx = ax + (bx - ax) * t, fy = ay + (by - ay) * t;
      ctx.beginPath(); ctx.arc(fx, fy, 2, 0, Math.PI * 2); ctx.fillStyle = T.teal; ctx.fill();
    });
    // nodes
    nodes.forEach((n: any) => {
      const [x, y] = P(n.x, n.y); const nw = 52 * s, nh = 30 * s;
      const st = KIND_STYLE[n.kind] ?? KIND_STYLE.valve;
      const statusCol = n.status === "warning" ? T.amber : n.status === "fault" ? T.red : n.status === "batching" ? T.gold : T.border;
      ctx.fillStyle = st.fill; ctx.strokeStyle = statusCol; ctx.lineWidth = 1.5;
      roundRect(ctx, x, y, nw, nh, 4 * s); ctx.fill(); ctx.stroke();
      const label = (n.label ?? "").split("\n");
      ctx.fillStyle = T.textSec; ctx.font = `${9 * s}px 'Rajdhani',sans-serif`; ctx.textAlign = "center";
      label.forEach((ln: string, i: number) => ctx.fillText(ln, x + nw / 2, y + 11 * s + i * 9 * s));
      // value chip below
      const val = n.demo != null ? `${n.demo}${n.unit ?? ""}` : "—";
      ctx.fillStyle = T.gold; ctx.font = `bold ${9 * s}px 'Rajdhani',sans-serif`;
      ctx.fillText(val, x + nw / 2, y + nh + 10 * s);
    });
    function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w2: number, h2: number, r: number) {
      c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w2, y, x + w2, y + h2, r); c.arcTo(x + w2, y + h2, x, y + h2, r);
      c.arcTo(x, y + h2, x, y, r); c.arcTo(x, y, x + w2, y, r); c.closePath();
    }
  });
  // animate flow
  useEffect(() => { const id = setInterval(() => { const c = ref.current; if (c) c.dispatchEvent(new Event("x")); }, 60); return () => clearInterval(id); }, []);
  return (
    <div style={card}>
      <div style={titleRow}><span style={titleTxt}>{w.title}</span><DemoBadge /></div>
      <div style={{ flex: 1, minHeight: 160, position: "relative" }}><canvas ref={ref} style={{ width: "100%", height: "100%" }} /></div>
    </div>
  );
}

// ============ Text ============
function TextWidget({ w }: { w: DashboardWidget }) {
  return <div style={card}><div style={titleRow}><span style={titleTxt}>{w.title}</span></div>
    <div style={{ fontSize: 13, color: T.textSec }}>{w.options?.text ?? ""}</div></div>;
}

// ============ Dispatcher ============
export function Widget({ w }: { w: DashboardWidget }) {
  switch (w.type) {
    case "kpi": return <KpiWidget w={w} />;
    case "gauge": return <GaugeWidget w={w} />;
    case "trend": case "sparkline": return <TrendWidget w={w} />;
    case "alarm_list": return <AlarmListWidget w={w} />;
    case "equipment_list": return <EquipmentListWidget w={w} />;
    case "batch_bar": return <BatchBarWidget w={w} />;
    case "schematic": return <SchematicWidget w={w} />;
    case "text": return <TextWidget w={w} />;
    default: return <div style={card}><span style={{ color: T.textMuted, fontSize: 12 }}>Unknown widget: {w.type}</span></div>;
  }
}
