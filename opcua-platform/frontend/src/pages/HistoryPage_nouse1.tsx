import React, { useState } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, Brush,
} from "recharts";
import { format, subHours, subDays } from "date-fns";
import { fetchTags, fetchHistory } from "../services/api";
import type { Tag } from "../types";

const RANGES = [
  { label: "1h",  start: () => subHours(new Date(), 1) },
  { label: "6h",  start: () => subHours(new Date(), 6) },
  { label: "24h", start: () => subHours(new Date(), 24) },
  { label: "7d",  start: () => subDays(new Date(), 7) },
  { label: "30d", start: () => subDays(new Date(), 30) },
];

const COLORS = ["#38bdf8", "#22c55e", "#f97316", "#a78bfa", "#f43f5e", "#fbbf24"];

export default function HistoryPage() {
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [rangeIdx, setRangeIdx] = useState(2);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  const { data: tags = [] } = useQuery({ queryKey: ["tags"], queryFn: () => fetchTags() });

  const start = customStart ? new Date(customStart) : RANGES[rangeIdx].start();
  const end = customEnd ? new Date(customEnd) : new Date();

  // Fetch history for all selected tags using useQueries (Rules-of-Hooks safe:
  // a single hook call handles a dynamic number of parallel queries).
  const historyQueries = useQueries({
    queries: selectedTags.map((tagId) => ({
      queryKey: ["history", tagId, start.toISOString(), end.toISOString()],
      queryFn: () => fetchHistory(tagId, start, end),
      enabled: !!tagId,
    })),
  });

  // Merge all tag data into a single time-keyed dataset
  const merged: Record<string, Record<string, number>> = {};
  historyQueries.forEach((q, i) => {
    const tagId = selectedTags[i];
    const tag = tags.find((t) => t.id === tagId);
    if (!q.data || !tag) return;
    q.data.data.forEach((point) => {
      const key = point.time;
      if (!merged[key]) merged[key] = { time: new Date(key).getTime() };
      merged[key][tag.display_name] = point.avg_val ?? 0;
    });
  });

  const chartData = Object.values(merged).sort((a, b) => (a.time as number) - (b.time as number));

  const toggleTag = (id: string) => {
    setSelectedTags((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  };

  const isLoading = historyQueries.some((q) => q.isLoading);

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#0f172a" }}>History Viewer</h1>
        <p style={{ color: "#64748b", fontSize: 14, marginTop: 4 }}>
          Trend analysis with automatic resolution selection
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 20 }}>
        {/* Tag selector */}
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", padding: 16, alignSelf: "start" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 12 }}>Select Tags</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 420, overflow: "auto" }}>
            {tags.map((tag, i) => (
              <label key={tag.id} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "7px 8px", borderRadius: 6, cursor: "pointer",
                background: selectedTags.includes(tag.id) ? "#eff6ff" : "transparent",
              }}>
                <input
                  type="checkbox"
                  checked={selectedTags.includes(tag.id)}
                  onChange={() => toggleTag(tag.id)}
                  style={{ accentColor: COLORS[i % COLORS.length] }}
                />
                <span style={{ fontSize: 13, color: "#1e293b" }}>{tag.display_name}</span>
                {tag.engineering_unit && (
                  <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: "auto" }}>{tag.engineering_unit}</span>
                )}
              </label>
            ))}
          </div>
        </div>

        {/* Chart panel */}
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", padding: 20 }}>
          {/* Time range selector */}
          <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap", alignItems: "center" }}>
            {RANGES.map((r, i) => (
              <button
                key={r.label}
                onClick={() => { setRangeIdx(i); setCustomStart(""); setCustomEnd(""); }}
                style={{
                  padding: "5px 14px", borderRadius: 6, border: "1px solid",
                  borderColor: rangeIdx === i && !customStart ? "#0ea5e9" : "#e2e8f0",
                  background: rangeIdx === i && !customStart ? "#eff6ff" : "#fff",
                  color: rangeIdx === i && !customStart ? "#0ea5e9" : "#374151",
                  fontSize: 13, cursor: "pointer", fontWeight: 500,
                }}
              >
                {r.label}
              </button>
            ))}
            <div style={{ display: "flex", gap: 6, marginLeft: "auto", alignItems: "center" }}>
              <input
                type="datetime-local"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                style={{ fontSize: 12, padding: "5px 8px", borderRadius: 6, border: "1px solid #e2e8f0" }}
              />
              <span style={{ color: "#94a3b8", fontSize: 13 }}>→</span>
              <input
                type="datetime-local"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                style={{ fontSize: 12, padding: "5px 8px", borderRadius: 6, border: "1px solid #e2e8f0" }}
              />
            </div>
          </div>

          {selectedTags.length === 0 ? (
            <div style={{ height: 400, display: "flex", alignItems: "center", justifyContent: "center", color: "#94a3b8" }}>
              Select one or more tags to view trend
            </div>
          ) : isLoading ? (
            <div style={{ height: 400, display: "flex", alignItems: "center", justifyContent: "center", color: "#94a3b8" }}>
              Loading data…
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={420}>
              <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  scale="time"
                  tickFormatter={(v) => format(new Date(v), "HH:mm")}
                  tick={{ fontSize: 11, fill: "#94a3b8" }}
                />
                <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} />
                <Tooltip
                  labelFormatter={(v) => format(new Date(v), "dd MMM HH:mm:ss")}
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e2e8f0" }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Brush dataKey="time" height={24} stroke="#e2e8f0"
                  tickFormatter={(v) => format(new Date(v), "HH:mm")} />
                {selectedTags.map((id, i) => {
                  const tag = tags.find((t) => t.id === id);
                  return tag ? (
                    <Line
                      key={id}
                      type="monotone"
                      dataKey={tag.display_name}
                      stroke={COLORS[i % COLORS.length]}
                      dot={false}
                      strokeWidth={2}
                      isAnimationActive={false}
                    />
                  ) : null;
                })}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
