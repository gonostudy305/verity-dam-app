# VerityDAM — Hệ Thống Thiết Kế, Motion Tokens & Hướng Dẫn UI/UX

Tài liệu chuẩn hóa toàn diện kiến trúc giao diện người dùng (UI), trải nghiệm thao tác (UX), hệ thống phân cấp thị giác (Visual Hierarchy), kiến trúc Design Tokens 3 lớp (`ckm:design-system`), hệ thống Motion Tokens (`transitions-dev`), và tiêu chuẩn tuân thủ **Vercel Web Interface Guidelines** cho nền tảng **VerityDAM & DAM Platform**.

---

## 1. Triết Lý Thiết Kế Cốt Lõi (Core Principles)

Kế thừa chuẩn mực **Karpathy Guidelines for Simplicity & Precision** kết hợp với **Vercel Web Interface Guidelines**:

1. **Tỷ Lệ Tín Hiệu Trên Nhiễu Cực Đại (High Signal-to-Noise Ratio)**:
   - Mọi pixel và thành phần hiển thị đều phải phục vụ trực tiếp cho mục tiêu công việc của người dùng (tìm kiếm, duyệt, kiểm tra chất lượng và phân phối media).
   - **Nghiêm cấm** các nhãn trang trí thừa thãi, các badge trạng thái giả lập không tương tác được, hoặc hiệu ứng chuyển động rườm rà gây cản trở tốc độ xử lý ảnh.
2. **Ưu Tiên Không Gian Nội Dung Trực Quan (Viewport Real-Estate First)**:
   - Trong ứng dụng DAM / Media Review, tài nguyên quý giá nhất là **chiều cao màn hình** (vertical pixels) để quan sát chi tiết ảnh và filmstrip mà không phải cuộn trang.
   - Giữ thanh điều hướng trên cùng (Topbar) ở độ cao tối ưu `52px` và toolbar thao tác ở `38px`.
3. **Giảm Thiểu Tải Nhận Thức (Cognitive Load Reduction)**:
   - Gom cụm thông tin theo ngữ cảnh hành vi (Gestalt Proximity & Common Region).
   - Di chuyển các công tắc tiện ích toàn cục (như Theme Toggle Sáng/Tối) về khu vực hồ sơ người dùng ở chân Sidebar, nhường trọn thanh Topbar cho luồng tác vụ chính.
4. **Mặc Định Công Thái Học (Sensible Ergonomic Defaults)**:
   - Khi Reviewer mở trang `/review`, chế độ xem mặc định luôn là **`Tập trung` (Focus)** với khung ảnh lớn nhất, thay vì lưới tổng quan.
5. **Khả Năng Tiếp Cận Tuyệt Đối (Strict Accessibility & A11y)**:
   - Tuân thủ WCAG 2.1 AA: tương phản màu sắc tối thiểu `4.5:1` cho text và `3:1` cho controls tương tác.
   - Hỗ trợ đầy đủ bàn phím (`Tab`, `Arrows`, `Enter`, `Space`, `Escape`).
   - Mọi chuyển động phải được bảo vệ bởi `@media (prefers-reduced-motion: reduce)`.

---

## 2. Kiến Trúc Phân Cấp Thị Giác (Visual Hierarchy)

### 2.1. Phân Cấp Trước & Sau Khi Tái Cấu Trúc (Header Evolution)

```
[TRƯỚC ĐÂY - 2 HÀNG HEADER CHỒNG CHÉO (100px+)]
┌─────────────────────────────────────────────────────────────────────────────┐
│ Topbar (56px): [VerityDAM] [Trợ lý AI sẵn sàng]      [Ban ngày/Ban đêm]    │
├─────────────────────────────────────────────────────────────────────────────┤
│ Subheader (48px): [Cần duyệt (107)] [Để sau] [Hồ sơ]   [0/107 đã duyệt]     │
├─────────────────────────────────────────────────────────────────────────────┤
│ ReviewToolbar (48px): [Tổng quan | Tập trung]           [Đã tải 50/107]     │
└─────────────────────────────────────────────────────────────────────────────┘
  ❌ Nhược điểm: 3 tầng thanh điều hướng liên tiếp, chiếm hơn 150px chiều dọc,
     chứa badge vô nghĩa ("Trợ lý AI sẵn sàng"), nút ThemeToggle chiếm diện tích lớn.

[HIỆN TẠI - HEADER ĐƠN NHẤT & TINH GỌN (52px + 38px)]
┌─────────────────────────────────────────────────────────────────────────────┐
│ Topbar (52px): [Hàng chờ duyệt] [Cần duyệt (107)] [Để sau] [Hồ sơ] [0/107...]│
├─────────────────────────────────────────────────────────────────────────────┤
│ ReviewToolbar (38px): [Tập trung | Tổng quan]           [Đã tải 50/107]     │
└─────────────────────────────────────────────────────────────────────────────┘
  ✅ Ưu điểm: Tiết kiệm ngay 48px chiều dọc, gom toàn bộ điều hướng hàng chờ vào
     thanh Topbar chính, nút đổi giao diện Sáng/Tối dời vào Sidebar footer.
```

### 2.2. Vị Trí Công Cụ & Trách Nhiệm Thành Phần

| Thành phần | Vị trí | Chiều cao | Trách nhiệm chính |
| :--- | :--- | :--- | :--- |
| **Topbar** | Cố định trên cùng (`sticky top-0`) | `52px` | Tên màn hình hiện tại + Slot động (`#topbar-portal-slot`) nhận tabs hàng chờ và tiến độ duyệt. |
| **Sidebar Footer** | Chân sidebar (`mt-auto`) | Tự co giãn | Avatar, email, quyền hạn của User + Nút icon **Đổi Theme Sáng/Tối** (`32x32px`) + Nút **Đăng xuất**. |
| **ReviewToolbar** | Ngay dưới Topbar | `38px` | Bộ chuyển chế độ xem `[Tập trung]` / `[Tổng quan]` dạng compact pills (`h-8`) + Đếm số ảnh đã nạp. |
| **Workspace Content** | Chiếm toàn bộ phần còn lại | `flex-1 min-h-0` | Khung hiển thị ảnh lớn, filmstrip thumbnail, và panel metadata. |

---

## 3. Mô Hình Kiến Trúc Kỹ Thuật: TopbarPortal

Để hiển thị trạng thái động của hàng chờ duyệt (số lượng ảnh `pendingTotal`, `skippedTotal`, tiến độ `reviewedToday`) lên thanh `Topbar` của `AppShell` mà **không cần**:
- Không cần nâng state (state lifting) lên AppShell gây re-render toàn ứng dụng.
- Không cần prop-drilling qua nhiều tầng component.
- Không phá vỡ tính đóng gói cục bộ của module `ReviewView`.

Chúng tôi áp dụng mô hình **React Portal qua Target Slot**:

```tsx
// 1. Tại Topbar.tsx (Khung vỏ Shell)
<header className="flex min-h-[52px] h-[52px] items-center ...">
  <div className="min-w-0 flex flex-col shrink-0">
    <h1 className="text-[15px] font-semibold tracking-tight">{title}</h1>
  </div>
  
  {/* Điểm gắn kết DOM cho các trang con */}
  <div id="topbar-portal-slot" className="flex items-center min-w-0 flex-1 ml-1 sm:ml-3 gap-2 overflow-hidden" />
  
  {onSelectDemoState && <DemoScenariosMenu />}
</header>

// 2. Component TopbarPortal.tsx (Cầu nối client portal an toàn)
export function TopbarPortal({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(document.getElementById('topbar-portal-slot'));
  }, []);
  if (!target) return null;
  return ReactDOM.createPortal(children, target);
}

// 3. Tại ReviewView.tsx (Trang tiêu thụ)
<TopbarPortal>
  <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
    <QueueTabs activeTab={activeTab} setActiveTab={setActiveTab} counts={{ pendingTotal, skippedTotal }} />
    <ReviewProgress reviewedCount={reviewedToday} totalCount={reviewedToday + pendingTotal} />
  </div>
</TopbarPortal>
```

---

## 4. Kiến Trúc Design Tokens 3 Lớp (Three-Layer Token Architecture)

Theo quy chuẩn `ckm:design-system`, toàn bộ hệ thống biến CSS trong [`src/styles/globals.css`](../src/styles/globals.css) và [`tailwind.config.ts`](../tailwind.config.ts) được tổ chức theo mô hình 3 lớp phân cấp chặt chẽ:

```
[Lớp 1: Primitive Tokens]    (Giá trị thô: mã màu hex, ms, cubic-bezier, px)
            ↓
[Lớp 2: Semantic Tokens]     (Mục đích sử dụng: --surface, --text-1, --duration-fast, --ease-standard)
            ↓
[Lớp 3: Component Tokens]    (Đặc thù thành phần: --drawer-open-dur, --toast-distance, --sh-drawer)
```

### 4.1. Lớp Màu Sắc (Color Tokens)

| Token Semantic | Light Theme | Dark Theme | Mục đích sử dụng |
| :--- | :--- | :--- | :--- |
| `--verity` | `#104C87` | `#2E86C8` | Màu thương hiệu chính, nút CTA, viền focus, tab kích hoạt |
| `--verity-hover` | `#0D3F71` | `#4098D8` | Trạng thái hover của nút CTA chính |
| `--surface` | `#FFFFFF` | `#122539` | Nền Card, Panel, Drawer, Modal, Menu |
| `--surface-2` | `#EDF2F8` | `#172E45` | Nền thanh Toolbar phụ, badge nhẹ, header table |
| `--paper` | `#F4F7FB` | `#0D1B2A` | Nền canvas ứng dụng đằng sau các card nội dung |
| `--border` | `rgba(16, 76, 135, 0.18)` | `rgba(147, 197, 240, 0.17)` | Đường viền phân cách tiêu chuẩn |
| `--border-strong`| `rgba(16, 76, 135, 0.30)` | `rgba(147, 197, 240, 0.28)` | Viền active, viền input khi focus |
| `--text-1` | `#0F2436` | `#E8F1F9` | Văn bản chính, tiêu đề (độ tương phản cao nhất) |
| `--text-2` | `#3F586C` | `#9FB5C9` | Nhãn phụ, mô tả, trạng thái thông thường |
| `--text-3` | `#3F586C` | `#7891A6` | Placeholder, metadata phụ |
| `--ok` | `#1A7F45` | `#4FC17A` | Thành công, đã duyệt, độ tin cậy AI cao (≥85%) |
| `--warn` | `#9C560B` | `#F0A05A` | Cảnh báo, cần hậu kỳ, độ tin cậy AI thấp (<85%) |
| `--bad` | `#B3271B` | `#FF8078` | Lỗi, từ chối, media hỏng |
| `--ai` | `#5D37B0` | `#A78BFA` | Tính năng gán nhãn AI, vector SigLIP2 |
| `--gold` | `#FFD60D` | `#FACC15` | **Chỉ dùng làm nền badge/graphic.** Không dùng làm màu chữ |

### 4.2. Lớp Kích Thước & Lưới 4px (Spacing & Sizing Tokens)
- **Lưới 4px (Spacing Grid)**: `--s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 20px; --s6: 24px; --s8: 32px; --s10: 40px; --s12: 48px;`
- **Bo góc (Border Radius)**:
  - `--r-xs: 4px;` — tag nhỏ, badge con
  - `--r-sm: 6px;` — button nhỏ, badge trạng thái
  - `--r-md: 8px;` — button chuẩn, input control
  - `--r-lg: 10px;` — dialog góc mềm, popover
  - `--r-xl: 14px;` — card, drawer, bento widget
  - `--r-full: 9999px;` — avatar, pill button, radio
- **Độ cao chuẩn (Height Tokens)**:
  - `--topbar: 52px;` — Header ứng dụng
  - `--ctrl-sm: 30px;` — Nút nhỏ trên toolbar
  - `--ctrl-md: 36px;` — Nút chuẩn form
  - `--ctrl-lg: 44px;` — Nút CTA lớn, touch target tối thiểu di động
  - `--mobile-nav-height: 64px;` — Thanh điều hướng chân trang trên mobile

---

## 5. Hệ Thống Motion Tokens & Chuyển Động Chuẩn Hóa (`transitions-dev`)

Hệ thống chuyển động của VerityDAM được chuẩn hóa theo thang đo thời gian và đường cong chuyển động từ `transitions-dev`, tích hợp trực tiếp vào `:root` trong `globals.css` và mở rộng qua `tailwind.config.ts`.

### 5.1. Thang Đo Thời Lượng (Duration Scale)

| Token | Giá trị | Ứng dụng chuẩn | Lớp Tailwind |
| :--- | :--- | :--- | :--- |
| `--duration-instant` | `100ms` | Phản hồi vi mô, hover state, focus ring | `duration-instant` |
| `--duration-fast` | `150ms` | Đóng popover, đóng dropdown, tooltip biến mất | `duration-fast` |
| `--duration-normal` | `200ms` | Đóng drawer, đóng modal dialog, chuyển tab | `duration-normal` |
| `--duration-moderate` | `300ms` | Mở drawer, mở modal dialog, trượt banner | `duration-moderate` |
| `--duration-slow` | `400ms` | Mở panel phức tạp, hiệu ứng skeleton reveal | `duration-slow` |
| `--duration-deliberate`| `600ms` | Hiệu ứng chúc mừng hoàn thành (success check) | `duration-deliberate` |

### 5.2. Thang Đo Đường Cong Chuyển Động (Easing Scale)

| Token | Công thức Bézier | Ý nghĩa & Hành vi thị giác | Lớp Tailwind |
| :--- | :--- | :--- | :--- |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | Chuẩn chuyển động giao diện tự nhiên, êm dịu | `ease-standard` |
| `--ease-decelerate` | `cubic-bezier(0, 0, 0, 1)` | Vào nhanh, hãm phanh mượt mà (dành cho phần tử mới xuất hiện) | `ease-decelerate` |
| `--ease-accelerate` | `cubic-bezier(0.3, 0, 1, 1)` | Rời khỏi khung nhìn nhanh dần (dành cho phần tử biến mất) | `ease-accelerate` |
| `--ease-spring-snappy`| `cubic-bezier(0.22, 1, 0.36, 1)` | Hiệu ứng đàn hồi nhẹ, nảy dứt khoát (toast, popover) | `ease-spring-snappy` |
| `--ease-spring-gentle`| `cubic-bezier(0.16, 1, 0.3, 1)` | Trượt êm ái cao cấp (drawer trượt từ cạnh phải vào) | `ease-spring-gentle` |

### 5.3. Quy Chuẩn Điều Phối Hai Chiều (Enter & Exit Orchestration)

> [!IMPORTANT]
> **Quy tắc vàng unmount trong React**: Không bao giờ được phép gỡ component (unmount) khỏi state ngay lập tức khi người dùng đóng. Luôn sử dụng trạng thái trung gian `isClosing` để chạy trọn vẹn transition đóng trước khi gỡ khỏi DOM.

Mẫu cài đặt chuẩn:
```tsx
const [isOpen, setIsOpen] = useState(false);
const [isClosing, setIsClosing] = useState(false);

useEffect(() => {
  const frame = requestAnimationFrame(() => setIsOpen(true));
  return () => cancelAnimationFrame(frame);
}, []);

const handleDismiss = useCallback(() => {
  if (isClosing) return;
  setIsClosing(true);
  setIsOpen(false);
  setTimeout(() => {
    onClose();
  }, 200); // 200ms khớp chính xác với --drawer-close-dur hoặc --toast-close
}, [isClosing, onClose]);
```

### 5.4. Các Mẫu Chuyển Động Đã Triển Khai

#### A. Pattern `07-panel-reveal / drawer` ([DetailDrawer.tsx](../src/components/library/DetailDrawer.tsx))
- **Mô tả**: Drawer xem chi tiết ảnh trượt từ mép phải màn hình sang trái, kết hợp backdrop mờ dần.
- **CSS Hooks**: `.t-drawer-backdrop`, `.t-drawer-panel` với `.is-open` và `.is-closing`.
- **Thông số**:
  - Mở: `transform: translateX(0); opacity: 1;` trong `280ms` (`--drawer-open-dur`) với `--drawer-ease`.
  - Đóng: `transform: translateX(100%); opacity: 0;` trong `200ms` (`--drawer-close-dur`).
- **Tương tác**: Tự động kích hoạt khi bấm Backdrop, nút `X`, ấn phím `Escape`, hoặc khi xác nhận xóa asset vào thùng rác.

#### B. Pattern `22-toast` ([Toast.tsx](../src/components/common/Toast.tsx))
- **Mô tả**: Thông báo nổi lên từ cạnh dưới màn hình với hiệu ứng nâng nhẹ, khử mờ (cross-blur) và phóng nhẹ.
- **CSS Hooks**: `.t-toast` với `.is-open` và `.is-closing`.
- **Thông số**:
  - Mở: `translateY(0) scale(1)` + `blur(0)` trong `320ms` (`--toast-open`).
  - Đóng: `translateY(14px) scale(0.96)` + `blur(2px)` trong `220ms` (`--toast-close`).
- **Tương tác**: Tự động đóng sau 2.8s hoặc khi bấm nút tắt nhanh `X`.

### 5.5. Lộ Trình Áp Dụng Tiếp Theo (Transitions Catalog Roadmap)
1. `05-menu-dropdown.md`: Áp dụng cho các menu thả xuống trên `HorizontalFilterBar.tsx`.
2. `06-modal.md`: Áp dụng cho `ReportResolveDialog.tsx`, `ImageCropperModal.tsx`, `ImageSaveAsModal.tsx`.
3. `14-skeleton-reveal.md` & `15-shimmer-text.md`: Áp dụng cho trạng thái nạp dữ liệu ở `MasonryGrid.tsx` và trang `/shot`.
4. `21-accordion.md`: Áp dụng cho các nhóm accordion cài đặt trong `AIVisionSettings.tsx`.
5. `27-toggle.md`: Áp dụng cho các công tắc bật/tắt trong `BatchReviewForm.tsx`.

---

## 6. Quy Chuẩn Tuân Thủ Web Interface Guidelines (`ck:web-design-guidelines`)

Mọi file mã nguồn UI đều phải tuân thủ nghiêm ngặt các quy tắc sau:

### 6.1. Khả Năng Tiếp Cận (Accessibility)
- **Nút chỉ chứa icon**: Bắt buộc có thuộc tính `aria-label` rõ ràng (ví dụ: `aria-label="Đóng chi tiết asset"`).
- **Phần tử tương tác**: Bắt buộc có keyboard handler (`onKeyDown` cho `Enter`, `Space`, `Escape`).
- **Semantic HTML**: Dùng `<button>` cho các hành động (actions), dùng `<a>` hoặc Next.js `<Link>` cho việc chuyển trang (navigation). Nghiêm cấm dùng `<div onClick>`.
- **Ảnh**: Phải có `alt` mô tả hoặc `alt=""` nếu là ảnh trang trí.
- **Thông báo bất đồng bộ**: Toast container phải có `aria-live="polite"` và `role="status"` để máy đọc màn hình không ngắt ngang người dùng.
- **Icon trang trí**: Các icon Lucide cạnh nhãn chữ phải có `aria-hidden="true"` nếu nhãn chữ đã đầy đủ ý nghĩa.

### 6.2. Quản Lý Focus & Trạng Thái Bàn Phím
- **Không bao giờ xóa outline mà không có viền thay thế**: Cấm dùng `outline-none` đơn độc. Luôn kết hợp với `focus-visible:ring-2 focus-visible:ring-verity/40`.
- **Ưu tiên `:focus-visible`**: Không để lộ viền focus khi người dùng click chuột thông thường, chỉ kích hoạt khi di chuyển bằng bàn phím (`Tab`).
- **Thoát nhanh qua phím `Escape`**: Mọi Modal, Drawer, Lightbox phải lắng nghe phím `Escape` để đóng ngay lập tức (kèm exit animation).

### 6.3. Hiệu Suất Chuyển Động (Compositor-Only Animation)
- **Chỉ animate `transform` và `opacity`**: Tránh hoàn toàn animate các thuộc tính gây re-layout như `width`, `height`, `top`, `left`, `margin`.
- **Cấm tuyệt đối `transition: all`**: Luôn liệt kê rõ ràng các thuộc tính (ví dụ: `transition: transform 200ms ease, opacity 200ms ease`).
- **Bắt buộc có guard `prefers-reduced-motion`**:
  ```css
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.001ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.001ms !important;
    }
  }
  ```

### 6.4. Quy Chuẩn Typography & Tiếng Việt
- **Dấu ba chấm**: Dùng ký tự elipsis chuẩn `…` thay vì ba dấu chấm rời rạc `...`.
- **Cấm viết hoa toàn bộ (`uppercase`) với Tiếng Việt có dấu**: Tuyệt đối không dùng `uppercase` trên các nhãn Tiếng Việt vì sẽ làm vỡ dấu thanh. Dùng Sentence case kèm `letter-spacing: 0.02em`.
- **Số liệu & SKU**: Toàn bộ SKU, số lượng, tỷ lệ phần trăm, timestamp phải dùng font monospace (`font-mono`) hoặc `tabular-nums` để các con số không bị nhảy vị trí khi cập nhật.

### 6.5. Kích Thước Vùng Chạm (Touch Targets)
- Trên thiết bị di động (`< 768px`): Mọi nút bấm, icon button tương tác phải có vùng chạm tối thiểu **`44x44px`** (Apple HIG & Material Design standard).
- Trên máy tính (`>= 768px`): Nút bấm công cụ tối thiểu `32x32px` với padding thoải mái.

---

## 7. Quy Chuẩn & Đặc Tả Thành Phần Giao Diện (Component Specifications)

### 7.1. Thành Phần DetailDrawer ([DetailDrawer.tsx](../src/components/library/DetailDrawer.tsx))

| Thuộc tính / Khía cạnh | Đặc tả kỹ thuật |
| :--- | :--- |
| **Props** | `asset: MediaAsset \| null; onClose: () => void; onAssetUpdated?: (...); onAssetDeleted?: (...);` |
| **Trạng thái (States)** | `isOpen: boolean; isClosing: boolean; isDeleting: boolean; isCropperOpen: boolean; isLightboxOpen: boolean;` |
| **Backdrop** | `.t-drawer-backdrop` (`bg-black/40 backdrop-blur-xs`), đóng khi click chuột. |
| **Panel** | `.t-drawer-panel` (`w-full sm:max-w-[560px] md:max-w-[620px] bg-surface border-l shadow-drawer`). |
| **Bàn phím** | Phím `Escape` kích hoạt `handleDismiss()` (khi không có modal con nào đang mở). |
| **Thời gian đóng** | `200ms` (`--drawer-close-dur`), gọi `onClose()` sau khi hoàn tất animation. |

### 7.2. Thành Phần Toast Notification ([Toast.tsx](../src/components/common/Toast.tsx))

| Thuộc tính / Khía cạnh | Đặc tả kỹ thuật |
| :--- | :--- |
| **Context Hook** | `const { showToast } = useToast();` |
| **Các kiểu (Types)** | `'success'` (Nền surface, icon Check xanh), `'warn'` (Nền surface, icon Alert vàng cam), `'info'` (Nền xanh Verity). |
| **Vị trí** | `fixed bottom-6 left-1/2 -translate-x-1/2` (Desktop) / `bottom-[calc(64px+env(safe-area-inset-bottom)+0.75rem)]` (Mobile). |
| **Tự động đóng** | 2.800ms kích hoạt `handleDismiss()`, đợi 220ms (`--toast-close`) rồi gỡ khỏi state. |
| **Thao tác thủ công** | Nút `X` nhỏ ở góc phải thông báo cho phép người dùng tắt ngay lập tức. |
| **Khả năng tiếp cận** | Container bọc ngoài có `aria-live="polite"` và `aria-atomic="false"`. |

### 7.3. Thành Phần TopbarPortal & Review Modes
- **Cầu nối Portal**: Kết nối động giữa `ReviewView` và thanh `Topbar` thông qua `#topbar-portal-slot`, đảm bảo zero prop-drilling và zero global re-render.
- **Chế độ Focus (Mặc định)**: Hiển thị ảnh lớn, filmstrip thumbnail bên dưới và form metadata cạnh bên.
- **Chế độ Grid**: Phục vụ duyệt nhanh hàng loạt, chọn nhiều ảnh, đổi ảnh đại diện (reference SKU).

---

## 8. Chiến Lược Thích Ứng Màn Hình (Responsive Adaptation)

| Breakpoint | Layout Ứng Dụng | Điều Hướng Chính | Khu Vực Duyệt Ảnh |
| :--- | :--- | :--- | :--- |
| **Desktop** (`>= 1120px`) | Sidebar mở rộng (`w-60`) + Topbar (`52px`) | Sidebar đầy đủ với menu dọc | Chia 2 cột song song: Khung ảnh bên trái + Form metadata bên phải. |
| **Tablet** (`768px - 1119px`) | Navigation Rail hẹp (`w-16`) + Topbar (`52px`) | Icon rail tiết kiệm bề ngang | Tự động chuyển layout compact hoặc 2 tab: `[Ảnh]` và `[Metadata]`. |
| **Mobile** (`< 768px`) | Toàn màn hình + Bottom Navigation Bar | Thanh điều hướng dưới đáy (Bottom bar) | Tabbed navigation: Chuyển đổi giữa xem ảnh toàn màn hình và điền thông tin. |

---

## 9. Quy Trình Kiểm Thử & Nghiệm Thu Giao Diện (Verification & Quality Gates)

Trước khi commit hoặc triển khai bất kỳ thay đổi nào liên quan đến UI/UX:

```bash
# 1. Kiểm tra toàn diện kiểu dữ liệu TypeScript (Bắt buộc 0 lỗi)
npx tsc --noEmit

# 2. Chạy toàn bộ bộ test đơn vị và test hành vi
npm test

# 3. Kiểm tra build sản phẩm Next.js
npm run build

# 4. Kiểm tra khả năng tiếp cận và responsive chống tràn (E2E)
npx playwright test e2e/responsive/shell.spec.ts
```

Tiêu chí nghiệm thu bắt buộc:
1. `npx tsc --noEmit` thoát với mã `0`.
2. Không phát hiện bất kỳ lỗi tràn màn hình ngang (`expectNoDocumentOverflow`) trên cả 3 breakpoint: Mobile (375px), Tablet (768px), Desktop (1440px).
3. Không vi phạm bất kỳ quy tắc nào của Axe Accessibility Audit.
