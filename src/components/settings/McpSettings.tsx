'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Cpu,
  Key,
  Loader2,
  Lock,
  LogIn,
  MessageSquareText,
  Plus,
  RefreshCw,
  RotateCw,
  Shield,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { useToast } from '@/components/common/Toast';
import { cn } from '@/lib/utils';
import {
  MCP_SAMPLE_PROMPTS,
  MCP_TOKEN_PLACEHOLDER,
  mcpClientConfigs,
  mcpInstallLinks,
  mcpOAuthConfigs,
  toolsForRole,
  type McpAgentRole,
  type McpClientConfig,
  type McpClientId,
  type McpToolInfo,
} from '@/lib/mcp-catalog';

// ─── Types ────────────────────────────────────────────────────────────────────

interface McpAgent {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: McpAgentRole;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  rotatedFromId: string | null;
  calls24h: number;
  status: 'active' | 'revoked' | 'expired';
  rawKey?: string;
}

interface McpStatus {
  publicUrl: string | null;
  health: {
    configured: boolean;
    reachable: boolean;
    latencyMs: number | null;
    protocolVersion: string | null;
    rateLimitPerMinute: number | null;
    error: string | null;
  };
  publicRoute: { state: 'routed' | 'not_routed' | 'unreachable'; status: number | null; latencyMs: number | null } | null;
  checkedAt: string;
}

interface McpToolRow extends McpToolInfo {
  enabled: boolean;
  calls7d: number;
}

interface McpActivityRow {
  id: string;
  toolName: string;
  status: 'success' | 'error';
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;
  apiKeyId: string | null;
  keyName: string | null;
  keyPrefix: string | null;
  agentEmail: string | null;
}

const ROLE_LABEL: Record<McpAgentRole, string> = {
  viewer: 'Viewer: chỉ tìm kiếm & đọc',
  contributor: 'Contributor: thêm upload ảnh chờ duyệt, ghi nhận đăng ảnh',
  reviewer: 'Reviewer: thêm duyệt ảnh, sửa metadata, crop',
};

const EXPIRY_OPTIONS: { value: string; label: string }[] = [
  { value: '30', label: '30 ngày' },
  { value: '90', label: '90 ngày' },
  { value: '365', label: '1 năm' },
  { value: 'never', label: 'Không giới hạn' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  return json;
}

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
}

function relativeTime(value: string | null): string {
  if (!value) return 'Chưa dùng';
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'Vừa xong';
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} giờ trước`;
  return `${Math.round(hours / 24)} ngày trước`;
}

function roleBadgeClass(role: McpAgentRole): string {
  if (role === 'reviewer') return 'bg-ai/10 text-ai border-ai/20';
  if (role === 'contributor') return 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20';
  return 'bg-surface text-text-3 border-border';
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function CopyButton({ text, className, label = 'Sao chép' }: { text: string; className?: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'flex flex-none items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11.5px] font-semibold border transition-all',
        copied ? 'bg-ok-soft border-ok-border text-ok' : 'bg-surface-2 border-border text-text-2 hover:text-text-1 hover:bg-hover',
        className
      )}
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Đã sao chép' : label}
    </button>
  );
}

function SectionHeader({
  icon: Icon,
  iconClass,
  title,
  subtitle,
  actions,
}: {
  icon: React.ComponentType<{ className?: string }>;
  iconClass: string;
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2.5 min-w-0">
        <div className={cn('w-8 h-8 rounded-lg border flex items-center justify-center flex-none', iconClass)}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <div className="text-[13.5px] font-bold text-text-1">{title}</div>
          <div className="text-[11.5px] text-text-3">{subtitle}</div>
        </div>
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

function StatusPill({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'muted'; children: React.ReactNode }) {
  const toneClass = {
    ok: 'bg-ok-soft text-ok border-ok-border',
    warn: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
    bad: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20',
    muted: 'bg-surface-2 text-text-3 border-border',
  }[tone];
  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border', toneClass)}>
      <span className={cn('w-1.5 h-1.5 rounded-full', tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-amber-500' : tone === 'bad' ? 'bg-red-500' : 'bg-text-3')} />
      {children}
    </span>
  );
}

function ConfigBlock({ configs, compact = false }: { configs: McpClientConfig[]; compact?: boolean }) {
  const [clientId, setClientId] = useState<McpClientId>('claude-desktop');
  const cfg = configs.find((item) => item.id === clientId) ?? configs[0];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1 p-1 rounded-xl bg-surface-2/60 border border-border w-fit max-w-full">
        {configs.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setClientId(item.id)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-all',
              clientId === item.id ? 'bg-surface text-text-1 border border-border shadow-xs' : 'text-text-3 hover:text-text-1 border border-transparent'
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="relative rounded-xl border border-border bg-[#0d1117] overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-white/5">
          <span className="text-[11px] text-white/40 font-mono truncate">{cfg.filename}</span>
          <CopyButton text={cfg.code} className="bg-white/5 border-white/10 text-white/60 hover:bg-white/10 hover:text-white/90" />
        </div>
        <pre className={cn('p-4 text-[12px] leading-relaxed text-green-300/90 font-mono overflow-x-auto', compact && 'max-h-[220px]')}>
          <code>{cfg.code}</code>
        </pre>
      </div>
      <p className="text-[11.5px] text-text-3 leading-relaxed">{cfg.note}</p>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function McpSettings() {
  const { showToast } = useToast();

  const [endpointFallback, setEndpointFallback] = useState('http://localhost:3000/mcp');
  useEffect(() => { setEndpointFallback(`${window.location.origin}/mcp`); }, []);

  // ── Status ──
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(true);
  const checkStatus = useCallback(async () => {
    setCheckingStatus(true);
    try {
      const json = await api<{ data: McpStatus }>('/api/settings/mcp-status');
      setStatus(json.data);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Không kiểm tra được trạng thái MCP.', 'warn');
    } finally {
      setCheckingStatus(false);
    }
  }, [showToast]);

  // ── Keys ──
  const [agents, setAgents] = useState<McpAgent[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [agentError, setAgentError] = useState<string | null>(null);
  const fetchAgents = useCallback(async () => {
    setLoadingAgents(true);
    setAgentError(null);
    try {
      const json = await api<{ data: McpAgent[] }>('/api/settings/mcp-agents');
      setAgents(json.data);
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : 'Không thể tải danh sách key.');
    } finally {
      setLoadingAgents(false);
    }
  }, []);

  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<McpAgentRole>('viewer');
  const [newExpiry, setNewExpiry] = useState('90');
  const [adding, setAdding] = useState(false);
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);

  // Raw secret: shown once in the modal, kept only in memory for this page view
  // so the config templates can be filled with the real token.
  const [secret, setSecret] = useState<{ rawKey: string; name: string; email: string; role: McpAgentRole; rotated: boolean } | null>(null);
  const [sessionToken, setSessionToken] = useState<{ rawKey: string; name: string } | null>(null);

  // ── Tools ──
  const [tools, setTools] = useState<McpToolRow[]>([]);
  const [toolsExpanded, setToolsExpanded] = useState(true);
  const [togglingTool, setTogglingTool] = useState<string | null>(null);
  const fetchTools = useCallback(async () => {
    try {
      const json = await api<{ data: McpToolRow[] }>('/api/settings/mcp-tools');
      setTools(json.data);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Không tải được danh sách tool.', 'warn');
    }
  }, [showToast]);

  // ── Activity ──
  const [activity, setActivity] = useState<McpActivityRow[]>([]);
  const [summary, setSummary] = useState<{ total: number; errors: number; p50: number | null } | null>(null);
  const [activityKey, setActivityKey] = useState('');
  const [activityStatus, setActivityStatus] = useState('');
  const [loadingActivity, setLoadingActivity] = useState(true);
  const fetchActivity = useCallback(async () => {
    setLoadingActivity(true);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (activityKey) params.set('keyId', activityKey);
      if (activityStatus) params.set('status', activityStatus);
      const json = await api<{ data: McpActivityRow[]; summary24h: { total: number; errors: number; p50: number | null } }>(
        `/api/settings/mcp-activity?${params.toString()}`
      );
      setActivity(json.data);
      setSummary(json.summary24h);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Không tải được nhật ký MCP.', 'warn');
    } finally {
      setLoadingActivity(false);
    }
  }, [activityKey, activityStatus, showToast]);

  useEffect(() => { void checkStatus(); void fetchAgents(); void fetchTools(); }, [checkStatus, fetchAgents, fetchTools]);
  useEffect(() => { void fetchActivity(); }, [fetchActivity]);

  const endpoint = status?.publicUrl ?? endpointFallback;
  const oauthConfigs = useMemo(() => mcpOAuthConfigs(endpoint), [endpoint]);

  const revealSecret = (created: McpAgent, rotated: boolean) => {
    if (!created.rawKey) return;
    setSecret({ rawKey: created.rawKey, name: created.name, email: created.email, role: created.role, rotated });
    setSessionToken({ rawKey: created.rawKey, name: created.name });
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdding(true);
    try {
      const json = await api<{ data: McpAgent }>('/api/settings/mcp-agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName,
          email: newEmail,
          role: newRole,
          expiresInDays: newExpiry === 'never' ? null : Number(newExpiry),
        }),
      });
      revealSecret(json.data, false);
      setNewName('');
      setNewEmail('');
      setNewRole('viewer');
      setNewExpiry('90');
      setShowAddForm(false);
      await fetchAgents();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Có lỗi khi tạo key.', 'warn');
    } finally {
      setAdding(false);
    }
  };

  const handleRotate = async (agent: McpAgent) => {
    if (busyKeyId) return;
    if (!confirm(`Xoay key của "${agent.name}"? Key cũ (${agent.keyPrefix}) bị thu hồi ngay; agent phải cập nhật key mới.`)) return;
    setBusyKeyId(agent.id);
    try {
      const json = await api<{ data: McpAgent }>(`/api/settings/mcp-agents?id=${agent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rotate' }),
      });
      revealSecret(json.data, true);
      await fetchAgents();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Không xoay được key.', 'warn');
    } finally {
      setBusyKeyId(null);
    }
  };

  const handleRevoke = async (agent: McpAgent) => {
    if (busyKeyId) return;
    if (!confirm(`Thu hồi key của "${agent.name}" (${agent.email})? Agent sẽ bị từ chối (401) ngay lập tức.`)) return;
    setBusyKeyId(agent.id);
    try {
      await api(`/api/settings/mcp-agents?id=${agent.id}`, { method: 'DELETE' });
      showToast(`Đã thu hồi key của ${agent.name}`, 'success');
      if (sessionToken?.rawKey.startsWith(agent.keyPrefix.replace(/\.\.\.$/, ''))) setSessionToken(null);
      await fetchAgents();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Có lỗi xảy ra.', 'warn');
    } finally {
      setBusyKeyId(null);
    }
  };

  const handleToggleTool = async (tool: McpToolRow) => {
    if (togglingTool) return;
    const next = !tool.enabled;
    if (!next && !confirm(`Tắt tool "${tool.name}" cho mọi agent? Lời gọi sẽ bị từ chối trong khoảng 15 giây.`)) return;
    setTogglingTool(tool.name);
    try {
      await api('/api/settings/mcp-tools', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolName: tool.name, enabled: next }),
      });
      setTools((current) => current.map((item) => (item.name === tool.name ? { ...item, enabled: next } : item)));
      showToast(`${next ? 'Đã bật' : 'Đã tắt'} ${tool.name}`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Không đổi được trạng thái tool.', 'warn');
    } finally {
      setTogglingTool(null);
    }
  };

  // ── Status presentation ──
  const health = status?.health;
  const serverPill = !status ? (
    <StatusPill tone="muted">Đang kiểm tra…</StatusPill>
  ) : !health?.configured ? (
    <StatusPill tone="warn">Server chưa triển khai</StatusPill>
  ) : health.reachable ? (
    <StatusPill tone="ok">Server đang chạy · {health.latencyMs} ms</StatusPill>
  ) : (
    <StatusPill tone="bad">Server không phản hồi</StatusPill>
  );
  const route = status?.publicRoute;
  const routePill = !status ? null : !route ? (
    <StatusPill tone="muted">Chưa có URL public</StatusPill>
  ) : route.state === 'routed' ? (
    <StatusPill tone="ok">Endpoint public đã kết nối · {route.latencyMs} ms</StatusPill>
  ) : route.state === 'not_routed' ? (
    <StatusPill tone="bad">Endpoint public chưa trỏ tới MCP (HTTP {route.status})</StatusPill>
  ) : (
    <StatusPill tone="bad">Không truy cập được endpoint public</StatusPill>
  );
  const activeKeys = agents.filter((agent) => agent.status === 'active').length;

  return (
    <div className="space-y-5">
      {/* ── 1. Connection & health ── */}
      <div className="p-5 rounded-2xl border border-border bg-surface shadow-xs space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-xl bg-ai/10 border border-ai/20 flex items-center justify-center flex-none mt-0.5">
              <Cpu className="w-4.5 h-4.5 text-ai" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-bold text-text-1">VerityDAM MCP Server</span>
                <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                  <Lock className="w-3 h-3" />
                  Bearer API key
                </span>
              </div>
              <div className="text-[12px] text-text-3 mt-0.5">Streamable HTTP · mỗi API key có quyền và hạn dùng riêng</div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void checkStatus()}
            disabled={checkingStatus}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-surface-2 text-[12px] font-semibold text-text-2 hover:text-text-1 hover:bg-hover disabled:opacity-60 transition-all"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', checkingStatus && 'animate-spin')} />
            Kiểm tra kết nối
          </button>
        </div>

        <div className="flex items-center gap-2 p-3 rounded-xl bg-surface-2/60 border border-border font-mono">
          <code className="flex-1 text-[12px] text-text-1 truncate">{endpoint}</code>
          <CopyButton text={endpoint} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {serverPill}
          {routePill}
        </div>

        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11.5px]">
          {[
            ['Phiên bản giao thức MCP', health?.protocolVersion ?? '—'],
            ['Giới hạn mỗi key', health?.rateLimitPerMinute ? `${health.rateLimitPerMinute} request/phút` : health?.rateLimitPerMinute === 0 ? 'Không giới hạn' : '—'],
            ['Key đang hoạt động', String(activeKeys)],
            ['Kiểm tra lúc', status ? formatDateTime(status.checkedAt) : '—'],
          ].map(([label, value]) => (
            <div key={label} className="p-2.5 rounded-xl border border-border bg-surface-2/40">
              <dt className="text-text-3">{label}</dt>
              <dd className="mt-0.5 font-semibold text-text-1 font-mono">{value}</dd>
            </div>
          ))}
        </dl>

        {status && (!health?.reachable || route?.state !== 'routed') && (
          <div className="flex items-start gap-2 p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-[12px] text-amber-800 dark:text-amber-200">
            <AlertTriangle className="w-4 h-4 flex-none mt-0.5" />
            <p className="leading-relaxed">
              {!health?.configured
                ? 'App chưa được cấu hình VERITY_MCP_INTERNAL_URL, hoặc container verity-dam-mcp chưa chạy. '
                : !health.reachable
                ? `Không gọi được /health của MCP server (${health.error ?? 'lỗi không rõ'}). `
                : ''}
              {route?.state === 'not_routed'
                ? 'Endpoint public đang trả về web app thay vì MCP server: cần thêm rule tunnel /mcp → cổng 8000. '
                : ''}
              Agent chỉ kết nối được khi cả hai mục trên đều xanh. Xem docs/deploy-mcp-server.md.
            </p>
          </div>
        )}
      </div>

      {/* ── 2. API keys ── */}
      <div className="p-5 rounded-2xl border border-border bg-surface shadow-xs space-y-4">
        <SectionHeader
          icon={Key}
          iconClass="bg-verity-soft border-verity-border text-verity"
          title="API Keys của Agent"
          subtitle="Mỗi agent một key: quyền, hạn dùng, lần dùng gần nhất. Xoay hoặc thu hồi có hiệu lực ngay."
          actions={
            <>
              <button
                type="button"
                onClick={() => void fetchAgents()}
                disabled={loadingAgents}
                className="w-7 h-7 rounded-lg border border-border bg-surface-2 flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-hover transition-all"
                title="Tải lại"
                aria-label="Tải lại danh sách key"
              >
                <RefreshCw className={cn('w-3.5 h-3.5', loadingAgents && 'animate-spin')} />
              </button>
              <button
                type="button"
                onClick={() => setShowAddForm((v) => !v)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-verity-border bg-verity-soft text-[12px] font-semibold text-verity hover:bg-verity/15 transition-all"
              >
                <Plus className="w-3.5 h-3.5" />
                Cấp API Key mới
              </button>
            </>
          }
        />

        {showAddForm && (
          <form onSubmit={(e) => { void handleAdd(e); }} className="p-4 rounded-xl border border-verity-border/60 bg-verity-soft/30 space-y-3">
            <div className="text-[12.5px] font-bold text-text-1">Tạo API key cho agent</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold text-text-3">Tên agent (dùng trong nhật ký) *</span>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="vd: Claude Desktop - máy Vũ"
                  maxLength={128}
                  required
                  className="px-3 py-2 rounded-lg border border-border bg-surface text-[12.5px] text-text-1 placeholder:text-text-3/60 focus:outline-none focus:border-verity/50 focus:ring-1 focus:ring-verity/20"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold text-text-3">Email định danh agent (không dùng email đăng nhập web) *</span>
                <input
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="vd: claude-vu-agent@veritydam.example"
                  required
                  className="px-3 py-2 rounded-lg border border-border bg-surface text-[12.5px] text-text-1 placeholder:text-text-3/60 focus:outline-none focus:border-verity/50 focus:ring-1 focus:ring-verity/20"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold text-text-3">Quyền</span>
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as McpAgentRole)}
                  className="px-3 py-2 rounded-lg border border-border bg-surface text-[12.5px] text-text-1 focus:outline-none focus:border-verity/50"
                >
                  {(Object.keys(ROLE_LABEL) as McpAgentRole[]).map((role) => (
                    <option key={role} value={role}>{ROLE_LABEL[role]}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold text-text-3">Hạn dùng</span>
                <select
                  value={newExpiry}
                  onChange={(e) => setNewExpiry(e.target.value)}
                  className="px-3 py-2 rounded-lg border border-border bg-surface text-[12.5px] text-text-1 focus:outline-none focus:border-verity/50"
                >
                  {EXPIRY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            </div>
            <div className="text-[11.5px] text-text-3">
              Key này gọi được {toolsForRole(newRole).length}/13 tool: {toolsForRole(newRole).map((tool) => tool.name).join(', ')}.
            </div>
            <div className="flex items-center gap-2 justify-end">
              <button type="button" onClick={() => setShowAddForm(false)} className="px-3 py-1.5 rounded-lg border border-border text-[12px] text-text-2 hover:text-text-1 hover:bg-hover">
                Huỷ
              </button>
              <button type="submit" disabled={adding} className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-verity text-white text-[12px] font-semibold hover:bg-verity/90 disabled:opacity-60">
                {adding && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Tạo key
              </button>
            </div>
          </form>
        )}

        {loadingAgents && agents.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-8 text-text-3">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-[12.5px]">Đang tải danh sách key…</span>
          </div>
        ) : agentError ? (
          <div className="flex items-start gap-2 p-3 rounded-xl border border-red-200/50 bg-red-50/30 text-[12.5px] text-red-600 dark:border-red-900/30 dark:bg-red-950/20 dark:text-red-400">
            <AlertCircle className="w-4 h-4 flex-none mt-0.5" />
            <span>{agentError}</span>
          </div>
        ) : agents.length === 0 ? (
          <div className="py-8 text-center text-[12.5px] text-text-3">Chưa có API key nào. Bấm &quot;Cấp API Key mới&quot; để kết nối agent đầu tiên.</div>
        ) : (
          <div className="space-y-2">
            {agents.map((agent) => (
              <div
                key={agent.id}
                className={cn(
                  'flex flex-col gap-3 px-4 py-3 rounded-xl border sm:flex-row sm:items-center sm:justify-between',
                  agent.status === 'active' ? 'border-border bg-surface-2/40' : 'border-border/50 bg-surface-2/20 opacity-60'
                )}
              >
                <div className="flex items-start gap-3 min-w-0">
                  <div className={cn('w-8 h-8 rounded-lg border flex items-center justify-center flex-none', agent.status === 'active' ? 'bg-surface border-border text-ai' : 'bg-surface-2 border-border text-text-3')}>
                    <Bot className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold text-text-1 truncate">{agent.name}</span>
                      <span className={cn('px-2 py-0.5 rounded-full text-[10.5px] font-semibold border', roleBadgeClass(agent.role))}>{agent.role}</span>
                      <span
                        className={cn(
                          'px-2 py-0.5 rounded-full text-[10px] font-semibold border',
                          agent.status === 'active'
                            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
                            : agent.status === 'expired'
                            ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30'
                            : 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20'
                        )}
                      >
                        {agent.status === 'active' ? 'Hoạt động' : agent.status === 'expired' ? 'Hết hạn' : 'Đã thu hồi'}
                      </span>
                      {agent.rotatedFromId && <span className="text-[10.5px] text-text-3">(đã xoay)</span>}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-text-3">
                      <span className="font-mono">{agent.email}</span>
                      <span>•</span>
                      <span className="font-mono text-ai">{agent.keyPrefix}</span>
                      <span>•</span>
                      <span>Dùng gần nhất: {relativeTime(agent.lastUsedAt)}</span>
                      <span>•</span>
                      <span>{agent.calls24h} lượt gọi tool/24h</span>
                      <span>•</span>
                      <span>Hết hạn: {agent.expiresAt ? formatDateTime(agent.expiresAt) : 'không giới hạn'}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-none">
                  <button
                    type="button"
                    onClick={() => { setActivityKey(agent.id); setActivityStatus(''); document.getElementById('mcp-activity')?.scrollIntoView({ behavior: 'smooth' }); }}
                    className="px-2.5 py-1 rounded-lg border border-border text-[11px] font-medium text-text-2 hover:text-text-1 hover:bg-hover flex items-center gap-1"
                  >
                    <Activity className="w-3 h-3" />
                    Nhật ký
                  </button>
                  {agent.status === 'active' && (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleRotate(agent)}
                        disabled={busyKeyId === agent.id}
                        className="px-2.5 py-1 rounded-lg border border-border text-[11px] font-medium text-text-2 hover:text-text-1 hover:bg-hover flex items-center gap-1 disabled:opacity-50"
                        title="Tạo key mới, thu hồi key cũ"
                      >
                        <RotateCw className="w-3 h-3" />
                        Xoay key
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleRevoke(agent)}
                        disabled={busyKeyId === agent.id}
                        className="px-2.5 py-1 rounded-lg border border-red-200 dark:border-red-900/40 text-red-600 dark:text-red-400 text-[11px] font-medium hover:bg-red-50 dark:hover:bg-red-950/30 flex items-center gap-1 disabled:opacity-50"
                      >
                        {busyKeyId === agent.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                        Thu hồi
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── 3. One-time secret modal (with ready-to-paste configs) ── */}
      {secret && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs" role="dialog" aria-modal="true" aria-label="API key mới">
          <div className="w-full max-w-2xl max-h-[92dvh] overflow-y-auto p-6 rounded-2xl bg-surface border border-border shadow-2xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center flex-none text-emerald-500">
                <Key className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[15px] font-bold text-text-1">{secret.rotated ? 'Đã xoay key' : 'Đã tạo API key'}</div>
                <div className="text-[12px] text-text-3 mt-0.5">
                  {secret.name} ({secret.email}) · quyền <strong className="text-text-1">{secret.role}</strong>
                  {secret.rotated ? ' · key cũ đã bị thu hồi' : ''}
                </div>
              </div>
              <button type="button" onClick={() => setSecret(null)} className="p-1 rounded-lg text-text-3 hover:text-text-1 hover:bg-hover" aria-label="Đóng">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 flex items-start gap-2.5 text-[12px] text-amber-800 dark:text-amber-200">
              <AlertTriangle className="w-4 h-4 flex-none mt-0.5" />
              <p className="leading-relaxed">Key chỉ hiển thị lần này. Hệ thống chỉ lưu bản băm SHA-256 nên không thể xem lại sau khi bạn rời trang.</p>
            </div>

            <div className="flex items-center gap-2 p-3 rounded-xl bg-surface-2 border border-border font-mono text-[12px] text-text-1 break-all">
              <span className="flex-1 select-all">{secret.rawKey}</span>
              <CopyButton text={secret.rawKey} label="Sao chép key" />
            </div>

            <div className="space-y-2">
              <div className="text-[12.5px] font-bold text-text-1">Cấu hình đã điền sẵn key</div>
              <ConfigBlock configs={mcpClientConfigs(endpoint, secret.rawKey)} compact />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11.5px] text-text-3">Cài 1 click:</span>
              <a href={mcpInstallLinks(endpoint, secret.rawKey).cursor} className="px-3 py-1.5 rounded-lg border border-border bg-surface-2 text-[12px] font-semibold text-text-1 hover:bg-hover">
                Cài vào Cursor
              </a>
              <a href={mcpInstallLinks(endpoint, secret.rawKey).vscode} className="px-3 py-1.5 rounded-lg border border-border bg-surface-2 text-[12px] font-semibold text-text-1 hover:bg-hover">
                Cài vào VS Code
              </a>
            </div>

            <div className="pt-1 flex justify-end">
              <button type="button" onClick={() => setSecret(null)} className="px-4 py-2 rounded-xl bg-verity text-white text-[12.5px] font-semibold hover:bg-verity/90">
                Tôi đã lưu key
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 4a. OAuth connect (no API key) ── */}
      <div className="p-5 rounded-2xl border border-verity-border bg-surface shadow-xs space-y-4">
        <SectionHeader
          icon={LogIn}
          iconClass="bg-verity-soft border-verity-border text-verity-fg"
          title="Kết nối bằng đăng nhập (OAuth) · khuyên dùng"
          subtitle="Chỉ cần URL. Người dùng đăng nhập VerityDAM và bấm Cho phép; agent dùng đúng vai trò của người đó, token tự hết hạn sau 1 giờ."
        />
        <ConfigBlock configs={oauthConfigs} />
      </div>

      {/* ── 4b. Client configs (API key) ── */}
      <div className="p-5 rounded-2xl border border-border bg-surface shadow-xs space-y-4">
        <SectionHeader
          icon={Copy}
          iconClass="bg-teal-500/10 border-teal-500/20 text-teal-600 dark:text-teal-400"
          title="Kết nối bằng API key"
          subtitle="Cho agent chạy tự động không có người đăng nhập (Agenthub, Dify, cron). Tạo hoặc xoay key ở trên để điền token thật."
        />
        <div
          className={cn(
            'flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl border text-[11.5px]',
            sessionToken ? 'border-ok-border bg-ok-soft text-ok' : 'border-border bg-surface-2/60 text-text-3'
          )}
        >
          <span>
            {sessionToken
              ? `Đang điền key vừa tạo cho "${sessionToken.name}" (chỉ trong lần xem trang này).`
              : `Đang dùng chỗ trống ${MCP_TOKEN_PLACEHOLDER}. Thay bằng key của bạn.`}
          </span>
          {sessionToken && (
            <button type="button" onClick={() => setSessionToken(null)} className="font-semibold underline">
              Ẩn key
            </button>
          )}
        </div>
        <ConfigBlock configs={mcpClientConfigs(endpoint, sessionToken?.rawKey ?? MCP_TOKEN_PLACEHOLDER)} />
      </div>

      {/* ── 5. Tools ── */}
      <div className="p-5 rounded-2xl border border-border bg-surface shadow-xs space-y-4">
        <button type="button" onClick={() => setToolsExpanded((v) => !v)} className="w-full flex items-center justify-between gap-3">
          <SectionHeader
            icon={Wrench}
            iconClass="bg-surface-2 border-border text-text-2"
            title={`${tools.length || 13} công cụ MCP`}
            subtitle={`Quyền tối thiểu, đọc/ghi, lượt gọi 7 ngày. Đang tắt: ${tools.filter((tool) => !tool.enabled).length}.`}
          />
          {toolsExpanded ? <ChevronUp className="w-4 h-4 text-text-3 flex-none" /> : <ChevronDown className="w-4 h-4 text-text-3 flex-none" />}
        </button>

        {toolsExpanded && (
          <div className="space-y-2">
            {tools.map((tool) => (
              <div
                key={tool.name}
                className={cn('flex flex-col gap-2 px-4 py-3 rounded-xl border sm:flex-row sm:items-center sm:justify-between', tool.enabled ? 'border-border bg-surface-2/40' : 'border-border/60 bg-surface-2/10 opacity-70')}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12.5px] font-mono font-semibold text-text-1">{tool.name}</span>
                    <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-semibold border', tool.access === 'write' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30' : 'bg-surface text-text-3 border-border')}>
                      {tool.access === 'write' ? 'GHI' : 'ĐỌC'}
                    </span>
                    <span className={cn('px-2 py-0.5 rounded-full text-[10.5px] font-semibold border', roleBadgeClass(tool.minRole))}>≥ {tool.minRole}</span>
                  </div>
                  <div className="text-[11.5px] text-text-3 mt-0.5">{tool.title}: {tool.desc}</div>
                </div>
                <div className="flex items-center gap-3 flex-none">
                  <span className="text-[11px] text-text-3 font-mono">{tool.calls7d} lượt/7 ngày</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={tool.enabled}
                    aria-label={`${tool.enabled ? 'Tắt' : 'Bật'} ${tool.name}`}
                    disabled={togglingTool === tool.name}
                    onClick={() => void handleToggleTool(tool)}
                    className={cn('relative w-9 h-5 rounded-full transition-colors disabled:opacity-50', tool.enabled ? 'bg-verity' : 'bg-border-strong')}
                  >
                    <span className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all', tool.enabled ? 'left-[18px]' : 'left-0.5')} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── 6. Activity log ── */}
      <div id="mcp-activity" className="p-5 rounded-2xl border border-border bg-surface shadow-xs space-y-4">
        <SectionHeader
          icon={Activity}
          iconClass="bg-blue-500/10 border-blue-500/20 text-blue-600 dark:text-blue-400"
          title="Nhật ký gọi MCP"
          subtitle="Mỗi lần gọi tool: agent, tool, kết quả, thời gian xử lý."
          actions={
            <button
              type="button"
              onClick={() => void fetchActivity()}
              disabled={loadingActivity}
              className="w-7 h-7 rounded-lg border border-border bg-surface-2 flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-hover"
              aria-label="Tải lại nhật ký"
            >
              <RefreshCw className={cn('w-3.5 h-3.5', loadingActivity && 'animate-spin')} />
            </button>
          }
        />

        <div className="grid grid-cols-3 gap-2 text-[11.5px]">
          {[
            ['Lượt gọi 24h', summary ? String(summary.total) : '—'],
            ['Lỗi / bị từ chối 24h', summary ? String(summary.errors) : '—'],
            ['Thời gian xử lý trung vị', summary?.p50 != null ? `${summary.p50} ms` : '—'],
          ].map(([label, value]) => (
            <div key={label} className="p-2.5 rounded-xl border border-border bg-surface-2/40">
              <div className="text-text-3">{label}</div>
              <div className="mt-0.5 font-semibold text-text-1 font-mono">{value}</div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select value={activityKey} onChange={(e) => setActivityKey(e.target.value)} aria-label="Lọc theo key" className="px-2.5 py-1.5 rounded-lg border border-border bg-surface text-[12px] text-text-1">
            <option value="">Tất cả key</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} ({agent.keyPrefix})</option>)}
          </select>
          <select value={activityStatus} onChange={(e) => setActivityStatus(e.target.value)} aria-label="Lọc theo kết quả" className="px-2.5 py-1.5 rounded-lg border border-border bg-surface text-[12px] text-text-1">
            <option value="">Mọi kết quả</option>
            <option value="success">Thành công</option>
            <option value="error">Lỗi / bị từ chối</option>
          </select>
        </div>

        {activity.length === 0 ? (
          <div className="py-6 text-center text-[12.5px] text-text-3">{loadingActivity ? 'Đang tải…' : 'Chưa có lượt gọi nào khớp bộ lọc.'}</div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[640px] text-[12px]">
              <thead className="bg-surface-2/60 text-text-3 text-left">
                <tr>
                  <th className="px-3 py-2 font-semibold">Thời gian</th>
                  <th className="px-3 py-2 font-semibold">Agent</th>
                  <th className="px-3 py-2 font-semibold">Tool</th>
                  <th className="px-3 py-2 font-semibold">Kết quả</th>
                  <th className="px-3 py-2 font-semibold text-right">ms</th>
                </tr>
              </thead>
              <tbody>
                {activity.map((row) => (
                  <tr key={row.id} className="border-t border-border align-top">
                    <td className="px-3 py-2 whitespace-nowrap text-text-2">{formatDateTime(row.createdAt)}</td>
                    <td className="px-3 py-2 text-text-1">
                      {row.keyName ?? row.agentEmail ?? '—'}
                      {row.keyPrefix && <div className="font-mono text-[10.5px] text-text-3">{row.keyPrefix}</div>}
                    </td>
                    <td className="px-3 py-2 font-mono text-text-1">{row.toolName}</td>
                    <td className="px-3 py-2">
                      {row.status === 'success' ? (
                        <span className="text-ok font-semibold">Thành công</span>
                      ) : (
                        <span className="text-red-600 dark:text-red-400">
                          <span className="font-semibold">Lỗi</span>
                          {row.errorMessage && <div className="text-[11px] text-text-3 max-w-[340px] break-words">{row.errorMessage.slice(0, 200)}</div>}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-text-2">{row.durationMs ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-text-3">Request bị chặn trước khi gọi tool (401 sai/hết hạn key, 429 vượt giới hạn) không nằm trong bảng này.</p>
      </div>

      {/* ── 7. Quickstart prompts ── */}
      <div className="p-5 rounded-2xl border border-border bg-surface shadow-xs space-y-3">
        <SectionHeader
          icon={MessageSquareText}
          iconClass="bg-purple-500/10 border-purple-500/20 text-purple-600 dark:text-purple-400"
          title="Thử ngay sau khi kết nối"
          subtitle="Prompt mẫu để kiểm tra agent đã gọi được tool."
        />
        <div className="space-y-2">
          {MCP_SAMPLE_PROMPTS.map((prompt) => (
            <div key={prompt.text} className="flex items-start justify-between gap-3 px-4 py-3 rounded-xl border border-border bg-surface-2/40">
              <div className="min-w-0">
                <span className={cn('px-2 py-0.5 rounded-full text-[10px] font-semibold border', roleBadgeClass(prompt.role))}>cần ≥ {prompt.role}</span>
                <p className="mt-1.5 text-[12.5px] text-text-1 leading-relaxed">{prompt.text}</p>
              </div>
              <CopyButton text={prompt.text} />
            </div>
          ))}
        </div>
      </div>

      {/* ── 8. Security note (only what the server actually enforces) ── */}
      <div className="p-4 rounded-xl border border-border bg-surface-2/60 flex items-start gap-3 text-[12px]">
        <Shield className="w-4 h-4 text-verity flex-none mt-0.5" />
        <ul className="text-text-3 leading-relaxed list-disc pl-4 space-y-0.5">
          <li>Mọi request phải có <code className="font-mono text-text-2">Authorization: Bearer</code> với API key (server chỉ lưu bản băm SHA-256) hoặc OAuth access token (JWT ký EdDSA, đúng issuer và audience là URL MCP này).</li>
          <li>OAuth: client tự đăng ký nhưng chỉ nhận token sau khi người dùng đăng nhập và đồng ý; vai trò được đọc lại từ tài khoản ở mỗi request.</li>
          <li>Token thiếu, sai, đã thu hồi hoặc hết hạn: <strong className="text-text-2">401</strong>. Vượt giới hạn request/phút của key hoặc người dùng OAuth: <strong className="text-text-2">429</strong> kèm Retry-After.</li>
          <li>Trước mỗi lần gọi tool, server kiểm tra quyền tối thiểu của tool và công tắc bật/tắt; thao tác ghi còn được kiểm tra lại ở tầng dữ liệu.</li>
          <li>Mỗi lần gọi tool được ghi vào nhật ký kèm key đã dùng; tham số nhạy cảm và ảnh base64 được che hoặc rút gọn trước khi lưu.</li>
        </ul>
      </div>
    </div>
  );
}
