'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  FileText,
  ImageDown,
  Info,
  Loader2,
  Save,
  Sparkles,
} from 'lucide-react';
import { useTaxonomy } from '@/hooks/useTaxonomy';
import { activeItems } from '@/config/taxonomy';
import { VerityChip } from '@/components/common/VerityChip';

export interface ProductIntakeDraftFields {
  proposedName: string;
  proposedBrand: string;
  proposedModel: string;
  proposedSku: string;
  proposedCategory: string;
  proposedSpace: string;
  sourceUrl: string;
  notes: string;
}

interface ProductIntakeFormProps {
  value: ProductIntakeDraftFields;
  onChange: (value: ProductIntakeDraftFields) => void;
  onSaveDraft: () => void;
  saving?: boolean;
  locked?: boolean;
  intakeId?: string | null;
  /** Mở bộ chọn ảnh từ link. Bỏ trống thì nút không hiện. */
  onFetchImagesFromUrl?: () => void;
  /** Ẩn nút "Lưu nháp" nổi bật, thay bằng chỉ báo tự động lưu (dossier workspace tự debounce onChange). */
  autosave?: boolean;
}

const DUMMY_SKU_SET = new Set(['X', 'TEST', 'NONE', 'TEMP', 'UNKNOWN', 'DUMMY', 'NA', 'NULL', 'UNDEFINED']);
const SKU_REGEX = /^[A-Z0-9]{2,}(?:[-_.][A-Z0-9]+)*$/;

const inputClassName = 'h-11 w-full rounded-xl border border-border bg-surface px-3 text-[12.5px] text-text-1 outline-none placeholder:text-text-3 transition-colors focus:border-verity focus:ring-2 focus:ring-verity/20 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-text-3';

interface ExistingProductMatch {
  id: string;
  primary_sku: string;
  display_name: string;
  brand: string | null;
}

/** Form khai sinh hồ sơ sản phẩm mới (New Product Declaration).
 * Luồng chuyên biệt 100% cho sản phẩm chưa có trong catalog.
 * Nếu muốn bổ sung ảnh cho sản phẩm có sẵn, định tuyến sang /upload?prefill_sku=...
 */
export function ProductIntakeForm({
  value,
  onChange,
  onSaveDraft,
  saving = false,
  locked = false,
  intakeId,
  onFetchImagesFromUrl,
  autosave = false,
}: ProductIntakeFormProps) {
  const { taxonomy } = useTaxonomy();
  const spaceOptions = activeItems(taxonomy.space);

  const [checkingSku, setCheckingSku] = useState(false);
  const [existingProduct, setExistingProduct] = useState<ExistingProductMatch | null>(null);

  const set = <K extends keyof ProductIntakeDraftFields>(key: K, next: ProductIntakeDraftFields[K]) => {
    onChange({ ...value, [key]: next });
  };

  const handleSkuChange = (raw: string) => {
    const formatted = raw.toUpperCase().replace(/\s+/g, '-');
    set('proposedSku', formatted);
  };

  const trimmedSku = value.proposedSku.trim();
  const isSkuFormatValid = trimmedSku.length >= 3 && !DUMMY_SKU_SET.has(trimmedSku) && SKU_REGEX.test(trimmedSku);
  const isSkuInvalidLength = trimmedSku.length > 0 && trimmedSku.length < 3;
  const isSkuDummy = DUMMY_SKU_SET.has(trimmedSku);
  const isSkuInvalidRegex = trimmedSku.length >= 3 && !isSkuDummy && !SKU_REGEX.test(trimmedSku);

  // Debounced catalog duplicate check
  useEffect(() => {
    if (!isSkuFormatValid) {
      setExistingProduct(null);
      setCheckingSku(false);
      return;
    }

    let active = true;
    setCheckingSku(true);

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/catalog/check-sku?sku=${encodeURIComponent(trimmedSku)}`);
        if (!active) return;
        if (res.ok) {
          const json = await res.json() as { exists?: boolean; product?: ExistingProductMatch | null };
          if (json.exists && json.product) {
            setExistingProduct(json.product);
          } else {
            setExistingProduct(null);
          }
        } else {
          setExistingProduct(null);
        }
      } catch {
        if (active) setExistingProduct(null);
      } finally {
        if (active) setCheckingSku(false);
      }
    }, 350);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [trimmedSku, isSkuFormatValid]);

  const hasSkuConflict = Boolean(existingProduct);
  const canSave = (
    isSkuFormatValid
    && !hasSkuConflict
    && value.proposedName.trim().length >= 3
    && value.proposedBrand.trim().length > 0
  );

  return (
    <section aria-labelledby="product-intake-heading" className="rounded-2xl border border-verity-border bg-surface p-4 shadow-xs sm:p-5">
      {/* Header with Live Identity Tag */}
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 gap-3">
          <div className="grid h-11 w-11 flex-none place-items-center rounded-xl bg-verity-soft text-verity-fg">
            <Sparkles aria-hidden="true" className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="product-intake-heading" className="text-[15px] font-bold text-text-1">Khai báo sản phẩm mới</h2>
              {intakeId ? <span className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] text-text-3">Đã lưu nháp</span> : null}
            </div>
            <p className="mt-0.5 max-w-2xl text-[12px] leading-relaxed text-text-2">
              Khai sinh danh tính cho sản phẩm chưa có trong catalog. SKU và Tên là bắt buộc ngay từ đầu — AI sẽ đối chiếu bằng chứng ảnh theo đúng danh tính này.
            </p>
          </div>
        </div>

        {/* Live Identity Preview Badge */}
        {(value.proposedBrand || value.proposedSku || value.proposedName) ? (
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-surface-2/60 px-2.5 py-1.5 text-[11.5px] text-text-2">
            <span className="font-bold text-text-1">{value.proposedBrand || 'Hãng'}</span>
            <span className="text-text-3">·</span>
            <span className="font-mono font-bold text-verity">{value.proposedSku || 'SKU'}</span>
            {value.proposedName ? (
              <>
                <span className="text-text-3">·</span>
                <span className="max-w-[180px] truncate text-text-2">{value.proposedName}</span>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* SKU Catalog Conflict Warning Banner */}
      {hasSkuConflict && existingProduct ? (
        <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-[12px] leading-relaxed text-amber-900 dark:text-amber-200">
          <div className="flex items-start gap-2.5">
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 flex-none text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="font-bold">
                Mã SKU <span className="font-mono underline">{existingProduct.primary_sku}</span> đã tồn tại trong catalog!
              </p>
              <p className="text-[11.5px] text-amber-800 dark:text-amber-300">
                Sản phẩm hiện có: <strong>{existingProduct.display_name}</strong> {existingProduct.brand ? `(${existingProduct.brand})` : ''}.
                Hồ sơ này chỉ dành cho sản phẩm mới. Để bổ sung ảnh cho sản phẩm đã có, vui lòng tải trực tiếp tại trang Tải ảnh.
              </p>
              <div className="pt-1">
                <Link
                  href={`/upload?prefill_sku=${encodeURIComponent(existingProduct.primary_sku)}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-600/40 bg-surface px-2.5 py-1 font-bold text-amber-700 shadow-2xs hover:bg-hover dark:text-amber-300"
                >
                  <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
                  Bổ sung ảnh cho {existingProduct.primary_sku} tại /upload
                </Link>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Main Form Fields */}
      <div className="mt-4 border-t border-border pt-4">
        <div className="mb-3 flex items-center gap-2">
          <FileText aria-hidden="true" className="h-4 w-4 text-verity" />
          <h3 className="text-[13px] font-bold text-text-1">Thông tin danh tính sản phẩm</h3>
          <span className="text-[11px] text-text-3">SKU, tên và hãng là bắt buộc</span>
        </div>

        <div className="grid gap-3.5 sm:grid-cols-2">
          {/* SKU Field with validation feedback */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold text-text-2">
                Mã SKU chính thức <span className="text-bad">*</span>
              </span>
              {checkingSku ? (
                <span className="flex items-center gap-1 text-[11px] text-text-3">
                  <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin text-verity" />
                  Kiểm tra catalog…
                </span>
              ) : isSkuFormatValid && !hasSkuConflict ? (
                <span className="flex items-center gap-1 text-[11px] text-ok">
                  <CheckCircle2 aria-hidden="true" className="h-3 w-3" />
                  SKU hợp lệ & khả dụng
                </span>
              ) : null}
            </div>
            <input
              value={value.proposedSku}
              onChange={(event) => handleSkuChange(event.target.value)}
              disabled={locked}
              className={`${inputClassName} font-mono ${hasSkuConflict ? 'border-amber-500 focus:border-amber-500 focus:ring-amber-500/20' : isSkuInvalidLength || isSkuDummy || isSkuInvalidRegex ? 'border-bad focus:border-bad focus:ring-bad/20' : ''}`}
              placeholder="VD: LF-RF21, XM-SL5MAX, H1-EU"
            />
            {isSkuInvalidLength ? (
              <p className="text-[11px] text-bad">Mã SKU phải có độ dài tối thiểu 3 ký tự.</p>
            ) : isSkuDummy ? (
              <p className="text-[11px] text-bad">Mã SKU &quot;{trimmedSku}&quot; thuộc danh sách mã thử nghiệm bị chặn.</p>
            ) : isSkuInvalidRegex ? (
              <p className="text-[11px] text-bad">Mã SKU chỉ được chứa chữ cái, chữ số và dấu gạch (- _ .).</p>
            ) : (
              <p className="text-[11px] text-text-3">Chữ in hoa, số và dấu gạch nối. Tự động viết hoa.</p>
            )}
          </div>

          {/* Product Name */}
          <label className="space-y-1.5">
            <span className="text-[12px] font-semibold text-text-2">
              Tên sản phẩm đầy đủ <span className="text-bad">*</span>
            </span>
            <input
              value={value.proposedName}
              onChange={(event) => set('proposedName', event.target.value)}
              disabled={locked}
              className={inputClassName}
              placeholder="VD: Khóa thông minh Nova Smart Lock 5 Max"
            />
            {value.proposedName && value.proposedName.trim().length < 3 ? (
              <p className="text-[11px] text-bad">Tên sản phẩm tối thiểu 3 ký tự.</p>
            ) : (
              <p className="text-[11px] text-text-3">Tên thương mại chuẩn xác của sản phẩm.</p>
            )}
          </label>

          {/* Brand */}
          <label className="space-y-1.5">
            <span className="text-[12px] font-semibold text-text-2">
              Hãng sản xuất / Thương hiệu <span className="text-bad">*</span>
            </span>
            <input
              value={value.proposedBrand}
              onChange={(event) => set('proposedBrand', event.target.value)}
              disabled={locked}
              className={inputClassName}
              placeholder="VD: LocknLock, Elmich, Inochi, Sunhouse…"
            />
            <p className="text-[11px] text-text-3">Tên thương hiệu sẽ được ép đồng bộ vào toàn bộ ảnh trong lô.</p>
          </label>

          {/* Model */}
          <label className="space-y-1.5">
            <span className="text-[12px] font-semibold text-text-2">Mã Model (tuỳ chọn)</span>
            <input
              value={value.proposedModel}
              onChange={(event) => set('proposedModel', event.target.value)}
              disabled={locked}
              className={inputClassName}
              placeholder="VD: XM-SL5MAX, AC-S02, S1E…"
            />
            <p className="text-[11px] text-text-3">Mã model kỹ thuật của nhà sản xuất (nếu có).</p>
          </label>
        </div>

        {/* Taxonomy Context (Category & Space) directly exposed */}
        <div className="mt-4 rounded-xl border border-border/80 bg-surface-2/30 p-3.5">
          <div className="mb-2.5 flex items-center gap-2">
            <Info aria-hidden="true" className="h-4 w-4 text-verity" />
            <h4 className="text-[12.5px] font-bold text-text-1">Bối cảnh sản phẩm & Phân loại</h4>
            <span className="text-[11px] text-text-3">Giúp AI nhận diện và đối sánh ảnh chuẩn xác</span>
          </div>

          <div className="grid gap-3.5 sm:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-[12px] font-semibold text-text-2">Danh mục sản phẩm</span>
              <input
                value={value.proposedCategory}
                onChange={(event) => set('proposedCategory', event.target.value)}
                disabled={locked}
                className={inputClassName}
                placeholder="VD: Khoá cửa thông minh, Công tắc, Cảm biến…"
              />
            </label>

            <div className="space-y-1.5">
              <span className="text-[12px] font-semibold text-text-2">Không gian sử dụng</span>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {spaceOptions.map((option) => (
                  <VerityChip
                    key={option.value}
                    active={value.proposedSpace === option.value}
                    disabled={locked}
                    onClick={() => set('proposedSpace', value.proposedSpace === option.value ? '' : option.value)}
                  >
                    {option.label}
                  </VerityChip>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Auxiliary Details (Reference URL & Notes) */}
      <details
        className="group mt-4 rounded-xl border border-border/70 bg-surface-2/30 p-3.5 transition-colors"
        open={Boolean(value.sourceUrl || value.notes) || undefined}
      >
        <summary className="flex cursor-pointer select-none items-center justify-between text-[12.5px] font-bold text-text-2 hover:text-text-1">
          <span className="flex flex-wrap items-center gap-2">
            <span>Nguồn tham khảo & Ghi chú hồ sơ</span>
            <span className="text-[11px] font-normal text-text-3">(link trang chủ, hướng dẫn sử dụng, lưu ý model)</span>
          </span>
          <ChevronDown aria-hidden="true" className="h-4 w-4 text-text-3 transition-transform duration-200 group-open:rotate-180" />
        </summary>

        <div className="mt-3.5 space-y-3.5 border-t border-border/60 pt-3.5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="space-y-1.5">
                <span className="text-[12px] font-semibold text-text-2">Nguồn tham khảo</span>
                <input
                  value={value.sourceUrl}
                  onChange={(event) => set('sourceUrl', event.target.value)}
                  disabled={locked}
                  type="url"
                  className={inputClassName}
                  placeholder="https://… (link sản phẩm chính hãng)"
                />
              </label>
              {onFetchImagesFromUrl ? (
                <button
                  type="button"
                  onClick={onFetchImagesFromUrl}
                  disabled={locked}
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-verity-border bg-verity-soft/50 px-3 text-[12px] font-bold text-verity-fg transition-colors hover:bg-verity-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-verity disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ImageDown aria-hidden="true" className="h-4 w-4" />
                  Lấy ảnh từ link
                </button>
              ) : null}
            </div>

            <label className="space-y-1.5">
              <span className="text-[12px] font-semibold text-text-2">Ghi chú hồ sơ</span>
              <textarea
                value={value.notes}
                onChange={(event) => set('notes', event.target.value)}
                disabled={locked}
                rows={2}
                className="min-h-[72px] w-full resize-y rounded-xl border border-border bg-surface px-3 py-2.5 text-[12.5px] text-text-1 outline-none placeholder:text-text-3 transition-colors focus:border-verity focus:ring-2 focus:ring-verity/20 disabled:cursor-not-allowed disabled:bg-surface-2"
                placeholder="VD: Ảnh chụp thực tế tại showroom, phụ kiện bao gồm ruột khóa 6068…"
              />
            </label>
          </div>
        </div>
      </details>

      {/* Action Footer */}
      <div className="mt-4 flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        {autosave ? (
          <p className="flex items-center gap-1.5 text-[11.5px] leading-relaxed text-text-3">
            <Save aria-hidden="true" className="h-3.5 w-3.5" />
            {saving ? 'Đang tự động lưu…' : 'Tự động lưu khi bạn chỉnh sửa.'}
          </p>
        ) : (
          <>
            <p className="text-[11.5px] leading-relaxed text-text-3">
              {hasSkuConflict
                ? 'Mã SKU đã có trong catalog. Vui lòng đổi SKU hoặc nạp ảnh tại trang /upload.'
                : 'Lưu nháp hồ sơ trước khi tải ảnh để có thể quay lại hoàn thiện bất kỳ lúc nào.'}
            </p>
            <button
              type="button"
              onClick={onSaveDraft}
              disabled={locked || saving || !canSave}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border-strong bg-surface px-4 text-[12.5px] font-bold text-text-1 shadow-xs transition-colors hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-verity disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Save aria-hidden="true" className="h-4 w-4" />
              {saving ? 'Đang lưu…' : intakeId ? 'Lưu thay đổi' : 'Lưu nháp hồ sơ'}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
