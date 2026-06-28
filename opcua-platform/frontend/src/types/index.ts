// ── Auth ────────────────────────────────────────────────────────────
export interface User {
  id: string;
  email: string;
  username: string;
  full_name?: string;
  role: "ADMIN" | "ENGINEER" | "OPERATOR" | "VIEWER";
  is_active: boolean;
}

export interface AuthToken {
  access_token: string;
  token_type: string;
  user: User;
}

// ── Assets ──────────────────────────────────────────────────────────
export interface Asset {
  id: string;
  parent_id?: string;
  level_id: number;
  name: string;
  description?: string;
  location?: string;
}

// ── Tags ────────────────────────────────────────────────────────────
export interface Tag {
  id: string;
  node_id: string;
  display_name: string;
  description?: string;
  engineering_unit?: string;
  data_type: string;
  deadband_value: number;
  sample_interval_ms: number;
  is_active: boolean;
  asset_id?: string;
}

export interface TagLiveValue {
  tag_id: string;
  node_id: string;
  value?: number;
  quality: number;
  ts: string;
}

// ── History ─────────────────────────────────────────────────────────
export interface HistoryPoint {
  time: string;
  avg_val?: number;
  min_val?: number;
  max_val?: number;
  last_val?: number;
  sample_count?: number;
}

export interface TagHistory {
  tag_id: string;
  node_id: string;
  display_name: string;
  engineering_unit?: string;
  resolution: string;
  data: HistoryPoint[];
}

// ── Alarms ──────────────────────────────────────────────────────────
export interface AlarmDefinition {
  id: string;
  tag_id: string;
  name: string;
  severity: number;
  condition_type: string;
  limit_value?: number;
  deadband: number;
  message?: string;
  is_active: boolean;
}

export type AlarmState = "ACTIVE" | "ACKNOWLEDGED" | "CLEARED";

export interface AlarmEvent {
  id: string;
  alarm_def_id: string;
  tag_id: string;
  triggered_at: string;
  cleared_at?: string;
  ack_at?: string;
  ack_by?: string;
  trigger_value?: number;
  severity?: number;
  message?: string;
  state: AlarmState;
}

// ── Analytics ───────────────────────────────────────────────────────
export interface TagSummary {
  tag_id: string;
  display_name: string;
  engineering_unit?: string;
  avg_val?: number;
  min_val?: number;
  max_val?: number;
  std_dev?: number;
  sample_count: number;
  first_time?: string;
  last_time?: string;
}

export interface OEEResult {
  asset_id: string;
  start: string;
  end: string;
  availability: number;
  performance: number;
  quality: number;
  oee: number;
}

// ── WebSocket ───────────────────────────────────────────────────────
export interface WsTagUpdate {
  tag_id: string;
  node_id: string;
  value: number | string | boolean;
  quality: number;
  ts: string;
}
