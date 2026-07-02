import React, { useState, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchDashboards, fetchDashboard, updateDashboard, createDashboard, deleteDashboard,
  seedFevicolDashboard, fetchTags,
  type DashboardSummary, type Dashboard, type DashboardWidget,
} from "../services/api";
import { Widget, T } from "../components/dashboard/DashboardWidgets";
import { DemoModeContext, useDashboardTagCount } from "../hooks/useBinding";
import {
  LayoutGrid, Plus, Pencil, Trash2, Save, X, Sparkles, Monitor, Settings2, Check,
} from "lucide-react";

const WIDGET_TYPES = ["kpi", "gauge", "trend", "alarm_list", "equipment_list", "batch_bar", "schematic", "text"];

export default function DashboardsPage() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: list = [] } = useQuery({ queryKey: ["dashboards"], queryFn: fetchDashboards });

  // auto-select default/first
  const activeId = selectedId ?? list.find((d) => d.is_default)?.id ?? list[0]?.id ?? null;

  const seedMut = useMutation({
    mutationFn: seedFevicolDashboard,
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["dashboards"] }); setSelectedId(r.id); },
  });

  if (!list.length) {
    return (
      <div style={{ background: "#0e1015", minHeight: "calc(100vh - 60px)", margin: -24, padding: 40, color: T.textPri }}>
        <EmptyState onSeed={() => seedMut.mutate()} seeding={seedMut.isPending} />
      </div>
    );
  }

  return (
    <div style={{ background: "#0e1015", minHeight: "calc(100vh - 60px)", margin: -24, color: T.textPri, display: "flex" }}>
      {/* dashboard switcher rail */}
      <div style={{ width: 210, borderRight: `1px solid ${T.border}`, padding: 12, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: T.textSec, fontFamily: "'Rajdhani',sans-serif" }}>Dashboards</span>
          <button title="New" onClick={() => createDashboard({ name: "New Dashboard", layout: { grid: { cols: 12, row_height: 38 }, widgets: [] } }).then((r) => { qc.invalidateQueries({ queryKey: ["dashboards"] }); setSelectedId(r.id); })}
            style={iconBtn}><Plus size={14} /></button>
        </div>
        {list.map((d) => (
          <div key={d.id} onClick={() => setSelectedId(d.id)}
            style={{ padding: "8px 10px", borderRadius: 8, cursor: "pointer", marginBottom: 4,
              background: d.id === activeId ? "rgba(232,168,48,0.12)" : "transparent",
              color: d.id === activeId ? T.gold : T.textSec, fontSize: 13,
              boxShadow: d.id === activeId ? `inset 2px 0 0 ${T.gold}` : "none" }}>
            {d.name}{d.is_default ? <span style={{ fontSize: 9, marginLeft: 6, color: T.textMuted }}>default</span> : null}
          </div>
        ))}
        <button onClick={() => seedMut.mutate()} disabled={seedMut.isPending}
          style={{ ...iconBtn, width: "100%", marginTop: 10, gap: 6, fontSize: 12, color: T.textMuted }}>
          <Sparkles size={13} /> Seed Fevicol demo
        </button>
      </div>
      {activeId ? <DashboardView key={activeId} id={activeId} /> : null}
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "6px 8px",
  borderRadius: 6, border: `1px solid ${T.border}`, background: T.bgCard, color: T.textSec, cursor: "pointer", fontSize: 13,
};
const primaryBtn: React.CSSProperties = { ...iconBtn, background: T.gold, color: "#0e1015", border: "none", fontWeight: 600, gap: 6 };

function EmptyState({ onSeed, seeding }: { onSeed: () => void; seeding: boolean }) {
  return (
    <div style={{ maxWidth: 520, margin: "60px auto", textAlign: "center" }}>
      <Monitor size={44} color={T.gold} style={{ marginBottom: 16 }} />
      <h1 style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 26, fontWeight: 700, margin: "0 0 8px" }}>Operations Dashboards</h1>
      <p style={{ color: T.textSec, fontSize: 14, marginBottom: 24 }}>
        Config-driven screens that bind to your live tags, history, alarms, and assets.
        Nothing is hardcoded — build your own, or start from the Fevicol demo.
      </p>
      <button onClick={onSeed} disabled={seeding} style={{ ...primaryBtn, margin: "0 auto", padding: "10px 18px" }}>
        <Sparkles size={16} /> {seeding ? "Seeding…" : "Create Fevicol demo dashboard"}
      </button>
    </div>
  );
}

function DashboardView({ id }: { id: string }) {
  const qc = useQueryClient();
  const { data: dash } = useQuery({ queryKey: ["dashboard", id], queryFn: () => fetchDashboard(id) });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Dashboard | null>(null);
  const [drag, setDrag] = useState<{ id: string } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const tagCount = useDashboardTagCount(dash?.layout);

  const saveMut = useMutation({
    mutationFn: (d: Dashboard) => updateDashboard(id, { name: d.name, demo_mode: d.demo_mode, layout: d.layout }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["dashboard", id] }); qc.invalidateQueries({ queryKey: ["dashboards"] }); setEditing(false); setDraft(null); },
  });

  if (!dash) return <div style={{ padding: 40, color: T.textMuted }}>Loading…</div>;
  const model = editing && draft ? draft : dash;
  const rowH = model.layout.grid.row_height ?? 38;
  const cols = model.layout.grid.cols ?? 12;

  const beginEdit = () => { setDraft(JSON.parse(JSON.stringify(dash))); setEditing(true); };
  const updateWidget = (wid: string, patch: Partial<DashboardWidget>) =>
    setDraft((d) => d ? { ...d, layout: { ...d.layout, widgets: d.layout.widgets.map((w) => w.id === wid ? { ...w, ...patch } : w) } } : d);
  const addWidget = (type: string) => setDraft((d) => {
    if (!d) return d;
    const maxY = d.layout.widgets.reduce((m, w) => Math.max(m, w.pos.y + w.pos.h), 0);
    const nw: DashboardWidget = { id: "w" + Date.now(), type, title: type.replace("_", " "),
      pos: { x: 0, y: maxY, w: type === "trend" || type === "schematic" ? 6 : 2, h: type === "batch_bar" ? 2 : 3 },
      binding: { mode: type === "alarm_list" ? "alarms" : type === "equipment_list" ? "assets" : type === "trend" ? "history" : "live" }, demo: {} };
    return { ...d, layout: { ...d.layout, widgets: [...d.layout.widgets, nw] } };
  });
  const removeWidget = (wid: string) => setDraft((d) => d ? { ...d, layout: { ...d.layout, widgets: d.layout.widgets.filter((w) => w.id !== wid) } } : d);

  // ── mouse drag-move / resize with grid snapping ──
  const startDrag = (e: React.MouseEvent, w: DashboardWidget, mode: "move" | "resize") => {
    // ignore drags that start on interactive controls (buttons/inputs/selects)
    const tgt = e.target as HTMLElement;
    if (tgt.closest("button, input, select, textarea")) return;
    e.preventDefault();
    const gridEl = gridRef.current; if (!gridEl) return;
    const rect = gridEl.getBoundingClientRect();
    const gap = 12;
    const cellW = (rect.width - gap * (cols - 1)) / cols;
    const cellH = rowH;
    const startX = e.clientX, startY = e.clientY;
    const orig = { ...w.pos };
    setDrag({ id: w.id });
    const onMove = (ev: MouseEvent) => {
      const dxCells = Math.round((ev.clientX - startX) / (cellW + gap));
      const dyCells = Math.round((ev.clientY - startY) / (cellH + gap));
      if (mode === "move") {
        const nx = Math.max(0, Math.min(cols - orig.w, orig.x + dxCells));
        const ny = Math.max(0, orig.y + dyCells);
        updateWidget(w.id, { pos: { ...orig, x: nx, y: ny } });
      } else {
        const nw2 = Math.max(1, Math.min(cols - orig.x, orig.w + dxCells));
        const nh2 = Math.max(1, orig.h + dyCells);
        updateWidget(w.id, { pos: { ...orig, w: nw2, h: nh2 } });
      }
    };
    const onUp = () => { setDrag(null); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <DemoModeContext.Provider value={model.demo_mode}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: `1px solid ${T.border}`, background: "linear-gradient(180deg,#151820,#0e1015)" }}>
          <div>
            <h1 style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 22, fontWeight: 700, margin: 0 }}>{model.layout.header?.title ?? model.name}</h1>
            {model.layout.header?.subtitle ? <p style={{ fontSize: 11, color: T.textMuted, margin: "2px 0 0" }}>{model.layout.header.subtitle}</p> : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 11, color: T.textMuted }}>{tagCount} live tags bound</span>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: T.textSec, cursor: "pointer" }}>
              <input type="checkbox" checked={model.demo_mode}
                onChange={(e) => editing ? setDraft((d) => d ? { ...d, demo_mode: e.target.checked } : d) : saveMut.mutate({ ...dash, demo_mode: e.target.checked })} />
              Demo mode
            </label>
            {editing ? (
              <>
                <button style={iconBtn} onClick={() => { setEditing(false); setDraft(null); }}><X size={14} /> Cancel</button>
                <button style={primaryBtn} onClick={() => draft && saveMut.mutate(draft)}><Save size={14} /> Save</button>
              </>
            ) : (
              <button style={iconBtn} onClick={beginEdit}><Pencil size={14} /> Edit</button>
            )}
          </div>
        </div>

        {/* editor toolbar */}
        {editing ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 18px", borderBottom: `1px solid ${T.border}`, background: T.bgCard, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: T.textMuted }}>Add widget:</span>
            {WIDGET_TYPES.map((t) => (
              <button key={t} onClick={() => addWidget(t)} style={{ ...iconBtn, fontSize: 11, padding: "4px 8px" }}>+ {t.replace("_", " ")}</button>
            ))}
          </div>
        ) : null}

        {/* grid */}
        <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
          <div ref={gridRef} style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gridAutoRows: `${rowH}px`, gap: 12, position: "relative" }}>
            {model.layout.widgets.map((w) => (
              <div key={w.id}
                onMouseDown={editing ? (e) => startDrag(e, w, "move") : undefined}
                style={{ gridColumn: `${w.pos.x + 1} / span ${w.pos.w}`, gridRow: `${w.pos.y + 1} / span ${w.pos.h}`, position: "relative",
                  cursor: editing ? (drag?.id === w.id ? "grabbing" : "grab") : "default",
                  outline: editing ? `1px dashed ${T.borderLight}` : "none", outlineOffset: 2,
                  opacity: drag?.id === w.id ? 0.85 : 1 }}>
                <Widget w={w} />
                {editing ? <WidgetEditOverlay w={w} onChange={(p) => updateWidget(w.id, p)} onRemove={() => removeWidget(w.id)} cols={cols} /> : null}
                {editing ? (
                  <div onMouseDown={(e) => { e.stopPropagation(); startDrag(e, w, "resize"); }}
                    style={{ position: "absolute", right: 0, bottom: 0, width: 16, height: 16, cursor: "nwse-resize", zIndex: 6,
                      background: `linear-gradient(135deg, transparent 50%, ${T.gold} 50%)`, borderBottomRightRadius: 10 }} />
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </DemoModeContext.Provider>
  );
}

// overlay shown in edit mode: move/resize by number, bind a tag, delete
function WidgetEditOverlay({ w, onChange, onRemove, cols }: { w: DashboardWidget; onChange: (p: Partial<DashboardWidget>) => void; onRemove: () => void; cols: number }) {
  const [open, setOpen] = useState(false);
  const { data: tags = [] } = useQuery({ queryKey: ["all-tags"], queryFn: () => fetchTags(), enabled: open });
  const setPos = (k: "x" | "y" | "w" | "h", v: number) => onChange({ pos: { ...w.pos, [k]: Math.max(k === "w" || k === "h" ? 1 : 0, v) } });
  return (
    <>
      <div style={{ position: "absolute", top: 4, right: 4, display: "flex", gap: 4, zIndex: 5 }}>
        <button style={{ ...iconBtn, padding: "3px 5px", background: T.bgElevated }} onClick={() => setOpen((o) => !o)}><Settings2 size={12} /></button>
        <button style={{ ...iconBtn, padding: "3px 5px", background: T.bgElevated, color: T.red }} onClick={onRemove}><Trash2 size={12} /></button>
      </div>
      {open ? (
        <div onMouseDown={(e) => e.stopPropagation()} style={{ position: "absolute", top: 30, right: 4, width: 240, background: T.bgElevated, border: `1px solid ${T.borderLight}`, borderRadius: 8, padding: 12, zIndex: 20, boxShadow: "0 8px 30px rgba(0,0,0,0.5)" }}>
          <div style={{ fontSize: 11, color: T.textSec, marginBottom: 6 }}>Title</div>
          <input value={w.title ?? ""} onChange={(e) => onChange({ title: e.target.value })} style={inp} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, margin: "10px 0" }}>
            {(["x", "y", "w", "h"] as const).map((k) => (
              <div key={k}><div style={{ fontSize: 10, color: T.textMuted, textTransform: "uppercase" }}>{k}</div>
                <input type="number" value={w.pos[k]} onChange={(e) => setPos(k, +e.target.value)} style={{ ...inp, padding: "4px 6px" }} /></div>
            ))}
          </div>
          {w.type === "schematic" ? (
            <>
              <div style={{ fontSize: 11, color: T.textSec, marginBottom: 4 }}>Bind each node to a tag</div>
              <div style={{ maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                {(w.options?.nodes ?? []).map((n: any) => (
                  <div key={n.id}>
                    <div style={{ fontSize: 10, color: T.textMuted }}>{(n.label ?? n.id).replace("\n", " ")}</div>
                    <select value={n.value_tag ?? ""} style={{ ...inp, padding: "4px 6px" }}
                      onChange={(e) => {
                        const nodes = (w.options?.nodes ?? []).map((x: any) => x.id === n.id ? { ...x, value_tag: e.target.value || null } : x);
                        onChange({ options: { ...w.options, nodes } });
                      }}>
                      <option value="">— demo —</option>
                      {tags.map((t: any) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
                    </select>
                  </div>
                ))}
              </div>
              <p style={{ fontSize: 10, color: T.textMuted, marginTop: 6 }}>Each bound node shows its live value with a dot; unbound nodes show demo values.</p>
            </>
          ) : (w.binding?.mode === "live" || w.type === "kpi" || w.type === "gauge") ? (
            <>
              <div style={{ fontSize: 11, color: T.textSec, marginBottom: 4 }}>Bind to tag (live)</div>
              <select value={w.binding?.tag_id ?? ""} onChange={(e) => onChange({ binding: { ...w.binding, mode: "live", tag_id: e.target.value || null } })} style={inp}>
                <option value="">— demo (unbound) —</option>
                {tags.map((t: any) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
              </select>
              <p style={{ fontSize: 10, color: T.textMuted, marginTop: 6 }}>Bound widgets show live data; unbound show demo values with a badge.</p>
            </>
          ) : (
            <p style={{ fontSize: 10, color: T.textMuted }}>This widget pulls from {w.binding?.mode}. It will show live data when that source produces, otherwise demo values.</p>
          )}
        </div>
      ) : null}
    </>
  );
}

const inp: React.CSSProperties = { width: "100%", padding: "6px 8px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.bgCard, color: T.textPri, fontSize: 12, boxSizing: "border-box" };
