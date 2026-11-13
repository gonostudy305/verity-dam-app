'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MediaAsset, ReviewQueueItem } from '@/types/media';
import { useTaxonomy } from '@/hooks/useTaxonomy';
import { activeItems } from '@/config/taxonomy';
import { cn } from '@/lib/utils';
import {
  Layers,
  Sparkles,
  Star,
  AlertTriangle,
  Check,
  X,
  Clock,
  ExternalLink,
  Wrench,
  ChevronDown,
  ChevronUp,
  SlidersHorizontal,
} from 'lucide-react';
import type { TaggableRole } from '@/lib/product-role';
import { ProductHeroCard } from './ProductHeroCard';
import { ContextualTaxonomy } from './ContextualTaxonomy';
import { AdvancedMetaAccordion } from './AdvancedMetaAccordion';
import { ProductTagPicker, type PendingProductTag } from './ProductTagPicker';
import { apiRequest } from '@/lib/client/api';

export interface BatchReviewFormProps {
  selectedItems: ReviewQueueItem[];
  referenceId: string | null;
  suggestedSku?: string;
  suggestedSkuConfidence?: number;
  suggestedBrand?: string;
  suggestedCategory?: string;
  suggestedSpace?: string;
  onSetReference: (id: string) => void;
  onApprove: (
    patch: Partial<MediaAsset>,
    corrections: string[],
    referenceQueueId?: string,
    productLinks?: { sku: string; role: TaggableRole }[],
    patchFields?: string[]
  ) => void;
  onReject: () => void;
  onSkip: () => void;
  onClearSelection: () => void;
  isSubmitting?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export function BatchReviewForm({
  selectedItems,
  referenceId,
  suggestedSku,
  suggestedSkuConfidence,
  suggestedBrand,
  suggestedCategory,
  suggestedSpace,
  onSetReference,
  onApprove,
  onReject,
  onSkip,
  onClearSelection,
  isSubmitting = false,
  className,
  style,
}: BatchReviewFormProps) {
  const { taxonomy } = useTaxonomy();
  const formScrollRef = useRef<HTMLDivElement>(null);

  // Active reference item in batch
  const refItem = useMemo(() => {
    return selectedItems.find((item) => item.id === referenceId) || selectedItems[0] || null;
  }, [selectedItems, referenceId]);

  // These are the fields this form can actually edit for a whole batch. Title
  // deliberately remains per-asset, and sub_category is not a supported API
  // patch key. Do not silently copy the reference item's value when a field
  // disagrees within the selected batch.
  const batchValues = useMemo(() => {
    const same = (read: (asset: MediaAsset) => string) => {
      const values = selectedItems.map((item) => read(item.asset));
      return values.length > 0 && values.every((value) => value === values[0]);
    };
    const keywords = selectedItems.map((item) => (item.asset.keywords || []).join('\u0001'));
    const postProdValues = selectedItems.map((item) => Boolean(item.asset.needs_post_production));
    const postProdSame = postProdValues.length > 0 && postProdValues.every((value) => value === postProdValues[0]);
    return {
      sku: same((asset) => asset.sku || ''),
      brand: same((asset) => asset.brand || ''),
      category: same((asset) => asset.category || ''),
      space: same((asset) => asset.space || ''),
      status: same((asset) => asset.status || ''),
      permission: same((asset) => asset.permission || ''),
      keywords: keywords.length > 0 && keywords.every((value) => value === keywords[0]),
      needs_post_production: postProdSame,
    } as const;
  }, [selectedItems]);
  const selectedItemKey = selectedItems.map((item) => item.id).join('|');
  const mixedFieldLabels = useMemo(() => {
    const labels: Record<keyof typeof batchValues, string> = {
      sku: 'SKU', brand: 'Thương hiệu', category: 'Loại ảnh', space: 'Không gian',
      status: 'Tình trạng', permission: 'Quyền dùng', keywords: 'Từ khóa',
      needs_post_production: 'Cần Hậu kỳ',
    };
    return (Object.keys(batchValues) as Array<keyof typeof batchValues>)
      .filter((field) => !batchValues[field])
      .map((field) => ({ field, label: labels[field] }));
  }, [batchValues]);

  // Initial metadata form state initialized from group suggestions or first item
  const [formState, setFormState] = useState<Partial<MediaAsset>>({
    sku: suggestedSku || refItem?.asset?.sku || '',
    brand: suggestedBrand || refItem?.asset?.brand || '',
    category: suggestedCategory || refItem?.asset?.category || 'Ảnh thực tế',
    sub_category: refItem?.asset?.sub_category || undefined,
    space: suggestedSpace || refItem?.asset?.space || '',
    status: refItem?.asset?.status || 'Mới',
    permission: refItem?.asset?.permission || 'public',
    needs_post_production: Boolean(refItem?.asset?.needs_post_production),
    // Selecting ★ chooses the candidate only. A reviewer must explicitly opt
    // into adding it to the AI reference corpus in ProductHeroCard.
    promote_reference: false,
  });

  const [editedFields, setEditedFields] = useState<Record<string, boolean>>({});
  const [appliedFields, setAppliedFields] = useState<Record<string, boolean>>({});
  const [pendingProductTags, setPendingProductTags] = useState<PendingProductTag[]>([]);
  const [keywordsInput, setKeywordsInput] = useState('');
  const [liveCatalogIdentity, setLiveCatalogIdentity] = useState<{
    brand?: string;
    model_name?: string;
    display_name?: string;
    catalog_sku_kind?: string;
  }>({});
  const [showAdvanced, setShowAdvanced] = useState(false);

  const recordEdit = (field: string) => {
    setEditedFields((prev) => ({ ...prev, [field]: true }));
    setAppliedFields((prev) => ({ ...prev, [field]: true }));
  };

  const handleTogglePostProduction = () => {
    setFormState((prev) => ({
      ...prev,
      needs_post_production: !prev.needs_post_production,
    }));
    recordEdit('needs_post_production');
  };

  const isInitializedRef = useRef(false);

  // Selection changes in batch:
  // On initial batch open, seed unanimous/suggested values.
  // On subsequent selection changes (adding/removing items), preserve any fields
  // the reviewer has already edited so their typed work is NEVER wiped out.
  useEffect(() => {
    const first = selectedItems[0]?.asset;
    if (!first) return;

    if (!isInitializedRef.current) {
      isInitializedRef.current = true;
      setFormState({
        sku: batchValues.sku ? first.sku || '' : (suggestedSku || ''),
        brand: batchValues.brand ? first.brand || '' : (suggestedBrand || ''),
        category: batchValues.category ? first.category || '' : '',
        space: batchValues.space ? first.space || '' : '',
        status: batchValues.status ? first.status || '' : 'Mới',
        permission: batchValues.permission ? first.permission : 'public',
        keywords: batchValues.keywords ? first.keywords || [] : [],
        needs_post_production: batchValues.needs_post_production ? Boolean(first.needs_post_production) : false,
        promote_reference: false,
      });
      setKeywordsInput(batchValues.keywords ? (first.keywords || []).join(', ') : '');
      setEditedFields({});
      setAppliedFields({});
      setPendingProductTags([]);
      setLiveCatalogIdentity({});
    } else {
      setFormState((prev) => ({
        ...prev,
        sku: editedFields.sku ? prev.sku : (batchValues.sku ? first.sku || '' : prev.sku || ''),
        brand: editedFields.brand ? prev.brand : (batchValues.brand ? first.brand || '' : prev.brand || ''),
        category: editedFields.category ? prev.category : (batchValues.category ? first.category || '' : prev.category || ''),
        space: editedFields.space ? prev.space : (batchValues.space ? first.space || '' : prev.space || ''),
        status: editedFields.status ? prev.status : (batchValues.status ? first.status || '' : prev.status || 'Mới'),
        permission: editedFields.permission ? prev.permission : (batchValues.permission ? first.permission : prev.permission),
        keywords: editedFields.keywords ? prev.keywords : (batchValues.keywords ? first.keywords || [] : prev.keywords || []),
        needs_post_production: editedFields.needs_post_production
          ? Boolean(prev.needs_post_production)
          : (batchValues.needs_post_production ? Boolean(first.needs_post_production) : Boolean(prev.needs_post_production)),
      }));
      if (!editedFields.keywords && batchValues.keywords) {
        setKeywordsInput((first.keywords || []).join(', '));
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItemKey]);

  // Sync state if suggestedSku changes from parent and user hasn't edited SKU
  useEffect(() => {
    if (suggestedSku && !formState.sku && !editedFields.sku) {
      setFormState((prev) => ({
        ...prev,
        sku: suggestedSku,
        brand: suggestedBrand || prev.brand,
      }));
    }
  }, [suggestedSku, suggestedBrand, formState.sku, editedFields.sku]);

  // Dynamic catalog lookup when SKU changes in Batch Form
  useEffect(() => {
    const trimmed = formState.sku?.trim();
    if (!trimmed || trimmed.length < 2) {
      setLiveCatalogIdentity({});
      return;
    }

    if (
      refItem?.sku_match?.catalog_identity &&
      (trimmed.toLowerCase() === refItem.sku_match.sku?.trim().toLowerCase() ||
        trimmed.toLowerCase() === refItem.sku_match.catalog_identity.model_name?.trim().toLowerCase())
    ) {
      setLiveCatalogIdentity(refItem.sku_match.catalog_identity);
      return;
    }

    let active = true;
    const timer = setTimeout(() => {
      apiRequest<{ data: { primary_sku: string; brand?: string; model_name?: string; display_name?: string; catalog_sku_kind?: string } | null }>(
        `/api/catalog/lookup?sku=${encodeURIComponent(trimmed)}`
      )
        .then((res) => {
          if (!active) return;
          if (res?.data) {
            setLiveCatalogIdentity(res.data);
            if (res.data.brand && (!formState.brand || formState.brand.toLowerCase() === 'unknown')) {
              setFormState((prev) => ({ ...prev, brand: res.data!.brand! }));
              recordEdit('brand');
            }
          } else {
            setLiveCatalogIdentity({});
          }
        })
        .catch(() => {
          if (!active) setLiveCatalogIdentity({});
        });
    }, 250);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [formState.sku, refItem?.sku_match]);

  const duplicateCount = useMemo(() => {
    return selectedItems.filter((i) => i.is_duplicate).length;
  }, [selectedItems]);

  const categories = useMemo(() => activeItems(taxonomy.category), [taxonomy.category]);
  const spaces = useMemo(() => activeItems(taxonomy.space), [taxonomy.space]);
  const statuses = useMemo(() => activeItems(taxonomy.status), [taxonomy.status]);
  const permissions = useMemo(() => activeItems(taxonomy.permission), [taxonomy.permission]);
  const internalLabel = taxonomy.permission.find((entry) => entry.value === 'internal')?.label || 'Chỉ nội bộ';
  const peopleLabel = taxonomy.safety.find((entry) => entry.value === 'only_people')?.label || 'Có người';

  const isNonCatalog = Boolean(formState.ai_flags?.non_catalog);

  const effectiveCatalogIdentity = useMemo(() => {
    return {
      brand: liveCatalogIdentity.brand || formState.brand || undefined,
      model_name: liveCatalogIdentity.model_name || undefined,
      display_name: liveCatalogIdentity.display_name || undefined,
      catalog_sku_kind: liveCatalogIdentity.catalog_sku_kind || undefined,
    };
  }, [liveCatalogIdentity, formState.brand]);

  const handleApplySuggestedSku = () => {
    if (suggestedSku) {
      setFormState((prev) => ({
        ...prev,
        sku: suggestedSku,
        brand: suggestedBrand || prev.brand,
      }));
      recordEdit('sku');
      if (suggestedBrand) recordEdit('brand');
    }
  };

  const handleSubmitApprove = () => {
    // Invariant fields: SKU and Brand are always applied in batch review
    const patchFields: string[] = ['sku', 'brand'];
    if (formState.promote_reference) {
      patchFields.push('promote_reference');
    }
    // Variant fields (Category, Space, Status, Permission, etc.) are ONLY applied
    // if the reviewer explicitly edited/applied them. This guarantees that individual
    // AI Vision recognitions on each photo are 100% preserved.
    const variantFields = ['category', 'space', 'status', 'permission', 'keywords', 'needs_post_production'];
    for (const field of variantFields) {
      if (appliedFields[field]) {
        patchFields.push(field);
      }
    }

    const patch = Object.fromEntries(
      Object.entries(formState).filter(([field]) => patchFields.includes(field))
    ) as Partial<MediaAsset>;
    const correctionsList = Object.keys(editedFields).filter((field) => editedFields[field] && patchFields.includes(field));
    const tags = pendingProductTags.map((t) => ({ sku: t.sku, role: t.role }));
    onApprove(patch, correctionsList, refItem?.id, tags, patchFields);
  };

  return (
    <div
      className={cn(
        'w-full max-w-[420px] flex-none flex flex-col bg-surface border-l border-border h-full select-none shadow-sm',
        className
      )}
      style={style}
    >
      {/* Batch Header Bar */}
      <div className="flex-none p-3.5 border-b border-border bg-surface-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-verity/10 text-verity flex items-center justify-center flex-none font-bold">
            <Layers className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-[13.5px] font-bold text-text-1 truncate leading-tight">
              Duyệt hàng loạt ({selectedItems.length} ảnh)
            </h3>
            <p className="text-[11px] text-text-3 truncate">
              Metadata bên dưới sẽ áp dụng cho tất cả ảnh đã chọn
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClearSelection}
          className="flex-none px-2 py-1 rounded-md text-[11.5px] font-semibold text-text-2 hover:bg-hover hover:text-text-1 border border-border transition-all"
          title="Thoát chế độ duyệt hàng loạt"
        >
          Bỏ chọn
        </button>
      </div>

      {/* Scrollable Form Content */}
      <div className="relative min-h-0 flex-1">
        <div ref={formScrollRef} className="h-full overflow-y-auto p-4 pb-6 space-y-3.5">
          {/* Duplicate Warning if any */}
          {duplicateCount > 0 && (
            <div className="p-3 rounded-xl border border-warn-border bg-warn-soft/80 text-warn flex items-start gap-2.5 text-[12px]">
              <AlertTriangle className="w-4 h-4 flex-none mt-0.5" />
              <div>
                <p className="font-bold">
                  Phát hiện {duplicateCount} ảnh nghi trùng lặp trong lô
                </p>
                <p className="text-[11.5px] opacity-90 mt-0.5">
                  Các ảnh này vẫn sẽ được duyệt vào kho. Nếu muốn kiểm tra đối chiếu chi tiết, hãy chọn duyệt riêng từng ảnh.
                </p>
              </div>
            </div>
          )}

          {mixedFieldLabels.length > 0 && (
            <div className="rounded-xl border border-verity/25 bg-verity/5 p-3">
              <p className="text-[12px] font-bold text-text-1">Một số trường có nhiều giá trị</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-text-3">
                Các trường này không được tự động lấy từ ảnh Reference. Hãy chỉnh giá trị rồi bật “Áp dụng cho tất cả”.
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {mixedFieldLabels.map(({ field, label }) => (
                  <label key={field} className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-2 text-[11px] font-semibold text-text-2">
                    <input
                      type="checkbox"
                      checked={Boolean(appliedFields[field])}
                      onChange={(event) => setAppliedFields((prev) => ({ ...prev, [field]: event.target.checked }))}
                      className="h-4 w-4 accent-verity"
                    />
                    {label}: {appliedFields[field] ? 'Áp dụng cho tất cả' : 'Nhiều giá trị'}
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Reference Photo Card */}
          {refItem && (
            <div className="p-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 flex items-center gap-3">
              <div className="relative w-12 h-12 rounded-lg overflow-hidden border border-amber-500/40 flex-none bg-surface">
                <img
                  src={refItem.asset.thumbnail_url}
                  alt="Ảnh đại diện"
                  className="w-full h-full object-cover"
                />
                <span className="absolute top-0.5 right-0.5 w-3.5 h-3.5 rounded-full bg-amber-500 text-white flex items-center justify-center text-[8px] font-bold">
                  ★
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1 text-[11px] font-bold text-amber-600 dark:text-amber-400">
                  <Star className="w-3 h-3 fill-amber-500 text-amber-500" />
                  <span>Ảnh đại diện lô (Reference)</span>
                </div>
                <p className="text-[11px] text-text-3 truncate mt-0.5">
                  Chỉ ảnh này có thể được nạp vector chuẩn khi bạn bật “Ảnh mẫu AI”. Đổi ảnh bằng ⭐ ở Grid hoặc thanh ảnh Focus.
                </p>
              </div>
            </div>
          )}

          {selectedItems.length > 1 ? (
            <div className="rounded-xl border border-border bg-surface-2 p-2.5">
              <p className="mb-2 text-[11px] font-bold text-text-2">Chọn ảnh Reference cho lô</p>
              <div className="flex gap-2 overflow-x-auto pb-2 filmstrip-scrollbar" role="group" aria-label="Chọn ảnh Reference cho lô">
                {selectedItems.map((item) => {
                  const isReference = item.id === refItem?.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onSetReference(item.id)}
                      aria-label={isReference ? 'Ảnh Reference đang chọn' : `Đặt ${item.asset.title || item.asset.sku || 'ảnh'} làm Reference`}
                      aria-pressed={isReference}
                      className={cn(
                        'relative h-11 w-11 flex-none overflow-hidden rounded-lg border-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-verity',
                        isReference ? 'border-amber-500 ring-2 ring-amber-500/20' : 'border-border hover:border-amber-500/70'
                      )}
                    >
                      <img src={item.asset.thumbnail_url} alt="" className="h-full w-full object-cover" />
                      <span className={cn('absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full text-[10px]', isReference ? 'bg-amber-500 text-white' : 'bg-black/55 text-white/80')} aria-hidden="true">★</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* AI SKU Suggestion Banner */}
          {suggestedSku && formState.sku !== suggestedSku && (
            <div className="p-3 rounded-xl border border-sky-300 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/40 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0 text-[12px] text-sky-800 dark:text-sky-200">
                <Sparkles className="w-4 h-4 text-sky-600 flex-none" />
                <div className="truncate">
                  <span>Gợi ý từ lô: </span>
                  <span className="font-bold text-sky-900 dark:text-sky-100">{suggestedSku}</span>
                  {suggestedSkuConfidence ? (
                    <span className="text-[10.5px] opacity-80"> ({suggestedSkuConfidence}%)</span>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                onClick={handleApplySuggestedSku}
                className="flex-none px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-[11px] font-bold shadow-xs transition-all"
              >
                Dùng ngay
              </button>
            </div>
          )}

          {/* 1. Product Identity Hero Card */}
          <ProductHeroCard
            sku={formState.sku || ''}
            disabled={isSubmitting}
            onSkuChange={(nextSku, selectedCatalog) => {
              setFormState((prev) => ({
                ...prev,
                sku: nextSku,
                ...(selectedCatalog?.brand && (!prev.brand || prev.brand.toLowerCase() === 'unknown' || prev.brand.trim().toUpperCase() === 'Verity' || prev.brand !== selectedCatalog.brand)
                  ? { brand: selectedCatalog.brand }
                  : {}),
                ...(isNonCatalog && nextSku.trim().length > 0
                  ? { ai_flags: { ...(prev.ai_flags as any), non_catalog: false } as any }
                  : {}),
              }));
              if (selectedCatalog) {
                setLiveCatalogIdentity({
                  brand: selectedCatalog.brand || undefined,
                  model_name: selectedCatalog.model_name || undefined,
                  display_name: selectedCatalog.display_name || undefined,
                  catalog_sku_kind: selectedCatalog.catalog_sku_kind || undefined,
                });
                if (selectedCatalog.brand) {
                  recordEdit('brand');
                }
              }
              recordEdit('sku');
            }}
            isNonCatalog={isNonCatalog}
            onToggleNonCatalog={() => {
              if (isNonCatalog) {
                setFormState((prev) => ({
                  ...prev,
                  ai_flags: { ...(prev.ai_flags as any), non_catalog: false } as any,
                }));
              } else {
                setFormState((prev) => ({
                  ...prev,
                  sku: '',
                  promote_reference: false,
                  ai_flags: { ...(prev.ai_flags as any), non_catalog: true } as any,
                }));
                recordEdit('sku');
              }
            }}
            promoteReference={Boolean(formState.promote_reference)}
            onTogglePromoteReference={(nextPromote) => {
              setFormState((prev) => ({ ...prev, promote_reference: nextPromote }));
            }}
            effectiveCatalogIdentity={effectiveCatalogIdentity}
            skuMatch={refItem?.sku_match}
            confidence={suggestedSkuConfidence ?? 0}
            isEdited={Boolean(editedFields.sku)}
          />

          {/* Collapsible Advanced Options: Secondary products, Taxonomy, Rights */}
          <div className="rounded-2xl border border-border bg-surface-2/40 overflow-hidden">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full p-3 flex items-center justify-between text-[12px] font-bold text-text-2 hover:bg-hover transition-colors text-left"
            >
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4 text-text-3" />
                <span>Tùy chọn nâng cao (Không gian, Loại ảnh, Quyền dùng...)</span>
              </div>
              {showAdvanced ? (
                <ChevronUp className="w-4 h-4 text-text-3" />
              ) : (
                <ChevronDown className="w-4 h-4 text-text-3" />
              )}
            </button>

            {showAdvanced && (
              <div className="p-3 pt-0 space-y-3 border-t border-border/50">
                <p className="text-[11px] text-text-3 pt-2">
                  💡 <strong>Bảo toàn dữ liệu:</strong> Mặc định mỗi ảnh tự giữ nguyên nhãn do AI nhận diện. Chỉ chọn bên dưới nếu bạn muốn áp dụng chung giá trị đó cho cả {selectedItems.length} ảnh.
                </p>

                {/* 2. Secondary Product Links */}
                <ProductTagPicker
                  tags={pendingProductTags}
                  onChange={setPendingProductTags}
                  disabled={isSubmitting}
                  primarySku={formState.sku || ''}
                />

                {/* 3. Contextual Taxonomy: Loại ảnh + Không gian & Tình trạng */}
                <ContextualTaxonomy
                  category={formState.category}
                  onCategoryChange={(cat) => {
                    setFormState((prev) => ({ ...prev, category: cat }));
                    recordEdit('category');
                  }}
                  subCategory={formState.sub_category || undefined}
                  onSubCategoryChange={(sub) => {
                    setFormState((prev) => ({ ...prev, sub_category: sub }));
                    recordEdit('sub_category');
                  }}
                  space={formState.space}
                  onSpaceChange={(sp) => {
                    setFormState((prev) => ({ ...prev, space: sp }));
                    recordEdit('space');
                  }}
                  status={formState.status}
                  onStatusChange={(st) => {
                    setFormState((prev) => ({ ...prev, status: st as any }));
                    recordEdit('status');
                  }}
                  categories={categories}
                  spaces={spaces}
                  statuses={statuses}
                  editedFields={editedFields}
                  isLowConf={() => false}
                  confidence={{
                    category: 90,
                    space: 90,
                    status: 90,
                  }}
                  disabled={isSubmitting}
                />

                {/* Post-Production Toggle for Batch */}
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={handleTogglePostProduction}
                  title={`Bật/tắt đánh dấu cần hậu kỳ cho toàn bộ ${selectedItems.length} ảnh`}
                  aria-label="Bật/tắt đánh dấu ảnh cần hậu kỳ cho cả lô"
                  aria-pressed={Boolean(formState.needs_post_production)}
                  className={cn(
                    'w-full flex items-center justify-between p-3 rounded-xl border text-[12.5px] transition-all cursor-pointer select-none text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-50',
                    formState.needs_post_production
                      ? 'border-amber-500/50 bg-amber-500/10'
                      : 'border-border/80 bg-surface-2/40 hover:bg-surface-2/70 hover:border-border'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Wrench
                      className={cn('w-4 h-4', formState.needs_post_production ? 'text-amber-500' : 'text-text-3')}
                      aria-hidden="true"
                    />
                    <span className="font-semibold text-text-1">Cần Hậu kỳ cả lô</span>
                    {!batchValues.needs_post_production && !appliedFields.needs_post_production ? (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-3 text-text-3 border border-border">
                        Nhiều giá trị
                      </span>
                    ) : formState.needs_post_production ? (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 uppercase">
                        {selectedItems.length} ảnh
                      </span>
                    ) : (
                      <span className="text-[10px] font-medium text-text-3">Không</span>
                    )}
                  </div>
                  <div
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out',
                      formState.needs_post_production ? 'bg-amber-500' : 'bg-surface-3'
                    )}
                  >
                    <span
                      className={cn(
                        'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
                        formState.needs_post_production ? 'translate-x-4' : 'translate-x-0'
                      )}
                    />
                  </div>
                </button>

                {/* 4. Advanced Metadata Accordion */}
                <AdvancedMetaAccordion
                  permission={formState.permission || 'public'}
                  onPermissionChange={(p) => {
                    setFormState((prev) => ({ ...prev, permission: p }));
                    recordEdit('permission');
                  }}
                  source={refItem?.asset.origin_info?.source || 'auto'}
                  suggestedCaption=""
                  onCaptionChange={() => undefined}
                  visibleText={[]}
                  keywordsInput={keywordsInput}
                  onKeywordsChange={(kw) => {
                    setKeywordsInput(kw);
                    const parsed = kw.split(',').map((s) => s.trim()).filter(Boolean);
                    setFormState((prev) => ({ ...prev, keywords: parsed }));
                    recordEdit('keywords');
                  }}
                  permissions={permissions}
                  hasPeople={false}
                  internalLabel={internalLabel}
                  peopleLabel={peopleLabel}
                  editedFields={editedFields}
                  disabled={isSubmitting}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Sticky Bottom Actions */}
      <div className="flex-none p-3.5 border-t border-border bg-surface-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onReject}
          disabled={isSubmitting}
          className="flex-1 h-[40px] rounded-xl border border-warn-border hover:bg-warn-soft text-warn text-[12.5px] font-bold transition-all disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          <X className="w-3.5 h-3.5" />
          <span>Từ chối</span>
        </button>

        <button
          type="button"
          onClick={onSkip}
          disabled={isSubmitting}
          className="flex-1 h-[40px] rounded-xl border border-border hover:bg-hover text-text-2 text-[12.5px] font-bold transition-all disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          <Clock className="w-3.5 h-3.5" />
          <span>Để sau</span>
        </button>

        <button
          type="button"
          onClick={handleSubmitApprove}
          disabled={isSubmitting}
          className="flex-[2] h-[40px] rounded-xl bg-verity hover:bg-verity-hover text-white text-[13px] font-bold transition-all shadow-sm disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          <Check className="w-4 h-4 stroke-[2.5]" />
          <span>Duyệt {selectedItems.length} ảnh</span>
        </button>
      </div>
    </div>
  );
}
