'use client';

import React, { useState, useEffect } from 'react';
import {
  Globe2,
  Key,
  ExternalLink,
  Info,
  Check,
  ShieldCheck,
  Search,
  Sliders,
  Eye,
  EyeOff,
  Sparkles,
  Layers,
  AlertCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/common/Toast';
import type { WebImageSourceConfig } from '@/types/media';
import {
  loadWebImageConfig,
  saveWebImageConfig,
  getStockActiveCount,
  getSearchActiveCount,
} from '@/lib/web-image-sources';

type TabType = 'stock' | 'search';

export function WebImageSourcesSettings() {
  const { showToast } = useToast();
  const [config, setConfig] = useState<WebImageSourceConfig>(loadWebImageConfig);
  const [activeTab, setActiveTab] = useState<TabType>('stock');
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setConfig(loadWebImageConfig());
  }, []);

  const toggleShowKey = (id: string) => {
    setShowKeys((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleSave = () => {
    saveWebImageConfig(config);
    showToast('Đã lưu cấu hình Nguồn ảnh từ Web thành công', 'success');
  };

  const stockCount = getStockActiveCount(config);
  const searchCount = getSearchActiveCount(config);

  return (
    <div className="p-5 rounded-2xl border border-border bg-surface shadow-xs space-y-5">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-teal-soft border border-teal-border flex items-center justify-center flex-none mt-0.5">
            <Globe2 className="w-4 h-4 text-teal" />
          </div>
          <div>
            <div className="text-[14px] font-bold text-text-1">Nguồn ảnh từ web & Stock</div>
          </div>
        </div>
      </div>

      {/* ── Tabs Navigation ── */}
      <div className="flex items-center gap-2 border-b border-border pb-3">
        <button
          type="button"
          onClick={() => setActiveTab('stock')}
          className={cn(
            'flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-[12.5px] font-semibold transition-all',
            activeTab === 'stock'
              ? 'bg-ok-soft text-ok border border-ok-border shadow-xs'
              : 'bg-surface-2 text-text-2 border border-border hover:text-text-1 hover:bg-hover'
          )}
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          <span>Stock — Free commercial</span>
          <span
            className={cn(
              'px-1.5 py-0.2 rounded-full text-[10.5px] font-mono font-bold',
              activeTab === 'stock' ? 'bg-ok text-white' : 'bg-surface text-text-3'
            )}
          >
            {stockCount.active}/{stockCount.total}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('search')}
          className={cn(
            'flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-[12.5px] font-semibold transition-all',
            activeTab === 'search'
              ? 'bg-warn-soft text-warn border border-warn-border shadow-xs'
              : 'bg-surface-2 text-text-2 border border-border hover:text-text-1 hover:bg-hover'
          )}
        >
          <Search className="w-3.5 h-3.5" />
          <span>Search engine — License unknown</span>
          <span
            className={cn(
              'px-1.5 py-0.2 rounded-full text-[10.5px] font-mono font-bold',
              activeTab === 'search' ? 'bg-warn text-white' : 'bg-surface text-text-3'
            )}
          >
            {searchCount.active}/{searchCount.total}
          </span>
        </button>
      </div>

      {/* ── Tab 1: Stock — Free commercial ── */}
      {activeTab === 'stock' && (
        <div className="space-y-4 transition-all">
          <div className="flex items-center gap-2 text-[12px] text-ok font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-ok" />
            <span>An toàn dùng cho website thương mại, bài viết marketing, banner không vướng bản quyền.</span>
          </div>

          {/* Unsplash */}
          <div className="p-4 rounded-xl border border-border bg-surface-2/40 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-bold text-[13.5px] text-text-1">Unsplash</span>
                <span className="px-2 py-0.5 rounded-full text-[10.5px] font-bold bg-ok-soft text-ok border border-ok-border">
                  Free • 50 req/h
                </span>
                <span className="px-2 py-0.5 rounded-full text-[10.5px] font-medium bg-surface text-text-3 border border-border">
                  Commercial Safe
                </span>
              </div>
              <a
                href="https://unsplash.com/developers"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-[12px] font-semibold text-verity hover:underline"
              >
                <span>Lấy key</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
            <p className="text-[12px] text-text-3">
              Ảnh chất lượng cao, thiết kế nội thất, không gian sống sang trọng. Đăng ký app → lấy &quot;Access Key&quot;.
            </p>
            <div className="relative">
              <input
                type={showKeys['unsplash'] ? 'text' : 'password'}
                value={config.unsplash.accessKey}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    unsplash: { ...prev.unsplash, accessKey: e.target.value },
                  }))
                }
                placeholder="Dán Unsplash Access Key vào đây..."
                className="w-full h-9 px-3 pr-10 rounded-lg border border-border bg-surface text-[13px] text-text-1 outline-none focus:border-verity-border focus:ring-1 focus:ring-verity/20 transition-all font-mono placeholder:font-sans placeholder:text-text-disabled"
              />
              <button
                type="button"
                onClick={() => toggleShowKey('unsplash')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-3 hover:text-text-1 transition-colors"
              >
                {showKeys['unsplash'] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Pexels */}
          <div className="p-4 rounded-xl border border-border bg-surface-2/40 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-bold text-[13.5px] text-text-1">Pexels</span>
                <span className="px-2 py-0.5 rounded-full text-[10.5px] font-bold bg-ok-soft text-ok border border-ok-border">
                  Free • 200 req/h
                </span>
                <span className="px-2 py-0.5 rounded-full text-[10.5px] font-medium bg-surface text-text-3 border border-border">
                  Commercial Safe
                </span>
              </div>
              <a
                href="https://www.pexels.com/api/"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-[12px] font-semibold text-verity hover:underline"
              >
                <span>Lấy key</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
            <p className="text-[12px] text-text-3">
              Ảnh free commercial, phong cách đời sống người dùng thực tế, không cần ghi nguồn. Đăng ký → lấy API Key.
            </p>
            <div className="relative">
              <input
                type={showKeys['pexels'] ? 'text' : 'password'}
                value={config.pexels.apiKey}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    pexels: { ...prev.pexels, apiKey: e.target.value },
                  }))
                }
                placeholder="Dán Pexels API key vào đây..."
                className="w-full h-9 px-3 pr-10 rounded-lg border border-border bg-surface text-[13px] text-text-1 outline-none focus:border-verity-border focus:ring-1 focus:ring-verity/20 transition-all font-mono placeholder:font-sans placeholder:text-text-disabled"
              />
              <button
                type="button"
                onClick={() => toggleShowKey('pexels')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-3 hover:text-text-1 transition-colors"
              >
                {showKeys['pexels'] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Pixabay */}
          <div className="p-4 rounded-xl border border-border bg-surface-2/40 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-bold text-[13.5px] text-text-1">Pixabay</span>
                <span className="px-2 py-0.5 rounded-full text-[10.5px] font-bold bg-ok-soft text-ok border border-ok-border">
                  Free • 100 req/min
                </span>
                <span className="px-2 py-0.5 rounded-full text-[10.5px] font-medium bg-surface text-text-3 border border-border">
                  Commercial Safe
                </span>
              </div>
              <a
                href="https://pixabay.com/api/docs/"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-[12px] font-semibold text-verity hover:underline"
              >
                <span>Lấy key</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
            <p className="text-[12px] text-text-3">
              Ảnh + vector + illustration, license Pixabay Content. Đăng ký → lấy API Key.
            </p>
            <div className="relative">
              <input
                type={showKeys['pixabay'] ? 'text' : 'password'}
                value={config.pixabay.apiKey}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    pixabay: { ...prev.pixabay, apiKey: e.target.value },
                  }))
                }
                placeholder="Dán Pixabay API key vào đây..."
                className="w-full h-9 px-3 pr-10 rounded-lg border border-border bg-surface text-[13px] text-text-1 outline-none focus:border-verity-border focus:ring-1 focus:ring-verity/20 transition-all font-mono placeholder:font-sans placeholder:text-text-disabled"
              />
              <button
                type="button"
                onClick={() => toggleShowKey('pixabay')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-3 hover:text-text-1 transition-colors"
              >
                {showKeys['pixabay'] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Tab 2: Search engine — License unknown ── */}
      {activeTab === 'search' && (
        <div className="space-y-4 transition-all">
          <div className="flex items-center gap-2 text-[12px] text-warn font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-warn" />
            <span>Lấy ảnh từ kết quả tìm kiếm web. Bạn phải tự kiểm tra license trên trang nguồn trước khi xuất bản công khai.</span>
          </div>

          {/* Google Programmable Search */}
          <div className="p-4 rounded-xl border border-border bg-surface-2/40 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-bold text-[13.5px] text-text-1">Google Programmable Search</span>
                <span className="px-2 py-0.5 rounded-full text-[10.5px] font-bold bg-warn-soft text-warn border border-warn-border">
                  License unknown
                </span>
                <span className="px-2 py-0.5 rounded-full text-[10.5px] font-bold bg-ok-soft text-ok border border-ok-border">
                  100 req/ngày miễn phí
                </span>
              </div>
              <div className="flex items-center gap-3">
                <a
                  href="https://programmablesearchengine.google.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[12px] font-semibold text-verity hover:underline"
                >
                  <span>Tạo CX</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
                <a
                  href="https://console.cloud.google.com/apis/credentials"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[12px] font-semibold text-text-3 hover:text-text-1 hover:underline"
                >
                  <span>API Key</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
            <p className="text-[12px] text-text-3">
              Cần 2 thông tin: API Key (Google Cloud Console) và CX (Programmable Search Engine, bật &quot;Image search&quot;).
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="relative">
                <input
                  type={showKeys['google_key'] ? 'text' : 'password'}
                  value={config.googleCse.apiKey}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      googleCse: { ...prev.googleCse, apiKey: e.target.value },
                    }))
                  }
                  placeholder="API Key (AIza...)"
                  className="w-full h-9 px-3 pr-10 rounded-lg border border-border bg-surface text-[13px] text-text-1 outline-none focus:border-verity-border focus:ring-1 focus:ring-verity/20 transition-all font-mono placeholder:font-sans placeholder:text-text-disabled"
                />
                <button
                  type="button"
                  onClick={() => toggleShowKey('google_key')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-text-3 hover:text-text-1 transition-colors"
                >
                  {showKeys['google_key'] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              <input
                type="text"
                value={config.googleCse.cx}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    googleCse: { ...prev.googleCse, cx: e.target.value },
                  }))
                }
                placeholder="CX (Search Engine ID)"
                className="w-full h-9 px-3 rounded-lg border border-border bg-surface text-[13px] text-text-1 outline-none focus:border-verity-border focus:ring-1 focus:ring-verity/20 transition-all font-mono placeholder:font-sans placeholder:text-text-disabled"
              />
            </div>

            <label className="flex items-center gap-2 text-[12px] text-text-2 cursor-pointer select-none pt-1">
              <input
                type="checkbox"
                checked={config.googleCse.onlyCreativeCommons}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    googleCse: { ...prev.googleCse, onlyCreativeCommons: e.target.checked },
                  }))
                }
                className="rounded border-border text-verity focus:ring-verity"
              />
              <span>Chỉ lấy ảnh Creative Commons (an toàn hơn, nhưng kết quả ít hơn rất nhiều)</span>
            </label>
          </div>

          {/* Brave Search Images */}
          <div className="p-4 rounded-xl border border-border bg-surface-2/40 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-bold text-[13.5px] text-text-1">Brave Search Images</span>
                <span className="px-2 py-0.5 rounded-full text-[10.5px] font-bold bg-warn-soft text-warn border border-warn-border">
                  License unknown
                </span>
                <span className="px-2 py-0.5 rounded-full text-[10.5px] font-bold bg-ok-soft text-ok border border-ok-border">
                  2000 req/tháng miễn phí
                </span>
              </div>
              <a
                href="https://brave.com/search/api/"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-[12px] font-semibold text-verity hover:underline"
              >
                <span>Lấy key</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
            <p className="text-[12px] text-text-3">
              Search engine độc lập của Brave. Đăng ký Free tier → lấy Subscription Token.
            </p>
            <div className="relative">
              <input
                type={showKeys['brave'] ? 'text' : 'password'}
                value={config.braveSearch.subscriptionToken}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    braveSearch: { ...prev.braveSearch, subscriptionToken: e.target.value },
                  }))
                }
                placeholder="Brave Subscription Token (BSA...)"
                className="w-full h-9 px-3 pr-10 rounded-lg border border-border bg-surface text-[13px] text-text-1 outline-none focus:border-verity-border focus:ring-1 focus:ring-verity/20 transition-all font-mono placeholder:font-sans placeholder:text-text-disabled"
              />
              <button
                type="button"
                onClick={() => toggleShowKey('brave')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-3 hover:text-text-1 transition-colors"
              >
                {showKeys['brave'] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* DuckDuckGo Images */}
          <div className="p-4 rounded-xl border border-border bg-surface-2/40 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-bold text-[13.5px] text-text-1">DuckDuckGo Images</span>
                <span className="px-2 py-0.5 rounded-full text-[10.5px] font-bold bg-warn-soft text-warn border border-warn-border">
                  License unknown
                </span>
                <span className="px-2 py-0.5 rounded-full text-[10.5px] font-bold bg-teal-soft text-teal border border-teal-border">
                  Không cần key
                </span>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.duckDuckGo.enabled}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      duckDuckGo: { ...prev.duckDuckGo, enabled: e.target.checked },
                    }))
                  }
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-border peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-border after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-teal"></div>
              </label>
            </div>
            <p className="text-[12px] text-text-3">
              Tìm kiếm ảnh trực tiếp qua endpoint DuckDuckGo không cần tài khoản. Dùng làm phương án dự phòng khi các nguồn khác hết quota.
            </p>
          </div>
        </div>
      )}

      {/* ── Guidelines Footer ── */}
      <div className="p-3.5 rounded-xl border border-border-subtle bg-surface-2/50 text-[11.5px] text-text-3 space-y-1.5 leading-relaxed">
        <p>• Bạn có thể chỉ cấu hình 1 provider; hệ thống sẽ tự động fallback nếu provider đó không có kết quả hoặc hết quota.</p>
        <p>• Mọi key được lưu cục bộ trên trình duyệt máy bạn (<span className="font-mono text-text-2">localStorage</span>), không gửi lên server.</p>
        <p>• Với nguồn &quot;License unknown&quot;: Hệ thống sẽ tự động lưu link gốc của ảnh để bạn kiểm tra trước khi publish.</p>
      </div>

      {/* ── Save Action ── */}
      <div className="flex items-center justify-end pt-2">
        <button
          id="btn-save-web-image-sources"
          type="button"
          onClick={handleSave}
          className="flex items-center gap-2 px-4 h-9 rounded-lg bg-teal text-white text-[13px] font-semibold hover:opacity-90 transition-all shadow-xs"
        >
          <Check className="w-4 h-4" />
          Lưu cấu hình nguồn ảnh
        </button>
      </div>
    </div>
  );
}
