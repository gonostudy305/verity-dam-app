'use client';

import React, { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertCircle, Bot, Check, Loader2, ShieldCheck, X } from 'lucide-react';

import { apiRequest } from '@/lib/client/api';
import { toolsForRole, type McpAgentRole } from '@/lib/mcp-catalog';
import { describeScopes, safeRedirect, signedOAuthQuery } from '@/lib/mcp-oauth';

type PublicClient = { client_id: string; client_name?: string; client_uri?: string; logo_uri?: string };
type SessionInfo = { authenticated: boolean; user: { email: string; role: string } | null };

function agentRole(role: string | undefined): McpAgentRole {
  if (role === 'contributor' || role === 'reviewer') return role;
  if (role === 'admin') return 'reviewer';
  return 'viewer';
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function ConsentForm() {
  const searchParams = useSearchParams();
  const clientId = searchParams.get('client_id') ?? '';
  const scopes = useMemo(() => describeScopes(searchParams.get('scope')), [searchParams]);
  const redirectHost = hostOf(searchParams.get('redirect_uri'));

  const [client, setClient] = useState<PublicClient | null>(null);
  const [session, setSession] = useState<SessionInfo['user']>(null);
  const [busy, setBusy] = useState<'accept' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId) return;
    let active = true;
    void apiRequest<PublicClient>(`/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`)
      .then((data) => active && setClient(data))
      .catch(() => active && setError('Không tìm thấy ứng dụng yêu cầu truy cập.'));
    void apiRequest<SessionInfo>('/api/auth/session')
      .then((data) => active && setSession(data.user))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [clientId]);

  const role = agentRole(session?.role);
  const tools = toolsForRole(role);
  const writeTools = tools.filter((tool) => tool.access === 'write').length;
  const clientName = client?.client_name || clientId || 'Ứng dụng';

  const decide = async (accept: boolean) => {
    const oauthQuery = signedOAuthQuery(window.location.search);
    if (!oauthQuery) {
      setError('Liên kết uỷ quyền không hợp lệ hoặc đã hết hạn. Hãy kết nối lại từ ứng dụng AI.');
      return;
    }
    setBusy(accept ? 'accept' : 'deny');
    setError(null);
    try {
      const result = await apiRequest<{ redirect_uri?: string; url?: string }>('/api/auth/oauth2/consent', {
        method: 'POST',
        body: JSON.stringify({ accept, oauth_query: oauthQuery }),
      });
      const target = safeRedirect(result.redirect_uri ?? result.url);
      if (!target) throw new Error('Máy chủ không trả về địa chỉ chuyển hướng hợp lệ.');
      window.location.assign(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không xử lý được yêu cầu.');
      setBusy(null);
    }
  };

  if (!clientId) {
    return (
      <p className="flex items-center gap-2 text-[13px] text-bad">
        <AlertCircle className="h-4 w-4" /> Thiếu thông tin ứng dụng (client_id). Hãy bắt đầu kết nối từ ứng dụng AI.
      </p>
    );
  }

  return (
    <>
      <div className="flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center overflow-hidden rounded-xl border border-border bg-surface-2">
          {client?.logo_uri ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={client.logo_uri} alt="" className="h-full w-full object-cover" />
          ) : (
            <Bot className="h-5 w-5 text-verity-fg" />
          )}
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-verity-fg">Kết nối MCP</p>
          <h1 className="truncate text-xl font-bold tracking-[-0.02em] text-text-1">{clientName}</h1>
        </div>
      </div>

      <p className="mt-4 text-[13px] leading-6 text-text-2">
        <b>{clientName}</b> muốn truy cập VerityDAM thay mặt bạn
        {session?.email ? <> (<b>{session.email}</b>)</> : null}.
      </p>

      <div className="mt-4 rounded-2xl border border-border bg-surface-2 p-4">
        <p className="text-[12px] font-semibold text-text-1">Agent sẽ dùng quyền của bạn: {role}</p>
        <p className="mt-1 text-[12px] leading-5 text-text-3">
          {tools.length} công cụ MCP ({tools.length - writeTools} đọc, {writeTools} ghi). Mọi lệnh gọi đều được ghi vào nhật ký hoạt động.
        </p>
        {scopes.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {scopes.map((item) => (
              <li key={item.scope} className="flex items-start gap-2 text-[12px] text-text-2">
                <Check className="mt-0.5 h-3.5 w-3.5 flex-none text-ok" />
                {item.label}
              </li>
            ))}
          </ul>
        )}
      </div>

      {redirectHost && (
        <p className="mt-3 text-[11.5px] text-text-3">
          Sau khi cho phép, bạn sẽ được chuyển về <span className="font-mono text-text-2">{redirectHost}</span>.
        </p>
      )}

      {error && (
        <div role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-bad-border bg-bad-soft p-3 text-[12.5px] text-bad">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-none" />
          <span>{error}</span>
        </div>
      )}

      <div className="mt-6 grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void decide(false)}
          className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 text-[13px] font-semibold text-text-2 transition hover:bg-hover disabled:opacity-60"
        >
          {busy === 'deny' ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Từ chối
        </button>
        <button
          type="button"
          disabled={busy !== null || !client}
          onClick={() => void decide(true)}
          className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-verity px-4 text-[13px] font-bold text-white transition hover:bg-verity-hover disabled:opacity-60"
        >
          {busy === 'accept' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Cho phép
        </button>
      </div>

      <p className="mt-4 text-[11px] leading-5 text-text-3">
        Access token có hiệu lực 1 giờ. Quản trị viên có thể tắt từng công cụ (Cài đặt → MCP) hoặc đổi vai trò của bạn; thay đổi áp dụng ngay từ lệnh gọi tiếp theo.
      </p>
    </>
  );
}

export default function ConsentPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-paper p-4 text-text-1">
      <div className="w-full max-w-[460px] rounded-3xl border border-border bg-surface p-5 shadow-pop sm:p-8">
        <Suspense fallback={<Loader2 className="mx-auto h-6 w-6 animate-spin text-verity" />}>
          <ConsentForm />
        </Suspense>
      </div>
    </div>
  );
}
