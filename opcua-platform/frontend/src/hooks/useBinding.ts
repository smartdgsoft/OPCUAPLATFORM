import { useEffect, useState, useMemo, useRef, createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, fetchTagHistory, type WidgetBinding, type DashboardLayout } from "../services/api";

const WS_BASE = (import.meta as any).env?.VITE_WS_URL ?? "ws://localhost:8000";

/**
 * LiveBus — a single multiplexed WebSocket shared by every live widget on the
 * page. Widgets subscribe to a tag_id; the bus opens ONE socket for the union
 * of all requested tags and fans updates out. This avoids one-socket-per-widget
 * (the scalability trap) and is the anti-rework data layer.
 */
class LiveBus {
  private ws: WebSocket | null = null;
  private tags = new Set<string>();
  private latest = new Map<string, { value: number | string; quality: number; ts: string }>();
  private listeners = new Set<() => void>();
  private reconnect: ReturnType<typeof setTimeout> | undefined;

  subscribe(tagIds: string[], cb: () => void): () => void {
    let changed = false;
    tagIds.forEach((t) => { if (t && !this.tags.has(t)) { this.tags.add(t); changed = true; } });
    this.listeners.add(cb);
    if (changed) this.reopen();
    return () => { this.listeners.delete(cb); };
  }
  get(tagId: string) { return this.latest.get(tagId); }

  private reopen() {
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    const ids = [...this.tags];
    if (!ids.length) return;
    const url = `${WS_BASE}/ws/live?tag_ids=${ids.join(",")}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onmessage = (evt) => {
      try {
        const d = JSON.parse(evt.data);
        if (d.type === "heartbeat" || !d.tag_id) return;
        this.latest.set(d.tag_id, { value: d.value, quality: d.quality, ts: d.ts });
        this.listeners.forEach((l) => l());
      } catch {}
    };
    ws.onclose = () => { clearTimeout(this.reconnect); this.reconnect = setTimeout(() => this.reopen(), 3000); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
}
const liveBus = new LiveBus();

// ---- demo mode context (global toggle from the dashboard) ----
export const DemoModeContext = createContext<boolean>(false);
export const useGlobalDemo = () => useContext(DemoModeContext);

export interface ResolvedData {
  live?: { value: number | string; quality: number; ts: string };
  history?: { t: string; v: number }[];
  isDemo: boolean;         // true when showing demo/fallback values
  hasBinding: boolean;     // true when a real binding target is configured
}

/**
 * useBinding — the single resolver every widget uses. Given a binding and its
 * demo fallback, returns the data plus whether it's live or demo. Widgets never
 * talk to the network directly; they read this. New widget types need zero data
 * plumbing — they just consume the resolved shape.
 */
export function useBinding(binding: WidgetBinding | undefined, demo: any): ResolvedData {
  const globalDemo = useGlobalDemo();
  const [, force] = useState(0);
  const tagId = binding?.tag_id || undefined;
  const mode = binding?.mode ?? "static";
  const hasLiveTarget = !!tagId;

  // live: subscribe to the shared bus
  useEffect(() => {
    if (globalDemo || mode !== "live" || !tagId) return;
    const off = liveBus.subscribe([tagId], () => force((n) => n + 1));
    return off;
  }, [tagId, mode, globalDemo]);

  // history: fetch series when bound
  const historyIds = binding?.tag_ids?.filter(Boolean) ?? (tagId ? [tagId] : []);
  const { data: hist } = useQuery({
    queryKey: ["dash-hist", historyIds.join(","), binding?.range, binding?.resolution],
    queryFn: async () => {
      const first = historyIds[0];
      if (!first) return [];
      const r = await fetchTagHistory(first, binding?.range ?? "1H", binding?.resolution ?? "min1");
      return r.points;
    },
    enabled: !globalDemo && mode === "history" && historyIds.length > 0,
    refetchInterval: 15000,
  });

  return useMemo(() => {
    const liveVal = hasLiveTarget ? liveBus.get(tagId!) : undefined;
    if (globalDemo) return { isDemo: true, hasBinding: hasLiveTarget || historyIds.length > 0, live: undefined, history: undefined };
    if (mode === "live") {
      if (liveVal) return { live: liveVal, isDemo: false, hasBinding: true };
      return { isDemo: true, hasBinding: hasLiveTarget }; // bound but no data yet, or unbound
    }
    if (mode === "history") {
      if (hist && hist.length) return { history: hist, isDemo: false, hasBinding: true };
      return { isDemo: true, hasBinding: historyIds.length > 0 };
    }
    return { isDemo: true, hasBinding: false }; // static/unbound → demo
  }, [globalDemo, mode, tagId, hasLiveTarget, hist, historyIds.length]);
}

// alarms + assets resolvers (used by list widgets)
export function useAlarmsData(enabled: boolean) {
  return useQuery({
    queryKey: ["dash-alarms"],
    queryFn: () => api.get("/alarms/events", { params: { active_only: true, limit: 20 } }).then((r) => r.data),
    enabled, refetchInterval: 8000,
  });
}
export function useAssetsData(enabled: boolean) {
  return useQuery({
    queryKey: ["dash-assets"],
    queryFn: () => api.get("/assets/").then((r) => r.data),
    enabled, refetchInterval: 15000,
  });
}

// how many live tags a whole dashboard references (for a header indicator)
export function useDashboardTagCount(layout: DashboardLayout | undefined): number {
  return useMemo(() => {
    if (!layout) return 0;
    const s = new Set<string>();
    layout.widgets.forEach((w) => {
      if (w.binding?.tag_id) s.add(w.binding.tag_id);
      w.binding?.tag_ids?.forEach((t) => t && s.add(t));
    });
    return s.size;
  }, [layout]);
}
