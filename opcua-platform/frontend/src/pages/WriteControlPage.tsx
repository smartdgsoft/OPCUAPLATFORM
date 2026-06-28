import React, { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Send, List, TrendingUp, Clock, CheckCircle, XCircle,
  AlertTriangle, RefreshCw, ChevronDown, Info,
} from "lucide-react";
import { format } from "date-fns";
import { fetchTags } from "../services/api";
import { api } from "../services/api";
import { useTagWebSocket } from "../hooks/useTagWebSocket";
import type { Tag } from "../types";

const TABS = ["Single Write", "Bulk Write", "Set-point Ramp", "Write Audit"] as const;
type Tab = typeof TABS[number];

const DATA_TYPES = ["Double","Float","Int32","Int64","UInt32","Boolean","String","Byte"];
const PRIORITIES = [
  { value: 0, label: "EMERGENCY", color: "#ef4444" },
  { value: 1, label: "HIGH",      color: "#f97316" },
  { value: 2, label: "NORMAL",    color: "#22c55e" },
];

// ── Types ──────────────────────────────────────────────────────────────────
interface WriteResult {
  request_id: string;
  success: boolean;
  readback_value?: any;
  readback_match?: boolean;
  error?: string;
  latency_ms?: number;
  timestamp?: string;
  status?: string;
}

interface WriteAuditRow {
  request_id: string;
  server_id: string;
  node_id: string;
  value_written: string;
  data_type: string;
  priority: string;
  requested_by: string;
  success: boolean;
  readback_value?: string;
  readback_match?: boolean;
  error_message?: string;
  latency_ms: number;
  created_at: string;
}

export default function WriteControlPage() {
  const [tab, setTab] = useState<Tab>("Single Write");
  const [lastResults, setLastResults] = useState<WriteResult[]>([]);

  const addResult = useCallback((r: WriteResult) => {
    setLastResults(prev => [r, ...prev].slice(0, 20));
  }, []);

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#0f172a",
          display: "flex", alignItems: "center", gap: 10 }}>
          <Send size={22} color="#f97316" /> Write Control
        </h1>
        <p style={{ color: "#64748b", fontSize: 14, marginTop: 4 }}>
          Write values to OPC UA nodes · Priority queue · Read-back confirmation · Full audit trail
        </p>
      </div>

      {/* Tab bar */}
      <div style={{ display: "flex", gap: 2, borderBottom: "1px solid #e2e8f0", marginBottom: 20 }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: "9px 16px", border: "none", background: "none",
            fontSize: 14, cursor: "pointer",
            fontWeight: tab === t ? 600 : 400,
            color: tab === t ? "#f97316" : "#64748b",
            borderBottom: `2px solid ${tab === t ? "#f97316" : "transparent"}`,
            marginBottom: -1,
          }}>{t}</button>
        ))}
      </div>

      {/* Recent results sidebar */}
      {lastResults.length > 0 && tab !== "Write Audit" && (
        <ResultsSidebar results={lastResults} />
      )}

      {tab === "Single Write"    && <SingleWriteTab onResult={addResult} />}
      {tab === "Bulk Write"      && <BulkWriteTab   onResult={addResult} />}
      {tab === "Set-point Ramp"  && <RampTab />}
      {tab === "Write Audit"     && <WriteAuditTab />}
    </div>
  );
}

// ── Single Write ──────────────────────────────────────────────────────────
function SingleWriteTab({ onResult }: { onResult: (r: WriteResult) => void }) {
  const [form, setForm] = useState({
    server_id: "default",
    node_id: "",
    value: "",
    data_type: "Double",
    priority: 2,
    confirm_readback: true,
    min_value: "",
    max_value: "",
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<WriteResult | null>(null);
  const { data: tags = [] } = useQuery({ queryKey: ["tags"], queryFn: () => fetchTags() });

  const handleWrite = async () => {
    if (!form.node_id || form.value === "") return;
    setLoading(true);
    setResult(null);
    try {
      const payload: any = {
        server_id: form.server_id,
        node_id: form.node_id,
        value: form.data_type === "Boolean" ? form.value === "true"
               : form.data_type.includes("Int") ? parseInt(form.value)
               : form.data_type === "String" ? form.value
               : parseFloat(form.value),
        data_type: form.data_type,
        priority: form.priority,
        confirm_readback: form.confirm_readback,
      };
      if (form.min_value) payload.min_value = parseFloat(form.min_value);
      if (form.max_value) payload.max_value = parseFloat(form.max_value);

      const { data } = await api.post("/write/node", payload);
      setResult(data);
      onResult(data);
    } catch (err: any) {
      const r = { request_id: "", success: false, error: err.response?.data?.detail || err.message };
      setResult(r);
      onResult(r);
    } finally {
      setLoading(false);
    }
  };

  const fillFromTag = (tag: Tag) => {
    setForm(f => ({ ...f, node_id: tag.node_id, data_type: tag.data_type }));
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
      {/* Write form */}
      <div style={card}>
        <div style={cardTitle}>Write to OPC UA Node</div>

        <div style={{ marginBottom: 14 }}>
          <Label>Select from tag registry (optional)</Label>
          <select onChange={e => {
            const tag = tags.find(t => t.id === e.target.value);
            if (tag) fillFromTag(tag);
          }} style={input}>
            <option value="">— choose a tag —</option>
            {tags.map(t => (
              <option key={t.id} value={t.id}>{t.display_name} ({t.node_id})</option>
            ))}
          </select>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
          <div>
            <Label>Node ID *</Label>
            <input value={form.node_id} onChange={e => setForm(f => ({...f, node_id: e.target.value}))}
              placeholder="ns=2;i=1001" style={input} />
          </div>
          <div>
            <Label>Data Type</Label>
            <select value={form.data_type} onChange={e => setForm(f => ({...f, data_type: e.target.value}))}
              style={input}>
              {DATA_TYPES.map(dt => <option key={dt}>{dt}</option>)}
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <Label>Value *</Label>
          {form.data_type === "Boolean" ? (
            <select value={form.value} onChange={e => setForm(f => ({...f, value: e.target.value}))} style={input}>
              <option value="false">False</option>
              <option value="true">True</option>
            </select>
          ) : (
            <input value={form.value} onChange={e => setForm(f => ({...f, value: e.target.value}))}
              placeholder={form.data_type === "String" ? "Enter text value" : "Enter numeric value"}
              style={input} />
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
          <div>
            <Label>Min Value (validation)</Label>
            <input type="number" value={form.min_value}
              onChange={e => setForm(f => ({...f, min_value: e.target.value}))}
              placeholder="No limit" style={input} />
          </div>
          <div>
            <Label>Max Value (validation)</Label>
            <input type="number" value={form.max_value}
              onChange={e => setForm(f => ({...f, max_value: e.target.value}))}
              placeholder="No limit" style={input} />
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <Label>Priority</Label>
          <div style={{ display: "flex", gap: 8 }}>
            {PRIORITIES.map(p => (
              <button key={p.value} onClick={() => setForm(f => ({...f, priority: p.value}))}
                style={{
                  flex: 1, padding: "8px", borderRadius: 6, cursor: "pointer",
                  border: `1px solid ${form.priority === p.value ? p.color : "#e2e8f0"}`,
                  background: form.priority === p.value ? `${p.color}18` : "#fff",
                  color: form.priority === p.value ? p.color : "#374151",
                  fontSize: 12, fontWeight: 500,
                }}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, cursor: "pointer" }}>
          <input type="checkbox" checked={form.confirm_readback}
            onChange={e => setForm(f => ({...f, confirm_readback: e.target.checked}))} />
          <span style={{ fontSize: 13, color: "#374151" }}>Confirm write by reading back value</span>
        </label>

        <button onClick={handleWrite} disabled={loading || !form.node_id || form.value === ""}
          style={{
            width: "100%", padding: "11px", borderRadius: 8, border: "none",
            background: loading ? "#94a3b8" : "#f97316",
            color: "#fff", fontSize: 14, fontWeight: 600, cursor: loading ? "not-allowed" : "pointer",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          }}>
          {loading ? <><RefreshCw size={16} /> Writing…</> : <><Send size={16} /> Write Node</>}
        </button>
      </div>

      {/* Result panel */}
      <div>
        {result ? <WriteResultCard result={result} /> : (
          <div style={{ ...card, textAlign: "center", color: "#94a3b8", padding: 40 }}>
            <Send size={32} style={{ opacity: 0.3, display: "block", margin: "0 auto 10px" }} />
            <p style={{ fontSize: 13 }}>Write result will appear here</p>
          </div>
        )}
        <div style={{ ...card, marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 8 }}>
            Priority Queue Guide
          </div>
          {PRIORITIES.map(p => (
            <div key={p.value} style={{ display: "flex", gap: 10, marginBottom: 6 }}>
              <span style={{ minWidth: 90, fontSize: 12, fontWeight: 600, color: p.color }}>{p.label}</span>
              <span style={{ fontSize: 12, color: "#64748b" }}>
                {p.value === 0 ? "Bypasses queue — immediate execution. Safety shutdowns, ESD." :
                 p.value === 1 ? "First in queue. Operator set-points, alarm resets." :
                 "Standard queue position. Scheduled writes, batch ops."}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Bulk Write ────────────────────────────────────────────────────────────
function BulkWriteTab({ onResult }: { onResult: (r: WriteResult) => void }) {
  const [rows, setRows] = useState([
    { node_id: "", value: "", data_type: "Double", priority: 2 }
  ]);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<any[]>([]);

  const addRow = () => setRows(r => [...r, { node_id: "", value: "", data_type: "Double", priority: 2 }]);
  const removeRow = (i: number) => setRows(r => r.filter((_, idx) => idx !== i));
  const updateRow = (i: number, field: string, val: any) =>
    setRows(r => r.map((row, idx) => idx === i ? {...row, [field]: val} : row));

  const handleBulkWrite = async () => {
    const valid = rows.filter(r => r.node_id && r.value !== "");
    if (!valid.length) return;
    setLoading(true);
    try {
      const { data } = await api.post("/write/bulk", {
        writes: valid.map(r => ({
          server_id: "default",
          node_id: r.node_id,
          value: parseFloat(r.value) || r.value,
          data_type: r.data_type,
          priority: r.priority,
        }))
      });
      setResults(data.request_ids || []);
    } catch (err: any) {
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={card}>
      <div style={{ ...cardTitle, marginBottom: 16 }}>Bulk Write — up to 500 nodes</div>
      <div style={{ marginBottom: 12 }}>
        {rows.map((row, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "3fr 2fr 1.5fr 1.5fr auto",
            gap: 8, marginBottom: 8, alignItems: "center" }}>
            <input placeholder="ns=2;i=1001" value={row.node_id}
              onChange={e => updateRow(i, "node_id", e.target.value)} style={{...input, margin: 0}} />
            <input placeholder="Value" value={row.value}
              onChange={e => updateRow(i, "value", e.target.value)} style={{...input, margin: 0}} />
            <select value={row.data_type} onChange={e => updateRow(i, "data_type", e.target.value)}
              style={{...input, margin: 0}}>
              {["Double","Float","Int32","Boolean","String"].map(dt => <option key={dt}>{dt}</option>)}
            </select>
            <select value={row.priority} onChange={e => updateRow(i, "priority", parseInt(e.target.value))}
              style={{...input, margin: 0}}>
              {PRIORITIES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
            <button onClick={() => removeRow(i)}
              style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", padding: 4 }}>
              ✕
            </button>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={addRow} style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid #e2e8f0",
          background: "#f8fafc", color: "#374151", fontSize: 13, cursor: "pointer" }}>
          + Add Row
        </button>
        <button onClick={handleBulkWrite} disabled={loading} style={{
          padding: "8px 20px", borderRadius: 6, border: "none", background: "#f97316",
          color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer",
          display: "flex", alignItems: "center", gap: 6,
        }}>
          {loading ? <><RefreshCw size={14} /> Sending…</> : <><Send size={14} /> Write All</>}
        </button>
      </div>
      {results.length > 0 && (
        <div style={{ marginTop: 16, padding: 12, background: "#f0fdf4", borderRadius: 8, border: "1px solid #bbf7d0" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#15803d", marginBottom: 6 }}>
            ✓ {results.length} writes queued
          </div>
          {results.slice(0, 5).map((id, i) => (
            <div key={i} style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace" }}>{id}</div>
          ))}
          {results.length > 5 && <div style={{ fontSize: 11, color: "#94a3b8" }}>…and {results.length - 5} more</div>}
        </div>
      )}
    </div>
  );
}

// ── Set-point Ramp ────────────────────────────────────────────────────────
function RampTab() {
  const [form, setForm] = useState({
    server_id: "default",
    node_id: "",
    target_value: "",
    duration_seconds: "30",
    steps: "10",
    data_type: "Double",
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const { data: tags = [] } = useQuery({ queryKey: ["tags"], queryFn: () => fetchTags() });

  const handleRamp = async () => {
    setLoading(true);
    try {
      const { data } = await api.post("/write/ramp", {
        server_id: form.server_id,
        node_id: form.node_id,
        target_value: parseFloat(form.target_value),
        duration_seconds: parseFloat(form.duration_seconds),
        steps: parseInt(form.steps),
        data_type: form.data_type,
      });
      setResult(data);
    } catch (err: any) {
      setResult({ error: err.response?.data?.detail || err.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
      <div style={card}>
        <div style={cardTitle}>Set-point Ramp</div>
        <p style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>
          Gradually ramp a value to a target over a defined duration.
          Ideal for soft-start motors, temperature ramp-up, and pressure control.
        </p>

        <div style={{ marginBottom: 12 }}>
          <Label>Tag</Label>
          <select onChange={e => {
            const tag = tags.find(t => t.id === e.target.value);
            if (tag) setForm(f => ({...f, node_id: tag.node_id, data_type: tag.data_type}));
          }} style={input}>
            <option value="">— select tag —</option>
            {tags.map(t => <option key={t.id} value={t.id}>{t.display_name}</option>)}
          </select>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
          <div><Label>Node ID</Label>
            <input value={form.node_id} onChange={e => setForm(f => ({...f, node_id: e.target.value}))}
              placeholder="ns=2;i=1001" style={input} /></div>
          <div><Label>Data Type</Label>
            <select value={form.data_type} onChange={e => setForm(f => ({...f, data_type: e.target.value}))} style={input}>
              {["Double","Float","Int32"].map(dt => <option key={dt}>{dt}</option>)}
            </select></div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
          <div><Label>Target Value</Label>
            <input type="number" value={form.target_value} onChange={e => setForm(f => ({...f, target_value: e.target.value}))}
              placeholder="100.0" style={input} /></div>
          <div><Label>Duration (sec)</Label>
            <input type="number" value={form.duration_seconds} onChange={e => setForm(f => ({...f, duration_seconds: e.target.value}))}
              min={1} max={3600} style={input} /></div>
          <div><Label>Steps</Label>
            <input type="number" value={form.steps} onChange={e => setForm(f => ({...f, steps: e.target.value}))}
              min={2} max={100} style={input} /></div>
        </div>

        <button onClick={handleRamp} disabled={loading || !form.node_id || !form.target_value}
          style={{ width: "100%", padding: 11, borderRadius: 8, border: "none",
            background: loading ? "#94a3b8" : "#f97316",
            color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
          {loading ? "Scheduling Ramp…" : "Start Ramp"}
        </button>
      </div>

      <div style={card}>
        <div style={cardTitle}>Ramp Preview</div>
        {form.target_value && form.steps && (
          <div>
            <div style={{ fontSize: 13, color: "#64748b", marginBottom: 12 }}>
              {parseInt(form.steps)} steps over {parseFloat(form.duration_seconds)}s =&nbsp;
              <strong>{(parseFloat(form.duration_seconds) / parseInt(form.steps)).toFixed(1)}s per step</strong>
            </div>
            <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 80, marginBottom: 8 }}>
              {Array.from({length: Math.min(parseInt(form.steps) || 10, 20)}, (_, i) => {
                const pct = (i + 1) / parseInt(form.steps) * 100;
                return <div key={i} style={{ flex: 1, background: "#f97316",
                  height: `${pct}%`, borderRadius: "2px 2px 0 0", opacity: 0.7 + i * 0.015 }} />;
              })}
            </div>
            <div style={{ fontSize: 11, color: "#94a3b8", textAlign: "center" }}>
              0 → {form.target_value}
            </div>
          </div>
        )}
        {result && (
          <div style={{ marginTop: 16, padding: 12,
            background: result.error ? "#fef2f2" : "#f0fdf4",
            border: `1px solid ${result.error ? "#fecaca" : "#bbf7d0"}`,
            borderRadius: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: result.error ? "#dc2626" : "#15803d" }}>
              {result.error ? "✗ " + result.error : "✓ " + result.status}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Write Audit ───────────────────────────────────────────────────────────
function WriteAuditTab() {
  const { data: rows = [], isLoading, refetch } = useQuery({
    queryKey: ["write-audit"],
    queryFn: () => api.get<WriteAuditRow[]>("/write/audit?limit=200").then(r => r.data),
    refetchInterval: 10_000,
  });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 14, color: "#64748b" }}>{rows.length} recent writes</div>
        <button onClick={() => refetch()} style={{ padding: "6px 12px", borderRadius: 6,
          border: "1px solid #e2e8f0", background: "#fff", color: "#374151",
          fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>
      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
              {["Time","Node ID","Value","Type","Priority","By","Readback","Status","Latency"].map(h => (
                <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontSize: 11,
                  fontWeight: 600, color: "#64748b", textTransform: "uppercase" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? <tr><td colSpan={9} style={{textAlign:"center",padding:32,color:"#94a3b8"}}>Loading…</td></tr>
            : rows.map(r => (
              <tr key={r.request_id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                <td style={td}>{format(new Date(r.created_at),"HH:mm:ss")}</td>
                <td style={{...td,fontFamily:"monospace",fontSize:11}}>{r.node_id}</td>
                <td style={{...td,fontWeight:600}}>{r.value_written}</td>
                <td style={td}>{r.data_type}</td>
                <td style={td}><PriorityBadge priority={r.priority} /></td>
                <td style={td}>{r.requested_by}</td>
                <td style={td}>
                  {r.readback_value != null ? (
                    <span style={{ color: r.readback_match ? "#22c55e" : "#ef4444", fontSize: 12 }}>
                      {r.readback_value} {r.readback_match ? "✓" : "✗"}
                    </span>
                  ) : "—"}
                </td>
                <td style={td}>
                  {r.success
                    ? <span style={{color:"#22c55e",fontSize:12,fontWeight:600}}>OK</span>
                    : <span style={{color:"#ef4444",fontSize:12,fontWeight:600}}>FAIL</span>}
                </td>
                <td style={td}>{r.latency_ms?.toFixed(0)}ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Shared components ──────────────────────────────────────────────────────
function WriteResultCard({ result }: { result: WriteResult }) {
  const ok = result.success;
  return (
    <div style={{ ...card, border: `1px solid ${ok ? "#bbf7d0" : "#fecaca"}`,
      background: ok ? "#f0fdf4" : "#fef2f2" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        {ok ? <CheckCircle size={24} color="#16a34a" /> : <XCircle size={24} color="#dc2626" />}
        <div style={{ fontSize: 16, fontWeight: 700, color: ok ? "#15803d" : "#dc2626" }}>
          {ok ? "Write Successful" : "Write Failed"}
        </div>
      </div>
      {result.latency_ms && (
        <div style={{ fontSize: 13, color: "#64748b", marginBottom: 6 }}>
          Latency: <strong>{result.latency_ms.toFixed(1)}ms</strong>
        </div>
      )}
      {result.readback_value != null && (
        <div style={{ fontSize: 13, color: "#64748b", marginBottom: 6 }}>
          Read-back: <strong style={{ color: result.readback_match ? "#22c55e" : "#f97316" }}>
            {String(result.readback_value)}
          </strong> {result.readback_match ? "✓ Match" : "⚠ Mismatch"}
        </div>
      )}
      {result.error && (
        <div style={{ fontSize: 13, color: "#dc2626" }}>{result.error}</div>
      )}
      {result.request_id && (
        <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 8, fontFamily: "monospace" }}>
          ID: {result.request_id}
        </div>
      )}
    </div>
  );
}

function ResultsSidebar({ results }: { results: WriteResult[] }) {
  return (
    <div style={{ marginBottom: 20, display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
      {results.slice(0, 6).map((r, i) => (
        <div key={i} style={{ minWidth: 140, padding: "8px 12px", borderRadius: 8,
          background: r.success ? "#f0fdf4" : "#fef2f2",
          border: `1px solid ${r.success ? "#bbf7d0" : "#fecaca"}`, flexShrink: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: r.success ? "#15803d" : "#dc2626" }}>
            {r.success ? "✓ OK" : "✗ Fail"}
          </div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
            {r.latency_ms ? `${r.latency_ms.toFixed(0)}ms` : r.error?.slice(0, 30) || "pending"}
          </div>
        </div>
      ))}
    </div>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  const cfg = priority === "EMERGENCY" ? { bg: "#fef2f2", color: "#dc2626" }
            : priority === "HIGH"      ? { bg: "#fff7ed", color: "#ea580c" }
            :                            { bg: "#f0fdf4", color: "#15803d" };
  return <span style={{ padding: "2px 8px", borderRadius: 20, fontSize: 11,
    background: cfg.bg, color: cfg.color, fontWeight: 600 }}>{priority}</span>;
}

function Label({ children }: { children: React.ReactNode }) {
  return <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 4 }}>{children}</label>;
}

const card: React.CSSProperties = {
  background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0",
  padding: "20px 24px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
};
const cardTitle: React.CSSProperties = { fontSize: 15, fontWeight: 600, color: "#1e293b", marginBottom: 12 };
const input: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #e2e8f0",
  fontSize: 13, boxSizing: "border-box", marginBottom: 0,
};
const td: React.CSSProperties = { padding: "10px 12px", fontSize: 12, color: "#374151" };
