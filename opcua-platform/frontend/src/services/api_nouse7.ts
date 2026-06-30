import axios from "axios";
import type {
  AlarmDefinition, AlarmEvent, Asset, AuthToken,
  OEEResult, Tag, TagHistory, TagLiveValue, TagSummary,
} from "../types";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

// FastAPI expects list query params as repeated keys: tag_ids=a&tag_ids=b
// (not the default axios tag_ids[]=a&tag_ids[]=b). This serializer emits
// repeated keys for arrays and skips null/undefined, using only built-ins.
function serializeParams(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        if (v !== undefined && v !== null) sp.append(key, String(v));
      }
    } else {
      sp.append(key, String(value));
    }
  }
  return sp.toString();
}

export const api = axios.create({
  baseURL: `${API_BASE}/api`,
  paramsSerializer: serializeParams,
});

// Inject token from localStorage
api.interceptors.request.use((cfg) => {
  const raw = localStorage.getItem("opcua-auth");
  if (raw) {
    const parsed = JSON.parse(raw);
    if (parsed?.state?.token) {
      cfg.headers.Authorization = `Bearer ${parsed.state.token}`;
    }
  }
  return cfg;
});

// ── Auth ────────────────────────────────────────────────────────────
export const login = async (username: string, password: string): Promise<AuthToken> => {
  const form = new FormData();
  form.append("username", username);
  form.append("password", password);
  const { data } = await api.post<AuthToken>("/auth/token", form);
  return data;
};

// ── Tags ────────────────────────────────────────────────────────────
export const fetchTags = (assetId?: string): Promise<Tag[]> =>
  api.get<Tag[]>("/tags/", { params: { asset_id: assetId } }).then((r) => r.data);

export const fetchLiveValues = (tagIds: string[]): Promise<TagLiveValue[]> =>
  api.get<TagLiveValue[]>("/tags/live", { params: { tag_ids: tagIds } }).then((r) => r.data);

// ── Assets ──────────────────────────────────────────────────────────
export const fetchAssets = (): Promise<Asset[]> =>
  api.get<Asset[]>("/assets/").then((r) => r.data);

export interface AssetLevel { id: number; name: string; }
export const fetchAssetLevels = (): Promise<AssetLevel[]> =>
  api.get<AssetLevel[]>("/assets/levels").then((r) => r.data);

export const fetchAssetTags = (assetId: string): Promise<Tag[]> =>
  api.get<Tag[]>(`/assets/${assetId}/tags`).then((r) => r.data);

export interface AssetInput {
  parent_id?: string | null;
  level_id: number;
  name: string;
  description?: string | null;
  location?: string | null;
}

export const createAsset = (body: AssetInput): Promise<Asset> =>
  api.post<Asset>("/assets/", body).then((r) => r.data);

export const updateAsset = (id: string, body: Partial<AssetInput>): Promise<Asset> =>
  api.put<Asset>(`/assets/${id}`, body).then((r) => r.data);

export const deleteAsset = (id: string): Promise<void> =>
  api.delete(`/assets/${id}`).then(() => undefined);

export const mapTagToAsset = (assetId: string, tagId: string): Promise<void> =>
  api.post(`/assets/${assetId}/tags`, { tag_id: tagId }).then(() => undefined);

export const unmapTagFromAsset = (assetId: string, tagId: string): Promise<void> =>
  api.delete(`/assets/${assetId}/tags/${tagId}`).then(() => undefined);

// ── History ─────────────────────────────────────────────────────────
export const fetchHistory = (
  tagId: string,
  start: Date,
  end: Date,
  resolution?: string
): Promise<TagHistory> =>
  api
    .get<TagHistory>(`/history/${tagId}`, {
      params: {
        start: start.toISOString(),
        end: end.toISOString(),
        ...(resolution ? { resolution } : {}),
      },
    })
    .then((r) => r.data);

// ── Alarms ──────────────────────────────────────────────────────────
export const fetchAlarmEvents = (state?: string): Promise<AlarmEvent[]> =>
  api.get<AlarmEvent[]>("/alarms/events", { params: { state } }).then((r) => r.data);

export const acknowledgeAlarm = (eventId: string): Promise<AlarmEvent> =>
  api.post<AlarmEvent>(`/alarms/events/${eventId}/acknowledge`).then((r) => r.data);

export const fetchAlarmDefinitions = (): Promise<AlarmDefinition[]> =>
  api.get<AlarmDefinition[]>("/alarms/definitions").then((r) => r.data);

// ── Analytics ───────────────────────────────────────────────────────
export const fetchSummary = (
  tagIds: string[],
  start: Date,
  end: Date
): Promise<TagSummary[]> =>
  api
    .get<TagSummary[]>("/analytics/summary", {
      params: { tag_ids: tagIds, start: start.toISOString(), end: end.toISOString() },
    })
    .then((r) => r.data);

export const fetchOEE = (assetId: string, start: Date, end: Date): Promise<OEEResult> =>
  api
    .get<OEEResult>("/analytics/oee", {
      params: { asset_id: assetId, start: start.toISOString(), end: end.toISOString() },
    })
    .then((r) => r.data);

// ── Servers (multi-server management) ───────────────────────────────
export interface OpcServer {
  id: string;
  name: string;
  endpoint_url: string;
  security_mode: string;
  security_policy: string;
  publish_interval_ms?: number;
  enabled: boolean;
  description?: string;
  // live status (enriched from Redis)
  connected?: boolean;
  last_connected?: string | null;
  last_error?: string | null;
  reconnect_count?: number;
  tag_count?: number;
}

export interface OpcServerInput {
  name: string;
  endpoint_url: string;
  security_mode?: string;
  security_policy?: string;
  username?: string | null;
  password?: string | null;
  certificate_path?: string | null;
  private_key_path?: string | null;
  publish_interval_ms?: number;
  description?: string | null;
}

export const fetchServers = (): Promise<OpcServer[]> =>
  api.get<OpcServer[]>("/servers/").then((r) => r.data);

export const addServer = (body: OpcServerInput): Promise<OpcServer> =>
  api.post<OpcServer>("/servers/", body).then((r) => r.data);

export const updateServer = (id: string, body: Partial<OpcServerInput> & { enabled?: boolean }): Promise<OpcServer> =>
  api.put<OpcServer>(`/servers/${id}`, body).then((r) => r.data);

export const removeServer = (id: string): Promise<void> =>
  api.delete(`/servers/${id}`).then(() => undefined);

export const browseServer = (serverId: string, nodeId = "i=85") =>
  api.get(`/servers/${serverId}/browse`, { params: { node_id: nodeId } }).then((r) => r.data);

// ── Digital Twin ────────────────────────────────────────────────────────────
export type TwinHealth = "good" | "warning" | "bad" | "stale" | "unknown";

export interface TwinSummary {
  id: string;
  asset_id: string;
  asset_name: string;
  name: string;
  description?: string;
  model_type: string;
  enabled: boolean;
  health: TwinHealth;
  signal_count: number;
  evaluated_at?: string | null;
}

export interface TwinSignal {
  id: string;
  tag_id: string;
  display_name: string;
  node_id: string;
  role?: string;
  label?: string;
  unit?: string;
  engineering_unit?: string;
  envelope_mode: "manual" | "learned";
  manual_min?: number | null;
  manual_max?: number | null;
  manual_target?: number | null;
  warn_fraction?: number | null;
  learn_method?: string;
  learn_window_hours?: number;
  learn_k?: number;
  learn_p_low?: number;
  learn_p_high?: number;
  learned_min?: number | null;
  learned_max?: number | null;
  learned_target?: number | null;
  learned_at?: string | null;
  learned_sample_count?: number | null;
  live_value?: number | null;
  live_health?: TwinHealth;
  stale?: boolean;
}

export interface TwinDetail extends TwinSummary {
  signals: TwinSignal[];
}

export interface TwinOutput {
  id: string;
  module: string;
  output_type: string;
  tag_id?: string | null;
  severity?: string;
  title?: string;
  detail?: string;
  payload: any;
  requires_approval?: boolean;
  approved?: boolean | null;
  approved_by?: string | null;
  created_at: string;
}

export const fetchTwins = (): Promise<TwinSummary[]> =>
  api.get<TwinSummary[]>("/twin/").then((r) => r.data);

export const fetchTwin = (id: string): Promise<TwinDetail> =>
  api.get<TwinDetail>(`/twin/${id}`).then((r) => r.data);

export const createTwin = (body: { asset_id: string; name: string; description?: string; model_type?: string }): Promise<TwinSummary> =>
  api.post<TwinSummary>("/twin/", body).then((r) => r.data);

export const updateTwin = (id: string, body: { name?: string; description?: string; enabled?: boolean }): Promise<TwinSummary> =>
  api.put<TwinSummary>(`/twin/${id}`, body).then((r) => r.data);

export const deleteTwin = (id: string): Promise<void> =>
  api.delete(`/twin/${id}`).then(() => undefined);

export interface SignalInput {
  tag_id: string;
  role?: string | null;
  label?: string | null;
  unit?: string | null;
  envelope_mode?: "manual" | "learned";
  manual_min?: number | null;
  manual_max?: number | null;
  manual_target?: number | null;
  warn_fraction?: number | null;
  learn_method?: string;
  learn_window_hours?: number;
  learn_k?: number;
  learn_p_low?: number;
  learn_p_high?: number;
}

export const addTwinSignal = (twinId: string, body: SignalInput): Promise<{ id: string }> =>
  api.post(`/twin/${twinId}/signals`, body).then((r) => r.data);

export const updateTwinSignal = (signalId: string, body: Partial<SignalInput>): Promise<{ id: string }> =>
  api.put(`/twin/signals/${signalId}`, body).then((r) => r.data);

export const deleteTwinSignal = (signalId: string): Promise<void> =>
  api.delete(`/twin/signals/${signalId}`).then(() => undefined);

export const learnSignalNow = (signalId: string): Promise<{ learned_min: number; learned_max: number; learned_target: number; sample_count: number }> =>
  api.post(`/twin/signals/${signalId}/learn`).then((r) => r.data);

export const fetchTwinOutputs = (twinId: string): Promise<TwinOutput[]> =>
  api.get<TwinOutput[]>(`/twin/${twinId}/outputs`).then((r) => r.data);

// ── Predictive models ───────────────────────────────────────────────────────
export interface PredMethod {
  key: string; name: string; needs_labels: boolean; min_signals: number; description: string;
}
export interface PredModel {
  id: string; twin_id: string; twin_name: string; name: string; method: string;
  description?: string; enabled: boolean; config: any;
  score_interval_s: number; retrain_cron?: string | null; train_window_hours: number;
  active_version?: number | null; active_trained_at?: string | null; version_count: number;
}
export interface PredVersion {
  id: string; version: number; status: string; trained_at?: string | null;
  trained_by?: string; train_start?: string | null; train_end?: string | null;
  train_sample_count?: number | null; metrics: any; notes?: string;
}
export interface PredAudit {
  event: string; actor?: string; detail?: string; payload: any; created_at: string;
}
export interface PredDrift {
  drift_score: number; drifted: boolean; detail: any; created_at: string;
}
export interface PredModelInput {
  twin_id: string; name: string; method: string; description?: string | null;
  config?: any; score_interval_s?: number; retrain_cron?: string | null; train_window_hours?: number;
}

export const fetchPredMethods = (): Promise<PredMethod[]> =>
  api.get<PredMethod[]>("/predictive/methods").then((r) => r.data);
export const fetchPredModels = (twinId?: string): Promise<PredModel[]> =>
  api.get<PredModel[]>("/predictive/models", { params: twinId ? { twin_id: twinId } : {} }).then((r) => r.data);
export const createPredModel = (b: PredModelInput): Promise<PredModel> =>
  api.post<PredModel>("/predictive/models", b).then((r) => r.data);
export const updatePredModel = (id: string, b: Partial<PredModelInput> & { enabled?: boolean }): Promise<PredModel> =>
  api.put<PredModel>(`/predictive/models/${id}`, b).then((r) => r.data);
export const deletePredModel = (id: string): Promise<void> =>
  api.delete(`/predictive/models/${id}`).then(() => undefined);
export const fetchPredVersions = (id: string): Promise<PredVersion[]> =>
  api.get<PredVersion[]>(`/predictive/models/${id}/versions`).then((r) => r.data);
export const trainPredModel = (id: string): Promise<{ status: string; detail: string }> =>
  api.post(`/predictive/models/${id}/train`).then((r) => r.data);
export const activatePredVersion = (id: string, versionId: string): Promise<{ status: string; version: number }> =>
  api.post(`/predictive/models/${id}/versions/${versionId}/activate`).then((r) => r.data);
export const rollbackPredModel = (id: string): Promise<{ status: string; version: number }> =>
  api.post(`/predictive/models/${id}/rollback`).then((r) => r.data);
export const fetchPredAudit = (id: string): Promise<PredAudit[]> =>
  api.get<PredAudit[]>(`/predictive/models/${id}/audit`).then((r) => r.data);
export const fetchPredDrift = (id: string): Promise<PredDrift[]> =>
  api.get<PredDrift[]>(`/predictive/models/${id}/drift`).then((r) => r.data);
