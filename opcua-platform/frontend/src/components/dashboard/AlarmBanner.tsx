import React from "react";
import { AlertTriangle } from "lucide-react";
import type { AlarmEvent } from "../../types";

export default function AlarmBanner({ alarms }: { alarms: AlarmEvent[] }) {
  return (
    <div style={{
      background: "#fef2f2",
      border: "1px solid #fecaca",
      borderRadius: 10,
      padding: "12px 16px",
      marginBottom: 20,
      display: "flex",
      alignItems: "center",
      gap: 12,
    }}>
      <AlertTriangle size={20} color="#ef4444" style={{ flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: "#991b1b" }}>
          {alarms.length} Active Alarm{alarms.length !== 1 ? "s" : ""}
        </span>
        <span style={{ fontSize: 13, color: "#b91c1c", marginLeft: 12 }}>
          {alarms.slice(0, 2).map((a) => a.message || "Threshold exceeded").join(" · ")}
          {alarms.length > 2 ? ` · +${alarms.length - 2} more` : ""}
        </span>
      </div>
      <a href="/alarms" style={{ fontSize: 13, color: "#ef4444", fontWeight: 500, textDecoration: "none" }}>
        View all →
      </a>
    </div>
  );
}
