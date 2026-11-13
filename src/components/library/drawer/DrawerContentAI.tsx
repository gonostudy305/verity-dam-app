'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  FileText,
  Hash,
  Pencil,
  X,
  Plus,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/common/Toast';

interface DrawerContentAIProps {
  caption?: string;
  description?: string;
  keywords?: string[];
  canEdit?: boolean;
  onUpdate?: (updates: {
    suggested_caption?: string;
    description?: string;
    keywords?: string[];
  }) => Promise<void>;
  className?: string;
}

export function DrawerContentAI({
  caption,
  description,
  keywords = [],
  canEdit = false,
  onUpdate,
  className,
}: DrawerContentAIProps) {
  const { showToast } = useToast();
  const [copiedType, setCopiedType] = useState<'caption' | 'keywords' | 'desc' | null>(null);
  const [isDescOpen, setIsDescOpen] = useState(false);

  // Caption & Description edit state
  const [isEditingContent, setIsEditingContent] = useState(false);
  const [captionInput, setCaptionInput] = useState(caption || '');
  const [descInput, setDescInput] = useState(description || '');
  const [isSavingContent, setIsSavingContent] = useState(false);
  const captionTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Keyword tag edit state
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [newTagInput, setNewTagInput] = useState('');
  const [tagUpdating, setTagUpdating] = useState<string | null>(null);
  const newTagInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCaptionInput(caption || '');
    setDescInput(description || '');
    setIsEditingContent(false);
  }, [caption, description]);

  useEffect(() => {
    if (isEditingContent) {
      captionTextareaRef.current?.focus();
    }
  }, [isEditingContent]);

  useEffect(() => {
    if (isAddingTag) {
      newTagInputRef.current?.focus();
    }
  }, [isAddingTag]);

  const cleanCaption = (caption || '').trim();
  const cleanDesc = (description || '').trim();

  // Check if description is distinct or just a duplicate of caption
  const hasDistinctDescription =
    Boolean(cleanDesc) &&
    cleanDesc.toLowerCase() !== cleanCaption.toLowerCase() &&
    !cleanCaption.toLowerCase().includes(cleanDesc.toLowerCase());

  const handleCopy = async (text: string, type: 'caption' | 'keywords' | 'desc', label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedType(type);
      showToast(`Đã sao chép ${label} vào bộ nhớ tạm!`, 'success');
      setTimeout(() => setCopiedType(null), 2000);
    } catch {
      showToast(`Không thể sao chép ${label}.`, 'warn');
    }
  };

  const handleSaveContent = async () => {
    if (!onUpdate || isSavingContent) return;
    setIsSavingContent(true);
    try {
      await onUpdate({
        suggested_caption: captionInput.trim(),
        description: descInput.trim(),
      });
      setIsEditingContent(false);
      showToast('Đã lưu nội dung AI và mô tả!', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Không thể lưu nội dung.', 'warn');
    } finally {
      setIsSavingContent(false);
    }
  };

  const handleRemoveTag = async (tagToRemove: string) => {
    if (!onUpdate || tagUpdating) return;
    setTagUpdating(tagToRemove);
    try {
      const nextKeywords = keywords.filter((k) => k !== tagToRemove);
      await onUpdate({ keywords: nextKeywords });
      showToast(`Đã xóa từ khóa #${tagToRemove}`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Không thể xóa từ khóa.', 'warn');
    } finally {
      setTagUpdating(null);
    }
  };

  const handleAddTag = async () => {
    const raw = newTagInput.replace(/^#+/, '').trim();
    if (!raw) {
      setIsAddingTag(false);
      setNewTagInput('');
      return;
    }
    if (!onUpdate || tagUpdating) return;

    if (keywords.map((k) => k.toLowerCase()).includes(raw.toLowerCase())) {
      showToast('Từ khóa này đã tồn tại.', 'warn');
      setNewTagInput('');
      setIsAddingTag(false);
      return;
    }

    setTagUpdating('__new__');
    try {
      const nextKeywords = [...keywords, raw];
      await onUpdate({ keywords: nextKeywords });
      setNewTagInput('');
      setIsAddingTag(false);
      showToast(`Đã thêm từ khóa #${raw}`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Không thể thêm từ khóa.', 'warn');
    } finally {
      setTagUpdating(null);
    }
  };

  if (!cleanCaption && !cleanDesc && keywords.length === 0 && !canEdit) {
    return null;
  }

  return (
    <div
      className={cn(
        'rounded-2xl border border-border/80 bg-surface-2/30 p-3.5 space-y-3 transition-all',
        className
      )}
    >
      {/* Header + Quick Copy Caption + Edit Toggle */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Sparkles className="w-3.5 h-3.5 text-verity flex-none" />
          <span className="text-[12px] font-bold text-text-2 tracking-tight">
            Nội dung AI & Đăng bài
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {canEdit && !isEditingContent && (
            <button
              type="button"
              onClick={() => setIsEditingContent(true)}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-surface border border-border hover:border-verity text-text-2 hover:text-verity text-[11px] font-semibold transition-all cursor-pointer shadow-2xs"
              title="Chỉnh sửa trực tiếp caption và mô tả"
            >
              <Pencil className="w-3 h-3 text-text-3" />
              <span>Sửa</span>
            </button>
          )}

          {cleanCaption && !isEditingContent && (
            <button
              type="button"
              onClick={() => handleCopy(cleanCaption, 'caption', 'caption đăng bài')}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface border border-border hover:border-verity text-text-2 hover:text-verity text-[11px] font-semibold transition-all cursor-pointer shadow-2xs"
              title="Sao chép toàn bộ nội dung caption để đăng Facebook/Zalo"
            >
              {copiedType === 'caption' ? (
                <>
                  <Check className="w-3 h-3 text-emerald-500" />
                  <span className="text-emerald-600 dark:text-emerald-400">Đã chép</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  <span>Copy Caption</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Caption Box: View Mode vs Edit Mode */}
      {isEditingContent ? (
        <div className="space-y-2.5 p-3 rounded-xl bg-surface border border-verity/60 shadow-xs">
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[11px] text-text-3 font-medium">
              <span>Caption đăng bài (Facebook / Zalo):</span>
              <span>Ctrl + Enter để lưu</span>
            </div>
            <textarea
              ref={captionTextareaRef}
              rows={3}
              value={captionInput}
              onChange={(e) => setCaptionInput(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void handleSaveContent();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setCaptionInput(caption || '');
                  setDescInput(description || '');
                  setIsEditingContent(false);
                }
              }}
              placeholder="Nhập caption đăng bài..."
              className="w-full px-2.5 py-2 rounded-lg border border-border bg-surface-2/50 text-[12.5px] leading-relaxed text-text-1 outline-none focus:border-verity focus:ring-1 focus:ring-verity transition-all resize-y"
            />
          </div>

          <div className="space-y-1">
            <span className="text-[11px] text-text-3 font-medium">
              Mô tả chi tiết & thông số bổ sung (tùy chọn):
            </span>
            <textarea
              rows={2}
              value={descInput}
              onChange={(e) => setDescInput(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void handleSaveContent();
                }
              }}
              placeholder="Nhập mô tả chi tiết sản phẩm..."
              className="w-full px-2.5 py-2 rounded-lg border border-border bg-surface-2/50 text-[12px] leading-relaxed text-text-2 outline-none focus:border-verity focus:ring-1 focus:ring-verity transition-all resize-y"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-1 border-t border-border/50">
            <button
              type="button"
              onClick={() => {
                setCaptionInput(caption || '');
                setDescInput(description || '');
                setIsEditingContent(false);
              }}
              disabled={isSavingContent}
              className="px-2.5 py-1 rounded-lg text-[11.5px] font-medium text-text-3 hover:text-text-1 hover:bg-surface-2 transition-colors cursor-pointer"
            >
              Hủy
            </button>
            <button
              type="button"
              onClick={() => void handleSaveContent()}
              disabled={isSavingContent}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-verity hover:bg-verity/90 text-white text-[11.5px] font-semibold transition-all cursor-pointer shadow-xs disabled:opacity-50"
            >
              {isSavingContent ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Đang lưu...</span>
                </>
              ) : (
                <span>Lưu thay đổi</span>
              )}
            </button>
          </div>
        </div>
      ) : cleanCaption ? (
        <div
          onClick={() => {
            if (canEdit) setIsEditingContent(true);
          }}
          className={cn(
            'p-3 rounded-xl bg-surface border border-border/70 text-[12.5px] leading-relaxed text-text-1 select-text transition-colors',
            canEdit && 'hover:border-verity/60 hover:bg-surface-2/40 cursor-pointer group relative'
          )}
          title={canEdit ? 'Nhấp để chỉnh sửa caption' : undefined}
        >
          {cleanCaption}
          {canEdit && (
            <span className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-[10px] text-text-3 bg-surface px-1.5 py-0.5 rounded border border-border">
              <Pencil className="w-2.5 h-2.5" />
              <span>Sửa</span>
            </span>
          )}
        </div>
      ) : canEdit ? (
        <button
          type="button"
          onClick={() => setIsEditingContent(true)}
          className="w-full p-3 rounded-xl border border-dashed border-border hover:border-verity text-text-3 hover:text-verity text-[12px] font-medium text-center transition-all bg-surface/50 cursor-pointer"
        >
          + Thêm caption AI & nội dung đăng bài
        </button>
      ) : null}

      {/* Keywords Pills */}
      {(keywords.length > 0 || canEdit) && (
        <div className="space-y-1.5 pt-0.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-text-3 flex items-center gap-1">
              <Hash className="w-3 h-3" />
              <span>Từ khóa ({keywords.length})</span>
            </span>
            {keywords.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  handleCopy(
                    keywords.map((k) => `#${k}`).join(' '),
                    'keywords',
                    'danh sách từ khóa'
                  )
                }
                className="text-[10.5px] text-verity hover:underline font-medium cursor-pointer"
              >
                Chép tất cả hashtag
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {keywords.map((kw, idx) => (
              <div
                key={`${kw}-${idx}`}
                className="group/tag inline-flex items-center rounded-md bg-surface border border-border hover:border-verity text-[11px] font-mono text-text-2 transition-all shadow-2xs"
              >
                <button
                  type="button"
                  onClick={() => handleCopy(`#${kw}`, 'keywords', `#${kw}`)}
                  className="px-2 py-0.5 hover:text-verity transition-colors cursor-pointer"
                  title={`Nhấp để sao chép #${kw}`}
                >
                  #{kw}
                </button>

                {canEdit && (
                  <button
                    type="button"
                    onClick={() => void handleRemoveTag(kw)}
                    disabled={tagUpdating === kw}
                    className="pr-1.5 pl-0.5 py-0.5 text-text-3 hover:text-rose-500 transition-colors cursor-pointer"
                    title={`Xóa tag #${kw}`}
                  >
                    {tagUpdating === kw ? (
                      <Loader2 className="w-2.5 h-2.5 animate-spin text-rose-500" />
                    ) : (
                      <X className="w-3 h-3" />
                    )}
                  </button>
                )}
              </div>
            ))}

            {/* Inline Add Tag */}
            {canEdit && (
              <>
                {isAddingTag ? (
                  <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-surface border border-verity shadow-2xs">
                    <span className="text-[11px] font-mono text-verity font-bold">#</span>
                    <input
                      ref={newTagInputRef}
                      type="text"
                      value={newTagInput}
                      onChange={(e) => setNewTagInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault();
                          void handleAddTag();
                        } else if (e.key === 'Escape') {
                          setIsAddingTag(false);
                          setNewTagInput('');
                        }
                      }}
                      onBlur={() => {
                        if (newTagInput.trim()) {
                          void handleAddTag();
                        } else {
                          setIsAddingTag(false);
                        }
                      }}
                      placeholder="từ khóa..."
                      className="w-20 px-0.5 text-[11px] font-mono text-text-1 bg-transparent outline-none"
                    />
                    {tagUpdating === '__new__' && (
                      <Loader2 className="w-2.5 h-2.5 animate-spin text-verity" />
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setIsAddingTag(true)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-dashed border-border hover:border-verity text-[11px] font-medium text-text-3 hover:text-verity transition-all cursor-pointer bg-surface/50"
                    title="Thêm từ khóa hashtag mới"
                  >
                    <Plus className="w-3 h-3" />
                    <span>Thêm tag</span>
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Collapsible Detailed Description (Only shown when distinct in view mode) */}
      {!isEditingContent && hasDistinctDescription && (
        <div className="pt-2 border-t border-border/50">
          <button
            type="button"
            onClick={() => setIsDescOpen((prev) => !prev)}
            className="w-full flex items-center justify-between py-1 text-[11.5px] font-medium text-text-3 hover:text-text-1 transition-colors cursor-pointer"
          >
            <span className="flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5" />
              <span>Mô tả chi tiết & thông số bổ sung</span>
            </span>
            {isDescOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>

          {isDescOpen && (
            <div className="mt-2 p-3 rounded-xl bg-surface border border-border/60 text-[12px] leading-relaxed text-text-2 select-text animate-fadeIn">
              {cleanDesc}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
