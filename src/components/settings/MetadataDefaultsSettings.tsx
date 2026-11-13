'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Info, Loader2, Plus, RotateCcw, Save, Tags, X } from 'lucide-react';

import { useToast } from '@/components/common/Toast';
import { apiRequest, ClientApiError } from '@/lib/client/api';

type SharedMetadataDefaults = {
  author: string;
  copyright: string;
  credit: string;
  description: string;
  keywords: string[];
  autoApply: boolean;
  updatedAt: string | null;
  licenseUrl?: string;
  licensorName?: string;
  licensorUrl?: string;
  acquireLicensePage?: string;
  webStatementUrl?: string;
};

const EMPTY_DEFAULTS: SharedMetadataDefaults = {
  author: '',
  copyright: '',
  credit: '',
  description: '',
  keywords: [],
  autoApply: true,
  updatedAt: null,
  licenseUrl: '',
  licensorName: '',
  licensorUrl: '',
  acquireLicensePage: '',
  webStatementUrl: '',
};

export function MetadataDefaultsSettings() {
  const { showToast } = useToast();
  const [saved, setSaved] = useState<SharedMetadataDefaults>(EMPTY_DEFAULTS);
  const [author, setAuthor] = useState('');
  const [copyright, setCopyright] = useState('');
  const [credit, setCredit] = useState('');
  const [description, setDescription] = useState('');
  const [keywords, setKeywords] = useState<string[]>([]);
  const [autoApply, setAutoApply] = useState(true);
  const [licenseUrl, setLicenseUrl] = useState('');
  const [licensorName, setLicensorName] = useState('');
  const [licensorUrl, setLicensorUrl] = useState('');
  const [acquireLicensePage, setAcquireLicensePage] = useState('');
  const [webStatementUrl, setWebStatementUrl] = useState('');
  const [keywordDraft, setKeywordDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ data: SharedMetadataDefaults }>('/api/settings/metadata-defaults')
      .then(({ data }) => {
        if (cancelled) return;
        setSaved(data);
        setAuthor(data.author);
        setCopyright(data.copyright);
        setCredit(data.credit);
        setDescription(data.description);
        setKeywords(data.keywords);
        setAutoApply(data.autoApply);
        setLicenseUrl(data.licenseUrl || '');
        setLicensorName(data.licensorName || '');
        setLicensorUrl(data.licensorUrl || '');
        setAcquireLicensePage(data.acquireLicensePage || '');
        setWebStatementUrl(data.webStatementUrl || '');
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof ClientApiError && error.status === 403) {
          setForbidden(true);
          return;
        }
        showToast(error instanceof Error ? error.message : 'Không tải được Metadata mặc định', 'warn');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showToast]);

  const hasChanges = useMemo(() => {
    return (
      author !== saved.author ||
      copyright !== saved.copyright ||
      credit !== saved.credit ||
      description !== saved.description ||
      autoApply !== saved.autoApply ||
      JSON.stringify(keywords) !== JSON.stringify(saved.keywords) ||
      licenseUrl !== (saved.licenseUrl || '') ||
      licensorName !== (saved.licensorName || '') ||
      licensorUrl !== (saved.licensorUrl || '') ||
      acquireLicensePage !== (saved.acquireLicensePage || '') ||
      webStatementUrl !== (saved.webStatementUrl || '')
    );
  }, [
    author,
    copyright,
    credit,
    description,
    autoApply,
    keywords,
    licenseUrl,
    licensorName,
    licensorUrl,
    acquireLicensePage,
    webStatementUrl,
    saved,
  ]);

  const addKeyword = () => {
    const value = keywordDraft.trim();
    if (!value) return;
    if (keywords.some((keyword) => keyword.toLowerCase() === value.toLowerCase())) {
      setKeywordDraft('');
      return;
    }
    setKeywords((prev) => [...prev, value]);
    setKeywordDraft('');
  };

  const removeKeyword = (value: string) => {
    setKeywords((prev) => prev.filter((keyword) => keyword !== value));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await apiRequest<{ data: SharedMetadataDefaults }>('/api/settings/metadata-defaults', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          author,
          copyright,
          credit,
          description,
          keywords,
          autoApply,
          licenseUrl,
          licensorName,
          licensorUrl,
          acquireLicensePage,
          webStatementUrl,
        }),
      });
      setSaved(response.data);
      showToast('Đã lưu Metadata mặc định dùng chung cho toàn hệ thống.', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không lưu được Metadata mặc định', 'warn');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setAuthor(saved.author);
    setCopyright(saved.copyright);
    setCredit(saved.credit);
    setDescription(saved.description);
    setKeywords(saved.keywords);
    setAutoApply(saved.autoApply);
    setLicenseUrl(saved.licenseUrl || '');
    setLicensorName(saved.licensorName || '');
    setLicensorUrl(saved.licensorUrl || '');
    setAcquireLicensePage(saved.acquireLicensePage || '');
    setWebStatementUrl(saved.webStatementUrl || '');
  };

  if (forbidden) {
    return (
      <div className="p-5 rounded-2xl border border-border bg-surface shadow-xs">
        <div className="flex items-start gap-2.5 text-[12.5px] text-text-3">
          <Info className="w-4 h-4 text-warn flex-none mt-0.5" />
          <span>Bạn cần quyền Admin để xem và chỉnh Metadata mặc định dùng chung toàn hệ thống.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-5 rounded-2xl border border-border bg-surface shadow-xs space-y-5">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-verity-soft border border-verity-border flex items-center justify-center flex-none mt-0.5">
            <Tags className="w-4 h-4 text-verity" />
          </div>
          <div>
            <div className="text-[14px] font-bold text-text-1">Metadata mặc định (dùng chung toàn hệ thống)</div>
          </div>
        </div>
        {saved.updatedAt && (
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-ok-soft text-ok border border-ok-border whitespace-nowrap">
            <CheckCircle2 className="w-3.5 h-3.5" /> Đã cấu hình
          </span>
        )}
      </div>

      {/* ── Author / Copyright / Credit ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field
          label="Author"
          value={author}
          onChange={setAuthor}
          disabled={loading || saving}
          placeholder="VerityDAM Platform"
        />
        <Field
          label="Copyright"
          value={copyright}
          onChange={setCopyright}
          disabled={loading || saving}
          placeholder="© 2026 VerityDAM Platform"
        />
        <Field
          label="Credit"
          value={credit}
          onChange={setCredit}
          disabled={loading || saving}
          placeholder="VerityDAM Team"
        />
      </div>

      {/* ── Description ── */}
      <div>
        <label htmlFor="metadata-description" className="text-[12px] font-semibold text-text-2 uppercase tracking-wide">
          Mô tả mặc định
        </label>
        <textarea
          id="metadata-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          disabled={loading || saving}
          rows={2}
          placeholder="Hình ảnh sản phẩm, tư liệu truyền thông và tài sản số chính hãng LocknLock."
          className="mt-1.5 w-full px-3 py-2 rounded-lg border border-border bg-surface text-[13px] text-text-1 outline-none focus:border-verity focus:ring-2 focus:ring-verity/15 disabled:opacity-60 resize-none"
        />
      </div>

      {/* ── Keywords ── */}
      <div>
        <label className="text-[12px] font-semibold text-text-2 uppercase tracking-wide">Từ khóa mặc định</label>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 p-2.5 rounded-lg border border-border bg-surface-2/40 min-h-11">
          {keywords.map((keyword) => (
            <span
              key={keyword}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[12px] font-medium bg-verity-soft text-verity border border-verity-border"
            >
              {keyword}
              <button
                type="button"
                onClick={() => removeKeyword(keyword)}
                disabled={loading || saving}
                className="hover:text-bad transition-colors disabled:opacity-40"
                aria-label={`Xóa từ khóa ${keyword}`}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
          <div className="flex items-center gap-1 flex-1 min-w-[140px]">
            <input
              type="text"
              value={keywordDraft}
              onChange={(event) => setKeywordDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addKeyword();
                }
              }}
              disabled={loading || saving}
              placeholder="Nhập từ khóa rồi Enter..."
              className="flex-1 min-w-0 bg-transparent text-[12.5px] text-text-1 outline-none placeholder:text-text-disabled px-1 disabled:opacity-60"
            />
            <button
              type="button"
              onClick={addKeyword}
              disabled={loading || saving || !keywordDraft.trim()}
              className="p-1 rounded-md text-text-3 hover:text-verity hover:bg-verity-soft transition-colors disabled:opacity-40"
              aria-label="Thêm từ khóa"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* ── Licensing & Copyright (Image SEO & Licensable Badge) ── */}
      <div className="pt-2 border-t border-border space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-bold text-text-1">Bản quyền &amp; Giấy phép (Google Licensable Badge &amp; IPTC/XMP)</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field
            label="License Policy URL (xmpRights:WebStatement)"
            value={licenseUrl}
            onChange={setLicenseUrl}
            disabled={loading || saving}
            placeholder="https://veritydam.example/chinh-sach-ban-quyen"
          />
          <Field
            label="Acquire License Page (Trang liên hệ cấp phép)"
            value={acquireLicensePage}
            onChange={setAcquireLicensePage}
            disabled={loading || saving}
            placeholder="https://veritydam.example/lien-he"
          />
          <Field
            label="Licensor Name (plus:LicensorName)"
            value={licensorName}
            onChange={setLicensorName}
            disabled={loading || saving}
            placeholder="VerityDAM Platform"
          />
          <Field
            label="Licensor URL (plus:LicensorURL)"
            value={licensorUrl}
            onChange={setLicensorUrl}
            disabled={loading || saving}
            placeholder="https://veritydam.example"
          />
        </div>
      </div>

      {/* ── Auto-apply toggle ── */}
      <div className="flex items-center justify-between p-3 rounded-xl border border-border bg-surface-2/40">
        <div>
          <div className="text-[12.5px] font-semibold text-text-1">Tự động gán khi upload</div>
          <div className="text-[11.5px] text-text-3 mt-0.5">
            Tự động điền các trường mặc định ở trên vào metadata ảnh mới, chỉ khi ảnh chưa có sẵn giá trị.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={autoApply}
          onClick={() => setAutoApply((prev) => !prev)}
          disabled={loading || saving}
          className={`relative w-10 h-5.5 rounded-full transition-colors flex-none disabled:opacity-50 ${
            autoApply ? 'bg-verity' : 'bg-surface-2 border border-border'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow-sm transition-transform ${
              autoApply ? 'translate-x-4.5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      <div className="flex items-start gap-2 p-3 rounded-xl border border-border bg-surface-2/60 text-[12px] text-text-3 leading-relaxed">
        <Info className="w-4 h-4 text-verity flex-none mt-0.5" />
        <span>Đây là cấu hình dùng chung — không tách theo từng tài khoản. Mọi thay đổi ở đây áp dụng ngay cho cả đội.</span>
      </div>

      <div className="flex justify-end gap-2.5">
        <button
          type="button"
          onClick={handleReset}
          disabled={loading || saving || !hasChanges}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-text-2 text-[12.5px] font-bold hover:bg-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Hoàn tác
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={loading || saving || !hasChanges}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-verity text-white text-[12.5px] font-bold hover:bg-verity-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Lưu cấu hình dùng chung
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="text-[12px] font-semibold text-text-2 uppercase tracking-wide">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="mt-1.5 w-full h-10 px-3 rounded-lg border border-border bg-surface text-[13px] text-text-1 outline-none focus:border-verity focus:ring-2 focus:ring-verity/15 disabled:opacity-60"
      />
    </div>
  );
}
