/**
 * VerityDAM upload-batch context contract.
 *
 * The database table `verity_upload_context_config` is the production source
 * of truth (Settings > Ngữ cảnh Upload). These values are bootstrap defaults
 * used only while the migration or the config endpoint is unavailable; the
 * upload UI consumes useUploadContextConfig().
 *
 * `icon` is a STRING key (not a component) so this file stays JSON-safe end
 * to end (DB jsonb -> API -> client state) -- BatchContextSelector.tsx
 * resolves the key to a lucide-react component via a small local registry,
 * falling back to a generic icon for an unknown/mistyped key rather than
 * crashing the page.
 */

export interface UploadQuickPreset {
  label: string;
  /** Emoji, rendered directly -- no registry needed. */
  icon: string;
  value: string;
}

export interface UploadTagGroup {
  name: string;
  /** Key into the icon registry in BatchContextSelector.tsx, e.g. "Building2". */
  icon: string;
  tags: string[];
}

export interface UploadContextConfig {
  quickPresets: UploadQuickPreset[];
  tagGroups: UploadTagGroup[];
  updatedAt: string | null;
}

/** Bootstrap-only values. Do not edit UI copy here; edit Settings instead. */
export const DEFAULT_UPLOAD_CONTEXT: UploadContextConfig = {
  quickPresets: [
    {
      label: 'Studio & TMĐT',
      icon: '📸',
      value: 'Ảnh chụp sản phẩm LocknLock Studio phông trắng chuẩn TMĐT, chi tiết góc cạnh',
    },
    {
      label: 'Sử dụng thực tế',
      icon: '🍳',
      value: 'Ảnh sử dụng thực tế trong không gian nhà bếp, bàn ăn sinh hoạt',
    },
    {
      label: 'Bao bì & Tem phụ',
      icon: '📦',
      value: 'Ảnh mở hộp sản phẩm LocknLock, bao bì nguyên seal tem phụ tiếng Việt',
    },
  ],
  tagGroups: [
    {
      name: 'Loại hình',
      icon: 'Building2',
      tags: [
        'Studio nền trắng',
        'Sử dụng thực tế',
        'Bao bì & Tem phụ',
        'Banner Marketing',
        'Trưng bày Showroom',
        'Ảnh lỗi / Bảo hành',
      ],
    },
    {
      name: 'Không gian',
      icon: 'Home',
      tags: [
        'Nhà bếp & Bàn ăn',
        'Phòng khách',
        'Văn phòng / Bàn làm việc',
        'Dã ngoại / Ngoài trời',
        'Tủ lạnh & Bảo quản',
        'Studio phông trơn',
        'Kệ hàng Showroom',
      ],
    },
    {
      name: 'Ngành hàng & Dòng SP',
      icon: 'Package',
      tags: [
        'Bình giữ nhiệt & Ly nước',
        'Hộp bảo quản thực phẩm',
        'Nồi chiên & Nồi điện',
        'Nồi chảo & Dụng cụ nấu',
        'Máy xay & Thiết bị bếp',
        'Đồ dùng sinh hoạt gia đình',
      ],
    },
    {
      name: 'Tiến độ',
      icon: 'CheckCircle2',
      tags: [
        'Mới đập hộp (Unboxing)',
        'Sản phẩm hoàn thiện',
        'Chi tiết phụ kiện / Nắp / Ron',
        'Đang sử dụng thực tế',
        'Ảnh thực tế kệ hàng',
      ],
    },
  ],
  updatedAt: null,
};

// Bounds enforced both client-side (form) and server-side (PUT route) so a
// runaway config can never turn into an unbounded query-expansion payload.
export const MAX_QUICK_PRESETS = 10;
export const MAX_TAG_GROUPS = 10;
export const MAX_TAGS_PER_GROUP = 24;
export const MAX_LABEL_LENGTH = 60;
export const MAX_PRESET_VALUE_LENGTH = 500;
export const MAX_TAG_LENGTH = 80;
export const MAX_ICON_KEY_LENGTH = 40;
