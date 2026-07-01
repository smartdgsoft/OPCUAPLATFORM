import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { X, Check, Plus, Play, Trash2, Gauge, Beaker, Hand, Cpu } from "lucide-react";
import {
  fetchCalibrations, createCalibration, fetchCalibration, addCalibrationPoint,
  runAutomatedCalibration, applyCalibration, deleteCalibration,
  type ProblemInstance, type Calibration,
} from "../services/api";

const btn = (bg: string, fg = "#fff"): React.CSSProperties => ({
  display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px",
  borderRadius: 6, border: "none", background: bg, color: fg, fontSize: 13, fontWeight: 500, cursor: "pointer",
});
const inp: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #e2e8f0", fontSize: 13, boxSizing: "border-box",
};
const lbl: React.CSSProperties = { fontSize: 12, color: "#64748b", marginBottom: 4, display: "block" };
const iconBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28,
  borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", color: "#64748b",
};
const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", display: "flex",
  alignItems: "center", justifyContent: "center", zIndex: 60,
};
const modal: React.CSSProperties = {
  background: "#fff", borderRadius: 12, padding: 24, width: 640, maxWidth: "95vw",
  maxHeight: "92vh", overflow: "auto", boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
};
const card: React.CSSProperties = { background: "#fff", borderRadius: 10, border: "1px solid #e2e8f0", padding: 14 };

const STATUS_COLOR: Record<string, string> = {
  planned: "#94a3b8", collecting: "#f59e0b", running: "#0ea5e9",
  computed: "#8b5cf6", applied: "#22c55e", failed: "#dc2626", cancelled: "#94a3b8",
};

export function CalibrationPanel({ instance, onClose }: {
  instance: ProblemInstance; onClose: () => void;
}) {
  const qc = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  const { data: calibrations = [] } = useQuery({
    queryKey: ["calibrations", instance.id],
    queryFn: () => fetchCalibrations(instance.id),
    refetchInterval: 3000,
  });

  const delMut = useMutation({
    mutationFn: (id: string) => deleteCalibration(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["calibrations", instance.id] }),
  });

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
          <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
            <Beaker size={18} color="#7c3aed" /> Gain Calibration
          </h2>
          <button style={iconBtn} onClick={onClose}><X size={16} /></button>
        </div>
        <p style={{ fontSize: 13, color: "#64748b", marginTop: 0, marginBottom: 16 }}>
          Compute the gain by stepping the setting and measuring the response — the reliable way
          when history has no setting-variation to learn from.
        </p>

        {activeId ? (
          <CalibrationDetail id={activeId} onBack={() => setActiveId(null)}
            onApplied={() => { qc.invalidateQueries({ queryKey: ["problem-instances"] }); }} />
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
              <button style={btn("#7c3aed")} onClick={() => setShowNew(true)}>
                <Plus size={16} /> New Calibration
              </button>
            </div>

            {calibrations.length === 0 ? (
              <div style={{ ...card, textAlign: "center", color: "#94a3b8", padding: 28 }}>
                No calibrations yet. Start one to measure the gain directly.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {calibrations.map((c) => (
                  <div key={c.id} style={{ ...card, cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }}
                    onClick={() => setActiveId(c.id)}>
                    {c.mode === "manual" ? <Hand size={18} color="#64748b" /> : <Cpu size={18} color="#64748b" />}
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "#1e293b" }}>
                        {c.mode === "manual" ? "Manual" : "Automated"} calibration
                        {c.unit_key ? ` · ${c.unit_key}` : ""}
                      </div>
                      <div style={{ fontSize: 12, color: "#94a3b8" }}>
                        {c.n_points} points{c.computed_gain != null
                          ? ` · gain ${c.computed_gain.toFixed(3)}${c.r_squared != null ? ` (R² ${c.r_squared.toFixed(3)})` : ""}`
                          : ""}
                      </div>
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 12,
                      background: `${STATUS_COLOR[c.status] || "#94a3b8"}18`, color: STATUS_COLOR[c.status] || "#94a3b8" }}>
                      {c.status}
                    </span>
                    <button style={{ ...iconBtn, color: "#dc2626" }}
                      onClick={(e) => { e.stopPropagation(); if (confirm("Delete this calibration?")) delMut.mutate(c.id); }}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {showNew && (
          <NewCalibrationModal instance={instance}
            onCancel={() => setShowNew(false)}
            onCreated={(id) => { setShowNew(false); setActiveId(id);
              qc.invalidateQueries({ queryKey: ["calibrations", instance.id] }); }} />
        )}
      </div>
    </div>
  );
}

function NewCalibrationModal({ instance, onCancel, onCreated }: {
  instance: ProblemInstance; onCancel: () => void; onCreated: (id: string) => void;
}) {
  const cfg = instance.config || {};
  const measTag = (cfg.inputs || []).find((i: any) => i.role === "measurement")?.tag_id || null;
  const setTag = (cfg.inputs || []).find((i: any) => i.role === "setting")?.tag_id || null;
  const server = cfg.action?.target_server_id || null;

  const [mode, setMode] = useState("manual");
  const [steps, setSteps] = useState("46, 48, 50, 52, 54");
  const [settleS, setSettleS] = useState(10);
  const [samples, setSamples] = useState(10);
  const [err, setErr] = useState("");

  const createMut = useMutation({
    mutationFn: () => createCalibration({
      instance_id: instance.id,
      unit_key: cfg.inputs?.[0]?.tag_id ? undefined : undefined,
      measurement_tag_id: measTag, setting_tag_id: setTag, target_server_id: server,
      mode,
      plan: mode === "automated"
        ? { steps: steps.split(",").map((s) => Number(s.trim())).filter((n) => !isNaN(n)),
            settle_s: settleS, samples_per_step: samples, sample_gap_s: 1.0 }
        : {},
    }),
    onSuccess: (r) => onCreated(r.id),
    onError: (e: any) => setErr(e?.response?.data?.detail ?? "Failed to create"),
  });

  return (
    <div style={overlay} onClick={onCancel}>
      <div style={{ ...modal, width: 520 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0, flex: 1 }}>New Calibration</h2>
          <button style={iconBtn} onClick={onCancel}><X size={16} /></button>
        </div>

        <label style={lbl}>Mode</label>
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <button style={{ ...btn(mode === "manual" ? "#7c3aed" : "#f1f5f9", mode === "manual" ? "#fff" : "#334155"), flex: 1 }}
            onClick={() => setMode("manual")}>
            <Hand size={15} /> Manual (operator-guided)
          </button>
          <button style={{ ...btn(mode === "automated" ? "#7c3aed" : "#f1f5f9", mode === "automated" ? "#fff" : "#334155"), flex: 1 }}
            onClick={() => setMode("automated")}>
            <Cpu size={15} /> Automated
          </button>
        </div>

        {mode === "manual" ? (
          <div style={{ fontSize: 13, color: "#475569", background: "#f8fafc", borderRadius: 8, padding: "12px 14px", marginBottom: 14 }}>
            You'll step the setting by hand on the line, then enter each
            <strong> setting → measured</strong> pair. The gain forms as you add points.
            Recommended: 4–6 points across the working range.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 13, color: "#475569", background: "#fffbeb", border: "1px solid #fde68a",
              borderRadius: 8, padding: "12px 14px", marginBottom: 14 }}>
              The platform will write each setting through the approved write path, wait to settle,
              and measure the response. Requires a writable setting tag + server.
              {(!setTag || !server) && (
                <div style={{ color: "#b45309", marginTop: 6, fontWeight: 600 }}>
                  ⚠ This solver has no setting tag / server configured — set them in the solver's
                  corrective action first, or use Manual mode.
                </div>
              )}
            </div>
            <label style={lbl}>Setting steps (comma-separated)</label>
            <input style={{ ...inp, marginBottom: 10 }} value={steps} onChange={(e) => setSteps(e.target.value)} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
              <div><label style={lbl}>Settle time per step (s)</label>
                <input style={inp} type="number" value={settleS} onChange={(e) => setSettleS(+e.target.value)} /></div>
              <div><label style={lbl}>Samples per step</label>
                <input style={inp} type="number" value={samples} onChange={(e) => setSamples(+e.target.value)} /></div>
            </div>
          </>
        )}

        {err && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>{err}</div>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button style={btn("#f1f5f9", "#334155")} onClick={onCancel}>Cancel</button>
          <button style={btn("#7c3aed")} disabled={createMut.isPending} onClick={() => createMut.mutate()}>
            <Check size={16} /> Create
          </button>
        </div>
      </div>
    </div>
  );
}

function CalibrationDetail({ id, onBack, onApplied }: {
  id: string; onBack: () => void; onApplied: () => void;
}) {
  const qc = useQueryClient();
  const { data: cal } = useQuery({ queryKey: ["calibration", id], queryFn: () => fetchCalibration(id), refetchInterval: 2500 });
  const [setting, setSetting] = useState("");
  const [measured, setMeasured] = useState("");

  const addMut = useMutation({
    mutationFn: () => addCalibrationPoint(id, { setting_value: Number(setting), measured_value: Number(measured),
      step_index: cal?.points?.length ?? 0 }),
    onSuccess: () => { setSetting(""); setMeasured(""); qc.invalidateQueries({ queryKey: ["calibration", id] }); },
  });
  const runMut = useMutation({
    mutationFn: () => runAutomatedCalibration(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["calibration", id] }),
  });
  const applyMut = useMutation({
    mutationFn: () => applyCalibration(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["calibration", id] }); onApplied(); },
  });

  if (!cal) return <div style={{ color: "#94a3b8", fontSize: 13 }}>Loading…</div>;

  return (
    <div>
      <button style={{ ...btn("#f1f5f9", "#334155"), marginBottom: 14 }} onClick={onBack}>← Back to calibrations</button>

      <div style={{ ...card, marginBottom: 14, display: "flex", alignItems: "center", gap: 16 }}>
        <Gauge size={28} color="#7c3aed" />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: "#64748b" }}>Computed gain</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: "#1e293b" }}>
            {cal.computed_gain != null ? cal.computed_gain.toFixed(4) : "—"}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 13, color: "#64748b" }}>Fit quality (R²)</div>
          <div style={{ fontSize: 20, fontWeight: 600,
            color: cal.r_squared == null ? "#94a3b8" : cal.r_squared > 0.9 ? "#16a34a" : cal.r_squared > 0.7 ? "#f59e0b" : "#dc2626" }}>
            {cal.r_squared != null ? cal.r_squared.toFixed(3) : "—"}
          </div>
        </div>
      </div>

      {cal.error && (
        <div style={{ color: "#dc2626", fontSize: 13, background: "#fef2f2", borderRadius: 8, padding: "10px 12px", marginBottom: 12 }}>
          {cal.error}
        </div>
      )}

      {cal.mode === "manual" ? (
        <div style={{ ...card, marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 10 }}>Add measured point</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 10, alignItems: "end" }}>
            <div><label style={lbl}>Setting applied</label>
              <input style={inp} type="number" value={setting} onChange={(e) => setSetting(e.target.value)} placeholder="e.g. 48" /></div>
            <div><label style={lbl}>Measured result</label>
              <input style={inp} type="number" value={measured} onChange={(e) => setMeasured(e.target.value)} placeholder="e.g. 240" /></div>
            <button style={btn("#7c3aed")} disabled={!setting || !measured || addMut.isPending}
              onClick={() => addMut.mutate()}><Plus size={15} /> Add</button>
          </div>
        </div>
      ) : (
        <div style={{ ...card, marginBottom: 14, display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, fontSize: 13, color: "#475569" }}>
            {cal.status === "running" ? "Calibration running — stepping the setting and measuring…"
              : "Automated calibration ready. It will step the setting and measure the response."}
          </div>
          <button style={btn(cal.status === "running" ? "#94a3b8" : "#0ea5e9")}
            disabled={cal.status === "running" || runMut.isPending}
            onClick={() => runMut.mutate()}>
            <Play size={15} /> {cal.status === "running" ? "Running…" : "Run"}
          </button>
        </div>
      )}

      {cal.points && cal.points.length > 0 && (
        <div style={{ ...card, marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 8 }}>Points ({cal.points.length})</div>
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead><tr style={{ color: "#94a3b8", textAlign: "left" }}>
              <th style={{ padding: "4px 8px" }}>Setting</th><th style={{ padding: "4px 8px" }}>Measured</th>
              <th style={{ padding: "4px 8px" }}>Samples</th><th style={{ padding: "4px 8px" }}>Source</th>
            </tr></thead>
            <tbody>
              {cal.points.map((p, i) => (
                <tr key={i} style={{ borderTop: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "4px 8px" }}>{p.setting_value.toFixed(2)}</td>
                  <td style={{ padding: "4px 8px" }}>{p.measured_value.toFixed(2)}</td>
                  <td style={{ padding: "4px 8px" }}>{p.n_samples}</td>
                  <td style={{ padding: "4px 8px", color: "#94a3b8" }}>{p.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cal.computed_gain != null && cal.status !== "applied" && (
        <button style={{ ...btn("#16a34a"), width: "100%", justifyContent: "center" }}
          disabled={applyMut.isPending} onClick={() => applyMut.mutate()}>
          <Check size={16} /> Apply this gain to the solver
        </button>
      )}
      {cal.status === "applied" && (
        <div style={{ textAlign: "center", color: "#16a34a", fontSize: 13, fontWeight: 600, padding: 8 }}>
          ✓ Gain applied — the solver now uses this calibrated gain for prescriptions.
        </div>
      )}
    </div>
  );
}
