"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  Eye,
  Images,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  Sparkles,
  Wand2,
} from "lucide-react";

type Provider = { configured: boolean; model: string };
type StudioConfig = {
  providers: { openai: Provider; gemini: Provider; configured: boolean };
  brands: Array<{
    profile_id: string;
    slug: string;
    display_name: string;
    version_id: string;
    version: number;
    config: Record<string, unknown>;
  }>;
  channels: Array<{
    profile_id: string;
    slug: string;
    display_name: string;
    version_id: string;
    version: number;
    config: Record<string, unknown>;
  }>;
  templates: Array<{
    template_id: string;
    slug: string;
    display_name: string;
    version_id: string;
    version: number;
    template_family: string;
    config: Record<string, unknown>;
    brand_version_id: string | null;
    channel_version_id: string | null;
    priority: number;
  }>;
  budgets: Array<{
    id: string;
    brand_profile_id: string;
    period_start: string;
    hard_cap_minor: string;
    currency: string;
    committed_minor: string;
  }>;
  readiness: {
    providers: boolean;
    brand: boolean;
    channel: boolean;
    template: boolean;
    budget: boolean;
    ready: boolean;
    generation: boolean;
  };
};

type CreativeRequest = {
  id: string;
  status: string;
  external_source: string;
  external_article_id: string | null;
  external_revision: string | null;
  created_at: string;
  total_slots: number;
  resolved_slots: number;
  awaiting_review_slots: number;
};

type Output = {
  id: string;
  candidate_index: number;
  creative_state: string;
  review_state: string;
  expires_at: string;
  media_asset_id: string | null;
  preview_url: string | null;
  dimensions: Record<string, unknown> | null;
};

type Generation = {
  id: string;
  attempt_no: number;
  provider: string;
  model: string;
  provider_call_state: string;
  retry_class: string | null;
  error_code: string | null;
  error_detail: string | null;
  job_status: string | null;
  outputs: Output[];
};

type Resolution = {
  id: string;
  source_kind: string;
  status: string;
  media_asset_id: string;
  generation_output_id: string | null;
  asset_review_state: string;
  asset_file_url: string | null;
};

type CreativeDetail = {
  id: string;
  status: string;
  external_source: string;
  external_article_id: string | null;
  external_revision: string | null;
  brand_name: string;
  brand_version: number;
  channel_name: string;
  channel_version: number;
  slots: Array<{
    id: string;
    slot_key: string;
    slot_kind: string;
    status: string;
    fidelity_mode: string;
    target_product_id: string | null;
    content_snapshot: Record<string, unknown>;
    template_name: string;
    template_version: number;
    generations: Generation[];
    resolutions: Resolution[];
  }>;
  budget_events: Array<{
    id: string;
    generation_id: string;
    reserved_minor: string;
    actual_minor: string | null;
    status: string;
    currency: string;
  }>;
};

type BootstrapForm = {
  brand_slug: string;
  brand_name: string;
  primary_color: string;
  brand_notes: string;
  channel_slug: string;
  channel_name: string;
  aspect_ratio: string;
  provider: "openai" | "gemini";
  model: string;
  fidelity_mode: "reference_generate" | "preserve_pixels";
  compositor_width: string;
  compositor_height: string;
  product_left: string;
  product_top: string;
  product_width: string;
  product_height: string;
  currency: string;
  hard_cap_minor: string;
  period_start: string;
  thumbnail_prompt: string;
  thumbnail_cost: string;
  section_prompt: string;
  section_cost: string;
};

type JobForm = {
  external_source: string;
  external_article_id: string;
  external_revision: string;
  supersedes_revision: string;
  brand_version_id: string;
  channel_version_id: string;
  budget_period_id: string;
  thumbnail_template_version_id: string;
  section_template_version_id: string;
  title: string;
  body: string;
  product_id: string;
  section_headings: string;
};

const statusLabel: Record<string, string> = {
  planning: "Đang lập kế hoạch",
  generating: "Đang tạo",
  candidate_ready: "Có candidate",
  awaiting_review: "Chờ DAM duyệt",
  resolved: "Sẵn sàng xuất bản",
  superseded_for_placement: "Đã thay revision",
  failed: "Cần xử lý",
  cancelled: "Đã hủy",
  candidate: "Candidate",
  promoted: "Đã gửi duyệt",
  expired: "Đã hết hạn",
  proposed: "Đề xuất chờ duyệt",
  active: "Đang dùng",
  superseded: "Đã thay thế",
  dismissed: "Đã bỏ",
  queued: "Đã xếp hàng",
  executing: "Đang gọi provider",
  succeeded: "Hoàn thành",
  blocked: "Bị chặn",
  pending: "Chờ duyệt",
  approved: "Đã duyệt",
  rejected: "Từ chối",
  held_unknown: "Cần đối soát chi phí",
};

function localDate(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function monthStart(): string {
  return `${localDate().slice(0, 7)}-01`;
}

function newJobForm(): JobForm {
  const stamp = Date.now().toString(36);
  return {
    external_source: "studio-manual-v1",
    external_article_id: `article-${stamp}`,
    external_revision: "r1",
    supersedes_revision: "",
    brand_version_id: "",
    channel_version_id: "",
    budget_period_id: "",
    thumbnail_template_version_id: "",
    section_template_version_id: "",
    title: "",
    body: "",
    product_id: "",
    section_headings: "",
  };
}

function newBootstrapForm(): BootstrapForm {
  return {
    brand_slug: "verity",
    brand_name: "Verity",
    primary_color: "#1557A0",
    brand_notes: "",
    channel_slug: "article-web",
    channel_name: "Article web",
    aspect_ratio: "16:9",
    provider: "openai",
    model: "",
    fidelity_mode: "reference_generate",
    compositor_width: "1536",
    compositor_height: "1024",
    product_left: "400",
    product_top: "132",
    product_width: "736",
    product_height: "760",
    currency: "USD",
    hard_cap_minor: "1000",
    period_start: monthStart(),
    thumbnail_prompt:
      "Create a polished editorial hero image for the article. Use a clear focal point, premium composition, and leave clean negative space for an optional headline. No text, logo, or watermark.",
    thumbnail_cost: "25",
    section_prompt:
      "Create an editorial supporting image for this article section. Make the visual meaningfully distinct from the hero image while staying within the approved brand direction. No text, logo, or watermark.",
    section_cost: "20",
  };
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(payload?.error?.message || "Không thể xử lý yêu cầu.");
  return payload as T;
}

export default function StudioPage() {
  const [configuration, setConfiguration] = useState<StudioConfig | null>(null);
  const [requests, setRequests] = useState<CreativeRequest[]>([]);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(
    null,
  );
  const [detail, setDetail] = useState<CreativeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshingDetail, setRefreshingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showJobForm, setShowJobForm] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [bootstrapForm, setBootstrapForm] =
    useState<BootstrapForm>(newBootstrapForm);
  const [jobForm, setJobForm] = useState<JobForm>(newJobForm);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [configResponse, requestsResponse] = await Promise.all([
        requestJson<{ data: StudioConfig }>("/api/creative/configuration"),
        requestJson<{ data: CreativeRequest[] }>(
          "/api/creative/requests?limit=25",
        ),
      ]);
      setConfiguration(configResponse.data);
      setRequests(
        Array.isArray(requestsResponse.data) ? requestsResponse.data : [],
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Không thể tải AI Creative Studio.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshDetail = useCallback(async (id: string, quiet = false) => {
    if (!quiet) setRefreshingDetail(true);
    try {
      const response = await requestJson<{ data: CreativeDetail }>(
        `/api/creative/requests/${id}`,
      );
      setDetail(response.data);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Không thể tải chi tiết creative job.",
      );
    } finally {
      if (!quiet) setRefreshingDetail(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!selectedRequestId) {
      setDetail(null);
      return;
    }
    void refreshDetail(selectedRequestId);
    const timer = window.setInterval(() => {
      void refreshDetail(selectedRequestId, true);
    }, 6_000);
    return () => window.clearInterval(timer);
  }, [selectedRequestId, refreshDetail]);

  useEffect(() => {
    if (!configuration) return;
    setBootstrapForm((previous) => {
      const preferred: "openai" | "gemini" = configuration.providers.openai
        .configured
        ? "openai"
        : "gemini";
      return previous.model
        ? previous
        : {
            ...previous,
            provider: preferred,
            model: configuration.providers[preferred].model,
          };
    });
    setJobForm((previous) => ({
      ...previous,
      brand_version_id:
        previous.brand_version_id || configuration.brands[0]?.version_id || "",
      channel_version_id:
        previous.channel_version_id ||
        configuration.channels[0]?.version_id ||
        "",
    }));
  }, [configuration]);

  const selectedBrand = useMemo(
    () =>
      configuration?.brands.find(
        (item) => item.version_id === jobForm.brand_version_id,
      ) || null,
    [configuration, jobForm.brand_version_id],
  );
  const matchingTemplates = useMemo(
    () =>
      (configuration?.templates || []).filter(
        (item) =>
          item.brand_version_id === jobForm.brand_version_id &&
          item.channel_version_id === jobForm.channel_version_id,
      ),
    [configuration, jobForm.brand_version_id, jobForm.channel_version_id],
  );
  const thumbnailTemplates = useMemo(
    () =>
      matchingTemplates.filter(
        (item) => item.template_family === "article-thumbnail",
      ),
    [matchingTemplates],
  );
  const sectionTemplates = useMemo(
    () =>
      matchingTemplates.filter(
        (item) => item.template_family === "article-section",
      ),
    [matchingTemplates],
  );
  const matchingBudget = useMemo(
    () =>
      (configuration?.budgets || []).filter(
        (item) => item.brand_profile_id === selectedBrand?.profile_id,
      ),
    [configuration, selectedBrand],
  );

  useEffect(() => {
    setJobForm((previous) => ({
      ...previous,
      thumbnail_template_version_id: thumbnailTemplates.some(
        (item) => item.version_id === previous.thumbnail_template_version_id,
      )
        ? previous.thumbnail_template_version_id
        : thumbnailTemplates[0]?.version_id || "",
      section_template_version_id: sectionTemplates.some(
        (item) => item.version_id === previous.section_template_version_id,
      )
        ? previous.section_template_version_id
        : sectionTemplates[0]?.version_id ||
          thumbnailTemplates[0]?.version_id ||
          "",
      budget_period_id: matchingBudget.some(
        (item) => item.id === previous.budget_period_id,
      )
        ? previous.budget_period_id
        : matchingBudget[0]?.id || "",
    }));
  }, [thumbnailTemplates, sectionTemplates, matchingBudget]);

  const awaiting = requests.reduce(
    (total, item) => total + item.awaiting_review_slots,
    0,
  );
  const resolved = requests.reduce(
    (total, item) => total + item.resolved_slots,
    0,
  );

  const submitBootstrap = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const fidelityConfig = {
        fidelity_mode: bootstrapForm.fidelity_mode,
        ...(bootstrapForm.fidelity_mode === "preserve_pixels"
          ? {
              compositor: {
                width: Number(bootstrapForm.compositor_width),
                height: Number(bootstrapForm.compositor_height),
                product_box: {
                  left: Number(bootstrapForm.product_left),
                  top: Number(bootstrapForm.product_top),
                  width: Number(bootstrapForm.product_width),
                  height: Number(bootstrapForm.product_height),
                },
              },
            }
          : {}),
      };
      await requestJson("/api/creative/configuration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "bootstrap",
          ...bootstrapForm,
          thumbnail: {
            prompt: bootstrapForm.thumbnail_prompt,
            reserved_minor: Number(bootstrapForm.thumbnail_cost),
            currency: bootstrapForm.currency,
            size: "1536x1024",
            ...fidelityConfig,
          },
          section: {
            prompt: bootstrapForm.section_prompt,
            reserved_minor: Number(bootstrapForm.section_cost),
            currency: bootstrapForm.currency,
            size: "1536x1024",
            ...fidelityConfig,
          },
          hard_cap_minor: Number(bootstrapForm.hard_cap_minor),
          soft_alert_percent: 70,
        }),
      });
      setNotice(
        "Đã tạo brand/channel/template versions và budget. Bạn có thể tạo creative job ngay.",
      );
      setShowSetup(false);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Không thể khởi tạo cấu hình.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const submitJob = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const headings = jobForm.section_headings
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 3);
      const response = await requestJson<{
        data: { requestId: string; replayed: boolean };
      }>("/api/creative/requests", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          ...jobForm,
          supersedes_revision: jobForm.supersedes_revision || null,
          max_section_images: headings.length,
          sections: headings.map((heading, index) => ({
            id: `section-${index + 1}`,
            heading,
            body: jobForm.body,
            product_id: jobForm.product_id || null,
          })),
        }),
      });
      setNotice(
        response.data.replayed
          ? "Đã mở creative job đã tồn tại."
          : "Đã tạo job. Library được kiểm tra trước; các slot chưa resolve sẽ được queue cho worker.",
      );
      setShowJobForm(false);
      setJobForm(newJobForm());
      await refresh();
      setSelectedRequestId(response.data.requestId);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Không thể tạo creative job.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const promote = async (outputId: string) => {
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      await requestJson(`/api/creative/outputs/${outputId}/promote`, {
        method: "POST",
      });
      setNotice(
        "Candidate đã được đưa vào DAM Review. Kết quả duyệt sẽ tự đồng bộ về Slot Resolution.",
      );
      if (selectedRequestId) await refreshDetail(selectedRequestId);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Không thể promote candidate.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const retry = async (generationId: string) => {
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      await requestJson(`/api/creative/generations/${generationId}/retry`, {
        method: "POST",
      });
      setNotice("Đã tạo attempt mới. Attempt cũ vẫn giữ nguyên để audit.");
      if (selectedRequestId) await refreshDetail(selectedRequestId);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Không thể retry generation.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const openSetup = () => {
    setShowSetup(true);
    setShowJobForm(false);
    if (configuration?.brands.length) {
      const provider: "openai" | "gemini" = configuration.providers.openai
        .configured
        ? "openai"
        : "gemini";
      setBootstrapForm({
        ...newBootstrapForm(),
        provider,
        model: configuration.providers[provider].model,
        brand_slug: "",
        brand_name: "",
        channel_slug: "",
        channel_name: "",
        brand_notes: "",
      });
    }
  };

  return (
    <AppShell
      title="AI Creative Studio"
      subtitle="Brand version → candidate → DAM review → placement"
    >
      <div className="mx-auto w-full max-w-7xl space-y-5 p-3 sm:p-6">
        <section className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-base font-bold text-text-1">
              Vận hành ảnh AI có kiểm duyệt
            </h1>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-text-2">
              Studio tạo candidate; DAM quyết định asset; Slot Resolution quyết
              định ảnh dùng; consumer xác nhận publish. Provider key chỉ được
              quản lý trong Settings.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={openSetup}
              className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-xs font-semibold text-text-2 hover:bg-surface-2"
            >
              <Settings2 className="h-4 w-4" />{" "}
              {configuration?.brands.length
                ? "Thêm brand pipeline"
                : "Cấu hình pipeline"}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowJobForm((value) => !value);
                setShowSetup(false);
              }}
              disabled={!configuration?.readiness.ready}
              className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-ai px-3 text-xs font-bold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-4 w-4" /> Tạo creative job
            </button>
          </div>
        </section>
        <Readiness
          configuration={configuration}
          loading={loading}
          onOpenSetup={openSetup}
        />
        {notice && (
          <p
            role="status"
            className="rounded-xl border border-ok-border bg-ok-soft px-3 py-2 text-xs text-ok"
          >
            {notice}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
          >
            {error}
          </p>
        )}
        {showSetup && (
          <SetupForm
            form={bootstrapForm}
            setForm={setBootstrapForm}
            configuration={configuration}
            submitting={submitting}
            onSubmit={submitBootstrap}
          />
        )}
        {showJobForm && configuration?.readiness.ready && (
          <JobFormView
            form={jobForm}
            setForm={setJobForm}
            configuration={configuration}
            thumbnailTemplates={thumbnailTemplates}
            sectionTemplates={sectionTemplates}
            budgets={matchingBudget}
            submitting={submitting}
            onSubmit={submitJob}
          />
        )}
        <section className="grid gap-3 sm:grid-cols-3">
          <Metric
            icon={<Images className="h-5 w-5" />}
            label="Creative jobs"
            value={String(requests.length)}
          />
          <Metric
            icon={<Clock3 className="h-5 w-5" />}
            label="Slot chờ duyệt"
            value={String(awaiting)}
            tone="amber"
          />
          <Metric
            icon={<CheckCircle2 className="h-5 w-5" />}
            label="Slot đã resolve"
            value={String(resolved)}
            tone="green"
          />
        </section>
        <section className="rounded-2xl border border-border bg-surface shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
            <div>
              <h2 className="text-sm font-bold text-text-1">
                Creative job gần đây
              </h2>
              <p className="mt-0.5 text-xs text-text-2">
                Library-first trước, chỉ những slot chưa resolve mới gọi AI.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-semibold text-text-2 hover:bg-surface-2"
              disabled={loading}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
              />{" "}
              Làm mới
            </button>
          </div>
          <div className="divide-y divide-border">
            {loading && (
              <div className="p-8 text-center text-sm text-text-2">
                Đang tải creative jobs…
              </div>
            )}
            {!loading && !error && requests.length === 0 && (
              <div className="p-10 text-center">
                <div className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-ai-soft text-ai">
                  <Wand2 className="h-5 w-5" />
                </div>
                <p className="mt-3 text-sm font-semibold text-text-1">
                  Chưa có creative job
                </p>
                <p className="mt-1 text-xs text-text-2">
                  Hoàn tất readiness rồi tạo job đầu tiên trực tiếp tại đây.
                </p>
              </div>
            )}
            {!loading &&
              requests.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedRequestId(item.id)}
                  className={`flex w-full flex-col gap-2 px-4 py-3 text-left hover:bg-surface-2/60 sm:flex-row sm:items-center sm:justify-between sm:px-5 ${selectedRequestId === item.id ? "bg-ai-soft/35" : ""}`}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-text-1">
                      {item.external_article_id || item.id}
                    </p>
                    <p className="mt-0.5 text-xs text-text-2">
                      {item.external_source} ·{" "}
                      {item.external_revision || "không có revision"} ·{" "}
                      {new Date(item.created_at).toLocaleString("vi-VN")}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="rounded-full bg-surface-2 px-2 py-1 font-medium text-text-2">
                      {item.resolved_slots}/{item.total_slots} resolved
                    </span>
                    <StatusChip value={item.status} />
                  </div>
                </button>
              ))}
          </div>
        </section>
        {selectedRequestId && (
          <JobDetail
            detail={detail}
            refreshing={refreshingDetail}
            submitting={submitting}
            onPromote={promote}
            onRetry={retry}
          />
        )}
      </div>
    </AppShell>
  );
}

function Readiness({
  configuration,
  loading,
  onOpenSetup,
}: {
  configuration: StudioConfig | null;
  loading: boolean;
  onOpenSetup: () => void;
}) {
  const rows: Array<[string, boolean, string]> = [
    [
      "Provider tạo ảnh",
      configuration?.readiness.providers || false,
      configuration?.providers.configured
        ? "Ít nhất một provider đã sẵn sàng"
        : "Mở Settings → AI Creative để lưu provider key",
    ],
    [
      "Brand và channel version",
      Boolean(
        configuration?.readiness.brand && configuration?.readiness.channel,
      ),
      `${configuration?.brands.length || 0} brand · ${configuration?.channels.length || 0} channel published`,
    ],
    [
      "Template binding",
      configuration?.readiness.template || false,
      `${configuration?.templates.length || 0} template binding enabled`,
    ],
    [
      "Ngân sách",
      configuration?.readiness.budget || false,
      `${configuration?.budgets.length || 0} budget period`,
    ],
  ];
  return (
    <section className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-text-1">Creative readiness</h2>
          <p className="mt-0.5 text-xs text-text-2">
            Chỉ trạng thái cấu hình đã redacted — Studio không đọc hay hiển thị
            API key.
          </p>
        </div>
        <button
          type="button"
          onClick={onOpenSetup}
          className="text-xs font-semibold text-ai hover:underline"
        >
          {configuration?.readiness.ready
            ? "Thêm brand pipeline"
            : "Hoàn tất cấu hình"}
        </button>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map(([label, ready, description]) => (
          <div
            key={label}
            className="rounded-xl border border-border-subtle bg-surface-2/40 px-3 py-2"
          >
            <div className="flex items-center gap-1.5 text-xs font-semibold text-text-1">
              {ready ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-ok" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 text-warn" />
              )}
              {label}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-text-3">
              {loading ? "Đang kiểm tra…" : description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function SetupForm({
  form,
  setForm,
  configuration,
  submitting,
  onSubmit,
}: {
  form: BootstrapForm;
  setForm: React.Dispatch<React.SetStateAction<BootstrapForm>>;
  configuration: StudioConfig | null;
  submitting: boolean;
  onSubmit: (event: React.FormEvent) => void;
}) {
  const change = (field: keyof BootstrapForm, value: string) =>
    setForm((current) => ({ ...current, [field]: value }));
  const modelFor = (provider: "openai" | "gemini") =>
    configuration?.providers[provider].model || "";
  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-2xl border border-ai-border bg-surface p-4 shadow-sm sm:p-5"
    >
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 h-5 w-5 text-ai" />
        <div>
          <h2 className="text-sm font-bold text-text-1">
            Thiết lập brand guideline và template đầu tiên
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-text-2">
            Mỗi lần lưu tạo một version immutable. Provider key vẫn nằm ở{" "}
            <Link
              className="font-semibold text-ai hover:underline"
              href="/settings?section=ai-creative"
            >
              Settings → AI Creative
            </Link>
            .
          </p>
        </div>
      </div>
      {!configuration?.providers.configured && (
        <p className="rounded-lg border border-warn-border bg-warn-soft px-3 py-2 text-xs text-warn">
          Hãy lưu ít nhất một provider key trong Settings trước; hệ thống vẫn
          không queue generation nếu chưa có key.
        </p>
      )}
      <div className="grid gap-3 lg:grid-cols-3">
        <Field label="Brand slug">
          <input
            value={form.brand_slug}
            onChange={(e) => change("brand_slug", e.target.value)}
            required
          />
        </Field>
        <Field label="Tên brand">
          <input
            value={form.brand_name}
            onChange={(e) => change("brand_name", e.target.value)}
            required
          />
        </Field>
        <Field label="Màu chính">
          <input
            value={form.primary_color}
            onChange={(e) => change("primary_color", e.target.value)}
            required
          />
        </Field>
        <Field label="Channel slug">
          <input
            value={form.channel_slug}
            onChange={(e) => change("channel_slug", e.target.value)}
            required
          />
        </Field>
        <Field label="Tên channel">
          <input
            value={form.channel_name}
            onChange={(e) => change("channel_name", e.target.value)}
            required
          />
        </Field>
        <Field label="Tỷ lệ ảnh">
          <input
            value={form.aspect_ratio}
            onChange={(e) => change("aspect_ratio", e.target.value)}
            required
          />
        </Field>
      </div>
      <Field label="Ghi chú brand guideline">
        <textarea
          rows={2}
          value={form.brand_notes}
          onChange={(e) => change("brand_notes", e.target.value)}
          placeholder="Ví dụ: hình tinh gọn, công nghệ thân thiện, tông xanh chủ đạo…"
        />
      </Field>
      <div className="grid gap-3 lg:grid-cols-4">
        <Field label="Provider">
          <select
            value={form.provider}
            onChange={(e) => {
              const provider = e.target.value as "openai" | "gemini";
              setForm((current) => ({
                ...current,
                provider,
                model: modelFor(provider),
              }));
            }}
          >
            <option
              value="openai"
              disabled={!configuration?.providers.openai.configured}
            >
              OpenAI / compatible
            </option>
            <option
              value="gemini"
              disabled={!configuration?.providers.gemini.configured}
            >
              Gemini
            </option>
          </select>
        </Field>
        <Field label="Model đã pin trong Settings">
          <input value={form.model} readOnly required />
        </Field>
        <Field label="Ngân sách kỳ (minor unit)">
          <input
            type="number"
            min="0"
            value={form.hard_cap_minor}
            onChange={(e) => change("hard_cap_minor", e.target.value)}
            required
          />
        </Field>
        <Field label="Bắt đầu kỳ">
          <input
            type="date"
            value={form.period_start}
            onChange={(e) => change("period_start", e.target.value)}
            required
          />
        </Field>
      </div>
      <div className="rounded-xl border border-border bg-surface-2/30 p-3">
        <Field label="Product fidelity">
          <select
            value={form.fidelity_mode}
            onChange={(event) =>
              change(
                "fidelity_mode",
                event.target.value as BootstrapForm["fidelity_mode"],
              )
            }
          >
            <option value="reference_generate">
              Reference generate — model dùng ảnh sản phẩm thật đã duyệt
            </option>
            <option value="preserve_pixels">
              Preserve pixels — AI chỉ tạo nền, cutout thật được compositing
            </option>
          </select>
        </Field>
        {form.fidelity_mode === "preserve_pixels" && (
          <>
            <p className="mt-2 text-[11px] leading-relaxed text-text-3">
              Template này chỉ gọi model trước compositor. Mọi slot gắn SKU phải
              có approved real cutout; không có model call nào sau khi product
              pixels được ghép vào ảnh.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Canvas width">
                <input
                  type="number"
                  min="320"
                  max="4096"
                  value={form.compositor_width}
                  onChange={(event) =>
                    change("compositor_width", event.target.value)
                  }
                  required
                />
              </Field>
              <Field label="Canvas height">
                <input
                  type="number"
                  min="320"
                  max="4096"
                  value={form.compositor_height}
                  onChange={(event) =>
                    change("compositor_height", event.target.value)
                  }
                  required
                />
              </Field>
              <Field label="Product left">
                <input
                  type="number"
                  min="0"
                  value={form.product_left}
                  onChange={(event) =>
                    change("product_left", event.target.value)
                  }
                  required
                />
              </Field>
              <Field label="Product top">
                <input
                  type="number"
                  min="0"
                  value={form.product_top}
                  onChange={(event) =>
                    change("product_top", event.target.value)
                  }
                  required
                />
              </Field>
              <Field label="Product width">
                <input
                  type="number"
                  min="1"
                  value={form.product_width}
                  onChange={(event) =>
                    change("product_width", event.target.value)
                  }
                  required
                />
              </Field>
              <Field label="Product height">
                <input
                  type="number"
                  min="1"
                  value={form.product_height}
                  onChange={(event) =>
                    change("product_height", event.target.value)
                  }
                  required
                />
              </Field>
            </div>
          </>
        )}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-border p-3">
          <Field label="Prompt thumbnail">
            <textarea
              rows={4}
              value={form.thumbnail_prompt}
              onChange={(e) => change("thumbnail_prompt", e.target.value)}
              required
            />
          </Field>
          <Field label="Chi phí reserve / thumbnail">
            <input
              type="number"
              min="0"
              value={form.thumbnail_cost}
              onChange={(e) => change("thumbnail_cost", e.target.value)}
              required
            />
          </Field>
        </div>
        <div className="rounded-xl border border-border p-3">
          <Field label="Prompt section">
            <textarea
              rows={4}
              value={form.section_prompt}
              onChange={(e) => change("section_prompt", e.target.value)}
              required
            />
          </Field>
          <Field label="Chi phí reserve / section">
            <input
              type="number"
              min="0"
              value={form.section_cost}
              onChange={(e) => change("section_cost", e.target.value)}
              required
            />
          </Field>
        </div>
      </div>
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={submitting || !configuration?.providers.configured}
          className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-ai px-4 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Settings2 className="h-4 w-4" />
          )}{" "}
          Khởi tạo versioned pipeline
        </button>
      </div>
    </form>
  );
}

function JobFormView({
  form,
  setForm,
  configuration,
  thumbnailTemplates,
  sectionTemplates,
  budgets,
  submitting,
  onSubmit,
}: {
  form: JobForm;
  setForm: React.Dispatch<React.SetStateAction<JobForm>>;
  configuration: StudioConfig;
  thumbnailTemplates: StudioConfig["templates"];
  sectionTemplates: StudioConfig["templates"];
  budgets: StudioConfig["budgets"];
  submitting: boolean;
  onSubmit: (event: React.FormEvent) => void;
}) {
  const change = (field: keyof JobForm, value: string) =>
    setForm((current) => ({ ...current, [field]: value }));
  const requiresProduct = [
    thumbnailTemplates.find(
      (item) => item.version_id === form.thumbnail_template_version_id,
    ),
    sectionTemplates.find(
      (item) => item.version_id === form.section_template_version_id,
    ),
  ].some((template) => template?.config.fidelity_mode === "preserve_pixels");
  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-2xl border border-ai-border bg-surface p-4 shadow-sm sm:p-5"
    >
      <div className="flex items-start gap-2">
        <Plus className="mt-0.5 h-5 w-5 text-ai" />
        <div>
          <h2 className="text-sm font-bold text-text-1">Tạo creative job</h2>
          <p className="mt-1 text-xs text-text-2">
            Library-first sẽ resolve asset đã approved nếu đúng
            brand/product/channel và không nằm trong cooldown 14 ngày. Slot còn
            lại mới vào AI worker.
          </p>
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <Field label="Nguồn bài">
          <input
            value={form.external_source}
            onChange={(e) => change("external_source", e.target.value)}
            required
          />
        </Field>
        <Field label="Article ID">
          <input
            value={form.external_article_id}
            onChange={(e) => change("external_article_id", e.target.value)}
            required
          />
        </Field>
        <Field label="Revision">
          <input
            value={form.external_revision}
            onChange={(e) => change("external_revision", e.target.value)}
            required
          />
        </Field>
        <Field label="Supersedes revision (nếu có)">
          <input
            value={form.supersedes_revision}
            onChange={(e) => change("supersedes_revision", e.target.value)}
            placeholder="r1"
          />
        </Field>
        <Field label="Brand version">
          <select
            value={form.brand_version_id}
            onChange={(e) => change("brand_version_id", e.target.value)}
            required
          >
            {configuration.brands.map((item) => (
              <option key={item.version_id} value={item.version_id}>
                {item.display_name} · v{item.version}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Channel version">
          <select
            value={form.channel_version_id}
            onChange={(e) => change("channel_version_id", e.target.value)}
            required
          >
            {configuration.channels.map((item) => (
              <option key={item.version_id} value={item.version_id}>
                {item.display_name} · v{item.version}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <Field label="Template thumbnail">
          <select
            value={form.thumbnail_template_version_id}
            onChange={(e) =>
              change("thumbnail_template_version_id", e.target.value)
            }
            required
          >
            <option value="">Chọn template</option>
            {thumbnailTemplates.map((item) => (
              <option key={item.version_id} value={item.version_id}>
                {item.display_name} · v{item.version}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Template section">
          <select
            value={form.section_template_version_id}
            onChange={(e) =>
              change("section_template_version_id", e.target.value)
            }
            required
          >
            <option value="">Chọn template</option>
            {sectionTemplates.map((item) => (
              <option key={item.version_id} value={item.version_id}>
                {item.display_name} · v{item.version}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Budget period">
          <select
            value={form.budget_period_id}
            onChange={(e) => change("budget_period_id", e.target.value)}
            required
          >
            <option value="">Chọn budget</option>
            {budgets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.period_start} · {item.committed_minor}/
                {item.hard_cap_minor} {item.currency}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Tiêu đề bài">
        <input
          value={form.title}
          onChange={(e) => change("title", e.target.value)}
          required
        />
      </Field>
      <ProductSelector
        value={form.product_id}
        required={requiresProduct}
        onChange={(productId) => change("product_id", productId)}
      />
      <Field label="Nội dung bài (subject matter, không phải instruction)">
        <textarea
          rows={5}
          value={form.body}
          onChange={(e) => change("body", e.target.value)}
          placeholder="Nội dung được coi là untrusted context; brand/template constraints luôn ưu tiên."
        />
      </Field>
      <Field label="Heading section cần ảnh (mỗi dòng một heading, tối đa 3)">
        <textarea
          rows={3}
          value={form.section_headings}
          onChange={(e) => change("section_headings", e.target.value)}
          placeholder="Lợi ích nổi bật&#10;Cách sử dụng"
        />
      </Field>
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={
            submitting ||
            !form.thumbnail_template_version_id ||
            !form.section_template_version_id ||
            !form.budget_period_id ||
            (requiresProduct && !form.product_id)
          }
          className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-ai px-4 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Wand2 className="h-4 w-4" />
          )}{" "}
          Tạo job và chạy Library-first
        </button>
      </div>
    </form>
  );
}

type CatalogProduct = {
  id: string;
  primary_sku: string;
  display_name: string;
  brand: string | null;
  model_name: string | null;
};

function ProductSelector({
  value,
  required,
  onChange,
}: {
  value: string;
  required: boolean;
  onChange: (productId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CatalogProduct[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void requestJson<{ data: CatalogProduct[] }>(
        `/api/catalog/search?q=${encodeURIComponent(term)}`,
      )
        .then((response) => {
          if (active)
            setResults(Array.isArray(response.data) ? response.data : []);
        })
        .catch(() => {
          if (active) setResults([]);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-2/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-text-1">
            Sản phẩm tham chiếu {required ? "(bắt buộc)" : "(tuỳ chọn)"}
          </p>
          <p className="mt-0.5 text-[11px] text-text-3">
            Chọn đúng SKU để dùng approved real reference/cutout. Template
            preserve-pixels bắt buộc có SKU và approved real cutout; server sẽ
            fail closed trước provider dispatch nếu thiếu.
          </p>
        </div>
        {value && (
          <button
            type="button"
            onClick={() => onChange("")}
            className="text-xs font-semibold text-text-2 hover:text-text-1"
          >
            Bỏ chọn
          </button>
        )}
      </div>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Tìm SKU, model hoặc tên sản phẩm…"
        className="mt-2 h-9 w-full rounded-lg border border-border bg-surface px-3 text-xs text-text-1 outline-none focus:border-ai"
      />
      {loading && (
        <p className="mt-2 text-[11px] text-text-3">Đang tìm catalog…</p>
      )}
      {results.length > 0 && (
        <div className="mt-2 grid gap-1">
          {results.map((product) => (
            <button
              key={product.id}
              type="button"
              onClick={() => {
                onChange(product.id);
                setQuery(`${product.primary_sku} · ${product.display_name}`);
                setResults([]);
              }}
              className={`rounded-lg border px-2.5 py-2 text-left text-xs ${value === product.id ? "border-ai bg-ai-soft" : "border-border bg-surface hover:bg-surface-2"}`}
            >
              <span className="font-semibold text-text-1">
                {product.primary_sku}
              </span>
              <span className="text-text-2"> · {product.display_name}</span>
              {product.brand && (
                <span className="text-text-3"> · {product.brand}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function JobDetail({
  detail,
  refreshing,
  submitting,
  onPromote,
  onRetry,
}: {
  detail: CreativeDetail | null;
  refreshing: boolean;
  submitting: boolean;
  onPromote: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  if (!detail)
    return (
      <section className="rounded-2xl border border-border bg-surface p-8 text-center text-sm text-text-2">
        Đang tải slot, candidate và resolution…
      </section>
    );
  return (
    <section className="space-y-4 rounded-2xl border border-border bg-surface p-4 shadow-sm sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-bold text-text-1">
            {detail.external_article_id || detail.id}{" "}
            <span className="font-normal text-text-3">
              · {detail.external_revision || "—"}
            </span>
          </h2>
          <p className="mt-1 text-xs text-text-2">
            {detail.brand_name} v{detail.brand_version} · {detail.channel_name}{" "}
            v{detail.channel_version} · {detail.slots.length} slot
          </p>
        </div>
        <div className="flex items-center gap-2">
          {refreshing && (
            <Loader2 className="h-4 w-4 animate-spin text-text-3" />
          )}
          <StatusChip value={detail.status} />
        </div>
      </div>
      {detail.budget_events.some(
        (event) => event.status === "held_unknown",
      ) && (
        <p className="rounded-xl border border-warn-border bg-warn-soft px-3 py-2 text-xs text-warn">
          Có budget event cần đối soát; hệ thống không retry/fallback tự động
          sau lỗi ambiguous.
        </p>
      )}
      <div className="grid gap-3">
        {detail.slots.map((slot) => (
          <article
            key={slot.id}
            className="rounded-xl border border-border p-3 sm:p-4"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-bold text-text-1">
                    {slot.slot_kind === "thumbnail"
                      ? "Thumbnail"
                      : `Section · ${slot.slot_key}`}
                  </h3>
                  <StatusChip value={slot.status} />
                </div>
                <p className="mt-1 text-xs text-text-2">
                  {slot.template_name} v{slot.template_version} · fidelity:{" "}
                  {slot.fidelity_mode}
                  {slot.target_product_id ? " · product-bound" : ""}
                </p>
              </div>
              {slot.resolutions
                .filter((item) => item.status === "active")
                .map((resolution) => (
                  <div
                    key={resolution.id}
                    className="flex items-center gap-2 text-xs text-ok"
                  >
                    <CheckCircle2 className="h-4 w-4" /> Library/DAM asset
                    active
                  </div>
                ))}
            </div>
            {slot.resolutions.map((resolution) => (
              <div
                key={resolution.id}
                className="mt-3 rounded-lg bg-surface-2/60 p-2 text-xs text-text-2"
              >
                <span className="font-semibold text-text-1">
                  {resolution.source_kind === "library" ? "Library" : "AI"}{" "}
                  resolution
                </span>{" "}
                · <StatusChip value={resolution.status} /> · DAM:{" "}
                {statusLabel[resolution.asset_review_state] ||
                  resolution.asset_review_state}
                {resolution.asset_file_url && (
                  <a
                    className="ml-2 inline-flex items-center gap-1 font-semibold text-ai hover:underline"
                    href={resolution.asset_file_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Eye className="h-3.5 w-3.5" /> Xem asset
                  </a>
                )}
              </div>
            ))}
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              {slot.generations.map((generation) => (
                <div
                  key={generation.id}
                  className="rounded-xl border border-border-subtle bg-surface-2/30 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-bold text-text-1">
                      Attempt {generation.attempt_no} · {generation.provider}
                    </p>
                    <StatusChip value={generation.provider_call_state} />
                  </div>
                  <p className="mt-1 break-all font-mono text-[10px] text-text-3">
                    {generation.model}
                  </p>
                  {generation.error_detail && (
                    <p className="mt-2 rounded-lg bg-red-50 px-2 py-1.5 text-xs text-red-700">
                      {generation.error_detail}
                    </p>
                  )}
                  {generation.retry_class === "safe_retry" && (
                    <button
                      type="button"
                      onClick={() => onRetry(generation.id)}
                      disabled={submitting}
                      className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-semibold text-text-2 hover:bg-surface"
                    >
                      Thử lại attempt mới
                    </button>
                  )}
                  {generation.retry_class === "ambiguous" && (
                    <p className="mt-2 text-xs text-warn">
                      Không retry tự động: provider response ambiguous.
                    </p>
                  )}
                  {generation.outputs.map((output) => (
                    <div
                      key={output.id}
                      className="mt-3 overflow-hidden rounded-xl border border-border bg-surface"
                    >
                      <div className="aspect-video bg-surface-2">
                        {output.preview_url ? (
                          <img
                            src={output.preview_url}
                            alt={`Creative candidate ${output.candidate_index + 1}`}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="grid h-full place-items-center text-xs text-text-3">
                            {statusLabel[output.creative_state] ||
                              output.creative_state}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 p-2">
                        <div className="text-[11px] text-text-2">
                          <StatusChip value={output.creative_state} />{" "}
                          <span className="ml-1">
                            {output.creative_state === "candidate"
                              ? `Hết hạn ${new Date(output.expires_at).toLocaleString("vi-VN")}`
                              : statusLabel[output.review_state] ||
                                output.review_state}
                          </span>
                        </div>
                        {output.creative_state === "candidate" && (
                          <button
                            type="button"
                            onClick={() => onPromote(output.id)}
                            disabled={submitting}
                            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-ai px-2.5 text-xs font-bold text-white disabled:opacity-50"
                          >
                            <Send className="h-3.5 w-3.5" /> Promote để duyệt
                          </button>
                        )}
                        {output.creative_state === "promoted" && (
                          <Link
                            href="/review-queue"
                            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-semibold text-ai hover:bg-surface-2"
                          >
                            Mở hàng chờ duyệt{" "}
                            <ArrowUpRight className="h-3.5 w-3.5" />
                          </Link>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-xs font-semibold text-text-2">
      <span className="mb-1 block">{label}</span>
      {React.isValidElement(children)
        ? React.cloneElement(
            children as React.ReactElement<{ className?: string }>,
            {
              className:
                "min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs text-text-1 outline-none transition focus:border-ai focus:ring-1 focus:ring-ai/30",
            },
          )
        : children}
    </label>
  );
}
function StatusChip({ value }: { value: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-ai-soft px-2 py-1 text-[10px] font-semibold text-ai">
      {statusLabel[value] || value}
    </span>
  );
}
function Metric({
  icon,
  label,
  value,
  tone = "purple",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "purple" | "amber" | "green";
}) {
  const tones = {
    purple: "bg-ai-soft text-ai",
    amber: "bg-amber-50 text-amber-700",
    green: "bg-emerald-50 text-emerald-700",
  };
  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
      <div
        className={`grid h-8 w-8 place-items-center rounded-lg ${tones[tone]}`}
      >
        {icon}
      </div>
      <p className="mt-3 text-2xl font-bold text-text-1">{value}</p>
      <p className="text-xs text-text-2">{label}</p>
    </div>
  );
}
