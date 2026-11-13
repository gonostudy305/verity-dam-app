'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { BookOpen, Plus, Trash2, Search, Save, RefreshCw, Lock } from 'lucide-react';
import { useToast } from '@/components/common/Toast';

export interface SynonymItem {
  id: string;
  from: string;
  to: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchSynonyms(): Promise<SynonymItem[]> {
  const res = await fetch('/api/settings/synonyms');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message ?? `HTTP ${res.status}`);
  }
  const json = await res.json();
  return Array.isArray(json.items) ? json.items : [];
}

async function putSynonyms(items: SynonymItem[]): Promise<SynonymItem[]> {
  const res = await fetch('/api/settings/synonyms', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message ?? `HTTP ${res.status}`);
  }
  const json = await res.json();
  return Array.isArray(json.items) ? json.items : items;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SynonymsSettings() {
  const { showToast } = useToast();

  const [synonyms, setSynonyms] = useState<SynonymItem[]>([]);
  const [newFrom, setNewFrom] = useState('');
  const [newTo, setNewTo] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  /** Tracks local unsaved changes */
  const [dirty, setDirty] = useState(false);
  /** null = not checked yet, false = read-only, true = can edit */
  const [canEdit, setCanEdit] = useState<boolean | null>(null);

  // ── Load from API on mount ──────────────────────────────────────────────────
  const loadSynonyms = useCallback(async () => {
    setLoading(true);
    try {
      const items = await fetchSynonyms();
      setSynonyms(items);
      setDirty(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('403') || msg.includes('INSUFFICIENT_ROLE') || msg.includes('401') || msg.includes('AUTHENTICATION_REQUIRED')) {
        setCanEdit(false);
      }
      showToast(`Không tải được từ điển: ${msg}`, 'warn');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    // Check if user is admin by attempting a dummy PUT (dry-run: we just check
    // the response code on a preflight OPTIONS, not an actual save).
    // Simpler: optimistically allow editing and catch 403 on save.
    setCanEdit(true);
    loadSynonyms();
  }, [loadSynonyms]);

  // ── Mutations (local state only; persisted on Save) ─────────────────────────
  const markDirty = (next: SynonymItem[]) => {
    setSynonyms(next);
    setDirty(true);
  };

  const handleAdd = () => {
    if (!newFrom.trim() || !newTo.trim()) {
      showToast('Vui lòng nhập đầy đủ từ khóa gốc và từ đồng nghĩa', 'warn');
      return;
    }
    const newItem: SynonymItem = {
      id: Date.now().toString(),
      from: newFrom.trim().toLowerCase(),
      to: newTo.trim(),
    };
    markDirty([newItem, ...synonyms]);
    setNewFrom('');
    setNewTo('');
    showToast(`Đã thêm từ đồng nghĩa cho "${newItem.from}" — nhớ bấm Lưu`, 'info');
  };

  const handleDelete = (id: string) => {
    markDirty(synonyms.filter((item) => item.id !== id));
  };

  // ── Save to API ─────────────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true);
    try {
      const saved = await putSynonyms(synonyms);
      setSynonyms(saved);
      setDirty(false);
      showToast('Đã lưu từ điển đồng nghĩa vào Database dùng chung ✓', 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('403') || msg.includes('INSUFFICIENT_ROLE')) {
        setCanEdit(false);
        showToast('Chỉ Admin mới có quyền lưu từ điển đồng nghĩa', 'warn');
      } else {
        showToast(`Lỗi lưu từ điển: ${msg}`, 'warn');
      }
    } finally {
      setSaving(false);
    }
  };

  const filtered = synonyms.filter(
    (s) =>
      s.from.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.to.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="p-5 rounded-2xl border border-border bg-surface shadow-xs space-y-5">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-verity-soft border border-verity-border flex items-center justify-center flex-none mt-0.5">
            <BookOpen className="w-4 h-4 text-verity" />
          </div>
          <div>
            <div className="text-[14px] font-bold text-text-1">Từ điển đồng nghĩa (Synonyms)</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="px-2.5 py-1 rounded-full text-[11.5px] font-mono font-bold bg-surface-2 border border-border text-text-2">
            {synonyms.length} quy tắc
          </div>
          {/* Reload button */}
          <button
            type="button"
            onClick={loadSynonyms}
            disabled={loading}
            className="p-1.5 rounded-lg text-text-3 hover:text-text-1 hover:bg-surface-2 transition-all disabled:opacity-40"
            title="Tải lại từ điển"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* ── Read-only notice ── */}
      {canEdit === false && (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-warn-soft border border-warn-border text-[12.5px] text-warn">
          <Lock className="w-3.5 h-3.5 flex-none" />
          <span>Chỉ Admin mới có quyền chỉnh sửa từ điển đồng nghĩa.</span>
        </div>
      )}

      {/* ── Quick Add Form ── */}
      {canEdit !== false && (
        <div className="p-3.5 rounded-xl border border-border bg-surface-2/40 space-y-3">
          <div className="text-[12px] font-bold text-text-2 uppercase tracking-wide">Thêm quy tắc mới</div>
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-2.5">
            <div className="sm:col-span-2">
              <input
                type="text"
                placeholder="Từ viết tắt / từ lóng (VD: ct, led...)"
                value={newFrom}
                onChange={(e) => setNewFrom(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                className="w-full h-9 px-3 rounded-lg border border-border bg-surface text-[13px] text-text-1 outline-none focus:border-verity-border focus:ring-1 focus:ring-verity/20 transition-all font-mono"
              />
            </div>
            <div className="sm:col-span-2">
              <input
                type="text"
                placeholder="Từ đầy đủ (VD: Công tắc thông minh, Dây LED T1...)"
                value={newTo}
                onChange={(e) => setNewTo(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                className="w-full h-9 px-3 rounded-lg border border-border bg-surface text-[13px] text-text-1 outline-none focus:border-verity-border focus:ring-1 focus:ring-verity/20 transition-all"
              />
            </div>
            <div className="sm:col-span-1">
              <button
                type="button"
                onClick={handleAdd}
                className="w-full h-9 flex items-center justify-center gap-1.5 rounded-lg bg-verity text-white text-[12.5px] font-semibold hover:opacity-90 transition-all shadow-xs"
              >
                <Plus className="w-3.5 h-3.5" />
                Thêm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Search filter ── */}
      <div className="flex items-center gap-2 px-3 h-8.5 rounded-lg border border-border bg-surface text-[12.5px]">
        <Search className="w-3.5 h-3.5 text-text-3 flex-none" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Tìm kiếm trong từ điển..."
          className="flex-1 bg-transparent outline-none placeholder:text-text-disabled"
        />
      </div>

      {/* ── Skeleton loading ── */}
      {loading && (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-10 rounded-lg bg-surface-2 animate-pulse" />
          ))}
        </div>
      )}

      {/* ── Synonyms List ── */}
      {!loading && (
        <div className="rounded-xl border border-border overflow-hidden divide-y divide-border text-[12.5px]">
          {filtered.length === 0 ? (
            <div className="p-6 text-center text-[12.5px] text-text-3">
              Không tìm thấy từ đồng nghĩa phù hợp.
            </div>
          ) : (
            filtered.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between p-3 bg-surface hover:bg-surface-2/40 transition-colors group"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <span className="font-mono font-bold text-verity px-2.5 py-0.5 rounded bg-verity-soft border border-verity-border/50 text-[12px]">
                    {s.from}
                  </span>
                  <span className="text-text-3">→</span>
                  <span className="text-text-1 font-medium truncate">{s.to}</span>
                </div>
                {canEdit !== false && (
                  <button
                    type="button"
                    onClick={() => handleDelete(s.id)}
                    className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md text-text-3 hover:text-bad hover:bg-bad-soft transition-all"
                    title="Xóa quy tắc"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
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
            {saving ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
            {saving ? 'Đang lưu...' : 'Lưu từ điển'}
          </button>
        </div>
      )}
    </div>
  );
}
