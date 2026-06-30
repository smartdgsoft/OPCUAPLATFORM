import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Brain, Plus, Trash2, X, Check, ChevronLeft, Play, History as HistoryIcon,
  RotateCcw, CheckCircle2, Activity, AlertTriangle, GitBranch, Cpu,
} from "lucide-react";
import {
  fetchPredModels, fetchPredMethods, createPredModel, deletePredModel,
  fetchPredVersions, trainPredModel, activatePredVersion, rollbackPredModel,
  fetchPredAudit, fetchPredDrift, fetchTwins,
  type PredModel, type PredMethod, type PredVersion, type PredModelInput,
} from "../services/api";
import { useFeatures } from "../hooks/useFeatures";

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
  background: "#fff", borderRadius: 12, padding: 24, width: 500, maxWidth: "94vw",
  maxHeight: "90vh", overflow: "auto", boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
};
const card: React.CSSProperties = {
  background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", padding: 18,
};

const STATUS_COLOR: Record<string, string> = {
  active: "#22c55e", trained: "#0ea5e9", retired: "#94a3b8", failed: "#dc2626",
};

export default function PredictivePage() {
  const features = useFeatures();
  const [selected, setSelected] = useState<string | null>(null);

  if (!features.twin_predictive) {
    return (
      <div>
        <PageHeader />
        <div style={{ ...card, padding: 40, textAlign: "center", color: "#64748b" }}>
          <Brain size={40} style={{ display: "block", margin: "0 auto 16px", opacity: 0.3 }} />
          <div style={{ fontSize: 15, fontWeight: 600, color: "#1e293b", marginBottom: 8 }}>
            Predictive module is not enabled
          </div>
          <p style={{ fontSize: 13, maxWidth: 480, margin: "0 auto" }}>
            Set <code style={{ background: "#f1f5f9", padding: "2px 6px", borderRadius: 4 }}>FEATURE_TWIN_PREDICTIVE=true</code> and
            start the twin-predictive service. Requires the Digital Twin module and at least one twin with signals.
          </p>
        </div>
      </div>
    );
  }

  return selected
    ? <ModelDetail modelId={selected} onBack={() => setSelected(null)} />
    : <ModelList onOpen={setSelected} />;
}

function PageHeader() {
  return (
    <div style={{ marginBottom: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#0f172a",
        display: "flex", alignItems: "center", gap: 10 }}>
        <Brain size={22} color="#7c3aed" /> Predictive Models
      </h1>
      <p style={{ color: "#64748b", fontSize: 14, marginTop: 4 }}>
        Train, version, and operate anomaly &amp; prediction models on your twins
      </p>
    </div>
  );
}

// ── Model list ──────────────────────────────────────────────────────────────
function ModelList({ onOpen }: { onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [err, setErr] = useState("");

  const { data: models = [] } = useQuery({ queryKey: ["pred-models"], queryFn: () => fetchPredModels(), refetchInterval: 5000 });
  const { data: methods = [] } = useQuery({ queryKey: ["pred-methods"], queryFn: fetchPredMethods });
  const { data: twins = [] } = useQuery({ queryKey: ["twins"], queryFn: fetchTwins });

  const createMut = useMutation({
    mutationFn: (b: PredModelInput) => createPredModel(b),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["pred-models"] }); setShowAdd(false); setErr(""); },
    onError: (e: any) => setErr(e?.response?.data?.detail ?? "Failed to create model"),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deletePredModel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pred-models"] }),
  });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start" }}>
        <div style={{ flex: 1 }}><PageHeader /></div>
        <button style={btn("#7c3aed")} onClick={() => { setErr(""); setShowAdd(true); }}>
          <Plus size={16} /> New Model
        </button>
      </div>

      {models.length === 0 ? (
        <div style={{ ...card, padding: 48, textAlign: "center", color: "#94a3b8" }}>
          <Brain size={40} style={{ display: "block", margin: "0 auto 12px", opacity: 0.3 }} />
          No predictive models yet. Create one on a twin that has signals and history.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 16 }}>
          {models.map((m) => (
            <div key={m.id} style={{ ...card, cursor: "pointer" }} onClick={() => onOpen(m.id)}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <div style={{ width: 40, height: 40, borderRadius: 8, flexShrink: 0,
                  background: "#f5f3ff", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Cpu size={20} color="#7c3aed" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: "#1e293b" }}>{m.name}</div>
                  <div style={{ fontSize: 12, color: "#94a3b8" }}>{m.twin_name} · {m.method}</div>
                </div>
                <button title="Delete" style={{ ...iconBtn, color: "#dc2626" }}
                  onClick={(e) => { e.stopPropagation();
                    if (confirm(`Delete model "${m.name}" and all its versions?`)) deleteMut.mutate(m.id); }}>
                  <Trash2 size={14} />
                </button>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {m.active_version != null ? (
                  <span style={{ ...badge("#22c55e") }}>
                    <CheckCircle2 size={11} /> v{m.active_version} active
                  </span>
                ) : (
                  <span style={{ ...badge("#94a3b8") }}>not trained</span>
                )}
                <span style={{ ...badge("#0ea5e9") }}>{m.version_count} version{m.version_count !== 1 ? "s" : ""}</span>
                {!m.enabled && <span style={{ ...badge("#f59e0b") }}>disabled</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <CreateModelModal methods={methods} twins={twins} error={err}
          busy={createMut.isPending}
          onCancel={() => { setShowAdd(false); setErr(""); }}
          onSubmit={(b) => createMut.mutate(b)} />
      )}
    </div>
  );
}

function badge(color: string): React.CSSProperties {
  return { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 500,
    padding: "3px 8px", borderRadius: 12, background: `${color}18`, color };
}

function CreateModelModal({ methods, twins, error, busy, onCancel, onSubmit }: {
  methods: PredMethod[];
  twins: { id: string; name: string; asset_name: string }[];
  error: string; busy: boolean;
  onCancel: () => void; onSubmit: (b: PredModelInput) => void;
}) {
  const [twinId, setTwinId] = useState("");
  const [name, setName] = useState("");
  const [method, setMethod] = useState(methods[0]?.key ?? "univariate_drift");
  const [trainWindow, setTrainWindow] = useState(168);
  const [scoreInterval, setScoreInterval] = useState(30);
  const [retrainHours, setRetrainHours] = useState("");

  const selectedMethod = methods.find((m) => m.key === method);

  return (
    <div style={overlay} onClick={onCancel}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>New Predictive Model</h2>
          <button style={iconBtn} onClick={onCancel}><X size={16} /></button>
        </div>

        <label style={lbl}>Twin *</label>
        <select style={{ ...inp, marginBottom: 12 }} value={twinId} onChange={(e) => setTwinId(e.target.value)}>
          <option value="">— Select a twin —</option>
          {twins.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.asset_name})</option>)}
        </select>

        <label style={lbl}>Model name *</label>
        <input style={{ ...inp, marginBottom: 12 }} value={name} autoFocus
          onChange={(e) => setName(e.target.value)} placeholder="e.g. Adhesive Drift Monitor" />

        <label style={lbl}>Method *</label>
        <select style={{ ...inp, marginBottom: 6 }} value={method} onChange={(e) => setMethod(e.target.value)}>
          {methods.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
        </select>
        {selectedMethod && (
          <div style={{ fontSize: 12, color: "#64748b", background: "#f8fafc", borderRadius: 6,
            padding: "8px 10px", marginBottom: 12 }}>
            {selectedMethod.description}
            <div style={{ marginTop: 4, color: "#94a3b8" }}>
              Needs ≥ {selectedMethod.min_signals} signal{selectedMethod.min_signals !== 1 ? "s" : ""} ·
              {selectedMethod.needs_labels ? " requires labelled failures" : " no labels required"}
            </div>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div><label style={lbl}>Train window (hours)</label>
            <input style={inp} type="number" value={trainWindow} onChange={(e) => setTrainWindow(+e.target.value)} /></div>
          <div><label style={lbl}>Score interval (s)</label>
            <input style={inp} type="number" value={scoreInterval} onChange={(e) => setScoreInterval(+e.target.value)} /></div>
        </div>

        <label style={lbl}>Auto-retrain every (hours, blank = manual only)</label>
        <input style={{ ...inp, marginBottom: 16 }} type="number" value={retrainHours}
          onChange={(e) => setRetrainHours(e.target.value)} placeholder="manual only" />

        {error && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button style={btn("#f1f5f9", "#334155")} onClick={onCancel}>Cancel</button>
          <button style={btn("#7c3aed")} disabled={busy || !twinId || !name.trim()}
            onClick={() => onSubmit({
              twin_id: twinId, name: name.trim(), method,
              train_window_hours: trainWindow, score_interval_s: scoreInterval,
              retrain_cron: retrainHours.trim() || null,
            })}>
            <Check size={16} /> Create
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Model detail ────────────────────────────────────────────────────────────
function ModelDetail({ modelId, onBack }: { modelId: string; onBack: () => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"versions" | "audit" | "drift">("versions");

  const { data: models = [] } = useQuery({ queryKey: ["pred-models"], queryFn: () => fetchPredModels() });
  const model = models.find((m) => m.id === modelId);
  const { data: versions = [] } = useQuery({ queryKey: ["pred-versions", modelId], queryFn: () => fetchPredVersions(modelId), refetchInterval: 4000 });
  const { data: audit = [] } = useQuery({ queryKey: ["pred-audit", modelId], queryFn: () => fetchPredAudit(modelId), enabled: tab === "audit" });
  const { data: drift = [] } = useQuery({ queryKey: ["pred-drift", modelId], queryFn: () => fetchPredDrift(modelId), enabled: tab === "drift" });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["pred-versions", modelId] });
    qc.invalidateQueries({ queryKey: ["pred-models"] });
  };

  const trainMut = useMutation({
    mutationFn: () => trainPredModel(modelId),
    onSuccess: () => { setTimeout(invalidate, 1500); },
    onError: (e: any) => alert(e?.response?.data?.detail ?? "Train request failed"),
  });
  const activateMut = useMutation({
    mutationFn: (versionId: string) => activatePredVersion(modelId, versionId), onSuccess: invalidate,
  });
  const rollbackMut = useMutation({
    mutationFn: () => rollbackPredModel(modelId), onSuccess: invalidate,
    onError: (e: any) => alert(e?.response?.data?.detail ?? "Rollback failed"),
  });

  return (
    <div>
      <button style={{ ...btn("#f1f5f9", "#334155"), marginBottom: 16 }} onClick={onBack}>
        <ChevronLeft size={16} /> All models
      </button>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <div style={{ width: 44, height: 44, borderRadius: 10, background: "#f5f3ff",
          display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Brain size={22} color="#7c3aed" />
        </div>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#0f172a" }}>{model?.name ?? "Model"}</h1>
          <p style={{ color: "#64748b", fontSize: 14, margin: "2px 0 0" }}>
            {model?.twin_name} · {model?.method}
            {model?.active_version != null && <> · <span style={{ color: "#16a34a", fontWeight: 500 }}>v{model.active_version} active</span></>}
          </p>
        </div>
        <button style={btn("#f1f5f9", "#334155")} disabled={rollbackMut.isPending} onClick={() => rollbackMut.mutate()}>
          <RotateCcw size={15} /> Rollback
        </button>
        <button style={btn("#7c3aed")} disabled={trainMut.isPending} onClick={() => trainMut.mutate()}>
          <Play size={15} /> {trainMut.isPending ? "Requesting…" : "Train new version"}
        </button>
      </div>

      {trainMut.isSuccess && (
        <div style={{ ...card, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: "#0369a1",
          background: "#eff6ff", borderColor: "#bae6fd" }}>
          Training requested — the predictive service is fitting a new version. It will appear below shortly.
        </div>
      )}

      <div style={{ display: "flex", gap: 2, borderBottom: "1px solid #e2e8f0", marginBottom: 16 }}>
        {([["versions", "Versions"], ["audit", "Audit Log"], ["drift", "Model Drift"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            style={{ padding: "8px 16px", border: "none", background: "none", fontSize: 13, cursor: "pointer",
              fontWeight: tab === k ? 600 : 400, color: tab === k ? "#7c3aed" : "#64748b",
              borderBottom: `2px solid ${tab === k ? "#7c3aed" : "transparent"}`, marginBottom: -1 }}>
            {label}
          </button>
        ))}
      </div>

      {tab === "versions" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {versions.length === 0 ? (
            <div style={{ ...card, padding: 32, textAlign: "center", color: "#94a3b8" }}>
              <GitBranch size={32} style={{ display: "block", margin: "0 auto 10px", opacity: 0.3 }} />
              No versions yet. Click “Train new version” to fit the first model from history.
            </div>
          ) : versions.map((v) => (
            <VersionRow key={v.id} v={v} onActivate={() => activateMut.mutate(v.id)} />
          ))}
        </div>
      )}

      {tab === "audit" && (
        <div style={card}>
          {audit.length === 0 ? (
            <div style={{ color: "#94a3b8", fontSize: 13, padding: 12 }}>No audit entries yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {audit.map((a, i) => (
                <div key={i} style={{ display: "flex", gap: 12, padding: "8px 4px",
                  borderBottom: "1px solid #f1f5f9", fontSize: 13 }}>
                  <span style={{ ...badge("#7c3aed"), minWidth: 90, justifyContent: "center" }}>{a.event}</span>
                  <span style={{ flex: 1, color: "#475569" }}>{a.detail}</span>
                  <span style={{ color: "#94a3b8" }}>{a.actor}</span>
                  <span style={{ color: "#cbd5e1" }}>{new Date(a.created_at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "drift" && (
        <div style={card}>
          {drift.length === 0 ? (
            <div style={{ color: "#94a3b8", fontSize: 13, padding: 12 }}>
              No drift records yet. The service records input-distribution drift while scoring.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {drift.map((d, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 4px",
                  borderBottom: "1px solid #f1f5f9", fontSize: 13 }}>
                  {d.drifted
                    ? <AlertTriangle size={15} color="#f59e0b" />
                    : <Activity size={15} color="#22c55e" />}
                  <span style={{ flex: 1, color: "#475569" }}>
                    drift score {d.drift_score?.toFixed(2)} {d.drifted && <strong style={{ color: "#d97706" }}>— drifted</strong>}
                  </span>
                  <span style={{ color: "#cbd5e1" }}>{new Date(d.created_at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function VersionRow({ v, onActivate }: { v: PredVersion; onActivate: () => void }) {
  const color = STATUS_COLOR[v.status] || "#94a3b8";
  return (
    <div style={{ ...card, display: "flex", alignItems: "center", gap: 14 }}>
      <div style={{ width: 44, height: 44, borderRadius: 10, flexShrink: 0,
        background: `${color}18`, display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 14, fontWeight: 700, color }}>
        v{v.version}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ ...badge(color), textTransform: "capitalize" }}>{v.status}</span>
          {v.train_sample_count != null && (
            <span style={{ fontSize: 12, color: "#94a3b8" }}>{v.train_sample_count.toLocaleString()} samples</span>
          )}
        </div>
        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>
          {v.notes} {v.trained_at && <>· {new Date(v.trained_at).toLocaleString()}</>} {v.trained_by && <>· by {v.trained_by}</>}
        </div>
      </div>
      {v.status !== "active" && (
        <button style={btn("#f5f3ff", "#7c3aed")} onClick={onActivate}>
          <CheckCircle2 size={14} /> Activate
        </button>
      )}
    </div>
  );
}
