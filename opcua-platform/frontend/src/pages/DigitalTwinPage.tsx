import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Boxes, Plus, Trash2, X, Check, Pencil, Sparkles, Activity,
  AlertTriangle, ChevronLeft, Gauge as GaugeIcon, Cpu,
} from "lucide-react";
import {
  fetchTwins, fetchTwin, createTwin, deleteTwin,
  addTwinSignal, updateTwinSignal, deleteTwinSignal, learnSignalNow, fetchTwinOutputs,
  fetchAssets, fetchTags,
  type TwinSummary, type TwinDetail, type TwinSignal, type TwinHealth, type SignalInput,
} from "../services/api";
import { useFeatures } from "../hooks/useFeatures";

const HEALTH_COLOR: Record<TwinHealth, string> = {
  good: "#22c55e", warning: "#f59e0b", bad: "#dc2626", stale: "#94a3b8", unknown: "#cbd5e1",
};
const HEALTH_LABEL: Record<TwinHealth, string> = {
  good: "Healthy", warning: "Warning", bad: "Out of range", stale: "Stale", unknown: "Unknown",
};

const btn = (bg: string, fg = "#fff"): React.CSSProperties => ({
  display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px",
  borderRadius: 6, border: "none", background: bg, color: fg,
  fontSize: 13, fontWeight: 500, cursor: "pointer",
});
const iconBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28,
  borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", color: "#64748b",
};
const inp: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #e2e8f0",
  fontSize: 13, boxSizing: "border-box",
};
const lbl: React.CSSProperties = { fontSize: 12, color: "#64748b", marginBottom: 4, display: "block" };
const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", display: "flex",
  alignItems: "center", justifyContent: "center", zIndex: 50,
};
const modal: React.CSSProperties = {
  background: "#fff", borderRadius: 12, padding: 24, width: 480, maxWidth: "94vw",
  maxHeight: "90vh", overflow: "auto", boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
};

export default function DigitalTwinPage() {
  const features = useFeatures();
  const [selected, setSelected] = useState<string | null>(null);

  if (!features.digital_twin) {
    return (
      <div>
        <Header />
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0",
          padding: 40, textAlign: "center", color: "#64748b" }}>
          <Boxes size={40} style={{ display: "block", margin: "0 auto 16px", opacity: 0.3 }} />
          <div style={{ fontSize: 15, fontWeight: 600, color: "#1e293b", marginBottom: 8 }}>
            Digital Twin module is not enabled
          </div>
          <p style={{ fontSize: 13, maxWidth: 460, margin: "0 auto" }}>
            Set <code style={{ background: "#f1f5f9", padding: "2px 6px", borderRadius: 4 }}>FEATURE_DIGITAL_TWIN=true</code> and
            start the twin-evaluator service to enable live asset twins.
          </p>
        </div>
      </div>
    );
  }

  return selected
    ? <TwinDetailView twinId={selected} onBack={() => setSelected(null)} />
    : <TwinList onOpen={setSelected} />;
}

function Header() {
  return (
    <div style={{ marginBottom: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#0f172a",
        display: "flex", alignItems: "center", gap: 10 }}>
        <Boxes size={22} color="#0ea5e9" /> Digital Twins
      </h1>
      <p style={{ color: "#64748b", fontSize: 14, marginTop: 4 }}>
        Live asset models with health monitoring against operating envelopes
      </p>
    </div>
  );
}

function HealthDot({ health, size = 10 }: { health: TwinHealth; size?: number }) {
  return <span style={{ width: size, height: size, borderRadius: "50%",
    background: HEALTH_COLOR[health], display: "inline-block", flexShrink: 0 }} />;
}

// ── Master list ─────────────────────────────────────────────────────────────
function TwinList({ onOpen }: { onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [err, setErr] = useState("");

  const { data: twins = [] } = useQuery({ queryKey: ["twins"], queryFn: fetchTwins, refetchInterval: 5000 });
  const { data: assets = [] } = useQuery({ queryKey: ["assets"], queryFn: fetchAssets });

  const createMut = useMutation({
    mutationFn: (b: { asset_id: string; name: string; description?: string }) => createTwin(b),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["twins"] }); setShowAdd(false); setErr(""); },
    onError: (e: any) => setErr(e?.response?.data?.detail ?? "Failed to create twin"),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteTwin(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["twins"] }),
  });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start" }}>
        <div style={{ flex: 1 }}><Header /></div>
        <button style={btn("#0ea5e9")} onClick={() => { setErr(""); setShowAdd(true); }}>
          <Plus size={16} /> New Twin
        </button>
      </div>

      {twins.length === 0 ? (
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0",
          padding: 48, textAlign: "center", color: "#94a3b8" }}>
          <Boxes size={40} style={{ display: "block", margin: "0 auto 12px", opacity: 0.3 }} />
          No twins yet. Click “New Twin” and attach it to an asset.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
          {twins.map((t) => (
            <div key={t.id} style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0",
              padding: 18, cursor: "pointer" }} onClick={() => onOpen(t.id)}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <div style={{ width: 40, height: 40, borderRadius: 8, flexShrink: 0,
                  background: `${HEALTH_COLOR[t.health]}18`, display: "flex",
                  alignItems: "center", justifyContent: "center" }}>
                  <Boxes size={20} color={HEALTH_COLOR[t.health]} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: "#1e293b" }}>{t.name}</div>
                  <div style={{ fontSize: 12, color: "#94a3b8" }}>{t.asset_name}</div>
                </div>
                <button title="Delete" style={{ ...iconBtn, color: "#dc2626" }}
                  onClick={(e) => { e.stopPropagation();
                    if (confirm(`Delete twin "${t.name}"?`)) deleteMut.mutate(t.id); }}>
                  <Trash2 size={14} />
                </button>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <HealthDot health={t.health} />
                <span style={{ fontSize: 13, fontWeight: 500, color: HEALTH_COLOR[t.health] }}>
                  {HEALTH_LABEL[t.health]}
                </span>
                <span style={{ fontSize: 12, color: "#94a3b8", marginLeft: "auto" }}>
                  {t.signal_count} signal{t.signal_count !== 1 ? "s" : ""}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <div style={overlay} onClick={() => setShowAdd(false)}>
          <div style={modal} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>New Digital Twin</h2>
              <button style={iconBtn} onClick={() => setShowAdd(false)}><X size={16} /></button>
            </div>
            <NewTwinForm assets={assets} error={err}
              busy={createMut.isPending} onSubmit={(b) => createMut.mutate(b)} />
          </div>
        </div>
      )}
    </div>
  );
}

function NewTwinForm({ assets, error, busy, onSubmit }: {
  assets: { id: string; name: string; level_id: number }[];
  error: string; busy: boolean;
  onSubmit: (b: { asset_id: string; name: string; description?: string }) => void;
}) {
  const [assetId, setAssetId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  return (
    <div>
      <label style={lbl}>Asset *</label>
      <select style={{ ...inp, marginBottom: 12 }} value={assetId} onChange={(e) => setAssetId(e.target.value)}>
        <option value="">— Select an asset —</option>
        {assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <label style={lbl}>Twin name *</label>
      <input style={{ ...inp, marginBottom: 12 }} value={name} autoFocus
        onChange={(e) => setName(e.target.value)} placeholder="e.g. Adhesive Line Twin" />
      <label style={lbl}>Description</label>
      <input style={{ ...inp, marginBottom: 16 }} value={description}
        onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
      {error && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>{error}</div>}
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button style={btn("#0ea5e9")} disabled={busy || !assetId || !name.trim()}
          onClick={() => onSubmit({ asset_id: assetId, name: name.trim(), description: description.trim() || undefined })}>
          <Check size={16} /> Create
        </button>
      </div>
    </div>
  );
}

// ── Detail view ─────────────────────────────────────────────────────────────
function TwinDetailView({ twinId, onBack }: { twinId: string; onBack: () => void }) {
  const qc = useQueryClient();
  const [addingSignal, setAddingSignal] = useState(false);
  const [editingSignal, setEditingSignal] = useState<TwinSignal | null>(null);

  const { data: twin } = useQuery({ queryKey: ["twin", twinId], queryFn: () => fetchTwin(twinId), refetchInterval: 4000 });
  const { data: tags = [] } = useQuery({ queryKey: ["tags"], queryFn: () => fetchTags() });
  const { data: outputs = [] } = useQuery({ queryKey: ["twin-outputs", twinId], queryFn: () => fetchTwinOutputs(twinId), refetchInterval: 8000 });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["twin", twinId] });

  const addMut = useMutation({
    mutationFn: (b: SignalInput) => addTwinSignal(twinId, b),
    onSuccess: () => { invalidate(); setAddingSignal(false); },
    onError: (e: any) => alert(e?.response?.data?.detail ?? "Failed to add signal"),
  });
  const updateMut = useMutation({
    mutationFn: ({ id, b }: { id: string; b: Partial<SignalInput> }) => updateTwinSignal(id, b),
    onSuccess: () => { invalidate(); setEditingSignal(null); },
  });
  const deleteSigMut = useMutation({
    mutationFn: (id: string) => deleteTwinSignal(id), onSuccess: invalidate,
  });
  const learnMut = useMutation({
    mutationFn: (id: string) => learnSignalNow(id),
    onSuccess: invalidate,
    onError: (e: any) => alert(e?.response?.data?.detail ?? "Could not learn — not enough history"),
  });

  if (!twin) return <div style={{ padding: 40, color: "#94a3b8" }}>Loading twin…</div>;

  const mappedTagIds = new Set(twin.signals.map((s) => s.tag_id));
  const availableTags = tags.filter((t) => !mappedTagIds.has(t.id));

  return (
    <div>
      <button style={{ ...btn("#f1f5f9", "#334155"), marginBottom: 16 }} onClick={onBack}>
        <ChevronLeft size={16} /> All twins
      </button>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <HealthDot health={twin.health} size={14} />
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#0f172a" }}>{twin.name}</h1>
          <p style={{ color: "#64748b", fontSize: 14, margin: "2px 0 0" }}>
            {twin.asset_name} · <span style={{ color: HEALTH_COLOR[twin.health], fontWeight: 500 }}>
              {HEALTH_LABEL[twin.health]}</span>
            {twin.evaluated_at && <> · updated {new Date(twin.evaluated_at).toLocaleTimeString()}</>}
          </p>
        </div>
        <button style={btn("#0ea5e9")} onClick={() => setAddingSignal(true)}>
          <Plus size={16} /> Add Signal
        </button>
      </div>

      {/* Live signal gauges */}
      {twin.signals.length === 0 ? (
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0",
          padding: 40, textAlign: "center", color: "#94a3b8", marginBottom: 20 }}>
          <Activity size={36} style={{ display: "block", margin: "0 auto 12px", opacity: 0.3 }} />
          No signals yet. Add a tag and define its operating envelope.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
          gap: 16, marginBottom: 24 }}>
          {twin.signals.map((s) => (
            <SignalGauge key={s.id} signal={s}
              onEdit={() => setEditingSignal(s)}
              onDelete={() => { if (confirm(`Remove signal "${s.label || s.display_name}"?`)) deleteSigMut.mutate(s.id); }}
              onLearn={() => learnMut.mutate(s.id)}
              learning={learnMut.isPending} />
          ))}
        </div>
      )}

      {/* Module outputs panel (the plugin seam) */}
      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <Cpu size={18} color="#7c3aed" />
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Module Outputs</h2>
          <span style={{ fontSize: 12, color: "#94a3b8" }}>
            predictions &amp; recommendations from on-demand modules
          </span>
        </div>
        {outputs.length === 0 ? (
          <div style={{ fontSize: 13, color: "#94a3b8", padding: "16px 0" }}>
            No module outputs. Predictive or closed-loop modules, when deployed for this twin,
            publish their results here.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {outputs.map((o) => (
              <div key={o.id} style={{ display: "flex", alignItems: "flex-start", gap: 10,
                padding: "10px 12px", borderRadius: 8, background: "#f8fafc" }}>
                <div style={{ fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 12,
                  background: o.severity === "critical" ? "#fef2f2" : o.severity === "warning" ? "#fffbeb" : "#eff6ff",
                  color: o.severity === "critical" ? "#dc2626" : o.severity === "warning" ? "#d97706" : "#2563eb" }}>
                  {o.output_type}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "#1e293b" }}>{o.title || o.module}</div>
                  {o.detail && <div style={{ fontSize: 12, color: "#64748b" }}>{o.detail}</div>}
                </div>
                {o.requires_approval && o.approved == null && (
                  <span style={{ fontSize: 11, color: "#92400e", background: "#fffbeb",
                    border: "1px solid #fde68a", borderRadius: 6, padding: "3px 8px" }}>
                    Awaiting approval
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {addingSignal && (
        <SignalModal mode="create" availableTags={availableTags} busy={addMut.isPending}
          onCancel={() => setAddingSignal(false)} onSubmit={(b) => addMut.mutate(b)} />
      )}
      {editingSignal && (
        <SignalModal mode="edit" signal={editingSignal} busy={updateMut.isPending}
          onCancel={() => setEditingSignal(null)}
          onSubmit={(b) => updateMut.mutate({ id: editingSignal.id, b })} />
      )}
    </div>
  );
}

function SignalGauge({ signal, onEdit, onDelete, onLearn, learning }: {
  signal: TwinSignal; onEdit: () => void; onDelete: () => void; onLearn: () => void; learning: boolean;
}) {
  const health = (signal.live_health || "unknown") as TwinHealth;
  const mode = signal.envelope_mode;
  const vmin = mode === "learned" ? signal.learned_min : signal.manual_min;
  const vmax = mode === "learned" ? signal.learned_max : signal.manual_max;
  const value = signal.live_value;
  const unit = signal.unit || signal.engineering_unit || "";

  // Position of the value within [min,max] as a 0..100% for the bar.
  let pct: number | null = null;
  if (typeof value === "number" && typeof vmin === "number" && typeof vmax === "number" && vmax > vmin) {
    pct = Math.max(0, Math.min(100, ((value - vmin) / (vmax - vmin)) * 100));
  }

  return (
    <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <HealthDot health={health} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#1e293b" }}>{signal.label || signal.display_name}</div>
          {signal.role && <div style={{ fontSize: 11, color: "#94a3b8" }}>{signal.role}</div>}
        </div>
        <button title="Edit envelope" style={iconBtn} onClick={onEdit}><Pencil size={13} /></button>
        <button title="Remove" style={{ ...iconBtn, color: "#dc2626" }} onClick={onDelete}><Trash2 size={13} /></button>
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 26, fontWeight: 700, color: HEALTH_COLOR[health] }}>
          {typeof value === "number" ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}
        </span>
        <span style={{ fontSize: 13, color: "#94a3b8" }}>{unit}</span>
        {signal.stale && <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: "auto" }}>stale</span>}
      </div>

      {/* Envelope bar */}
      <div style={{ position: "relative", height: 8, borderRadius: 4, background: "#f1f5f9", marginBottom: 6 }}>
        {pct != null && (
          <div style={{ position: "absolute", left: `${pct}%`, top: -3, width: 3, height: 14,
            borderRadius: 2, background: HEALTH_COLOR[health], transform: "translateX(-50%)" }} />
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#94a3b8" }}>
        <span>{typeof vmin === "number" ? vmin.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {mode === "learned" ? <><Sparkles size={11} /> learned</> : "manual"}
        </span>
        <span>{typeof vmax === "number" ? vmax.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}</span>
      </div>

      {mode === "learned" && (
        <button style={{ ...btn("#f5f3ff", "#7c3aed"), marginTop: 10, width: "100%", justifyContent: "center" }}
          disabled={learning} onClick={onLearn}>
          <Sparkles size={14} /> {learning ? "Learning…" : "Recompute from history"}
        </button>
      )}
    </div>
  );
}

function SignalModal({ mode, signal, availableTags, busy, onCancel, onSubmit }: {
  mode: "create" | "edit";
  signal?: TwinSignal;
  availableTags?: { id: string; display_name: string; node_id: string; engineering_unit?: string }[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (b: SignalInput) => void;
}) {
  const [tagId, setTagId] = useState(signal?.tag_id ?? "");
  const [role, setRole] = useState(signal?.role ?? "");
  const [label, setLabel] = useState(signal?.label ?? "");
  const [unit, setUnit] = useState(signal?.unit ?? signal?.engineering_unit ?? "");
  const [envMode, setEnvMode] = useState<"manual" | "learned">(signal?.envelope_mode ?? "manual");
  const [vmin, setVmin] = useState(signal?.manual_min ?? "");
  const [vmax, setVmax] = useState(signal?.manual_max ?? "");
  const [target, setTarget] = useState(signal?.manual_target ?? "");
  const [warn, setWarn] = useState(signal?.warn_fraction ?? 0.1);
  const [learnMethod, setLearnMethod] = useState(signal?.learn_method ?? "sigma");
  const [learnWindow, setLearnWindow] = useState(signal?.learn_window_hours ?? 168);
  const [learnK, setLearnK] = useState(signal?.learn_k ?? 3.0);

  const submit = () => {
    if (mode === "create" && !tagId) return;
    const body: SignalInput = {
      tag_id: tagId,
      role: role.trim() || null,
      label: label.trim() || null,
      unit: unit.trim() || null,
      envelope_mode: envMode,
      warn_fraction: Number(warn),
      learn_method: learnMethod,
      learn_window_hours: Number(learnWindow),
      learn_k: Number(learnK),
    };
    if (envMode === "manual") {
      body.manual_min = vmin === "" ? null : Number(vmin);
      body.manual_max = vmax === "" ? null : Number(vmax);
      body.manual_target = target === "" ? null : Number(target);
    }
    onSubmit(body);
  };

  return (
    <div style={overlay} onClick={onCancel}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>
            {mode === "create" ? "Add Signal" : "Edit Signal Envelope"}
          </h2>
          <button style={iconBtn} onClick={onCancel}><X size={16} /></button>
        </div>

        {mode === "create" && (
          <>
            <label style={lbl}>Tag *</label>
            <select style={{ ...inp, marginBottom: 12 }} value={tagId} onChange={(e) => setTagId(e.target.value)}>
              <option value="">— Select a tag —</option>
              {(availableTags || []).map((t) => (
                <option key={t.id} value={t.id}>{t.display_name} ({t.node_id})</option>
              ))}
            </select>
          </>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div>
            <label style={lbl}>Role (freeform)</label>
            <input style={inp} value={role} onChange={(e) => setRole(e.target.value)}
              placeholder="temperature, pressure…" list="twin-roles" />
            <datalist id="twin-roles">
              <option value="temperature" /><option value="pressure" /><option value="viscosity" />
              <option value="flow" /><option value="humidity" /><option value="status" /><option value="filter_dp" />
            </datalist>
          </div>
          <div>
            <label style={lbl}>Unit</label>
            <input style={inp} value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="°C, bar, cP…" />
          </div>
        </div>

        <label style={lbl}>Display label</label>
        <input style={{ ...inp, marginBottom: 12 }} value={label}
          onChange={(e) => setLabel(e.target.value)} placeholder="defaults to tag name" />

        <label style={lbl}>Envelope mode</label>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          {(["manual", "learned"] as const).map((m) => (
            <button key={m} onClick={() => setEnvMode(m)}
              style={{ flex: 1, padding: "8px", borderRadius: 6, fontSize: 13, cursor: "pointer",
                border: `1px solid ${envMode === m ? "#0ea5e9" : "#e2e8f0"}`,
                background: envMode === m ? "#eff6ff" : "#fff",
                color: envMode === m ? "#0369a1" : "#64748b", fontWeight: envMode === m ? 600 : 400 }}>
              {m === "manual" ? "Manual bounds" : "Learned from history"}
            </button>
          ))}
        </div>

        {envMode === "manual" ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
            <div><label style={lbl}>Min</label>
              <input style={inp} type="number" value={vmin} onChange={(e) => setVmin(e.target.value as any)} /></div>
            <div><label style={lbl}>Max</label>
              <input style={inp} type="number" value={vmax} onChange={(e) => setVmax(e.target.value as any)} /></div>
            <div><label style={lbl}>Target</label>
              <input style={inp} type="number" value={target} onChange={(e) => setTarget(e.target.value as any)} /></div>
          </div>
        ) : (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 8 }}>
              <div><label style={lbl}>Method</label>
                <select style={inp} value={learnMethod} onChange={(e) => setLearnMethod(e.target.value)}>
                  <option value="sigma">Mean ± k·σ</option>
                  <option value="percentile">Percentile band</option>
                </select></div>
              <div><label style={lbl}>Baseline window (h)</label>
                <input style={inp} type="number" value={learnWindow}
                  onChange={(e) => setLearnWindow(+e.target.value)} /></div>
            </div>
            {learnMethod === "sigma" && (
              <div><label style={lbl}>k (std multiplier)</label>
                <input style={inp} type="number" step="0.5" value={learnK}
                  onChange={(e) => setLearnK(+e.target.value)} /></div>
            )}
            <div style={{ fontSize: 12, color: "#7c3aed", background: "#f5f3ff", borderRadius: 6,
              padding: "8px 10px", marginTop: 8 }}>
              Bounds are computed from historical data by the evaluator. Use “Recompute from history”
              on the gauge after enough data has accumulated.
            </div>
          </div>
        )}

        <label style={lbl}>Warning band (fraction of span, 0–0.5)</label>
        <input style={{ ...inp, marginBottom: 16 }} type="number" step="0.05" min="0" max="0.5"
          value={warn} onChange={(e) => setWarn(+e.target.value as any)} />

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button style={btn("#f1f5f9", "#334155")} onClick={onCancel}>Cancel</button>
          <button style={btn("#0ea5e9")} disabled={busy || (mode === "create" && !tagId)} onClick={submit}>
            <Check size={16} /> {mode === "create" ? "Add Signal" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
