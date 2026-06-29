import React, { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Building2, Tag as TagIcon, Plus, Pencil, Trash2, Link2, X, Check,
} from "lucide-react";
import {
  fetchAssets, fetchTags, fetchAssetLevels,
  createAsset, updateAsset, deleteAsset, mapTagToAsset, unmapTagFromAsset,
  type AssetInput,
} from "../services/api";
import type { Asset, Tag } from "../types";

const LEVEL_LABELS: Record<number, string> = {
  1: "Enterprise", 2: "Site", 3: "Area", 4: "Work Center", 5: "Work Unit",
};
const LEVEL_COLORS: Record<number, string> = {
  1: "#7c3aed", 2: "#0ea5e9", 3: "#22c55e", 4: "#f97316", 5: "#f43f5e",
};

const btn = (bg: string, fg = "#fff"): React.CSSProperties => ({
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "6px 12px", borderRadius: 6, border: "none",
  background: bg, color: fg, fontSize: 13, fontWeight: 500, cursor: "pointer",
});
const iconBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  width: 28, height: 28, borderRadius: 6, border: "1px solid #e2e8f0",
  background: "#fff", cursor: "pointer", color: "#64748b",
};
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 6,
  border: "1px solid #e2e8f0", fontSize: 13, boxSizing: "border-box",
};
const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50,
};
const modal: React.CSSProperties = {
  background: "#fff", borderRadius: 12, padding: 24, width: 440,
  maxWidth: "92vw", maxHeight: "88vh", overflow: "auto",
  boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
};

type EditState =
  | { mode: "create"; parentId: string | null; levelId: number }
  | { mode: "edit"; asset: Asset }
  | null;

export default function AssetsPage() {
  const qc = useQueryClient();
  const { data: assets = [] } = useQuery({ queryKey: ["assets"], queryFn: fetchAssets });
  const { data: tags = [] } = useQuery({ queryKey: ["tags"], queryFn: () => fetchTags() });
  const { data: levels = [] } = useQuery({ queryKey: ["asset-levels"], queryFn: fetchAssetLevels });

  const [edit, setEdit] = useState<EditState>(null);
  const [mapFor, setMapFor] = useState<Asset | null>(null);
  const [err, setErr] = useState<string>("");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["assets"] });
    qc.invalidateQueries({ queryKey: ["tags"] });
  };

  const createMut = useMutation({
    mutationFn: (b: AssetInput) => createAsset(b),
    onSuccess: () => { invalidate(); setEdit(null); setErr(""); },
    onError: (e: any) => setErr(e?.response?.data?.detail ?? "Create failed"),
  });
  const updateMut = useMutation({
    mutationFn: ({ id, b }: { id: string; b: Partial<AssetInput> }) => updateAsset(id, b),
    onSuccess: () => { invalidate(); setEdit(null); setErr(""); },
    onError: (e: any) => setErr(e?.response?.data?.detail ?? "Update failed"),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteAsset(id),
    onSuccess: invalidate,
    onError: (e: any) => alert(e?.response?.data?.detail ?? "Delete failed"),
  });
  const mapMut = useMutation({
    mutationFn: ({ assetId, tagId }: { assetId: string; tagId: string }) =>
      mapTagToAsset(assetId, tagId),
    onSuccess: invalidate,
  });
  const unmapMut = useMutation({
    mutationFn: ({ assetId, tagId }: { assetId: string; tagId: string }) =>
      unmapTagFromAsset(assetId, tagId),
    onSuccess: invalidate,
  });

  const roots = assets.filter((a) => !a.parent_id);
  const children = (pid: string) => assets.filter((a) => a.parent_id === pid);
  const tagCount = (aid: string) => tags.filter((t) => t.asset_id === aid).length;

  function AssetNode({ asset, depth = 0 }: { asset: Asset; depth?: number }) {
    const kids = children(asset.id);
    const tc = tagCount(asset.id);
    const color = LEVEL_COLORS[asset.level_id] || "#94a3b8";
    const nextLevel = Math.min((asset.level_id ?? 1) + 1, 5);

    return (
      <div>
        <div
          style={{
            display: "flex", alignItems: "center", gap: 12,
            padding: "12px 16px", marginLeft: depth * 24,
            borderBottom: "1px solid #f1f5f9",
            background: depth === 0 ? "#fafafa" : "#fff",
          }}
        >
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
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
            <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#64748b" }}>
              <TagIcon size={12} /> {tc} tag{tc !== 1 ? "s" : ""}
            </span>
          )}
          <div style={{ display: "flex", gap: 6 }}>
            <button title="Map tags" style={iconBtn} onClick={() => setMapFor(asset)}>
              <Link2 size={14} />
            </button>
            <button title="Add child" style={iconBtn}
              onClick={() => { setErr(""); setEdit({ mode: "create", parentId: asset.id, levelId: nextLevel }); }}>
              <Plus size={14} />
            </button>
            <button title="Edit" style={iconBtn}
              onClick={() => { setErr(""); setEdit({ mode: "edit", asset }); }}>
              <Pencil size={14} />
            </button>
            <button title="Delete" style={{ ...iconBtn, color: "#dc2626" }}
              onClick={() => {
                if (confirm(`Delete asset "${asset.name}"? Tags mapped to it will be unmapped.`))
                  deleteMut.mutate(asset.id);
              }}>
              <Trash2 size={14} />
            </button>
          </div>
        </div>
        {kids.map((kid) => <AssetNode key={kid.id} asset={kid} depth={depth + 1} />)}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", marginBottom: 24 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#0f172a" }}>Asset Hierarchy</h1>
          <p style={{ color: "#64748b", fontSize: 14, marginTop: 4 }}>
            ISA-95 asset model · {assets.length} assets · {tags.length} tags
          </p>
        </div>
        <button style={btn("#0ea5e9")}
          onClick={() => { setErr(""); setEdit({ mode: "create", parentId: null, levelId: 1 }); }}>
          <Plus size={16} /> New Root Asset
        </button>
      </div>

      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", overflow: "hidden" }}>
        {roots.length === 0 ? (
          <div style={{ textAlign: "center", padding: 60, color: "#94a3b8" }}>
            <Building2 size={40} style={{ display: "block", margin: "0 auto 12px", opacity: 0.3 }} />
            No assets configured. Click “New Root Asset” to begin.
          </div>
        ) : roots.map((r) => <AssetNode key={r.id} asset={r} />)}
      </div>

      {edit && (
        <AssetEditor
          state={edit}
          assets={assets}
          levels={levels.length ? levels : Object.entries(LEVEL_LABELS).map(([id, name]) => ({ id: +id, name }))}
          error={err}
          busy={createMut.isPending || updateMut.isPending}
          onCancel={() => { setEdit(null); setErr(""); }}
          onSubmit={(body) => {
            if (edit.mode === "create") createMut.mutate(body);
            else updateMut.mutate({ id: edit.asset.id, b: body });
          }}
        />
      )}

      {mapFor && (
        <TagMapper
          asset={mapFor}
          allTags={tags}
          onClose={() => setMapFor(null)}
          onMap={(tagId) => mapMut.mutate({ assetId: mapFor.id, tagId })}
          onUnmap={(tagId) => unmapMut.mutate({ assetId: mapFor.id, tagId })}
        />
      )}
    </div>
  );
}

function AssetEditor({
  state, assets, levels, error, busy, onCancel, onSubmit,
}: {
  state: NonNullable<EditState>;
  assets: Asset[];
  levels: { id: number; name: string }[];
  error: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (b: AssetInput) => void;
}) {
  const initial = state.mode === "edit" ? state.asset : null;
  const [name, setName] = useState(initial?.name ?? "");
  const [levelId, setLevelId] = useState<number>(
    initial?.level_id ?? (state.mode === "create" ? state.levelId : 1)
  );
  const [parentId, setParentId] = useState<string | "">(
    initial?.parent_id ?? (state.mode === "create" ? (state.parentId ?? "") : "")
  );
  const [description, setDescription] = useState(initial?.description ?? "");
  const [location, setLocation] = useState(initial?.location ?? "");

  const parentOptions = useMemo(
    () => assets.filter((a) => !initial || a.id !== initial.id),
    [assets, initial]
  );

  const submit = () => {
    if (!name.trim()) return;
    onSubmit({
      name: name.trim(),
      level_id: levelId,
      parent_id: parentId || null,
      description: description.trim() || null,
      location: location.trim() || null,
    });
  };

  return (
    <div style={overlay} onClick={onCancel}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>
            {state.mode === "create" ? "Create Asset" : "Edit Asset"}
          </h2>
          <button style={iconBtn} onClick={onCancel}><X size={16} /></button>
        </div>

        <label style={{ fontSize: 12, color: "#64748b" }}>Name *</label>
        <input style={{ ...inputStyle, marginBottom: 12 }} value={name}
          onChange={(e) => setName(e.target.value)} placeholder="e.g. Assembly Line 2" autoFocus />

        <label style={{ fontSize: 12, color: "#64748b" }}>Level</label>
        <select style={{ ...inputStyle, marginBottom: 12 }} value={levelId}
          onChange={(e) => setLevelId(+e.target.value)}>
          {levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>

        <label style={{ fontSize: 12, color: "#64748b" }}>Parent</label>
        <select style={{ ...inputStyle, marginBottom: 12 }} value={parentId}
          onChange={(e) => setParentId(e.target.value)}>
          <option value="">— None (root) —</option>
          {parentOptions.map((a) => (
            <option key={a.id} value={a.id}>
              {LEVEL_LABELS[a.level_id]}: {a.name}
            </option>
          ))}
        </select>

        <label style={{ fontSize: 12, color: "#64748b" }}>Description</label>
        <input style={{ ...inputStyle, marginBottom: 12 }} value={description}
          onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />

        <label style={{ fontSize: 12, color: "#64748b" }}>Location</label>
        <input style={{ ...inputStyle, marginBottom: 16 }} value={location}
          onChange={(e) => setLocation(e.target.value)} placeholder="Optional" />

        {error && (
          <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>{error}</div>
        )}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button style={btn("#f1f5f9", "#334155")} onClick={onCancel}>Cancel</button>
          <button style={btn("#0ea5e9")} disabled={busy || !name.trim()} onClick={submit}>
            <Check size={16} /> {state.mode === "create" ? "Create" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TagMapper({
  asset, allTags, onClose, onMap, onUnmap,
}: {
  asset: Asset;
  allTags: Tag[];
  onClose: () => void;
  onMap: (tagId: string) => void;
  onUnmap: (tagId: string) => void;
}) {
  const mapped = allTags.filter((t) => t.asset_id === asset.id);
  const unmapped = allTags.filter((t) => t.asset_id !== asset.id);

  const Row = ({ t, action }: { t: Tag; action: "add" | "remove" }) => (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "8px 10px", borderRadius: 8, background: "#f8fafc", marginBottom: 6,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "#1e293b" }}>{t.display_name}</div>
        <div style={{ fontSize: 11, color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis" }}>
          {t.node_id}
        </div>
      </div>
      {action === "add" ? (
        <button style={btn("#22c55e")} onClick={() => onMap(t.id)}>
          <Plus size={14} /> Map
        </button>
      ) : (
        <button style={btn("#fef2f2", "#dc2626")} onClick={() => onUnmap(t.id)}>
          <X size={14} /> Unmap
        </button>
      )}
    </div>
  );

  return (
    <div style={overlay} onClick={onClose}>
      <div style={{ ...modal, width: 520 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
          <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>
            Map Tags — {asset.name}
          </h2>
          <button style={iconBtn} onClick={onClose}><X size={16} /></button>
        </div>
        <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 0, marginBottom: 16 }}>
          Mapped tags drive this asset’s analytics and OEE.
        </p>

        <div style={{ fontSize: 12, fontWeight: 600, color: "#16a34a", marginBottom: 8 }}>
          Mapped ({mapped.length})
        </div>
        {mapped.length === 0 ? (
          <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 16 }}>No tags mapped yet.</div>
        ) : (
          <div style={{ marginBottom: 16 }}>
            {mapped.map((t) => <Row key={t.id} t={t} action="remove" />)}
          </div>
        )}

        <div style={{ fontSize: 12, fontWeight: 600, color: "#64748b", marginBottom: 8 }}>
          Available ({unmapped.length})
        </div>
        <div style={{ maxHeight: 260, overflow: "auto" }}>
          {unmapped.length === 0 ? (
            <div style={{ fontSize: 12, color: "#94a3b8" }}>All tags are mapped.</div>
          ) : (
            unmapped.map((t) => <Row key={t.id} t={t} action="add" />)
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button style={btn("#0ea5e9")} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
