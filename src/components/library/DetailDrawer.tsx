'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MediaAsset, MediaAssetProductLink, CropConfig, MediaPermission } from '@/types/media';
import {
  X,
  Download,
  Trash2,
  Loader2,
  Clipboard,
  Link2,
  Maximize2,
  Pencil,
  Flag,
  AlertTriangle,
  Check,
} from 'lucide-react';
import { formatDate } from '@/lib/utils';
import { useToast } from '@/components/common/Toast';
import { ImageCropperModal } from '@/components/common/ImageCropperModal';
import { ReportIssueModal } from './ReportIssueModal';
import { cn } from '@/lib/utils';
import { taxonomyLabel } from '@/config/taxonomy';
import { useTaxonomy } from '@/hooks/useTaxonomy';
import { apiRequest } from '@/lib/client/api';
import { useImageExport, type ExportFormat } from '@/hooks/useImageExport';

// Sub-components
import { DrawerProductHero } from './drawer/DrawerProductHero';
import { DrawerCropBar } from './drawer/DrawerCropBar';
import { DrawerTaxonomyBadges } from './drawer/DrawerTaxonomyBadges';
import { DrawerContentAI } from './drawer/DrawerContentAI';
import { DrawerAdvancedMeta } from './drawer/DrawerAdvancedMeta';
import { ImageSaveAsModal } from './drawer/ImageSaveAsModal';

interface CatalogProduct {
  primary_sku: string;
  code?: string | null;
  display_name: string;
  brand?: string | null;
  model_name?: string | null;
  category?: string | null;
  catalog_sku_kind?: string | null;
}

interface OpenReportItem {
  id: string;
  report_reason: string;
  report_note: string | null;
  created_at: string;
  reported_by_name?: string | null;
}

const REPORT_REASON_LABELS: Record<string, string> = {
  wrong_sku: 'Sai mã SKU',
  wrong_recognition: 'Nhận diện sai sản phẩm',
  wrong_url: 'Sai đường dẫn URL',
  other: 'Lý do khác',
};

interface DetailDrawerProps {
  asset: MediaAsset | null;
  onClose: () => void;
  onAssetUpdated?: (updatedAsset: MediaAsset) => void;
  onAssetDeleted?: (assetId: string) => void;
  className?: string;
}

export function DetailDrawer({
  asset,
  onClose,
  onAssetUpdated,
  onAssetDeleted,
  className,
}: DetailDrawerProps) {
  const { showToast } = useToast();
  const { taxonomy } = useTaxonomy();
  const [isCropperOpen, setIsCropperOpen] = useState(false);
  const [currentRole, setCurrentRole] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [cropperInitialPreset, setCropperInitialPreset] = useState('1:1');
  const [localCropConfigs, setLocalCropConfigs] = useState<Record<string, CropConfig>>(asset?.crop_configs || {});
  const [isSaveAsOpen, setIsSaveAsOpen] = useState(false);

  // Orchestrated drawer transition state (transitions-dev)
  const [isOpen, setIsOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    // The drawer is always mounted (LibraryView renders it unconditionally
    // and it returns null when there's no asset), so this must re-arm on
    // every new asset -- not just the first mount -- otherwise `isClosing`
    // stays stuck true from the previous close and the backdrop renders
    // invisible (opacity via .is-closing) yet still blocks every click as a
    // full-screen overlay, making the whole page look frozen.
    if (!asset) return;
    setIsClosing(false);
    const frame = requestAnimationFrame(() => setIsOpen(true));
    return () => cancelAnimationFrame(frame);
  }, [asset?.id]);

  const handleDismiss = useCallback(() => {
    if (isClosing) return;
    setIsClosing(true);
    setIsOpen(false);
    setTimeout(() => {
      onClose();
    }, 200);
  }, [isClosing, onClose]);

  // Catalog identity lookup
  const [catalogProduct, setCatalogProduct] = useState<CatalogProduct | null>(null);

  // Product entity relations
  const [productActionId, setProductActionId] = useState<string | null>(null);

  // UX states: Lightbox preview
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);

  // Issue report state
  const [isReportOpen, setIsReportOpen] = useState(false);

  // Keyboard: Escape closes drawer smoothly when no sub-modal is open
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isCropperOpen && !isLightboxOpen && !isReportOpen && !isSaveAsOpen) {
        handleDismiss();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleDismiss, isCropperOpen, isLightboxOpen, isReportOpen, isSaveAsOpen]);

  // Title editing state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState(asset?.title || '');
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Needs post-production flag state
  const [needsPostProduction, setNeedsPostProduction] = useState<boolean>(Boolean(asset?.needs_post_production));
  const [isUpdatingPostProduction, setIsUpdatingPostProduction] = useState(false);

  // Permission toggle state
  const [isUpdatingPermission, setIsUpdatingPermission] = useState(false);

  // Open reports state for in-situ review
  const [openReports, setOpenReports] = useState<OpenReportItem[]>([]);
  const [isLoadingReports, setIsLoadingReports] = useState(false);
  const [isResolvingReports, setIsResolvingReports] = useState(false);

  // SKU update state (must be declared before early return to satisfy Rules of Hooks)
  const [isUpdatingSku, setIsUpdatingSku] = useState(false);

  useEffect(() => {
    setNeedsPostProduction(Boolean(asset?.needs_post_production));
  }, [asset?.id, asset?.needs_post_production]);

  // Load open reports for in-situ review when drawer displays an asset with open reports
  useEffect(() => {
    if (!asset?.id || !asset.has_open_report) {
      setOpenReports([]);
      return;
    }
    let active = true;
    setIsLoadingReports(true);
    apiRequest<{ success: boolean; data: OpenReportItem[] }>(
      `/api/asset-reports?asset_id=${asset.id}`
    )
      .then((res) => {
        if (active && res.success && Array.isArray(res.data)) {
          setOpenReports(res.data);
        }
      })
      .catch(() => {
        if (active) setOpenReports([]);
      })
      .finally(() => {
        if (active) setIsLoadingReports(false);
      });
    return () => {
      active = false;
    };
  }, [asset?.id, asset?.has_open_report]);

  useEffect(() => {
    setTitleInput(asset?.title || '');
    setIsEditingTitle(false);
  }, [asset?.id, asset?.title]);

  useEffect(() => {
    if (isEditingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [isEditingTitle]);

  const {
    isExporting,
    exportingType,
    exportFormatted,
    exportOriginal,
    exportZalo,
    exportCrop,
    copyImageToClipboard,
  } = useImageExport();

  useEffect(() => {
    if (asset?.crop_configs) {
      setLocalCropConfigs(asset.crop_configs);
    } else {
      setLocalCropConfigs({});
    }
  }, [asset]);

  useEffect(() => {
    let active = true;
    if (!asset) {
      setCurrentRole(null);
      return () => { active = false; };
    }
    apiRequest<{ authenticated: boolean; user: { role: string } | null }>('/api/auth/session')
      .then((response) => {
        if (active) setCurrentRole(response.authenticated ? response.user?.role || null : null);
      })
      .catch(() => {
        if (active) setCurrentRole(null);
      });
    return () => { active = false; };
  }, [asset?.id]);

  // Dynamic catalog lookup for product display name and model name
  useEffect(() => {
    const rawSku = asset?.sku?.trim();
    if (!rawSku || rawSku.length < 2) {
      setCatalogProduct(null);
      return;
    }

    let active = true;
    apiRequest<{ data: CatalogProduct | null }>(
      `/api/catalog/lookup?sku=${encodeURIComponent(rawSku)}`
    )
      .then((res) => {
        if (active) {
          setCatalogProduct(res?.data || null);
        }
      })
      .catch(() => {
        if (active) setCatalogProduct(null);
      });

    return () => {
      active = false;
    };
  }, [asset?.sku]);

  // Reset drawer interactive states when selected asset changes
  useEffect(() => {
    setIsLightboxOpen(false);
  }, [asset?.id]);

  // Lightbox keyboard dismissal
  useEffect(() => {
    if (!isLightboxOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsLightboxOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isLightboxOpen]);

  const handleTogglePostProduction = async () => {
    if (!asset || isUpdatingPostProduction) return;
    const isReviewerOrAdmin = currentRole === 'reviewer' || currentRole === 'admin';
    if (!isReviewerOrAdmin) {
      showToast('Chỉ Reviewer hoặc Admin mới có quyền đổi cờ Hậu kỳ.', 'warn');
      return;
    }

    const previousValue = needsPostProduction;
    const nextValue = !previousValue;
    setNeedsPostProduction(nextValue);
    setIsUpdatingPostProduction(true);

    try {
      const response = await apiRequest<{ success: boolean; data: MediaAsset }>(`/api/media/${asset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ needs_post_production: nextValue }),
      });
      if (response.success && response.data) {
        onAssetUpdated?.(response.data);
        showToast(
          nextValue ? 'Đã đánh dấu ảnh cần Hậu kỳ.' : 'Đã bỏ đánh dấu cần Hậu kỳ.',
          'success'
        );
      } else {
        throw new Error('Cập nhật thất bại');
      }
    } catch (error) {
      setNeedsPostProduction(previousValue);
      showToast(error instanceof Error ? error.message : 'Không thể cập nhật cờ Hậu kỳ. Vui lòng thử lại.', 'warn');
    } finally {
      setIsUpdatingPostProduction(false);
    }
  };

  // Hotkey 'h' or 'H' to toggle post-production for reviewers/admins
  useEffect(() => {
    if (!asset) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'h' || e.key === 'H') {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          return;
        }
        if (isCropperOpen || isLightboxOpen || isReportOpen || isSaveAsOpen || isEditingTitle) {
          return;
        }
        if (currentRole === 'reviewer' || currentRole === 'admin') {
          e.preventDefault();
          handleTogglePostProduction();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [asset, isCropperOpen, isLightboxOpen, isReportOpen, isSaveAsOpen, isEditingTitle, currentRole, needsPostProduction, isUpdatingPostProduction]);

  if (!asset) return null;

  const categoryLabel = taxonomyLabel(taxonomy, 'category', asset.category, asset.category);
  const spaceLabel = taxonomyLabel(taxonomy, 'space', asset.space, asset.space || '');
  const statusLabel = taxonomyLabel(taxonomy, 'status', asset.status, asset.status);

  const handleCopyLink = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }
      let copyUrl = asset.file_url || asset.thumbnail_url || '';
      if (copyUrl.startsWith('/')) {
        copyUrl = `${window.location.origin}${copyUrl}`;
      }
      await navigator.clipboard.writeText(copyUrl);
      showToast('Đã sao chép đường dẫn ảnh chất lượng cao', 'success');
    } catch {
      showToast('Không thể sao chép link ảnh. Hãy kiểm tra quyền trình duyệt.', 'warn');
    }
  };

  const handleDelete = async () => {
    if (!asset || currentRole !== 'admin' || isDeleting) return;
    if (!window.confirm(`Đưa "${asset.title || asset.id}" vào thùng rác? Ảnh sẽ bị ẩn khỏi Thư viện và hàng chờ duyệt.`)) return;

    setIsDeleting(true);
    try {
      await apiRequest(`/api/media/${asset.id}`, { method: 'DELETE' });
      onAssetDeleted?.(asset.id);
      showToast('Đã đưa ảnh vào thùng rác.', 'success');
      handleDismiss();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể xóa ảnh.', 'warn');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleProductAction = async (link: MediaAssetProductLink, action: 'confirm' | 'reject' | 'set_primary') => {
    if (!asset || productActionId) return;
    setProductActionId(link.id);
    try {
      await apiRequest(`/api/media/${asset.id}/products/${link.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const nextProducts = (asset.products || []).map((p) => {
        if (action === 'set_primary' && p.id !== link.id && p.role === 'primary' && p.review_state !== 'rejected') {
          return { ...p, role: 'secondary' as const };
        }
        if (p.id !== link.id) return p;
        if (action === 'confirm') return { ...p, review_state: 'confirmed' as const };
        if (action === 'reject') return { ...p, review_state: 'rejected' as const };
        return { ...p, role: 'primary' as const, review_state: 'confirmed' as const };
      });
      onAssetUpdated?.({ ...asset, products: nextProducts });
      showToast(
        action === 'confirm'
          ? 'Đã xác nhận sản phẩm liên quan.'
          : action === 'reject'
            ? 'Đã từ chối liên kết sản phẩm này.'
            : 'Đã đặt làm sản phẩm chính.',
        'success'
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể cập nhật liên kết sản phẩm.', 'warn');
    } finally {
      setProductActionId(null);
    }
  };


  const handleSkuChange = async (nextSku: string) => {
    if (!asset || isUpdatingSku) return;
    const trimmed = nextSku.trim();
    if (trimmed === (asset.sku || '').trim()) return;

    setIsUpdatingSku(true);
    try {
      const res = await apiRequest<{ success: boolean; data: MediaAsset }>(`/api/media/${asset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: trimmed }),
      });
      if (res.success && res.data) {
        onAssetUpdated?.(res.data);
        showToast(`Đã đổi SKU sang "${trimmed}"`, 'success');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể cập nhật SKU.', 'warn');
      throw error;
    } finally {
      setIsUpdatingSku(false);
    }
  };

  const handleSaveTitle = async () => {
    if (!asset || isSavingTitle) return;
    const trimmed = titleInput.trim();
    if (trimmed === (asset.title || '').trim()) {
      setIsEditingTitle(false);
      return;
    }
    setIsSavingTitle(true);
    try {
      const res = await apiRequest<{ success: boolean; data: MediaAsset }>(`/api/media/${asset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      });
      const updated = res?.data || { ...asset, title: trimmed };
      onAssetUpdated?.(updated);
      showToast('Đã cập nhật tiêu đề thành công', 'success');
      setIsEditingTitle(false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể cập nhật tiêu đề.', 'warn');
    } finally {
      setIsSavingTitle(false);
    }
  };

  const handleTogglePermission = async () => {
    if (!asset || isUpdatingPermission) return;
    const isReviewerOrAdmin = currentRole === 'reviewer' || currentRole === 'admin';
    if (!isReviewerOrAdmin) {
      showToast('Chỉ Reviewer hoặc Admin mới có quyền đổi phân quyền ảnh.', 'warn');
      return;
    }
    const nextPermission: MediaPermission = asset.permission === 'internal' ? 'public' : 'internal';
    setIsUpdatingPermission(true);
    try {
      const res = await apiRequest<{ success: boolean; data: MediaAsset }>(`/api/media/${asset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permission: nextPermission }),
      });
      if (res.success && res.data) {
        onAssetUpdated?.(res.data);
        showToast(
          nextPermission === 'public'
            ? 'Đã chuyển sang Công khai thành công.'
            : 'Đã chuyển sang Nội bộ thành công.',
          'success'
        );
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể cập nhật quyền ảnh.', 'warn');
    } finally {
      setIsUpdatingPermission(false);
    }
  };

  const handleUpdateContentAI = async (updates: {
    suggested_caption?: string;
    description?: string;
    keywords?: string[];
  }) => {
    if (!asset) return;
    const res = await apiRequest<{ success: boolean; data: MediaAsset }>(`/api/media/${asset.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (res.success && res.data) {
      onAssetUpdated?.(res.data);
    }
  };

  const handleResolveOpenReports = async () => {
    if (!asset || isResolvingReports) return;
    const reportIds = openReports.map((r) => r.id);
    if (!reportIds.length) {
      onAssetUpdated?.({ ...asset, has_open_report: false });
      return;
    }
    setIsResolvingReports(true);
    try {
      const res = await apiRequest<{ success: boolean; data: { updated: number } }>('/api/asset-reports', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_ids: reportIds,
          status: 'resolved',
          resolution_note: 'Đã xử lý trực tiếp từ Drawer chi tiết ảnh',
        }),
      });
      if (res.success) {
        setOpenReports([]);
        onAssetUpdated?.({ ...asset, has_open_report: false });
        showToast('Đã giải quyết và đóng báo lỗi thành công!', 'success');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể đóng báo lỗi.', 'warn');
    } finally {
      setIsResolvingReports(false);
    }
  };

  const handleOpenCropper = (presetId = '1:1') => {
    setCropperInitialPreset(presetId);
    setIsCropperOpen(true);
  };

  const handleCropSaved = (presetId: string, crop: CropConfig) => {
    setLocalCropConfigs((prev) => {
      const updated = {
        ...prev,
        [presetId]: crop,
      };
      if (asset) {
        onAssetUpdated?.({
          ...asset,
          crop_configs: updated,
        });
      }
      return updated;
    });
  };

  const handleQuickExportCrop = async (presetId: '1:1' | '9:16' | '16:9') => {
    if (!asset) return;
    const savedCrop = localCropConfigs[presetId];
    const res = await exportCrop(asset, presetId, savedCrop, 'webp');
    showToast(res.message, res.success ? 'success' : 'warn');
  };

  const handleConfirmDownload = async (customFilename: string, format: ExportFormat) => {
    if (!asset) return;
    const res = await exportFormatted(asset, format, customFilename);
    showToast(res.message, res.success ? 'success' : 'warn');
  };

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={handleDismiss}
        className={cn(
          't-drawer-backdrop fixed inset-0 z-40 bg-black/40 backdrop-blur-xs cursor-pointer',
          isOpen && 'is-open',
          isClosing && 'is-closing'
        )}
      />

      {/* Drawer Body (Bento Grid & Action Dock) */}
      <aside
        className={cn(
          't-drawer-panel fixed right-0 top-0 bottom-0 z-50 w-full sm:max-w-[560px] md:max-w-[620px] bg-surface border-l border-border shadow-drawer flex flex-col overflow-hidden select-none',
          isOpen && 'is-open',
          isClosing && 'is-closing',
          className
        )}
      >
        {/* Sticky Header Toolbar */}
        <div className="flex min-h-14 items-center justify-between gap-3 border-b border-border bg-surface-2/80 backdrop-blur-md px-4 sm:px-5 shrink-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="font-mono text-[13px] font-bold text-text-1 px-2 py-0.5 rounded-lg bg-surface border border-border shrink-0 shadow-2xs">
              {asset.sku || asset.id.slice(0, 8)}
            </span>
          </div>

          {/* Quick Action Dock */}
          <div className="flex items-center gap-2 shrink-0">
            {/* 1. Copy Image Bitmap */}
            <button
              type="button"
              onClick={async () => {
                const res = await copyImageToClipboard(asset);
                showToast(res.message, res.success ? 'success' : 'warn');
              }}
              disabled={isExporting}
              className="flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[11.5px] font-semibold text-text-1 shadow-2xs transition-all hover:bg-surface-2 hover:border-border-strong disabled:opacity-60 cursor-pointer"
              title="Sao chép ảnh bitmap (Ctrl+V dán ngay vào Zalo / Messenger)"
            >
              {exportingType === 'clipboard' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-verity" />
              ) : (
                <Clipboard className="w-3.5 h-3.5 text-verity" />
              )}
              <span className="hidden sm:inline">Copy ảnh</span>
            </button>

            {/* 2. Download / Save As Dialog */}
            <button
              type="button"
              onClick={() => setIsSaveAsOpen(true)}
              className="flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-lg bg-verity px-3.5 text-[11.5px] font-bold text-white shadow-2xs transition-all hover:bg-verity-hover active:scale-[0.98] cursor-pointer"
              title="Tải ảnh về máy (Lựa chọn định dạng & Đổi tên file)"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Tải ảnh</span>
            </button>

            {/* 3. Copy Link */}
            <button
              type="button"
              onClick={handleCopyLink}
              aria-label="Sao chép link ảnh"
              className="grid h-10 w-10 place-items-center rounded-lg border border-border bg-surface text-text-2 shadow-2xs transition-all hover:bg-surface-2 hover:text-text-1 cursor-pointer"
              title="Sao chép đường dẫn ảnh CDN"
            >
              <Link2 className="w-3.5 h-3.5" />
            </button>

            {/* 4. Report Issue (All roles) */}
            <button
              type="button"
              onClick={() => setIsReportOpen(true)}
              aria-label="Báo lỗi ảnh"
              className="inline-flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-text-2 shadow-2xs transition-all hover:bg-amber-500/10 hover:border-amber-500/30 hover:text-amber-600 dark:hover:text-amber-400 cursor-pointer sm:px-3"
              title="Báo lỗi ảnh (sai SKU, nhận diện sai...)"
            >
              <Flag className="w-3.5 h-3.5" />
              <span className="hidden text-[11px] font-semibold sm:inline">Báo lỗi</span>
            </button>

            {/* 5. Delete (Admin) */}
            {currentRole === 'admin' && (
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={isDeleting}
                aria-label="Đưa ảnh vào thùng rác"
                className="ml-1 grid h-10 w-10 place-items-center rounded-lg border border-red-200/80 bg-red-50 dark:bg-red-950/30 text-red-600 shadow-2xs transition-all hover:bg-red-100 disabled:opacity-50 cursor-pointer"
                title="Đưa vào thùng rác"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}

            <div className="h-4 w-px bg-border mx-0.5" aria-hidden="true" />

            {/* Close Button */}
            <button
              type="button"
              onClick={handleDismiss}
              aria-label="Đóng chi tiết asset"
              className="grid h-10 w-10 place-items-center rounded-lg text-text-3 transition-colors hover:bg-hover hover:text-text-1 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Scrollable Bento Body */}
        <div className="flex-1 space-y-3.5 overflow-y-auto p-4 pb-8 sm:p-5">
          {/* Open Issue Report Banner with In-situ Details & 1-Click Resolve */}
          {asset.has_open_report && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 dark:bg-amber-500/15 p-3.5 space-y-2 text-amber-900 dark:text-amber-200 shadow-xs">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <span className="font-bold text-[12.5px] text-amber-900 dark:text-amber-100">
                    Ảnh này đang có báo lỗi cần xử lý
                  </span>
                  {openReports.length > 0 && (
                    <span className="px-1.5 py-0.5 rounded-full bg-amber-500/20 text-[11px] font-bold text-amber-800 dark:text-amber-300">
                      {openReports.length}
                    </span>
                  )}
                </div>

                {(currentRole === 'reviewer' || currentRole === 'admin') && (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => void handleResolveOpenReports()}
                      disabled={isResolvingReports}
                      className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[11.5px] font-semibold transition-all shadow-xs cursor-pointer disabled:opacity-50"
                      title="Đánh dấu tất cả báo lỗi của ảnh này đã được sửa và đóng lại"
                    >
                      {isResolvingReports ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Check className="w-3.5 h-3.5" />
                      )}
                      <span>Đã sửa & Đóng lỗi</span>
                    </button>

                    <a
                      href="/reports"
                      className="px-2 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-[11px] font-medium text-amber-800 dark:text-amber-300 transition-colors"
                      title="Xem trên trang quản lý báo cáo"
                    >
                      Xem tất cả →
                    </a>
                  </div>
                )}
              </div>

              {/* Detailed List of User Feedback Notes */}
              {openReports.length > 0 && (
                <div className="space-y-1.5 pt-1 border-t border-amber-500/20 text-[12px]">
                  {openReports.map((report) => (
                    <div
                      key={report.id}
                      className="p-2 rounded-lg bg-surface/70 border border-amber-500/20 flex flex-col gap-0.5"
                    >
                      <div className="flex items-center justify-between text-[11px] text-text-3 font-medium">
                        <span className="font-semibold text-amber-800 dark:text-amber-300">
                          {REPORT_REASON_LABELS[report.report_reason] || report.report_reason}
                        </span>
                        {report.reported_by_name && (
                          <span>bởi {report.reported_by_name}</span>
                        )}
                      </div>
                      {report.report_note && (
                        <p className="text-[12px] text-text-1 font-medium italic">
                          &ldquo;{report.report_note}&rdquo;
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 1. Title (Inline Editable) */}
          <div className="space-y-1">
            {isEditingTitle ? (
              <div className="flex items-center gap-2">
                <input
                  ref={titleInputRef}
                  type="text"
                  value={titleInput}
                  onChange={(e) => setTitleInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleSaveTitle();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setTitleInput(asset.title || '');
                      setIsEditingTitle(false);
                    }
                  }}
                  onBlur={() => void handleSaveTitle()}
                  disabled={isSavingTitle}
                  placeholder="Nhập tiêu đề ảnh..."
                  className="flex-1 px-3 py-1.5 rounded-xl border border-verity bg-surface text-[13.5px] font-semibold text-text-1 outline-none shadow-xs focus:ring-2 focus:ring-verity/20 transition-all"
                />
                {isSavingTitle && <Loader2 className="w-4 h-4 animate-spin text-verity flex-none" />}
              </div>
            ) : (
              <div
                onClick={() => setIsEditingTitle(true)}
                className="group flex items-center justify-between gap-2 p-1 -m-1 rounded-lg hover:bg-surface-2 cursor-pointer transition-colors"
                title="Nhấp để sửa tiêu đề ảnh"
              >
                <h3 className="text-[13.5px] font-semibold text-text-1 leading-snug break-words flex-1">
                  {asset.title ? (
                    asset.title
                  ) : (
                    <span className="text-text-3 italic font-normal">Chưa có tiêu đề (nhấp để thêm)</span>
                  )}
                </h3>
                <Pencil className="w-3.5 h-3.5 text-text-3 opacity-0 group-hover:opacity-100 transition-opacity flex-none" />
              </div>
            )}
          </div>

          {/* 2. Visual Showcase: High-Res Image Preview */}
          <div className="relative group rounded-2xl overflow-hidden border border-border bg-black/5 flex items-center justify-center shadow-xs min-h-[180px] max-h-[320px]">
            <img
              src={asset.thumbnail_url || asset.file_url}
              alt={asset.title}
              className="w-full h-auto object-contain max-h-[320px] cursor-zoom-in"
              onClick={() => setIsLightboxOpen(true)}
              title="Nhấp để xem ảnh toàn màn hình"
            />
            <button
              type="button"
              onClick={() => setIsLightboxOpen(true)}
              className="absolute top-2.5 right-2.5 w-7 h-7 rounded-lg bg-black/60 hover:bg-black/80 text-white grid place-items-center opacity-0 group-hover:opacity-100 transition-all shadow-md backdrop-blur-xs cursor-pointer"
              title="Xem toàn màn hình"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* 3. Bento Block: Quick Crop & Ratio Bar */}
          <DrawerCropBar
            asset={asset}
            localCropConfigs={localCropConfigs}
            onOpenCropper={handleOpenCropper}
            onQuickExportCrop={handleQuickExportCrop}
            isExporting={isExporting}
          />

          {/* 4. Bento Block: Product Identity & Relations */}
          <DrawerProductHero
            currentSku={asset.sku}
            catalogProduct={catalogProduct}
            products={asset.products}
            onProductAction={handleProductAction}
            productActionId={productActionId}
            canEditSku={currentRole === 'reviewer' || currentRole === 'admin'}
            onSkuChange={handleSkuChange}
            isUpdatingSku={isUpdatingSku}
          />

          {/* 5. Bento Block: Taxonomy, Context & Post-Production Badges */}
          <DrawerTaxonomyBadges
            asset={asset}
            categoryLabel={categoryLabel}
            spaceLabel={spaceLabel}
            statusLabel={statusLabel}
            needsPostProduction={needsPostProduction}
            canEditPostProduction={currentRole === 'reviewer' || currentRole === 'admin'}
            isUpdatingPostProduction={isUpdatingPostProduction}
            onTogglePostProduction={handleTogglePostProduction}
            canEditPermission={currentRole === 'reviewer' || currentRole === 'admin'}
            isUpdatingPermission={isUpdatingPermission}
            onTogglePermission={handleTogglePermission}
          />

          {/* 6. Bento Block: AI Caption & Keywords (Direct In-Situ Editing) */}
          <DrawerContentAI
            caption={asset.suggested_caption}
            description={asset.description}
            keywords={asset.keywords}
            canEdit={currentRole === 'reviewer' || currentRole === 'admin'}
            onUpdate={handleUpdateContentAI}
          />

          {/* 7. Bento Block: Advanced Metadata Accordion */}
          <DrawerAdvancedMeta asset={asset} />
        </div>
      </aside>

      {/* Cropper Modal */}
      {isCropperOpen && (
        <ImageCropperModal
          isOpen={isCropperOpen}
          onClose={() => setIsCropperOpen(false)}
          imageUrl={asset.file_url}
          imageTitle={asset.title}
          initialPresetId={cropperInitialPreset}
          assetId={asset.id}
          savedCropConfigs={localCropConfigs}
          onCropSaved={handleCropSaved}
        />
      )}

      {/* Fullscreen Image Lightbox Modal */}
      {isLightboxOpen && (
        <div
          className="fixed inset-0 z-[100] bg-black/95 backdrop-blur-md flex items-center justify-center p-4 sm:p-8 animate-fadeIn select-none"
          onClick={() => setIsLightboxOpen(false)}
        >
          {/* Top Floating Control Bar */}
          <div className="absolute top-4 left-4 right-4 flex items-center justify-between pointer-events-none z-10">
            <div className="pointer-events-auto flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/60 border border-white/20 text-white backdrop-blur-md text-[12.5px] font-medium shadow-lg max-w-[70%]">
              <span className="font-mono font-bold text-white/90 truncate">{asset.sku || 'Verity'}</span>
              <span className="text-white/40">·</span>
              <span className="truncate text-white/80">{asset.title || 'Xem ảnh phóng to'}</span>
            </div>

            <button
              type="button"
              onClick={() => setIsLightboxOpen(false)}
              className="pointer-events-auto flex items-center gap-1.5 h-10 px-4 rounded-full bg-white/20 hover:bg-white/30 text-white font-semibold text-[13px] backdrop-blur-md transition-all shadow-lg cursor-pointer"
              title="Đóng (Esc)"
            >
              <X className="w-4 h-4" />
              <span>Đóng</span>
            </button>
          </div>

          <img
            src={asset.file_url}
            alt={asset.title}
            className="max-w-[95vw] max-h-[88vh] object-contain rounded-xl shadow-2xl transition-transform"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* Issue Report Modal */}
      {asset && (
        <ReportIssueModal
          assetIds={[asset.id]}
          isOpen={isReportOpen}
          onClose={() => setIsReportOpen(false)}
          onReported={(count) => {
            setIsReportOpen(false);
            showToast(`Đã ghi nhận báo lỗi (${count} ảnh)`, 'success');
          }}
        />
      )}

      {/* Save As Download Modal */}
      {asset && (
        <ImageSaveAsModal
          isOpen={isSaveAsOpen}
          onClose={() => setIsSaveAsOpen(false)}
          asset={asset}
          onConfirmDownload={handleConfirmDownload}
          isExporting={isExporting}
        />
      )}
    </>
  );
}
