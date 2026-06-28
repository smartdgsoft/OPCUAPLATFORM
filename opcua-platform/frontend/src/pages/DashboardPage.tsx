import React, { useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Thermometer, Gauge, Zap, TrendingUp, AlertTriangle } from "lucide-react";
import { fetchTags, fetchLiveValues, fetchAlarmEvents } from "../services/api";
import { useTagWebSocket } from "../hooks/useTagWebSocket";
import type { Tag, WsTagUpdate } from "../types";
import LiveTagCard from "../components/dashboard/LiveTagCard";
import AlarmBanner from "../components/dashboard/AlarmBanner";
import MiniSparkline from "../components/charts/MiniSparkline";

export default function DashboardPage() {
  const [liveValues, setLiveValues] = useState<Record<string, WsTagUpdate>>({});

  const { data: tags = [] } = useQuery({
    queryKey: ["tags"],
    queryFn: () => fetchTags(),
  });

  const { data: activeAlarms = [] } = useQuery({
    queryKey: ["alarms", "ACTIVE"],
    queryFn: () => fetchAlarmEvents("ACTIVE"),
    refetchInterval: 10_000,
  });

  // Seed initial live values from Redis cache
  const { data: initialLive } = useQuery({
    queryKey: ["live", tags.map((t) => t.id)],
    queryFn: () => fetchLiveValues(tags.map((t) => t.id)),
    enabled: tags.length > 0,
  });

  useEffect(() => {
    if (initialLive) {
      const map: Record<string, WsTagUpdate> = {};
      initialLive.forEach((v) => {
        map[v.tag_id] = { tag_id: v.tag_id, node_id: v.node_id, value: v.value ?? 0, quality: v.quality, ts: v.ts };
      });
      setLiveValues(map);
    }
  }, [initialLive]);

  // WebSocket live updates
  const handleWsUpdate = useCallback((update: WsTagUpdate) => {
    setLiveValues((prev) => ({ ...prev, [update.tag_id]: update }));
  }, []);

  useTagWebSocket(tags.map((t) => t.id), handleWsUpdate);

  const tagIcons: Record<string, React.ReactNode> = {
    Temperature: <Thermometer size={20} color="#f97316" />,
    Pressure: <Gauge size={20} color="#8b5cf6" />,
    Power: <Zap size={20} color="#eab308" />,
    Speed: <Activity size={20} color="#22c55e" />,
  };

  function getIcon(name: string) {
    for (const [k, v] of Object.entries(tagIcons)) {
      if (name.toLowerCase().includes(k.toLowerCase())) return v;
    }
    return <TrendingUp size={20} color="#38bdf8" />;
  }

  const now = new Date();
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#0f172a" }}>Live Dashboard</h1>
        <p style={{ color: "#64748b", fontSize: 14, marginTop: 4 }}>
          Real-time industrial tag monitoring · {tags.length} tags active
        </p>
      </div>

      {/* Alarm banner */}
      {activeAlarms.length > 0 && (
        <AlarmBanner alarms={activeAlarms} />
      )}

      {/* Summary KPI row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
        <KpiCard label="Active Tags" value={tags.filter((t) => t.is_active).length} color="#22c55e" />
        <KpiCard label="Active Alarms" value={activeAlarms.length} color={activeAlarms.length > 0 ? "#ef4444" : "#22c55e"} />
        <KpiCard label="Connected" value="OPC UA" color="#38bdf8" isText />
        <KpiCard label="Data Points Today" value="—" color="#8b5cf6" isText />
      </div>

      {/* Live tag grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
        {tags.map((tag) => (
          <LiveTagCard
            key={tag.id}
            tag={tag}
            liveValue={liveValues[tag.id]}
            icon={getIcon(tag.display_name)}
          />
        ))}
        {tags.length === 0 && (
          <div style={{
            gridColumn: "1/-1", textAlign: "center", padding: 60,
            color: "#94a3b8", background: "#fff", borderRadius: 12,
            border: "1px dashed #e2e8f0",
          }}>
            <Activity size={40} style={{ opacity: 0.3, marginBottom: 12 }} />
            <p>No tags configured yet. Add tags in the Tags section.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function KpiCard({ label, value, color, isText = false }: {
  label: string; value: number | string; color: string; isText?: boolean;
}) {
  return (
    <div style={{
      background: "#fff", borderRadius: 12, padding: "20px 24px",
      border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
    }}>
      <div style={{ color: "#64748b", fontSize: 12, fontWeight: 500, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {label}
      </div>
      <div style={{ fontSize: isText ? 20 : 32, fontWeight: 700, color }}>
        {value}
      </div>
    </div>
  );
}
