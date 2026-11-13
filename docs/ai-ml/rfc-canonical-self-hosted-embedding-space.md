# RFC: Kiến Trúc Canonical Self-Hosted Embedding Space (VerityDAM DAM)

**Tác giả / Đề xuất:** Đội ngũ Kỹ thuật VerityDAM  
**Ngày:** 26/08/2026  
**Trạng thái Phê Duyệt:**
- **Kiến trúc tổng thể (Architecture):** `APPROVED` ✅
- **Kế hoạch Benchmark (Benchmark Implementation):** `GO` 🚀
- **Triển khai Production (Production Cutover):** `BLOCKED` ⏸️ *(Đợi kết quả Benchmark & Nghiệm thu Shadow Migration)*

---

## 1. Tóm Tắt Định Hướng (Executive Summary)

Hệ thống **VerityDAM DAM** chính thức dừng thảo luận về kiến trúc bộ định tuyến đa nhà cung cấp (*Multi-Provider Router*) và chuyển sang chiến lược:

> 🎯 **1 Canonical Embedding Model $\longrightarrow$ Self-Host / Local Runtime $\longrightarrow$ Không Quota $\longrightarrow$ Không Runtime Fallback.**  
> Mô hình chỉ thay đổi khi có benchmark thực nghiệm độc lập chứng minh sự vượt trội đáng kể trên dữ liệu thật của Verity.

### 4 Dòng Định Danh Bất Biến (Canonical Contract):
- **Canonical Checkpoint:** `laion/CLIP-ViT-B-32-256x256-DataComp-s34B-b86K`
- **Input Resolution:** **`256 × 256` px (Cố định, duy nhất)**
- **Embedding:** **`512-d` vector, L2-normalized**
- **Production Runtime:** **ONNX Runtime (CPU)** được nghiệm thu qua cổng kiểm định PyTorch $\leftrightarrow$ ONNX Parity Test và VPS Benchmark.

---

## 2. Bản Chất Workload & Triết Lý Xử Lý Sự Cố (Failure Philosophy)

### 2.1. Asynchronous Enrichment qua Durable Queue
- Nhận diện SKU trong hệ thống DAM là tác vụ **làm giàu dữ liệu bất đồng bộ** (*asynchronous enrichment*), không phải tác vụ synchronous tương tác thời gian thực như chatbot.
- Toàn bộ ảnh tải lên đi qua hàng đợi `media_ingest_jobs` với các trường quản lý trạng thái: `queued`, `processing`, `attempts`, `max_attempts`, `run_after`, `locked_at`, `locked_by`.
- **Cơ chế phục hồi:** Khi embedding worker gặp sự cố tạm thời (quá tải CPU, restart container), job được release về trạng thái `queued` và tự động retry theo cơ chế **Durable Queue + Bounded Exponential Backoff**. Không mất ảnh, không hỏng vector, không gây gián đoạn luồng upload.

### 2.2. So Sánh 2 Hướng Tiếp Cận:

```text
❌ HƯỚNG MULTI-PROVIDER FALLBACK (Bị bác bỏ):
Embedding Lỗi ──▶ Router ──▶ Model B ──▶ Space B ──▶ Threshold B ──▶ Re-embed Catalog B ──▶ Gánh nặng kiến trúc khổng lồ

✅ HƯỚNG CANONICAL SELF-HOSTED (Được chọn):
Upload ──▶ Ingest Job ──▶ Local ONNX Runtime ──▶ PostgreSQL pgvector (512-d) ──▶ SKU Match
                                │
                        (Nếu Worker bận/lỗi)
                                ▼
                   Job ở lại Queue & Bounded Retry
```

---

## 3. Thông Số Kỹ Thuật Chi Tiết của Canonical Model

| Thuộc tính | Đặc tả Kỹ thuật | Ghi chú Vận hành |
|---|---|---|
| **Space ID** | `verity-openclip-b32-datacomp-256-v1` | Tên định danh versioned space trong DB |
| **Model Checkpoint** | `laion/CLIP-ViT-B-32-256x256-DataComp-s34B-b86K` | Upstream OpenCLIP ViT-B/32 DataComp-1B (34B samples seen) |
| **Weights File Gốc** | `open_clip_model.safetensors` (~605 MB) | Checkpoint gốc dùng để export ONNX |
| **Source Checksum** | `92c26d60d3200ed5ed040dff31a8d19f8140648da8007216c25744c478deef27` | SHA-256 file safetensors công bố bởi Hugging Face |
| **Production Artifact** | `/opt/models/openclip-256.onnx` | Tệp binary ONNX chạy thực tế trong container |
| **ONNX Metadata** | `onnx_opset = 17`<br>`execution_provider = CPUExecutionProvider`<br>`input_dtype = float32`<br>`output_dtype = float32` | Khóa cố định phiên bản runtime và opset |
| **Vector Dimension** | **512 dimensions** | Khớp chính xác kiểu dữ liệu `vector(512)` hiện có của PostgreSQL |
| **Input Resolution** | **`256 × 256` px** | Chuẩn hóa cố định (ONE PREPROCESSING) |
| **Normalization** | Mean: `[0.48145466, 0.4578275, 0.40821073]`<br>Std: `[0.26862954, 0.26130258, 0.27577711]` | Áp dụng tiền xử lý RGB trước khi đưa vào tensor |
| **Metric & Normalization** | Cosine Similarity (`vector_cosine_ops`), L2 Normalized (`||v||_2 = 1.0`) | Tối ưu cho HNSW index trong pgvector |
| **Licensing** | Checkpoint repository khai báo **MIT License** | Lưu trữ hồ sơ compliance trong deployment record |

---

## 4. Kiến Trúc Production Runtime: ONNX Runtime CPU & Strict Offline

### 4.1. Tách Biệt Vai Trò PyTorch vs ONNX Runtime
Để duy trì Docker image nhẹ, tránh tái đưa framework PyTorch cồng kềnh vào production container:
- **Development & Benchmark Environment:** Sử dụng PyTorch/OpenCLIP làm reference implementation, xuất khẩu mô hình sang định dạng ONNX và thực hiện đo đạc baseline.
- **Production Runtime Environment:** Sử dụng **`onnxruntime` (C++ backend, CPU-optimized)**.
- **Cổng Kiểm Định Parity Gate & Golden Preprocessing Test:**  
  1. **Golden Preprocessing Test:** Sử dụng bộ 10–20 ảnh golden chuẩn để kiểm định:
     $$\text{Raw Image} \xrightarrow{\text{Verity Preprocessing}} \text{ONNX} \approx \text{Raw Image} \xrightarrow{\text{OpenCLIP preprocess\_val}} \text{PyTorch}$$
  2. **Parity Metric:** Mô hình ONNX chỉ được chấp thuận đưa lên production khi đạt sai số vector gần như tuyệt đối so với PyTorch:
     $$\text{CosineSimilarity}(\mathbf{v}_{\text{PyTorch}}, \mathbf{v}_{\text{ONNX}}) \ge 0.9999 \quad \forall \text{ ảnh trong test set}$$

### 4.2. Định Nghĩa 100% Offline & Immutability
- **Nghiêm cấm** mọi dòng lệnh tải weights động từ Internet khi container khởi động (ví dụ `create_model_from_pretrained("hf-hub:...")`).
- **Quy trình Build/Deploy:**
  1. Tải weights một lần duy nhất trong quá trình build image hoặc đóng gói local volume.
  2. Xác minh SHA-256 checksum khớp chính xác `92c26d60...8deef27` (source) và `onnx_sha256` (binary export).
  3. Runtime nạp model trực tiếp từ đường dẫn tệp cục bộ (`/opt/models/openclip-256.onnx`).
  4. Hệ thống hoàn toàn không phụ thuộc vào trạng thái hoạt động của Hugging Face Hub, Jina API hay 9Router.

---

## 5. Phương Pháp Benchmark Khoa Học: Two-Cohort & 3-Way Split

Để so sánh công bằng và tránh ngụy biện thống kê, hệ thống phân tách thành **2 Cohort đánh giá độc lập** và **3 tập dữ liệu bất biến**:

### 5.1. Hai Cohort Đo Lường (Two-Cohort Evaluation Structure)

```text
                    Authoritative WooCommerce Catalog
                               1,729 SKUs
                                   │
                                   ▼
                       Eligible Reference Universe
                    (Sau kiểm định URL, decode, hash)
                                   │
          ┌────────────────────────┴────────────────────────┐
          ▼                                                 ▼
[COHORT A: QUALITY BENCHMARK]                      [COHORT B: COVERAGE BENCHMARK]
- Reference Corpus: CÙNG MỘT BỘ ẢNH CHUẨN          - Toàn bộ Eligible Catalog References
  (Chỉ lấy SKU giao nhau: Jina ∩ OpenCLIP)          - Đo lường độ phủ catalog thực tế:
- So sánh công bằng Model-vs-Model:                   Coverage = Usable References / Eligible SKUs
  Top-1, Top-5, CI, Hard-Confusion, Precision       - Jina: ~39% vs OpenCLIP Target: ~100%
```

> ⚠️ **Quy tắc bất biến:** Không được so sánh Accuracy của OpenCLIP trên 1.700 SKU với Jina trên 670 SKU (khác tập reference). Đánh giá chất lượng mô hình (Cohort A) bắt buộc phải chạy trên cùng một bộ ảnh reference gốc.

---

### 5.2. Lộ Trình 3 Giai Đoạn & Cổng Khả Thi Pilot v0 (Model Viability Gate)

1. **Giai đoạn 1: Pilot v0 (~50 – 100 queries)**
   - **v0A (Raw Retrieval Viability):** Đánh giá Top-1, Top-5, phân bổ similarity đúng/sai, Hard-Confusion mà **chưa tinh chỉnh threshold**.
     - Nếu OpenCLIP gặp *catastrophic regression* so với Jina $\longrightarrow$ **STOP NGAY**, không lãng phí công sức gán nhãn lớn.
   - **v0B (Calibrated Decision Quality):** Sử dụng tập Calibration để hiệu chỉnh threshold, sau đó đo lường độ chính xác phân loại.
2. **Giai đoạn 2: Engineering Benchmark (~300 – 500 queries)**
   - Cung cấp bằng chứng định lượng vững chắc cho quyết định GO / NO-GO kỹ thuật.
3. **Giai đoạn 3: Production Evidence (3.000+ quyết định tích lũy)**
   - Chứng minh tỷ lệ lỗi nghiêm trọng (*Wrong High-Confidence Rate*) $\le 0.1\%$.

---

### 5.3. Phân Tách 3 Tập Dữ Liệu Bất Biến (3-Way Split)

```text
┌──────────────────────────────────────────────────────────┐
│ 1. REFERENCE SET (Authoritative Catalog Universe)        │
│ 1,729 catalog SKUs; eligible reference count TBD.        │
└──────────────────────────────────────────────────────────┘
                            ≠ (Tách biệt tuyệt đối)
┌──────────────────────────────────────────────────────────┐
│ 2. CALIBRATION / DEV SET (Dev Tuning Set)                │
│ (Chỉ dùng để chọn Similarity Threshold, Margin, Gates)   │
└──────────────────────────────────────────────────────────┘
                            ≠ (Tách biệt tuyệt đối)
┌──────────────────────────────────────────────────────────┐
│ 3. FINAL HOLDOUT TEST SET (Unseen Evaluation)            │
│ ├── Positive (>= 20 mẫu)                                 │
│ ├── Hard Positive (>= 20 mẫu)                            │
│ ├── Hard Confusion (>= 25 mẫu - Ưu tiên hàng đầu)        │
│ └── Open-Set Negative (>= 20 mẫu)                        │
│ (Tuyệt đối không tune - Chỉ dùng để ra quyết định GO)    │
└──────────────────────────────────────────────────────────┘
```

### 5.1. Quy Tắc Chống Rò Rỉ (Leakage Prevention Rules):
- Cấm trùng lặp SHA-256: `reference.asset_sha256 != query.asset_sha256`.
- Cấm các ảnh có khoảng cách pHash gần, cùng source URL, cùng ảnh crop/master export từ một ảnh gốc.
- *Lưu ý:* Cùng mã SKU giữa Reference và Query là hợp lệ (mục tiêu là kiểm tra khả năng nhận diện SKU).

### 5.2. Hai Tầng Chỉ Số Đo Lường (Two-Tier Evaluation Metrics):

#### Tầng 1: Chất lượng Truy xuất (Retrieval Quality):
- **Top-1 Accuracy**
- **Top-5 Recall**
- **Hard-Confusion Top-1 Accuracy**

#### Tầng 2: Chất lượng Quyết định Vận hành (Production Decision Quality):
- **Auto-assignment Precision**: $\ge 99\%$
- **Open-Set False Auto-assignment Rate**: $\le 1\%$ (và không tệ hơn Jina quá 0.5 pp).
- **Wrong High-Confidence Rate**: Tỷ lệ model gán nhầm SKU với độ tự tin cao (phải được chặn triệt để).
- **Review Rate & Unmatched Rate**: Tỷ lệ ảnh chuyển về hàng chờ duyệt thủ công.

### 5.3. Tiêu Chí Nghiệm Thu với Paired Confidence Interval (Acceptance Gate):

$$\text{GO (Chấp thuận Cutover)} \iff \begin{cases}
95\%\text{ CI của }(\text{Top-1}_{\text{OpenCLIP}} - \text{Top-1}_{\text{Jina}}) \ge -2.0\text{ pp} \\
95\%\text{ CI của }(\text{Top-5}_{\text{OpenCLIP}} - \text{Top-5}_{\text{Jina}}) \ge -1.0\text{ pp} \\
\text{Auto-assignment Precision} \ge 99.0\% \\
\text{Open-set False Auto-assignment} \le 1.0\% \\
\text{Hard-confusion Macro Regression} \le 3.0\text{ pp (không critical family nào > 10 pp)} \\
\text{Golden Preprocessing \& Parity Gate} \ge 0.9999 \\
\text{Step 0 Early Resource Gate: Peak Worker RSS} \le 850\text{ MiB (dưới cap 1024 MiB)} \\
\text{Queue Throughput SLA} \ge 0.33\text{ img/s (p95 latency đáp ứng SLO xả queue)}
\end{cases}$$

---

## 6. Chiến Lược Chuyển Đổi: Temporary Shadow Reference Store

### 6.1. Vấn Đề DB Hiện Tại
Bảng `public.sku_reference_embeddings` hiện sở hữu ràng buộc Unique Index trên `(sku, source_url)`. Đồng thời `NativeGateway` và `media_assets` lọc dữ liệu theo provenance cứng của không gian Jina hiện tại. Do đó, **không thể chèn đồng thời vector OpenCLIP vào bảng production khi Jina đang chạy**.

### 6.2. Quy Trình Atomic Cutover:
```text
[Quyết định GO sau Benchmark]
              │
              ▼
[Tạo Shadow Reference Table tạm: sku_reference_embeddings_shadow]
              ├── Re-embed 100% catalog reference images covering ~1,700 SKUs
              ├── Kiểm tra độ phủ (100% Coverage Verification)
              └── Dry-run Matching trên Holdout Test Set
              │
              ▼
[Atomic Cutover Transaction]
              ├── BEGIN TRANSACTION
              ├── RENAME TABLE sku_reference_embeddings_shadow ──▶ sku_reference_embeddings
              ├── Cập nhật NativeGateway & production_config sang OpenCLIP
              └── COMMIT
              │
              ▼
[Xóa Shadow Table tạm & Dỡ bỏ hoàn toàn Jina/9Router]
```

---

## 7. Quy Trình Thực Thi 10 Bước (10-Step Execution Flow)

```text
0. ONNX Resource Smoke Test (Peak RSS <= 850 MiB trên VPS)
         │
         ▼ (Nếu đạt mới đầu tư công sức vào dataset)
1. Freeze Reference, Calibration và Holdout Test Manifests
         │
         ▼
2. Freeze acceptance_policy.yaml
         │
         ▼
3. Record Jina Baseline trên Holdout Test Set
         │
         ▼
4. Khóa Baseline Report (Freeze baseline, không sửa thresholds hồi tố)
         │
         ▼
5. Chạy OpenCLIP PyTorch Reference
         │
         ▼
6. Export ONNX + Hash Artifact (onnx_sha256)
         │
         ▼
7. Golden Preprocessing & Parity Tests (>= 0.9999)
         │
         ▼
8. Chạy OpenCLIP trên Calibration Set (Tune thresholds) & Holdout Test Set
         │
         ▼
9. VPS Performance & Queue Throughput Benchmark
         │
         ▼
10. Đánh Giá Quyết Định GO / NO-GO
```

---

## 8. Kết Luận

Kế hoạch kỹ thuật đã được tối ưu hóa toàn diện theo các chuẩn mực khoa học thực nghiệm nghiêm ngặt nhất. Production hiện tại với Jina API vẫn được bảo vệ 100% trong khi chúng ta tiến hành **Step 0: ONNX Resource Smoke Test**.
# **HISTORICAL / SUPERSEDED (2026-09-08)**
#
# This RFC describes the former DataComp canonical/rollback posture. Current
# production identity and rollback behavior are governed by the Q0 ADR and the
# SigLIP2 artifact manifest.
