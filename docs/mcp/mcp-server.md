# VerityDAM MCP Server — Master Reference & Architecture

Tài liệu chuẩn hóa kiến trúc, cấu hình, danh mục 13 công cụ và quy trình vận hành của **VerityDAM Model Context Protocol (MCP) Server** (`backend/verity_media_mcp/`).

> **Runtime (2026-09-11):** Native PostgreSQL 16 + pgvector + Cloudflare R2 + Better Auth. Không dùng Supabase, không dùng PostgREST, không dùng bot password-grant sign-in. Toàn bộ logic giao tiếp cơ sở dữ liệu sử dụng parameterized SQL transactions qua `PostgresRepository`.

---

## 1. Tổng quan & Kiến trúc Hệ thống (System Architecture)

`verity_media_mcp` cung cấp giao diện chuẩn MCP cho phép các tác tử AI (Agenthub, Claude Code, Cursor, Antigravity, OpenCode...) tra cứu, đánh giá, kiểm duyệt, cắt ảnh (crop) và quản lý tài sản số (DAM) trong hệ sinh thái VerityDAM Platform.

### Sơ đồ luồng dữ liệu (Data Flow)

```mermaid
flowchart TD
    subgraph Clients["AI Clients & Automation"]
        Agenthub["Agenthub Marketing Agent"]
        Claude["Claude Code / Desktop"]
        CursorAgent["Cursor / Antigravity IDE"]
    end

    subgraph Transport["Transport Layer (Port 8000)"]
        StreamHTTP["Streamable HTTP\nhttps://dam.verity.internal/mcp"]
        StdioPipe["stdio pipe\n(Local dev / Subprocess)"]
    end

    subgraph MCPEngine["verity_media_mcp Runtime"]
        Middleware["AuditMiddleware\n(mcp_tool_call_log)"]
        ServerCore["MCPServer Engine (13 Tools)"]
        Gateway["MediaMcpGateway\n(Role & Bot Session Verification)"]
    end

    subgraph StorageAndDB["Native Backend Infrastructure"]
        Postgres["PostgreSQL 16 + pgvector\n(media_assets, review_queue, media_usages)"]
        CloudflareR2["Cloudflare R2 Storage\n(Originals & WebP Thumbnails)"]
        NextSearch["Next.js Search Engine\n(/api/internal/media-search)"]
    end

    Agenthub -->|"HTTP POST (Session)"| StreamHTTP
    Claude -->|"stdio"| StdioPipe
    CursorAgent -->|"HTTP / stdio"| StreamHTTP

    StreamHTTP --> Middleware
    StdioPipe --> Middleware
    Middleware --> ServerCore
    ServerCore --> Gateway

    Gateway -->|"Parameterized SQL"| Postgres
    Gateway -->|"Permanent Public CDN URLs"| CloudflareR2
    ServerCore -->|"Internal Service Key (NLP Search)"| NextSearch
```

### Quy định Domain chuẩn (Canonical Domain & Anti-Hallucination)
- **Web App / Human Review Studio**: `https://dam.verity.internal`
- **MCP Endpoint**: `https://dam.verity.internal/mcp`
- **Public Media CDN**: `https://assets.verity.internal` (Cung cấp URL ảnh công khai vĩnh viễn, không hết hạn, không có query param chữ ký, tối ưu 100% cho Facebook/Zalo/Web crawler).
- **Link xem trước cho người dùng (Preview URL)**: Trỏ về `https://dam.verity.internal/library?asset={media_asset_id}`.

---

## 2. Mô hình Bảo mật, Phân quyền RBAC & Audit Log

### 2.1. Tài khoản Bot & Phân quyền (RBAC)
Mỗi thao tác ghi (write) hoặc truy vấn nội bộ (internal) đều được gắn danh tính với một tài khoản bot định danh trong bảng `public."user"` (Better Auth). 
- Cấu hình qua biến môi trường `VERITY_MEDIA_MCP_USER_ID` hoặc `VERITY_MEDIA_MCP_EMAIL` (mặc định: `mcp-agent@veritydam.example`).
- Bot bắt buộc phải có `role` thuộc 1 trong 4 quyền:

| Role | Quyền hạn trong MCP | Các tool được phép gọi |
|---|---|---|
| `viewer` | Chỉ đọc tài nguyên công khai và lịch sử sử dụng | `media_list_library`, `media_search`, `media_search_by_image`, `media_get_asset`, `media_get_usage_history`, `media_evaluate_image_fit`, `media_find_best_image_for_post` |
| `contributor` | Được phép upload ảnh mới vào hàng đợi duyệt và ghi nhận nhật ký sử dụng | Toàn bộ quyền `viewer` + `media_upload_asset`, `media_record_usage` |
| `reviewer` | Thẩm định, duyệt/từ chối, gán SKU, cập nhật metadata, lưu toạ độ crop | Toàn bộ quyền `contributor` + `media_list_pending_review`, `media_resolve_review_item`, `media_update_metadata`, `media_save_crop` |
| `admin` | Toàn quyền, bao gồm xem và khôi phục tài sản đã xóa mềm (`include_deleted=true`) | Tất cả 13 tools không giới hạn |

> **Khuyến nghị sản xuất:** Tài khoản bot của MCP server được gán vai trò `reviewer` để đảm bảo thực hiện được toàn bộ chu trình duyệt và tối ưu hóa hình ảnh.

### 2.2. Ghi vết kiểm toán (Audit Logging)
Mọi lượt gọi công cụ đều được bộ đệm `AuditMiddleware` (`audit.py`) tự động can thiệp và ghi nhận vào bảng `public.mcp_tool_call_log`:
- **An toàn thông tin**: Tự động lược bỏ/che dấu các trường nhạy cảm (`token`, `secret`, `key`, `password`), thu gọn base64 thành thông tin độ dài/mime type, cắt ngắn các văn bản quá dài.
- **Bắt lỗi toàn diện**: Tự động trích xuất nội dung từ `CallToolResult` (FastMCP) và chuỗi trả về. Nếu phát hiện tiền tố `Error:` hoặc `Error listing media:`, tự động chuyển trạng thái `status = 'error'` và ghi lại `error_message` đầy đủ.
- **Khả năng phục hồi (Fail-safe)**: Nếu thao tác ghi log vào cơ sở dữ liệu gặp sự cố, lỗi sẽ được đẩy ra `stderr` và không bao giờ làm gián đoạn hay ngắt luồng thực thi của tool nghiệp vụ.

---

## 3. Cấu hình & Kết nối Client (Agent Integration)

### 3.1. Biến môi trường (Environment Variables)

| Biến môi trường | Bắt buộc | Mặc định | Ý nghĩa |
|---|---|---|---|
| `DATABASE_URL` | Có | — | Chuỗi kết nối PostgreSQL (vd: `postgresql://user:pass@127.0.0.1:5432/verity_media`) |
| `R2_ENDPOINT` | Có | — | Cloudflare R2 S3 Endpoint |
| `R2_ACCESS_KEY_ID` | Có | — | Cloudflare R2 Access Key |
| `R2_SECRET_ACCESS_KEY` | Có | — | Cloudflare R2 Secret Access Key |
| `R2_BUCKET` | Có | — | Tên bucket R2 (vd: `verity-media`) |
| `VERITY_INTERNAL_SERVICE_KEY`| Có | — | Khóa bảo mật gọi nội bộ Next.js (`/api/internal/media-search`) |
| `NEXT_PUBLIC_APP_URL` | Không | `http://localhost:3000` | URL của Next.js app để proxy tìm kiếm NLP |
| `PUBLIC_BASE_URL` | Không | `https://dam.verity.internal` | Domain canonical cho các link preview |
| `VERITY_MEDIA_MCP_EMAIL` | Không | `mcp-agent@veritydam.example` | Email tài khoản bot Better Auth |
| `MCP_TRANSPORT` | Không | `streamable-http` | Giao thức chạy: `streamable-http`, `sse`, hoặc `stdio` |
| `MCP_PORT` | Không | `8000` | Port lắng nghe khi chạy HTTP transport |
| `MCP_PATH` | Không | `/mcp` | Đường dẫn endpoint Streamable HTTP |

### 3.2. Cấu hình Client kết nối Remote HTTP (Khuyên dùng)
Dành cho Agenthub, Antigravity, Cursor hoặc bất kỳ MCP client nào hỗ trợ Streamable HTTP:

```json
{
  "mcpServers": {
    "verity-media": {
      "url": "https://dam.verity.internal/mcp",
      "headers": {
        "Content-Type": "application/json"
      }
    }
  }
}
```

### 3.3. Cấu hình Client kết nối Local Stdio
Dành cho Claude Desktop, Claude Code chạy trực tiếp mã nguồn local:

```json
{
  "mcpServers": {
    "verity-media": {
      "command": "python",
      "args": ["-m", "verity_media_mcp", "stdio"],
      "cwd": "/path/to/verity-media/backend",
      "env": {
        "DATABASE_URL": "postgresql://...",
        "R2_ENDPOINT": "https://...",
        "R2_ACCESS_KEY_ID": "...",
        "R2_SECRET_ACCESS_KEY": "...",
        "R2_BUCKET": "verity-media",
        "VERITY_INTERNAL_SERVICE_KEY": "...",
        "NEXT_PUBLIC_APP_URL": "http://localhost:3000",
        "PUBLIC_BASE_URL": "https://dam.verity.internal"
      }
    }
  }
}
```

---

## 4. Danh mục Chi tiết 13 Công cụ (Comprehensive Tool Reference)

Hệ thống cung cấp **13 công cụ** được chia thành 3 phân nhóm chức năng:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        VerityDAM MCP Tools (13)                       │
├────────────────────────┬───────────────────────┬───────────────────────┤
│ 1. Tra cứu & Tìm kiếm  │ 2. Hàng đợi & Curation│ 3. Marketing & Usage  │
├────────────────────────┼───────────────────────┼───────────────────────┤
│ • media_search         │ • media_list_pending  │ • media_evaluate_fit  │
│ • media_list_library   │ • media_upload_asset  │ • media_find_best     │
│ • media_search_by_image│ • media_resolve_review│ • media_record_usage  │
│ • media_get_asset      │ • media_update_meta   │ • media_get_usage_hist│
│                        │ • media_save_crop     │                       │
└────────────────────────┴───────────────────────┴───────────────────────┘
```

### Nhóm 1: Tra cứu & Tìm kiếm (Discovery & Retrieval)

#### 1. `media_search`
- **Mô tả**: Tìm kiếm ảnh bằng ngôn ngữ tự nhiên (tiếng Việt hoặc tiếng Anh). Proxy trực tiếp đến bộ xếp hạng chuyên sâu Next.js (kết hợp vector semantic SigLIP2, từ khóa lexical, nhận diện thực thể SKU, chống trùng lặp MMR). Tự động loại trừ (hard-exclude) các asset đang có báo lỗi (status `open` hoặc `in_review`) và các asset đang gắn cờ `needs_post_production` (ảnh thô/chưa hậu kỳ, hoặc chứa nội dung nhạy cảm/NDA chưa được công bố).
- **Quyền hạn**: `viewer`, `contributor`, `reviewer`, `admin`
- **Input Parameters**:
  - `query` (string, required, max 300 chars): Câu truy vấn tự nhiên (vd: *"Khóa cửa Acme A100 vân tay cửa gỗ"*).
  - `category`, `space`, `status`, `permission`, `media_type` (string, optional): Bộ lọc chính xác.
  - `limit` (int, 1-100, default 20), `offset` (int, default 0).
  - `include_reported` (bool, default false, chỉ dành cho `reviewer`/`admin`): Cho phép hiển thị asset đang có báo lỗi để phục vụ rà soát.
  - `include_unfinished` (bool, default false, chỉ dành cho `reviewer`/`admin`): Cho phép hiển thị asset đang gắn cờ `needs_post_production`.
  - `response_format` ("json" | "markdown", default "json").
- **Output**: Trả về struct `MediaSearchOutput` gồm danh sách kết quả kèm `product_safety.safe_for_exact_product_use` (cờ bảo vệ sản phẩm tuyệt đối không nhầm model), `has_open_report` (cảnh báo asset đang có báo lỗi), `needs_post_production` (cảnh báo asset chưa hậu kỳ/chưa được duyệt để publish), `canonical_sku_matches`, `match_reasons`, và `markdown_summary`.

#### 2. `media_list_library`
- **Mô tả**: Duyệt và lọc danh sách hình ảnh đã được phê duyệt (`review_state = 'approved'`). Hỗ trợ sắp xếp theo mức độ liên quan nếu có `query` hoặc theo thời gian mới nhất. Tự động loại trừ ảnh đang có báo lỗi chưa xử lý và ảnh đang gắn cờ `needs_post_production`.
- **Quyền hạn**: `viewer`, `contributor`, `reviewer`, `admin`
- **Input Parameters**:
  - `query` (string, optional): Từ khóa tìm kiếm tiếng Việt.
  - `category`, `space`, `status`, `permission`, `media_type` (optional): Bộ lọc chính xác. Hỗ trợ cả truyền tham số phẳng lẫn bọc trong object `filters: {...}`.
  - `limit` (int, 1-50, default 20), `offset` (int, default 0).
  - `include_deleted` (bool, default false, chỉ dành cho `admin`).
  - `include_reported` (bool, default false, chỉ dành cho `reviewer`/`admin`): Cho phép duyệt cả ảnh đang có báo lỗi.
  - `include_unfinished` (bool, default false, chỉ dành cho `reviewer`/`admin`): Cho phép duyệt cả ảnh đang gắn cờ `needs_post_production`.
  - `response_format` ("markdown" | "json", default "markdown"). Khi vượt quá giới hạn ký tự, cả hai định dạng đều cắt tại ranh giới từng item (không còn cắt giữa chuỗi JSON) và trả về `truncated: true` kèm số lượng đã trả về / tổng số ứng viên.
- **Output**: Định dạng Markdown hiển thị đầy đủ: Tiêu đề, SKU, Thương hiệu, Danh mục, Không gian, Trạng thái, **dimensions (chiều rộng x cao và bytes)**, **crop_configs (toạ độ crop các tỷ lệ)**, **file_url (link CDN vĩnh viễn https://assets.verity.internal/...)**, và thumbnail CDN URL.

#### 3. `media_search_by_image`
- **Mô tả**: Tìm kiếm ảnh tương đồng trực quan (Visual Similarity Search) thông qua vector embedding của một asset có sẵn hoặc từ chuỗi `image_base64` thô gửi lên.
- **Quyền hạn**: `viewer`, `contributor`, `reviewer`, `admin`
- **Input Parameters**:
  - `media_asset_id` (UUID string, optional): ID ảnh gốc đã có trong thư viện.
  - `image_base64` (string, optional): Dữ liệu base64 ảnh mới để trích xuất vector tức thời. *(Cung cấp đúng 1 trong 2 tham số trên)*.
  - `min_similarity` (float, 0.0 - 0.999, default 0.3): Ngưỡng tương đồng cosine tối thiểu.
  - `match_count` (int, 1-50, default 20).
  - `public_only` (bool, default false): Chỉ lấy ảnh quyền public.
  - `response_format` ("markdown" | "json", default "markdown").
- **Output**: Danh sách ảnh có độ tương đồng giảm dần kèm chỉ số `similarity`.

#### 4. `media_get_asset`
- **Mô tả**: Lấy toàn bộ thông tin chi tiết, metadata, signed URLs và các cấu hình crop của một tài sản số duy nhất.
- **Quyền hạn**: `viewer`, `contributor`, `reviewer`, `admin`
- **Input Parameters**:
  - `media_asset_id` (UUID string, required).
  - `include_deleted` (bool, default false, admin only).
  - `response_format` ("markdown" | "json", default "markdown").
- **Output**: Báo cáo Markdown hoặc JSON chi tiết của asset.

---

### Nhóm 2: Hàng đợi Duyệt & Quản lý Metadata (Review & Curation)

#### 5. `media_list_pending_review`
- **Mô tả**: Liệt kê các ảnh mới tải lên đang nằm trong hàng đợi duyệt (`review_queue` có `status = 'pending'`), sắp xếp theo thứ tự cũ nhất trước (FIFO) kèm metadata do AI tự động gợi ý (`metadata_draft`) và cờ cảnh báo trùng lặp (`is_duplicate`).
- **Quyền hạn**: `reviewer`, `admin`
- **Input Parameters**: `limit` (1-50, default 20), `offset` (default 0), `response_format` (default "markdown").
- **Output**: Danh sách mục cần duyệt kèm nhãn cảnh báo trùng lặp và bản nháp metadata.

#### 6. `media_upload_asset`
- **Mô tả**: Upload dữ liệu ảnh/video thô (dạng Base64) trực tiếp lên Cloudflare R2, tự động đăng ký tài sản mới vào bảng `media_assets` ở trạng thái `pending` và đưa vào `review_queue`.
- **Quyền hạn**: `contributor`, `reviewer`, `admin`
- **Input Parameters**:
  - `image_base64` (string, required): Dữ liệu nhị phân base64 của file.
  - `filename` (string, 1-200 ký tự): Tên file gốc (dùng để trích xuất Content-Type).
  - `media_type` ("photo" | "video" | "render" | "screenshot").
  - `permission` ("public" | "internal", default "public" — job ingest nên truyền `internal` tường minh).
  - `context` (string, optional, max 500 chars): Nhãn lô ổn định (vd "Zalo Marketing 2026-10-28"). Lưu ở `origin_info.batch_context`.
  - `sha256` (string, optional, 64 ký tự hex): SHA-256 của bytes gốc. Server luôn tự băm bytes đã giải mã; nếu truyền vào mà không khớp thì upload bị từ chối.
  - `source_ref` (string, optional, max 200 chars): Mã nguồn theo từng file (vd `zalo:marketing:<message_id>`). Lưu ở `origin_info.source_ref`.
- **Chống trùng chính xác**: nếu đã có asset chưa xoá với cùng `content_hash`, không lưu gì và trả về `## Upload skipped (exact duplicate)` kèm `duplicate_of_media_asset_id`, `review_state`, `review_queue_id`. Trùng gần giống (embedding) vẫn do worker gắn cờ `is_duplicate` sau đó. Không có unique index ở DB, nên hai upload đồng thời cùng một file có thể cùng lọt qua.
- **Định dạng chấp nhận** (suy từ đuôi file): jpeg, png, webp, avif, gif, mp4, webm, mov. **HEIC/HEIF chưa được hỗ trợ ở tool này** (web app thì có). Tối đa 50 MB ảnh, 200 MB video.
- **Output**: Markdown `## Upload accepted (pending review)` chứa `media_asset_id`, `review_queue_id`, `sha256` (cờ `is_duplicate` nếu có).

#### 7. `media_resolve_review_item`
- **Mô tả**: Phê duyệt (`approved`) hoặc từ chối (`rejected`) một mục trong hàng đợi duyệt. Cho phép cập nhật/sửa đổi metadata, ghi nhận lỗi sai của AI vào `review_correction_log` để huấn luyện few-shot, và cờ `promote_reference`.
- **Quyền hạn**: `reviewer`, `admin`
- **Input Parameters**:
  - `review_queue_id` (UUID string, required).
  - `decision` ("approved" | "rejected").
  - `patch` (dict, optional): Các trường cập nhật khi duyệt (`title`, `sku`, `brand`, `category`, `space`, `status`, `permission`, `suggested_caption`, `author`, `copyright`, `credit`, `description`, `keywords`).
  - `corrections` (dict[str, bool], optional): Đánh dấu trường nào đã sửa lỗi AI (vd: `{"sku": true}`).
  - `promote_reference` (bool, default false): Thăng hạng ảnh thành ảnh tham chiếu chuẩn cho SKU.
- **Output**: Chuỗi JSON xác nhận trạng thái duyệt.

#### 8. `media_update_metadata`
- **Mô tả**: Cập nhật thông tin tiêu đề, mô tả, danh mục, từ khóa... trên một ảnh **đã duyệt** hoặc **bị từ chối**. (Lưu ý: Không đổi SKU tại đây; SKU chỉ đổi qua `media_resolve_review_item`).
- **Quyền hạn**: `reviewer`, `admin`
- **Input Parameters**:
  - `media_asset_id` (UUID string, required).
  - `patch` (dict, required): Các trường cần cập nhật.
- **Output**: Chuỗi JSON xác nhận thông tin cập nhật.

#### 9. `media_save_crop`
- **Mô tả**: Lưu cấu hình toạ độ cắt ảnh hình chữ nhật (pixel-space) theo các tỉ lệ chuẩn vào cột `origin_info->'crop_configs'`. Toạ độ được kiểm tra hợp lệ chặt chẽ so với kích thước gốc (chiều rộng/chiều cao tự nhiên).
- **Quyền hạn**: `reviewer`, `admin`
- **Input Parameters**:
  - `media_asset_id` (UUID string, required).
  - `preset_id` ("1:1" | "9:16" | "16:9" | "4:5" | "free").
  - `crop` (dict, required): `{"x": float, "y": float, "width": float, "height": float}`.
- **Output**: Trả về JSON toạ độ crop đã lưu kèm **đường link preview trực quan**:
  ```text
  {
    "1:1": {"x": 0, "y": 180, "width": 750, "height": 750}
  }

  Crop saved. Preview at: https://dam.verity.internal/library?asset=b5515567-a0a6-418c-a8d9-21675df4ddbd
  ```

---

### Nhóm 3: Marketing Intelligence & Điều phối Xuất bản (Marketing & Usage)

#### 10. `media_evaluate_image_fit`
- **Mô tả**: Đánh giá độ phù hợp toàn diện của một bức ảnh đối với nội dung bài viết/post mạng xã hội theo thang điểm chuẩn 0–3:
  - **Grade 3 (Ideal)**: Đúng chính xác sản phẩm (SKU), bối cảnh tối ưu, tỉ lệ khung hình chuẩn.
  - **Grade 2 (Highly Relevant)**: Phù hợp ý niệm, bối cảnh đời sống/lifestyle chấp nhận được.
  - **Grade 1 (Marginally Relevant)**: Liên kết yếu, sai biến thể/model, hoặc góc chụp bị che khuất.
  - **Grade 0 (Irrelevant / Unsafe)**: Lệch hoàn toàn, ảo giác, hoặc vi phạm ràng buộc an toàn sản phẩm.
- **Quyền hạn**: `viewer`, `contributor`, `reviewer`, `admin`
- **Input Parameters**:
  - `article_text` (string, 1 - 10,000 chars): Toàn văn bài viết hoặc caption cần ghép ảnh.
  - `media_asset_id` (string, optional) HOẶC `image_base64` (string, optional).
  - `channel` (string, default "facebook"): Kênh triển khai (`facebook`, `zalo`, `website`, `instagram`, `tiktok`).
  - `within_days` (int, default 14): Cửa sổ kiểm tra tần suất sử dụng để tránh đăng trùng.
  - `product_hint` (string, optional): Mã SKU hoặc tên model bắt buộc thẩm định.
- **Output**: `EvaluateImageFitOutput` gồm `fit_grade`, `fit_label`, `rationale`, phân tích `technical_suitability` (khung hình Feed/Story), `product_match` (độ tin cậy khớp SKU), và `already_used_recently` (lịch sử dùng trong 14 ngày).

#### 11. `media_find_best_image_for_post`
- **Mô tả**: **Nhạc trưởng tự động hóa (Workflow Composer)**. Thực hiện trọn gói quy trình:
  1. Trích xuất query tìm kiếm từ bài viết và `product_hint`.
  2. Tìm kiếm ứng viên qua `media_search`.
  3. Dùng Vision AI chấm điểm fit grade (0-3) cho từng ứng viên.
  4. Kiểm tra lịch sử xuất bản trên kênh để chống đăng lặp.
  5. Áp dụng cơ chế **Starvation Breaker** & **LRU Fallback** để chọn ra ứng viên tốt nhất `best_pick`.
- **Quyền hạn**: `viewer`, `contributor`, `reviewer`, `admin`
- **Input Parameters**:
  - `post_text` (string, required, 1 - 10,000 chars): Nội dung bài post.
  - `search_query` (string, optional): Query tùy biến (nếu để trống, hệ thống tự trích xuất từ post).
  - `channel` (string, default "facebook").
  - `product_hint` (string, optional).
  - `exclude_used_within_days` (int, default 14): Số ngày cần tránh đăng lặp lại.
  - `candidate_count` (int, default 6, max 15): Số lượng ứng viên mang đi chấm điểm Vision.
  - `min_fit_grade` (int, default 2): Điểm chuẩn sàn để lọt vào `best_pick`.
- **Output**: `FindBestImageOutput` gồm `best_pick` (ứng viên tối ưu nhất), `ranked_candidates` (toàn bộ danh sách ứng viên đã xếp hạng), và `markdown_summary`.

#### 12. `media_record_usage`
- **Mô tả**: Ghi nhận một lượt xuất bản tài sản số lên kênh truyền thông (chỉ cho phép ghi nhận đối với ảnh đã duyệt `approved`). Phục vụ audit trail và chống đăng trùng lặp ảnh. **Publish-time safety guard**: từ chối (raise `GatewayError`) nếu asset đang có báo lỗi mở (`has_open_report`, không thể ghi đè — phải xử lý báo lỗi trước) hoặc đang gắn cờ `needs_post_production` trừ khi có `allow_unfinished=true` từ tài khoản `reviewer`/`admin`. Đây là lớp chặn thứ hai, độc lập với việc loại trừ ở bước tìm kiếm (`media_search`/`media_list_library`) — áp dụng cả khi agent lấy asset qua `media_get_asset` (công cụ này không tự động loại trừ theo id đã biết). Nhãn `permission` (internal/public) **không** phải là điều kiện chặn ở đây — đó chỉ là nhãn hiển thị cho người dùng.
- **Quyền hạn**: `contributor`, `reviewer`, `admin`
- **Input Parameters**:
  - `media_asset_id` (UUID string, required).
  - `channel` (string, required): Slug kênh chữ thường (vd: `'facebook'`, `'zalo'`, `'website'`, `'tiktok'`).
  - `note` (string, optional, max 500 chars): Ghi chú chiến dịch hoặc URL bài đăng.
  - `allow_unfinished` (bool, default false, chỉ dành cho `reviewer`/`admin`): Ghi đè guard `needs_post_production` khi có lý do xác đáng cho kênh cụ thể (vd: kênh nội bộ `'crm'`).
- **Output**: `RecordUsageOutput` gồm `usage_id`, `media_asset_id`, `channel`, `used_at` (ISO-8601 UTC).

#### 13. `media_get_usage_history`
- **Mô tả**: Truy xuất toàn bộ lịch sử xuất bản và nhật ký triển khai của một tài sản số trên các kênh tiếp thị.
- **Quyền hạn**: `viewer`, `contributor`, `reviewer`, `admin`
- **Input Parameters**:
  - `asset_id` (UUID string, required).
  - `limit` (int, 1-100, default 20).
- **Output**: `MediaUsageHistoryOutput` gồm tổng số lượt dùng (`total`) và danh sách chi tiết các lượt đăng (`usages`: kênh, người đăng, ghi chú, thời gian).

---

## 5. Nguyên tắc Thiết kế & Cơ chế Xử lý Lỗi (Design Principles)

### 5.1. Mô hình xử lý lỗi có chủ đích (Intentional Error Patterns)
Hệ thống áp dụng hai mô hình xử lý lỗi riêng biệt tùy theo mục đích sử dụng của công cụ:
- **Các CRUD Tools dạng văn bản (`media_list_library`, `media_get_asset`, `media_save_crop`,...)**: Bắt `GatewayError` nội bộ và trả về chuỗi thông báo rõ ràng dạng `Error: <lý_do>`. Điều này giúp các LLM đơn giản nhận diện được lý do và tự điều chỉnh tham số mà không bị crash phiên đàm thoại.
- **Các Structured Output Tools (`media_search`, `media_record_usage`, `media_get_usage_history`,...)**: Giữ nguyên cơ chế **Raise Exception**. Khi gặp lỗi về quyền hạn (RBAC) hoặc không tìm thấy bản ghi hợp lệ, ngoại lệ `GatewayError` sẽ được ném thẳng ra giao thức MCP với cờ `isError: true`. Điều này bảo vệ tính toàn vẹn của Pydantic Schema, tránh trả về dữ liệu rác/giả mạo UUID.

### 5.2. Nguyên tắc Fail-Closed trong Đánh giá Hình ảnh
Trong `media_evaluate_image_fit`:
- Nếu API Vision gặp sự cố (mất mạng, timeout, parse lỗi), hệ thống **tuyệt đối không đoán bừa** hay tự gán điểm cao.
- Hệ thống áp dụng nguyên tắc **Fail-Closed**: Trả về `fit_grade = 0` ("Irrelevant / Unsafe") kèm giải thích bằng tiếng Việt yêu cầu người dùng kiểm tra thủ công. Điều này ngăn chặn việc xuất bản hình ảnh sai sản phẩm ra công chúng trong các luồng chạy tự động.

### 5.3. Thuật toán Xoay vòng Ảnh (Starvation Breaker & LRU Fallback)
Khi tự động gợi ý ảnh cho chiến dịch qua `media_find_best_image_for_post`:
1. **Ưu tiên ảnh chưa từng đăng**: Nếu Ứng viên A (Grade 3) đã đăng trong vòng 14 ngày, nhưng Ứng viên B (Grade 2) chưa từng đăng $\rightarrow$ Ứng viên B sẽ chiến thắng (`Starvation Breaker`).
2. **Cơ chế LRU Fallback**: Nếu toàn bộ ứng viên đủ chuẩn đều đã được sử dụng trong vòng 14 ngày qua $\rightarrow$ Hệ thống không trả về rỗng mà tự động chọn bức ảnh có thời gian xuất bản **cũ nhất** (Least Recently Used) để tái sử dụng hợp lý.

---

## 6. Kịch bản Thực chiến cho Digital Marketing (Actionable Recipes)

### Kịch bản 1: Đăng bài tự động lên Facebook kèm Xoay vòng ảnh & Ghi vết
Quy trình khuyến nghị cho Marketing Agent (như Agenthub):

```text
BƯỚC 1: Tìm ảnh phù hợp nhất
CALL media_find_best_image_for_post(
  post_text="Khóa thông minh Acme A100 mở bằng Apple HomeKit siêu tiện lợi...",
  channel="facebook",
  product_hint="Acme A100",
  exclude_used_within_days=14
)
→ Nhận best_pick: asset_id = "43a5a39e-..."

BƯỚC 2: Kiểm tra toạ độ crop tỉ lệ 1:1 cho Facebook Feed
CALL media_get_asset(media_asset_id="43a5a39e-...")
→ Kiểm tra trường crop_configs["1:1"]. Nếu chưa có hoặc muốn tối ưu:
CALL media_save_crop(media_asset_id="43a5a39e-...", preset_id="1:1", crop={...})

BƯỚC 3: Xuất bản bài viết lên Facebook thành công qua Facebook Graph API

BƯỚC 4: Ghi nhận vết kiểm toán vào DAM
CALL media_record_usage(
  media_asset_id="43a5a39e-...",
  channel="facebook",
  note="Campaign Tháng 9 - Bài đăng Khóa Acme A100 Post ID #884192"
)
```

---

### Kịch bản 2: Quy trình Thẩm định, Gán SKU và Phê duyệt Ảnh mới
Dành cho Reviewer Bot kiểm duyệt kho ảnh thô:

```text
BƯỚC 1: Lấy danh sách ảnh đang chờ duyệt
CALL media_list_pending_review(limit=5)
→ Thu được review_queue_id và metadata_draft do AI gợi ý.

BƯỚC 2: Xem ảnh và kiểm tra thông số kỹ thuật
CALL media_get_asset(media_asset_id="...")

BƯỚC 3: Phê duyệt và chuẩn hóa SKU
CALL media_resolve_review_item(
  review_queue_id="...",
  decision="approved",
  patch={
    "title": "Khóa cửa EDEN DL05 lắp cửa chính căn hộ",
    "sku": "Eden DL05",
    "brand": "EDEN",
    "category": "Ảnh thực tế",
    "permission": "public"
  },
  corrections={"sku": false},
  promote_reference=true
)
```

---

## 7. SOP Vận hành, Kiểm tra & Chẩn đoán Sự cố (Troubleshooting)

### 7.1. Kiểm tra trạng thái dịch vụ trên VPS (Health Check)
Endpoint `/mcp` chạy giao thức Streamable HTTP. Kiểm tra bằng `curl`:

```bash
# Kiểm tra HTTP Status (khi không truyền Session ID, server phải trả về HTTP 400 - chứng tỏ service sống)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/mcp
# Kết quả mong đợi: 400

# Kiểm tra container Docker trên VPS
docker ps --filter "name=verity_native_media_mcp"
docker logs --tail 20 verity_native_media_mcp
```

### 7.2. Tái triển khai hoặc Khởi động lại MCP Container
Khi có thay đổi mã nguồn trong `backend/verity_media_mcp/`:

```bash
cd /opt/verity-media/current
# Compose project phải khớp release đang trỏ bởi symlink, không hardcode SHA cũ:
RELEASE="$(basename "$(readlink -f /opt/verity-media/current)")"
# Rebuild/restart MCP mà không ảnh hưởng tới DB hay Web app:
docker compose -f docker-compose.yml -p "$RELEASE" --env-file .env.production build verity-media-mcp
docker compose -f docker-compose.yml -p "$RELEASE" --env-file .env.production up -d --no-deps verity-media-mcp
```

### 7.3. Truy vấn Chẩn đoán Cơ sở Dữ liệu (SQL Diagnostics)

```sql
-- 1. Xem nhật ký 10 lượt gọi tool gần nhất qua MCP:
SELECT tool_name, status, duration_ms, error_message, created_at 
FROM public.mcp_tool_call_log 
ORDER BY created_at DESC LIMIT 10;

-- 2. Kiểm tra cấu hình crop và toạ độ của một asset:
SELECT id, title, dimensions, origin_info->'crop_configs' as crops 
FROM public.media_assets 
WHERE id = 'b5515567-a0a6-418c-a8d9-21675df4ddbd';

-- 3. Kiểm tra lịch sử xuất bản của asset trên các kênh:
SELECT channel, used_by, note, used_at 
FROM public.media_usages 
WHERE media_asset_id = 'b5515567-a0a6-418c-a8d9-21675df4ddbd' 
ORDER BY used_at DESC;
```

---

## 8. Lịch sử Phiên bản & Đóng góp (Changelog)

- **v0.1.4 (2026-10-28)**: Chuẩn bị luồng ingest tự động —
  - `media_upload_asset` tự băm SHA-256, từ chối upload trùng chính xác, nhận thêm `sha256` (kiểm tra toàn vẹn) và `source_ref` (mã nguồn theo file).
  - Cho phép tạo API key role `contributor` ở Settings → MCP agents (trước đây chỉ `viewer`/`reviewer`).
- **v0.1.3 (2026-09-23)**: MCP publish safety guard —
  - Sửa lỗi cắt chuỗi output tại đúng 25.000 ký tự làm hỏng JSON (`media_list_library` với `limit` lớn); nay cắt tại ranh giới item và trả về `truncated: true` hợp lệ.
  - `needs_post_production` được surface vào output của `media_search`/`media_list_library` và tự động loại trừ khỏi kết quả mặc định (tham số `include_unfinished`, chỉ `reviewer`/`admin`), mirror đúng pattern `include_reported` đã có.
  - `media_record_usage` chặn publish nếu asset đang có báo lỗi mở (không thể ghi đè) hoặc gắn cờ `needs_post_production` (ghi đè được qua `allow_unfinished=true`, chỉ `reviewer`/`admin`). Xác nhận rõ: nhãn `permission` internal/public **không** phải cơ chế chặn của MCP, chỉ là nhãn hiển thị cho người dùng.
- **v0.1.2 (2026-09-10)**:
  - Bổ sung `dimensions` (WxH, size_bytes), `crop_configs` (toạ độ JSON) và `file_url` vào Markdown output của `formatting.py`.
  - Bổ sung link preview studio (`https://dam.verity.internal/library?asset=...`) vào kết quả trả về của `media_save_crop`.
  - Cập nhật server instructions với domain canonical chuẩn `dam.verity.internal`, ngăn chặn hallucination sang `assets.verity.internal`.
  - Chuẩn hóa toàn bộ tài liệu đặc tả 13 công cụ theo chuẩn `/ck:docs`.
- **v0.1.1 (2026-09-08)**: Bổ sung marketing workflow composer (`media_find_best_image_for_post`), Vision evaluation (`media_evaluate_image_fit`), và hệ thống ghi nhận xuất bản kênh (`media_record_usage`, `media_get_usage_history`).
- **v0.1.0 (2026-08-26)**: Chuyển đổi toàn diện sang native PostgreSQL + Cloudflare R2 + Better Auth runtime.
