import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, ChevronRight, Tag } from "lucide-react";
import { fetchAssets, fetchTags } from "../services/api";

const LEVEL_LABELS: Record<number, string> = {
  1: "Enterprise", 2: "Site", 3: "Area", 4: "Work Center", 5: "Work Unit",
};
const LEVEL_COLORS: Record<number, string> = {
  1: "#7c3aed", 2: "#0ea5e9", 3: "#22c55e", 4: "#f97316", 5: "#f43f5e",
};

export default function AssetsPage() {
  const { data: assets = [] } = useQuery({ queryKey: ["assets"], queryFn: fetchAssets });
  const { data: tags = [] } = useQuery({ queryKey: ["tags"], queryFn: () => fetchTags() });

  // Build tree
  const roots = assets.filter((a) => !a.parent_id);

  function tagCount(assetId: string): number {
    return tags.filter((t) => t.asset_id === assetId).length;
  }

  function children(parentId: string) {
    return assets.filter((a) => a.parent_id === parentId);
  }

  function AssetNode({ asset, depth = 0 }: { asset: typeof assets[0]; depth?: number }) {
    const kids = children(asset.id);
    const tc = tagCount(asset.id);
    const color = LEVEL_COLORS[asset.level_id] || "#94a3b8";

    return (
      <div>
        <div style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "12px 16px",
          marginLeft: depth * 24,
          borderBottom: "1px solid #f1f5f9",
          background: depth === 0 ? "#fafafa" : "#fff",
        }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0,
          }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: depth === 0 ? 600 : 500, color: "#1e293b" }}>
              {asset.name}
            </div>
            {asset.description && (
              <div style={{ fontSize: 12, color: "#94a3b8" }}>{asset.description}</div>
            )}
          </div>
          <span style={{
            fontSize: 11, padding: "2px 8px", borderRadius: 12,
            background: `${color}18`, color, fontWeight: 500,
          }}>
            {LEVEL_LABELS[asset.level_id]}
          </span>
          {tc > 0 && (
            <span style={{
              display: "flex", alignItems: "center", gap: 4,
              fontSize: 11, color: "#64748b",
            }}>
              <Tag size={12} /> {tc} tag{tc !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        {kids.map((kid) => (
          <AssetNode key={kid.id} asset={kid} depth={depth + 1} />
        ))}
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#0f172a" }}>Asset Hierarchy</h1>
        <p style={{ color: "#64748b", fontSize: 14, marginTop: 4 }}>
          ISA-95 asset model · {assets.length} assets · {tags.length} tags
        </p>
      </div>

      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", overflow: "hidden" }}>
        {roots.length === 0 ? (
          <div style={{ textAlign: "center", padding: 60, color: "#94a3b8" }}>
            <Building2 size={40} style={{ display: "block", margin: "0 auto 12px", opacity: 0.3 }} />
            No assets configured
          </div>
        ) : roots.map((r) => <AssetNode key={r.id} asset={r} />)}
      </div>
    </div>
  );
}
