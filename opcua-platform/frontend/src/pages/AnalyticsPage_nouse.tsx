import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  RadialBarChart, RadialBar, PieChart, Pie, Cell,
  ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from "recharts";
import { subHours, subDays } from "date-fns";
import { fetchTags, fetchAssets, fetchSummary, fetchOEE } from "../services/api";

const RANGES = [
  { label: "Last 8h",  start: () => subHours(new Date(), 8) },
  { label: "Last 24h", start: () => subHours(new Date(), 24) },
  { label: "Last 7d",  start: () => subDays(new Date(), 7) },
];

export default function AnalyticsPage() {
  const [rangeIdx, setRangeIdx] = useState(1);
  const [selectedAsset, setSelectedAsset] = useState<string>("");

  const start = RANGES[rangeIdx].start();
  const end = new Date();

  const { data: tags = [] } = useQuery({ queryKey: ["tags"], queryFn: () => fetchTags() });
  const { data: assets = [] } = useQuery({ queryKey: ["assets"], queryFn: () => fetchAssets() });

  const tagIds = tags.map((t) => t.id);
  const { data: summaries = [] } = useQuery({
    queryKey: ["summary", tagIds, start, end],
    queryFn: () => fetchSummary(tagIds, start, end),
    enabled: tagIds.length > 0,
  });

  const { data: oee } = useQuery({
    queryKey: ["oee", selectedAsset, start, end],
    queryFn: () => fetchOEE(selectedAsset, start, end),
    enabled: !!selectedAsset,
  });

  const oeeData = oee
    ? [
        { name: "Availability", value: oee.availability, fill: "#22c55e" },
        { name: "Performance",  value: oee.performance,  fill: "#38bdf8" },
        { name: "Quality",      value: oee.quality,      fill: "#a78bfa" },
      ]
    : [];

  const barData = summaries.map((s) => ({
    name: s.display_name.replace(" ", "\n"),
    avg: +(s.avg_val ?? 0).toFixed(2),
    min: +(s.min_val ?? 0).toFixed(2),
    max: +(s.max_val ?? 0).toFixed(2),
  }));

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#0f172a" }}>Analytics</h1>
        <p style={{ color: "#64748b", fontSize: 14, marginTop: 4 }}>
          KPIs, OEE, and statistical summaries
        </p>
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 10, marginBottom: 24, alignItems: "center" }}>
        {RANGES.map((r, i) => (
          <button key={i} onClick={() => setRangeIdx(i)} style={{
            padding: "6px 14px", borderRadius: 6, border: "1px solid",
            borderColor: rangeIdx === i ? "#0ea5e9" : "#e2e8f0",
            background: rangeIdx === i ? "#eff6ff" : "#fff",
            color: rangeIdx === i ? "#0ea5e9" : "#374151",
            fontSize: 13, cursor: "pointer", fontWeight: 500,
          }}>
            {r.label}
          </button>
        ))}
        <select
          value={selectedAsset}
          onChange={(e) => setSelectedAsset(e.target.value)}
          style={{ marginLeft: "auto", padding: "6px 12px", borderRadius: 6,
            border: "1px solid #e2e8f0", fontSize: 13, color: "#374151" }}
        >
          <option value="">Select asset for OEE…</option>
          {assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
        {/* OEE Gauge */}
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", padding: 24 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#1e293b", marginBottom: 4 }}>OEE — Overall Equipment Effectiveness</div>
          <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 20 }}>Availability × Performance × Quality</div>
          {oee ? (
            <div style={{ display: "flex", alignItems: "center", gap: 32 }}>
              <div style={{ position: "relative", width: 180, height: 180 }}>
                <ResponsiveContainer width={180} height={180}>
                  <PieChart>
                    <Pie data={[{ value: oee.oee }, { value: 100 - oee.oee }]}
                      cx={80} cy={80} innerRadius={55} outerRadius={80}
                      startAngle={90} endAngle={-270} dataKey="value">
                      <Cell fill="#22c55e" />
                      <Cell fill="#f1f5f9" />
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div style={{
                  position: "absolute", top: "50%", left: "50%",
                  transform: "translate(-50%, -50%)", textAlign: "center",
                }}>
                  <div style={{ fontSize: 28, fontWeight: 700, color: "#0f172a" }}>{oee.oee}%</div>
                  <div style={{ fontSize: 11, color: "#94a3b8" }}>OEE</div>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {oeeData.map((d) => (
                  <div key={d.name}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: "#64748b" }}>{d.name}</span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: "#1e293b" }}>{d.value}%</span>
                    </div>
                    <div style={{ height: 6, background: "#f1f5f9", borderRadius: 3, width: 160 }}>
                      <div style={{ height: "100%", width: `${d.value}%`, background: d.fill, borderRadius: 3 }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ height: 180, display: "flex", alignItems: "center", justifyContent: "center", color: "#94a3b8", fontSize: 13 }}>
              Select an asset above to calculate OEE
            </div>
          )}
        </div>

        {/* Statistical summary cards */}
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", padding: 24 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#1e293b", marginBottom: 16 }}>Tag Statistics</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 280, overflow: "auto" }}>
            {summaries.map((s) => (
              <div key={s.tag_id} style={{
                display: "flex", alignItems: "center", gap: 12,
                padding: "10px 12px", background: "#f8fafc", borderRadius: 8,
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "#1e293b" }}>{s.display_name}</div>
                  <div style={{ fontSize: 11, color: "#94a3b8" }}>{s.sample_count.toLocaleString()} samples</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a" }}>
                    {s.avg_val?.toFixed(2) ?? "—"} <span style={{ fontSize: 11, color: "#94a3b8" }}>{s.engineering_unit}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "#94a3b8" }}>
                    {s.min_val?.toFixed(1)} – {s.max_val?.toFixed(1)}
                  </div>
                </div>
              </div>
            ))}
            {summaries.length === 0 && (
              <div style={{ textAlign: "center", color: "#94a3b8", padding: 24 }}>No data in selected range</div>
            )}
          </div>
        </div>
      </div>

      {/* Min/Avg/Max bar chart */}
      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", padding: 24 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: "#1e293b", marginBottom: 16 }}>Min / Avg / Max Comparison</div>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={barData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#94a3b8" }} />
            <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} />
            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e2e8f0" }} />
            <Bar dataKey="min" fill="#bfdbfe" name="Min" radius={[4, 4, 0, 0]} />
            <Bar dataKey="avg" fill="#38bdf8" name="Avg" radius={[4, 4, 0, 0]} />
            <Bar dataKey="max" fill="#0369a1" name="Max" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
