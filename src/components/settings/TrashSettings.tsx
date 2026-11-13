'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Info, RotateCcw, Trash2 } from 'lucide-react';

import { useToast } from '@/components/common/Toast';
import { apiRequest, ClientApiError } from '@/lib/client/api';

interface TrashItem {
  id: string;
  title: string;
  sku: string;
  brand: string;
  category: string;
  thumbnail_url: string;
  deleted_at: string;
  deleted_by_email: string | null;
}

export function TrashSettings() {
  const { showToast } = useToast();
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<TrashItem | null>(null);
  const [purgeConfirmText, setPurgeConfirmText] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiRequest<{ data: TrashItem[] }>('/api/admin/trash');
      setItems(response.data || []);
    } catch (requestError) {
      if (requestError instanceof ClientApiError && requestError.status === 403) {
        setForbidden(true);
      } else {
        setError(requestError instanceof Error ? requestError.message : 'Không thể tải danh sách thùng rác.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRestore = async (item: TrashItem) => {
    if (busyId) return;
    setBusyId(item.id);
    try {
      await apiRequest(`/api/media/${item.id}/restore`, { method: 'POST' });
      setItems((prev) => prev.filter((entry) => entry.id !== item.id));
      showToast(`Đã khôi phục "${item.title || item.sku || 'ảnh'}"`, 'success');
    } catch (requestError) {
      showToast(requestError instanceof Error ? requestError.message : 'Không thể khôi phục ảnh này.', 'warn');
    } finally {
      setBusyId(null);
    }
  };

  const handlePurge = async () => {
    if (!purgeTarget || busyId) return;
    setBusyId(purgeTarget.id);
    try {
      await apiRequest(`/api/media/${purgeTarget.id}/purge`, { method: 'DELETE' });
      setItems((prev) => prev.filter((entry) => entry.id !== purgeTarget.id));
      showToast(`Đã xóa vĩnh viễn "${purgeTarget.title || purgeTarget.sku || 'ảnh'}"`, 'success');
      setPurgeTarget(null);
      setPurgeConfirmText('');
    } catch (requestError) {
      showToast(requestError instanceof Error ? requestError.message : 'Không thể xóa vĩnh viễn ảnh này.', 'warn');
    } finally {
      setBusyId(null);
    }
  };

  const purgeLabel = purgeTarget ? (purgeTarget.title || purgeTarget.sku || 'ảnh') : '';
  const purgeConfirmMatches = purgeTarget ? purgeConfirmText.trim() === purgeLabel : false;

  if (forbidden) {
    return (
      <div className="p-5 rounded-2xl border border-border bg-surface shadow-xs">
        <div className="flex items-start gap-2.5 text-[12.5px] text-text-3">
          <Info className="w-4 h-4 text-warn flex-none mt-0.5" />
          <span>Bạn cần quyền Admin để xem và quản lý Thùng rác.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-surface p-4 sm:p-5 shadow-xs">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-[15px] font-bold text-text-1">Thùng rác</h2>
          {!loading && <span className="text-[11.5px] text-text-3">{items.length} ảnh đã xóa</span>}
        </div>
        <p className="text-[12.5px] text-text-2 leading-relaxed">
          Ảnh ở đây chỉ mới bị ẩn khỏi Thư viện và hàng chờ duyệt (soft-delete) — chưa mất dữ liệu.
          Khôi phục để đưa ảnh trở lại Thư viện, hoặc xóa vĩnh viễn để gỡ hẳn khỏi database và
          Cloudflare R2 (không thể hoàn tác).
        </p>
      </div>

      {loading ? (
        <div className="text-[13px] text-text-3 p-4">Đang tải…</div>
      ) : error ? (
        <div className="p-4 rounded-2xl border border-warn-border bg-warn-soft/70 text-[13px] text-warn space-y-2">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="px-3 py-1.5 rounded-lg border border-warn-border hover:bg-warn-soft text-[12px] font-semibold transition-all"
          >
            Thử lại
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="text-[13px] text-text-3 p-4 rounded-2xl border border-dashed border-border">Thùng rác đang trống.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {items.map((item) => (
            <div key={item.id} className="rounded-xl border border-border bg-surface overflow-hidden shadow-xs flex flex-col">
              <div className="h-[110px] bg-surface-2 flex-none">
                {item.thumbnail_url && (
                  <img src={item.thumbnail_url} alt={item.title || item.sku} className="w-full h-full object-cover" />
                )}
              </div>
              <div className="p-3 space-y-1.5 flex-1 flex flex-col">
                <p className="text-[12.5px] font-bold text-text-1 truncate">{item.title || item.sku || 'Chưa đặt tên'}</p>
                <p className="text-[11px] text-text-3 truncate">
                  Xóa lúc {new Date(item.deleted_at).toLocaleString('vi-VN')}
                  {item.deleted_by_email ? ` · bởi ${item.deleted_by_email}` : ''}
                </p>
                <div className="flex-1" />
                <div className="flex items-center gap-1.5 pt-1">
                  <button
                    type="button"
                    onClick={() => void handleRestore(item)}
                    disabled={busyId === item.id}
                    className="flex-1 h-[30px] rounded-lg bg-verity hover:bg-verity-hover disabled:opacity-60 text-white text-[11.5px] font-bold flex items-center justify-center gap-1 transition-all"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Khôi phục</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setPurgeTarget(item); setPurgeConfirmText(''); }}
                    disabled={busyId === item.id}
                    className="h-[30px] px-2.5 rounded-lg border border-bad-border text-bad hover:bg-bad-soft disabled:opacity-60 text-[11.5px] font-semibold flex items-center justify-center gap-1 transition-all"
                    title="Xóa vĩnh viễn"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {purgeTarget && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setPurgeTarget(null)}>
          <div
            className="w-full max-w-[420px] rounded-2xl border border-border bg-surface p-5 shadow-lg space-y-3"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-2 text-bad">
              <AlertTriangle className="w-5 h-5" />
              <h3 className="text-[14.5px] font-bold">Xóa vĩnh viễn?</h3>
            </div>
            <p className="text-[12.5px] text-text-2 leading-relaxed">
              Hành động này gỡ hẳn <strong>{purgeLabel}</strong> khỏi database và object trên Cloudflare R2.
              Không thể hoàn tác.
            </p>
            <p className="text-[12px] text-text-3">
              Gõ lại tên <strong>{purgeLabel}</strong> để xác nhận:
            </p>
            <input
              type="text"
              value={purgeConfirmText}
              onChange={(event) => setPurgeConfirmText(event.target.value)}
              className="w-full h-[38px] px-3 rounded-lg border border-border bg-surface-inset text-[13px] outline-none focus:border-bad"
              placeholder={purgeLabel}
            />
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setPurgeTarget(null)}
                className="h-[36px] px-3.5 rounded-lg border border-border text-text-2 hover:bg-hover text-[12.5px] font-semibold transition-all"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={() => void handlePurge()}
                disabled={!purgeConfirmMatches || busyId === purgeTarget.id}
                className="h-[36px] px-3.5 rounded-lg bg-bad hover:bg-bad/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-[12.5px] font-bold transition-all"
              >
                Xóa vĩnh viễn
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
