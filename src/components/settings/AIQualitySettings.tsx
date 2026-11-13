'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Brain, Eye, Info, RefreshCw, Shield, Sparkles, Tag } from 'lucide-react';
import { useToast } from '@/components/common/Toast';
import { apiRequest, ClientApiError } from '@/lib/client/api';

interface CorrectionEntry {
  id: string;
  media_asset_id: string;
  correction_kind: 'sku' | 'metadata';
  fields: unknown;
  reviewed_by_email: string | null;
  created_at: string;
  asset_title: string | null;
  asset_sku: string | null;
  thumbnail_url: string;
}

interface FewShotEntry {
  id: string;
  source_media_asset_id: string;
  is_active: boolean;
  created_at: string;
  asset_title: string | null;
  asset_sku: string | null;
  thumbnail_url: string;
}

interface AIQualityResponse {
  corrections: { by_kind: Record<string, number>; recent: CorrectionEntry[] };
  few_shot: { total: number; active: number; recent: FewShotEntry[] };
  sku_curation: {
    schema_ready: boolean;
    total: number;
    match_eligible: number;
    not_match_eligible: number;
    active: number;
    frozen_benchmark: number;
    avg_quality_score: number | null;
    by_status: Record<string, number>;
  };
  checked_at: string;
}

function fieldsList(fields: unknown): string {
  if (Array.isArray(fields)) return fields.filter((item) => typeof item === 'string').join(', ');
  if (typeof fields === 'string') {
    try {
      const parsed = JSON.parse(fields);
      if (Array.isArray(parsed)) return parsed.filter((item) => typeof item === 'string').join(', ');
    } catch {}
  }
  return '—';
}

/** Batch 6: read-only observability for the AI correction/learning loop --
 * see api/admin/ai-quality/route.ts for the full data-source rationale.
 * Admin-only, no write path: curation_status/match_eligible mutation would
 * touch the live SKU-matching pipeline and is out of scope for this panel. */
export function AIQualitySettings() {
  const { showToast } = useToast();
  const [data, setData] = useState<AIQualityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const response = await apiRequest<AIQualityResponse>('/api/admin/ai-quality');
      setData(response);
      if (isRefresh) showToast('Đã tải lại số liệu chất lượng AI', 'success');
    } catch (requestError) {
      if (requestError instanceof ClientApiError && requestError.status === 403) {
        setForbidden(true);
      } else {
        setError(requestError instanceof Error ? requestError.message : 'Không thể tải số liệu chất lượng AI.');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load(false);
  }, [load]);

  if (forbidden) {
    return (
      <div className="p-5 rounded-2xl border border-border bg-surface shadow-xs">
        <div className="flex items-start gap-2.5 text-[12.5px] text-text-3">
          <Shield className="w-4 h-4 text-warn flex-none mt-0.5" />
          <span>Bạn cần quyền Admin để xem số liệu chất lượng AI.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-5 rounded-2xl border border-border bg-surface shadow-xs space-y-5">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-ai-soft border border-ai-border flex items-center justify-center flex-none mt-0.5">
            <Brain className="w-4 h-4 text-ai" />
          </div>
          <div>
            <div className="text-[14px] font-bold text-text-1 flex items-center gap-2">
              Học máy & Chất lượng AI
              <span className="flex items-center gap-1 text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-surface-2 border border-border text-text-3">
                <Eye className="w-2.5 h-2.5" /> Chỉ xem
              </span>
            </div>
            <p className="text-[11.5px] text-text-3 mt-0.5">
              Nhật ký sửa lỗi của reviewer, kho ví dụ few-shot cho metadata, và trạng thái curation của ảnh tham chiếu SKU.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void load(true)}
          disabled={refreshing || loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-surface-2 text-[12px] font-semibold text-text-2 hover:text-text-1 hover:bg-hover transition-all disabled:opacity-60"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          <span>Tải lại</span>
        </button>
      </div>

      {loading ? (
        <div className="text-[13px] text-text-3 p-4">Đang tải…</div>
      ) : error ? (
        <div className="p-4 rounded-2xl border border-warn-border bg-warn-soft/70 text-[13px] text-warn space-y-2">
          <p>{error}</p>
          <button type="button" onClick={() => void load(false)} className="px-3 py-1.5 rounded-lg border border-warn-border hover:bg-warn-soft text-[12px] font-semibold transition-all">
            Thử lại
          </button>
        </div>
      ) : data ? (
        <>
          {/* ── Correction log ── */}
          <div className="space-y-2">
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-text-3">Nhật ký sửa lỗi (review_correction_log)</h4>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-xl border border-border bg-surface-2/40">
                <div className="text-[11px] text-text-3">Sửa SKU</div>
                <div className="text-[18px] font-bold text-text-1 font-mono">{data.corrections.by_kind.sku || 0}</div>
              </div>
              <div className="p-3 rounded-xl border border-border bg-surface-2/40">
                <div className="text-[11px] text-text-3">Sửa metadata</div>
                <div className="text-[18px] font-bold text-text-1 font-mono">{data.corrections.by_kind.metadata || 0}</div>
              </div>
            </div>
            {data.corrections.recent.length > 0 && (
              <div className="space-y-1.5">
                {data.corrections.recent.slice(0, 8).map((entry) => (
                  <div key={entry.id} className="flex items-center gap-2.5 p-2 rounded-lg border border-border bg-surface-2/30 text-[11.5px]">
                    {entry.thumbnail_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={entry.thumbnail_url} alt="" className="w-8 h-8 rounded object-cover flex-none border border-border" />
                    ) : (
                      <div className="w-8 h-8 rounded flex-none bg-surface-2 border border-border" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[9.5px] px-1.5 py-0.5 rounded-full font-semibold border ${entry.correction_kind === 'sku' ? 'bg-ai-soft text-ai border-ai-border' : 'bg-verity-soft text-verity border-verity-border'}`}>
                          {entry.correction_kind === 'sku' ? 'SKU' : 'Metadata'}
                        </span>
                        <span className="font-semibold text-text-1 truncate">{entry.asset_title || entry.asset_sku || entry.media_asset_id}</span>
                      </div>
                      <div className="text-text-3 truncate mt-0.5">Trường: {fieldsList(entry.fields)} · {entry.reviewed_by_email || 'không rõ'}</div>
                    </div>
                    <span className="text-[10px] text-text-3 font-mono flex-none">{new Date(entry.created_at).toLocaleDateString('vi-VN')}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Few-shot pool ── */}
          <div className="space-y-2">
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-text-3 flex items-center gap-1.5">
              <Sparkles className="w-3 h-3" /> Kho ví dụ few-shot (metadata_few_shot_examples)
            </h4>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-xl border border-border bg-surface-2/40">
                <div className="text-[11px] text-text-3">Tổng số ví dụ</div>
                <div className="text-[18px] font-bold text-text-1 font-mono">{data.few_shot.total}</div>
              </div>
              <div className="p-3 rounded-xl border border-border bg-surface-2/40">
                <div className="text-[11px] text-text-3">Đang hoạt động (is_active)</div>
                <div className="text-[18px] font-bold text-ok font-mono">{data.few_shot.active}</div>
              </div>
            </div>
            {data.few_shot.total === 0 && (
              <p className="text-[11px] text-text-3 italic">Chưa có ví dụ few-shot nào -- sẽ được tạo tự động khi reviewer duyệt một sửa đổi metadata.</p>
            )}
          </div>

          {/* ── SKU reference curation ── */}
          <div className="space-y-2">
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-text-3 flex items-center gap-1.5">
              <Tag className="w-3 h-3" /> Curation ảnh tham chiếu SKU (sku_references)
            </h4>
            {!data.sku_curation.schema_ready ? (
              <div className="flex items-start gap-2.5 p-4 rounded-xl border border-border bg-surface-2/60 text-[12.5px] text-text-3">
                <Info className="w-4 h-4 text-text-3 flex-none mt-0.5" />
                <span>Bảng sku_references (di trú SigLIP2) chưa được migrate trên môi trường này. Đây không phải lỗi.</span>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="p-3 rounded-xl border border-border bg-surface-2/40">
                    <div className="text-[11px] text-text-3">Tổng số</div>
                    <div className="text-[16px] font-bold text-text-1 font-mono">{data.sku_curation.total}</div>
                  </div>
                  <div className="p-3 rounded-xl border border-border bg-surface-2/40">
                    <div className="text-[11px] text-text-3">Đủ điều kiện khớp</div>
                    <div className="text-[16px] font-bold text-ok font-mono">{data.sku_curation.match_eligible}</div>
                  </div>
                  <div className="p-3 rounded-xl border border-border bg-surface-2/40">
                    <div className="text-[11px] text-text-3">Bị loại (not eligible)</div>
                    <div className="text-[16px] font-bold text-warn font-mono">{data.sku_curation.not_match_eligible}</div>
                  </div>
                  <div className="p-3 rounded-xl border border-border bg-surface-2/40">
                    <div className="text-[11px] text-text-3">Frozen benchmark</div>
                    <div className="text-[16px] font-bold text-text-1 font-mono">{data.sku_curation.frozen_benchmark}</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 text-[10.5px] font-mono">
                  {Object.entries(data.sku_curation.by_status).map(([status, count]) => (
                    <span key={status} className="px-2 py-1 rounded-lg bg-surface-2 border border-border text-text-2">
                      {status}: {count}
                    </span>
                  ))}
                  {data.sku_curation.avg_quality_score !== null && (
                    <span className="px-2 py-1 rounded-lg bg-surface-2 border border-border text-text-2">
                      quality_score TB: {data.sku_curation.avg_quality_score}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>

          <p className="text-[10.5px] text-text-disabled font-mono">Cập nhật lúc {new Date(data.checked_at).toLocaleString('vi-VN')}</p>
        </>
      ) : null}
    </div>
  );
}
