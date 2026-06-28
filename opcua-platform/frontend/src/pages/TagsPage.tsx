import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Tag as TagIcon, Trash2, Activity } from "lucide-react";
import { fetchTags } from "../services/api";
import type { Tag } from "../types";
import { api } from "../services/api";

export default function TagsPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    node_id: "ns=2;i=1001",
    display_name: "",
    engineering_unit: "",
    data_type: "Double",
    deadband_value: 0,
    sample_interval_ms: 1000,
  });

  const { data: tags = [], isLoading } = useQuery({
    queryKey: ["tags"],
    queryFn: () => fetchTags(undefined),
  });

  const createMutation = useMutation({
    mutationFn: (body: typeof form) => api.post("/tags/", body).then((r) => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["tags"] }); setShowForm(false); },
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/tags/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tags"] }),
  });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#0f172a" }}>Tag Registry</h1>
          <p style={{ color: "#64748b", fontSize: 14, marginTop: 4 }}>
            {tags.length} OPC UA nodes configured
          </p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "8px 16px", borderRadius: 8,
            background: "#0ea5e9", border: "none", color: "#fff",
            fontSize: 14, fontWeight: 500, cursor: "pointer",
          }}
        >
          <Plus size={16} /> Add Tag
        </button>
      </div>

      {/* Add tag form */}
      {showForm && (
        <div style={{
          background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0",
          padding: 24, marginBottom: 20,
        }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#1e293b", marginBottom: 16 }}>New Tag</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
            {[
              { label: "OPC UA Node ID", key: "node_id", placeholder: "ns=2;i=1001" },
              { label: "Display Name", key: "display_name", placeholder: "Motor Speed" },
              { label: "Engineering Unit", key: "engineering_unit", placeholder: "rpm" },
            ].map(({ label, key, placeholder }) => (
              <div key={key}>
                <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 4 }}>{label}</label>
                <input
                  placeholder={placeholder}
                  value={(form as any)[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 6,
                    border: "1px solid #e2e8f0", fontSize: 13, boxSizing: "border-box" }}
                />
              </div>
            ))}
            <div>
              <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 4 }}>Data Type</label>
              <select
                value={form.data_type}
                onChange={(e) => setForm({ ...form, data_type: e.target.value })}
                style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #e2e8f0", fontSize: 13 }}
              >
                {["Double", "Float", "Int32", "Boolean", "String"].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 4 }}>Sample Interval (ms)</label>
              <input
                type="number"
                value={form.sample_interval_ms}
                onChange={(e) => setForm({ ...form, sample_interval_ms: +e.target.value })}
                style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #e2e8f0", fontSize: 13 }}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 4 }}>Deadband Value</label>
              <input
                type="number"
                value={form.deadband_value}
                onChange={(e) => setForm({ ...form, deadband_value: +e.target.value })}
                style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #e2e8f0", fontSize: 13 }}
              />
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button
              onClick={() => createMutation.mutate(form)}
              disabled={createMutation.isPending}
              style={{ padding: "8px 20px", borderRadius: 6, background: "#0ea5e9",
                border: "none", color: "#fff", fontSize: 13, cursor: "pointer" }}
            >
              {createMutation.isPending ? "Saving…" : "Save Tag"}
            </button>
            <button onClick={() => setShowForm(false)}
              style={{ padding: "8px 20px", borderRadius: 6, background: "#f1f5f9",
                border: "1px solid #e2e8f0", color: "#374151", fontSize: 13, cursor: "pointer" }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Tags table */}
      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
              {["Name", "Node ID", "Type", "Unit", "Interval", "Deadband", "Status", ""].map((h) => (
                <th key={h} style={{ padding: "12px 16px", textAlign: "left", fontSize: 12,
                  fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={8} style={{ textAlign: "center", padding: 40, color: "#94a3b8" }}>Loading…</td></tr>
            ) : tags.map((tag) => (
              <tr key={tag.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                <td style={{ padding: "12px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <TagIcon size={14} color="#94a3b8" />
                    <span style={{ fontSize: 13, fontWeight: 500, color: "#1e293b" }}>{tag.display_name}</span>
                  </div>
                </td>
                <td style={{ padding: "12px 16px", fontSize: 12, fontFamily: "monospace", color: "#64748b" }}>{tag.node_id}</td>
                <td style={{ padding: "12px 16px", fontSize: 12, color: "#374151" }}>{tag.data_type}</td>
                <td style={{ padding: "12px 16px", fontSize: 12, color: "#374151" }}>{tag.engineering_unit || "—"}</td>
                <td style={{ padding: "12px 16px", fontSize: 12, color: "#374151" }}>{tag.sample_interval_ms}ms</td>
                <td style={{ padding: "12px 16px", fontSize: 12, color: "#374151" }}>{tag.deadband_value}</td>
                <td style={{ padding: "12px 16px" }}>
                  <span style={{
                    padding: "3px 10px", borderRadius: 20, fontSize: 12,
                    background: tag.is_active ? "#f0fdf4" : "#fef2f2",
                    color: tag.is_active ? "#22c55e" : "#ef4444",
                  }}>
                    {tag.is_active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td style={{ padding: "12px 16px" }}>
                  <button
                    onClick={() => deactivateMutation.mutate(tag.id)}
                    style={{ padding: "4px 8px", background: "none", border: "none",
                      cursor: "pointer", color: "#94a3b8" }}
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
