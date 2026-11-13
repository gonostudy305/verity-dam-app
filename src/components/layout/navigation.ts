import type { LucideIcon } from 'lucide-react';
import {
  BookOpen,
  CheckCircle2,
  Copy,
  Flag,
  LayoutGrid,
  PackagePlus,
  Settings,
  Sparkles,
  Target,
  UploadCloud,
} from 'lucide-react';

export interface NavigationItem {
  href: string;
  label: string;
  icon: LucideIcon;
  primary?: boolean;
  badge?: number;
  minimumRole?: NavigationRole;
}

export interface NavigationUser {
  email: string;
  role: string;
}

export type NavigationRole = 'viewer' | 'contributor' | 'reviewer' | 'admin';

const ROLE_RANK: Record<NavigationRole, number> = {
  viewer: 0,
  contributor: 1,
  reviewer: 2,
  admin: 3,
};

export const PRIMARY_NAV_ITEMS: readonly NavigationItem[] = [
  { href: '/library', label: 'Thư viện', icon: LayoutGrid, primary: true },
  { href: '/review', label: 'Hàng chờ duyệt', icon: CheckCircle2, primary: true, minimumRole: 'reviewer' },
  { href: '/duplicates', label: 'Ảnh trùng', icon: Copy, minimumRole: 'reviewer' },
  { href: '/reports', label: 'Báo lỗi', icon: Flag, minimumRole: 'reviewer' },
  { href: '/upload', label: 'Upload', icon: UploadCloud, primary: true, minimumRole: 'contributor' },
  { href: '/product-intakes', label: 'Hồ sơ sản phẩm', icon: PackagePlus, primary: true, minimumRole: 'contributor' },
  { href: '/studio', label: 'Tạo ảnh AI', icon: Sparkles },
  { href: '/shot', label: 'Cần ảnh', icon: Target, minimumRole: 'contributor' },
  { href: '/settings', label: 'Cài đặt', icon: Settings, minimumRole: 'admin' },
];

export const SECONDARY_NAV_ITEMS: readonly NavigationItem[] = [
  { href: '/shot', label: 'Cần ảnh', icon: Target, minimumRole: 'contributor' },
  { href: '/studio', label: 'Tạo ảnh AI', icon: Sparkles },
  { href: '/settings', label: 'Cài đặt', icon: Settings, minimumRole: 'admin' },
  { href: '/spec', label: 'Ghi chú thiết kế', icon: BookOpen },
];

export function isNavigationItemActive(pathname: string, href: string): boolean {
  if (href === '/review') return pathname === '/' || pathname === '/review' || pathname.startsWith('/review/');
  if (href === '/library') return pathname === '/library' || pathname.startsWith('/library/');
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function canNavigate(item: NavigationItem, user: NavigationUser | null): boolean {
  // A missing session is an unknown/unauthenticated state, not an admin
  // session. Public items remain visible while auth settles, but privileged
  // links must fail closed to avoid a misleading affordance.
  if (!item.minimumRole) return true;
  if (!user) return false;
  const role = user.role as NavigationRole;
  return ROLE_RANK[role] !== undefined && ROLE_RANK[role] >= ROLE_RANK[item.minimumRole];
}

export function getNavigationItems(
  queueCount = 0,
  user: NavigationUser | null = null,
  duplicateCount = 0,
  openReportCount = 0,
  productIntakesEnabled = true
): NavigationItem[] {
  return PRIMARY_NAV_ITEMS.filter(
    (item) => canNavigate(item, user) && (productIntakesEnabled || item.href !== '/product-intakes')
  ).map((item) => ({
    ...item,
    ...(item.href === '/review' && queueCount > 0 ? { badge: queueCount } : {}),
    ...(item.href === '/duplicates' && duplicateCount > 0 ? { badge: duplicateCount } : {}),
    ...(item.href === '/reports' && openReportCount > 0 ? { badge: openReportCount } : {}),
  }));
}
