'use client';

import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Info,
  KeyRound,
  Loader2,
  Save,
  ToggleLeft,
  ToggleRight,
  Zap,
  AlertCircle,
} from 'lucide-react';

import { useToast } from '@/components/common/Toast';
import { apiRequest } from '@/lib/client/api';
import { cn } from '@/lib/utils';

type EmbeddingProvider = '9router' | 'gemini';

type SharedEmbeddingConfig = {
  provider: EmbeddingProvider;
  baseUrl: string;
  model: string;
  embeddingVersion: string;
  embeddingDimension: number;
  configured: boolean;
  updatedAt: string | null;
  fallback: {
    enabled: boolean;
    provider: EmbeddingProvider | null;
    baseUrl: string | null;
    model: string | null;
    configured: boolean;
  };
};

const PROVIDER_LABELS: Record<EmbeddingProvider, { name: string; desc: string; badge: string }> = {
  '9router': {
    name: '9Router (jina-clip-v2)',
    desc: 'Multimodal CLIP — 512 chiều, hỗ trợ cả text + image',
    badge: 'Mặc định',
  },
  gemini: {
    name: 'Google Gemini Embedding',
    desc: 'text-embedding-004 — 768 chiều, tối ưu text semantic search',
    badge: 'Gemini',
  },
};

const PROVIDER_DEFAULTS: Record<EmbeddingProvider, { baseUrl: string; model: string; dim: number }> = {
  '9router': { baseUrl: 'https://api.example.com/v1', model: 'jina-ai/jina-clip-v2', dim: 512 },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'text-embedding-004', dim: 768 },
};

function ProviderSelect({
  value,
  onChange,
  disabled,
  exclude,
}: {
  value: EmbeddingProvider;
  onChange: (v: EmbeddingProvider) => void;
  disabled?: boolean;
  exclude?: EmbeddingProvider;
}) {
  const options = (['9router', 'gemini'] as EmbeddingProvider[]).filter((p) => p !== exclude);
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as EmbeddingProvider)}
        disabled={disabled}
        className="w-full h-10 pl-3 pr-8 rounded-lg border border-border bg-surface text-[13px] text-text-1 outline-none focus:border-verity focus:ring-2 focus:ring-verity/15 appearance-none disabled:opacity-60 cursor-pointer"
      >
        {options.map((p) => (
          <option key={p} value={p}>
            {PROVIDER_LABELS[p].name}
          </option>
        ))}
      </select>
      <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-3 pointer-events-none" />
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3 rounded-xl border border-border bg-surface-2/40">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-text-3">{label}</div>
      <div className="mt-1 text-[12.5px] font-mono text-text-1 break-all">{value}</div>
    </div>
  );
}

export function EmbeddingSettings() {
  const { showToast } = useToast();
  const [config, setConfig] = useState<SharedEmbeddingConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Primary provider form
  const [primaryProvider, setPrimaryProvider] = useState<EmbeddingProvider>('9router');
  const [primaryBaseUrl, setPrimaryBaseUrl] = useState(PROVIDER_DEFAULTS['9router'].baseUrl);
  const [primaryModel, setPrimaryModel] = useState(PROVIDER_DEFAULTS['9router'].model);
  const [primaryApiKey, setPrimaryApiKey] = useState('');
  const [primaryProbedModels, setPrimaryProbedModels] = useState<string[]>([]);
  const [primaryProbing, setPrimaryProbing] = useState(false);
  const [primaryProbeError, setPrimaryProbeError] = useState('');

  // Fallback form
  const [fallbackEnabled, setFallbackEnabled] = useState(false);
  const [fallbackProvider, setFallbackProvider] = useState<EmbeddingProvider>('gemini');
  const [fallbackBaseUrl, setFallbackBaseUrl] = useState(PROVIDER_DEFAULTS['gemini'].baseUrl);
  const [fallbackModel, setFallbackModel] = useState(PROVIDER_DEFAULTS['gemini'].model);
  const [fallbackApiKey, setFallbackApiKey] = useState('');
  const [fallbackProbedModels, setFallbackProbedModels] = useState<string[]>([]);
  const [fallbackProbing, setFallbackProbing] = useState(false);
  const [fallbackProbeError, setFallbackProbeError] = useState('');

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ data: SharedEmbeddingConfig }>('/api/settings/embedding')
      .then(({ data }) => {
        if (!cancelled) {
          setConfig(data);
          const provider = data.provider ?? '9router';
          setPrimaryProvider(provider);
          setPrimaryBaseUrl(data.baseUrl || PROVIDER_DEFAULTS[provider].baseUrl);
          setPrimaryModel(data.model || PROVIDER_DEFAULTS[provider].model);
          setFallbackEnabled(data.fallback?.enabled ?? false);
          if (data.fallback?.provider) {
            setFallbackProvider(data.fallback.provider);
            setFallbackBaseUrl(data.fallback.baseUrl || PROVIDER_DEFAULTS[data.fallback.provider].baseUrl);
            setFallbackModel(data.fallback.model || PROVIDER_DEFAULTS[data.fallback.provider].model);
          }
        }
      })
      .catch((error) => {
        if (!cancelled) showToast(error instanceof Error ? error.message : 'Không tải được cấu hình Embedding', 'warn');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [showToast]);

  // When provider changes, reset baseUrl/model to defaults
  const handlePrimaryProviderChange = (p: EmbeddingProvider) => {
    setPrimaryProvider(p);
    setPrimaryBaseUrl(PROVIDER_DEFAULTS[p].baseUrl);
    setPrimaryModel(PROVIDER_DEFAULTS[p].model);
    setPrimaryProbedModels([]);
    setPrimaryProbeError('');
  };
  const handleFallbackProviderChange = (p: EmbeddingProvider) => {
    setFallbackProvider(p);
    setFallbackBaseUrl(PROVIDER_DEFAULTS[p].baseUrl);
    setFallbackModel(PROVIDER_DEFAULTS[p].model);
    setFallbackProbedModels([]);
    setFallbackProbeError('');
  };

  // Probe models from endpoint
  const probeModels = async (
    baseUrl: string,
    apiKey: string,
    setModels: (m: string[]) => void,
    setProbing: (v: boolean) => void,
    setError: (e: string) => void
  ) => {
    if (!baseUrl.trim() || !apiKey.trim()) {
      setError('Nhập Base URL và API Key trước khi lấy models.');
      return;
    }
    setProbing(true);
    setError('');
    setModels([]);
    try {
      const res = await apiRequest<{ models: string[] }>('/api/settings/probe-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey }),
      });
      setModels(res.models);
      if (res.models.length === 0) setError('Endpoint không trả về model nào.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể lấy danh sách models.');
    } finally {
      setProbing(false);
    }
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!primaryApiKey.trim()) {
      showToast('Nhập API key của provider chính trước khi lưu.', 'warn');
      return;
    }
    if (fallbackEnabled && !fallbackApiKey.trim() && !config?.fallback?.configured) {
      showToast('Nhập API key của fallback provider hoặc tắt fallback.', 'warn');
      return;
    }
    setSaving(true);
    try {
      const response = await apiRequest<{ data: SharedEmbeddingConfig }>('/api/settings/embedding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: primaryApiKey,
          provider: primaryProvider,
          baseUrl: primaryBaseUrl,
          model: primaryModel,
          ...(fallbackEnabled
            ? {
                fallbackProvider,
                fallbackApiKey,
                fallbackBaseUrl,
                fallbackModel,
              }
            : {}),
        }),
      });
      setConfig(response.data);
      setPrimaryApiKey('');
      setFallbackApiKey('');
      showToast('Đã lưu cấu hình Embedding API dùng chung trên PostgreSQL.', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không lưu được cấu hình Embedding', 'warn');
    } finally {
      setSaving(false);
    }
  };


  return (
    <form onSubmit={handleSave} className="p-5 rounded-2xl border border-border bg-surface shadow-xs space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-ai-soft border border-ai-border flex items-center justify-center flex-none mt-0.5">
            <Zap className="w-4 h-4 text-ai" />
          </div>
          <div>
            <div className="text-[14px] font-bold text-text-1">Kết nối AI Embedding</div>
          </div>
        </div>
        {config?.configured ? (
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-ok-soft text-ok border border-ok-border flex-none">
            <CheckCircle2 className="w-3.5 h-3.5" /> Đã cấu hình
          </span>
        ) : (
          <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-warn-soft text-warn border border-warn-border flex-none">
            Chưa cấu hình
          </span>
        )}
      </div>

      {/* ── Primary Provider ── */}
      <div className="space-y-3">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-text-3">Provider chính</h3>

        {/* Provider selector */}
        <div>
          <label className="text-[12px] font-semibold text-text-2 uppercase tracking-wide block mb-1.5">
            Embedding Provider
          </label>
          <ProviderSelect
            value={primaryProvider}
            onChange={handlePrimaryProviderChange}
            disabled={loading || saving}
          />
          <p className="mt-1.5 text-[11.5px] text-text-3">{PROVIDER_LABELS[primaryProvider].desc}</p>
        </div>

        {/* Base URL — editable */}
        <div>
          <label className="text-[12px] font-semibold text-text-2 uppercase tracking-wide block mb-1.5">
            Base URL
          </label>
          <input
            type="text"
            value={primaryBaseUrl}
            onChange={(e) => setPrimaryBaseUrl(e.target.value)}
            disabled={loading || saving}
            placeholder="https://api.example.com/v1"
            className="w-full h-10 px-3 rounded-lg border border-border bg-surface text-[13px] text-text-1 font-mono outline-none focus:border-verity focus:ring-2 focus:ring-verity/15 disabled:opacity-60"
          />
        </div>

        {/* API Key */}
        <div>
          <label htmlFor="embedding-primary-key" className="text-[12px] font-semibold text-text-2 uppercase tracking-wide">
            API Key — {PROVIDER_LABELS[primaryProvider].name}
          </label>
          <input
            id="embedding-primary-key"
            type="password"
            autoComplete="new-password"
            value={primaryApiKey}
            onChange={(e) => setPrimaryApiKey(e.target.value)}
            placeholder={config?.configured ? 'Nhập key mới để rotate/cập nhật' : `Dán API key ${primaryProvider}`}
            disabled={loading || saving}
            className="mt-1.5 w-full h-10 px-3 rounded-lg border border-border bg-surface text-[13px] text-text-1 outline-none focus:border-verity focus:ring-2 focus:ring-verity/15 disabled:opacity-60"
          />
        </div>

        {/* Model — with probe */}
        <div>
          <label className="text-[12px] font-semibold text-text-2 uppercase tracking-wide block mb-1.5">
            Embedding Model
          </label>
          <input
            type="text"
            value={primaryModel}
            onChange={(e) => setPrimaryModel(e.target.value)}
            disabled={loading || saving}
            placeholder="jina-ai/jina-clip-v2"
            className="w-full h-10 px-3 rounded-lg border border-border bg-surface text-[13px] text-text-1 font-mono outline-none focus:border-verity focus:ring-2 focus:ring-verity/15 disabled:opacity-60"
          />
          {/* Probed model list */}
          {primaryProbedModels.length > 0 && (
            <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-border bg-surface-2/60 divide-y divide-border">
              {primaryProbedModels.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setPrimaryModel(m)}
                  className={cn(
                    'w-full flex items-center justify-between px-3 py-1.5 text-left text-[12px] font-mono transition-colors',
                    primaryModel === m ? 'bg-verity-soft text-verity font-semibold' : 'text-text-2 hover:bg-hover'
                  )}
                >
                  <span className="truncate">{m}</span>
                  {primaryModel === m && <CheckCircle2 className="w-3.5 h-3.5 flex-none text-verity" />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Probe models button */}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            disabled={primaryProbing || !primaryBaseUrl.trim() || !primaryApiKey.trim() || loading || saving}
            onClick={() => probeModels(primaryBaseUrl, primaryApiKey, setPrimaryProbedModels, setPrimaryProbing, setPrimaryProbeError)}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-verity-border bg-verity-soft text-verity text-[12.5px] font-semibold hover:bg-verity hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {primaryProbing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            {primaryProbing ? 'Đang lấy models...' : 'Lấy Models từ Endpoint'}
          </button>
          {primaryProbedModels.length > 0 && (
            <span className="text-[11.5px] text-ok font-semibold">✓ {primaryProbedModels.length} models — click để chọn</span>
          )}
          {primaryProbeError && <span className="text-[11.5px] text-bad">{primaryProbeError}</span>}
        </div>
      </div>


      {/* Divider */}
      <div className="border-t border-border" />

      {/* ── Fallback Provider ── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-text-3">Fallback Provider</h3>
            <p className="text-[11.5px] text-text-3 mt-0.5">
              Kích hoạt khi provider chính trả về lỗi 429 / 5xx
            </p>
          </div>
          <button
            type="button"
            onClick={() => setFallbackEnabled((v) => !v)}
            disabled={loading || saving}
            className="flex items-center gap-1.5 text-[12px] font-semibold text-text-2 hover:text-text-1 transition-colors disabled:opacity-60"
          >
            {fallbackEnabled ? (
              <ToggleRight className="w-6 h-6 text-ok" />
            ) : (
              <ToggleLeft className="w-6 h-6 text-text-3" />
            )}
            {fallbackEnabled ? 'Bật' : 'Tắt'}
          </button>
        </div>

        {fallbackEnabled && (
          <div className={cn('space-y-3 pl-3 border-l-2 border-ok-border', saving && 'opacity-60')}>
            {/* Fallback provider selector */}
            <div>
              <label className="text-[12px] font-semibold text-text-2 uppercase tracking-wide block mb-1.5">
                Fallback Provider
              </label>
              <ProviderSelect
                value={fallbackProvider}
                onChange={handleFallbackProviderChange}
                disabled={loading || saving}
                exclude={primaryProvider}
              />
              <p className="mt-1.5 text-[11.5px] text-text-3">{PROVIDER_LABELS[fallbackProvider].desc}</p>
            </div>

            {/* Fallback Base URL — editable */}
            <div>
              <label className="text-[12px] font-semibold text-text-2 uppercase tracking-wide block mb-1.5">
                Base URL
              </label>
              <input
                type="text"
                value={fallbackBaseUrl}
                onChange={(e) => setFallbackBaseUrl(e.target.value)}
                disabled={loading || saving}
                placeholder="https://generativelanguage.googleapis.com/v1beta"
                className="w-full h-10 px-3 rounded-lg border border-border bg-surface text-[13px] text-text-1 font-mono outline-none focus:border-ok focus:ring-2 focus:ring-ok/15 disabled:opacity-60"
              />
            </div>

            {/* Fallback API Key */}
            <div>
              <label htmlFor="embedding-fallback-key" className="text-[12px] font-semibold text-text-2 uppercase tracking-wide">
                API Key — {PROVIDER_LABELS[fallbackProvider].name}
              </label>
              <input
                id="embedding-fallback-key"
                type="password"
                autoComplete="new-password"
                value={fallbackApiKey}
                onChange={(e) => setFallbackApiKey(e.target.value)}
                placeholder={
                  config?.fallback?.configured
                    ? 'Nhập key mới để rotate/cập nhật fallback'
                    : `Dán API key ${fallbackProvider}`
                }
                disabled={loading || saving}
                className="mt-1.5 w-full h-10 px-3 rounded-lg border border-border bg-surface text-[13px] text-text-1 outline-none focus:border-ok focus:ring-2 focus:ring-ok/15 disabled:opacity-60"
              />
              {config?.fallback?.configured && !fallbackApiKey && (
                <p className="mt-1 text-[11.5px] text-ok flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> Đã cấu hình — bỏ trống để giữ nguyên key cũ
                </p>
              )}
            </div>

            {/* Fallback Model — with probe */}
            <div>
              <label className="text-[12px] font-semibold text-text-2 uppercase tracking-wide block mb-1.5">
                Embedding Model
              </label>
              <input
                type="text"
                value={fallbackModel}
                onChange={(e) => setFallbackModel(e.target.value)}
                disabled={loading || saving}
                placeholder="text-embedding-004"
                className="w-full h-10 px-3 rounded-lg border border-border bg-surface text-[13px] text-text-1 font-mono outline-none focus:border-ok focus:ring-2 focus:ring-ok/15 disabled:opacity-60"
              />
              {fallbackProbedModels.length > 0 && (
                <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-border bg-surface-2/60 divide-y divide-border">
                  {fallbackProbedModels.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setFallbackModel(m)}
                      className={cn(
                        'w-full flex items-center justify-between px-3 py-1.5 text-left text-[12px] font-mono transition-colors',
                        fallbackModel === m ? 'bg-ok-soft text-ok font-semibold' : 'text-text-2 hover:bg-hover'
                      )}
                    >
                      <span className="truncate">{m}</span>
                      {fallbackModel === m && <CheckCircle2 className="w-3.5 h-3.5 flex-none text-ok" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Fallback Probe button */}
            <div className="flex items-center gap-3 flex-wrap">
              <button
                type="button"
                disabled={fallbackProbing || !fallbackBaseUrl.trim() || !fallbackApiKey.trim() || loading || saving}
                onClick={() => probeModels(fallbackBaseUrl, fallbackApiKey, setFallbackProbedModels, setFallbackProbing, setFallbackProbeError)}
                className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-ok-border bg-ok-soft text-ok text-[12.5px] font-semibold hover:bg-ok hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {fallbackProbing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                {fallbackProbing ? 'Đang lấy models...' : 'Lấy Models Fallback'}
              </button>
              {fallbackProbedModels.length > 0 && (
                <span className="text-[11.5px] text-ok font-semibold">✓ {fallbackProbedModels.length} models — click để chọn</span>
              )}
              {fallbackProbeError && <span className="text-[11.5px] text-bad">{fallbackProbeError}</span>}
            </div>
          </div>
        )}

        {/* Fallback disabled notice */}
        {!fallbackEnabled && config?.fallback?.configured && (
          <div className="flex items-start gap-2 p-3 rounded-xl border border-warn-border bg-warn-soft text-[12px] text-warn leading-relaxed">
            <AlertCircle className="w-4 h-4 flex-none mt-0.5" />
            <span>Fallback đang có dữ liệu nhưng bị tắt. Lưu lại để xóa cấu hình fallback.</span>
          </div>
        )}
      </div>


      {/* Save button */}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={loading || saving || !primaryApiKey.trim() || (fallbackEnabled && !fallbackApiKey.trim() && !config?.fallback?.configured)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-verity text-white text-[12.5px] font-bold hover:bg-verity-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Lưu cấu hình Embedding
        </button>
      </div>
    </form>
  );
}
