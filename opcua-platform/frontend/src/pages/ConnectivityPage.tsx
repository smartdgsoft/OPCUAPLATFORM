import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plug, Plus, Trash2, X, Check, Database, Wifi, WifiOff, AlertTriangle,
  ChevronLeft, List, Power, Pencil,
} from "lucide-react";
import {
  fetchConnectorTypes, fetchSources, createSource, updateSource, deleteSource,
  fetchSourceStreams, testConnectorConnection, fetchConnectorTestResult,
  type ConnectorType, type Source, type SourceInput, type SourceStream,
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
  background: "#fff", borderRadius: 12, padding: 24, width: 560, maxWidth: "94vw",
  maxHeight: "90vh", overflow: "auto", boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
};

export default function ConnectivityPage() {
  const features = useFeatures();
  const [selected, setSelected] = useState<Source | null>(null);

  if (!features.connector_hub) {
    return (
      <div>
        <Header />
        <div style={{ ...card, padding: 40, textAlign: "center", color: "#64748b" }}>
          <Plug size={40} style={{ display: "block", margin: "0 auto 16px", opacity: 0.3 }} />
          <div style={{ fontSize: 15, fontWeight: 600, color: "#1e293b", marginBottom: 8 }}>
            Connector Hub is not enabled
          </div>
          <p style={{ fontSize: 13, maxWidth: 480, margin: "0 auto" }}>
            Set <code style={{ background: "#f1f5f9", padding: "2px 6px", borderRadius: 4 }}>FEATURE_CONNECTOR_HUB=true</code> and
            start the connector-hub service to ingest data from SQL databases, historians, and other sources.
          </p>
        </div>
      </div>
    );
  }

  return selected
    ? <SourceDetail source={selected} onBack={() => setSelected(null)} />
    : <SourceList onOpen={setSelected} />;
}

function Header() {
  return (
    <div style={{ marginBottom: 8 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#0f172a",
        display: "flex", alignItems: "center", gap: 10 }}>
        <Plug size={22} color="#0ea5e9" /> Data Sources
      </h1>
      <p style={{ color: "#64748b", fontSize: 14, marginTop: 4 }}>
        Connect databases, historians, and other systems — data lands alongside OPC UA
      </p>
    </div>
  );
}

function SourceList({ onOpen }: { onOpen: (s: Source) => void }) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editSource, setEditSource] = useState<Source | null>(null);
  const [err, setErr] = useState("");

  const { data: sources = [] } = useQuery({ queryKey: ["sources"], queryFn: fetchSources, refetchInterval: 4000 });
  const { data: types = [] } = useQuery({ queryKey: ["connector-types"], queryFn: fetchConnectorTypes });

  const createMut = useMutation({
    mutationFn: (b: SourceInput) => createSource(b),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sources"] }); setShowAdd(false); setErr(""); },
    onError: (e: any) => setErr(e?.response?.data?.detail ?? "Failed to create source"),
  });
  const updateMut = useMutation({
    mutationFn: ({ id, b }: { id: string; b: Partial<SourceInput> }) => updateSource(id, b),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sources"] }); setEditSource(null); setErr(""); },
    onError: (e: any) => setErr(e?.response?.data?.detail ?? "Failed to update source"),
  });
  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => updateSource(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sources"] }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteSource(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sources"] }),
  });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start" }}>
        <div style={{ flex: 1 }}><Header /></div>
        <button style={btn("#0ea5e9")} onClick={() => { setErr(""); setShowAdd(true); }}>
          <Plus size={16} /> Add Source
        </button>
      </div>

      {sources.length === 0 ? (
        <div style={{ ...card, padding: 48, textAlign: "center", color: "#94a3b8" }}>
          <Database size={40} style={{ display: "block", margin: "0 auto 12px", opacity: 0.3 }} />
          No sources yet. Add a SQL database to start ingesting existing data.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 16 }}>
          {sources.map((s) => {
            const connected = s.last_status === "connected";
            const statusColor = connected ? "#22c55e" : s.last_error ? "#dc2626" : "#94a3b8";
            return (
              <div key={s.id} style={{ ...card, cursor: "pointer" }} onClick={() => onOpen(s)}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 8, flexShrink: 0,
                    background: `${statusColor}18`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {connected ? <Wifi size={20} color={statusColor} /> : <WifiOff size={20} color={statusColor} />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 600, color: "#1e293b" }}>{s.name}</div>
                    <div style={{ fontSize: 12, color: "#94a3b8" }}>{s.source_type} · {s.mode}</div>
                  </div>
                  <button title="Edit" style={iconBtn}
                    onClick={(e) => { e.stopPropagation(); setErr(""); setEditSource(s); }}>
                    <Pencil size={13} />
                  </button>
                  <button title={s.enabled ? "Disable" : "Enable"} style={iconBtn}
                    onClick={(e) => { e.stopPropagation(); toggleMut.mutate({ id: s.id, enabled: !s.enabled }); }}>
                    <Power size={14} color={s.enabled ? "#16a34a" : "#94a3b8"} />
                  </button>
                  <button title="Delete" style={{ ...iconBtn, color: "#dc2626" }}
                    onClick={(e) => { e.stopPropagation();
                      if (confirm(`Delete source "${s.name}"?`)) deleteMut.mutate(s.id); }}>
                    <Trash2 size={14} />
                  </button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 500, color: statusColor }}>
                    {connected ? "Connected" : s.last_error ? "Error" : "Idle"}
                  </span>
                  <span style={{ fontSize: 12, color: "#94a3b8", marginLeft: "auto" }}>
                    <List size={11} style={{ display: "inline", verticalAlign: -1, marginRight: 3 }} />
                    {s.stream_count} stream{s.stream_count !== 1 ? "s" : ""}
                  </span>
                </div>
                {s.last_error && (
                  <div style={{ fontSize: 11, color: "#dc2626", background: "#fef2f2", padding: "6px 8px",
                    borderRadius: 6, marginTop: 8, wordBreak: "break-word" }}>{s.last_error}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showAdd && (
        <AddSourceModal types={types} error={err} busy={createMut.isPending}
          onCancel={() => { setShowAdd(false); setErr(""); }}
          onSubmit={(b) => createMut.mutate(b)} />
      )}
      {editSource && (
        <AddSourceModal types={types} error={err} busy={updateMut.isPending}
          existing={editSource}
          onCancel={() => { setEditSource(null); setErr(""); }}
          onSubmit={(b) => updateMut.mutate({ id: editSource.id, b })} />
      )}
    </div>
  );
}

function AddSourceModal({ types, error, busy, existing, onCancel, onSubmit }: {
  types: ConnectorType[]; error: string; busy: boolean; existing?: Source;
  onCancel: () => void; onSubmit: (b: SourceInput) => void;
}) {
  const available = types.filter((t) => t.available && t.key !== "opcua");
  const ec = existing?.config || {};
  const [name, setName] = useState(existing?.name ?? "");
  const [type, setType] = useState(existing?.source_type ?? available[0]?.key ?? "sql");
  const [pollMs, setPollMs] = useState(existing?.poll_interval_ms ?? 5000);
  const [description, setDescription] = useState(existing?.description ?? "");
  // SQL structured connection fields (pre-filled in edit mode; password blank = keep)
  const [dbType, setDbType] = useState(ec.db_type ?? "postgresql");
  const [host, setHost] = useState(ec.host ?? "");
  const [port, setPort] = useState(ec.port ? String(ec.port) : "");
  const [database, setDatabase] = useState(ec.database ?? "");
  const [username, setUsername] = useState(ec.username ?? "");
  const [password, setPassword] = useState("");
  // SQL query fields
  const [query, setQuery] = useState(ec.query ?? "SELECT ts, value FROM readings WHERE ts > :since ORDER BY ts");
  const [tsCol, setTsCol] = useState(ec.timestamp_column ?? "ts");
  const [valueCols, setValueCols] = useState<string>(
    Array.isArray(ec.value_columns) ? ec.value_columns.join(",") : "value");
  const [keyCol, setKeyCol] = useState(ec.key_column ?? "");
  // MQTT fields
  const [mqttTopics, setMqttTopics] = useState(
    Array.isArray(ec.topics) ? ec.topics.join(", ") : "sensors/#");
  const [mqttPayload, setMqttPayload] = useState(ec.payload ?? "raw");
  const [mqttJsonPath, setMqttJsonPath] = useState(ec.json_value_path ?? "value");
  // Modbus fields (registers as JSON text for flexibility)
  const [modbusUnit, setModbusUnit] = useState(ec.unit_id != null ? String(ec.unit_id) : "1");
  const [modbusRegisters, setModbusRegisters] = useState(
    Array.isArray(ec.registers) ? JSON.stringify(ec.registers, null, 2)
      : '[\n  { "name": "weight:nozzle=3", "address": 100, "type": "holding", "data_type": "float32", "scale": 1.0 }\n]');
  // REST fields
  const [restUrl, setRestUrl] = useState(ec.url ?? "");
  const [restMethod, setRestMethod] = useState(ec.method ?? "GET");
  const [restAuthType, setRestAuthType] = useState(ec.auth?.type ?? "none");
  const [restToken, setRestToken] = useState("");
  const [restApiHeader, setRestApiHeader] = useState(ec.auth?.header ?? "X-API-Key");
  const [restMapMode, setRestMapMode] = useState(ec.mapping?.mode ?? "fields");
  const [restFields, setRestFields] = useState(
    ec.mapping?.fields ? (Array.isArray(ec.mapping.fields) ? ec.mapping.fields.join(", ") : JSON.stringify(ec.mapping.fields)) : "temperature, pressure");
  const [restArrayPath, setRestArrayPath] = useState(ec.mapping?.array_path ?? "data.readings");
  const [restKeyField, setRestKeyField] = useState(ec.mapping?.key_field ?? "");
  const [restValueField, setRestValueField] = useState(ec.mapping?.value_field ?? "value");
  const [restTsField, setRestTsField] = useState(ec.mapping?.ts_field ?? "");

  const isEdit = !!existing;
  const isSqlite = dbType === "sqlite";
  const defaultPort: Record<string, string> = { postgresql: "5432", mysql: "3306", sqlserver: "1433", sqlite: "" };

  const buildConfig = (): any => {
    let config: any = {};
    if (type === "sql") {
      config = {
        db_type: dbType,
        host: host.trim(), port: port.trim() ? Number(port) : null,
        database: database.trim(), username: username.trim(),
        query: query.trim(), timestamp_column: tsCol.trim() || null,
        value_columns: valueCols.split(",").map((s: string) => s.trim()).filter(Boolean),
        key_column: keyCol.trim() || null,
        incremental_column: tsCol.trim() || null,
      };
      if (password) config.password = password;
      else if (isEdit && ec.password) config.password = ec.password;
    } else if (type === "mqtt") {
      config = {
        host: host.trim(), port: port.trim() ? Number(port) : 1883,
        username: username.trim() || null,
        topics: mqttTopics.split(",").map((s: string) => s.trim()).filter(Boolean),
        payload: mqttPayload,
        json_value_path: mqttPayload === "json" ? mqttJsonPath.trim() : undefined,
        tls: false,
      };
      if (password) config.password = password;
      else if (isEdit && ec.password) config.password = ec.password;
    } else if (type === "modbus_tcp") {
      let regs: any = [];
      try { regs = JSON.parse(modbusRegisters); } catch { regs = []; }
      config = {
        host: host.trim(), port: port.trim() ? Number(port) : 502,
        unit_id: Number(modbusUnit) || 1,
        registers: regs,
      };
    } else if (type === "rest") {
      const auth: any = { type: restAuthType };
      if (restAuthType === "bearer") auth.token = restToken || (isEdit ? ec.auth?.token : "");
      else if (restAuthType === "api_key") { auth.header = restApiHeader; auth.key = restToken || (isEdit ? ec.auth?.key : ""); }
      else if (restAuthType === "basic") { auth.username = username.trim(); auth.password = password || (isEdit ? ec.auth?.password : ""); }
      const mapping: any = { mode: restMapMode };
      if (restMapMode === "fields") {
        mapping.fields = restFields.split(",").map((s: string) => s.trim()).filter(Boolean);
      } else {
        mapping.array_path = restArrayPath.trim();
        mapping.value_field = restValueField.trim() || "value";
        if (restKeyField.trim()) mapping.key_field = restKeyField.trim();
        if (restTsField.trim()) mapping.ts_field = restTsField.trim();
      }
      config = { url: restUrl.trim(), method: restMethod, auth, mapping, verify_tls: true };
    }
    return config;
  };

  const [testState, setTestState] = useState<{ status: string; ok?: boolean; detail?: string }>({ status: "idle" });
  const runTest = async () => {
    setTestState({ status: "testing" });
    try {
      const { test_id } = await testConnectorConnection(type, buildConfig());
      // poll up to ~18s
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const res = await fetchConnectorTestResult(test_id);
        if (!res.pending) {
          setTestState({ status: "done", ok: res.ok,
            detail: res.detail + (res.ok && res.streams ? ` · ${res.streams} stream(s) seen` : "") });
          return;
        }
      }
      setTestState({ status: "done", ok: false, detail: "test timed out waiting for result" });
    } catch (e: any) {
      setTestState({ status: "done", ok: false, detail: e?.response?.data?.detail ?? "test failed" });
    }
  };

  const submit = () => {
    if (!name.trim()) return;
    const config = buildConfig();
    onSubmit({ name: name.trim(), source_type: type, mode: "poll",
      config, poll_interval_ms: pollMs, description: description.trim() || null });
  };

  return (
    <div style={overlay} onClick={onCancel}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>
            {isEdit ? "Edit Data Source" : "Add Data Source"}
          </h2>
          <button style={iconBtn} onClick={onCancel}><X size={16} /></button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div><label style={lbl}>Name *</label>
            <input style={inp} value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="e.g. Plant Historian" /></div>
          <div><label style={lbl}>Type</label>
            <select style={inp} value={type} onChange={(e) => setType(e.target.value)} disabled={isEdit}>
              {available.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
            </select></div>
        </div>

        {type === "sql" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div><label style={lbl}>Database type *</label>
                <select style={inp} value={dbType}
                  onChange={(e) => { setDbType(e.target.value); setPort(""); }}>
                  <option value="postgresql">PostgreSQL</option>
                  <option value="mysql">MySQL / MariaDB</option>
                  <option value="sqlserver">Microsoft SQL Server</option>
                  <option value="sqlite">SQLite (file)</option>
                </select></div>
              {!isSqlite && (
                <div><label style={lbl}>Port</label>
                  <input style={inp} value={port} onChange={(e) => setPort(e.target.value)}
                    placeholder={defaultPort[dbType]} /></div>
              )}
            </div>

            {isSqlite ? (
              <>
                <label style={lbl}>Database file path *</label>
                <input style={{ ...inp, marginBottom: 12, fontFamily: "monospace", fontSize: 12 }}
                  value={database} onChange={(e) => setDatabase(e.target.value)}
                  placeholder="/data/plant.db" />
              </>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, marginBottom: 12 }}>
                  <div><label style={lbl}>Host / Server *</label>
                    <input style={inp} value={host} onChange={(e) => setHost(e.target.value)}
                      placeholder="db.plant.local or 10.0.0.5" /></div>
                  <div><label style={lbl}>Database *</label>
                    <input style={inp} value={database} onChange={(e) => setDatabase(e.target.value)}
                      placeholder="historian" /></div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                  <div><label style={lbl}>Username *</label>
                    <input style={inp} value={username} onChange={(e) => setUsername(e.target.value)}
                      placeholder={dbType === "sqlserver" ? "sa" : "user"} /></div>
                  <div><label style={lbl}>Password{isEdit ? " (blank = keep)" : ""}</label>
                    <input style={inp} type="password" value={password}
                      onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" /></div>
                </div>
                {dbType === "sqlserver" && (
                  <div style={{ fontSize: 12, color: "#64748b", background: "#f8fafc", borderRadius: 6,
                    padding: "8px 10px", marginBottom: 12 }}>
                    SQL Server uses SQL/SA authentication. The connector reaches the server over the
                    network — ensure the SQL login has read access to the query's tables.
                  </div>
                )}
              </>
            )}

            <label style={lbl}>Query *  (use :since for incremental polling)</label>
            <textarea style={{ ...inp, marginBottom: 12, fontFamily: "monospace", fontSize: 12, minHeight: 64 }}
              value={query} onChange={(e) => setQuery(e.target.value)} />

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div><label style={lbl}>Timestamp column</label>
                <input style={inp} value={tsCol} onChange={(e) => setTsCol(e.target.value)} placeholder="ts" /></div>
              <div><label style={lbl}>Value columns</label>
                <input style={inp} value={valueCols} onChange={(e) => setValueCols(e.target.value)} placeholder="weight" /></div>
              <div><label style={lbl}>Key column</label>
                <input style={inp} value={keyCol} onChange={(e) => setKeyCol(e.target.value)} placeholder="nozzle (opt)" /></div>
            </div>
            <div style={{ fontSize: 12, color: "#64748b", background: "#f8fafc", borderRadius: 6,
              padding: "8px 10px", marginBottom: 12 }}>
              <strong>Key column</strong> splits one value into per-unit streams — e.g. key column
              "nozzle" turns <code>weight</code> into <code>weight:nozzle=1</code>,
              <code> weight:nozzle=2</code>… so each nozzle is monitored separately.
            </div>
          </>
        )}

        {type === "mqtt" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, marginBottom: 12 }}>
              <div><label style={lbl}>Broker host *</label>
                <input style={inp} value={host} onChange={(e) => setHost(e.target.value)} placeholder="broker.plant.local" /></div>
              <div><label style={lbl}>Port</label>
                <input style={inp} value={port} onChange={(e) => setPort(e.target.value)} placeholder="1883" /></div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div><label style={lbl}>Username</label>
                <input style={inp} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="(optional)" /></div>
              <div><label style={lbl}>Password{isEdit ? " (blank = keep)" : ""}</label>
                <input style={inp} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" /></div>
            </div>
            <label style={lbl}>Topics (comma-separated, MQTT wildcards + and # allowed) *</label>
            <input style={{ ...inp, marginBottom: 12, fontFamily: "monospace", fontSize: 12 }}
              value={mqttTopics} onChange={(e) => setMqttTopics(e.target.value)}
              placeholder="line1/nozzle/+/weight, sensors/#" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div><label style={lbl}>Payload format</label>
                <select style={inp} value={mqttPayload} onChange={(e) => setMqttPayload(e.target.value)}>
                  <option value="raw">Raw (payload is the value)</option>
                  <option value="json">JSON (extract a field)</option>
                </select></div>
              {mqttPayload === "json" && (
                <div><label style={lbl}>JSON value path</label>
                  <input style={inp} value={mqttJsonPath} onChange={(e) => setMqttJsonPath(e.target.value)} placeholder="value" /></div>
              )}
            </div>
            <div style={{ fontSize: 12, color: "#64748b", background: "#f8fafc", borderRadius: 6, padding: "8px 10px", marginBottom: 12 }}>
              Each <strong>topic becomes a stream</strong>, so <code>line1/nozzle/3/weight</code>
              is naturally per-unit — the same attribution the learning engine uses.
            </div>
          </>
        )}

        {type === "modbus_tcp" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div><label style={lbl}>Device host *</label>
                <input style={inp} value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.0.0.50" /></div>
              <div><label style={lbl}>Port</label>
                <input style={inp} value={port} onChange={(e) => setPort(e.target.value)} placeholder="502" /></div>
              <div><label style={lbl}>Unit ID</label>
                <input style={inp} value={modbusUnit} onChange={(e) => setModbusUnit(e.target.value)} placeholder="1" /></div>
            </div>
            <label style={lbl}>Registers (JSON) *</label>
            <textarea style={{ ...inp, marginBottom: 8, fontFamily: "monospace", fontSize: 11, minHeight: 130 }}
              value={modbusRegisters} onChange={(e) => setModbusRegisters(e.target.value)} />
            <div style={{ fontSize: 12, color: "#64748b", background: "#f8fafc", borderRadius: 6, padding: "8px 10px", marginBottom: 12 }}>
              Each register's <strong>name is the stream key</strong> — name them
              <code> weight:nozzle=3</code> for per-unit attribution. Types: holding/input/coil/discrete.
              Data types: int16, uint16, int32, uint32, float32, bool. <code>scale</code>/<code>offset</code> convert to engineering units.
            </div>
          </>
        )}

        {type === "rest" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "3fr 1fr", gap: 12, marginBottom: 12 }}>
              <div><label style={lbl}>Endpoint URL *</label>
                <input style={{ ...inp, fontFamily: "monospace", fontSize: 12 }} value={restUrl}
                  onChange={(e) => setRestUrl(e.target.value)} placeholder="https://api.plant.local/v1/readings" /></div>
              <div><label style={lbl}>Method</label>
                <select style={inp} value={restMethod} onChange={(e) => setRestMethod(e.target.value)}>
                  <option value="GET">GET</option><option value="POST">POST</option>
                </select></div>
            </div>

            <label style={lbl}>Authentication</label>
            <select style={{ ...inp, marginBottom: 10 }} value={restAuthType} onChange={(e) => setRestAuthType(e.target.value)}>
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="api_key">API key header</option>
              <option value="basic">Basic auth</option>
            </select>
            {restAuthType === "bearer" && (
              <div style={{ marginBottom: 12 }}><label style={lbl}>Token{isEdit ? " (blank = keep)" : ""}</label>
                <input style={inp} type="password" value={restToken} onChange={(e) => setRestToken(e.target.value)} placeholder="••••••••" /></div>
            )}
            {restAuthType === "api_key" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, marginBottom: 12 }}>
                <div><label style={lbl}>Header name</label>
                  <input style={inp} value={restApiHeader} onChange={(e) => setRestApiHeader(e.target.value)} placeholder="X-API-Key" /></div>
                <div><label style={lbl}>Key{isEdit ? " (blank = keep)" : ""}</label>
                  <input style={inp} type="password" value={restToken} onChange={(e) => setRestToken(e.target.value)} placeholder="••••••••" /></div>
              </div>
            )}
            {restAuthType === "basic" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                <div><label style={lbl}>Username</label>
                  <input style={inp} value={username} onChange={(e) => setUsername(e.target.value)} /></div>
                <div><label style={lbl}>Password{isEdit ? " (blank = keep)" : ""}</label>
                  <input style={inp} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" /></div>
              </div>
            )}

            <label style={lbl}>Response mapping</label>
            <select style={{ ...inp, marginBottom: 10 }} value={restMapMode} onChange={(e) => setRestMapMode(e.target.value)}>
              <option value="fields">Fields — response is one object, pull named fields</option>
              <option value="array">Array — response is a list of readings (per-unit)</option>
            </select>
            {restMapMode === "fields" ? (
              <>
                <label style={lbl}>Fields (comma-separated; dotted paths allowed)</label>
                <input style={{ ...inp, marginBottom: 12, fontFamily: "monospace", fontSize: 12 }}
                  value={restFields} onChange={(e) => setRestFields(e.target.value)}
                  placeholder="temperature, data.sensors.pressure" />
              </>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 10 }}>
                  <div><label style={lbl}>Array path ("" = root)</label>
                    <input style={inp} value={restArrayPath} onChange={(e) => setRestArrayPath(e.target.value)} placeholder="data.readings" /></div>
                  <div><label style={lbl}>Value field</label>
                    <input style={inp} value={restValueField} onChange={(e) => setRestValueField(e.target.value)} placeholder="weight" /></div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                  <div><label style={lbl}>Key field (per-unit)</label>
                    <input style={inp} value={restKeyField} onChange={(e) => setRestKeyField(e.target.value)} placeholder="nozzle" /></div>
                  <div><label style={lbl}>Timestamp field (optional)</label>
                    <input style={inp} value={restTsField} onChange={(e) => setRestTsField(e.target.value)} placeholder="timestamp" /></div>
                </div>
              </>
            )}
            <div style={{ fontSize: 12, color: "#64748b", background: "#f8fafc", borderRadius: 6, padding: "8px 10px", marginBottom: 12 }}>
              {restMapMode === "array"
                ? <>Array mode gives per-unit attribution: with key field <code>nozzle</code> and value <code>weight</code>, each record becomes <code>weight:nozzle=3</code> — the same attribution the learning engine uses.</>
                : <>Fields mode pulls named values from one JSON object. Each field becomes a stream.</>}
            </div>
          </>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          <div><label style={lbl}>Poll interval (ms)</label>
            <input style={inp} type="number" value={pollMs} onChange={(e) => setPollMs(+e.target.value)} /></div>
          <div><label style={lbl}>Description</label>
            <input style={inp} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" /></div>
        </div>

        {error && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        {testState.status !== "idle" && (
          <div style={{ fontSize: 13, marginBottom: 12, padding: "8px 12px", borderRadius: 6,
            background: testState.status === "testing" ? "#f0f9ff" : testState.ok ? "#f0fdf4" : "#fef2f2",
            color: testState.status === "testing" ? "#0369a1" : testState.ok ? "#15803d" : "#dc2626" }}>
            {testState.status === "testing" ? "Testing connection…"
              : `${testState.ok ? "✓ Connected" : "✗ Failed"} — ${testState.detail}`}
          </div>
        )}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", alignItems: "center" }}>
          <button style={{ ...btn("#f1f5f9", "#334155"), marginRight: "auto" }}
            disabled={testState.status === "testing" || (!host.trim() && !restUrl.trim())} onClick={runTest}>
            {testState.status === "testing" ? "Testing…" : "Test connection"}
          </button>
          <button style={btn("#f1f5f9", "#334155")} onClick={onCancel}>Cancel</button>
          <button style={btn("#0ea5e9")} disabled={busy || !name.trim()} onClick={submit}>
            <Check size={16} /> {isEdit ? "Save Changes" : "Add Source"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SourceDetail({ source, onBack }: { source: Source; onBack: () => void }) {
  const { data: streams = [] } = useQuery({
    queryKey: ["source-streams", source.id],
    queryFn: () => fetchSourceStreams(source.id),
    refetchInterval: 4000,
  });

  return (
    <div>
      <button style={{ ...btn("#f1f5f9", "#334155"), marginBottom: 16 }} onClick={onBack}>
        <ChevronLeft size={16} /> All sources
      </button>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#0f172a" }}>{source.name}</h1>
        <p style={{ color: "#64748b", fontSize: 14, margin: "2px 0 0" }}>
          {source.source_type} · {source.mode} · {source.last_status || "idle"}
        </p>
      </div>

      <h3 style={{ fontSize: 14, fontWeight: 600, color: "#1e293b", marginBottom: 12 }}>
        Discovered streams ({streams.length})
      </h3>
      {streams.length === 0 ? (
        <div style={{ ...card, padding: 32, textAlign: "center", color: "#94a3b8" }}>
          No streams yet. They appear automatically as the source polls data.
        </div>
      ) : (
        <div style={card}>
          {streams.map((s) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12,
              padding: "8px 4px", borderBottom: "1px solid #f1f5f9", fontSize: 13 }}>
              <Database size={14} color="#94a3b8" />
              <span style={{ flex: 1, fontWeight: 500, color: "#1e293b" }}>{s.display_name}</span>
              <code style={{ fontSize: 12, color: "#64748b" }}>{s.stream_key}</code>
              {s.tag_id && <span style={{ fontSize: 11, color: "#16a34a" }}>linked</span>}
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 12 }}>
        Each stream is monitored exactly like an OPC UA tag — usable in twins, predictive models, and rules.
      </div>
    </div>
  );
}
