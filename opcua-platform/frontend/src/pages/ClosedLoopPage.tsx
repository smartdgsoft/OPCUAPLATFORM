import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ShieldCheck, Plus, Trash2, X, Check, ThumbsUp, ThumbsDown,
  AlertTriangle, Lock, Pencil, Activity, ArrowRight,
} from "lucide-react";
import {
  fetchClRules, createClRule, updateClRule, deleteClRule,
  fetchClRecommendations, approveClRecommendation, rejectClRecommendation,
  fetchTwins, fetchTags, fetchServers,
  type ClRule, type ClRecommendation, type ClRuleInput,
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
const card: React.CSSProperties = { background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", padding: 18 };
const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", display: "flex",
  alignItems: "center", justifyContent: "center", zIndex: 50,
};
const modal: React.CSSProperties = {
  background: "#fff", borderRadius: 12, padding: 24, width: 560, maxWidth: "94vw",
  maxHeight: "90vh", overflow: "auto", boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
};

const SEV_COLOR: Record<string, string> = { info: "#0ea5e9", warning: "#f59e0b", critical: "#dc2626" };

export default function ClosedLoopPage() {
  const features = useFeatures();
  const [tab, setTab] = useState<"approvals" | "rules">("approvals");

  if (!features.closed_loop_advisory) {
    return (
      <div>
        <Header />
        <div style={{ ...card, padding: 40, textAlign: "center", color: "#64748b" }}>
          <ShieldCheck size={40} style={{ display: "block", margin: "0 auto 16px", opacity: 0.3 }} />
          <div style={{ fontSize: 15, fontWeight: 600, color: "#1e293b", marginBottom: 8 }}>
            Closed-Loop Advisory is not enabled
          </div>
          <p style={{ fontSize: 13, maxWidth: 500, margin: "0 auto" }}>
            Set <code style={{ background: "#f1f5f9", padding: "2px 6px", borderRadius: 4 }}>FEATURE_CLOSED_LOOP_ADVISORY=true</code>.
            Actuation also requires <code style={{ background: "#f1f5f9", padding: "2px 6px", borderRadius: 4 }}>FEATURE_WRITE=true</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Header />
      <SafetyBanner writeEnabled={features.write} />
      <div style={{ display: "flex", gap: 2, borderBottom: "1px solid #e2e8f0", margin: "16px 0" }}>
        {([["approvals", "Approvals"], ["rules", "Advisory Rules"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            style={{ padding: "8px 16px", border: "none", background: "none", fontSize: 13, cursor: "pointer",
              fontWeight: tab === k ? 600 : 400, color: tab === k ? "#0ea5e9" : "#64748b",
              borderBottom: `2px solid ${tab === k ? "#0ea5e9" : "transparent"}`, marginBottom: -1 }}>
            {label}
          </button>
        ))}
      </div>
      {tab === "approvals" ? <Approvals writeEnabled={features.write} /> : <Rules />}
    </div>
  );
}

function Header() {
  return (
    <div style={{ marginBottom: 8 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#0f172a",
        display: "flex", alignItems: "center", gap: 10 }}>
        <ShieldCheck size={22} color="#0ea5e9" /> Closed-Loop Advisory
      </h1>
      <p style={{ color: "#64748b", fontSize: 14, marginTop: 4 }}>
        Setpoint recommendations with human approval — advisory only, never auto-actuated
      </p>
    </div>
  );
}

function SafetyBanner({ writeEnabled }: { writeEnabled: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 14px",
      borderRadius: 8, background: "#f0f9ff", border: "1px solid #bae6fd", fontSize: 13, color: "#0369a1" }}>
      <Lock size={16} style={{ flexShrink: 0, marginTop: 1 }} />
      <div>
        Recommendations are <strong>never applied automatically</strong>. Approving one issues the write
        through the standard write-control path, with the rule's safety clamps enforced and full audit.
        {!writeEnabled && (
          <div style={{ color: "#b45309", marginTop: 4 }}>
            <AlertTriangle size={13} style={{ display: "inline", verticalAlign: -2, marginRight: 4 }} />
            Write feature is disabled — approvals cannot actuate until FEATURE_WRITE is enabled.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Approvals queue ─────────────────────────────────────────────────────────
function Approvals({ writeEnabled }: { writeEnabled: boolean }) {
  const qc = useQueryClient();
  const { data: pending = [] } = useQuery({
    queryKey: ["cl-recs", "pending"],
    queryFn: () => fetchClRecommendations({ status: "pending" }),
    refetchInterval: 4000,
  });
  const { data: recent = [] } = useQuery({
    queryKey: ["cl-recs", "recent"],
    queryFn: () => fetchClRecommendations({}),
    refetchInterval: 8000,
  });

  const approveMut = useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => approveClRecommendation(id, note),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["cl-recs"] });
      if (res?.status === "failed") alert("Write was attempted but failed — check write-control logs.");
    },
    onError: (e: any) => alert(e?.response?.data?.detail ?? "Approve failed"),
  });
  const rejectMut = useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => rejectClRecommendation(id, note),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cl-recs"] }),
  });

  const history = recent.filter((r) => r.status !== "pending").slice(0, 20);

  return (
    <div>
      <h3 style={{ fontSize: 14, fontWeight: 600, color: "#1e293b", margin: "8px 0 12px" }}>
        Pending approval ({pending.length})
      </h3>
      {pending.length === 0 ? (
        <div style={{ ...card, padding: 32, textAlign: "center", color: "#94a3b8" }}>
          <Activity size={32} style={{ display: "block", margin: "0 auto 10px", opacity: 0.3 }} />
          No pending recommendations. They appear here when an advisory rule fires.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {pending.map((r) => (
            <RecCard key={r.id} rec={r} writeEnabled={writeEnabled}
              busy={approveMut.isPending || rejectMut.isPending}
              onApprove={(note) => approveMut.mutate({ id: r.id, note })}
              onReject={(note) => rejectMut.mutate({ id: r.id, note })} />
          ))}
        </div>
      )}

      {history.length > 0 && (
        <>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "#1e293b", margin: "24px 0 12px" }}>
            Recent decisions
          </h3>
          <div style={card}>
            {history.map((r) => (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 12,
                padding: "8px 4px", borderBottom: "1px solid #f1f5f9", fontSize: 13 }}>
                <StatusPill status={r.status} />
                <span style={{ flex: 1, color: "#475569" }}>{r.title}</span>
                <span style={{ color: "#94a3b8" }}>
                  → {r.recommended_value?.toLocaleString(undefined, { maximumFractionDigits: 3 })}
                </span>
                {r.decided_by && <span style={{ color: "#cbd5e1" }}>by {r.decided_by}</span>}
                <span style={{ color: "#cbd5e1" }}>{new Date(r.created_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const c: Record<string, string> = {
    pending: "#f59e0b", approved: "#0ea5e9", applied: "#22c55e",
    rejected: "#94a3b8", failed: "#dc2626", expired: "#cbd5e1",
  };
  const color = c[status] || "#94a3b8";
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 12,
      background: `${color}18`, color, textTransform: "capitalize", minWidth: 70, textAlign: "center" }}>
      {status}
    </span>
  );
}

function RecCard({ rec, writeEnabled, busy, onApprove, onReject }: {
  rec: ClRecommendation; writeEnabled: boolean; busy: boolean;
  onApprove: (note?: string) => void; onReject: (note?: string) => void;
}) {
  const [note, setNote] = useState("");
  const sev = rec.severity || "warning";
  const color = SEV_COLOR[sev] || "#f59e0b";

  return (
    <div style={{ ...card, borderLeft: `4px solid ${color}` }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#1e293b" }}>{rec.title}</div>
          <div style={{ fontSize: 13, color: "#64748b", marginTop: 2 }}>{rec.detail}</div>
        </div>
        {rec.clamped && (
          <span style={{ fontSize: 11, color: "#b45309", background: "#fffbeb",
            border: "1px solid #fde68a", borderRadius: 6, padding: "3px 8px" }}>
            safety-clamped
          </span>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "10px 14px",
        background: "#f8fafc", borderRadius: 8, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: "#94a3b8" }}>Current</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: "#475569" }}>
            {rec.current_value?.toLocaleString(undefined, { maximumFractionDigits: 3 }) ?? "—"}
          </div>
        </div>
        <ArrowRight size={18} color="#94a3b8" />
        <div>
          <div style={{ fontSize: 11, color: "#94a3b8" }}>Recommended</div>
          <div style={{ fontSize: 18, fontWeight: 700, color }}>
            {rec.recommended_value?.toLocaleString(undefined, { maximumFractionDigits: 3 }) ?? "—"}
          </div>
        </div>
        {typeof rec.source_value === "number" && (
          <div style={{ marginLeft: "auto", fontSize: 12, color: "#94a3b8" }}>
            triggered at source = {rec.source_value.toLocaleString(undefined, { maximumFractionDigits: 3 })}
          </div>
        )}
      </div>

      <input style={{ ...inp, marginBottom: 10 }} value={note}
        onChange={(e) => setNote(e.target.value)} placeholder="Decision note (optional)" />

      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button style={btn("#fef2f2", "#dc2626")} disabled={busy} onClick={() => onReject(note || undefined)}>
          <ThumbsDown size={15} /> Reject
        </button>
        <button style={{ ...btn("#22c55e"), opacity: writeEnabled ? 1 : 0.5,
          cursor: writeEnabled ? "pointer" : "not-allowed" }}
          disabled={busy || !writeEnabled}
          title={writeEnabled ? "" : "Enable FEATURE_WRITE to actuate"}
          onClick={() => onApprove(note || undefined)}>
          <ThumbsUp size={15} /> Approve &amp; Apply
        </button>
      </div>
    </div>
  );
}

// ── Rules management ────────────────────────────────────────────────────────
function Rules() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<ClRule | null>(null);
  const [err, setErr] = useState("");

  const { data: rules = [] } = useQuery({ queryKey: ["cl-rules"], queryFn: () => fetchClRules() });
  const { data: twins = [] } = useQuery({ queryKey: ["twins"], queryFn: fetchTwins });
  const { data: tags = [] } = useQuery({ queryKey: ["tags"], queryFn: () => fetchTags() });
  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: fetchServers });

  const createMut = useMutation({
    mutationFn: (b: ClRuleInput) => createClRule(b),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cl-rules"] }); setShowAdd(false); setErr(""); },
    onError: (e: any) => setErr(e?.response?.data?.detail ?? "Create failed"),
  });
  const updateMut = useMutation({
    mutationFn: ({ id, b }: { id: string; b: Partial<ClRuleInput> }) => updateClRule(id, b),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cl-rules"] }); setEditing(null); setErr(""); },
    onError: (e: any) => setErr(e?.response?.data?.detail ?? "Update failed"),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteClRule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cl-rules"] }),
  });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <button style={btn("#0ea5e9")} onClick={() => { setErr(""); setShowAdd(true); }}>
          <Plus size={16} /> New Rule
        </button>
      </div>

      {rules.length === 0 ? (
        <div style={{ ...card, padding: 40, textAlign: "center", color: "#94a3b8" }}>
          <ShieldCheck size={36} style={{ display: "block", margin: "0 auto 10px", opacity: 0.3 }} />
          No advisory rules yet. Create one to generate setpoint recommendations.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 16 }}>
          {rules.map((r) => (
            <div key={r.id} style={card}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: "#1e293b" }}>{r.name}</div>
                  <div style={{ fontSize: 12, color: "#94a3b8" }}>{r.twin_name}</div>
                </div>
                {!r.enabled && <span style={{ fontSize: 11, color: "#94a3b8" }}>disabled</span>}
                <button style={iconBtn} onClick={() => { setErr(""); setEditing(r); }}><Pencil size={13} /></button>
                <button style={{ ...iconBtn, color: "#dc2626" }}
                  onClick={() => { if (confirm(`Delete rule "${r.name}"?`)) deleteMut.mutate(r.id); }}>
                  <Trash2 size={13} />
                </button>
              </div>
              <div style={{ fontSize: 12, color: "#475569", lineHeight: 1.6 }}>
                <div><strong>When</strong> {r.trigger_type === "anomaly" ? "anomaly detected" : `source ${r.trigger_op} ${r.trigger_value}`}</div>
                <div><strong>Then</strong> recommend {r.action_type === "set_value" ? `set ${r.action_value}` : r.action_type === "adjust" ? `adjust by ${r.action_value}` : `proportional → ${r.source_target}`}</div>
                {(r.safety_min != null || r.safety_max != null) && (
                  <div style={{ color: "#b45309" }}>
                    <Lock size={11} style={{ display: "inline", verticalAlign: -1, marginRight: 3 }} />
                    clamp [{r.safety_min ?? "−∞"}, {r.safety_max ?? "+∞"}]
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {(showAdd || editing) && (
        <RuleModal
          rule={editing || undefined}
          twins={twins} tags={tags} servers={servers} error={err}
          busy={createMut.isPending || updateMut.isPending}
          onCancel={() => { setShowAdd(false); setEditing(null); setErr(""); }}
          onSubmit={(b) => editing ? updateMut.mutate({ id: editing.id, b }) : createMut.mutate(b)} />
      )}
    </div>
  );
}

function RuleModal({ rule, twins, tags, servers, error, busy, onCancel, onSubmit }: {
  rule?: ClRule;
  twins: { id: string; name: string }[];
  tags: { id: string; display_name: string; node_id: string }[];
  servers: { id: string; name: string }[];
  error: string; busy: boolean;
  onCancel: () => void; onSubmit: (b: ClRuleInput) => void;
}) {
  const [twinId, setTwinId] = useState(rule?.twin_id ?? "");
  const [name, setName] = useState(rule?.name ?? "");
  const [triggerType, setTriggerType] = useState(rule?.trigger_type ?? "threshold");
  const [sourceTag, setSourceTag] = useState(rule?.source_tag_id ?? "");
  const [op, setOp] = useState(rule?.trigger_op ?? ">");
  const [triggerValue, setTriggerValue] = useState<any>(rule?.trigger_value ?? "");
  const [targetTag, setTargetTag] = useState(rule?.target_tag_id ?? "");
  const [targetServer, setTargetServer] = useState(rule?.target_server_id ?? "");
  const [actionType, setActionType] = useState(rule?.action_type ?? "set_value");
  const [actionValue, setActionValue] = useState<any>(rule?.action_value ?? "");
  const [sourceTarget, setSourceTarget] = useState<any>(rule?.source_target ?? "");
  const [gain, setGain] = useState<any>(rule?.gain ?? 1.0);
  const [safetyMin, setSafetyMin] = useState<any>(rule?.safety_min ?? "");
  const [safetyMax, setSafetyMax] = useState<any>(rule?.safety_max ?? "");
  const [maxStep, setMaxStep] = useState<any>(rule?.max_step ?? "");
  const [cooldown, setCooldown] = useState(rule?.cooldown_s ?? 300);
  const [severity, setSeverity] = useState(rule?.severity ?? "warning");

  const num = (v: any) => (v === "" || v === null ? null : Number(v));

  const submit = () => {
    if (!twinId || !name.trim()) return;
    onSubmit({
      twin_id: twinId, name: name.trim(), trigger_type: triggerType,
      source_tag_id: sourceTag || null,
      trigger_op: triggerType === "threshold" ? op : null,
      trigger_value: triggerType === "threshold" ? num(triggerValue) : null,
      target_tag_id: targetTag || null, target_server_id: targetServer || null,
      action_type: actionType, action_value: num(actionValue),
      source_target: num(sourceTarget), gain: num(gain),
      safety_min: num(safetyMin), safety_max: num(safetyMax), max_step: num(maxStep),
      cooldown_s: cooldown, severity,
    });
  };

  return (
    <div style={overlay} onClick={onCancel}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>
            {rule ? "Edit Advisory Rule" : "New Advisory Rule"}
          </h2>
          <button style={iconBtn} onClick={onCancel}><X size={16} /></button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div><label style={lbl}>Twin *</label>
            <select style={inp} value={twinId} onChange={(e) => setTwinId(e.target.value)} disabled={!!rule}>
              <option value="">— Select —</option>
              {twins.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select></div>
          <div><label style={lbl}>Rule name *</label>
            <input style={inp} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. High temp → lower heater" /></div>
        </div>

        <div style={{ fontSize: 12, fontWeight: 600, color: "#475569", margin: "8px 0 6px" }}>Trigger</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, marginBottom: 12 }}>
          <div><label style={lbl}>Type</label>
            <select style={inp} value={triggerType} onChange={(e) => setTriggerType(e.target.value)}>
              <option value="threshold">Threshold</option>
              <option value="anomaly">On anomaly</option>
            </select></div>
          <div><label style={lbl}>Source signal</label>
            <select style={inp} value={sourceTag} onChange={(e) => setSourceTag(e.target.value)}>
              <option value="">— Select tag —</option>
              {tags.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
            </select></div>
        </div>
        {triggerType === "threshold" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, marginBottom: 12 }}>
            <div><label style={lbl}>Operator</label>
              <select style={inp} value={op} onChange={(e) => setOp(e.target.value)}>
                {[">", "<", ">=", "<=", "==", "!="].map((o) => <option key={o} value={o}>{o}</option>)}
              </select></div>
            <div><label style={lbl}>Value</label>
              <input style={inp} type="number" value={triggerValue} onChange={(e) => setTriggerValue(e.target.value)} /></div>
          </div>
        )}

        <div style={{ fontSize: 12, fontWeight: 600, color: "#475569", margin: "8px 0 6px" }}>Target (writable)</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div><label style={lbl}>Target tag</label>
            <select style={inp} value={targetTag} onChange={(e) => setTargetTag(e.target.value)}>
              <option value="">— Select tag —</option>
              {tags.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
            </select></div>
          <div><label style={lbl}>Server</label>
            <select style={inp} value={targetServer} onChange={(e) => setTargetServer(e.target.value)}>
              <option value="">— Select server —</option>
              {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></div>
        </div>

        <div style={{ fontSize: 12, fontWeight: 600, color: "#475569", margin: "8px 0 6px" }}>Recommendation</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div><label style={lbl}>Action</label>
            <select style={inp} value={actionType} onChange={(e) => setActionType(e.target.value)}>
              <option value="set_value">Set fixed value</option>
              <option value="adjust">Adjust by delta</option>
              <option value="proportional">Proportional to source</option>
            </select></div>
          {actionType !== "proportional" ? (
            <div><label style={lbl}>{actionType === "set_value" ? "Value" : "Delta"}</label>
              <input style={inp} type="number" value={actionValue} onChange={(e) => setActionValue(e.target.value)} /></div>
          ) : (
            <div><label style={lbl}>Source target</label>
              <input style={inp} type="number" value={sourceTarget} onChange={(e) => setSourceTarget(e.target.value)} /></div>
          )}
        </div>
        {actionType === "proportional" && (
          <div style={{ marginBottom: 12 }}><label style={lbl}>Gain</label>
            <input style={inp} type="number" step="0.1" value={gain} onChange={(e) => setGain(e.target.value)} /></div>
        )}

        <div style={{ fontSize: 12, fontWeight: 600, color: "#b45309", margin: "8px 0 6px",
          display: "flex", alignItems: "center", gap: 6 }}>
          <Lock size={13} /> Safety limits (always enforced)
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div><label style={lbl}>Min</label>
            <input style={inp} type="number" value={safetyMin} onChange={(e) => setSafetyMin(e.target.value)} /></div>
          <div><label style={lbl}>Max</label>
            <input style={inp} type="number" value={safetyMax} onChange={(e) => setSafetyMax(e.target.value)} /></div>
          <div><label style={lbl}>Max step</label>
            <input style={inp} type="number" value={maxStep} onChange={(e) => setMaxStep(e.target.value)} /></div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          <div><label style={lbl}>Cooldown (s)</label>
            <input style={inp} type="number" value={cooldown} onChange={(e) => setCooldown(+e.target.value)} /></div>
          <div><label style={lbl}>Severity</label>
            <select style={inp} value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="info">Info</option><option value="warning">Warning</option><option value="critical">Critical</option>
            </select></div>
        </div>

        {error && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button style={btn("#f1f5f9", "#334155")} onClick={onCancel}>Cancel</button>
          <button style={btn("#0ea5e9")} disabled={busy || !twinId || !name.trim()} onClick={submit}>
            <Check size={16} /> {rule ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
