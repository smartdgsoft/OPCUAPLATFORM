import { useEffect, useRef, useCallback } from "react";
import type { WsTagUpdate } from "../types";

const WS_BASE = import.meta.env.VITE_WS_URL ?? "ws://localhost:8000";

type Handler = (update: WsTagUpdate) => void;

export function useTagWebSocket(tagIds: string[], onUpdate: Handler) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();

  const connect = useCallback(() => {
    if (!tagIds.length) return;

    const url = `${WS_BASE}/ws/live?tag_ids=${tagIds.join(",")}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[WS] connected", tagIds.length, "tags");
    };

    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (data.type === "heartbeat") return;
        onUpdate(data as WsTagUpdate);
      } catch {}
    };

    ws.onclose = () => {
      console.log("[WS] disconnected — reconnecting in 3s");
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = (err) => {
      console.error("[WS] error", err);
      ws.close();
    };
  }, [tagIds.join(",")]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);
}
