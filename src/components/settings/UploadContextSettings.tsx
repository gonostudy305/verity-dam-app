'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Wand2, Plus, Trash2, Save, RefreshCw, Lock } from 'lucide-react';
import { useToast } from '@/components/common/Toast';
import {
  DEFAULT_UPLOAD_CONTEXT,
  MAX_ICON_KEY_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_PRESET_VALUE_LENGTH,
  MAX_QUICK_PRESETS,
  MAX_TAG_GROUPS,
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_GROUP,
  type UploadContextConfig,
  type UploadQuickPreset,
  type UploadTagGroup,
} from '@/config/upload-context';

// Keep in sync with TAG_GROUP_ICON_REGISTRY in
// src/components/upload/BatchContextSelector.tsx -- a key not in that
// registry falls back to a generic icon there rather than crashing, but an
// admin should only be offered keys that actually render.
const ICON_OPTIONS = ['Building2', 'Home', 'Cpu', 'CheckCircle2', 'Wrench', 'Package', 'Camera', 'Tag', 'Layers'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchUploadContext(): Promise<UploadContextConfig> {
  const res = await fetch('/api/settings/upload-context');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message ?? `HTTP ${res.status}`);
  }
  const json = await res.json();
  return json.data ?? DEFAULT_UPLOAD_CONTEXT;
}

async function putUploadContext(quickPresets: UploadQuickPreset[], tagGroups: UploadTagGroup[]): Promise<UploadContextConfig> {
  const res = await fetch('/api/settings/upload-context', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quickPresets, tagGroups }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message ?? `HTTP ${res.status}`);
  }
  const json = await res.json();
  return json.data ?? { quickPresets, tagGroups, updatedAt: null };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function UploadContextSettings() {
  const { showToast } = useToast();

  const [quickPresets, setQuickPresets] = useState<UploadQuickPreset[]>([]);
  const [tagGroups, setTagGroups] = useState<UploadTagGroup[]>([]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  /** null = not checked yet, false = read-only, true = can edit */
  const [canEdit, setCanEdit] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchUploadContext();
      setQuickPresets(data.quickPresets);
      setTagGroups(data.tagGroups);
      setDirty(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('403') || msg.includes('INSUFFICIENT_ROLE') || msg.includes('401') || msg.includes('AUTHENTICATION_REQUIRED')) {
        setCanEdit(false);
      }
      showToast(`Không tải được cấu hình ngữ cảnh upload: ${msg}`, 'warn');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    // Optimistically allow editing; a 403 on save flips this to read-only.
    setCanEdit(true);
    load();
  }, [load]);

  const markDirty = () => setDirty(true);

  // ── Quick presets ────────────────────────────────────────────────────────
  const addPreset = () => {
    if (quickPresets.length >= MAX_QUICK_PRESETS) {
      showToast(`Tối đa ${MAX_QUICK_PRESETS} mẫu nhanh`, 'warn');
      return;
    }
    setQuickPresets((prev) => [...prev, { label: '', icon: '✨', value: '' }]);
    markDirty();
  };

  const updatePreset = (index: number, patch: Partial<UploadQuickPreset>) => {
    setQuickPresets((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
    markDirty();
  };

  const deletePreset = (index: number) => {
    setQuickPresets((prev) => prev.filter((_, i) => i !== index));
    markDirty();
  };

  // ── Tag groups ───────────────────────────────────────────────────────────
  const addGroup = () => {
    if (tagGroups.length >= MAX_TAG_GROUPS) {
      showToast(`Tối đa ${MAX_TAG_GROUPS} nhóm`, 'warn');
      return;
    }
    setTagGroups((prev) => [...prev, { name: '', icon: 'Layers', tags: [] }]);
    markDirty();
  };

  const updateGroup = (index: number, patch: Partial<UploadTagGroup>) => {
    setTagGroups((prev) => prev.map((g, i) => (i === index ? { ...g, ...patch } : g)));
    markDirty();
  };

  const deleteGroup = (index: number) => {
    setTagGroups((prev) => prev.filter((_, i) => i !== index));
    markDirty();
  };

  const addTag = (groupIndex: number, tagText: string) => {
    const trimmed = tagText.trim();
    if (!trimmed) return;
    setTagGroups((prev) =>
      prev.map((g, i) => {
        if (i !== groupIndex) return g;
        if (g.tags.length >= MAX_TAGS_PER_GROUP) {
          showToast(`Nhóm "${g.name}" tối đa ${MAX_TAGS_PER_GROUP} tag`, 'warn');
          return g;
        }
        return { ...g, tags: [...g.tags, trimmed] };
      })
    );
    markDirty();
  };

  const deleteTag = (groupIndex: number, tagIndex: number) => {
    setTagGroups((prev) =>
      prev.map((g, i) => (i === groupIndex ? { ...g, tags: g.tags.filter((_, j) => j !== tagIndex) } : g))
    );
    markDirty();
  };

  // ── Save ─────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    const cleanedPresets = quickPresets
      .map((p) => ({ label: p.label.trim(), icon: p.icon.trim(), value: p.value.trim() }))
      .filter((p) => p.label && p.value);
    const cleanedGroups = tagGroups
      .map((g) => ({ name: g.name.trim(), icon: g.icon.trim(), tags: g.tags.map((t) => t.trim()).filter(Boolean) }))
      .filter((g) => g.name);

    setSaving(true);
    try {
      const saved = await putUploadContext(cleanedPresets, cleanedGroups);
      setQuickPresets(saved.quickPresets);
      setTagGroups(saved.tagGroups);
      setDirty(false);
      showToast('Đã lưu ngữ cảnh upload vào Database dùng chung ✓', 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('403') || msg.includes('INSUFFICIENT_ROLE')) {
        setCanEdit(false);
        showToast('Chỉ Admin mới có quyền lưu ngữ cảnh upload', 'warn');
      } else {
        showToast(`Lỗi lưu ngữ cảnh upload: ${msg}`, 'warn');
      }
    } finally {
      setSaving(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="p-5 rounded-2xl border border-border bg-surface shadow-xs space-y-5">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-verity-soft border border-verity-border flex items-center justify-center flex-none mt-0.5">
            <Wand2 className="w-4 h-4 text-verity" />
          </div>
          <div>
            <div className="text-[14px] font-bold text-text-1">Ngữ cảnh Upload (Mẫu nhanh &amp; Tag)</div>
            <div className="text-[12px] text-text-3">
              Các mẫu nhanh và nhóm tag hiển thị trên trang Upload — không cần deploy code để đổi.
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="p-1.5 rounded-lg text-text-3 hover:text-text-1 hover:bg-surface-2 transition-all disabled:opacity-40"
          title="Tải lại cấu hình"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {canEdit === false && (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-warn-soft border border-warn-border text-[12.5px] text-warn">
          <Lock className="w-3.5 h-3.5 flex-none" />
          <span>Chỉ Admin mới có quyền chỉnh sửa ngữ cảnh upload.</span>
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-10 rounded-lg bg-surface-2 animate-pulse" />
          ))}
        </div>
      ) : (
        <>
          {/* ── Quick presets ── */}
          <div className="space-y-2.5">
            <div className="text-[12px] font-bold text-text-2 uppercase tracking-wide">Mẫu nhanh</div>
            {quickPresets.map((preset, i) => (
              <div key={i} className="grid grid-cols-[56px_1fr_2fr_auto] gap-2 items-center">
                <input
                  type="text"
                  value={preset.icon}
                  onChange={(e) => updatePreset(i, { icon: e.target.value.slice(0, MAX_ICON_KEY_LENGTH) })}
                  disabled={canEdit === false}
                  className="w-full h-9 px-2 rounded-lg border border-border bg-surface text-[14px] text-center outline-none focus:border-verity-border focus:ring-1 focus:ring-verity/20 disabled:opacity-60"
                  title="Emoji hiển thị"
                />
                <input
                  type="text"
                  value={preset.label}
                  onChange={(e) => updatePreset(i, { label: e.target.value.slice(0, MAX_LABEL_LENGTH) })}
                  placeholder="Nhãn hiển thị"
                  disabled={canEdit === false}
                  className="w-full h-9 px-3 rounded-lg border border-border bg-surface text-[13px] text-text-1 outline-none focus:border-verity-border focus:ring-1 focus:ring-verity/20 disabled:opacity-60"
                />
                <input
                  type="text"
                  value={preset.value}
                  onChange={(e) => updatePreset(i, { value: e.target.value.slice(0, MAX_PRESET_VALUE_LENGTH) })}
                  placeholder="Nội dung ngữ cảnh sẽ điền vào ô nhập"
                  disabled={canEdit === false}
                  className="w-full h-9 px-3 rounded-lg border border-border bg-surface text-[13px] text-text-1 outline-none focus:border-verity-border focus:ring-1 focus:ring-verity/20 disabled:opacity-60"
                />
                {canEdit !== false && (
                  <button
                    type="button"
                    onClick={() => deletePreset(i)}
                    className="p-1.5 rounded-md text-text-3 hover:text-bad hover:bg-bad-soft transition-all"
                    title="Xóa mẫu"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
            {canEdit !== false && quickPresets.length < MAX_QUICK_PRESETS && (
              <button
                type="button"
                onClick={addPreset}
                className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-dashed border-border text-[12px] font-semibold text-text-3 hover:text-verity hover:border-verity-border transition-all"
              >
                <Plus className="w-3.5 h-3.5" />
                Thêm mẫu nhanh
              </button>
            )}
          </div>

          {/* ── Tag groups ── */}
          <div className="space-y-3 pt-2 border-t border-border-subtle">
            <div className="text-[12px] font-bold text-text-2 uppercase tracking-wide pt-2">Nhóm tag</div>
            {tagGroups.map((group, gi) => (
              <TagGroupEditor
                key={gi}
                group={group}
                canEdit={canEdit !== false}
                onNameChange={(name) => updateGroup(gi, { name: name.slice(0, MAX_LABEL_LENGTH) })}
                onIconChange={(icon) => updateGroup(gi, { icon })}
                onDeleteGroup={() => deleteGroup(gi)}
                onAddTag={(tag) => addTag(gi, tag.slice(0, MAX_TAG_LENGTH))}
                onDeleteTag={(ti) => deleteTag(gi, ti)}
              />
            ))}
            {canEdit !== false && tagGroups.length < MAX_TAG_GROUPS && (
              <button
                type="button"
                onClick={addGroup}
                className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-dashed border-border text-[12px] font-semibold text-text-3 hover:text-verity hover:border-verity-border transition-all"
              >
                <Plus className="w-3.5 h-3.5" />
                Thêm nhóm tag
              </button>
            )}
          </div>
        </>
      )}

      {/* ── Save button (sticky bottom) ── */}
      {canEdit !== false && dirty && (
        <div className="pt-1 flex justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="h-9 px-4 flex items-center gap-2 rounded-lg bg-verity text-white text-[12.5px] font-semibold hover:opacity-90 transition-all shadow-xs disabled:opacity-50"
          >
            {saving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {saving ? 'Đang lưu...' : 'Lưu ngữ cảnh upload'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Tag group sub-editor ───────────────────────────────────────────────────

function TagGroupEditor({
  group,
  canEdit,
  onNameChange,
  onIconChange,
  onDeleteGroup,
  onAddTag,
  onDeleteTag,
}: {
  group: UploadTagGroup;
  canEdit: boolean;
  onNameChange: (name: string) => void;
  onIconChange: (icon: string) => void;
  onDeleteGroup: () => void;
  onAddTag: (tag: string) => void;
  onDeleteTag: (tagIndex: number) => void;
}) {
  const [newTag, setNewTag] = useState('');

  return (
    <div className="p-3 rounded-xl border border-border bg-surface-2/40 space-y-2.5">
      <div className="flex items-center gap-2">
        <select
          value={group.icon}
          onChange={(e) => onIconChange(e.target.value)}
          disabled={!canEdit}
          className="h-9 px-2 rounded-lg border border-border bg-surface text-[12.5px] outline-none disabled:opacity-60"
        >
          {ICON_OPTIONS.map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={group.name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Tên nhóm (VD: Không gian)"
          disabled={!canEdit}
          className="flex-1 h-9 px-3 rounded-lg border border-border bg-surface text-[13px] font-semibold text-text-1 outline-none focus:border-verity-border focus:ring-1 focus:ring-verity/20 disabled:opacity-60"
        />
        {canEdit && (
          <button
            type="button"
            onClick={onDeleteGroup}
            className="p-1.5 rounded-md text-text-3 hover:text-bad hover:bg-bad-soft transition-all"
            title="Xóa nhóm"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <div className="flex items-center flex-wrap gap-1.5">
        {group.tags.map((tag, ti) => (
          <span
            key={ti}
            className="inline-flex items-center gap-1 h-[26px] pl-2.5 pr-1.5 rounded-lg border border-border bg-surface text-[11.5px] font-semibold text-text-2"
          >
            {tag}
            {canEdit && (
              <button
                type="button"
                onClick={() => onDeleteTag(ti)}
                className="text-text-3 hover:text-bad transition-colors"
                title="Xóa tag"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </span>
        ))}
      </div>

      {canEdit && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onAddTag(newTag);
                setNewTag('');
              }
            }}
            placeholder="Thêm tag mới rồi nhấn Enter"
            className="flex-1 h-8 px-2.5 rounded-lg border border-border bg-surface text-[12px] text-text-1 outline-none focus:border-verity-border focus:ring-1 focus:ring-verity/20"
          />
          <button
            type="button"
            onClick={() => {
              onAddTag(newTag);
              setNewTag('');
            }}
            className="h-8 px-2.5 flex items-center gap-1 rounded-lg bg-surface border border-border text-[11.5px] font-semibold text-text-2 hover:bg-surface-2 transition-all"
          >
            <Plus className="w-3 h-3" />
            Tag
          </button>
        </div>
      )}
    </div>
  );
}
