/**
 * Reference role and curation status vocabulary and resolution.
 * Vocabulary conforms to backend migration 0015 + migration 0034 (image_category taxonomy).
 *
 * image_category groups:
 *   REAL   ← INSTALLATION, REAL_WORLD, LIFESTYLE, MULTI_PRODUCT
 *   STUDIO ← HERO, ANGLE, DETAIL, PACKAGING, LOGO, UNCLASSIFIED
 *   DESIGN ← BANNER, RENDER_3D, MOCKUP
 */

export type ImageCategory = 'REAL' | 'STUDIO' | 'DESIGN';

export type ReferenceRole =
  | 'HERO'
  | 'ANGLE'
  | 'DETAIL'
  | 'INSTALLATION'
  | 'REAL_WORLD'
  | 'PACKAGING'
  | 'LIFESTYLE'
  | 'BANNER'
  | 'RENDER_3D'
  | 'MOCKUP'
  | 'LOGO'
  | 'MULTI_PRODUCT'
  | 'UNCLASSIFIED';

export type CurationStatus = 'UNREVIEWED' | 'VERIFIED' | 'REJECTED';

/** Maps every ReferenceRole to its ImageCategory group. */
export const ROLE_TO_CATEGORY: Record<ReferenceRole, ImageCategory> = {
  INSTALLATION:  'REAL',
  REAL_WORLD:    'REAL',
  LIFESTYLE:     'REAL',
  MULTI_PRODUCT: 'REAL',
  HERO:          'STUDIO',
  ANGLE:         'STUDIO',
  DETAIL:        'STUDIO',
  PACKAGING:     'STUDIO',
  LOGO:          'STUDIO',
  UNCLASSIFIED:  'STUDIO',
  BANNER:        'DESIGN',
  RENDER_3D:     'DESIGN',
  MOCKUP:        'DESIGN',
};

export interface ResolveReferenceRoleInput {
  isPromoted: boolean;
  hasActiveReferenceForSku?: boolean;
  category?: string | null;
  productLinkCount?: number;
}

export interface ReferenceRoleDecision {
  role: ReferenceRole;
  curationStatus: CurationStatus;
  matchEligible: boolean;
  imageCategory: ImageCategory;
}

/**
 * Resolve the reference role, curation status, match eligibility, and image category.
 *
 * Rules:
 * 1. isPromoted === true:
 *    - role: HERO if !hasActiveReferenceForSku, else ANGLE
 *    - curationStatus: 'VERIFIED'
 *    - matchEligible: true
 *    - imageCategory: 'STUDIO'
 * 2. isPromoted === false:
 *    - matchEligible: false
 *    - curationStatus: 'UNREVIEWED'
 *    - role + imageCategory derived from category/productLinkCount
 */
export function resolveReferenceRole(input: ResolveReferenceRoleInput): ReferenceRoleDecision {
  const linkCount = input.productLinkCount ?? 0;
  let role: ReferenceRole;

  if (linkCount >= 2) {
    role = 'MULTI_PRODUCT';
  } else {
    const rawCat = typeof input.category === 'string' ? input.category.trim().toLowerCase() : '';
    if (rawCat === 'banner') {
      role = 'BANNER';
    } else if (rawCat === 'công trình' || rawCat === 'cong trinh' || rawCat === 'ảnh thực tế' || rawCat === 'anh thuc te') {
      role = 'INSTALLATION';
    } else if (rawCat === 'bảo hành' || rawCat === 'bao hanh') {
      role = 'REAL_WORLD';
    } else if (rawCat === 'showroom') {
      role = 'LIFESTYLE';
    } else if (input.isPromoted) {
      role = input.hasActiveReferenceForSku ? 'ANGLE' : 'HERO';
    } else {
      role = 'UNCLASSIFIED';
    }
  }

  const imageCategory = ROLE_TO_CATEGORY[role] || 'STUDIO';
  return {
    role,
    curationStatus: input.isPromoted ? 'VERIFIED' : 'UNREVIEWED',
    matchEligible: Boolean(input.isPromoted),
    imageCategory,
  };
}

