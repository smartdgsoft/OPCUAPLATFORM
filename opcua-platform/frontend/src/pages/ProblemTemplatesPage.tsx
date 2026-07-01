import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Boxes, Plus, Trash2, X, Check, ChevronLeft, Power, Activity, TrendingUp,
  Gauge, AlertTriangle, CheckCircle2, Sparkles, Pencil,
} from "lucide-react";
import {
  fetchProblemTemplates, fetchProblemInstances, createProblemInstance,
  updateProblemInstance, deleteProblemInstance, fetchProblemOutputs,
  fetchTags, fetchAssets, fetchServers,
  type ProblemTemplateType, type ProblemInstance, type ProblemOutput, type ProblemInstanceInput,
} from "../services/api";
import { useFeatures } from "../hooks/useFeatures";

const btn = (bg: string, fg = "#fff"): React.CSSProperties => ({
  display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px",
  borderRadius: 6, border: "none", background: bg, color: fg, fontSize: 13, fontWeight: 500, cursor: "pointer",
});
const iconBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28,
  borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", color: "#64748b",
};
const inp: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #e2e8f0", fontSize: 13, boxSizing: "border-box",
};
const lbl: React.CSSProperties = { fontSize: 12, color: "#64748b", marginBottom: 4, display: "block" };
const card: React.CSSProperties = { background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", padding: 18 };
const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", display: "flex",
  alignItems: "center", justifyContent: "center", zIndex: 50,
};
const modal: React.CSSProperties = {
  background: "#fff", borderRadius: 12, padding: 24, width: 620, maxWidth: "95vw",
  maxHeight: "92vh", overflow: "auto", boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
};

const MATURITY_COLOR: Record<string, string> = { cold_start: "#94a3b8", warming: "#f59e0b", mature: "#22c55e" };
const MATURITY_LABEL: Record<string, string> = { cold_start: "Cold start", warming: "Warming", mature: "Mature" };
const SEV_COLOR: Record<string, string> = { info: "#0ea5e9", warning: "#f59e0b", critical: "#dc2626" };
const TYPE_ICON: Record<string, any> = { detect: AlertTriangle, predict: TrendingUp, prescribe: Sparkles, health: Gauge };

export default function ProblemTemplatesPage() {
  const features = useFeatures();
  const [selected, setSelected] = useState<ProblemInstance | null>(null);

  if (!features.problem_templates) {
    return (
      <div>
        <Header />
        <div style={{ ...card, padding: 40, textAlign: "center", color: "#64748b" }}>
          <Boxes size={40} style={{ display: "block", margin: "0 auto 16px", opacity: 0.3 }} />
          <div style={{ fontSize: 15, fontWeight: 600, color: "#1e293b", marginBottom: 8 }}>
            Problem Templates are not enabled
          </div>
          <p style={{ fontSize: 13, maxWidth: 500, margin: "0 auto" }}>
            Set <code style={{ background: "#f1f5f9", padding: "2px 6px", borderRadius: 4 }}>FEATURE_PROBLEM_TEMPLATES=true</code>.
            Templates turn multi-source data into the suggestion a problem needs — predictive maintenance, giveaway correction, and more.
          </p>
        </div>
      </div>
    );
  }

  return selected
    ? <InstanceDetail instance={selected} onBack={() => setSelected(null)} />
    : <InstanceList onOpen={setSelected} />;
}

function Header() {
  return (
    <div style={{ marginBottom: 8 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#0f172a",
        display: "flex", alignItems: "center", gap: 10 }}>
        <Boxes size={22} color="#7c3aed" /> Problem Solvers
      </h1>
      <p style={{ color: "#64748b", fontSize: 14, marginTop: 4 }}>
        Point a template at your data — it learns and produces the suggestion the problem needs
      </p>
    </div>
  );
}

function MaturityBadge({ maturity, confidence }: { maturity: string; confidence: number }) {
  const c = MATURITY_COLOR[maturity] || "#94a3b8";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 500,
      padding: "3px 8px", borderRadius: 12, background: `${c}18`, color: c }}>
      {MATURITY_LABEL[maturity] || maturity} · {(confidence * 100).toFixed(0)}%
    </span>
  );
}

function InstanceList({ onOpen }: { onOpen: (i: ProblemInstance) => void }) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editInst, setEditInst] = useState<ProblemInstance | null>(null);
  const [err, setErr] = useState("");

  const { data: instances = [] } = useQuery({ queryKey: ["problem-instances"], queryFn: fetchProblemInstances, refetchInterval: 5000 });
  const { data: templates = [] } = useQuery({ queryKey: ["problem-templates"], queryFn: fetchProblemTemplates });
  const { data: tags = [] } = useQuery({ queryKey: ["tags", "all"], queryFn: () => fetchTags(undefined, true) });
  const { data: assets = [] } = useQuery({ queryKey: ["assets"], queryFn: () => fetchAssets() });
  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: fetchServers });

  const createMut = useMutation({
    mutationFn: (b: ProblemInstanceInput) => createProblemInstance(b),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["problem-instances"] }); setShowAdd(false); setErr(""); },
    onError: (e: any) => setErr(e?.response?.data?.detail ?? "Failed to create"),
  });
  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => updateProblemInstance(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["problem-instances"] }),
  });
  const editMut = useMutation({
    mutationFn: ({ id, b }: { id: string; b: any }) => updateProblemInstance(id, b),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["problem-instances"] }); setEditInst(null); setErr(""); },
    onError: (e: any) => setErr(e?.response?.data?.detail ?? "Update failed"),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteProblemInstance(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["problem-instances"] }),
  });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start" }}>
        <div style={{ flex: 1 }}><Header /></div>
        <button style={btn("#7c3aed")} onClick={() => { setErr(""); setShowAdd(true); }}>
          <Plus size={16} /> New Solver
        </button>
      </div>

      {instances.length === 0 ? (
        <div style={{ ...card, padding: 48, textAlign: "center", color: "#94a3b8" }}>
          <Boxes size={40} style={{ display: "block", margin: "0 auto 12px", opacity: 0.3 }} />
          No problem solvers yet. Create one to monitor equipment health or correct multi-unit giveaway.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 16 }}>
          {instances.map((i) => {
            const tmpl = templates.find((t) => t.key === i.template_key);
            return (
              <div key={i.id} style={{ ...card, cursor: "pointer" }} onClick={() => onOpen(i)}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 8, flexShrink: 0, background: "#f5f3ff",
                    display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Boxes size={20} color="#7c3aed" />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 600, color: "#1e293b" }}>{i.name}</div>
                    <div style={{ fontSize: 12, color: "#94a3b8" }}>{tmpl?.name || i.template_key}</div>
                  </div>
                  <button title="Edit" style={iconBtn}
                    onClick={(e) => { e.stopPropagation(); setErr(""); setEditInst(i); }}>
                    <Pencil size={13} />
                  </button>
                  <button title={i.enabled ? "Disable" : "Enable"} style={iconBtn}
                    onClick={(e) => { e.stopPropagation(); toggleMut.mutate({ id: i.id, enabled: !i.enabled }); }}>
                    <Power size={14} color={i.enabled ? "#16a34a" : "#94a3b8"} />
                  </button>
                  <button title="Delete" style={{ ...iconBtn, color: "#dc2626" }}
                    onClick={(e) => { e.stopPropagation(); if (confirm(`Delete "${i.name}"?`)) deleteMut.mutate(i.id); }}>
                    <Trash2 size={14} />
                  </button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <MaturityBadge maturity={i.maturity} confidence={i.confidence} />
                  <span style={{ fontSize: 12, color: "#94a3b8" }}>{i.output_count} outputs</span>
                  {i.last_status === "error" && (
                    <span style={{ fontSize: 11, color: "#dc2626" }}>error</span>
                  )}
                </div>
                {i.last_error && (
                  <div style={{ fontSize: 11, color: "#dc2626", background: "#fef2f2", padding: "6px 8px",
                    borderRadius: 6, marginTop: 8 }}>{i.last_error}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showAdd && (
        <CreateInstanceModal templates={templates} tags={tags} assets={assets} servers={servers}
          error={err} busy={createMut.isPending}
          onCancel={() => { setShowAdd(false); setErr(""); }}
          onSubmit={(b) => createMut.mutate(b)} />
      )}
      {editInst && (
        <CreateInstanceModal templates={templates} tags={tags} assets={assets} servers={servers}
          existing={editInst} error={err} busy={editMut.isPending}
          onCancel={() => { setEditInst(null); setErr(""); }}
          onSubmit={(b) => editMut.mutate({ id: editInst.id, b })} />
      )}
    </div>
  );
}

function CreateInstanceModal({ templates, tags, assets, servers, existing, error, busy, onCancel, onSubmit }: {
  templates: ProblemTemplateType[];
  tags: { id: string; display_name: string }[];
  assets: { id: string; name: string }[];
  servers: { id: string; name: string }[];
  existing?: ProblemInstance;
  error: string; busy: boolean;
  onCancel: () => void; onSubmit: (b: ProblemInstanceInput) => void;
}) {
  const avail = templates.filter((t) => t.available);
  const isEdit = !!existing;
  // config may arrive as an object OR a JSON string (JSONB); handle both defensively
  const ec: any = (() => {
    const c = existing?.config;
    if (!c) return {};
    if (typeof c === "string") { try { return JSON.parse(c); } catch { return {}; } }
    return c;
  })();
  const eObj = ec.objective || {};
  const eBounds = eObj.bounds || {};
  const eAction = ec.action || {};
  // condition-monitoring stores bounds as {tag:{max}}; prescribe as {min,max}
  const firstBoundMax = eBounds.max != null ? eBounds.max
    : (typeof eBounds === "object" && Object.values(eBounds)[0]
        ? (Object.values(eBounds)[0] as any).max : undefined);

  const [templateKey, setTemplateKey] = useState(existing?.template_key ?? avail[0]?.key ?? "condition_monitoring");
  const [name, setName] = useState(existing?.name ?? "");
  const [assetId, setAssetId] = useState(existing?.asset_id ?? "");
  // inputs: list of {tag_id, role}
  const [inputs, setInputs] = useState<{ tag_id: string; role: string }[]>(
    Array.isArray(ec.inputs) && ec.inputs.length ? ec.inputs : [{ tag_id: "", role: "measurement" }]);
  // objective
  const [target, setTarget] = useState(eObj.target != null ? String(eObj.target) : "");
  const [boundMin, setBoundMin] = useState(eBounds.min != null ? String(eBounds.min) : "");
  const [boundMax, setBoundMax] = useState(firstBoundMax != null ? String(firstBoundMax) : "");
  const [trainWindow, setTrainWindow] = useState(ec.model?.train_window_hours ?? 168);
  const [minSamples, setMinSamples] = useState(ec.model?.min_samples != null ? String(ec.model.min_samples) : "");
  const [evalInterval, setEvalInterval] = useState(existing?.eval_interval_s ?? 60);
  // action (prescribe)
  const firstTargetTag = eAction.target_tag_map ? Object.values(eAction.target_tag_map)[0] as string : "";
  const [targetTag, setTargetTag] = useState(firstTargetTag ?? "");
  const [targetServer, setTargetServer] = useState(eAction.target_server_id ?? "");
  const [settingMin, setSettingMin] = useState(eAction.setting_min != null ? String(eAction.setting_min) : "");
  const [settingMax, setSettingMax] = useState(eAction.setting_max != null ? String(eAction.setting_max) : "");
  const [maxStep, setMaxStep] = useState(eAction.max_step != null ? String(eAction.max_step) : "");

  const tmpl = templates.find((t) => t.key === templateKey);
  const isPrescribe = tmpl?.objective_types.includes("prescribe");
  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  const roleOptions = isPrescribe
    ? ["measurement", "setting", "context"]
    : ["measurement", "context"];

  const [localErr, setLocalErr] = useState("");

  const submit = () => {
    setLocalErr("");
    if (!name.trim()) { setLocalErr("Name is required."); return; }
    const validInputs = inputs.filter((i) => i.tag_id);
    if (validInputs.length === 0) {
      setLocalErr("At least one input signal is required. Select a signal before saving — "
        + "saving with none would clear the solver's bindings.");
      return;
    }
    if (isPrescribe && num(target) === null) {
      setLocalErr("Target value is required for a prescription solver — "
        + "saving without it would stop the solver from producing recommendations.");
      return;
    }
    if (isPrescribe) {
      const hasMeasurement = validInputs.some((i) => i.role === "measurement");
      if (!hasMeasurement) {
        setLocalErr("At least one input must have the 'measurement' role.");
        return;
      }
    }

    const config: any = {
      inputs: validInputs,
      model: { train_window_hours: trainWindow },
      objective: {
        type: isPrescribe ? "prescribe" : "predict",
      },
    };
    // preserve any model fields we don't surface in the form (e.g. score_window_minutes)
    if (ec.model && typeof ec.model === "object") {
      config.model = { ...ec.model, train_window_hours: trainWindow };
    }
    if (num(minSamples) !== null) config.model.min_samples = num(minSamples);
    if (isPrescribe) {
      config.objective.target = num(target);
      config.objective.bounds = { min: num(boundMin), max: num(boundMax) };
      config.objective.deadband = ec.objective?.deadband ?? 0.0;
      // map each measurement tag to the target tag (single-unit simple case)
      const measTags = validInputs.filter((i) => i.role === "measurement").map((i) => i.tag_id);
      const setTags = validInputs.filter((i) => i.role === "setting").map((i) => i.tag_id);
      const targetTagMap: any = {};
      measTags.forEach((mt, idx) => { targetTagMap[mt] = targetTag || setTags[idx] || null; });
      config.action = {
        ...(ec.action || {}),
        target_tag_map: targetTagMap, target_server_id: targetServer || (ec.action?.target_server_id ?? null),
        setting_min: num(settingMin), setting_max: num(settingMax), max_step: num(maxStep),
      };
    } else {
      // condition monitoring: bounds per measurement tag as {max}
      const bounds: any = {};
      validInputs.filter((i) => i.role === "measurement").forEach((i) => {
        if (num(boundMax) !== null) bounds[i.tag_id] = { max: num(boundMax) };
      });
      config.objective.bounds = bounds;
    }

    onSubmit({ template_key: templateKey, name: name.trim(),
      asset_id: assetId || null, config, eval_interval_s: evalInterval });
  };

  return (
    <div style={overlay} onClick={onCancel}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>
            {isEdit ? "Edit Problem Solver" : "New Problem Solver"}
          </h2>
          <button style={iconBtn} onClick={onCancel}><X size={16} /></button>
        </div>

        <label style={lbl}>Template *</label>
        <select style={{ ...inp, marginBottom: 6 }} value={templateKey}
          onChange={(e) => setTemplateKey(e.target.value)} disabled={isEdit}>
          {avail.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
        </select>
        {tmpl && (
          <div style={{ fontSize: 12, color: "#64748b", background: "#f8fafc", borderRadius: 6,
            padding: "8px 10px", marginBottom: 12 }}>{tmpl.description}</div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div><label style={lbl}>Name *</label>
            <input style={inp} value={name} autoFocus onChange={(e) => setName(e.target.value)}
              placeholder={isPrescribe ? "e.g. Nozzle Giveaway" : "e.g. Pump Health"} /></div>
          <div><label style={lbl}>Asset (links to twin)</label>
            <select style={inp} value={assetId} onChange={(e) => setAssetId(e.target.value)}>
              <option value="">— None —</option>
              {assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select></div>
        </div>

        <label style={lbl}>Input signals *</label>
        {inputs.map((row, idx) => (
          <div key={idx} style={{ display: "grid", gridTemplateColumns: "2fr 1fr auto", gap: 8, marginBottom: 8 }}>
            <select style={inp} value={row.tag_id}
              onChange={(e) => { const n = [...inputs]; n[idx].tag_id = e.target.value; setInputs(n); }}>
              <option value="">— Select signal —</option>
              {tags.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
            </select>
            <select style={inp} value={row.role}
              onChange={(e) => { const n = [...inputs]; n[idx].role = e.target.value; setInputs(n); }}>
              {roleOptions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button style={iconBtn} onClick={() => setInputs(inputs.filter((_, i) => i !== idx))}>
              <X size={14} />
            </button>
          </div>
        ))}
        <button style={{ ...btn("#f1f5f9", "#334155"), marginBottom: 14 }}
          onClick={() => setInputs([...inputs, { tag_id: "", role: isPrescribe ? "setting" : "measurement" }])}>
          <Plus size={14} /> Add signal
        </button>

        <div style={{ fontSize: 12, fontWeight: 600, color: "#475569", margin: "4px 0 8px" }}>Objective</div>
        {isPrescribe ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div><label style={lbl}>Target value *</label>
              <input style={inp} type="number" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="250" /></div>
            <div><label style={lbl}>Spec min</label>
              <input style={inp} type="number" value={boundMin} onChange={(e) => setBoundMin(e.target.value)} /></div>
            <div><label style={lbl}>Spec max</label>
              <input style={inp} type="number" value={boundMax} onChange={(e) => setBoundMax(e.target.value)} /></div>
          </div>
        ) : (
          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Alarm limit (max)</label>
            <input style={inp} type="number" value={boundMax} onChange={(e) => setBoundMax(e.target.value)} placeholder="e.g. 4.5" />
          </div>
        )}

        <div style={{ fontSize: 12, fontWeight: 600, color: "#475569", margin: "4px 0 8px" }}>Learning settings</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div><label style={lbl}>Train window (h)</label>
            <input style={inp} type="number" value={trainWindow} onChange={(e) => setTrainWindow(+e.target.value)} /></div>
          <div><label style={lbl}>Min samples</label>
            <input style={inp} type="number" value={minSamples} onChange={(e) => setMinSamples(e.target.value)}
              placeholder="default" /></div>
          <div><label style={lbl}>Eval interval (s)</label>
            <input style={inp} type="number" value={evalInterval} onChange={(e) => setEvalInterval(+e.target.value)} /></div>
        </div>

        {isPrescribe && (
          <>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#b45309", margin: "4px 0 8px" }}>
              Corrective action (advisory — routes to approval)
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div><label style={lbl}>Writable target tag</label>
                <select style={inp} value={targetTag} onChange={(e) => setTargetTag(e.target.value)}>
                  <option value="">— Use setting signal —</option>
                  {tags.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
                </select></div>
              <div><label style={lbl}>Server</label>
                <select style={inp} value={targetServer} onChange={(e) => setTargetServer(e.target.value)}>
                  <option value="">— Select —</option>
                  {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select></div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div><label style={lbl}>Setting min</label>
                <input style={inp} type="number" value={settingMin} onChange={(e) => setSettingMin(e.target.value)} /></div>
              <div><label style={lbl}>Setting max</label>
                <input style={inp} type="number" value={settingMax} onChange={(e) => setSettingMax(e.target.value)} /></div>
              <div><label style={lbl}>Max step</label>
                <input style={inp} type="number" value={maxStep} onChange={(e) => setMaxStep(e.target.value)} /></div>
            </div>
          </>
        )}

        {(error || localErr) && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>{localErr || error}</div>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button style={btn("#f1f5f9", "#334155")} onClick={onCancel}>Cancel</button>
          <button style={btn("#7c3aed")} disabled={busy || !name.trim()} onClick={submit}>
            <Check size={16} /> {isEdit ? "Save Changes" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function InstanceDetail({ instance, onBack }: { instance: ProblemInstance; onBack: () => void }) {
  const { data: outputs = [] } = useQuery({
    queryKey: ["problem-outputs", instance.id],
    queryFn: () => fetchProblemOutputs(instance.id),
    refetchInterval: 4000,
  });

  return (
    <div>
      <button style={{ ...btn("#f1f5f9", "#334155"), marginBottom: 16 }} onClick={onBack}>
        <ChevronLeft size={16} /> All solvers
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <div style={{ width: 44, height: 44, borderRadius: 10, background: "#f5f3ff",
          display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Boxes size={22} color="#7c3aed" />
        </div>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#0f172a" }}>{instance.name}</h1>
          <p style={{ color: "#64748b", fontSize: 14, margin: "2px 0 0" }}>{instance.template_key}</p>
        </div>
        <MaturityBadge maturity={instance.maturity} confidence={instance.confidence} />
      </div>

      <h3 style={{ fontSize: 14, fontWeight: 600, color: "#1e293b", marginBottom: 12 }}>
        Outputs ({outputs.length})
      </h3>
      {outputs.length === 0 ? (
        <div style={{ ...card, padding: 32, textAlign: "center", color: "#94a3b8" }}>
          <Activity size={32} style={{ display: "block", margin: "0 auto 10px", opacity: 0.3 }} />
          No outputs yet. The engine evaluates on its interval — results appear here.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {outputs.map((o, idx) => {
            const Icon = TYPE_ICON[o.output_type] || Activity;
            const color = SEV_COLOR[o.severity] || "#64748b";
            return (
              <div key={idx} style={{ ...card, borderLeft: `4px solid ${color}`, padding: 14 }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                  <Icon size={18} color={color} style={{ flexShrink: 0, marginTop: 2 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: "#1e293b" }}>{o.title}</span>
                      <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase",
                        padding: "2px 6px", borderRadius: 4, background: `${color}18`, color }}>{o.output_type}</span>
                      {o.recommendation_id && (
                        <span style={{ fontSize: 11, color: "#0ea5e9" }}>→ sent to approval</span>
                      )}
                    </div>
                    <div style={{ fontSize: 13, color: "#475569", marginTop: 3 }}>{o.detail}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
                      <MaturityBadge maturity={o.maturity} confidence={o.confidence} />
                      <span style={{ fontSize: 11, color: "#cbd5e1" }}>{new Date(o.created_at).toLocaleString()}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
