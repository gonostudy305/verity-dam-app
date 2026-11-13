'use client';

import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  Bot,
  Link2,
  Sliders,
  Zap,
  Code2,
  Copy,
  Check,
  AlertTriangle,
  Loader2,
  ChevronDown,
  Info,
  Upload,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/common/Toast';
import type { AIVisionConfig, VisionDetail } from '@/types/media';
import {
  DEFAULT_VISION_CONFIG,
  DEFAULT_VISION_TEST_IMAGE_URL,
  loadVisionTestImageUrl,
  saveVisionTestImageUrl,
  testVisionConnection,
  generateCurlSnippet,
  generatePythonSnippet,
  generateNodeSnippet,
  type TestConnectionResult,
} from '@/lib/ai-vision';
import { apiRequest } from '@/lib/client/api';

// ─── Constants ────────────────────────────────────────────────────────────────

// No hardcoded model list — models are fetched dynamically from the endpoint.

const DETAIL_OPTIONS: { value: VisionDetail; label: string; desc: string; cost: string }[] = [
  { value: 'auto', label: 'Auto', desc: 'Model tự quyết định', cost: 'Cân bằng' },
  { value: 'low', label: 'Low', desc: 'Nén ảnh — đọc text sơ bộ', cost: 'Ít token nhất' },
  { value: 'high', label: 'High', desc: 'Giữ nguyên độ phân giải', cost: 'Tốn token nhất' },
];

const CODE_TABS = ['cURL', 'Python', 'Node.js'] as const;
type CodeTab = (typeof CODE_TABS)[number];

type SharedVisionConfig = Omit<AIVisionConfig, 'apiKey'> & {
  configured: boolean;
  updatedAt: string | null;
};

// ─── Section Header ───────────────────────────────────────────────────────────

function SectionHeader({ icon: Icon, title, subtitle }: { icon: React.ElementType; title: string; subtitle?: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="w-8 h-8 rounded-lg bg-ai-soft border border-ai-border flex items-center justify-center flex-none mt-0.5">
        <Icon className="w-4 h-4 text-ai" />
      </div>
      <div>
        <div className="text-[14px] font-bold text-text-1">{title}</div>
        {subtitle && <div className="text-[12px] text-text-3 mt-0.5">{subtitle}</div>}
      </div>
    </div>
  );
}

// ─── Field Label ──────────────────────────────────────────────────────────────

function FieldLabel({ children, tooltip }: { children: React.ReactNode; tooltip?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex items-center gap-1.5 mb-1.5">
      <label className="text-[12px] font-semibold text-text-2 uppercase tracking-wide">{children}</label>
      {tooltip && (
        <div className="relative">
          <button
            type="button"
            onMouseEnter={() => setShow(true)}
            onMouseLeave={() => setShow(false)}
            className="text-text-disabled hover:text-text-3 transition-colors"
          >
            <Info className="w-3.5 h-3.5" />
          </button>
          {show && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-2.5 rounded-lg bg-elevated border border-border shadow-pop text-[11.5px] text-text-2 leading-relaxed z-50">
              {tooltip}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Input ────────────────────────────────────────────────────────────────────

function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
  error,
  suffix,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  error?: string;
  suffix?: React.ReactNode;
}) {
  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-2 px-3 h-9 rounded-lg border bg-surface text-[13px] text-text-1 transition-all',
          error ? 'border-bad-border ring-1 ring-bad/20' : 'border-border focus-within:border-verity-border focus-within:ring-1 focus-within:ring-verity/20'
        )}
      >
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="flex-1 bg-transparent outline-none placeholder:text-text-disabled min-w-0"
        />
        {suffix}
      </div>
      {error && <div className="mt-1 text-[11.5px] text-bad">{error}</div>}
    </div>
  );
}

// ─── Select ───────────────────────────────────────────────────────────────────

function Select<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="appearance-none w-full h-9 px-3 pr-8 rounded-lg border border-border bg-surface text-[13px] text-text-1 outline-none focus:border-verity-border focus:ring-1 focus:ring-verity/20 transition-all cursor-pointer"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-3" />
    </div>
  );
}

// ─── Connection Badge ─────────────────────────────────────────────────────────

function ConnectionBadge({ result, loading }: { result: TestConnectionResult | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-verity-soft border border-verity-border text-[12.5px] text-verity font-semibold">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>Đang kiểm tra...</span>
      </div>
    );
  }
  if (!result) return null;
  return (
    <div
      className={cn(
        'rounded-lg border text-[12.5px] font-semibold overflow-hidden',
        result.ok ? 'bg-ok-soft border-ok-border' : 'bg-bad-soft border-bad-border'
      )}
    >
      <div className={cn('flex items-center gap-2 px-3 py-2', result.ok ? 'text-ok' : 'text-bad')}>
        {result.ok ? <Check className="w-3.5 h-3.5 flex-none" /> : <AlertTriangle className="w-3.5 h-3.5 flex-none" />}
        <span className="flex-1 min-w-0 truncate">{result.message}</span>
        {result.latencyMs && (
          <span className="text-[11px] font-mono opacity-70 flex-none">{result.latencyMs}ms</span>
        )}
      </div>
      {result.responseSnippet && (
        <div className="px-3 pb-2.5 pt-0">
          <p className="text-[11.5px] font-normal text-text-2 leading-relaxed line-clamp-4 font-mono bg-surface/60 p-2 rounded-md border border-ok-border/40">
            {result.responseSnippet}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Code Snippet Block ───────────────────────────────────────────────────────

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: execCommand
      const el = document.createElement('textarea');
      el.value = code;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="relative rounded-xl border border-border overflow-hidden bg-[#0F1923]">
      <button
        type="button"
        onClick={handleCopy}
        className={cn(
          'absolute top-2.5 right-2.5 flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] font-semibold transition-all z-10',
          copied
            ? 'bg-ok text-white'
            : 'bg-white/10 text-white/70 hover:bg-white/20 hover:text-white'
        )}
      >
        {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        {copied ? 'Đã copy' : 'Copy'}
      </button>
      <pre className="p-4 text-[12px] text-[#C9D4DF] font-mono leading-relaxed overflow-x-auto whitespace-pre">
        {code}
      </pre>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function AIVisionSettings() {
  const { showToast } = useToast();
  const [config, setConfig] = useState<AIVisionConfig>(DEFAULT_VISION_CONFIG);
  const [savedConfig, setSavedConfig] = useState<AIVisionConfig | null>(null);
  const [configured, setConfigured] = useState(false);
  const [configLoading, setConfigLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [customModel, setCustomModel] = useState('');
  const [urlError, setUrlError] = useState('');
  const [activeTab, setActiveTab] = useState<CodeTab>('cURL');
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const [testImageUrl, setTestImageUrl] = useState(DEFAULT_VISION_TEST_IMAGE_URL);
  const [testImagePreview, setTestImagePreview] = useState(DEFAULT_VISION_TEST_IMAGE_URL);
  const [showCodeSnippet, setShowCodeSnippet] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [probing, setProbing] = useState(false);
  const [probedModels, setProbedModels] = useState<string[]>([]);
  const [probeError, setProbeError] = useState('');

  // Nạp URL ảnh kiểm tra đã lưu từ localStorage khi khởi động
  useEffect(() => {
    const savedUrl = loadVisionTestImageUrl();
    setTestImageUrl(savedUrl);
    setTestImagePreview(savedUrl);
  }, []);

  const isCustomModel = probedModels.length > 0
    ? !probedModels.includes(config.model)
    : false;

  useEffect(() => {
    if (isCustomModel) setCustomModel(config.model);
  }, [config.model, isCustomModel]);

  // ── Helpers ──
  useEffect(() => {
    let active = true;
    void apiRequest<{ data: SharedVisionConfig }>('/api/settings/vision')
      .then(({ data }) => {
        if (!active) return;
        const nextConfig = {
          baseUrl: data.baseUrl,
          apiKey: '',
          model: data.model,
          detail: data.detail,
          maxTokens: data.maxTokens,
          systemPrompt: data.systemPrompt,
        };
        setConfig(nextConfig);
        setSavedConfig(nextConfig);
        setConfigured(data.configured);
      })
      .catch((error) => {
        if (active) showToast(error instanceof Error ? error.message : 'Unable to load shared AI configuration.', 'warn');
      })
      .finally(() => {
        if (active) setConfigLoading(false);
      });
    return () => {
      active = false;
    };
  }, [showToast]);

  const update = useCallback(<K extends keyof AIVisionConfig>(key: K, val: AIVisionConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: val }));
  }, []);

  const validateUrl = (url: string) => {
    if (!url) return 'Base URL không được để trống';
    if (!/^https:\/\//i.test(url)) return 'URL phải bắt đầu bằng https://';
    return '';
  };

  // ── Save ──
  const saveConfiguration = async (quiet = false) => {
    const err = validateUrl(config.baseUrl);
    setUrlError(err);
    if (err) return false;
    setSaving(true);
    try {
      const response = await apiRequest<{ data: SharedVisionConfig }>('/api/settings/vision', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const nextConfig = {
        baseUrl: response.data.baseUrl,
        apiKey: '',
        model: response.data.model,
        detail: response.data.detail,
        maxTokens: response.data.maxTokens,
        systemPrompt: response.data.systemPrompt,
      };
      setConfig(nextConfig);
      setSavedConfig(nextConfig);
      setConfigured(response.data.configured);
      if (!quiet) {
        showToast('Đã lưu cấu hình AI dùng chung thành công.', 'success');
      }
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể lưu cấu hình AI dùng chung.', 'warn');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    void saveConfiguration();
  };

  // ── Upload test image ──
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // [QA #5] Warn if > 5MB
    if (file.size > 5 * 1024 * 1024) {
      showToast('Ảnh quá 5MB — hãy dùng ảnh nhỏ hơn để test', 'warn');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      setTestImageUrl(dataUrl);
      setTestImagePreview(dataUrl);
      setTestResult(null);
    };
    reader.readAsDataURL(file);
  };

  const clearTestImage = () => {
    setTestImageUrl('');
    setTestImagePreview('');
    setTestResult(null);
    saveVisionTestImageUrl('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // ── Test connection ──
  const handleTest = async () => {
    const needsSave =
      !savedConfig ||
      !!config.apiKey.trim() ||
      config.baseUrl !== savedConfig.baseUrl ||
      config.model !== savedConfig.model ||
      config.detail !== savedConfig.detail ||
      config.maxTokens !== savedConfig.maxTokens ||
      config.systemPrompt !== savedConfig.systemPrompt;
    if (!configured && !needsSave) {
      showToast('Hãy lưu cấu hình Vision trước khi kiểm tra kết nối.', 'warn');
      return;
    }
    setTestLoading(true);
    setTestResult(null);
    const saved = needsSave ? await saveConfiguration(true) : configured;
    if (!saved) {
      setTestLoading(false);
      return;
    }
    const result = await testVisionConnection(config, testImageUrl || undefined);
    setTestResult(result);
    setTestLoading(false);
  };

  // ── Code snippet ──
  const snippet = (() => {
    const sampleUrl = testImageUrl && !testImageUrl.startsWith('data:')
      ? testImageUrl
      : DEFAULT_VISION_TEST_IMAGE_URL;
    const snippetConfig = { ...config, apiKey: '' };
    if (activeTab === 'cURL') return generateCurlSnippet(snippetConfig, sampleUrl);
    if (activeTab === 'Python') return generatePythonSnippet(snippetConfig);
    return generateNodeSnippet(snippetConfig);
  })();

  // ── Probe models from endpoint ──
  const handleProbeModels = async () => {
    if (!config.baseUrl.trim()) {
      setProbeError('Nhập Base URL trước khi lấy danh sách models.');
      return;
    }
    if (!config.apiKey.trim() && !configured) {
      setProbeError('Nhập API Key để xác thực với endpoint.');
      return;
    }
    setProbing(true);
    setProbeError('');
    setProbedModels([]);
    try {
      const res = await apiRequest<{ models: string[] }>('/api/settings/probe-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: config.baseUrl, apiKey: config.apiKey }),
      });
      setProbedModels(res.models);
      if (res.models.length === 0) {
        setProbeError('Endpoint kết nối thành công nhưng không trả về model nào.');
      }
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : 'Không thể lấy danh sách models.');
    } finally {
      setProbing(false);
    }
  };

  const effectiveModel = isCustomModel ? customModel : config.model;


  return (
    <div className="p-5 rounded-2xl border border-ai-border bg-surface shadow-xs space-y-6">
      {/* ── Header ── */}
      <SectionHeader
        icon={Bot}
        title="Kết nối AI Vision (OpenAI-compatible)"
      />

      {/* ── Section 1: Endpoint & Auth ── */}
      <div className="space-y-4">
        <div className="text-[12px] font-bold text-text-3 uppercase tracking-widest">Endpoint & Xác thực</div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Base URL */}
          <div>
            <FieldLabel
              tooltip="Base URL của API gateway, không gồm /chat/completions. Endpoint đầy đủ sẽ là: <baseUrl>/chat/completions"
            >
              <Link2 className="w-3 h-3 inline-block mr-1 opacity-70" />
              Base URL
            </FieldLabel>
            <Input
              value={config.baseUrl}
              onChange={(v) => {
                update('baseUrl', v);
                if (urlError) setUrlError(validateUrl(v));
              }}
              placeholder="https://api.example.com/v1"
              error={urlError}
            />
          </div>

          {/* Model — dynamic from endpoint */}
          <div>
            <FieldLabel tooltip="Nhập Base URL + API Key rồi bấm 'Lấy Models' để lấy danh sách model từ endpoint. Hoặc nhập tên model thủ công.">
              Model Vision
            </FieldLabel>
            {/* Manual model input — always visible */}
            <input
              className="w-full h-9 px-3 rounded-lg border border-border bg-surface text-[13px] text-text-1 outline-none focus:border-verity-border focus:ring-1 focus:ring-verity/20 transition-all"
              placeholder="Nhập tên model (vd: cx/gpt-6-luna)"
              value={config.model}
              onChange={(e) => {
                update('model', e.target.value);
                setCustomModel(e.target.value);
              }}
            />
            {/* Probed model list */}
            {probedModels.length > 0 && (
              <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-border bg-surface-2/60 divide-y divide-border">
                {probedModels.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => update('model', m)}
                    className={cn(
                      'w-full flex items-center justify-between px-3 py-1.5 text-left text-[12.5px] font-mono transition-colors',
                      config.model === m
                        ? 'bg-verity-soft text-verity font-semibold'
                        : 'text-text-2 hover:bg-hover'
                    )}
                  >
                    <span className="truncate">{m}</span>
                    {config.model === m && <Check className="w-3.5 h-3.5 flex-none text-verity" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* API Key */}
        <div>
          <FieldLabel tooltip="Key chỉ được gửi tới API nội bộ khi lưu. PostgreSQL giữ bản mã hóa; key không được tải lại vào trình duyệt.">
            API Key dùng chung
          </FieldLabel>
          <Input
            type="password"
            value={config.apiKey}
            onChange={(value) => update('apiKey', value)}
            placeholder={configured ? '•••••••••••••••••••• (Đã lưu mã hóa — để trống nếu không đổi)' : 'Nhập API key để lưu dùng chung'}
          />
          <p className="mt-1.5 text-[11px] text-text-3">
            {configLoading
              ? 'Đang kiểm tra cấu hình đã lưu…'
              : configured
                ? 'Key đã được lưu mã hóa an toàn (AES-256-GCM). Chỉ nhập khi muốn thay đổi key mới.'
                : 'Chưa có key dùng chung được lưu.'}
          </p>
        </div>

        {/* Probe models button */}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={handleProbeModels}
            disabled={probing || !config.baseUrl.trim() || (!config.apiKey.trim() && !configured)}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-verity-border bg-verity-soft text-verity text-[12.5px] font-semibold hover:bg-verity hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {probing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            {probing ? 'Đang lấy models...' : `Lấy Models từ Endpoint`}
          </button>
          {probedModels.length > 0 && (
            <span className="text-[11.5px] text-ok font-semibold">
              ✓ {probedModels.length} models khả dụng — click để chọn
            </span>
          )}
          {probeError && (
            <span className="text-[11.5px] text-bad">{probeError}</span>
          )}
        </div>
      </div>


      <div className="border-t border-border-subtle" />

      {/* ── Section 2: Vision Parameters ── */}
      <div className="space-y-4">
        <div className="text-[12px] font-bold text-text-3 uppercase tracking-widest">Tham số Vision</div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Detail */}
          <div>
            <FieldLabel tooltip={`low: Nén ảnh, tiết kiệm token tối đa, phù hợp đọc text sơ bộ.\nhigh: Giữ nguyên độ phân giải cao, đọc chữ nhỏ và chi tiết rất nét, tốn token hơn.\nauto: Model tự quyết định.`}>
              <Sliders className="w-3 h-3 inline-block mr-1 opacity-70" />
              Image Detail
            </FieldLabel>
            <div className="grid grid-cols-3 gap-1.5">
              {DETAIL_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => update('detail', opt.value)}
                  className={cn(
                    'flex flex-col items-center gap-0.5 p-2 rounded-lg border text-[11.5px] font-semibold transition-all',
                    config.detail === opt.value
                      ? 'bg-verity text-white border-verity shadow-sm'
                      : 'bg-surface-2 text-text-2 border-border hover:border-verity-border hover:bg-verity-soft'
                  )}
                >
                  <span>{opt.label}</span>
                  <span className={cn('text-[10px] font-normal', config.detail === opt.value ? 'text-white/70' : 'text-text-3')}>
                    {opt.cost}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Max Tokens */}
          <div>
            <FieldLabel tooltip="Số token tối đa trong response. Tăng lên nếu AI bị cắt giữa chừng.">
              Max Tokens
              <span className="ml-2 text-verity font-mono font-bold">{config.maxTokens}</span>
            </FieldLabel>
            <input
              type="range"
              min={256}
              max={4096}
              step={64}
              value={config.maxTokens}
              onChange={(e) => update('maxTokens', Number(e.target.value))}
              className="w-full h-1.5 rounded-full accent-verity cursor-pointer"
            />
            <div className="flex justify-between text-[10.5px] text-text-disabled mt-1 font-mono">
              <span>256</span>
              <span>4096</span>
            </div>
          </div>
        </div>

        {/* System Prompt */}
        <div>
          <FieldLabel tooltip="Hướng dẫn mức system cho AI. Mô tả vai trò và nhiệm vụ phân tích ảnh sản phẩm.">
            System Prompt
          </FieldLabel>
          <textarea
            value={config.systemPrompt}
            onChange={(e) => update('systemPrompt', e.target.value)}
            rows={3}
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-[12.5px] text-text-1 resize-none outline-none focus:border-verity-border focus:ring-1 focus:ring-verity/20 transition-all leading-relaxed placeholder:text-text-disabled font-mono"
            placeholder="Bạn là trợ lý phân tích hình ảnh sản phẩm..."
          />
        </div>
      </div>

      <div className="border-t border-border-subtle" />

      {/* ── Section 3: Test Connection ── */}
      <div className="space-y-4">
        <div className="text-[12px] font-bold text-text-3 uppercase tracking-widest">Kiểm tra kết nối</div>

        {/* Image input */}
        <div className="flex items-start gap-3">
          <div className="flex-1 space-y-2">
            <FieldLabel tooltip="Nhập URL ảnh công khai hoặc upload ảnh từ máy. Ảnh sẽ được gửi tới AI kèm prompt test. Giới hạn upload: 5MB.">
              Ảnh kiểm tra
            </FieldLabel>
            <div className="flex gap-2">
              <Input
                value={testImageUrl.startsWith('data:') ? '' : testImageUrl}
                onChange={(v) => {
                  setTestImageUrl(v);
                  setTestImagePreview(v);
                  setTestResult(null);
                  if (!v.startsWith('data:')) {
                    saveVisionTestImageUrl(v);
                  }
                }}
                placeholder="https://... hoặc upload ảnh từ máy"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex-none flex items-center gap-1.5 px-3 h-9 rounded-lg border border-border bg-surface-2 text-[12.5px] font-semibold text-text-2 hover:bg-hover hover:text-text-1 transition-all"
              >
                <Upload className="w-3.5 h-3.5" />
                Upload
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={handleFileUpload}
              />
            </div>
          </div>

          {/* Image preview */}
          {testImagePreview && (
            <div className="relative flex-none mt-7">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={testImagePreview}
                alt="Ảnh test"
                className="w-16 h-16 object-cover rounded-lg border border-border"
              />
              <button
                type="button"
                onClick={clearTestImage}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-bad text-white flex items-center justify-center shadow"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-3">
          <button
            id="btn-test-vision-connection"
            type="button"
            onClick={handleTest}
            disabled={testLoading || saving || configLoading}
            className="flex items-center gap-2 px-4 h-9 rounded-lg bg-ai text-white text-[13px] font-semibold hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {testLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Zap className="w-4 h-4" />
            )}
            Kiểm tra kết nối
          </button>

          <button
            id="btn-save-vision-config"
            type="button"
            onClick={handleSave}
            disabled={saving || configLoading}
            className="flex items-center gap-2 px-4 h-9 rounded-lg bg-verity text-white text-[13px] font-semibold hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            Lưu cấu hình
          </button>
        </div>

        {/* Result badge */}
        <ConnectionBadge result={testResult} loading={testLoading} />
      </div>

      <div className="border-t border-border-subtle" />

      {/* ── Section 4: Code Snippets (Collapsible) ── */}
      <div className="rounded-xl border border-border bg-surface-2/30 overflow-hidden">
        <button
          type="button"
          onClick={() => setShowCodeSnippet((prev) => !prev)}
          className="w-full flex items-center justify-between p-3.5 text-left hover:bg-surface-2/60 transition-colors"
        >
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-surface border border-border flex items-center justify-center text-text-2">
              <Code2 className="w-3.5 h-3.5" />
            </div>
            <div>
              <div className="text-[13px] font-bold text-text-1">Code mẫu tích hợp API (cURL / Python / Node.js)</div>
              <div className="text-[11.5px] text-text-3">Nhấn để xem và copy code snippet đã điền sẵn cấu hình</div>
            </div>
          </div>
          <ChevronDown
            className={cn(
              'w-4 h-4 text-text-3 transition-transform duration-200',
              showCodeSnippet ? 'rotate-180' : ''
            )}
          />
        </button>

        {showCodeSnippet && (
          <div className="p-4 pt-1 space-y-3 border-t border-border-subtle">
            {/* Tabs */}
            <div className="flex gap-1 p-1 rounded-lg bg-surface border border-border w-fit">
              {CODE_TABS.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={cn(
                    'px-3 py-1 rounded-md text-[12px] font-semibold transition-all',
                    activeTab === tab
                      ? 'bg-surface-2 text-text-1 shadow-xs border border-border'
                      : 'text-text-3 hover:text-text-2'
                  )}
                >
                  {tab}
                </button>
              ))}
            </div>

            <CodeBlock code={snippet} />

            {/* Payload structure info */}
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-verity-soft border border-verity-border text-[11.5px] text-verity leading-relaxed">
              <Info className="w-3.5 h-3.5 flex-none mt-0.5" />
              <span>
                <strong>Cấu trúc chuẩn:</strong> <code className="font-mono">messages[].content</code> là{' '}
                <strong>mảng (Array)</strong> — không phải string. Mỗi phần tử có{' '}
                <code className="font-mono">type: &quot;text&quot;</code> hoặc{' '}
                <code className="font-mono">type: &quot;image_url&quot;</code>.
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
