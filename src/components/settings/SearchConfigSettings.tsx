'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { SlidersHorizontal, Save, RotateCcw, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useToast } from '@/components/common/Toast';

interface SearchConfigState {
  rrf_k: number;
  semantic_weight: number;
  lexical_weight: number;
  mmr_lambda: number;
  mmr_pool_size: number;
  mmr_output_size: number;
  rerank_lexical: number;
  rerank_fuzzy: number;
  rerank_rrf: number;
  rerank_entity: number;
  semantic_enabled: boolean;
}

const DEFAULTS: SearchConfigState = {
  rrf_k: 60,
  semantic_weight: 1.0,
  lexical_weight: 1.0,
  mmr_lambda: 0.7,
  mmr_pool_size: 40,
  mmr_output_size: 20,
  rerank_lexical: 1.0,
  rerank_fuzzy: 0.5,
  rerank_rrf: 10.0,
  rerank_entity: 1.0,
  semantic_enabled: true,
};

export function SearchConfigSettings() {
  const { showToast } = useToast();
  const [config, setConfig] = useState<SearchConfigState>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/settings/search');
      if (res.ok) {
        const json = await res.json();
        if (json.data) {
          setConfig(json.data);
        }
      }
    } catch {
      showToast('Không thể tải cấu hình tìm kiếm, sử dụng mặc định.', 'warn');
    } finally {
      setLoading(false);
      setDirty(false);
    }
  }, [showToast]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings/search', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || `HTTP ${res.status}`);
      }
      const json = await res.json();
      if (json.data) {
        setConfig(json.data);
      }
      setDirty(false);
      showToast('Đã lưu cấu hình xếp hạng tìm kiếm thành công!', 'success');
    } catch (err: any) {
      showToast(`Lỗi khi lưu cấu hình: ${err?.message || err}`, 'warn');
    } finally {
      setSaving(false);
    }
  };

  const handleResetDefaults = () => {
    setConfig(DEFAULTS);
    setDirty(true);
    showToast('Đã tải lại giá trị mặc định (nhấn Lưu để áp dụng).', 'info');
  };

  const updateField = <K extends keyof SearchConfigState>(key: K, value: SearchConfigState[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  if (loading) {
    return (
      <div className="p-8 text-center text-text-3">
        Đang tải cấu hình tìm kiếm...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header card */}
      <div className="bg-surface border border-border rounded-xl p-5 shadow-xs">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-sky-50 dark:bg-sky-950/40 text-sky-600 border border-sky-200/50">
              <SlidersHorizontal className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-text-1">Cấu hình thuật toán xếp hạng (RRF & MMR)</h2>
              <p className="text-xs text-text-3 mt-0.5">
                Điều chỉnh trọng số Reciprocal Rank Fusion, khử trùng lặp trực quan MMR và reranker đa tầng.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleResetDefaults}
              className="px-3 py-1.5 text-xs font-medium text-text-2 bg-surface hover:bg-surface-2 border border-border rounded-lg transition-colors flex items-center gap-1.5"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Mặc định
            </button>
            <button
              onClick={handleSave}
              disabled={!dirty || saving}
              className={`px-4 py-1.5 text-xs font-medium text-white rounded-lg transition-colors flex items-center gap-1.5 ${
                dirty && !saving ? 'bg-primary hover:bg-primary-hover shadow-xs' : 'bg-primary/40 cursor-not-allowed'
              }`}
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? 'Đang lưu...' : 'Lưu thay đổi'}
            </button>
          </div>
        </div>
      </div>

      {/* Semantic Search Activation Toggle */}
      <div className="bg-surface border border-border rounded-xl p-5 shadow-xs flex items-center justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-text-1">Tìm kiếm AI Ngữ nghĩa (Semantic Vector Search)</h3>
            <span className={`text-[11px] font-mono font-bold px-2 py-0.5 rounded ${config.semantic_enabled ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-surface-2 text-text-3'}`}>
              {config.semantic_enabled ? 'ĐANG BẬT' : 'ĐANG TẮT'}
            </span>
          </div>
          <p className="text-xs text-text-3 max-w-2xl">
            Tự động định tuyến câu văn tự nhiên, cảnh quan và tâm trạng qua microservice SigLIP2.
            Khi tắt, hệ thống chỉ dùng tìm kiếm cơ bản (lexical + từ đồng nghĩa), tiết kiệm 100% tài nguyên CPU/RAM inference trên VPS.
          </p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer ml-4 flex-none">
          <input
            type="checkbox"
            checked={config.semantic_enabled}
            onChange={(e) => updateField('semantic_enabled', e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-surface-3 peer-focus:outline-hidden rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-border after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
        </label>
      </div>

      {/* Grid of parameters */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* RRF Group */}
        <div className="bg-surface border border-border rounded-xl p-5 shadow-xs space-y-4">
          <div className="border-b border-border pb-3">
            <h3 className="text-sm font-semibold text-text-1">Reciprocal Rank Fusion (RRF)</h3>
            <p className="text-xs text-text-3 mt-0.5">Kết hợp thứ hạng giữa từ khóa (lexical) và vector ngữ nghĩa (SigLIP2).</p>
          </div>

          <div className="space-y-3.5">
            <div>
              <label className="text-xs font-medium text-text-2 flex justify-between">
                <span>Hằng số làm mượt RRF (k)</span>
                <span className="font-mono text-primary font-semibold">{config.rrf_k}</span>
              </label>
              <input
                type="number"
                min={1}
                max={200}
                value={config.rrf_k}
                onChange={(e) => updateField('rrf_k', parseInt(e.target.value, 10) || 60)}
                className="mt-1.5 w-full px-3 py-1.5 text-xs bg-surface-2 border border-border rounded-lg text-text-1 focus:outline-hidden focus:border-primary"
              />
              <span className="text-[11px] text-text-3">Giá trị chuẩn là 60. Giá trị cao hơn làm giảm ảnh hưởng của vị trí đầu.</span>
            </div>

            <div>
              <label className="text-xs font-medium text-text-2 flex justify-between">
                <span>Trọng số ngữ nghĩa (Semantic Weight)</span>
                <span className="font-mono text-primary font-semibold">{config.semantic_weight}</span>
              </label>
              <input
                type="number"
                step="0.1"
                min={0}
                max={10}
                value={config.semantic_weight}
                onChange={(e) => updateField('semantic_weight', parseFloat(e.target.value) || 0)}
                className="mt-1.5 w-full px-3 py-1.5 text-xs bg-surface-2 border border-border rounded-lg text-text-1 focus:outline-hidden focus:border-primary"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-text-2 flex justify-between">
                <span>Trọng số từ khóa (Lexical Weight)</span>
                <span className="font-mono text-primary font-semibold">{config.lexical_weight}</span>
              </label>
              <input
                type="number"
                step="0.1"
                min={0}
                max={10}
                value={config.lexical_weight}
                onChange={(e) => updateField('lexical_weight', parseFloat(e.target.value) || 0)}
                className="mt-1.5 w-full px-3 py-1.5 text-xs bg-surface-2 border border-border rounded-lg text-text-1 focus:outline-hidden focus:border-primary"
              />
            </div>
          </div>
        </div>

        {/* MMR Group */}
        <div className="bg-surface border border-border rounded-xl p-5 shadow-xs space-y-4">
          <div className="border-b border-border pb-3">
            <h3 className="text-sm font-semibold text-text-1">Maximal Marginal Relevance (MMR)</h3>
            <p className="text-xs text-text-3 mt-0.5">Khử trùng lặp ảnh cùng góc chụp bằng khoảng cách cosine vector 768-d.</p>
          </div>

          <div className="space-y-3.5">
            <div>
              <label className="text-xs font-medium text-text-2 flex justify-between">
                <span>MMR Lambda (Độ tương quan vs Đa dạng)</span>
                <span className="font-mono text-primary font-semibold">{config.mmr_lambda}</span>
              </label>
              <div className="flex items-center gap-3 mt-1.5">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={config.mmr_lambda}
                  onChange={(e) => updateField('mmr_lambda', parseFloat(e.target.value))}
                  className="w-full accent-primary"
                />
                <span className="text-xs font-mono w-10 text-right">{config.mmr_lambda}</span>
              </div>
              <span className="text-[11px] text-text-3">1.0: thuần tương quan (không đa dạng hóa); 0.5: cân bằng; 0.0: tối đa đa dạng.</span>
            </div>

            <div>
              <label className="text-xs font-medium text-text-2 flex justify-between">
                <span>Kích thước tập ứng viên MMR (Pool Size)</span>
                <span className="font-mono text-primary font-semibold">{config.mmr_pool_size}</span>
              </label>
              <input
                type="number"
                min={5}
                max={100}
                value={config.mmr_pool_size}
                onChange={(e) => updateField('mmr_pool_size', parseInt(e.target.value, 10) || 40)}
                className="mt-1.5 w-full px-3 py-1.5 text-xs bg-surface-2 border border-border rounded-lg text-text-1 focus:outline-hidden focus:border-primary"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-text-2 flex justify-between">
                <span>Số lượng đầu ra đa dạng hóa (Output Size)</span>
                <span className="font-mono text-primary font-semibold">{config.mmr_output_size}</span>
              </label>
              <input
                type="number"
                min={5}
                max={100}
                value={config.mmr_output_size}
                onChange={(e) => updateField('mmr_output_size', parseInt(e.target.value, 10) || 20)}
                className="mt-1.5 w-full px-3 py-1.5 text-xs bg-surface-2 border border-border rounded-lg text-text-1 focus:outline-hidden focus:border-primary"
              />
            </div>
          </div>
        </div>

        {/* Deterministic Reranker Weights */}
        <div className="bg-surface border border-border rounded-xl p-5 shadow-xs space-y-4 md:col-span-2">
          <div className="border-b border-border pb-3">
            <h3 className="text-sm font-semibold text-text-1">Trọng số Reranker trong cùng RankTier</h3>
            <p className="text-xs text-text-3 mt-0.5">
              Áp dụng kết hợp tuyến tính các tín hiệu phụ trong cùng tầng ưu tiên (Tier 0: SKU chính xác, Tier 1: Brand/Model, Tier 2: Ngữ nghĩa).
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <label className="text-xs font-medium text-text-2">Rerank RRF</label>
              <input
                type="number"
                step="0.5"
                min={0}
                max={50}
                value={config.rerank_rrf}
                onChange={(e) => updateField('rerank_rrf', parseFloat(e.target.value) || 0)}
                className="mt-1.5 w-full px-3 py-1.5 text-xs bg-surface-2 border border-border rounded-lg text-text-1 focus:outline-hidden focus:border-primary"
              />
              <span className="text-[11px] text-text-3">Mặc định: 10.0</span>
            </div>

            <div>
              <label className="text-xs font-medium text-text-2">Rerank Lexical</label>
              <input
                type="number"
                step="0.1"
                min={0}
                max={10}
                value={config.rerank_lexical}
                onChange={(e) => updateField('rerank_lexical', parseFloat(e.target.value) || 0)}
                className="mt-1.5 w-full px-3 py-1.5 text-xs bg-surface-2 border border-border rounded-lg text-text-1 focus:outline-hidden focus:border-primary"
              />
              <span className="text-[11px] text-text-3">Mặc định: 1.0</span>
            </div>

            <div>
              <label className="text-xs font-medium text-text-2">Rerank Fuzzy</label>
              <input
                type="number"
                step="0.1"
                min={0}
                max={10}
                value={config.rerank_fuzzy}
                onChange={(e) => updateField('rerank_fuzzy', parseFloat(e.target.value) || 0)}
                className="mt-1.5 w-full px-3 py-1.5 text-xs bg-surface-2 border border-border rounded-lg text-text-1 focus:outline-hidden focus:border-primary"
              />
              <span className="text-[11px] text-text-3">Mặc định: 0.5</span>
            </div>

            <div>
              <label className="text-xs font-medium text-text-2">Rerank Entity Overlap</label>
              <input
                type="number"
                step="0.1"
                min={0}
                max={10}
                value={config.rerank_entity}
                onChange={(e) => updateField('rerank_entity', parseFloat(e.target.value) || 0)}
                className="mt-1.5 w-full px-3 py-1.5 text-xs bg-surface-2 border border-border rounded-lg text-text-1 focus:outline-hidden focus:border-primary"
              />
              <span className="text-[11px] text-text-3">Mặc định: 1.0</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
