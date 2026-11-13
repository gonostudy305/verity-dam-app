'use client';

import React, { useState, useEffect } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import {
  Bot,
  Globe2,
  BookOpen,
  Database,
  ChevronRight,
  ChevronDown,
  SlidersHorizontal,
  Tags,
  Zap,
  Cpu,
  Trash2,
  Layers,
  Brain,
  Wand2,
  ImagePlus,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { AIVisionSettings } from '@/components/settings/AIVisionSettings';
import { CreativeProviderSettings } from '@/components/settings/CreativeProviderSettings';
import { EmbeddingSettings } from '@/components/settings/EmbeddingSettings';
import { EmbeddingRuntimeSettings } from '@/components/settings/EmbeddingRuntimeSettings';
import { AIQualitySettings } from '@/components/settings/AIQualitySettings';
import { WebImageSourcesSettings } from '@/components/settings/WebImageSourcesSettings';
import { SynonymsSettings } from '@/components/settings/SynonymsSettings';
import { IntegrationSettings } from '@/components/settings/IntegrationSettings';
import { MetadataDefaultsSettings } from '@/components/settings/MetadataDefaultsSettings';
import { TaxonomySettings } from '@/components/settings/TaxonomySettings';
import { McpSettings } from '@/components/settings/McpSettings';
import { TrashSettings } from '@/components/settings/TrashSettings';
import { SearchConfigSettings } from '@/components/settings/SearchConfigSettings';
import { UploadContextSettings } from '@/components/settings/UploadContextSettings';

type SettingsTab =
  | 'ai-vision'
  | 'ai-creative'
  | 'ai-embedding'
  | 'embedding-runtime'
  | 'ai-quality'
  | 'web-sources'
  | 'synonyms'
  | 'search-config'
  | 'metadata-defaults'
  | 'taxonomy'
  | 'upload-context'
  | 'integrations'
  | 'mcp'
  | 'trash';

interface SettingsSectionItem {
  id: SettingsTab;
  label: string;
  shortDesc: string;
  icon: React.ElementType;
  tag?: string;
  tagColor?: 'ai' | 'teal' | 'ok' | 'verity' | 'muted';
}

interface SettingsGroup {
  id: string;
  label: string;
  icon: React.ElementType;
  tabs: SettingsSectionItem[];
}

const SECTION_GROUPS: SettingsGroup[] = [
  {
    id: 'ai',
    label: 'Trí tuệ nhân tạo',
    icon: Bot,
    tabs: [
      {
        id: 'ai-vision',
        label: 'AI Vision',
        shortDesc: 'Chat Completions, Vision model, system prompt',
        icon: Bot,
        tag: '9Router',
        tagColor: 'ai',
      },
      {
        id: 'ai-creative',
        label: 'AI Creative',
        shortDesc: 'Provider tạo ảnh, model và API key mã hóa',
        icon: ImagePlus,
        tag: 'Image Gen',
        tagColor: 'ai',
      },
      {
        id: 'ai-embedding',
        label: 'AI Embedding',
        shortDesc: 'Vector embedding + fallback Gemini',
        icon: Zap,
        tag: 'Gemini',
        tagColor: 'ai',
      },
      {
        id: 'embedding-runtime',
        label: 'Embedding Runtime',
        shortDesc: 'Chỉ xem: registry, active space, coverage',
        icon: Layers,
        tag: 'Chỉ xem',
        tagColor: 'muted',
      },
      {
        id: 'ai-quality',
        label: 'Học máy & Chất lượng',
        shortDesc: 'Nhật ký sửa lỗi, kho few-shot, curation SKU',
        icon: Brain,
        tag: 'Chỉ xem',
        tagColor: 'muted',
      },
    ],
  },
  {
    id: 'search',
    label: 'Tìm kiếm & Dữ liệu',
    icon: Globe2,
    tabs: [
      {
        id: 'web-sources',
        label: 'Nguồn ảnh Web & Stock',
        shortDesc: 'Unsplash, Pexels, Google CSE, Brave',
        icon: Globe2,
        tag: 'Free Stock',
        tagColor: 'teal',
      },
      {
        id: 'synonyms',
        label: 'Từ điển đồng nghĩa',
        shortDesc: 'Synonyms cho Semantic Search',
        icon: BookOpen,
        tag: 'Search',
        tagColor: 'verity',
      },
      {
        id: 'search-config',
        label: 'Cấu hình xếp hạng (RRF & MMR)',
        shortDesc: 'Trọng số RRF, MMR lambda, tham số rerank',
        icon: SlidersHorizontal,
        tag: 'Hybrid',
        tagColor: 'verity',
      },
    ],
  },
  {
    id: 'content',
    label: 'Phân loại & Metadata',
    icon: Tags,
    tabs: [
      {
        id: 'metadata-defaults',
        label: 'Metadata mặc định',
        shortDesc: 'Author, Copyright, Credit, mô tả dùng chung',
        icon: Tags,
        tag: 'Dùng chung',
        tagColor: 'verity',
      },
      {
        id: 'taxonomy',
        label: 'Bộ lọc & nhãn',
        shortDesc: 'Loại ảnh, không gian, hãng, quyền dùng',
        icon: SlidersHorizontal,
        tag: 'Config',
        tagColor: 'verity',
      },
      {
        id: 'upload-context',
        label: 'Ngữ cảnh Upload',
        shortDesc: 'Mẫu nhanh & nhóm tag trên trang Upload',
        icon: Wand2,
        tag: 'Config',
        tagColor: 'verity',
      },
    ],
  },
  {
    id: 'system',
    label: 'Hệ thống & Admin',
    icon: Database,
    tabs: [
      {
        id: 'integrations',
        label: 'Trạng thái hệ thống',
        shortDesc: 'DB, R2, AI Vision, Embedding, WordPress',
        icon: Database,
        tag: 'Admin',
        tagColor: 'muted',
      },
      {
        id: 'mcp',
        label: 'API & MCP Server',
        shortDesc: 'Bot accounts, endpoint, cấu hình 1-click',
        icon: Cpu,
        tag: 'MCP',
        tagColor: 'ai',
      },
      {
        id: 'trash',
        label: 'Thùng rác',
        shortDesc: 'Khôi phục hoặc xóa vĩnh viễn ảnh đã xóa',
        icon: Trash2,
        tag: 'Admin',
        tagColor: 'muted',
      },
    ],
  },
];

const ALL_SECTIONS = SECTION_GROUPS.flatMap((g) => g.tabs);

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('ai-vision');
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    ai: true,
    search: true,
    content: true,
    system: true,
  });

  // Load persisted group expansion state from localStorage
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem('verity_settings_open_groups');
      if (stored) {
        setOpenGroups((prev) => ({ ...prev, ...JSON.parse(stored) }));
      }
    } catch {}
  }, []);

  // Auto-expand group containing activeTab
  useEffect(() => {
    const parentGroup = SECTION_GROUPS.find((g) => g.tabs.some((t) => t.id === activeTab));
    if (parentGroup && !openGroups[parentGroup.id]) {
      setOpenGroups((prev) => {
        const next = { ...prev, [parentGroup.id]: true };
        try {
          window.localStorage.setItem('verity_settings_open_groups', JSON.stringify(next));
        } catch {}
        return next;
      });
    }
  }, [activeTab]);

  const toggleGroup = (groupId: string) => {
    setOpenGroups((prev) => {
      const next = { ...prev, [groupId]: !prev[groupId] };
      try {
        window.localStorage.setItem('verity_settings_open_groups', JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const currentSection = ALL_SECTIONS.find((s) => s.id === activeTab) || ALL_SECTIONS[0];

  const selectSection = (section: SettingsTab) => {
    setActiveTab(section);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('section', section);
      window.history.pushState({ section }, '', url);
    }
  };

  useEffect(() => {
    const syncSectionFromUrl = () => {
      const candidate = new URLSearchParams(window.location.search).get('section');
      if (candidate && ALL_SECTIONS.some((section) => section.id === candidate)) {
        setActiveTab(candidate as SettingsTab);
      }
    };
    syncSectionFromUrl();
    window.addEventListener('popstate', syncSectionFromUrl);
    return () => window.removeEventListener('popstate', syncSectionFromUrl);
  }, []);

  return (
    <AppShell
      title="Cài đặt hệ thống"
    >
      <div className="mx-auto max-w-[1240px] p-3 sm:p-6">
        {/* Top summary title */}
        <div className="mb-4 flex flex-col gap-2 border-b border-border pb-4 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-[13px] text-text-3">
            <span className="font-semibold text-text-1">Cài đặt</span>
            <ChevronRight className="w-3.5 h-3.5" />
            <span className="text-verity font-bold">{currentSection.label}</span>
          </div>
          <div className="flex w-fit items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[11.5px] text-text-3">
            <SlidersHorizontal className="w-3 h-3 text-verity" />
            <span>{ALL_SECTIONS.length} mục cấu hình · {SECTION_GROUPS.length} nhóm</span>
          </div>
        </div>

        {/* Master-Detail Layout */}
        <div className="flex flex-col lg:flex-row gap-6 items-start">
          {/* ── Sub-Navigation Menu (Collapsible Groups) ── */}
          <aside className="flex w-full flex-none flex-col gap-2.5 rounded-2xl border border-border bg-surface p-2.5 shadow-xs sm:p-3 lg:w-[270px]">
            <div className="md:hidden">
              <label htmlFor="settings-section-picker" className="mb-1.5 block px-1 text-[11px] font-bold uppercase tracking-wider text-text-3">
                Mục cài đặt
              </label>
              <select
                id="settings-section-picker"
                value={activeTab}
                onChange={(event) => selectSection(event.target.value as SettingsTab)}
                className="min-h-11 w-full rounded-xl border border-border bg-surface-2 px-3 text-[13px] font-semibold text-text-1 outline-none focus:border-verity focus:ring-2 focus:ring-verity/20"
              >
                {SECTION_GROUPS.map((group) => (
                  <optgroup key={group.id} label={group.label}>
                    {group.tabs.map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>

            <div className="hidden md:flex md:flex-col md:gap-2.5">
            <div className="px-2 py-1 text-[11px] font-bold text-text-3 uppercase tracking-wider hidden lg:block border-b border-border-subtle pb-2">
              Danh mục cấu hình
            </div>

            {/* Section Groups */}
            <div className="flex flex-col gap-2">
              {SECTION_GROUPS.map((group) => {
                const isGroupOpen = openGroups[group.id] ?? true;
                const hasActiveChild = group.tabs.some((t) => t.id === activeTab);
                const GroupIcon = group.icon;

                return (
                  <div key={group.id} className="flex flex-col gap-1 pb-1">
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.id)}
                      className="flex items-center justify-between px-2.5 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider text-text-3 hover:text-text-1 hover:bg-surface-2/60 transition-all select-none"
                      aria-expanded={isGroupOpen}
                    >
                      <div className="flex items-center gap-1.5">
                        <GroupIcon className={cn('w-3.5 h-3.5', hasActiveChild ? 'text-verity' : 'text-text-3')} />
                        <span className={cn(hasActiveChild && 'text-text-1 font-extrabold')}>{group.label}</span>
                      </div>
                      <ChevronDown
                        className={cn(
                          'w-3.5 h-3.5 text-text-3 transition-transform duration-200',
                          !isGroupOpen && '-rotate-90'
                        )}
                      />
                    </button>

                    {isGroupOpen && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-1 pl-0 lg:pl-1 animate-fadeIn">
                        {group.tabs.map((sec) => {
                          const Icon = sec.icon;
                          const isActive = activeTab === sec.id;
                          return (
                            <button
                              key={sec.id}
                              type="button"
                              onClick={() => selectSection(sec.id)}
                              className={cn(
                                'w-full flex items-center lg:items-start gap-2.5 p-2 sm:p-2.5 rounded-xl text-left transition-all group relative',
                                isActive
                                  ? 'bg-verity-soft text-text-1 border border-verity-border shadow-xs'
                                  : 'hover:bg-hover text-text-2 border border-transparent'
                              )}
                            >
                              <div
                                className={cn(
                                  'w-7 h-7 rounded-lg flex items-center justify-center flex-none transition-colors',
                                  isActive
                                    ? sec.tagColor === 'ai'
                                      ? 'bg-ai text-white'
                                      : sec.tagColor === 'teal'
                                      ? 'bg-teal text-white'
                                      : sec.tagColor === 'ok'
                                      ? 'bg-ok text-white'
                                      : 'bg-verity text-white'
                                    : 'bg-surface-2 text-text-3 group-hover:text-text-1'
                                )}
                              >
                                <Icon className="w-3.5 h-3.5" />
                              </div>

                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-1">
                                  <span className={cn('text-[12.5px] font-bold truncate', isActive ? 'text-text-1' : 'text-text-2 group-hover:text-text-1')}>
                                    {sec.label}
                                  </span>
                                  {sec.tag && (
                                    <span
                                      className={cn(
                                        'px-1.5 py-0.2 rounded-full text-[9.5px] font-mono font-semibold flex-none hidden xl:inline-block',
                                        isActive
                                          ? 'bg-surface text-text-1 border border-border'
                                          : 'bg-surface-2 text-text-3'
                                      )}
                                    >
                                      {sec.tag}
                                    </span>
                                  )}
                                </div>
                                <p className="text-[10.5px] text-text-3 truncate mt-0.5 hidden lg:block">
                                  {sec.shortDesc}
                                </p>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            </div>
          </aside>

          {/* ── Right Content Panel (Flex-1) ── */}
          <main className="flex-1 min-w-0 w-full">
            {activeTab === 'ai-vision' && <AIVisionSettings />}
            {activeTab === 'ai-creative' && <CreativeProviderSettings />}
            {activeTab === 'ai-embedding' && <EmbeddingSettings />}
            {activeTab === 'embedding-runtime' && <EmbeddingRuntimeSettings />}
            {activeTab === 'ai-quality' && <AIQualitySettings />}
            {activeTab === 'web-sources' && <WebImageSourcesSettings />}
            {activeTab === 'synonyms' && <SynonymsSettings />}
            {activeTab === 'search-config' && <SearchConfigSettings />}
            {activeTab === 'metadata-defaults' && <MetadataDefaultsSettings />}
            {activeTab === 'taxonomy' && <TaxonomySettings />}
            {activeTab === 'upload-context' && <UploadContextSettings />}
            {activeTab === 'integrations' && <IntegrationSettings />}
            {activeTab === 'mcp' && <McpSettings />}
            {activeTab === 'trash' && <TrashSettings />}
          </main>
        </div>
      </div>
    </AppShell>
  );
}
