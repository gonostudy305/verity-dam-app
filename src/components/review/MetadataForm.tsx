'use client';

import React, { useEffect, useRef, useState } from 'react';
import { DedupSummary, MediaAsset, SkuMatchResult } from '@/types/media';
import { DuplicateBanner } from './DuplicateBanner';
import { DuplicateCompareModal } from './DuplicateCompareModal';
import { Check, ShieldAlert, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import { activeItems } from '@/config/taxonomy';
import { useTaxonomy } from '@/hooks/useTaxonomy';
import { apiRequest } from '@/lib/client/api';
import { isGenericOrRawTitle, composeAssetTitle } from '@/lib/image-slug';
import { resolveSkuContext, isSkuNagSuppressed } from '@/lib/sku-context';
import type { TaggableRole } from '@/lib/product-role';
import { ProductTagPicker, type PendingProductTag } from './ProductTagPicker';
import { isReviewTypingTarget } from './review-interaction';
import { ProductHeroCard } from './ProductHeroCard';
import { ContextualTaxonomy } from './ContextualTaxonomy';
import { AdvancedMetaAccordion } from './AdvancedMetaAccordion';

const LOW_CONFIDENCE_THRESHOLD = 50;
const WARN_CONFIDENCE_THRESHOLD = 80;
const CONFIDENCE_FIELD_LABELS = [
  { key: 'sku', label: 'SKU' },
  { key: 'brand', label: 'Thương hiệu' },
  { key: 'category', label: 'Loại ảnh' },
  { key: 'space', label: 'Không gian' },
  { key: 'status', label: 'Tình trạng' },
] as const;

interface MetadataFormProps {
  asset: MediaAsset;
  isDuplicate?: boolean;
  duplicateSimilarity?: number;
  duplicateMatches?: MediaAsset[];
  skuMatch?: SkuMatchResult;
  metadataDraft?: {
    visible_text?: string[];
    visible_text_confidence?: number;
    brand?: string;
    caption?: string;
    category?: string;
    keywords?: string[];
    [key: string]: any;
  };
  dedupSummary?: DedupSummary;
  onReplaceDuplicate?: (replaceIds: string[]) => void;
  onKeepDuplicate?: () => void;
  onDropDuplicate?: () => void;
  onApprove: (
    updatedAsset: MediaAsset,
    correctedFields: string[],
    productLinks?: { sku: string; role: TaggableRole }[]
  ) => void;
  onReject: () => void;
  onSkip: () => void;
  isSubmitting?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export function MetadataForm({
  asset,
  isDuplicate = false,
  duplicateSimilarity = 0.92,
  duplicateMatches = [],
  skuMatch,
  metadataDraft,
  dedupSummary,
  onReplaceDuplicate,
  onKeepDuplicate,
  onDropDuplicate,
  onApprove,
  onReject,
  onSkip,
  isSubmitting = false,
  className,
  style,
}: MetadataFormProps) {
  const { taxonomy } = useTaxonomy();
  // Local form state for live editing
  const [formState, setFormState] = useState<MediaAsset>({ ...asset });
  const formScrollRef = useRef<HTMLDivElement>(null);
  const [hasMoreContent, setHasMoreContent] = useState(false);
  const [editedFields, setEditedFields] = useState<Record<string, boolean>>({});
  const [dismissDuplicate, setDismissDuplicate] = useState(false);
  const [isCompareModalOpen, setIsCompareModalOpen] = useState(false);
  const [compareModalIndex, setCompareModalIndex] = useState(0);
  const [keywordsInput, setKeywordsInput] = useState((asset.keywords || []).join(', '));
  const [liveCatalogIdentity, setLiveCatalogIdentity] = useState<{
    brand?: string;
    model_name?: string;
    display_name?: string;
    catalog_sku_kind?: string;
  } | null>(skuMatch?.catalog_identity || null);
  const [pendingProductTags, setPendingProductTags] = useState<PendingProductTag[]>([]);

  // Sync state whenever the active asset changes
  useEffect(() => {
    const initialCatalog = skuMatch?.catalog_identity || null;
    const initialSuggested = initialCatalog?.model_name || initialCatalog?.display_name;
    const shouldAutoApplyTitle = Boolean(initialSuggested && isGenericOrRawTitle(asset.title));
    const initialPermission = asset.ai_flags?.has_people && asset.permission === 'public'
      ? 'internal'
      : asset.permission;

    setFormState({
      ...asset,
      title: shouldAutoApplyTitle ? initialSuggested! : asset.title,
      permission: initialPermission,
      promote_reference: Boolean(asset.promote_reference),
      needs_post_production: Boolean(asset.needs_post_production),
      ai_flags: {
        ...(asset.ai_flags || { is_ai: false, is_internal: false, has_people: false, tag_failed: false }),
        non_catalog: Boolean(asset.ai_flags?.non_catalog),
      },
    });
    setKeywordsInput((asset.keywords || []).join(', '));
    setEditedFields({});
    setPendingProductTags([]);
    setDismissDuplicate(false);
    setCompareModalIndex(0);
    setLiveCatalogIdentity(initialCatalog);

    let active = true;
    apiRequest<{ data: { author: string; copyright: string; credit: string; description: string; keywords: string[]; autoApply: boolean } }>('/api/settings/metadata-defaults')
      .then((res) => {
        if (!active || !res?.data || !res.data.autoApply) return;
        setFormState((prev) => {
          const nextKeywords = prev.keywords && prev.keywords.length > 0 ? prev.keywords : res.data.keywords;
          return {
            ...prev,
            author: prev.author || res.data.author,
            copyright: prev.copyright || res.data.copyright,
            credit: prev.credit || res.data.credit,
            description: prev.description || prev.suggested_caption || res.data.description,
            keywords: nextKeywords,
          };
        });
        if (!asset.keywords || asset.keywords.length === 0) {
          setKeywordsInput((res.data.keywords || []).join(', '));
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [asset.id]);

  // Dynamic catalog lookup when SKU changes
  useEffect(() => {
    const trimmed = formState.sku?.trim();
    if (!trimmed || trimmed.length < 2) {
      setLiveCatalogIdentity(null);
      return;
    }

    if (
      skuMatch?.catalog_identity &&
      (trimmed.toLowerCase() === skuMatch.sku?.trim().toLowerCase() ||
        trimmed.toLowerCase() === skuMatch.catalog_identity.model_name?.trim().toLowerCase())
    ) {
      setLiveCatalogIdentity(skuMatch.catalog_identity);
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
            setLiveCatalogIdentity(null);
          }
        })
        .catch(() => {
          if (!active) setLiveCatalogIdentity(null);
        });
    }, 250);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [formState.sku, skuMatch]);

  const recordEdit = (fieldName: string) => {
    setEditedFields((prev) => ({ ...prev, [fieldName]: true }));
  };

  const categories = activeItems(taxonomy.category);
  const spaces = activeItems(taxonomy.space);
  const statuses = activeItems(taxonomy.status);
  const permissions = activeItems(taxonomy.permission);
  const internalLabel = taxonomy.permission.find((entry) => entry.value === 'internal')?.label || 'Chỉ nội bộ';
  const peopleLabel = taxonomy.safety.find((entry) => entry.value === 'only_people')?.label || 'Có người';

  const effectiveCatalogIdentity = liveCatalogIdentity || (
    formState.sku && skuMatch?.sku && formState.sku.trim().toLowerCase() === skuMatch.sku.trim().toLowerCase()
      ? skuMatch.catalog_identity
      : null
  );

  const suggestedTitle =
    effectiveCatalogIdentity?.model_name ||
    effectiveCatalogIdentity?.display_name ||
    composeAssetTitle({
      title: formState.title,
      brand: formState.brand,
      sku: formState.sku,
      category: formState.category,
      space: formState.space,
      suggested_caption: formState.suggested_caption,
    }) ||
    null;

  const isLowConf = (val: number | undefined) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return false;
    const n = val > 0 && val <= 1 ? val * 100 : val;
    return n < WARN_CONFIDENCE_THRESHOLD;
  };

  const isNonCatalog = formState.ai_flags?.non_catalog === true;

  const activeSkuConfidence = React.useMemo(() => {
    const currentSku = formState.sku?.trim().toLowerCase();
    if (!currentSku || isNonCatalog) return null;

    // Check if matches any candidate in skuMatch
    const matchedCandidate = skuMatch?.candidates?.find(
      (c) => c.sku.trim().toLowerCase() === currentSku
    );
    if (matchedCandidate && typeof matchedCandidate.similarity === 'number') {
      return Math.round(matchedCandidate.similarity * 100);
    }

    // Check if matches initial skuMatch top pick
    if (skuMatch?.sku && skuMatch.sku.trim().toLowerCase() === currentSku) {
      if (typeof skuMatch.similarity === 'number') {
        return Math.round(skuMatch.similarity * 100);
      }
      if (typeof formState.ai_confidence?.sku === 'number') {
        const val = formState.ai_confidence.sku;
        return val > 0 && val <= 1 ? Math.round(val * 100) : Math.round(val);
      }
    }

    // If edited manually or selected from catalog search (not an AI candidate)
    if (editedFields.sku) {
      return 'manual' as const;
    }

    // Fallback if untouched
    if (typeof formState.ai_confidence?.sku === 'number') {
      const val = formState.ai_confidence.sku;
      return val > 0 && val <= 1 ? Math.round(val * 100) : Math.round(val);
    }

    return null;
  }, [formState.sku, formState.ai_confidence?.sku, skuMatch, editedFields.sku, isNonCatalog]);

  const skuContext = resolveSkuContext({
    category: formState.category,
    non_catalog: formState.ai_flags?.non_catalog,
  });

  const isMarketingOrStudio = formState.category === 'Banner' || formState.category === 'Studio';

  // Suppress low-confidence warnings for space/status when category is Banner or Studio
  const lowConfidenceFields = CONFIDENCE_FIELD_LABELS
    .filter(({ key }) => {
      if (key === 'sku' && (isSkuNagSuppressed(skuContext) || activeSkuConfidence === 'manual')) return false;
      if ((key === 'space' || key === 'status') && isMarketingOrStudio) return false;
      if (editedFields[key]) return false;
      const value = key === 'sku'
        ? (typeof activeSkuConfidence === 'number' ? activeSkuConfidence : undefined)
        : formState.ai_confidence?.[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      const normalized = value > 0 && value <= 1 ? value * 100 : value;
      return normalized < LOW_CONFIDENCE_THRESHOLD;
    })
    .map(({ label }) => label);

  useEffect(() => {
    const node = formScrollRef.current;
    if (!node) return;

    const updateScrollCue = () => {
      setHasMoreContent(node.scrollHeight - node.scrollTop - node.clientHeight > 4);
    };

    updateScrollCue();
    node.addEventListener('scroll', updateScrollCue, { passive: true });

    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(updateScrollCue);
      observer.observe(node);
    }

    let mutationObserver: MutationObserver | undefined;
    if (typeof MutationObserver !== 'undefined') {
      mutationObserver = new MutationObserver(updateScrollCue);
      mutationObserver.observe(node, { childList: true, subtree: true, characterData: true });
    }

    return () => {
      node.removeEventListener('scroll', updateScrollCue);
      observer?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [asset.id]);

  // Auto-sync Title from Catalog Model if title is raw/generic and hasn't been manually edited
  useEffect(() => {
    if (suggestedTitle && !editedFields.title && isGenericOrRawTitle(formState.title)) {
      setFormState((prev) => ({ ...prev, title: suggestedTitle }));
    }
  }, [suggestedTitle, editedFields.title, formState.title]);

  const handleTogglePostProduction = () => {
    setFormState((prev) => ({
      ...prev,
      needs_post_production: !prev.needs_post_production,
    }));
    recordEdit('needs_post_production');
  };

  const handleTriggerApprove = () => {
    if (isSubmitting) return;
    onApprove(
      formState,
      Object.keys(editedFields),
      pendingProductTags.map((t) => ({ sku: t.sku, role: t.role }))
    );
  };

  // Global Review Keyboard Shortcuts (Speed-Review)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't intercept if user is typing inside an input or textarea
      if (e.defaultPrevented || isReviewTypingTarget(e.target)) return;

      if (isSubmitting || isCompareModalOpen) return;

      // Space or Enter: Approve & Next
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        handleTriggerApprove();
      }
      // S: Skip
      else if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        onSkip();
      }
      // Delete or X: Reject
      else if (e.key === 'Delete' || e.key === 'x' || e.key === 'X') {
        e.preventDefault();
        onReject();
      }
      // H: Toggle Cần Hậu kỳ
      else if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        handleTogglePostProduction();
      }
      // Number keys 1-5: Pick candidate SKU
      else if (['1', '2', '3', '4', '5'].includes(e.key)) {
        const candidateIdx = parseInt(e.key, 10) - 1;
        const candidate = skuMatch?.candidates?.[candidateIdx];
        if (candidate) {
          e.preventDefault();
          setFormState((prev) => ({
            ...prev,
            sku: candidate.sku,
            ai_flags: { ...prev.ai_flags, non_catalog: false },
          }));
          recordEdit('sku');
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [formState, editedFields, pendingProductTags, isSubmitting, isCompareModalOpen, skuMatch]);

  return (
    <div
      className={cn(
        'w-full max-w-[420px] flex-none flex flex-col bg-surface border-l border-border h-full select-none',
        className
      )}
      style={style}
    >
      {/* Scrollable Form Body */}
      <div className="relative min-h-0 flex-1">
        <div ref={formScrollRef} className="h-full overflow-y-auto p-4 pb-6 space-y-3.5">
          {/* Duplicate Banner */}
          {isDuplicate && !dismissDuplicate && (
            <DuplicateBanner
              similarity={duplicateSimilarity}
              matches={duplicateMatches}
              currentAsset={formState}
              onOpenCompare={(index = 0) => {
                setCompareModalIndex(index);
                setIsCompareModalOpen(true);
              }}
            />
          )}

          {/* 1. Product Identity Hero Card */}
          <ProductHeroCard
            sku={formState.sku}
            disabled={isSubmitting}
            onSkuChange={(nextSku, selectedCatalog) => {
              setFormState((prev) => ({
                ...prev,
                sku: nextSku,
                ...(selectedCatalog?.brand && (!prev.brand || prev.brand.toLowerCase() === 'unknown' || prev.brand.trim().toUpperCase() === 'Verity' || prev.brand !== selectedCatalog.brand)
                  ? { brand: selectedCatalog.brand }
                  : {}),
                ...(isNonCatalog && nextSku.trim().length > 0
                  ? { ai_flags: { ...prev.ai_flags, non_catalog: false } }
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
                  ai_flags: { ...prev.ai_flags, non_catalog: false },
                }));
              } else {
                setFormState((prev) => ({
                  ...prev,
                  sku: '',
                  promote_reference: false,
                  ai_flags: { ...prev.ai_flags, non_catalog: true },
                }));
                recordEdit('sku');
              }
            }}
            promoteReference={Boolean(formState.promote_reference)}
            onTogglePromoteReference={(nextPromote) => {
              setFormState((prev) => ({ ...prev, promote_reference: nextPromote }));
            }}
            effectiveCatalogIdentity={effectiveCatalogIdentity}
            skuMatch={skuMatch}
            confidence={activeSkuConfidence}
            isEdited={Boolean(editedFields.sku)}
            guideUrl={formState.guide_url}
          />

          {/* 2. Multi-SKU Secondary Products (Collapsible Mode) */}
          <ProductTagPicker
            tags={pendingProductTags}
            onChange={setPendingProductTags}
            disabled={isSubmitting}
            primarySku={formState.sku}
            context={skuContext}
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
            isLowConf={isLowConf}
            confidence={{
              category: formState.ai_confidence?.category,
              space: formState.ai_confidence?.space,
              status: formState.ai_confidence?.status,
            }}
            disabled={isSubmitting}
          />

          {/* Post-Production Toggle (Entire card is clickable) */}
          <button
            type="button"
            disabled={isSubmitting}
            onClick={handleTogglePostProduction}
            title="Bật/tắt đánh dấu ảnh cần crop, xoay, chỉnh sửa hậu kỳ (Phím: H)"
            aria-label="Bật/tắt đánh dấu ảnh cần hậu kỳ"
            aria-pressed={Boolean(formState.needs_post_production)}
            className={cn(
              'w-full flex items-center justify-between p-3 rounded-xl border text-[12.5px] transition-all cursor-pointer select-none text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-50',
              formState.needs_post_production
                ? 'border-amber-500/50 bg-amber-500/10'
                : 'border-border/80 bg-surface-2/40 hover:bg-surface-2/70 hover:border-border'
            )}
          >
            <div className="flex items-center gap-2">
              <Wrench className={cn('w-4 h-4', formState.needs_post_production ? 'text-amber-500' : 'text-text-3')} aria-hidden="true" />
              <span className="font-semibold text-text-1">Cần Hậu kỳ</span>
              {formState.needs_post_production ? (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 uppercase">
                  Đang bật
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

          {/* 4. Advanced Metadata Accordion: Brand, Permission, Caption, OCR, Keywords */}
          <AdvancedMetaAccordion
            permission={formState.permission}
            onPermissionChange={(p) => {
              setFormState((prev) => ({ ...prev, permission: p }));
              recordEdit('permission');
            }}
            source={formState.origin_info?.source || 'auto'}
            suggestedCaption={formState.suggested_caption}
            onCaptionChange={(c) => {
              setFormState((prev) => ({ ...prev, suggested_caption: c }));
              recordEdit('suggested_caption');
            }}
            visibleText={formState.visible_text || asset.visible_text || metadataDraft?.visible_text || []}
            keywordsInput={keywordsInput}
            onKeywordsChange={(kw) => {
              setKeywordsInput(kw);
              const parsed = kw.split(',').map((s) => s.trim()).filter(Boolean);
              setFormState((prev) => ({ ...prev, keywords: parsed }));
              recordEdit('keywords');
            }}
            permissions={permissions}
            hasPeople={Boolean(formState.ai_flags?.has_people)}
            internalLabel={internalLabel}
            peopleLabel={peopleLabel}
            editedFields={editedFields}
            disabled={isSubmitting}
          />

          {/* Learning Loop Note */}
          <div className="flex items-center gap-2 text-[10.5px] text-text-3 pt-0.5">
            <span className="w-1.5 h-1.5 rounded-full bg-learn flex-none" />
            <span>Viền cam = trường đã sửa (hệ thống sẽ ghi nhận để tự học)</span>
          </div>
        </div>

        {hasMoreContent && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-surface via-surface/80 to-transparent"
          />
        )}
      </div>

      {/* Sticky Bottom Actions */}
      <div className="p-3 bg-surface border-t border-border select-none shadow-sm space-y-2">
        {lowConfidenceFields.length > 0 && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-warn-border bg-warn-soft/70 px-2.5 py-1.5 text-[11px] leading-snug text-warn animate-fadeIn">
            <div className="flex items-center gap-1.5">
              <ShieldAlert className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
              <span>
                <strong>Cần đối chiếu:</strong> {lowConfidenceFields.join(', ')} dưới {LOW_CONFIDENCE_THRESHOLD}%.
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                CONFIDENCE_FIELD_LABELS.forEach(({ key }) => recordEdit(key));
                handleTriggerApprove();
              }}
              disabled={isSubmitting}
              className="text-[10.5px] font-semibold underline hover:text-warn-hover text-warn flex-none cursor-pointer"
            >
              Bỏ qua & duyệt
            </button>
          </div>
        )}

        <div className="flex items-center gap-2">
          {/* Reject */}
          <button
            type="button"
            onClick={onReject}
            disabled={isSubmitting}
            title="Từ chối ảnh này (Phím: Delete hoặc X)"
            className="flex h-10 items-center justify-center gap-1 rounded-xl border border-border-strong px-3 text-[12.5px] font-semibold text-text-2 transition-all hover:border-bad hover:bg-bad-soft hover:text-bad disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            <span>Từ chối</span>
            <kbd className="text-[10px] text-text-3 font-mono opacity-70">Del</kbd>
          </button>

          <div className="flex-1" />

          {/* Skip / Để sau */}
          <button
            type="button"
            onClick={onSkip}
            disabled={isSubmitting}
            title="Để sau và chuyển ảnh tiếp theo (Phím: S)"
            className="h-10 rounded-xl px-3 text-[12.5px] font-medium text-text-3 transition-all hover:bg-hover hover:text-text-1 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 cursor-pointer"
          >
            <span>Để sau</span>
            <kbd className="text-[10px] text-text-3 font-mono opacity-70">S</kbd>
          </button>

          {/* Approve */}
          <button
            type="button"
            onClick={handleTriggerApprove}
            disabled={isSubmitting}
            aria-busy={isSubmitting}
            title="Duyệt ảnh này (Phím: Space hoặc Enter)"
            className={cn(
              'flex h-10 items-center justify-center gap-2 rounded-xl px-4 text-[13px] font-bold text-white shadow-sm transition-all cursor-pointer',
              isSubmitting
                ? 'bg-verity-hover cursor-wait'
                : 'bg-verity hover:bg-verity-hover active:scale-[0.98]'
            )}
          >
            {isSubmitting ? (
              <>
                <span className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                <span>Đang duyệt…</span>
              </>
            ) : (
              <>
                <Check className="w-4 h-4 stroke-[2.5]" />
                <span>Duyệt & tiếp</span>
                <kbd className="px-1 py-0.2 rounded bg-white/20 text-[10px] font-mono text-white/90">↵</kbd>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Duplicate Compare Modal */}
      <DuplicateCompareModal
        isOpen={isCompareModalOpen}
        onClose={() => setIsCompareModalOpen(false)}
        currentAsset={formState}
        matchedAssets={duplicateMatches || []}
        similarity={duplicateSimilarity}
        initialIndex={compareModalIndex}
        onReplaceOld={(replaceIds) => {
          setDismissDuplicate(true);
          onReplaceDuplicate?.(replaceIds);
        }}
        onKeepBoth={() => {
          setDismissDuplicate(true);
          onKeepDuplicate?.();
        }}
        onDropNew={() => {
          setDismissDuplicate(true);
          onDropDuplicate?.();
        }}
      />
    </div>
  );
}
