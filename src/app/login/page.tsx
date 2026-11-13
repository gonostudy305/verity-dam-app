'use client';

import React, { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Lock,
  Mail,
  Eye,
  EyeOff,
  ArrowRight,
  ShieldCheck,
  Film,
  Camera,
  Layers,
  AlertCircle,
  Loader2,
  CheckCircle2,
  Image as ImageIcon,
  ScanSearch,
  UsersRound,
} from 'lucide-react';
import { apiRequest } from '@/lib/client/api';
import { oauthAuthorizeResumeUrl } from '@/lib/mcp-oauth';
import { useToast } from '@/components/common/Toast';

type TestAccount = {
  key: string;
  role: 'viewer' | 'contributor' | 'reviewer' | 'admin';
  label: string;
  description: string;
  email: string;
  name: string;
};

const roleStyles: Record<TestAccount['role'], string> = {
  viewer: 'border-border bg-surface text-text-2 hover:border-verity-border hover:bg-verity-soft',
  contributor: 'border-border bg-surface text-text-2 hover:border-verity-border hover:bg-verity-soft',
  reviewer: 'border-verity-border bg-verity-soft text-verity-fg hover:bg-verity-soft-hi',
  admin: 'border-gold-border bg-gold-soft text-gold-ink hover:bg-gold-soft/80',
};

const safeReturnUrl = (value: string | null): string => {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/library';
  return value;
};

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnUrl = safeReturnUrl(searchParams.get('returnUrl'));
  const { showToast } = useToast();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [testAccounts, setTestAccounts] = useState<TestAccount[]>([]);
  const [showTestAccounts, setShowTestAccounts] = useState(false);

  useEffect(() => {
    let active = true;
    void apiRequest<{ accounts: TestAccount[] }>('/api/auth/test-accounts')
      .then((data) => {
        if (active && Array.isArray(data.accounts)) {
          setTestAccounts(data.accounts);
        }
      })
      .catch(() => {
        // Disabled in production
      });
    return () => {
      active = false;
    };
  }, []);

  const handleLogin = async (e?: React.FormEvent, accountKey?: string) => {
    if (e) e.preventDefault();
    setIsLoading(true);
    setErrorMsg(null);

    try {
      if (accountKey) {
        await apiRequest('/api/auth/test-accounts/login', {
          method: 'POST',
          body: JSON.stringify({ key: accountKey }),
        });
      } else {
        await apiRequest('/api/auth/sign-in/email', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        });
      }

      showToast('Đăng nhập thành công', 'success');
      // Signed in during an MCP/OAuth authorization: resume it (full
      // navigation, the provider redirects to consent or the client).
      const resumeUrl = oauthAuthorizeResumeUrl(window.location.search);
      if (resumeUrl) {
        window.location.assign(resumeUrl);
        return;
      }
      router.replace(returnUrl);
      router.refresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Đăng nhập không thành công. Vui lòng kiểm tra lại thông tin.';
      setErrorMsg(msg);
      showToast(msg, 'warn');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-paper text-text-1">
      <div className="grid min-h-screen lg:grid-cols-[1.1fr,0.9fr]">
        <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-border bg-gradient-to-br from-surface via-surface-2 to-surface p-12 lg:flex">
          <div className="relative z-10 flex items-center gap-3">
            <div className="relative grid h-10 w-10 place-items-center rounded-xl bg-verity text-lg font-black text-white shadow-sm">
              V
              <span className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full bg-ok" />
            </div>
            <div>
              <p className="text-[15px] font-bold text-text-1">VerityDAM</p>
              <p className="text-xs text-text-3">Visual Asset Intelligence</p>
            </div>
          </div>

          <div className="relative z-10 max-w-xl py-12 xl:py-20">
            <span className="inline-flex items-center gap-2 rounded-full border border-verity-border bg-surface/80 px-3 py-1.5 text-[11px] font-semibold text-verity-fg shadow-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-ok" /> Không gian làm việc số
            </span>
            <h2 className="mt-6 max-w-lg text-4xl font-bold leading-[1.08] tracking-[-0.04em] text-text-1 xl:text-5xl">
              Tài sản thị giác tin cậy cho con người & AI.
            </h2>
            <p className="mt-5 max-w-lg text-[15px] leading-7 text-text-2">
              VerityDAM giúp đội ngũ và AI Agent tìm kiếm, kiểm chứng và xuất bản tài sản số với độ chính xác cao dựa trên dữ liệu đã xác thực.
            </p>

            <div className="mt-10 grid max-w-lg gap-3 sm:grid-cols-3">
              {[
                { icon: ImageIcon, label: 'Kho tài sản', value: 'Ảnh & video gốc' },
                { icon: ScanSearch, label: 'Zero Speculation', value: 'Tìm kiếm kiểm chứng' },
                { icon: UsersRound, label: 'Agentic Ready', value: 'MCP cho AI Agent' },
              ].map(({ icon: Icon, label, value }) => (
                <div key={label} className="rounded-2xl border border-border bg-surface/80 p-3.5 shadow-sm backdrop-blur-sm">
                  <Icon className="h-4 w-4 text-verity-fg" />
                  <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-3">{label}</p>
                  <p className="mt-1 text-[12px] font-semibold leading-5 text-text-1">{value}</p>
                </div>
              ))}
            </div>
          </div>

          <p className="relative z-10 text-[11px] text-text-3">VerityDAM Platform · Quản trị phân quyền theo vai trò</p>
        </aside>

        <main className="flex min-h-[100dvh] items-center justify-center p-4 sm:p-8 lg:p-12">
          <div className="w-full max-w-[460px]">
            <div className="mb-6 flex items-center gap-3 lg:hidden">
              <div className="relative grid h-10 w-10 place-items-center rounded-xl bg-verity text-lg font-black text-white shadow-sm">
                V
                <span className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full bg-ok" />
              </div>
              <div>
                <p className="text-[15px] font-bold text-text-1">VerityDAM</p>
                <p className="text-xs text-text-3">Visual Asset Intelligence</p>
              </div>
            </div>

            <div className="rounded-3xl border border-border bg-surface p-5 shadow-pop sm:p-8">
              <div className="mb-7">
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-verity-fg">AI-Native DAM</p>
                <h1 className="mt-2 text-2xl font-bold tracking-[-0.025em] text-text-1 sm:text-[28px]">Đăng nhập vào VerityDAM</h1>
                <p className="mt-2 text-[13px] leading-6 text-text-3">Sử dụng tài khoản email/mật khẩu được cấp cho bạn.</p>
              </div>

              {errorMsg && (
                <div id="login-error" role="alert" className="mb-5 flex items-start gap-2.5 rounded-xl border border-bad-border bg-bad-soft p-3 text-[12.5px] text-bad animate-pop">
                  <AlertCircle className="mt-0.5 h-4 w-4 flex-none" />
                  <span className="leading-snug">{errorMsg}</span>
                </div>
              )}

              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-text-2 mb-1.5">Email</label>
                  <div className="relative">
                    <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-text-3" />
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="ten@congty.com"
                      className="w-full h-11 pl-10 pr-4 rounded-xl border border-border bg-surface-inset text-sm text-text-1 outline-none transition focus:border-verity focus:ring-2 focus:ring-verity/20"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-text-2 mb-1.5">Mật khẩu</label>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-text-3" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full h-11 pl-10 pr-11 rounded-xl border border-border bg-surface-inset text-sm text-text-1 outline-none transition focus:border-verity focus:ring-2 focus:ring-verity/20"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-text-3 hover:text-text-1"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-verity px-4 text-[13.5px] font-bold text-white shadow-sm transition hover:bg-verity-hover active:bg-verity-press disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-verity"
                >
                  {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <><span>Đăng nhập</span><ArrowRight className="h-4 w-4" /></>}
                </button>
              </form>

              {testAccounts.length > 0 && (
                <div className="mt-6 border-t border-border-subtle pt-5">
                  <button
                    type="button"
                    onClick={() => setShowTestAccounts(!showTestAccounts)}
                    className="flex min-h-11 w-full items-center justify-between rounded-xl border border-border bg-surface-2 px-3.5 text-left text-[12px] font-semibold text-text-2 transition hover:bg-hover"
                  >
                    <span className="flex items-center gap-2">
                      <UsersRound className="h-4 w-4 text-verity-fg" /> Tài khoản kiểm thử
                    </span>
                    <span className="text-text-3">{showTestAccounts ? 'Thu gọn' : 'Mở danh sách'}</span>
                  </button>
                  {showTestAccounts && (
                    <div className="mt-2 grid gap-2">
                      {testAccounts.map((account) => (
                        <button
                          key={account.key}
                          type="button"
                          disabled={isLoading}
                          onClick={() => void handleLogin(undefined, account.key)}
                          className={`flex min-h-12 items-center justify-between gap-3 rounded-xl border px-3 text-left transition disabled:opacity-60 ${roleStyles[account.role]}`}
                        >
                          <span className="min-w-0">
                            <span className="block text-[12px] font-bold">{account.label}</span>
                            <span className="block truncate text-[11px] opacity-80">{account.email}</span>
                          </span>
                          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4 flex-none opacity-70" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="mt-6 grid grid-cols-3 gap-2 border-t border-border-subtle pt-5 text-center text-[10.5px] text-text-3">
                <span className="flex flex-col items-center gap-1.5"><Camera className="h-4 w-4 text-verity-fg" />Kho ảnh gốc</span>
                <span className="flex flex-col items-center gap-1.5"><Film className="h-4 w-4 text-ai" />Video & media</span>
                <span className="flex flex-col items-center gap-1.5"><Layers className="h-4 w-4 text-gold" />AI metadata</span>
              </div>
            </div>

            <div className="mt-5 flex items-center justify-center gap-2 text-center text-[11px] text-text-3">
              <ShieldCheck className="h-4 w-4 text-ok" />
              <span>Phân quyền theo vai trò · Better Auth + PostgreSQL</span>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen w-full items-center justify-center bg-paper text-text-3">
          <Loader2 className="h-6 w-6 animate-spin text-verity" />
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
