import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Zap, AlertTriangle, List, Plus, CheckCircle, XCircle, RefreshCw, Play } from "lucide-react";
import { format } from "date-fns";
import { api } from "../services/api";

const TABS = ["Templates", "Direct Call", "Emergency Stop", "Call Audit"] as const;
type Tab = typeof TABS[number];
const DATA_TYPES = ["Double","Float","Int32","Int64","UInt32","Boolean","String"];

interface Template {
  id: string;
  name: string;
  description: string;
  server_id: string;
  object_node_id: string;
  method_node_id: string;
  input_args: Array<{name:string;data_type:string;description:string;default?:string}>;
  output_args: Array<{name:string;data_type:string;description:string}>;
  requires_confirmation: boolean;
  min_role: string;
}

export default function MethodCallPage() {
  const [tab, setTab] = useState<Tab>("Templates");
  const [lastResult, setLastResult] = useState<any>(null);

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#0f172a",
          display: "flex", alignItems: "center", gap: 10 }}>
          <Zap size={22} color="#a78bfa" /> Method Calls
        </h1>
        <p style={{ color: "#64748b", fontSize: 14, marginTop: 4 }}>
          Call OPC UA Method nodes · Templates · Emergency Stop · Full audit trail
        </p>
      </div>

      <div style={{ display: "flex", gap: 2, borderBottom: "1px solid #e2e8f0", marginBottom: 20 }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: "9px 16px", border: "none", background: "none", fontSize: 14, cursor: "pointer",
            fontWeight: tab === t ? 600 : 400,
            color: tab === t ? "#a78bfa" : "#64748b",
            borderBottom: `2px solid ${tab === t ? "#a78bfa" : "transparent"}`, marginBottom: -1,
          }}>{t === "Emergency Stop" ? "🔴 Emergency Stop" : t}</button>
        ))}
      </div>

      {tab === "Templates"       && <TemplatesTab onResult={setLastResult} />}
      {tab === "Direct Call"     && <DirectCallTab onResult={setLastResult} />}
      {tab === "Emergency Stop"  && <EmergencyStopTab onResult={setLastResult} />}
      {tab === "Call Audit"      && <CallAuditTab />}
    </div>
  );
}

// ── Templates tab ──────────────────────────────────────────────────────────
function TemplatesTab({ onResult }: { onResult: (r: any) => void }) {
  const [selected, setSelected] = useState<Template | null>(null);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [showCreate, setShowCreate] = useState(false);

  const { data: templates = [], refetch } = useQuery({
    queryKey: ["method-templates"],
    queryFn: () => api.get<Template[]>("/methods/templates").then(r => r.data),
  });

  const handleCall = async () => {
    if (!selected) return;
    setLoading(true);
    try {
      const inputArgs = selected.input_args.map(a => {
        const v = args[a.name] ?? a.default ?? "";
        if (a.data_type === "Boolean") return v === "true";
        if (a.data_type.includes("Int")) return parseInt(v);
        if (a.data_type === "String") return v;
        return parseFloat(v);
      });
      const { data } = await api.post("/methods/call/template", {
        template_id: selected.id, input_args: inputArgs,
      });
      setResult(data);
      onResult(data);
    } catch (err: any) {
      const r = { success: false, error: err.response?.data?.detail || err.message };
      setResult(r);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 20 }}>
      {/* Template list */}
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={cardTitle}>Method Templates</div>
          <button onClick={() => setShowCreate(!showCreate)}
            style={{ background: "none", border: "none", color: "#a78bfa", cursor: "pointer" }}>
            <Plus size={16} />
          </button>
        </div>

        {templates.length === 0 ? (
          <div style={{ textAlign: "center", color: "#94a3b8", padding: 24, fontSize: 13 }}>
            No templates yet.<br />Create one to get started.
          </div>
        ) : templates.map(t => (
          <div key={t.id} onClick={() => { setSelected(t); setArgs({}); setResult(null); }}
            style={{
              padding: "10px 12px", borderRadius: 8, cursor: "pointer", marginBottom: 4,
              background: selected?.id === t.id ? "#f5f3ff" : "#f8fafc",
              border: `1px solid ${selected?.id === t.id ? "#c4b5fd" : "transparent"}`,
            }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#1e293b" }}>{t.name}</div>
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{t.description}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <span style={{ fontSize: 10, color: "#a78bfa" }}>{t.input_args.length} inputs</span>
              <span style={{ fontSize: 10, color: "#64748b" }}>Min: {t.min_role}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Call panel */}
      <div>
        {selected ? (
          <div style={card}>
            <div style={cardTitle}>{selected.name}</div>
            <p style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>{selected.description}</p>

            <div style={{ marginBottom: 8, fontSize: 12, color: "#94a3b8" }}>
              Object: <code style={{ fontFamily: "monospace" }}>{selected.object_node_id}</code><br/>
              Method: <code style={{ fontFamily: "monospace" }}>{selected.method_node_id}</code>
            </div>

            {selected.input_args.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 10 }}>
                  Input Arguments
                </div>
                {selected.input_args.map(a => (
                  <div key={a.name} style={{ marginBottom: 10 }}>
                    <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 4 }}>
                      {a.name} <span style={{ color: "#94a3b8" }}>({a.data_type})</span>
                      {a.description && <span style={{ marginLeft: 4, fontStyle: "italic" }}>— {a.description}</span>}
                    </label>
                    {a.data_type === "Boolean" ? (
                      <select value={args[a.name] ?? a.default ?? "false"}
                        onChange={e => setArgs(av => ({...av, [a.name]: e.target.value}))}
                        style={input}>
                        <option value="false">False</option>
                        <option value="true">True</option>
                      </select>
                    ) : (
                      <input value={args[a.name] ?? a.default ?? ""}
                        onChange={e => setArgs(av => ({...av, [a.name]: e.target.value}))}
                        placeholder={a.default || `Enter ${a.data_type}`} style={input} />
                    )}
                  </div>
                ))}
              </div>
            )}

            {selected.requires_confirmation && (
              <div style={{ padding: "10px 12px", background: "#fffbeb", borderRadius: 8,
                border: "1px solid #fde68a", marginBottom: 14, fontSize: 13, color: "#92400e" }}>
                ⚠ This method requires confirmation before executing
              </div>
            )}

            <button onClick={handleCall} disabled={loading}
              style={{ width: "100%", padding: 11, borderRadius: 8, border: "none",
                background: loading ? "#94a3b8" : "#a78bfa", color: "#fff",
                fontSize: 14, fontWeight: 600, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              {loading ? <><RefreshCw size={16} /> Calling…</> : <><Play size={16} /> Call Method</>}
            </button>

            {result && <MethodResultCard result={result} outputArgs={selected.output_args} />}
          </div>
        ) : (
          <div style={{ ...card, textAlign: "center", color: "#94a3b8", padding: 60 }}>
            <Zap size={40} style={{ opacity: 0.3, display: "block", margin: "0 auto 12px" }} />
            <p>Select a method template to call it</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Direct Call tab ────────────────────────────────────────────────────────
function DirectCallTab({ onResult }: { onResult: (r: any) => void }) {
  const [form, setForm] = useState({
    server_id: "default",
    object_node_id: "",
    method_node_id: "",
  });
  const [argRows, setArgRows] = useState<Array<{value: string; type: string}>>([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  const handleCall = async () => {
    setLoading(true);
    try {
      const { data } = await api.post("/methods/call", {
        server_id: form.server_id,
        object_node_id: form.object_node_id,
        method_node_id: form.method_node_id,
        input_args: argRows.map(a =>
          a.type === "Boolean" ? a.value === "true"
          : a.type.includes("Int") ? parseInt(a.value)
          : a.type === "String" ? a.value : parseFloat(a.value)
        ),
        arg_types: argRows.map(a => a.type),
      });
      setResult(data);
      onResult(data);
    } catch (err: any) {
      setResult({ success: false, error: err.response?.data?.detail || err.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={card}>
      <div style={cardTitle}>Direct Method Call</div>
      <p style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>
        Call any OPC UA method directly by node IDs. ENGINEER+ only.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
        <div><Label>Object Node ID</Label>
          <input value={form.object_node_id} onChange={e => setForm(f => ({...f, object_node_id: e.target.value}))}
            placeholder="ns=2;i=100" style={input} /></div>
        <div><Label>Method Node ID</Label>
          <input value={form.method_node_id} onChange={e => setForm(f => ({...f, method_node_id: e.target.value}))}
            placeholder="ns=2;i=101" style={input} /></div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>Input Arguments</div>
          <button onClick={() => setArgRows(r => [...r, {value:"",type:"Double"}])}
            style={{ fontSize: 12, color: "#a78bfa", background: "none", border: "none", cursor: "pointer" }}>
            + Add Arg
          </button>
        </div>
        {argRows.map((a, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, marginBottom: 6 }}>
            <input value={a.value} onChange={e => setArgRows(r => r.map((x,j) => j===i ? {...x, value: e.target.value} : x))}
              placeholder="Value" style={{...input, margin:0}} />
            <select value={a.type} onChange={e => setArgRows(r => r.map((x,j) => j===i ? {...x, type: e.target.value} : x))}
              style={{...input, margin:0}}>
              {DATA_TYPES.map(dt => <option key={dt}>{dt}</option>)}
            </select>
            <button onClick={() => setArgRows(r => r.filter((_,j) => j !== i))}
              style={{ background:"none",border:"none",color:"#94a3b8",cursor:"pointer" }}>✕</button>
          </div>
        ))}
      </div>
      <button onClick={handleCall} disabled={loading || !form.object_node_id || !form.method_node_id}
        style={{ width:"100%",padding:11,borderRadius:8,border:"none",background:loading?"#94a3b8":"#a78bfa",
          color:"#fff",fontSize:14,fontWeight:600,cursor:"pointer" }}>
        {loading ? "Calling…" : "Call Method"}
      </button>
      {result && <MethodResultCard result={result} outputArgs={[]} />}
    </div>
  );
}

// ── Emergency Stop ─────────────────────────────────────────────────────────
function EmergencyStopTab({ onResult }: { onResult: (r: any) => void }) {
  const [form, setForm] = useState({
    server_id: "default",
    stop_node_id: "",
    stop_method_node_id: "",
    reason: "",
  });
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  const handleStop = async () => {
    if (!confirmed) return;
    setLoading(true);
    try {
      const { data } = await api.post("/methods/emergency-stop", form);
      setResult(data);
      onResult(data);
      setConfirmed(false);
    } catch (err: any) {
      setResult({ success: false, error: err.response?.data?.detail || err.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 600 }}>
      <div style={{ ...card, border: "2px solid #fecaca", background: "#fef2f2", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <AlertTriangle size={24} color="#dc2626" />
          <div style={{ fontSize: 18, fontWeight: 700, color: "#dc2626" }}>Emergency Stop</div>
        </div>
        <p style={{ fontSize: 13, color: "#991b1b", marginBottom: 16 }}>
          Calls an OPC UA Method with EMERGENCY priority — bypasses all queuing and executes immediately.
          All connected clients are notified. Action is fully audited.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
          <div><Label>Object Node ID</Label>
            <input value={form.stop_node_id} onChange={e => setForm(f => ({...f, stop_node_id: e.target.value}))}
              placeholder="ns=2;i=100" style={input} /></div>
          <div><Label>Method Node ID</Label>
            <input value={form.stop_method_node_id} onChange={e => setForm(f => ({...f, stop_method_node_id: e.target.value}))}
              placeholder="ns=2;i=999" style={input} /></div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <Label>Reason (for audit)</Label>
          <input value={form.reason} onChange={e => setForm(f => ({...f, reason: e.target.value}))}
            placeholder="Brief description of why ESD was triggered" style={input} />
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, cursor: "pointer" }}>
          <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
          <span style={{ fontSize: 13, color: "#dc2626", fontWeight: 600 }}>
            I confirm this is an emergency stop and understand the consequences
          </span>
        </label>

        <button onClick={handleStop}
          disabled={!confirmed || loading || !form.stop_node_id || !form.stop_method_node_id}
          style={{
            width: "100%", padding: "13px", borderRadius: 8, border: "none",
            background: confirmed && !loading ? "#dc2626" : "#fca5a5",
            color: "#fff", fontSize: 15, fontWeight: 700,
            cursor: confirmed && !loading ? "pointer" : "not-allowed",
            letterSpacing: "0.05em",
          }}>
          {loading ? "EXECUTING EMERGENCY STOP…" : "🔴 EXECUTE EMERGENCY STOP"}
        </button>
      </div>

      {result && (
        <div style={{ ...card, border: `1px solid ${result.success ? "#bbf7d0" : "#fecaca"}`,
          background: result.success ? "#f0fdf4" : "#fef2f2" }}>
          {result.success
            ? <div style={{ color: "#15803d", fontWeight: 600 }}>✓ Emergency stop executed</div>
            : <div style={{ color: "#dc2626", fontWeight: 600 }}>✗ {result.error}</div>}
        </div>
      )}
    </div>
  );
}

// ── Call Audit ─────────────────────────────────────────────────────────────
function CallAuditTab() {
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["method-audit"],
    queryFn: () => api.get<any[]>("/methods/audit?limit=200").then(r => r.data),
    refetchInterval: 10_000,
  });
  return (
    <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", overflow: "hidden" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
            {["Time","Method Node","Inputs","Outputs","By","Status","Latency"].map(h => (
              <th key={h} style={{ padding:"10px 14px",textAlign:"left",fontSize:11,
                fontWeight:600,color:"#64748b",textTransform:"uppercase" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {isLoading ? <tr><td colSpan={7} style={{textAlign:"center",padding:32,color:"#94a3b8"}}>Loading…</td></tr>
          : rows.map(r => (
            <tr key={r.request_id} style={{ borderBottom: "1px solid #f1f5f9" }}>
              <td style={td}>{format(new Date(r.created_at),"HH:mm:ss")}</td>
              <td style={{...td,fontFamily:"monospace",fontSize:11}}>{r.method_node_id}</td>
              <td style={td}>{r.input_args ? JSON.stringify(r.input_args).slice(0,40) : "—"}</td>
              <td style={td}>{r.output_args ? JSON.stringify(r.output_args).slice(0,40) : "—"}</td>
              <td style={td}>{r.requested_by}</td>
              <td style={td}>
                <span style={{ fontWeight:600,color:r.success?"#22c55e":"#ef4444",fontSize:12 }}>
                  {r.success?"OK":"FAIL"}
                </span>
              </td>
              <td style={td}>{r.latency_ms?.toFixed(0)}ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Shared ─────────────────────────────────────────────────────────────────
function MethodResultCard({ result, outputArgs }: { result: any; outputArgs: any[] }) {
  return (
    <div style={{ marginTop: 16, padding: 14, borderRadius: 8,
      background: result.success ? "#f0fdf4" : "#fef2f2",
      border: `1px solid ${result.success ? "#bbf7d0" : "#fecaca"}` }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        {result.success ? <CheckCircle size={18} color="#16a34a" /> : <XCircle size={18} color="#dc2626" />}
        <span style={{ fontWeight: 600, color: result.success ? "#15803d" : "#dc2626" }}>
          {result.success ? "Method executed successfully" : "Method failed"}
        </span>
      </div>
      {result.error && <div style={{ fontSize: 13, color: "#dc2626" }}>{result.error}</div>}
      {result.output_args && result.output_args.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 4 }}>Output Arguments</div>
          {result.output_args.map((v: any, i: number) => (
            <div key={i} style={{ fontSize: 13, color: "#1e293b" }}>
              <span style={{ color: "#64748b", marginRight: 6 }}>{outputArgs[i]?.name || `arg[${i}]`}:</span>
              <strong style={{ fontFamily: "monospace" }}>{String(v)}</strong>
            </div>
          ))}
        </div>
      )}
      {result.latency_ms && (
        <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6 }}>
          Latency: {result.latency_ms.toFixed(1)}ms
        </div>
      )}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 4 }}>{children}</label>;
}

const card: React.CSSProperties = {
  background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0",
  padding: "20px 24px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
};
const cardTitle: React.CSSProperties = { fontSize: 15, fontWeight: 600, color: "#1e293b", marginBottom: 4 };
const input: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #e2e8f0",
  fontSize: 13, boxSizing: "border-box", marginBottom: 0,
};
const td: React.CSSProperties = { padding: "10px 14px", fontSize: 12, color: "#374151" };
