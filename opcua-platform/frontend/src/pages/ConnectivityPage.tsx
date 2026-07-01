import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plug, Plus, Trash2, X, Check, Database, Wifi, WifiOff, AlertTriangle,
  ChevronLeft, List, Power, Pencil,
} from "lucide-react";
import {
  fetchConnectorTypes, fetchSources, createSource, updateSource, deleteSource,
  fetchSourceStreams,
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
  const [valueCols, setValueCols] = useState(
    Array.isArray(ec.value_columns) ? ec.value_columns.join(",") : "value");
  const [keyCol, setKeyCol] = useState(ec.key_column ?? "");

  const isEdit = !!existing;
  const isSqlite = dbType === "sqlite";
  const defaultPort: Record<string, string> = { postgresql: "5432", mysql: "3306", sqlserver: "1433", sqlite: "" };

  const submit = () => {
    if (!name.trim()) return;
    let config: any = {};
    if (type === "sql") {
      config = {
        db_type: dbType,
        host: host.trim(), port: port.trim() ? Number(port) : null,
        database: database.trim(), username: username.trim(),
        query: query.trim(), timestamp_column: tsCol.trim() || null,
        value_columns: valueCols.split(",").map((s) => s.trim()).filter(Boolean),
        key_column: keyCol.trim() || null,
        incremental_column: tsCol.trim() || null,
      };
      // only send password if the user typed one (blank = keep existing)
      if (password) config.password = password;
      else if (isEdit && ec.password) config.password = ec.password;
    }
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

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          <div><label style={lbl}>Poll interval (ms)</label>
            <input style={inp} type="number" value={pollMs} onChange={(e) => setPollMs(+e.target.value)} /></div>
          <div><label style={lbl}>Description</label>
            <input style={inp} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" /></div>
        </div>

        {error && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
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
