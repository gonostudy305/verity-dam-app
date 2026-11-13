'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Eye, Info, Layers, RefreshCw, Shield } from 'lucide-react';
import { useToast } from '@/components/common/Toast';
import { apiRequest, ClientApiError } from '@/lib/client/api';

interface SpaceCalibration {
  sku_high: number;
  sku_low: number;
  ambiguity_margin: number;
  consistency_primary_min: number;
  consistency_spread_max: number;
  scene_duplicate_threshold: number;
}

interface EmbeddingSpace {
  space_id: string;
  model_family: string;
  model_name: string;
  model_revision: string | null;
  dimension: number;
  distance_metric: string;
  provider: string;
  runtime: string;
  status: 'CANDIDATE' | 'SHADOW' | 'ACTIVE' | 'DEPRECATED' | 'RETIRED';
  created_at: string;
  activated_at: string | null;
  calibration: SpaceCalibration | null;
  asset_embedding_count: number;
  coverage_pct: number;
}

interface EmbeddingSpacesResponse {
  schema_ready: boolean;
  spaces: EmbeddingSpace[];
  runtime_state: { active_space_id: string; nl_search_space_id: string | null; updated_at: string } | null;
  total_assets: number;
  checked_at: string;
}

const STATUS_STYLE: Record<EmbeddingSpace['status'], string> = {
  ACTIVE: 'bg-ok-soft text-ok border-ok-border',
  SHADOW: 'bg-amber-500/10 text-amber-600 border-amber-500/25',
  CANDIDATE: 'bg-sky-500/10 text-sky-600 border-sky-500/25',
  DEPRECATED: 'bg-surface-2 text-text-3 border-border',
  RETIRED: 'bg-rose-500/10 text-rose-600 border-rose-500/25',
};

/** Batch 5: read-only observability for the staged SigLIP2 versioned-space
 * migration (see api/admin/embedding-spaces/route.ts for the full context).
 * This panel is deliberately view-only and DISTINCT from the "AI Embedding"
 * Settings tab (EmbeddingSettings.tsx) above it, which configures the
 * *existing* embedding call's provider/API key -- that page is untouched by
 * this batch and this panel must never grow a "switch active space" action.
 * Real cutover is an operator-only, DB-side procedure outside this app. */
export function EmbeddingRuntimeSettings() {
  const { showToast } = useToast();
  const [data, setData] = useState<EmbeddingSpacesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const response = await apiRequest<EmbeddingSpacesResponse>('/api/admin/embedding-spaces');
      setData(response);
      if (isRefresh) showToast('Đã tải lại trạng thái embedding space', 'success');
    } catch (requestError) {
      if (requestError instanceof ClientApiError && requestError.status === 403) {
        setForbidden(true);
      } else {
        setError(requestError instanceof Error ? requestError.message : 'Không thể tải trạng thái embedding space.');
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
          <span>Bạn cần quyền Admin để xem trạng thái embedding space.</span>
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
            <Layers className="w-4 h-4 text-ai" />
          </div>
          <div>
            <div className="text-[14px] font-bold text-text-1 flex items-center gap-2">
              Không gian Embedding (Runtime)
              <span className="flex items-center gap-1 text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-surface-2 border border-border text-text-3">
                <Eye className="w-2.5 h-2.5" /> Chỉ xem
              </span>
            </div>
            <p className="text-[11.5px] text-text-3 mt-0.5">
              Theo dõi kế hoạch di trú versioned-space (SigLIP2). Không có nút chuyển đổi ở đây --
              cutover chỉ thực hiện qua quy trình vận hành riêng ngoài web app.
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
      ) : data && !data.schema_ready ? (
        <div className="flex items-start gap-2.5 p-4 rounded-xl border border-border bg-surface-2/60 text-[12.5px] text-text-3">
          <Info className="w-4 h-4 text-text-3 flex-none mt-0.5" />
          <span>
            Schema versioned-space (embedding_spaces / embedding_runtime_state) chưa được migrate trên môi trường này --
            kế hoạch di trú SigLIP2 chưa qua GO Phase 0. Đây không phải lỗi, chỉ là chưa triển khai.
          </span>
        </div>
      ) : data ? (
        <>
          {/* ── Runtime pointer ── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-3 rounded-xl border border-border bg-surface-2/40">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-text-3">active_space_id (nhận diện SKU)</div>
              <div className="mt-1 text-[12.5px] font-mono text-text-1 break-all">{data.runtime_state?.active_space_id || '—'}</div>
            </div>
            <div className="p-3 rounded-xl border border-border bg-surface-2/40">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-text-3">nl_search_space_id (tìm kiếm semantic)</div>
              <div className="mt-1 text-[12.5px] font-mono text-text-1 break-all">
                {data.runtime_state?.nl_search_space_id || 'Đã tắt (null) -- semantic search không hoạt động'}
              </div>
            </div>
          </div>

          {/* ── Space registry ── */}
          <div className="space-y-2">
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-text-3">
              Đăng ký không gian ({data.spaces.length}) -- {data.total_assets} ảnh đang hoạt động
            </h4>
            <div className="space-y-2">
              {data.spaces.map((space) => (
                <div key={space.space_id} className="p-3 rounded-xl border border-border bg-surface-2/40 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-mono text-[12.5px] font-bold text-text-1 truncate">{space.space_id}</div>
                      <div className="text-[11px] text-text-3 mt-0.5">
                        {space.model_family} · {space.model_name}{space.model_revision ? ` @ ${space.model_revision.slice(0, 12)}` : ''} · {space.dimension} chiều · {space.distance_metric}
                      </div>
                    </div>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border flex-none ${STATUS_STYLE[space.status]}`}>
                      {space.status}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 rounded-full bg-surface overflow-hidden">
                      <div className="h-full bg-verity" style={{ width: `${Math.min(100, space.coverage_pct)}%` }} />
                    </div>
                    <span className="text-[10.5px] font-mono text-text-3 flex-none">
                      {space.asset_embedding_count}/{data.total_assets} ảnh ({space.coverage_pct}%)
                    </span>
                  </div>

                  {space.calibration ? (
                    <div className="flex flex-wrap gap-1.5 text-[10px] font-mono text-text-3">
                      <span className="px-1.5 py-0.5 rounded bg-surface border border-border">sku_high {space.calibration.sku_high}</span>
                      <span className="px-1.5 py-0.5 rounded bg-surface border border-border">sku_low {space.calibration.sku_low}</span>
                      <span className="px-1.5 py-0.5 rounded bg-surface border border-border">ambiguity {space.calibration.ambiguity_margin}</span>
                      <span className="px-1.5 py-0.5 rounded bg-surface border border-border">consistency_min {space.calibration.consistency_primary_min}</span>
                      <span className="px-1.5 py-0.5 rounded bg-surface border border-border">spread_max {space.calibration.consistency_spread_max}</span>
                      <span className="px-1.5 py-0.5 rounded bg-surface border border-border">dup_threshold {space.calibration.scene_duplicate_threshold}</span>
                    </div>
                  ) : (
                    <p className="text-[10.5px] text-text-3 italic">Chưa có ngưỡng hiệu chỉnh (calibration) cho không gian này.</p>
                  )}
                </div>
              ))}
            </div>
          </div>

          <p className="text-[10.5px] text-text-disabled font-mono">Cập nhật lúc {new Date(data.checked_at).toLocaleString('vi-VN')}</p>
        </>
      ) : null}
    </div>
  );
}
