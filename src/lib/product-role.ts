export const PRODUCT_ROLE_LABELS = {
  primary: 'Chính',
  secondary: 'Phụ',
  background: 'Nền',
  packaging: 'Bao bì',
} as const;

export type ProductRole = keyof typeof PRODUCT_ROLE_LABELS;

export const TAGGABLE_ROLES = ['secondary', 'background', 'packaging'] as const;
export type TaggableRole = (typeof TAGGABLE_ROLES)[number];

export const TAGGABLE_ROLE_SET = new Set<string>(TAGGABLE_ROLES);
