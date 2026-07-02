import React, { useEffect, useRef } from "react";
import { useBinding, useAlarmsData, useAssetsData, useLiveTags, useGlobalDemo, type ResolvedData } from "../../hooks/useBinding";
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

// ============ Sparkline canvas (denser, HTML-style) ============
function Spark({ data, color }: { data: number[]; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current; if (!c || !data.length) return;
    const ctx = c.getContext("2d"); if (!ctx) return;
    const dpr = 2; c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr; ctx.scale(dpr, dpr);
    const w = c.clientWidth, h = c.clientHeight; ctx.clearRect(0, 0, w, h);
    const mn = Math.min(...data), mx = Math.max(...data), rng = mx - mn || 1;
    const X = (i: number) => (i / (data.length - 1)) * w;
    const Y = (v: number) => h - ((v - mn) / rng) * (h - 4) - 2;
    // area fill
    ctx.beginPath(); ctx.moveTo(0, h);
    data.forEach((v, i) => ctx.lineTo(X(i), Y(v)));
    ctx.lineTo(w, h); ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, color + "40"); grad.addColorStop(1, color + "00");
    ctx.fillStyle = grad; ctx.fill();
    // line
    ctx.beginPath();
    data.forEach((v, i) => { i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); });
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = "round"; ctx.stroke();
  }, [data, color]);
  return <canvas ref={ref} style={{ width: "100%", height: 34 }} />;
}

// dense realistic-looking series for demo sparklines
function densify(base: number[], n = 40): number[] {
  if (base.length >= n) return base;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = (i / (n - 1)) * (base.length - 1);
    const lo = Math.floor(p), hi = Math.ceil(p), f = p - lo;
    const v = base[lo] * (1 - f) + base[hi] * f;
    const jitter = (base[0] || 1) * 0.012 * (Math.sin(i * 1.7) + Math.sin(i * 0.6));
    out.push(v + jitter);
  }
  return out;
}

// ============ KPI ============
function KpiWidget({ w }: { w: DashboardWidget }) {
  const r = useBinding(w.binding, w.demo);
  const color = w.options?.color ?? T.gold;
  const value = r.isDemo ? w.demo?.value : r.live?.value;
  const series = densify(w.demo?.series ?? [Number(value) || 0]);
  const spec = w.binding?.spec;
  const inSpec = spec && value != null && (spec.min == null || Number(value) >= spec.min) && (spec.max == null || Number(value) <= spec.max);
  const badge = w.options?.badge ?? (spec ? (inSpec ? "Spec" : "Out") : null);
  const specTxt = spec ? `${spec.unit ?? ""}${(spec.min != null || spec.max != null) ? ` (${spec.min != null ? spec.min : ""}${spec.min != null && spec.max != null ? "-" : ""}${spec.max != null ? spec.max : spec.min != null ? "+" : ""})` : ""}` : "";
  return (
    <div style={{ ...card, position: "relative" }}>
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 2, background: color, opacity: 0.5 }} />
      <div style={{ ...titleRow, alignItems: "flex-start", marginBottom: 6 }}>
        <span style={{ ...titleTxt, maxWidth: "58%", lineHeight: 1.2 }}>{w.title}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
          {badge ? (
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.04em", padding: "2px 6px", borderRadius: 4, textTransform: "uppercase", whiteSpace: "nowrap",
              background: inSpec ? "rgba(45,212,168,0.14)" : "rgba(239,68,68,0.14)", color: inSpec ? T.teal : T.red }}>
              {inSpec ? "✓ " : ""}{badge}
            </span>
          ) : null}
          {/* live/demo indicator as a tiny dot to save space */}
          <span title={r.isDemo ? "demo" : "live"} style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
            background: r.isDemo ? T.textMuted : T.teal, boxShadow: r.isDemo ? "none" : `0 0 5px ${T.teal}` }} />
        </div>
      </div>
      <div style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 30, fontWeight: 700, color: T.textPri, lineHeight: 1 }}>
        {fmt(value, w.options?.decimals ?? 0, w.options?.suffix ?? "")}
      </div>
      <div style={{ marginTop: "auto", paddingTop: 6 }}>
        <Spark data={series} color={color} />
        <span style={{ fontSize: 10, color: T.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>{specTxt}</span>
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

// ============ Trend (multi-series, dual-axis, gridlines) ============
function TrendWidget({ w }: { w: DashboardWidget }) {
  const r = useBinding(w.binding, w.demo);
  const ref = useRef<HTMLCanvasElement>(null);
  const series = w.binding?.series ?? [{ label: w.title ?? "", color: T.gold }];
  useEffect(() => {
    const c = ref.current; if (!c) return; const ctx = c.getContext("2d"); if (!ctx) return;
    const parent = c.parentElement!; const dpr = 2;
    c.width = parent.clientWidth * dpr; c.height = parent.clientHeight * dpr;
    c.style.width = "100%"; c.style.height = "100%"; ctx.scale(dpr, dpr);
    const w0 = parent.clientWidth, h0 = parent.clientHeight; ctx.clearRect(0, 0, w0, h0);
    const pad = { l: 40, r: 34, t: 10, b: 20 };
    const plotW = w0 - pad.l - pad.r, plotH = h0 - pad.t - pad.b;
    const n = w.demo?.points ?? 48;
    // HTML character: primary (viscosity) is a spiky high-frequency signal;
    // the others are near-flat reference lines. Makes the gold signal pop.
    const mkPrimary = (seed: number) => Array.from({ length: n }, (_, i) =>
      0.5 + 0.30 * Math.sin(i / 2.0 + seed) + 0.18 * Math.sin(i * 1.4 + seed) + (Math.random() - 0.5) * 0.22);
    const mkFlat = (seed: number, level: number) => Array.from({ length: n }, (_, i) =>
      level + 0.015 * Math.sin(i / 6 + seed) + (Math.random() - 0.5) * 0.02);
    const flatLevels = [0.5, 0.82, 0.32, 0.9];
    const datasets = (r.isDemo || !r.history)
      ? series.map((_, si) => si === 0 ? mkPrimary(si * 2.1) : mkFlat(si * 1.7, flatLevels[si] ?? 0.5))
      : [normalize(r.history.map((p) => p.v))];
    // left axis labels (primary series scale, demo uses viscosity-like range)
    const leftMin = 4800, leftMax = 4950, rightMin = 20, rightMax = 80;
    ctx.font = "10px 'Source Sans 3',sans-serif"; ctx.textBaseline = "middle";
    for (let g = 0; g <= 4; g++) {
      const y = pad.t + (plotH * g) / 4;
      ctx.strokeStyle = T.border; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + plotW, y); ctx.stroke();
      const lv = Math.round(leftMax - (leftMax - leftMin) * (g / 4));
      ctx.fillStyle = T.textMuted; ctx.textAlign = "right"; ctx.fillText(lv.toLocaleString(), pad.l - 6, y);
      const rv = Math.round(rightMax - (rightMax - rightMin) * (g / 4));
      ctx.textAlign = "left"; ctx.fillText(String(rv), pad.l + plotW + 6, y);
    }
    datasets.forEach((data, si) => {
      const col = series[si]?.color ?? T.gold;
      ctx.beginPath();
      data.forEach((v, i) => { const x = pad.l + (plotW * i) / (data.length - 1); const y = pad.t + plotH * (1 - v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.strokeStyle = col; ctx.lineWidth = 1.8; ctx.lineJoin = "round"; ctx.stroke();
    });
    function normalize(arr: number[]) { const mn = Math.min(...arr), mx = Math.max(...arr), rg = mx - mn || 1; return arr.map((v) => (v - mn) / rg); }
  });
  return (
    <div style={card}>
      <div style={titleRow}>
        <span style={titleTxt}>{w.title}</span>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {series.map((s, i) => <span key={i} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: T.textSec }}>
            <span style={{ width: 10, height: 3, background: s.color, borderRadius: 2 }} />{s.label}</span>)}
          {r.isDemo ? <DemoBadge /> : <LiveDot />}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 150, position: "relative" }}><canvas ref={ref} /></div>
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
function SchematicWidget({ w }: { w: DashboardWidget }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const nodes: any[] = w.options?.nodes ?? [];
  const edges: any[] = w.options?.edges ?? [];
  const globalDemo = useGlobalDemo();
  const nodeTags = nodes.map((n) => n.value_tag).filter(Boolean);
  const live = useLiveTags(nodeTags, !globalDemo && nodeTags.length > 0);
  const anyLive = Object.keys(live).length > 0;
  const liveRef = useRef(live); liveRef.current = live;

  useEffect(() => {
    const c = ref.current; if (!c) return; const ctx = c.getContext("2d"); if (!ctx) return;
    let raf = 0, frame = 0;
    const hexRgba = (hex: string, a: number) => {
      const h = hex.replace("#", ""); const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${a})`;
    };
    const draw = () => {
      const parent = c.parentElement!; const dpr = 2;
      c.width = parent.clientWidth * dpr; c.height = parent.clientHeight * dpr;
      c.style.width = "100%"; c.style.height = "100%";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const W = parent.clientWidth, H = parent.clientHeight; ctx.clearRect(0, 0, W, H);
      // resolve node positions: fractional fx/fy (0..1) preferred, else authored x/y scaled
      const pos = nodes.map((n) => ({
        x: n.fx != null ? n.fx * W : (n.x ?? 0.1) * (W / 640),
        y: n.fy != null ? n.fy * H : (n.y ?? 0.1) * (H / 220),
        n,
      }));
      const byId: Record<string, any> = {}; pos.forEach((p) => (byId[p.n.id] = p));
      // pipes (quadratic curves + flow particles)
      edges.forEach((e) => {
        const a = byId[e.from], b = byId[e.to]; if (!a || !b) return;
        const cpx = (a.x + b.x) / 2, cpy = (a.y + b.y) / 2 + (Math.abs(a.y - b.y) < 10 ? 0 : (a.y < b.y ? -15 : 15));
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(cpx, cpy, b.x, b.y);
        ctx.strokeStyle = "#252a36"; ctx.lineWidth = 3; ctx.stroke();
        const col = b.n.col ?? T.teal;
        for (let i = 0; i < 3; i++) {
          const t = ((frame * 0.007 + i * 0.33) % 1);
          const px = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * cpx + t * t * b.x;
          const py = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * cpy + t * t * b.y;
          ctx.beginPath(); ctx.arc(px, py, 1.8, 0, Math.PI * 2); ctx.fillStyle = hexRgba(col, 0.7 - t * 0.5); ctx.fill();
        }
      });
      // nodes
      pos.forEach(({ x, y, n }) => {
        const type = n.kind ?? n.type ?? "tank";
        const col = n.col ?? (type === "reactor" ? T.gold : type === "mixer" || type === "pump" ? T.teal : type === "filler" ? T.gold : T.cyan);
        const sz = type === "reactor" ? 20 : (type === "mixer" || type === "pump") ? 17 : 15;
        // glow
        ctx.beginPath(); ctx.arc(x, y, sz + 5, 0, Math.PI * 2); ctx.fillStyle = hexRgba(col, 0.06); ctx.fill();
        // shape
        ctx.beginPath();
        if (type === "tank") { const rw = sz * 1.3, rh = sz; roundRect(ctx, x - rw / 2, y - rh / 2, rw, rh, 4); }
        else if (type === "reactor") { for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; const px = x + sz * Math.cos(a), py = y + sz * Math.sin(a); i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); } ctx.closePath(); }
        else if (type === "box") { roundRect(ctx, x - sz, y - sz * 0.7, sz * 2, sz * 1.4, 3); }
        else { ctx.arc(x, y, sz, 0, Math.PI * 2); }
        ctx.fillStyle = "#151820"; ctx.fill();
        const statusCol = n.status === "warning" ? T.amber : n.status === "fault" ? T.red : hexRgba(col, 0.5);
        ctx.strokeStyle = statusCol; ctx.lineWidth = 1.5; ctx.stroke();
        // inner symbol
        ctx.fillStyle = col; ctx.font = `700 ${type === "reactor" ? 10 : 9}px 'Rajdhani',sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        const sym = ({ tank: "T", mixer: "M", pump: "M", reactor: "R", filler: "F", box: "P" } as any)[type] ?? "?";
        ctx.fillText(sym, x, y + 1);
        // labels
        const label = n.label ?? n.id; const sub = n.sub ?? "";
        ctx.fillStyle = T.textPri; ctx.font = "600 10px 'Rajdhani',sans-serif"; ctx.textBaseline = "top";
        ctx.fillText(String(label).split("\n")[0], x, y + sz + 6);
        if (sub) { ctx.fillStyle = T.textMuted; ctx.font = "500 8px 'Source Sans 3',sans-serif"; ctx.fillText(sub, x, y + sz + 18); }
        // live/demo value chip
        const lv = !globalDemo && n.value_tag ? liveRef.current[n.value_tag] : undefined;
        const num: any = lv ? lv.value : n.demo;
        if (num != null) {
          const disp = typeof num === "number" ? (Math.abs(num) >= 1000 ? num.toFixed(0) : num.toFixed(1)) : num;
          ctx.fillStyle = lv ? T.teal : T.gold; ctx.font = "700 9px 'Rajdhani',sans-serif"; ctx.textBaseline = "bottom";
          ctx.fillText(`${disp}${n.unit ?? ""}`, x, y - sz - 4);
          if (lv) { ctx.beginPath(); ctx.arc(x + sz - 2, y - sz + 2, 2, 0, Math.PI * 2); ctx.fillStyle = T.teal; ctx.fill(); }
        }
        // reactor agitator animation
        if (type === "reactor") {
          ctx.save(); ctx.translate(x, y); ctx.rotate(frame * 0.05);
          ctx.beginPath(); ctx.moveTo(-12, 0); ctx.lineTo(12, 0);
          ctx.strokeStyle = hexRgba(col, 0.4); ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.stroke();
          ctx.beginPath(); ctx.moveTo(-8, -4); ctx.lineTo(-8, 4); ctx.moveTo(8, -4); ctx.lineTo(8, 4); ctx.stroke();
          ctx.restore();
        }
      });
      frame++;
      raf = requestAnimationFrame(draw);
    };
    function roundRect(cc: CanvasRenderingContext2D, x: number, y: number, w2: number, h2: number, rr: number) {
      cc.moveTo(x + rr, y); cc.arcTo(x + w2, y, x + w2, y + h2, rr); cc.arcTo(x + w2, y + h2, x, y + h2, rr);
      cc.arcTo(x, y + h2, x, y, rr); cc.arcTo(x, y, x + w2, y, rr);
    }
    draw();
    return () => cancelAnimationFrame(raf);
  }, [nodes, edges, globalDemo]);

  return (
    <div style={card}>
      <div style={titleRow}><span style={titleTxt}>{w.title}</span>{anyLive ? <LiveDot /> : <DemoBadge />}</div>
      <div style={{ flex: 1, minHeight: 200, position: "relative" }}><canvas ref={ref} /></div>
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
