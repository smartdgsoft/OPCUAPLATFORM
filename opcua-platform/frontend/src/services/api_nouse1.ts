import axios from "axios";
import type {
  AlarmDefinition, AlarmEvent, Asset, AuthToken,
  OEEResult, Tag, TagHistory, TagLiveValue, TagSummary,
} from "../types";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

export const api = axios.create({ baseURL: `${API_BASE}/api` });

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
