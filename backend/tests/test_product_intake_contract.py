from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_product_intake_migration_owns_lifecycle_and_open_asset_guard() -> None:
    sql = (ROOT / "backend" / "migrations" / "0037_product_intake_workflow.sql").read_text(encoding="utf-8")
    lowered = sql.lower()

    assert "create table if not exists public.product_intakes" in lowered
    assert "create table if not exists public.product_intake_assets" in lowered
    assert "create table if not exists public.product_intake_decisions" in lowered
    assert "supplement_of_intake_id" in lowered
    assert "'draft', 'submitted', 'needs_changes', 'approved', 'rejected'" in lowered
    assert "'none', 'queued', 'ready', 'failed'" in lowered
    assert "guard_open_product_intake_asset" in lowered
    assert "verity.product_intake_approval" in lowered
    sql_0040 = (ROOT / "backend" / "migrations" / "0040_sku_references_image_category.sql").read_text(encoding="utf-8").lower()
    assert "sku_references" in sql_0040 and "image_category" in sql_0040


def test_product_intake_enrichment_migration_is_additive_and_vocab_locked() -> None:
    sql = (ROOT / "backend" / "migrations" / "0043_product_intake_enrichment.sql").read_text(encoding="utf-8").lower()

    # Product-level context (category + space/room) for reference learning.
    assert "alter table public.product_intakes" in sql
    assert "add column if not exists proposed_category" in sql
    assert "add column if not exists proposed_space" in sql

    # Per-image uploader proposals + reviewer confirmations.
    assert "alter table public.product_intake_assets" in sql
    for column in (
        "proposed_role",
        "proposed_image_category",
        "proposed_angle",
        "confirmed_role",
        "confirmed_image_category",
    ):
        assert f"add column if not exists {column}" in sql

    # Every new column is additive/nullable so open intakes and history survive.
    assert "not null" not in sql

    # image_category shares sku_references' closed vocabulary; role stays
    # app-validated to match sku_references.reference_role (no DB CHECK).
    assert "in ('real', 'studio', 'design')" in sql
    assert "proposed_role text" in sql  # declared, but not constrained
    assert "check (proposed_role" not in sql
    assert "check (confirmed_role" not in sql


def test_reference_worker_and_gateway_fail_closed_on_provenance_or_space() -> None:
    worker = (ROOT / "backend" / "app" / "worker.py").read_text(encoding="utf-8")
    gateway = (ROOT / "backend" / "app" / "native_gateway.py").read_text(encoding="utf-8")

    assert 'elif job["job_kind"] == "prepare_reference"' in worker
    assert "hashlib.sha256(source).hexdigest()" in worker
    assert '"complete_product_intake_reference"' in worker
    assert "embedding_runtime_state" in gateway
    assert "es.status = 'ACTIVE'" in gateway
    assert "Active asset embedding is missing or does not match the reference source" in gateway
    assert "reference_status = 'ready'" in gateway
    assert "'approved', 'rejected'" in gateway
    assert "embedding_spaces es on es.space_id = ers.active_space_id" in gateway
    assert "nullif(lower(source.content_hash), '') = lower(re.source_sha256)" in gateway

    # Reference role + image_category come from the reviewer-confirmed labels on
    # product_intake_assets, not a hardcoded STUDIO/HERO heuristic.
    assert "pia.confirmed_role, pia.confirmed_image_category" in gateway
    assert 'confirmed_role = _text(state.get("confirmed_role")).upper()' in gateway
    assert 'confirmed_category = _text(state.get("confirmed_image_category")).upper()' in gateway
    assert 'role = confirmed_role if confirmed_role in ("HERO", "ANGLE")' in gateway


def test_url_image_import_is_ssrf_guarded_and_records_provenance() -> None:
    guard = (ROOT / "src" / "lib" / "server" / "url-fetch-guard.ts").read_text(encoding="utf-8")
    extract_route = (ROOT / "src" / "app" / "api" / "uploads" / "from-url" / "extract" / "route.ts").read_text(encoding="utf-8")
    fetch_route = (ROOT / "src" / "app" / "api" / "uploads" / "from-url" / "fetch" / "route.ts").read_text(encoding="utf-8")
    complete_route = (ROOT / "src" / "app" / "api" / "uploads" / "complete" / "route.ts").read_text(encoding="utf-8")

    # Người khai được dán URL bất kỳ -> không có allowlist, guard là chốt duy nhất.
    assert "redirect: 'manual'" in guard
    assert "isPrivateAddress" in guard and "net.isIP(literal)" in guard
    assert "maxBytes" in guard

    # Cả hai route đều phải đi qua guard, và chỉ sống trong luồng khai báo SP mới.
    for route in (extract_route, fetch_route):
        assert "safeFetch" in route
        assert "assertProductIntakesEnabled()" in route
        assert "requireNativeContributor" in route

    # Bytes đi đúng pipeline upload hiện có, không có đường ghi R2 riêng.
    assert "optimizeUploadBuffer" in fetch_route
    assert "putR2Object" in fetch_route
    assert "MIN_IMAGE_DIMENSION" in fetch_route

    # Provenance: nguồn + hash của đúng bytes đã ghi, key R2 tất định để import
    # lại cùng URL rơi vào nhánh asset đã tồn tại thay vì tạo bản sao.
    assert "${user.id}/web/" in fetch_route
    assert "content_hash, source_provider, source_file_id" in complete_route
    assert "'source_url', $13::text" in complete_route
    assert "'WebFetch'" in complete_route


def test_url_image_import_adds_no_runtime_dependency() -> None:
    import json

    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    forbidden = {"cheerio", "jsdom", "axios", "metascraper", "puppeteer", "playwright"}
    assert not forbidden & set(package["dependencies"]), "trích ảnh phải dùng regex + sharp, không thêm dependency runtime"

    test_script = package["scripts"]["test"]
    assert "src/lib/server/product-image-extract.test.ts" in test_script
    assert "src/lib/server/url-fetch-guard.test.ts" in test_script


def test_legacy_mcp_resolve_routes_open_intakes_to_their_workflow() -> None:
    mcp_gateway = (ROOT / "backend" / "verity_dam_mcp" / "gateway.py").read_text(encoding="utf-8")

    assert "product_intake_open" in mcp_gateway
    assert "PRODUCT_INTAKE_REVIEW_REQUIRED" in mcp_gateway
    assert "p_promote_reference" in mcp_gateway

    web_queue = (ROOT / "src" / "lib" / "server" / "native-media.ts").read_text(encoding="utf-8")
    web_decision = (ROOT / "src" / "app" / "api" / "review-queue" / "[id]" / "decision" / "route.ts").read_text(encoding="utf-8")
    intake_service = (ROOT / "src" / "lib" / "server" / "product-intakes.ts").read_text(encoding="utf-8")
    intake_ui = (ROOT / "src" / "components" / "product-intakes" / "ProductIntakeReviewPanel.tsx").read_text(encoding="utf-8")

    assert "not exists (" in web_queue and "product_intake_assets" in web_queue
    assert "product_intake_open" in web_decision
    assert "REFERENCE_ASSET_INVALID_TYPE" in intake_service
    assert "Video không dùng làm ảnh mẫu" in intake_ui


def test_product_intake_service_retains_per_asset_evidence_and_safe_retry_rules() -> None:
    service = (ROOT / "src" / "lib" / "server" / "product-intakes.ts").read_text(encoding="utf-8")
    types = (ROOT / "src" / "types" / "media.ts").read_text(encoding="utf-8")

    assert "a.ingest_error, q.sku_match" in service
    assert "reference_job.error_message as reference_error" in service
    assert "PRODUCT_INTAKE_REFERENCE_NOT_FAILED" in service
    assert "and status = 'failed'" in service
    assert "values ($1::uuid, 'prepare_reference'" in service
    assert "'asset_id', $4::text" in service
    assert "createProductIntakeSupplement" in service
    assert "supplement_of_intake_id" in service
    assert "sku_match?: SkuMatchResult" in types
    assert "reference_error?: string | null" in types


def test_product_intake_adr_and_supplement_route_exist() -> None:
    adr = (ROOT / "docs" / "adr" / "0037-product-intake-workflow.md").read_text(encoding="utf-8")
    route = (ROOT / "src" / "app" / "api" / "product-intakes" / "[id]" / "supplement" / "route.ts").read_text(encoding="utf-8")

    assert "ADR-0037" in adr
    assert "prepare_reference" in adr
    assert "supplement_of_intake_id" in adr
    assert "createProductIntakeSupplement" in route


def test_catalog_picker_searches_by_brand_as_well_as_identity_fields() -> None:
    route = (ROOT / "src" / "app" / "api" / "catalog" / "search" / "route.ts").read_text(encoding="utf-8")
    picker = (ROOT / "src" / "components" / "product-intakes" / "CatalogProductPicker.tsx").read_text(encoding="utf-8")

    assert "or brand ilike $1" in route
    assert "Tìm theo SKU, hãng, tên hoặc model" in picker
