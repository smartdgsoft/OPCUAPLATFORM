import React from "react";
import type { Tag, WsTagUpdate } from "../../types";

interface Props {
  tag: Tag;
  liveValue?: WsTagUpdate;
  icon: React.ReactNode;
}

function qualityColor(q?: number) {
  if (!q) return "#94a3b8";
  if (q >= 192) return "#22c55e";  // Good
  if (q >= 64)  return "#f59e0b";  // Uncertain
  return "#ef4444";                 // Bad
}

function qualityLabel(q?: number) {
  if (!q) return "No Data";
  if (q >= 192) return "Good";
  if (q >= 64)  return "Uncertain";
  return "Bad";
}

export default function LiveTagCard({ tag, liveValue, icon }: Props) {
  const value = liveValue?.value;
  const quality = liveValue?.quality;
  const ts = liveValue?.ts ? new Date(liveValue.ts).toLocaleTimeString() : null;

  const displayValue = value !== undefined && value !== null
    ? typeof value === "number"
      ? value.toFixed(2)
      : String(value)
    : "—";

  return (
    <div style={{
      background: "#fff",
      borderRadius: 12,
      padding: "20px",
      border: "1px solid #e2e8f0",
      boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
      transition: "box-shadow 0.2s",
      position: "relative",
      overflow: "hidden",
    }}>
      {/* Quality stripe */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 3,
        background: qualityColor(quality),
      }} />

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 8,
            background: "#f1f5f9", display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {icon}
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#1e293b" }}>{tag.display_name}</div>
            <div style={{ fontSize: 11, color: "#94a3b8", fontFamily: "monospace" }}>{tag.node_id}</div>
          </div>
        </div>

        <div style={{
          fontSize: 11, padding: "3px 8px", borderRadius: 20,
          background: quality ? `${qualityColor(quality)}18` : "#f1f5f9",
          color: qualityColor(quality),
          fontWeight: 500,
        }}>
          {qualityLabel(quality)}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 36, fontWeight: 700, color: "#0f172a", lineHeight: 1 }}>
          {displayValue}
        </span>
        {tag.engineering_unit && (
          <span style={{ fontSize: 16, color: "#64748b", fontWeight: 400 }}>
            {tag.engineering_unit}
          </span>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 11, color: "#94a3b8" }}>
          Updated: {ts || "waiting…"}
        </div>
        <div style={{ fontSize: 11, color: "#94a3b8" }}>
          {tag.sample_interval_ms}ms
        </div>
      </div>
    </div>
  );
}
