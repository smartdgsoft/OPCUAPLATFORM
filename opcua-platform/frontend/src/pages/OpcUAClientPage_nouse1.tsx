import React, { useState, useEffect, useCallback, createContext, useContext } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Wifi, WifiOff, RefreshCw, Server, Activity, List,
  Search, ChevronRight, ChevronDown, Eye, AlertTriangle,
  Shield, Clock, Database, Zap, TrendingUp, Play, Square,
  CheckCircle, XCircle, Info, Folder, Tag, BarChart2,
  Plus, Trash2, X,
} from "lucide-react";
import { format } from "date-fns";
import { api } from "../services/api";
import {
  fetchServers as fetchServerList, addServer, removeServer,
  type OpcServer, type OpcServerInput,
} from "../services/api";
import { useFeatures } from "../hooks/useFeatures";

// ── Types ──────────────────────────────────────────────────────────────────
interface ConnectionStatus {
  connected: boolean;
  server_url: string;
  security_mode: string;
  security_policy: string;
  last_seen: string | null;
  reconnect_count: number;
  queue_depth: number;
  rows_written_total: number;
  rows_buffered_total: number;
}
interface ServerInfo {
  endpoint_url: string;
  server_name: string | null;
  software_version: string | null;
  build_number: string | null;
  manufacturer: string | null;
  namespaces: string[];
}
interface OpcNode {
  node_id: string;
  display_name: string;
  node_class: string;
  data_type: string | null;
  description: string | null;
  children_count: number;
}
interface SubscriptionInfo {
  tag_id: string;
  node_id: string;
  display_name: string;
  engineering_unit: string | null;
  sample_interval_ms: number;
  deadband_value: number;
  last_value: number | null;
  last_quality: number | null;
  last_ts: string | null;
  is_active: boolean;
}
interface ClientMetrics {
  values_received_total: number;
  values_filtered_total: number;
  rows_written_total: number;
  rows_buffered_total: number;
  write_errors_total: number;
  queue_depth: number;
  connection_status: number;
  reconnect_total: number;
}
interface EndpointInfo {
  endpoint_url: string;
  security_mode: string;
  security_policy: string;
  transport_profile: string;
}

// ── API calls ──────────────────────────────────────────────────────────────
const fetchStatus = (): Promise<ConnectionStatus> =>
  api.get("/opcua/status").then((r) => r.data);
const fetchMetrics = (): Promise<ClientMetrics> =>
  api.get("/opcua/metrics").then((r) => r.data);
const fetchServerInfo = (url?: string, serverId?: string): Promise<ServerInfo> =>
  api.get("/opcua/server-info", {
    params: { ...(url ? { server_url: url } : {}), ...(serverId ? { server_id: serverId } : {}) },
  }).then((r) => r.data);
const fetchBrowse = (nodeId: string, serverId?: string, url?: string): Promise<OpcNode[]> =>
  api.get("/opcua/browse", {
    params: { node_id: nodeId, ...(serverId ? { server_id: serverId } : {}), ...(url ? { server_url: url } : {}) },
  }).then((r) => r.data);
const fetchSubscriptions = (serverId?: string): Promise<SubscriptionInfo[]> =>
  api.get("/opcua/subscriptions", {
    params: serverId ? { server_id: serverId } : {},
  }).then((r) => r.data);
const fetchEndpoints = (url: string): Promise<EndpointInfo[]> =>
  api.get("/opcua/endpoints", { params: { server_url: url } }).then((r) => r.data);
const readNodeValue = (nodeId: string, serverId?: string): Promise<any> =>
  api.get("/opcua/node-value", {
    params: { node_id: nodeId, ...(serverId ? { server_id: serverId } : {}) },
  }).then((r) => r.data);
const restartClient = (): Promise<any> =>
  api.post("/opcua/restart").then((r) => r.data);

// ── Selected-server context (multi-server) ─────────────────────────────────
interface ServerCtx {
  serverId: string;            // "default" in single-server mode
  servers: OpcServer[];
  multi: boolean;
}
const SelectedServerContext = createContext<ServerCtx>({ serverId: "default", servers: [], multi: false });
const useServer = () => useContext(SelectedServerContext);

// ── Colours ────────────────────────────────────────────────────────────────
const TABS = ["Servers", "Connection", "Server Info", "Address Space", "Subscriptions", "Metrics", "Security"] as const;
type Tab = typeof TABS[number];

function qualityBadge(q?: number | null) {
  if (q == null) return { label: "No data", bg: "#f1f5f9", color: "#94a3b8" };
  if (q >= 192) return { label: "Good",      bg: "#f0fdf4", color: "#16a34a" };
  if (q >= 64)  return { label: "Uncertain", bg: "#fffbeb", color: "#d97706" };
  return           { label: "Bad",       bg: "#fef2f2", color: "#dc2626" };
}

function nodeClassIcon(nc: string) {
  if (nc === "Variable")  return <Tag   size={14} color="#38bdf8" />;
  if (nc === "Object")    return <Folder size={14} color="#f97316" />;
  if (nc === "Method")    return <Play  size={14} color="#a78bfa" />;
  return <Info size={14} color="#94a3b8" />;
}

// ── Main Component ─────────────────────────────────────────────────────────
export default function OpcUAClientPage() {
  const features = useFeatures();
  const multi = features.multi_server;
  const [tab, setTab] = useState<Tab>(multi ? "Servers" : "Connection");
  const [serverId, setServerId] = useState<string>("default");

  // In multi-server mode, load the server list for the selector + Servers tab.
  const { data: servers = [] } = useQuery({
    queryKey: ["servers"],
    queryFn: fetchServerList,
    refetchInterval: 5000,
    enabled: multi,
  });

  // Default the selected server to the first one once the list loads.
  React.useEffect(() => {
    if (multi && serverId === "default" && servers.length > 0) {
      setServerId(servers[0].id);
    }
  }, [multi, servers, serverId]);

  // Tabs to show: hide "Servers" entirely in single-server mode.
  const visibleTabs = TABS.filter((t) => (t === "Servers" ? multi : true));
  const showSelector = multi && tab !== "Servers" && tab !== "Security";

  return (
    <SelectedServerContext.Provider value={{ serverId, servers, multi }}>
      <div>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#0f172a", display: "flex", alignItems: "center", gap: 10 }}>
              <Wifi size={22} color="#0ea5e9" /> OPC UA Client
            </h1>
            <p style={{ color: "#64748b", fontSize: 14, marginTop: 4 }}>
              Manage connections, browse address space, monitor subscriptions
            </p>
          </div>
          <ConnectionPill />
        </div>

        {/* Tab bar + per-server selector */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, borderBottom: "1px solid #e2e8f0", marginBottom: 24 }}>
          <div style={{ display: "flex", gap: 2, flex: 1 }}>
            {visibleTabs.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  padding: "10px 18px", border: "none", background: "none",
                  fontSize: 14, cursor: "pointer", fontWeight: tab === t ? 600 : 400,
                  color: tab === t ? "#0ea5e9" : "#64748b",
                  borderBottom: `2px solid ${tab === t ? "#0ea5e9" : "transparent"}`,
                  marginBottom: -1,
                }}
              >
                {t}
              </button>
            ))}
          </div>
          {showSelector && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, paddingBottom: 6 }}>
              <Server size={15} color="#64748b" />
              <select
                value={serverId}
                onChange={(e) => setServerId(e.target.value)}
                style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid #e2e8f0", fontSize: 13, color: "#374151" }}
              >
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.connected ? "🟢" : "⚪"} {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Tab content */}
        {tab === "Servers"        && <ServersTab onConnectToView={() => setTab("Connection")} />}
        {tab === "Connection"     && <ConnectionTab />}
        {tab === "Server Info"    && <ServerInfoTab />}
        {tab === "Address Space"  && <AddressSpaceTab />}
        {tab === "Subscriptions"  && <SubscriptionsTab />}
        {tab === "Metrics"        && <MetricsTab />}
        {tab === "Security"       && <SecurityTab />}
      </div>
    </SelectedServerContext.Provider>
  );
}

// ── Connection status pill (always visible) ────────────────────────────────
function ConnectionPill() {
  const { data } = useQuery({ queryKey: ["opcua-status"], queryFn: fetchStatus, refetchInterval: 3000 });
  const mut = useMutation({ mutationFn: restartClient });

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "8px 16px", borderRadius: 24,
        background: data?.connected ? "#f0fdf4" : "#fef2f2",
        border: `1px solid ${data?.connected ? "#bbf7d0" : "#fecaca"}`,
      }}>
        {data?.connected
          ? <Wifi size={16} color="#16a34a" />
          : <WifiOff size={16} color="#dc2626" />}
        <span style={{ fontSize: 13, fontWeight: 600, color: data?.connected ? "#16a34a" : "#dc2626" }}>
          {data?.connected ? "Connected" : "Disconnected"}
        </span>
      </div>
      <button
        onClick={() => mut.mutate()}
        disabled={mut.isPending}
        style={{
          display: "flex", alignItems: "center", gap: 6, padding: "8px 14px",
          borderRadius: 8, border: "1px solid #e2e8f0", background: "#fff",
          color: "#374151", fontSize: 13, cursor: "pointer",
        }}
      >
        <RefreshCw size={14} className={mut.isPending ? "spin" : ""} />
        Reconnect
      </button>
    </div>
  );
}

// ── Tab: Connection ────────────────────────────────────────────────────────
function ConnectionTab() {
  const { data: status, isLoading } = useQuery({
    queryKey: ["opcua-status"],
    queryFn: fetchStatus,
    refetchInterval: 3000,
  });

  const rows = [
    { label: "Server URL",       value: status?.server_url,          icon: <Server size={14} color="#64748b" /> },
    { label: "Security Mode",    value: status?.security_mode,       icon: <Shield size={14} color="#64748b" /> },
    { label: "Security Policy",  value: status?.security_policy,     icon: <Shield size={14} color="#64748b" /> },
    { label: "Last Seen",        value: status?.last_seen ? format(new Date(status.last_seen), "dd MMM HH:mm:ss") : "—", icon: <Clock size={14} color="#64748b" /> },
    { label: "Reconnect Count",  value: status?.reconnect_count,     icon: <RefreshCw size={14} color="#64748b" /> },
    { label: "Queue Depth",      value: status?.queue_depth,         icon: <Database size={14} color="#64748b" /> },
    { label: "Rows Written",     value: status?.rows_written_total?.toLocaleString(), icon: <BarChart2 size={14} color="#64748b" /> },
    { label: "Buffered (offline)", value: status?.rows_buffered_total?.toLocaleString(), icon: <Database size={14} color="#64748b" /> },
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
      {/* Connection info card */}
      <div style={card}>
        <div style={cardTitle}>Connection Details</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {rows.map(({ label, value, icon }) => (
            <div key={label} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "11px 0", borderBottom: "1px solid #f1f5f9",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#64748b", fontSize: 13 }}>
                {icon} {label}
              </div>
              <span style={{ fontSize: 13, fontWeight: 500, color: "#1e293b", fontFamily: label === "Server URL" ? "monospace" : undefined }}>
                {isLoading ? "—" : String(value ?? "—")}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Status indicators */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <StatusGauge
          label="Connection Health"
          connected={status?.connected ?? false}
          detail={status?.connected ? "All monitored items are being published" : "Client is attempting to reconnect"}
        />
        <div style={card}>
          <div style={cardTitle}>Data Flow</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 4 }}>
            <MiniMetric label="Queue depth"  value={status?.queue_depth ?? 0}        unit="msgs" color="#38bdf8" />
            <MiniMetric label="Reconnects"   value={status?.reconnect_count ?? 0}    unit="total" color="#f97316" />
            <MiniMetric label="Written"      value={status?.rows_written_total ?? 0}  unit="rows" color="#22c55e" />
            <MiniMetric label="Buffered"     value={status?.rows_buffered_total ?? 0} unit="rows" color="#a78bfa" />
          </div>
        </div>
        <EndpointDiscovery serverUrl={status?.server_url} />
      </div>
    </div>
  );
}

function StatusGauge({ label, connected, detail }: { label: string; connected: boolean; detail: string }) {
  return (
    <div style={{ ...card, display: "flex", alignItems: "center", gap: 16 }}>
      <div style={{
        width: 52, height: 52, borderRadius: "50%", flexShrink: 0,
        background: connected ? "#f0fdf4" : "#fef2f2",
        display: "flex", alignItems: "center", justifyContent: "center",
        border: `2px solid ${connected ? "#86efac" : "#fca5a5"}`,
      }}>
        {connected
          ? <CheckCircle size={24} color="#16a34a" />
          : <XCircle    size={24} color="#dc2626" />}
      </div>
      <div>
        <div style={{ fontSize: 15, fontWeight: 600, color: "#1e293b" }}>{label}</div>
        <div style={{ fontSize: 12, color: "#64748b", marginTop: 3 }}>{detail}</div>
      </div>
    </div>
  );
}

function MiniMetric({ label, value, unit, color }: { label: string; value: number; unit: string; color: string }) {
  return (
    <div style={{ background: "#f8fafc", borderRadius: 8, padding: "12px 14px" }}>
      <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value.toLocaleString()}</div>
      <div style={{ fontSize: 11, color: "#94a3b8" }}>{unit}</div>
    </div>
  );
}

function EndpointDiscovery({ serverUrl }: { serverUrl?: string }) {
  const [url, setUrl] = useState(serverUrl || "");
  const [triggered, setTriggered] = useState(false);

  const { data: endpoints, isLoading, error } = useQuery({
    queryKey: ["endpoints", url],
    queryFn: () => fetchEndpoints(url),
    enabled: triggered && !!url,
    retry: false,
  });

  useEffect(() => { if (serverUrl) setUrl(serverUrl); }, [serverUrl]);

  return (
    <div style={card}>
      <div style={cardTitle}>Endpoint Discovery</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          value={url}
          onChange={(e) => { setUrl(e.target.value); setTriggered(false); }}
          placeholder="opc.tcp://host:4840"
          style={{ flex: 1, padding: "7px 10px", borderRadius: 6, border: "1px solid #e2e8f0", fontSize: 13 }}
        />
        <button
          onClick={() => setTriggered(true)}
          style={{ padding: "7px 14px", borderRadius: 6, background: "#0ea5e9", border: "none", color: "#fff", fontSize: 13, cursor: "pointer" }}
        >
          Discover
        </button>
      </div>
      {isLoading && <div style={{ color: "#94a3b8", fontSize: 13 }}>Discovering…</div>}
      {error   && <div style={{ color: "#ef4444", fontSize: 13 }}>Could not reach server</div>}
      {endpoints && endpoints.map((ep, i) => (
        <div key={i} style={{
          padding: "8px 10px", borderRadius: 6, background: "#f8fafc",
          marginBottom: 6, fontSize: 12,
        }}>
          <div style={{ fontWeight: 500, color: "#1e293b", marginBottom: 2 }}>{ep.security_mode} / {ep.security_policy}</div>
          <div style={{ color: "#94a3b8", fontFamily: "monospace", fontSize: 11 }}>{ep.endpoint_url}</div>
        </div>
      ))}
    </div>
  );
}

// ── Tab: Server Info ───────────────────────────────────────────────────────
function ServerInfoTab() {
  const { serverId } = useServer();
  const [customUrl, setCustomUrl] = useState("");
  const [triggered, setTriggered] = useState(true);

  const { data: info, isLoading, error, refetch } = useQuery({
    queryKey: ["server-info", serverId, customUrl],
    queryFn: () => fetchServerInfo(customUrl || undefined, serverId),
    enabled: triggered,
    retry: false,
  });

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <input
          value={customUrl}
          onChange={(e) => { setCustomUrl(e.target.value); setTriggered(false); }}
          placeholder="Override server URL (optional)"
          style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 13 }}
        />
        <button
          onClick={() => { setTriggered(true); refetch(); }}
          style={{ padding: "8px 16px", borderRadius: 8, background: "#0ea5e9", border: "none", color: "#fff", fontSize: 13, cursor: "pointer" }}
        >
          Fetch Info
        </button>
      </div>

      {isLoading && <LoadingBlock text="Connecting to OPC UA server…" />}
      {error && <ErrorBlock text="Cannot connect to OPC UA server. Check that it is running and reachable." />}

      {info && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          <div style={card}>
            <div style={cardTitle}>Server Identity</div>
            {[
              ["Product name",      info.server_name],
              ["Manufacturer",      info.manufacturer],
              ["Software version",  info.software_version],
              ["Build number",      info.build_number],
              ["Endpoint URL",      info.endpoint_url],
            ].map(([l, v]) => (
              <InfoRow key={l as string} label={l as string} value={v as string} mono={l === "Endpoint URL"} />
            ))}
          </div>

          <div style={card}>
            <div style={cardTitle}>Namespace Array</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
              {info.namespaces.map((ns, i) => (
                <div key={i} style={{
                  display: "flex", gap: 10, alignItems: "flex-start",
                  padding: "8px 10px", background: "#f8fafc", borderRadius: 6,
                }}>
                  <span style={{
                    minWidth: 24, height: 24, borderRadius: "50%",
                    background: i === 0 ? "#e0f2fe" : "#ede9fe",
                    color: i === 0 ? "#0369a1" : "#6d28d9",
                    fontSize: 11, fontWeight: 700,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {i}
                  </span>
                  <span style={{ fontSize: 12, color: "#374151", fontFamily: "monospace", wordBreak: "break-all" }}>{ns}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "10px 0", borderBottom: "1px solid #f1f5f9" }}>
      <span style={{ fontSize: 13, color: "#64748b" }}>{label}</span>
      <span style={{ fontSize: 13, color: "#1e293b", fontWeight: 500, fontFamily: mono ? "monospace" : undefined, maxWidth: 240, textAlign: "right", wordBreak: "break-all" }}>
        {value || "—"}
      </span>
    </div>
  );
}

// ── Tab: Address Space Browser ─────────────────────────────────────────────
function AddressSpaceTab() {
  const { serverId } = useServer();
  const [path, setPath] = useState<Array<{ node_id: string; label: string }>>([
    { node_id: "i=85", label: "Objects" },
  ]);
  const [selected, setSelected] = useState<OpcNode | null>(null);
  const [nodeValue, setNodeValue] = useState<any>(null);
  const [readingValue, setReadingValue] = useState(false);
  const [search, setSearch] = useState("");

  const currentNodeId = path[path.length - 1].node_id;

  const { data: nodes = [], isLoading } = useQuery({
    queryKey: ["browse", serverId, currentNodeId],
    queryFn: () => fetchBrowse(currentNodeId, serverId),
    retry: false,
  });

  const filtered = search
    ? nodes.filter((n) => n.display_name.toLowerCase().includes(search.toLowerCase()) || n.node_id.includes(search))
    : nodes;

  const navigate = (node: OpcNode) => {
    if (node.children_count > 0) {
      setPath([...path, { node_id: node.node_id, label: node.display_name }]);
      setSearch("");
      setSelected(null);
    }
  };

  const readValue = async (node: OpcNode) => {
    setSelected(node);
    setNodeValue(null);
    if (node.node_class === "Variable") {
      setReadingValue(true);
      try {
        const val = await readNodeValue(node.node_id, serverId);
        setNodeValue(val);
      } catch {
        setNodeValue({ error: "Could not read value" });
      } finally {
        setReadingValue(false);
      }
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 20 }}>
      {/* Browser panel */}
      <div style={card}>
        {/* Breadcrumb */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 14, flexWrap: "wrap" }}>
          {path.map((p, i) => (
            <React.Fragment key={p.node_id}>
              <button
                onClick={() => { setPath(path.slice(0, i + 1)); setSelected(null); }}
                style={{ background: "none", border: "none", color: i === path.length - 1 ? "#0f172a" : "#0ea5e9",
                  fontSize: 13, cursor: i < path.length - 1 ? "pointer" : "default",
                  fontWeight: i === path.length - 1 ? 600 : 400, padding: "2px 4px", borderRadius: 4 }}
              >
                {p.label}
              </button>
              {i < path.length - 1 && <ChevronRight size={14} color="#cbd5e1" />}
            </React.Fragment>
          ))}
        </div>

        {/* Search */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12,
          padding: "7px 10px", background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0" }}>
          <Search size={14} color="#94a3b8" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter nodes…"
            style={{ border: "none", background: "none", outline: "none", fontSize: 13, flex: 1, color: "#374151" }}
          />
        </div>

        {/* Node list */}
        {isLoading ? <LoadingBlock text="Browsing address space…" /> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 500, overflow: "auto" }}>
            {filtered.map((node) => (
              <div
                key={node.node_id}
                onClick={() => readValue(node)}
                onDoubleClick={() => navigate(node)}
                style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "9px 10px",
                  borderRadius: 6, cursor: "pointer",
                  background: selected?.node_id === node.node_id ? "#eff6ff" : "transparent",
                  border: selected?.node_id === node.node_id ? "1px solid #bfdbfe" : "1px solid transparent",
                }}
              >
                {nodeClassIcon(node.node_class)}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "#1e293b", whiteSpace: "nowrap",
                    overflow: "hidden", textOverflow: "ellipsis" }}>
                    {node.display_name}
                  </div>
                  <div style={{ fontSize: 11, color: "#94a3b8", fontFamily: "monospace" }}>
                    {node.node_id}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  <span style={{
                    fontSize: 10, padding: "2px 6px", borderRadius: 10,
                    background: node.node_class === "Variable" ? "#e0f2fe" : "#fef9c3",
                    color: node.node_class === "Variable" ? "#0369a1" : "#854d0e",
                  }}>
                    {node.node_class}
                  </span>
                  {node.children_count > 0 && (
                    <div style={{ display: "flex", alignItems: "center", gap: 3, color: "#94a3b8", fontSize: 11 }}>
                      <span>{node.children_count}</span>
                      <ChevronRight size={12} />
                    </div>
                  )}
                </div>
              </div>
            ))}
            {filtered.length === 0 && !isLoading && (
              <div style={{ textAlign: "center", color: "#94a3b8", padding: 32, fontSize: 13 }}>
                No nodes found
              </div>
            )}
          </div>
        )}
        <div style={{ marginTop: 10, color: "#94a3b8", fontSize: 11 }}>
          {filtered.length} nodes · Double-click to navigate into folders
        </div>
      </div>

      {/* Node detail panel */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {selected ? (
          <>
            <div style={card}>
              <div style={{ ...cardTitle, marginBottom: 12 }}>Node Details</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14,
                padding: "10px", background: "#f8fafc", borderRadius: 8 }}>
                {nodeClassIcon(selected.node_class)}
                <span style={{ fontWeight: 600, color: "#1e293b", fontSize: 14 }}>{selected.display_name}</span>
              </div>
              {[
                ["Node ID",     selected.node_id],
                ["Class",       selected.node_class],
                ["Data type",   selected.data_type],
                ["Children",    selected.children_count],
                ["Description", selected.description],
              ].map(([l, v]) => (
                <InfoRow key={l as string} label={l as string} value={v != null ? String(v) : null}
                  mono={l === "Node ID"} />
              ))}
            </div>

            {selected.node_class === "Variable" && (
              <div style={card}>
                <div style={cardTitle}>Live Value</div>
                {readingValue ? (
                  <LoadingBlock text="Reading from server…" />
                ) : nodeValue ? (
                  nodeValue.error ? (
                    <ErrorBlock text={nodeValue.error} />
                  ) : (
                    <div>
                      <div style={{ fontSize: 32, fontWeight: 700, color: "#0f172a", marginBottom: 8 }}>
                        {nodeValue.value}
                      </div>
                      {[
                        ["Quality",          nodeValue.quality],
                        ["Source timestamp", nodeValue.source_timestamp
                          ? format(new Date(nodeValue.source_timestamp), "HH:mm:ss.SSS")
                          : "—"],
                      ].map(([l, v]) => (
                        <InfoRow key={l as string} label={l as string} value={String(v ?? "—")} />
                      ))}
                      <button
                        onClick={() => readValue(selected)}
                        style={{ marginTop: 12, width: "100%", padding: "7px", borderRadius: 6,
                          border: "1px solid #e2e8f0", background: "#f8fafc", color: "#374151",
                          fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center",
                          justifyContent: "center", gap: 6 }}
                      >
                        <RefreshCw size={13} /> Refresh
                      </button>
                    </div>
                  )
                ) : (
                  <button
                    onClick={() => readValue(selected)}
                    style={{ width: "100%", padding: "10px", borderRadius: 6, border: "1px solid #e2e8f0",
                      background: "#f8fafc", color: "#0ea5e9", fontSize: 13, cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
                  >
                    <Eye size={14} /> Read Value
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          <div style={{ ...card, textAlign: "center", color: "#94a3b8", padding: 40 }}>
            <Folder size={32} style={{ opacity: 0.3, display: "block", margin: "0 auto 10px" }} />
            <p style={{ fontSize: 13 }}>Click a node to see details.<br />Double-click to browse into it.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Tab: Subscriptions ─────────────────────────────────────────────────────
function SubscriptionsTab() {
  const { serverId } = useServer();
  const { data: subs = [], isLoading, refetch } = useQuery({
    queryKey: ["subscriptions", serverId],
    queryFn: () => fetchSubscriptions(serverId),
    refetchInterval: 5000,
  });
  const [search, setSearch] = useState("");

  const filtered = subs.filter((s) =>
    !search || s.display_name.toLowerCase().includes(search.toLowerCase()) || s.node_id.includes(search)
  );

  const goodCount = subs.filter((s) => (s.last_quality ?? 0) >= 192).length;
  const totalActive = subs.filter((s) => s.is_active).length;

  return (
    <div>
      {/* Summary row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 20 }}>
        <SummaryCard label="Total Subscribed" value={totalActive} color="#0ea5e9" />
        <SummaryCard label="Good Quality"     value={goodCount}   color="#22c55e" />
        <SummaryCard label="Bad / No Data"    value={totalActive - goodCount} color="#ef4444" />
        <SummaryCard label="Avg Interval"
          value={subs.length ? Math.round(subs.reduce((a, s) => a + s.sample_interval_ms, 0) / subs.length) + "ms" : "—"}
          color="#a78bfa" isText />
      </div>

      {/* Search + refresh */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
          background: "#fff", borderRadius: 8, border: "1px solid #e2e8f0" }}>
          <Search size={14} color="#94a3b8" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search subscriptions…"
            style={{ border: "none", background: "none", outline: "none", fontSize: 13, flex: 1 }}
          />
        </div>
        <button onClick={() => refetch()} style={{
          padding: "8px 14px", borderRadius: 8, border: "1px solid #e2e8f0",
          background: "#fff", color: "#374151", fontSize: 13, cursor: "pointer",
          display: "flex", alignItems: "center", gap: 6,
        }}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Table */}
      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
              {["Tag Name", "Node ID", "Interval", "Deadband", "Last Value", "Quality", "Last Update"].map((h) => (
                <th key={h} style={{ padding: "11px 14px", textAlign: "left", fontSize: 11,
                  fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} style={{ padding: 40, textAlign: "center", color: "#94a3b8" }}>Loading subscriptions…</td></tr>
            ) : filtered.map((s) => {
              const qb = qualityBadge(s.last_quality);
              return (
                <tr key={s.tag_id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "11px 14px" }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "#1e293b" }}>{s.display_name}</div>
                    {s.engineering_unit && <div style={{ fontSize: 11, color: "#94a3b8" }}>{s.engineering_unit}</div>}
                  </td>
                  <td style={{ padding: "11px 14px", fontSize: 12, fontFamily: "monospace", color: "#64748b" }}>{s.node_id}</td>
                  <td style={{ padding: "11px 14px", fontSize: 12, color: "#374151" }}>{s.sample_interval_ms}ms</td>
                  <td style={{ padding: "11px 14px", fontSize: 12, color: "#374151" }}>{s.deadband_value}</td>
                  <td style={{ padding: "11px 14px", fontSize: 14, fontWeight: 700, color: "#0f172a" }}>
                    {s.last_value != null ? s.last_value.toFixed(3) : "—"}
                  </td>
                  <td style={{ padding: "11px 14px" }}>
                    <span style={{ padding: "3px 10px", borderRadius: 20, fontSize: 12,
                      background: qb.bg, color: qb.color, fontWeight: 500 }}>
                      {qb.label}
                    </span>
                  </td>
                  <td style={{ padding: "11px 14px", fontSize: 12, color: "#64748b" }}>
                    {s.last_ts ? format(new Date(s.last_ts), "HH:mm:ss.SSS") : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, color, isText = false }: any) {
  return (
    <div style={{ background: "#fff", borderRadius: 10, padding: "16px 20px", border: "1px solid #e2e8f0" }}>
      <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase",
        letterSpacing: "0.05em", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: isText ? 18 : 28, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

// ── Tab: Metrics ───────────────────────────────────────────────────────────
function MetricsTab() {
  const { data: m, isLoading } = useQuery({
    queryKey: ["opcua-metrics"],
    queryFn: fetchMetrics,
    refetchInterval: 3000,
  });

  const gauges = [
    { label: "Values received",   value: m?.values_received_total ?? 0,  color: "#22c55e", icon: <Activity size={18} color="#22c55e" /> },
    { label: "Values filtered",   value: m?.values_filtered_total ?? 0,  color: "#f97316", icon: <TrendingUp size={18} color="#f97316" /> },
    { label: "Rows written",      value: m?.rows_written_total ?? 0,     color: "#38bdf8", icon: <Database size={18} color="#38bdf8" /> },
    { label: "Offline buffered",  value: m?.rows_buffered_total ?? 0,    color: "#a78bfa", icon: <Database size={18} color="#a78bfa" /> },
    { label: "Write errors",      value: m?.write_errors_total ?? 0,     color: "#ef4444", icon: <AlertTriangle size={18} color="#ef4444" /> },
    { label: "Queue depth",       value: m?.queue_depth ?? 0,            color: "#eab308", icon: <Zap size={18} color="#eab308" /> },
    { label: "Reconnect count",   value: m?.reconnect_total ?? 0,        color: "#f97316", icon: <RefreshCw size={18} color="#f97316" /> },
  ];

  const filterRate = m && m.values_received_total > 0
    ? ((m.values_filtered_total / m.values_received_total) * 100).toFixed(1)
    : "0.0";

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 20 }}>
        {gauges.map((g) => (
          <div key={g.label} style={{ ...card, display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: `${g.color}18`,
              display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              {g.icon}
            </div>
            <div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 2 }}>{g.label}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: g.color }}>{g.value.toLocaleString()}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <div style={card}>
          <div style={cardTitle}>Dead-band filter effectiveness</div>
          <div style={{ marginTop: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 13, color: "#64748b" }}>Filtered out</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{filterRate}%</span>
            </div>
            <div style={{ height: 12, background: "#f1f5f9", borderRadius: 6 }}>
              <div style={{ height: "100%", width: `${filterRate}%`, background: "#f97316", borderRadius: 6, transition: "width 0.5s" }} />
            </div>
            <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 8 }}>
              Higher % = dead-band filters are saving more DB writes
            </p>
          </div>
        </div>

        <div style={card}>
          <div style={cardTitle}>Connection status</div>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 12 }}>
            <div style={{
              width: 64, height: 64, borderRadius: "50%",
              background: m?.connection_status ? "#f0fdf4" : "#fef2f2",
              display: "flex", alignItems: "center", justifyContent: "center",
              border: `3px solid ${m?.connection_status ? "#86efac" : "#fca5a5"}`,
              flexShrink: 0,
            }}>
              {m?.connection_status
                ? <CheckCircle size={28} color="#16a34a" />
                : <XCircle    size={28} color="#dc2626" />}
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, color: m?.connection_status ? "#16a34a" : "#dc2626" }}>
                {m?.connection_status ? "Online" : "Offline"}
              </div>
              <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 3 }}>
                {m?.reconnect_total} total reconnects
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Tab: Security ──────────────────────────────────────────────────────────
function SecurityTab() {
  const { data: status } = useQuery({ queryKey: ["opcua-status"], queryFn: fetchStatus });

  const securityLevels = [
    { mode: "None",             policy: "None",             label: "No security",       risk: "High",   color: "#ef4444" },
    { mode: "Sign",             policy: "Basic256Sha256",   label: "Signed only",       risk: "Medium", color: "#f97316" },
    { mode: "SignAndEncrypt",   policy: "Basic256Sha256",   label: "Sign + Encrypt",    risk: "Low",    color: "#22c55e" },
    { mode: "SignAndEncrypt",   policy: "Aes128Sha256RsaOaep", label: "Best security", risk: "Very Low", color: "#0ea5e9" },
  ];

  const currentIdx = securityLevels.findIndex(
    (s) => s.mode === status?.security_mode && s.policy === status?.security_policy
  );

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
      <div style={card}>
        <div style={cardTitle}>Current Security Configuration</div>
        <div style={{ marginTop: 12 }}>
          {[
            { label: "Mode",   value: status?.security_mode   || "None" },
            { label: "Policy", value: status?.security_policy || "None" },
          ].map(({ label, value }) => (
            <div key={label} style={{ padding: "12px 0", borderBottom: "1px solid #f1f5f9",
              display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, color: "#64748b" }}>{label}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#1e293b",
                fontFamily: "monospace", background: "#f8fafc", padding: "3px 10px", borderRadius: 6 }}>
                {value}
              </span>
            </div>
          ))}
          <div style={{ marginTop: 14, padding: "12px 14px", borderRadius: 8,
            background: currentIdx >= 2 ? "#f0fdf4" : "#fef9c3",
            border: `1px solid ${currentIdx >= 2 ? "#bbf7d0" : "#fde68a"}` }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: currentIdx >= 2 ? "#15803d" : "#92400e" }}>
              {currentIdx >= 2 ? "✓ Secure configuration" : "⚠ Security hardening recommended"}
            </div>
            {currentIdx < 2 && (
              <div style={{ fontSize: 12, color: "#92400e", marginTop: 4 }}>
                Set OPC_SECURITY_MODE=SignAndEncrypt and OPC_SECURITY_POLICY=Basic256Sha256 in your .env file
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={card}>
        <div style={cardTitle}>Security Levels</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
          {securityLevels.map((s, i) => (
            <div key={i} style={{
              padding: "12px 14px", borderRadius: 8, border: "1px solid",
              borderColor: i === currentIdx ? s.color : "#e2e8f0",
              background: i === currentIdx ? `${s.color}0d` : "#f8fafc",
              display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1e293b" }}>{s.label}</div>
                <div style={{ fontSize: 11, color: "#94a3b8", fontFamily: "monospace" }}>
                  {s.mode} / {s.policy}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: s.color, fontWeight: 500 }}>Risk: {s.risk}</span>
                {i === currentIdx && <CheckCircle size={16} color={s.color} />}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ ...card, gridColumn: "1/-1" }}>
        <div style={cardTitle}>Certificate Setup</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginTop: 12 }}>
          {[
            { step: "1", title: "Generate client cert",
              cmd: "cd opcua-client/certs\nopenssl req -x509 -newkey rsa:2048 -nodes \\\n  -keyout client_key.pem \\\n  -out client_cert.pem -days 365 \\\n  -subj \"/CN=OPCUAClient/O=MyOrg\"" },
            { step: "2", title: "Trust on server",
              cmd: "# Copy client_cert.pem to your\n# OPC UA server's trusted cert store.\n# Process varies by server vendor.\n# (Kepware, UAExpert, etc.)" },
            { step: "3", title: "Update .env",
              cmd: "OPC_SECURITY_MODE=SignAndEncrypt\nOPC_SECURITY_POLICY=Basic256Sha256\nOPC_CERTIFICATE_PATH=/app/certs/client_cert.pem\nOPC_PRIVATE_KEY_PATH=/app/certs/client_key.pem" },
          ].map(({ step, title, cmd }) => (
            <div key={step} style={{ background: "#f8fafc", borderRadius: 8, padding: "14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <span style={{ width: 24, height: 24, borderRadius: "50%", background: "#0ea5e9",
                  color: "#fff", fontSize: 12, fontWeight: 700, display: "flex",
                  alignItems: "center", justifyContent: "center" }}>{step}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#1e293b" }}>{title}</span>
              </div>
              <pre style={{ fontSize: 11, background: "#1e293b", color: "#e2e8f0",
                padding: 10, borderRadius: 6, overflow: "auto", margin: 0, lineHeight: 1.6 }}>
                {cmd}
              </pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Shared components ──────────────────────────────────────────────────────
function LoadingBlock({ text }: { text: string }) {
  return (
    <div style={{ textAlign: "center", padding: "32px 0", color: "#94a3b8", fontSize: 13 }}>
      <RefreshCw size={20} style={{ marginBottom: 8, display: "block", margin: "0 auto 8px" }} />
      {text}
    </div>
  );
}

function ErrorBlock({ text }: { text: string }) {
  return (
    <div style={{ padding: "14px", background: "#fef2f2", border: "1px solid #fecaca",
      borderRadius: 8, color: "#991b1b", fontSize: 13, display: "flex", gap: 8 }}>
      <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} /> {text}
    </div>
  );
}

// ── Shared styles ──────────────────────────────────────────────────────────
const card: React.CSSProperties = {
  background: "#fff",
  borderRadius: 12,
  border: "1px solid #e2e8f0",
  padding: "20px 24px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
};

const cardTitle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: "#1e293b",
  marginBottom: 4,
};

// ── Tab: Servers (multi-server management) ─────────────────────────────────
function ServersTab({ onConnectToView }: { onConnectToView: () => void }) {
  const qc = useQueryClient();
  const { servers } = useServer();
  const [showAdd, setShowAdd] = useState(false);
  const [err, setErr] = useState("");

  const addMut = useMutation({
    mutationFn: (b: OpcServerInput) => addServer(b),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["servers"] }); setShowAdd(false); setErr(""); },
    onError: (e: any) => setErr(e?.response?.data?.detail ?? "Failed to add server"),
  });
  const removeMut = useMutation({
    mutationFn: (id: string) => removeServer(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["servers"] }),
    onError: (e: any) => alert(e?.response?.data?.detail ?? "Failed to remove server"),
  });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
        <div style={{ flex: 1, fontSize: 13, color: "#64748b" }}>
          {servers.length} server{servers.length !== 1 ? "s" : ""} configured. Select one above to inspect its
          connection, address space, subscriptions, and metrics.
        </div>
        <button
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px",
            borderRadius: 6, border: "none", background: "#0ea5e9", color: "#fff",
            fontSize: 13, fontWeight: 500, cursor: "pointer" }}
          onClick={() => { setErr(""); setShowAdd(true); }}
        >
          <Plus size={16} /> Add Server
        </button>
      </div>

      {servers.length === 0 ? (
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0",
          padding: 48, textAlign: "center", color: "#94a3b8" }}>
          <Server size={40} style={{ display: "block", margin: "0 auto 12px", opacity: 0.3 }} />
          No servers configured. Click “Add Server” to connect one.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 16 }}>
          {servers.map((s) => (
            <ServerStatusCard key={s.id} server={s}
              onRemove={() => { if (confirm(`Disable & disconnect "${s.name}"?`)) removeMut.mutate(s.id); }} />
          ))}
        </div>
      )}

      {showAdd && (
        <AddServerModal error={err} busy={addMut.isPending}
          onCancel={() => { setShowAdd(false); setErr(""); }}
          onSubmit={(b) => addMut.mutate(b)} />
      )}
    </div>
  );
}

function ServerStatusCard({ server, onRemove }: { server: OpcServer; onRemove: () => void }) {
  const connected = server.connected;
  const secure = server.security_mode && server.security_mode !== "None";
  const statusColor = connected ? "#22c55e" : server.last_error ? "#dc2626" : "#94a3b8";
  const badge = (color: string, text: string) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 500,
      padding: "3px 8px", borderRadius: 12, background: `${color}18`, color }}>{text}</span>
  );
  return (
    <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0",
      padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius: 8, flexShrink: 0, background: `${statusColor}18`,
          display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Server size={18} color={statusColor} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#1e293b" }}>{server.name}</div>
          <div style={{ fontSize: 12, color: "#94a3b8", wordBreak: "break-all" }}>{server.endpoint_url}</div>
        </div>
        <button title="Disable & remove"
          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28,
            borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", color: "#dc2626" }}
          onClick={onRemove}>
          <Trash2 size={14} />
        </button>
      </div>
      {server.description && <div style={{ fontSize: 12, color: "#64748b" }}>{server.description}</div>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {badge(statusColor, connected ? "Connected" : server.last_error ? "Error" : "Offline")}
        {badge(secure ? "#7c3aed" : "#94a3b8", secure ? server.security_mode : "No security")}
        {typeof server.tag_count === "number" && badge("#0ea5e9", `${server.tag_count} tags`)}
      </div>
      {server.last_error && (
        <div style={{ fontSize: 11, color: "#dc2626", background: "#fef2f2", padding: "6px 8px", borderRadius: 6,
          wordBreak: "break-word" }}>{server.last_error}</div>
      )}
    </div>
  );
}

function AddServerModal({ error, busy, onCancel, onSubmit }: {
  error: string; busy: boolean; onCancel: () => void; onSubmit: (b: OpcServerInput) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("opc.tcp://");
  const [secMode, setSecMode] = useState("None");
  const [secPolicy, setSecPolicy] = useState("None");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [publishMs, setPublishMs] = useState(1000);
  const [description, setDescription] = useState("");
  const secured = secMode !== "None";
  const inp: React.CSSProperties = { width: "100%", padding: "8px 10px", borderRadius: 6,
    border: "1px solid #e2e8f0", fontSize: 13, boxSizing: "border-box" };
  const lbl: React.CSSProperties = { fontSize: 12, color: "#64748b", marginBottom: 4, display: "block" };

  const submit = () => {
    if (!name.trim() || !url.trim()) return;
    onSubmit({
      name: name.trim(), endpoint_url: url.trim(), security_mode: secMode,
      security_policy: secured ? secPolicy : "None",
      username: username.trim() || null, password: password || null,
      publish_interval_ms: publishMs, description: description.trim() || null,
    });
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", display: "flex",
      alignItems: "center", justifyContent: "center", zIndex: 50 }} onClick={onCancel}>
      <div style={{ background: "#fff", borderRadius: 12, padding: 24, width: 520, maxWidth: "94vw",
        maxHeight: "90vh", overflow: "auto", boxShadow: "0 20px 50px rgba(0,0,0,0.25)" }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>Add OPC UA Server</h2>
          <button style={{ background: "none", border: "none", cursor: "pointer", color: "#64748b" }} onClick={onCancel}>
            <X size={18} />
          </button>
        </div>
        <label style={lbl}>Name *</label>
        <input style={{ ...inp, marginBottom: 12 }} value={name} autoFocus
          onChange={(e) => setName(e.target.value)} placeholder="e.g. Plant PLC 2" />
        <label style={lbl}>Endpoint URL *</label>
        <input style={{ ...inp, marginBottom: 12 }} value={url}
          onChange={(e) => setUrl(e.target.value)} placeholder="opc.tcp://192.168.1.50:4840" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div>
            <label style={lbl}>Security Mode</label>
            <select style={inp} value={secMode} onChange={(e) => setSecMode(e.target.value)}>
              <option value="None">None</option><option value="Sign">Sign</option>
              <option value="SignAndEncrypt">SignAndEncrypt</option>
            </select>
          </div>
          <div>
            <label style={lbl}>Security Policy</label>
            <select style={{ ...inp, opacity: secured ? 1 : 0.5 }} value={secPolicy}
              disabled={!secured} onChange={(e) => setSecPolicy(e.target.value)}>
              <option value="None">None</option><option value="Basic256Sha256">Basic256Sha256</option>
              <option value="Aes128_Sha256_RsaOaep">Aes128_Sha256_RsaOaep</option>
              <option value="Aes256_Sha256_RsaPss">Aes256_Sha256_RsaPss</option>
            </select>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div>
            <label style={lbl}>Username (optional)</label>
            <input style={inp} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="anonymous if blank" />
          </div>
          <div>
            <label style={lbl}>Password (optional)</label>
            <input style={inp} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        </div>
        <label style={lbl}>Publish interval (ms)</label>
        <input style={{ ...inp, marginBottom: 12 }} type="number" min={100} step={100}
          value={publishMs} onChange={(e) => setPublishMs(+e.target.value || 1000)} />
        <label style={lbl}>Description (optional)</label>
        <input style={{ ...inp, marginBottom: 16 }} value={description}
          onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Line 2 controller" />
        {secured && (
          <div style={{ fontSize: 12, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a",
            borderRadius: 6, padding: "8px 10px", marginBottom: 14 }}>
            Secured connections may require a client certificate trusted by the server.
          </div>
        )}
        {error && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: "#f1f5f9",
            color: "#334155", fontSize: 13, fontWeight: 500, cursor: "pointer" }} onClick={onCancel}>Cancel</button>
          <button style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: "#0ea5e9",
            color: "#fff", fontSize: 13, fontWeight: 500, cursor: "pointer" }}
            disabled={busy || !name.trim() || !url.trim()} onClick={submit}>
            {busy ? "Adding…" : "Add Server"}
          </button>
        </div>
      </div>
    </div>
  );
}
