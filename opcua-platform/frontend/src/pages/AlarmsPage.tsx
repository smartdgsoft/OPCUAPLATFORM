import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle, Clock, Filter } from "lucide-react";
import { format } from "date-fns";
import { fetchAlarmEvents, acknowledgeAlarm } from "../services/api";
import type { AlarmEvent, AlarmState } from "../types";

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#22c55e",
};

function severityLabel(s?: number) {
  if (!s) return "unknown";
  if (s >= 900) return "critical";
  if (s >= 700) return "high";
  if (s >= 400) return "medium";
  return "low";
}

function stateChip(state: AlarmState) {
  const cfg = {
    ACTIVE:       { bg: "#fef2f2", color: "#ef4444", label: "Active" },
    ACKNOWLEDGED: { bg: "#fff7ed", color: "#f97316", label: "Acknowledged" },
    CLEARED:      { bg: "#f0fdf4", color: "#22c55e", label: "Cleared" },
  }[state];
  return (
    <span style={{ padding: "3px 10px", borderRadius: 20, fontSize: 12, fontWeight: 500,
      background: cfg.bg, color: cfg.color }}>
      {cfg.label}
    </span>
  );
}

export default function AlarmsPage() {
  const [stateFilter, setStateFilter] = useState<AlarmState | "ALL">("ALL");
  const qc = useQueryClient();

  const { data: events = [], isLoading } = useQuery({
    queryKey: ["alarms", stateFilter],
    queryFn: () => fetchAlarmEvents(stateFilter === "ALL" ? undefined : stateFilter),
    refetchInterval: 5_000,
  });

  const ackMutation = useMutation({
    mutationFn: acknowledgeAlarm,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alarms"] }),
  });

  const activeCount = events.filter((e) => e.state === "ACTIVE").length;

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#0f172a" }}>Alarm Management</h1>
        <p style={{ color: "#64748b", fontSize: 14, marginTop: 4 }}>
          {activeCount > 0
            ? `⚠ ${activeCount} active alarm${activeCount !== 1 ? "s" : ""} requiring attention`
            : "No active alarms"}
        </p>
      </div>

      {/* Filter bar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20, background: "#fff",
        padding: "12px 16px", borderRadius: 10, border: "1px solid #e2e8f0" }}>
        <Filter size={16} color="#94a3b8" style={{ alignSelf: "center" }} />
        {(["ALL", "ACTIVE", "ACKNOWLEDGED", "CLEARED"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStateFilter(s)}
            style={{
              padding: "5px 14px", borderRadius: 6, border: "1px solid",
              borderColor: stateFilter === s ? "#0ea5e9" : "#e2e8f0",
              background: stateFilter === s ? "#eff6ff" : "#fff",
              color: stateFilter === s ? "#0ea5e9" : "#374151",
              fontSize: 13, cursor: "pointer", fontWeight: 500,
            }}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Events table */}
      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
              {["Severity", "State", "Message", "Triggered", "Value", "Ack'd By", "Action"].map((h) => (
                <th key={h} style={{ padding: "12px 16px", textAlign: "left", fontSize: 12,
                  fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} style={{ textAlign: "center", padding: 40, color: "#94a3b8" }}>Loading…</td></tr>
            ) : events.length === 0 ? (
              <tr><td colSpan={7} style={{ textAlign: "center", padding: 40, color: "#94a3b8" }}>
                <CheckCircle size={32} style={{ display: "block", margin: "0 auto 8px", opacity: 0.3 }} />
                No alarms found
              </td></tr>
            ) : events.map((event) => {
              const sev = severityLabel(event.severity);
              const sevColor = SEVERITY_COLORS[sev];
              return (
                <tr key={event.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "12px 16px" }}>
                    <span style={{
                      display: "inline-flex", alignItems: "center", gap: 6,
                      fontSize: 12, fontWeight: 600, color: sevColor,
                    }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: sevColor }} />
                      {sev.toUpperCase()}
                    </span>
                  </td>
                  <td style={{ padding: "12px 16px" }}>{stateChip(event.state)}</td>
                  <td style={{ padding: "12px 16px", fontSize: 13, color: "#374151", maxWidth: 240 }}>
                    {event.message || "Threshold exceeded"}
                  </td>
                  <td style={{ padding: "12px 16px", fontSize: 12, color: "#64748b" }}>
                    {format(new Date(event.triggered_at), "dd MMM HH:mm:ss")}
                  </td>
                  <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 600, color: "#1e293b" }}>
                    {event.trigger_value?.toFixed(2) ?? "—"}
                  </td>
                  <td style={{ padding: "12px 16px", fontSize: 12, color: "#64748b" }}>
                    {event.ack_by || (event.ack_at ? format(new Date(event.ack_at), "HH:mm") : "—")}
                  </td>
                  <td style={{ padding: "12px 16px" }}>
                    {event.state === "ACTIVE" && (
                      <button
                        onClick={() => ackMutation.mutate(event.id)}
                        disabled={ackMutation.isPending}
                        style={{
                          padding: "5px 12px", borderRadius: 6, border: "1px solid #e2e8f0",
                          background: "#fff", color: "#0ea5e9", fontSize: 12,
                          cursor: "pointer", fontWeight: 500,
                        }}
                      >
                        Acknowledge
                      </button>
                    )}
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
