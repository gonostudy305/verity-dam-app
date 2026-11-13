'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  Plus,
  Save,
  Tags,
  Layers,
  Home,
  CheckCircle2,
  Building2,
  Lock,
  ShieldCheck,
  Search,
  Trash2,
  AlertCircle,
  Eye,
  EyeOff,
  Cpu,
} from 'lucide-react';

import { useToast } from '@/components/common/Toast';
import { ClientApiError, apiRequest } from '@/lib/client/api';
import { DEFAULT_TAXONOMY, type TaxonomyConfig, type TaxonomyFacet, type TaxonomyItem } from '@/config/taxonomy';
import { useTaxonomy } from '@/hooks/useTaxonomy';
import { cn } from '@/lib/utils';

type EditableOption = TaxonomyItem & { facet: TaxonomyFacet; isNew?: boolean };

interface FacetDef {
  facet: TaxonomyFacet;
  label: string;
  description: string;
  canAdd: boolean;
  icon: React.ElementType;
}

const FACETS: FacetDef[] = [
  {
    facet: 'category',
    label: 'Loại ảnh',
    description: 'Giá trị category dùng cho AI phân loại và bộ lọc thư viện.',
    canAdd: true,
    icon: Layers,
  },
  {
    facet: 'space',
    label: 'Không gian',
    description: 'Không gian / cảnh chụp công trình được phép gán.',
    canAdd: true,
    icon: Home,
  },
  {
    facet: 'status',
    label: 'Tình trạng',
    description: 'Trạng thái vòng đời và tiến độ hoàn thiện của ảnh.',
    canAdd: true,
    icon: CheckCircle2,
  },
  {
    facet: 'brand',
    label: 'Thương hiệu',
    description: 'Hãng sản xuất dùng cho bộ lọc và ngữ cảnh upload.',
    canAdd: true,
    icon: Building2,
  },
  {
    facet: 'permission',
    label: 'Quyền dùng',
    description: 'Giá trị Public / Internal trong cơ sở dữ liệu media_assets.',
    canAdd: false,
    icon: Lock,
  },
  {
    facet: 'safety',
    label: 'Cờ an toàn',
    description: 'Các cờ boolean của bộ lọc (nhận diện người, khuôn mặt...).',
    canAdd: false,
    icon: ShieldCheck,
  },
  {
    facet: 'ecosystem',
    label: 'Hệ sinh thái',
    description: 'Nền tảng / chuẩn kết nối tương thích (Apple HomeKit, Matter, Google Home...).',
    canAdd: true,
    icon: Cpu,
  },
];

function flattenConfig(config: TaxonomyConfig): EditableOption[] {
  return FACETS.flatMap(({ facet }) =>
    (config[facet] || []).map((item) => ({ ...item, facet, isNew: false }))
  );
}

function toConfigOptions(options: EditableOption[]) {
  return options.map(({ facet, value, label, sortOrder, isActive }) => ({
    facet,
    value,
    label,
    sortOrder: sortOrder ?? 100,
    isActive: isActive !== false,
  }));
}

export function TaxonomySettings() {
  const { showToast } = useToast();
  const { reload } = useTaxonomy();
  const [options, setOptions] = useState<EditableOption[]>(flattenConfig({ ...DEFAULT_TAXONOMY }));
  const [activeFacet, setActiveFacet] = useState<TaxonomyFacet>('category');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ data: TaxonomyConfig; mode?: 'demo' }>('/api/settings/taxonomy')
      .then(({ data, mode }) => {
        if (cancelled) return;
        if (mode === 'demo') setDemoMode(true);
        setOptions(flattenConfig(data));
        setDirty(false);
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof ClientApiError && error.status === 403) {
          setForbidden(true);
          return;
        }
        showToast(error instanceof Error ? error.message : 'Không tải được cấu hình bộ lọc.', 'warn');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showToast]);

  const currentFacetDef = useMemo(
    () => FACETS.find((f) => f.facet === activeFacet) || FACETS[0],
    [activeFacet]
  );

  const facetCounts = useMemo(() => {
    const counts: Record<TaxonomyFacet, number> = {
      category: 0,
      space: 0,
      status: 0,
      brand: 0,
      permission: 0,
      safety: 0,
      ecosystem: 0,
    };
    for (const opt of options) {
      if (counts[opt.facet] !== undefined) {
        counts[opt.facet]++;
      }
    }
    return counts;
  }, [options]);

  const activeOptions = useMemo(() => {
    return options.filter((item) => item.facet === activeFacet);
  }, [options, activeFacet]);

  const filteredOptions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return activeOptions;
    return activeOptions.filter(
      (opt) =>
        opt.label.toLowerCase().includes(query) ||
        opt.value.toLowerCase().includes(query)
    );
  }, [activeOptions, searchQuery]);

  const updateOption = (indexInAll: number, patch: Partial<EditableOption>) => {
    setOptions((current) =>
      current.map((item, idx) => (idx === indexInAll ? { ...item, ...patch } : item))
    );
    setDirty(true);
  };

  const addOption = (facet: TaxonomyFacet) => {
    setOptions((current) => [
      ...current,
      { facet, value: '', label: '', sortOrder: 100, isActive: true, isNew: true },
    ]);
    setDirty(true);
    setSearchQuery('');
  };

  const removeOption = (indexInAll: number) => {
    setOptions((current) => current.filter((_, idx) => idx !== indexInAll));
    setDirty(true);
  };

  const handleSave = async () => {
    if (demoMode) {
      showToast('Đang ở chế độ demo; cấu hình chưa được ghi vào PostgreSQL.', 'warn');
      return;
    }
    const invalid = options.some((option) => !option.value.trim() || !option.label.trim());
    if (invalid) {
      showToast('Mỗi tùy chọn phải có stable value và nhãn hiển thị.', 'warn');
      return;
    }
    setSaving(true);
    try {
      const response = await apiRequest<{ data: TaxonomyConfig }>('/api/settings/taxonomy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ options: toConfigOptions(options) }),
      });
      setOptions(flattenConfig(response.data));
      setDirty(false);
      reload();
      showToast('Đã lưu cấu hình bộ lọc cho toàn công ty.', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể lưu cấu hình bộ lọc.', 'warn');
    } finally {
      setSaving(false);
    }
  };

  if (forbidden) {
    return (
      <div className="p-6 rounded-2xl border border-warn-border bg-warn-soft text-warn font-medium">
        Chỉ Admin mới được sửa cấu hình bộ lọc.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-12 grid place-items-center text-text-3">
        <Loader2 className="w-6 h-6 animate-spin text-verity" />
      </div>
    );
  }

  const FacetIcon = currentFacetDef.icon;

  return (
    <div className="p-5 rounded-2xl border border-border bg-surface shadow-xs space-y-4 select-none">
      {/* ── Top Header Bar ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-verity-soft border border-verity-border flex items-center justify-center flex-none">
            <Tags className="w-4.5 h-4.5 text-verity" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-bold text-text-1">Cấu hình Bộ lọc & Nhãn</span>
              {dirty && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-warn-soft text-warn border border-warn-border">
                  Chưa lưu thay đổi
                </span>
              )}
            </div>
            <p className="text-[12px] text-text-3 mt-0.5">
              Quản lý danh mục áp dụng toàn diện cho AI nhận diện, bộ lọc thư viện và tìm kiếm.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || demoMode || !dirty}
          className={cn(
            'inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-[12.5px] font-semibold transition-all shadow-xs flex-none',
            dirty
              ? 'bg-verity hover:bg-verity-hover text-white shadow-verity/20'
              : 'bg-surface-2 text-text-3 border border-border opacity-70 cursor-not-allowed'
          )}
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Lưu thay đổi
        </button>
      </div>

      {/* ── Stable Value Banner (Compact) ── */}
      <div className="flex items-center gap-2.5 px-3.5 py-2 rounded-xl border border-verity-border/60 bg-verity-soft/30 text-[12px] text-text-2">
        <AlertCircle className="w-4 h-4 text-verity flex-none" />
        <div>
          <span className="font-semibold text-verity">Lưu ý:</span> <b>Stable Value</b> là mã định danh cố định trong database. Không nên đổi mã này khi ảnh đã lưu trữ.
        </div>
      </div>

      {demoMode && (
        <div className="p-3 rounded-xl border border-warn-border bg-warn-soft text-[12px] text-warn font-medium">
          Chế độ demo local: thay đổi tại đây không được lưu vào PostgreSQL.
        </div>
      )}

      {/* ── Segmented Facet Tabs (Zero-Scroll Navigation) ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-1.5 p-1.5 rounded-xl bg-surface-2/60 border border-border">
        {FACETS.map((item) => {
          const Icon = item.icon;
          const isActive = activeFacet === item.facet;
          const count = facetCounts[item.facet] || 0;
          return (
            <button
              key={item.facet}
              type="button"
              onClick={() => {
                setActiveFacet(item.facet);
                setSearchQuery('');
              }}
              className={cn(
                'flex items-center justify-between gap-1.5 px-3 py-2 rounded-lg text-[12.5px] font-semibold transition-all',
                isActive
                  ? 'bg-surface text-verity shadow-xs border border-border/80'
                  : 'text-text-2 hover:text-text-1 hover:bg-surface/50'
              )}
            >
              <div className="flex items-center gap-2 min-w-0 truncate">
                <Icon className={cn('w-3.5 h-3.5 flex-none', isActive ? 'text-verity' : 'text-text-3')} />
                <span className="truncate">{item.label}</span>
              </div>
              <span
                className={cn(
                  'px-1.5 py-0.5 rounded-md text-[10.5px] font-bold font-mono',
                  isActive
                    ? 'bg-verity-soft text-verity'
                    : 'bg-surface-3/80 text-text-3'
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* ── Active Facet Control Panel & Table ── */}
      <div className="rounded-xl border border-border overflow-hidden bg-surface">
        {/* Facet Toolbar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3 bg-surface-2/40 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-surface border border-border flex items-center justify-center text-verity">
              <FacetIcon className="w-3.5 h-3.5" />
            </div>
            <div>
              <h3 className="text-[13.5px] font-bold text-text-1">{currentFacetDef.label}</h3>
              <p className="text-[11.5px] text-text-3">{currentFacetDef.description}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Search Filter */}
            <div className="relative flex-1 sm:w-56">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-text-3" />
              <input
                type="text"
                placeholder={`Tìm trong ${currentFacetDef.label.toLowerCase()}...`}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full h-8 pl-8 pr-2.5 rounded-lg border border-border bg-surface text-[12px] text-text-1 placeholder:text-text-3 focus:outline-hidden focus:border-verity focus:ring-1 focus:ring-verity"
              />
            </div>

            {/* Add Button */}
            {currentFacetDef.canAdd && (
              <button
                type="button"
                onClick={() => addOption(currentFacetDef.facet)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-verity/10 hover:bg-verity/15 text-verity text-[12px] font-bold transition-all border border-verity/20 flex-none"
              >
                <Plus className="w-3.5 h-3.5" /> Thêm mới
              </button>
            )}
          </div>
        </div>

        {/* High-Density Compact Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-border bg-surface-2/20 text-[11px] font-bold uppercase tracking-wider text-text-3">
                <th className="py-2.5 px-4 w-[280px]">Mã hệ thống (Stable Value)</th>
                <th className="py-2.5 px-4 min-w-[200px]">Tên hiển thị (Nhãn)</th>
                <th className="py-2.5 px-4 w-[90px] text-center">Thứ tự</th>
                <th className="py-2.5 px-4 w-[110px] text-center">Trạng thái</th>
                <th className="py-2.5 px-4 w-[60px] text-center">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredOptions.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-text-3 text-[12.5px]">
                    {searchQuery ? (
                      <div>
                        Không tìm thấy tùy chọn nào khớp với &quot;<b>{searchQuery}</b>&quot;.
                      </div>
                    ) : (
                      <div>Chưa có tùy chọn nào trong danh mục này.</div>
                    )}
                  </td>
                </tr>
              ) : (
                filteredOptions.map((option) => {
                  const indexInAll = options.indexOf(option);
                  return (
                    <tr
                      key={`${option.facet}-${indexInAll}`}
                      className="hover:bg-surface-2/30 transition-colors group"
                    >
                      {/* Stable Value */}
                      <td className="py-2 px-4">
                        {option.isNew ? (
                          <input
                            type="text"
                            placeholder="vd: khoa_cong_sat"
                            value={option.value}
                            onChange={(e) =>
                              updateOption(indexInAll, {
                                value: e.target.value.toLowerCase().replace(/\s+/g, '_'),
                              })
                            }
                            className="w-full h-8 px-2.5 rounded-lg border border-verity bg-surface text-[12px] font-mono text-text-1 focus:outline-hidden focus:ring-1 focus:ring-verity"
                            autoFocus
                          />
                        ) : (
                          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface-2 border border-border/80 text-[12px] font-mono text-text-2 font-medium">
                            <Lock className="w-3 h-3 text-text-3 flex-none" />
                            <span className="truncate max-w-[220px]">{option.value}</span>
                          </div>
                        )}
                      </td>

                      {/* Label */}
                      <td className="py-2 px-4">
                        <input
                          type="text"
                          placeholder="Tên hiển thị tiếng Việt..."
                          value={option.label}
                          onChange={(e) => updateOption(indexInAll, { label: e.target.value })}
                          className="w-full h-8 px-2.5 rounded-lg border border-border hover:border-text-3/60 focus:border-verity bg-surface text-[12.5px] font-medium text-text-1 focus:outline-hidden focus:ring-1 focus:ring-verity transition-colors"
                        />
                      </td>

                      {/* Sort Order */}
                      <td className="py-2 px-4 text-center">
                        <input
                          type="number"
                          min={0}
                          max={10000}
                          value={option.sortOrder ?? 100}
                          onChange={(e) =>
                            updateOption(indexInAll, { sortOrder: Number(e.target.value) })
                          }
                          className="w-16 h-8 px-1.5 text-center rounded-lg border border-border hover:border-text-3/60 focus:border-verity bg-surface text-[12px] font-mono font-medium text-text-1 focus:outline-hidden focus:ring-1 focus:ring-verity transition-colors"
                        />
                      </td>

                      {/* Status Toggle */}
                      <td className="py-2 px-4 text-center">
                        <button
                          type="button"
                          onClick={() =>
                            updateOption(indexInAll, { isActive: option.isActive === false })
                          }
                          className={cn(
                            'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-all border',
                            option.isActive !== false
                              ? 'bg-ok-soft text-ok border-ok-border'
                              : 'bg-surface-2 text-text-3 border-border'
                          )}
                        >
                          {option.isActive !== false ? (
                            <>
                              <Eye className="w-3 h-3" /> Hiện
                            </>
                          ) : (
                            <>
                              <EyeOff className="w-3 h-3" /> Ẩn
                            </>
                          )}
                        </button>
                      </td>

                      {/* Actions */}
                      <td className="py-2 px-4 text-center">
                        {option.isNew && (
                          <button
                            type="button"
                            title="Xóa mục vừa thêm"
                            onClick={() => removeOption(indexInAll)}
                            className="p-1 rounded-md text-text-3 hover:text-warn hover:bg-warn-soft transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
