"use client";

import React, { useEffect, useState } from "react";
import { CheckCircle2, ImagePlus, KeyRound, Loader2, Save } from "lucide-react";

import { useToast } from "@/components/common/Toast";
import { apiRequest } from "@/lib/client/api";
import { cn } from "@/lib/utils";

type ProviderConfig = {
  baseUrl: string;
  model: string;
  configured: boolean;
};

type SharedCreativeConfig = {
  openai: ProviderConfig;
  gemini: ProviderConfig;
  configured: boolean;
  updatedAt: string | null;
};

const DEFAULTS = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-image-2.5-flare-2026-09-08",
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-3.1-flash-image",
  },
};

function ProviderCard({
  name,
  description,
  config,
  apiKey,
  modelOptions,
  onChange,
  onApiKeyChange,
}: {
  name: string;
  description: string;
  config: ProviderConfig;
  apiKey: string;
  modelOptions: readonly string[];
  onChange: (field: "baseUrl" | "model", value: string) => void;
  onApiKeyChange: (value: string) => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface-2/35 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[13px] font-bold text-text-1">{name}</div>
          <p className="mt-0.5 text-[11.5px] text-text-3">{description}</p>
        </div>
        {config.configured ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-ok-border bg-ok-soft px-2 py-1 text-[10.5px] font-semibold text-ok">
            <CheckCircle2 className="h-3.5 w-3.5" /> Đã cấu hình
          </span>
        ) : (
          <span className="rounded-full border border-warn-border bg-warn-soft px-2 py-1 text-[10.5px] font-semibold text-warn">
            Chưa cấu hình
          </span>
        )}
      </div>

      <label className="block">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-text-3">
          Base URL
        </span>
        <input
          value={config.baseUrl}
          onChange={(event) => onChange("baseUrl", event.target.value)}
          className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-[12.5px] text-text-1 outline-none transition focus:border-verity focus:ring-1 focus:ring-verity/20"
          placeholder="https://..."
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-text-3">
          Image model
        </span>
        <select
          value={config.model}
          onChange={(event) => onChange("model", event.target.value)}
          className="h-9 w-full rounded-lg border border-border bg-surface px-3 font-mono text-[12.5px] text-text-1 outline-none transition focus:border-verity focus:ring-1 focus:ring-verity/20"
        >
          {!modelOptions.includes(config.model) && (
            <option value={config.model}>
              {config.model} (không được hỗ trợ cho AI Creative)
            </option>
          )}
          {modelOptions.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-text-3">
          <KeyRound className="h-3.5 w-3.5" /> API key
        </span>
        <input
          type="password"
          value={apiKey}
          onChange={(event) => onApiKeyChange(event.target.value)}
          className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-[12.5px] text-text-1 outline-none transition focus:border-verity focus:ring-1 focus:ring-verity/20"
          placeholder={
            config.configured ? "Để trống để giữ key đang lưu" : "Nhập API key"
          }
          autoComplete="new-password"
        />
      </label>
    </div>
  );
}

export function CreativeProviderSettings() {
  const { showToast } = useToast();
  const [config, setConfig] = useState<SharedCreativeConfig>({
    openai: { ...DEFAULTS.openai, configured: false },
    gemini: { ...DEFAULTS.gemini, configured: false },
    configured: false,
    updatedAt: null,
  });
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void apiRequest<{ data: SharedCreativeConfig }>("/api/settings/creative")
      .then(({ data }) => {
        if (active) setConfig(data);
      })
      .catch((error) => {
        if (active)
          showToast(
            error instanceof Error
              ? error.message
              : "Không tải được cấu hình AI Creative.",
            "warn",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [showToast]);

  const updateProvider = (
    provider: "openai" | "gemini",
    field: "baseUrl" | "model",
    value: string,
  ) => {
    setConfig((previous) => ({
      ...previous,
      [provider]: { ...previous[provider], [field]: value },
    }));
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await apiRequest<{ data: SharedCreativeConfig }>(
        "/api/settings/creative",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            openai: { ...config.openai, apiKey: openaiApiKey },
            gemini: { ...config.gemini, apiKey: geminiApiKey },
          }),
        },
      );
      setConfig(response.data);
      setOpenaiApiKey("");
      setGeminiApiKey("");
      showToast(
        "Đã lưu cấu hình provider tạo ảnh. API key được mã hóa trong PostgreSQL.",
        "success",
      );
    } catch (error) {
      showToast(
        error instanceof Error
          ? error.message
          : "Không lưu được cấu hình AI Creative.",
        "warn",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={save}
      className="space-y-5 rounded-2xl border border-ai-border bg-surface p-5 shadow-xs"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-ai-border bg-ai-soft">
            <ImagePlus className="h-4 w-4 text-ai" />
          </div>
          <div>
            <div className="text-[14px] font-bold text-text-1">
              AI Creative — tạo ảnh
            </div>
            <p className="mt-0.5 text-[12px] text-text-3">
              Provider key chỉ dùng ở creative worker; không cần đưa vào Docker
              env.
            </p>
          </div>
        </div>
        {config.configured && (
          <span className="text-[11px] text-text-3">
            Cập nhật:{" "}
            {config.updatedAt
              ? new Date(config.updatedAt).toLocaleString("vi-VN")
              : "—"}
          </span>
        )}
      </div>

      <div className="rounded-lg border border-ai-border/60 bg-ai-soft/35 px-3 py-2.5 text-[11.5px] leading-relaxed text-text-2">
        API key được mã hóa AES-GCM tại PostgreSQL. Khi để trống ô key, hệ thống
        giữ key đã lưu; trình duyệt không bao giờ nhận lại key.
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ProviderCard
          name="OpenAI / OpenAI-compatible"
          description="Generation/editing precision cao; hỗ trợ gateway OpenAI-compatible."
          config={config.openai}
          apiKey={openaiApiKey}
          modelOptions={[
            "gpt-image-2.5-flare-2026-09-08",
            "gpt-image-2.5-sunburst-2026-09-08",
          ]}
          onChange={(field, value) => updateProvider("openai", field, value)}
          onApiKeyChange={setOpenaiApiKey}
        />
        <ProviderCard
          name="Google Gemini Image"
          description="Gemini image generation với reference images và output 4K."
          config={config.gemini}
          apiKey={geminiApiKey}
          modelOptions={["gemini-3.1-flash-image", "gemini-3-pro-image"]}
          onChange={(field, value) => updateProvider("gemini", field, value)}
          onApiKeyChange={setGeminiApiKey}
        />
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border-subtle pt-4">
        <p
          className={cn(
            "text-[11.5px]",
            config.configured ? "text-ok" : "text-warn",
          )}
        >
          {config.configured
            ? "Worker sẽ đọc cấu hình mới ở vòng poll kế tiếp."
            : "Cần cấu hình ít nhất một provider trước khi tạo ảnh."}
        </p>
        <button
          type="submit"
          disabled={loading || saving}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-verity px-4 text-[12.5px] font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {saving ? "Đang lưu..." : "Lưu cấu hình"}
        </button>
      </div>
    </form>
  );
}
