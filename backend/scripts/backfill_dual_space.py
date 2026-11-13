"""Phase 6: Dual-Space Backfill Runner and Suite E Integrity Audit.

Backfills 512-d DataComp rollback representations and 768-d SigLIP2 shadow representations
into public.asset_embeddings and public.reference_embeddings, keeping zero stale vectors,
zero dimension mismatches, and zero missing vectors across active and shadow spaces.

Usage:
  python -m scripts.backfill_dual_space --audit-only
  python -m scripts.backfill_dual_space --dry-run
  python -m scripts.backfill_dual_space --confirm
  python -m scripts.backfill_dual_space --confirm --limit 100
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

logger = logging.getLogger("backfill_dual_space")

DATACOMP_SPACE_ID = "verity-openclip-b32-datacomp-256-v1"
SIGLIP2_SPACE_ID = "verity-siglip2-b32-256-webli-v1"


@dataclass
class SuiteECheckResult:
    check_name: str
    passed: bool
    count: int
    threshold: int = 0
    detail: str = ""


@dataclass
class SuiteEAuditReport:
    status: str  # "PASS" | "FAIL"
    checked_at: str
    checks: list[SuiteECheckResult] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)
    metrics: dict[str, int] = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return self.status == "PASS"


class DualSpaceBackfillRunner:
    """Orchestrates Phase 6 dual-space backfill and Suite E integrity verification."""

    def __init__(
        self,
        repository: Any,
        storage: Any | None = None,
        siglip2_embed_fn: Callable[[bytes], list[float]] | None = None,
    ) -> None:
        self.repository = repository
        self.storage = storage
        self.siglip2_embed_fn = siglip2_embed_fn

    def _download_payload(self, storage_path: str) -> bytes:
        if not self.storage:
            raise RuntimeError("Storage client required to download image bytes")
        if hasattr(self.storage, "download_object"):
            return self.storage.download_object(storage_path)
        if hasattr(self.storage, "get_bytes"):
            return self.storage.get_bytes(storage_path)
        raise AttributeError(f"Storage client has neither download_object nor get_bytes: {type(self.storage)}")

    # ------------------------------------------------------------------
    # Task 0: Populate content_hash on media_assets
    # ------------------------------------------------------------------
    def populate_missing_content_hashes(self, limit: int | None = None, dry_run: bool = False) -> int:
        """Computes and populates SHA-256 content_hash for assets that lack one."""
        query = """
            SELECT id, storage_path
            FROM public.media_assets
            WHERE content_hash IS NULL AND storage_path IS NOT NULL AND deleted_at IS NULL
            ORDER BY created_at ASC
        """
        if limit:
            query += f" LIMIT {int(limit)}"

        rows = self.repository.fetch_all(query)
        if not rows:
            logger.info("Task 0: No assets missing content_hash.")
            return 0

        logger.info(f"Task 0: Found {len(rows)} assets missing content_hash.")
        updated_count = 0

        for row in rows:
            asset_id = str(row["id"])
            storage_path = str(row["storage_path"])
            if dry_run:
                updated_count += 1
                continue

            if not self.storage:
                raise RuntimeError("Storage client required to download asset bytes for content_hash")

            try:
                payload = self._download_payload(storage_path)
                content_hash = hashlib.sha256(payload).hexdigest()
                self.repository.fetch_one(
                    "UPDATE public.media_assets SET content_hash = %s WHERE id = %s RETURNING id",
                    (content_hash, asset_id),
                )
                updated_count += 1
            except Exception as exc:
                logger.error(f"Failed to populate content_hash for asset {asset_id}: {exc}")

        logger.info(f"Task 0: Populated content_hash for {updated_count} assets (dry_run={dry_run}).")
        return updated_count

    # ------------------------------------------------------------------
    # Task 2: Backfill DataComp rollback representations
    # ------------------------------------------------------------------
    def backfill_datacomp_rollback_space(self, dry_run: bool = False) -> dict[str, int]:
        """Copies legacy 512-d DataComp representations into asset_embeddings and reference_embeddings."""
        results = {"assets_copied": 0, "references_copied": 0}

        # 1. Assets: copy from media_assets.image_embedding where vector exists
        asset_check = self.repository.fetch_one(
            """
            SELECT count(*) as count
            FROM public.media_assets a
            WHERE a.image_embedding IS NOT NULL AND a.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM public.asset_embeddings ae
                WHERE ae.asset_id = a.id AND ae.space_id = %s AND ae.kind = 'global'
              )
            """,
            (DATACOMP_SPACE_ID,),
        )
        missing_assets = int(asset_check["count"] if asset_check else 0)
        results["assets_copied"] = missing_assets
        logger.info(f"Task 2: {missing_assets} assets pending DataComp representation copy.")

        if not dry_run and missing_assets > 0:
            copy_assets_sql = """
                INSERT INTO public.asset_embeddings (asset_id, space_id, kind, vector, source_sha256)
                SELECT
                    a.id,
                    %s,
                    'global',
                    a.image_embedding,
                    COALESCE(a.content_hash, '')
                FROM public.media_assets a
                WHERE a.image_embedding IS NOT NULL AND a.deleted_at IS NULL
                ON CONFLICT (asset_id, space_id) WHERE kind = 'global'
                DO UPDATE SET
                    vector = EXCLUDED.vector,
                    source_sha256 = EXCLUDED.source_sha256;
            """
            with self.repository.transaction() as cursor:
                cursor.execute(copy_assets_sql, (DATACOMP_SPACE_ID,))

        # 2. References: copy from sku_reference_embeddings and sku_reference_embeddings_shadow
        ref_check = self.repository.fetch_one(
            """
            SELECT count(*) as count
            FROM public.sku_references r
            WHERE r.is_active = true
              AND NOT EXISTS (
                SELECT 1 FROM public.reference_embeddings re
                WHERE re.reference_id = r.reference_id AND re.space_id = %s
              )
            """,
            (DATACOMP_SPACE_ID,),
        )
        missing_refs = int(ref_check["count"] if ref_check else 0)
        results["references_copied"] = missing_refs
        logger.info(f"Task 2: {missing_refs} references pending DataComp representation copy.")

        if not dry_run and missing_refs > 0:
            copy_refs_sql = """
                INSERT INTO public.reference_embeddings (reference_id, space_id, vector, source_sha256)
                SELECT
                    r.reference_id,
                    %s,
                    sre.embedding,
                    COALESCE(a.content_hash, '')
                FROM public.sku_references r
                JOIN public.sku_reference_embeddings sre ON sre.id = r.reference_id
                LEFT JOIN public.media_assets a ON a.id = r.source_media_asset_id
                WHERE sre.embedding IS NOT NULL
                ON CONFLICT (reference_id, space_id)
                DO UPDATE SET
                    vector = EXCLUDED.vector,
                    source_sha256 = EXCLUDED.source_sha256;
            """
            with self.repository.transaction() as cursor:
                cursor.execute(copy_refs_sql, (DATACOMP_SPACE_ID,))

        return results

    # ------------------------------------------------------------------
    # Task 3: Backfill SigLIP2 768-d asset embeddings
    # ------------------------------------------------------------------
    def backfill_siglip2_asset_space(
        self,
        limit: int | None = None,
        dry_run: bool = False,
    ) -> int:
        """Encodes approved media assets with SigLIP2 Vision ONNX and saves 768-d embeddings."""
        query = """
            SELECT a.id, a.storage_path, a.content_hash
            FROM public.media_assets a
            WHERE a.deleted_at IS NULL
              AND a.review_state = 'approved'
              AND NOT EXISTS (
                SELECT 1 FROM public.asset_embeddings ae
                WHERE ae.asset_id = a.id AND ae.space_id = %s AND ae.kind = 'global'
              )
            ORDER BY a.created_at ASC
        """
        if limit:
            query += f" LIMIT {int(limit)}"

        pending = self.repository.fetch_all(query, (SIGLIP2_SPACE_ID,))
        if not pending:
            logger.info("Task 3: No approved assets pending SigLIP2 embedding.")
            return 0

        logger.info(f"Task 3: Found {len(pending)} approved assets pending SigLIP2 embedding.")
        if dry_run:
            return len(pending)

        if not self.siglip2_embed_fn:
            raise RuntimeError("siglip2_embed_fn is required to generate SigLIP2 embeddings")
        if not self.storage:
            raise RuntimeError("Storage client required to download image bytes")

        succeeded = 0
        insert_sql = """
            INSERT INTO public.asset_embeddings (asset_id, space_id, kind, vector, source_sha256)
            VALUES (%s, %s, 'global', %s::vector, %s)
            ON CONFLICT (asset_id, space_id) WHERE kind = 'global'
            DO UPDATE SET
                vector = EXCLUDED.vector,
                source_sha256 = EXCLUDED.source_sha256;
        """

        for asset in pending:
            asset_id = str(asset["id"])
            storage_path = str(asset["storage_path"])
            content_hash = asset.get("content_hash") or ""
            try:
                payload = self._download_payload(storage_path)
                if not content_hash:
                    content_hash = hashlib.sha256(payload).hexdigest()
                vector = self.siglip2_embed_fn(payload)
                if len(vector) != 768:
                    raise ValueError(f"Expected 768-d vector, got {len(vector)}")

                with self.repository.transaction() as cursor:
                    if content_hash:
                        cursor.execute(
                            "UPDATE public.media_assets SET content_hash = %s WHERE id = %s",
                            (content_hash, asset_id),
                        )
                    cursor.execute(insert_sql, (asset_id, SIGLIP2_SPACE_ID, vector, content_hash))
                succeeded += 1
            except Exception as exc:
                logger.error(f"Task 3: Error embedding asset {asset_id}: {exc}")

        logger.info(f"Task 3: Successfully embedded {succeeded}/{len(pending)} assets with SigLIP2.")
        return succeeded

    # ------------------------------------------------------------------
    # Task 4: Backfill SigLIP2 768-d reference embeddings
    # ------------------------------------------------------------------
    def backfill_siglip2_reference_space(
        self,
        limit: int | None = None,
        dry_run: bool = False,
    ) -> int:
        """Encodes SKU references with SigLIP2 Vision ONNX and saves 768-d reference embeddings."""
        query = """
            SELECT r.reference_id, r.sku, r.source_media_asset_id, r.source_url,
                   ae.vector::text as cached_asset_siglip2,
                   a.storage_path, a.content_hash
            FROM public.sku_references r
            LEFT JOIN public.media_assets a ON a.id = r.source_media_asset_id
            LEFT JOIN public.asset_embeddings ae
                ON ae.asset_id = r.source_media_asset_id
               AND ae.space_id = %s
               AND ae.kind = 'global'
            WHERE r.is_active = true
              AND NOT EXISTS (
                SELECT 1 FROM public.reference_embeddings re
                WHERE re.reference_id = r.reference_id AND re.space_id = %s
              )
            ORDER BY r.created_at ASC
        """
        if limit:
            query += f" LIMIT {int(limit)}"

        pending = self.repository.fetch_all(query, (SIGLIP2_SPACE_ID, SIGLIP2_SPACE_ID))
        if not pending:
            logger.info("Task 4: No SKU references pending SigLIP2 embedding.")
            return 0

        logger.info(f"Task 4: Found {len(pending)} references pending SigLIP2 embedding.")
        if dry_run:
            return len(pending)

        insert_sql = """
            INSERT INTO public.reference_embeddings (reference_id, space_id, vector, source_sha256)
            VALUES (%s, %s, %s::vector, %s)
            ON CONFLICT (reference_id, space_id)
            DO UPDATE SET
                vector = EXCLUDED.vector,
                source_sha256 = EXCLUDED.source_sha256;
        """

        succeeded = 0
        http_session = None
        for ref in pending:
            ref_id = str(ref["reference_id"])
            cached_vector = ref.get("cached_asset_siglip2")
            source_sha256 = ref.get("content_hash") or ""

            try:
                if cached_vector:
                    # Reuse cached asset representation directly!
                    with self.repository.transaction() as cursor:
                        cursor.execute(insert_sql, (ref_id, SIGLIP2_SPACE_ID, cached_vector, source_sha256))
                    succeeded += 1
                    continue

                if not self.siglip2_embed_fn:
                    raise RuntimeError("siglip2_embed_fn required for uncached reference images")

                storage_path = ref.get("storage_path")
                if storage_path and self.storage:
                    payload = self._download_payload(storage_path)
                elif ref.get("source_url"):
                    if http_session is None:
                        import requests
                        http_session = requests.Session()
                    resp = http_session.get(ref["source_url"], timeout=15)
                    resp.raise_for_status()
                    payload = resp.content
                else:
                    logger.warning(f"Task 4: Reference {ref_id} has no storage payload or source_url, skipping")
                    continue

                if not source_sha256:
                    source_sha256 = hashlib.sha256(payload).hexdigest()

                vector = self.siglip2_embed_fn(payload)
                if len(vector) != 768:
                    raise ValueError(f"Expected 768-d vector, got {len(vector)}")

                with self.repository.transaction() as cursor:
                    cursor.execute(insert_sql, (ref_id, SIGLIP2_SPACE_ID, vector, source_sha256))
                succeeded += 1
                if succeeded % 100 == 0:
                    print(f"Task 4 progress: {succeeded}/{len(pending)} embedded...", flush=True)
            except Exception as exc:
                logger.error(f"Task 4: Error generating SigLIP2 reference embedding for {ref_id}: {exc}")

        logger.info(f"Task 4: Successfully embedded {succeeded}/{len(pending)} references with SigLIP2.")
        return succeeded

    # ------------------------------------------------------------------
    # Task 7: Suite E Integrity Audit
    # ------------------------------------------------------------------
    def run_suite_e_audit(self) -> SuiteEAuditReport:
        """Executes all pre-flip Suite E migration integrity checks."""
        import datetime

        now_str = datetime.datetime.now(datetime.timezone.utc).isoformat()
        checks: list[SuiteECheckResult] = []
        failures: list[str] = []
        metrics: dict[str, int] = {}

        # 1. Dimension Enforcement Check (Asset Embeddings)
        row = self.repository.fetch_one(
            """
            SELECT count(*) as count
            FROM public.asset_embeddings ae
            JOIN public.embedding_spaces es ON es.space_id = ae.space_id
            WHERE vector_dims(ae.vector) != es.dimension
            """
        )
        wrong_asset_dims = int(row["count"] if row else 0)
        metrics["wrong_asset_dims"] = wrong_asset_dims
        passed = wrong_asset_dims == 0
        checks.append(SuiteECheckResult(
            check_name="dim_enforcement_asset_embeddings",
            passed=passed,
            count=wrong_asset_dims,
            threshold=0,
            detail=f"{wrong_asset_dims} asset embeddings have dimension mismatch",
        ))
        if not passed:
            failures.append(f"Suite E FAIL: {wrong_asset_dims} asset embeddings violate space dimension")

        # 2. Dimension Enforcement Check (Reference Embeddings)
        row = self.repository.fetch_one(
            """
            SELECT count(*) as count
            FROM public.reference_embeddings re
            JOIN public.embedding_spaces es ON es.space_id = re.space_id
            WHERE vector_dims(re.vector) != es.dimension
            """
        )
        wrong_ref_dims = int(row["count"] if row else 0)
        metrics["wrong_reference_dims"] = wrong_ref_dims
        passed = wrong_ref_dims == 0
        checks.append(SuiteECheckResult(
            check_name="dim_enforcement_reference_embeddings",
            passed=passed,
            count=wrong_ref_dims,
            threshold=0,
            detail=f"{wrong_ref_dims} reference embeddings have dimension mismatch",
        ))
        if not passed:
            failures.append(f"Suite E FAIL: {wrong_ref_dims} reference embeddings violate space dimension")

        # 3. Missing Global Vectors in Active Space (DataComp)
        row = self.repository.fetch_one(
            """
            SELECT count(*) as count
            FROM public.media_assets a
            WHERE a.deleted_at IS NULL AND a.review_state = 'approved'
              AND NOT EXISTS (
                SELECT 1 FROM public.asset_embeddings ae
                WHERE ae.asset_id = a.id AND ae.space_id = %s AND ae.kind = 'global'
              )
            """,
            (DATACOMP_SPACE_ID,),
        )
        missing_active = int(row["count"] if row else 0)
        metrics["missing_active_space_assets"] = missing_active
        passed = missing_active == 0
        checks.append(SuiteECheckResult(
            check_name="missing_active_space_global_vectors",
            passed=passed,
            count=missing_active,
            threshold=0,
            detail=f"{missing_active} approved assets lack global vector in {DATACOMP_SPACE_ID}",
        ))
        if not passed:
            failures.append(f"Suite E FAIL: {missing_active} approved assets lack global vector in active space")

        # 4. Missing Global Vectors in Shadow Space (SigLIP2)
        row = self.repository.fetch_one(
            """
            SELECT count(*) as count
            FROM public.media_assets a
            WHERE a.deleted_at IS NULL AND a.review_state = 'approved'
              AND NOT EXISTS (
                SELECT 1 FROM public.asset_embeddings ae
                WHERE ae.asset_id = a.id AND ae.space_id = %s AND ae.kind = 'global'
              )
            """,
            (SIGLIP2_SPACE_ID,),
        )
        missing_shadow = int(row["count"] if row else 0)
        metrics["missing_shadow_space_assets"] = missing_shadow
        passed = missing_shadow == 0
        checks.append(SuiteECheckResult(
            check_name="missing_shadow_space_global_vectors",
            passed=passed,
            count=missing_shadow,
            threshold=0,
            detail=f"{missing_shadow} approved assets lack global vector in {SIGLIP2_SPACE_ID}",
        ))
        if not passed:
            failures.append(f"Suite E FAIL: {missing_shadow} approved assets lack global vector in shadow space")

        # 5. Stale source_sha256 Audit
        row = self.repository.fetch_one(
            """
            SELECT count(*) as count
            FROM public.asset_embeddings ae
            JOIN public.media_assets a ON a.id = ae.asset_id
            WHERE a.content_hash IS NOT NULL
              AND ae.source_sha256 IS NOT NULL
              AND ae.source_sha256 != ''
              AND ae.source_sha256 != a.content_hash
            """
        )
        stale_sha_count = int(row["count"] if row else 0)
        metrics["stale_source_sha256_count"] = stale_sha_count
        passed = stale_sha_count == 0
        checks.append(SuiteECheckResult(
            check_name="stale_source_sha256",
            passed=passed,
            count=stale_sha_count,
            threshold=0,
            detail=f"{stale_sha_count} asset embeddings have stale source_sha256 vs media_assets.content_hash",
        ))
        if not passed:
            failures.append(f"Suite E FAIL: {stale_sha_count} embeddings have stale source_sha256")

        # 6. Reference Dual-Space Coverage: DataComp
        row = self.repository.fetch_one(
            """
            SELECT count(*) as count
            FROM public.sku_references r
            WHERE r.is_active = true
              AND NOT EXISTS (
                SELECT 1 FROM public.reference_embeddings re
                WHERE re.reference_id = r.reference_id AND re.space_id = %s
              )
            """,
            (DATACOMP_SPACE_ID,),
        )
        missing_datacomp_refs = int(row["count"] if row else 0)
        metrics["missing_datacomp_references"] = missing_datacomp_refs
        passed = missing_datacomp_refs == 0
        checks.append(SuiteECheckResult(
            check_name="reference_coverage_datacomp",
            passed=passed,
            count=missing_datacomp_refs,
            threshold=0,
            detail=f"{missing_datacomp_refs} active sku_references lack {DATACOMP_SPACE_ID} embedding",
        ))
        if not passed:
            failures.append(f"Suite E FAIL: {missing_datacomp_refs} sku_references missing DataComp embedding")

        # 7. Reference Dual-Space Coverage: SigLIP2
        row = self.repository.fetch_one(
            """
            SELECT count(*) as count
            FROM public.sku_references r
            WHERE r.is_active = true
              AND NOT EXISTS (
                SELECT 1 FROM public.reference_embeddings re
                WHERE re.reference_id = r.reference_id AND re.space_id = %s
              )
            """,
            (SIGLIP2_SPACE_ID,),
        )
        missing_siglip2_refs = int(row["count"] if row else 0)
        metrics["missing_siglip2_references"] = missing_siglip2_refs
        passed = missing_siglip2_refs == 0
        checks.append(SuiteECheckResult(
            check_name="reference_coverage_siglip2",
            passed=passed,
            count=missing_siglip2_refs,
            threshold=0,
            detail=f"{missing_siglip2_refs} active sku_references lack {SIGLIP2_SPACE_ID} embedding",
        ))
        if not passed:
            failures.append(f"Suite E FAIL: {missing_siglip2_refs} sku_references missing SigLIP2 embedding")

        # 8. Orphan space_id check
        row = self.repository.fetch_one(
            """
            SELECT count(*) as count
            FROM public.asset_embeddings ae
            WHERE NOT EXISTS (
                SELECT 1 FROM public.embedding_spaces es WHERE es.space_id = ae.space_id
            )
            """
        )
        orphan_spaces = int(row["count"] if row else 0)
        metrics["orphan_spaces"] = orphan_spaces
        passed = orphan_spaces == 0
        checks.append(SuiteECheckResult(
            check_name="orphan_spaces_in_asset_embeddings",
            passed=passed,
            count=orphan_spaces,
            threshold=0,
            detail=f"{orphan_spaces} asset embeddings have orphan space_id",
        ))
        if not passed:
            failures.append(f"Suite E FAIL: {orphan_spaces} asset embeddings reference unknown space_id")

        # 9. Duplicate global check
        row = self.repository.fetch_one(
            """
            SELECT count(*) as count FROM (
                SELECT asset_id, space_id
                FROM public.asset_embeddings
                WHERE kind = 'global'
                GROUP BY asset_id, space_id
                HAVING count(*) > 1
            ) sub
            """
        )
        duplicate_globals = int(row["count"] if row else 0)
        metrics["duplicate_globals"] = duplicate_globals
        passed = duplicate_globals == 0
        checks.append(SuiteECheckResult(
            check_name="duplicate_global_embeddings",
            passed=passed,
            count=duplicate_globals,
            threshold=0,
            detail=f"{duplicate_globals} assets have duplicate global embeddings per space",
        ))
        if not passed:
            failures.append(f"Suite E FAIL: {duplicate_globals} duplicate global embeddings detected")

        # Compute overall status
        overall_status = "PASS" if not failures else "FAIL"
        return SuiteEAuditReport(
            status=overall_status,
            checked_at=now_str,
            checks=checks,
            failures=failures,
            metrics=metrics,
        )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Dual-Space Backfill Runner and Suite E Audit")
    parser.add_argument("--confirm", action="store_true", help="Permit writes to PostgreSQL (dry-run by default)")
    parser.add_argument("--dry-run", action="store_true", help="Perform inspection only without writing")
    parser.add_argument("--audit-only", action="store_true", help="Run Suite E integrity audit only")
    parser.add_argument("--limit", type=int, default=None, help="Batch limit per phase")
    parser.add_argument("--output-report", type=str, default="suite_e_audit_report.json", help="Path to save Suite E JSON report")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    from app.native_gateway import NativeGateway
    from app.production_config import WorkerSettings

    settings = WorkerSettings.from_environment()
    gateway = NativeGateway(settings)

    runner = DualSpaceBackfillRunner(
        repository=gateway.repository,
        storage=gateway.storage,
    )

    if args.audit_only:
        report = runner.run_suite_e_audit()
        print(json.dumps(asdict(report), indent=2))
        Path(args.output_report).write_text(json.dumps(asdict(report), indent=2), encoding="utf-8")
        return 0 if report.passed else 1

    dry_run = not args.confirm or args.dry_run
    mode_str = "DRY-RUN" if dry_run else "CONFIRM"
    print(f"=== Dual-Space Backfill Running in {mode_str} Mode ===")

    # Step 0: Populate missing content_hashes
    h_count = runner.populate_missing_content_hashes(limit=args.limit, dry_run=dry_run)
    print(f"Task 0 (content_hash): {h_count} rows processed.")

    # Step 2: Backfill DataComp rollback space
    dc_res = runner.backfill_datacomp_rollback_space(dry_run=dry_run)
    print(f"Task 2 (DataComp rollback): {dc_res['assets_copied']} assets, {dc_res['references_copied']} refs.")

    # Step 3 & 4: SigLIP2 embeddings (if worker / onnx available)
    try:
        from app.embedding_api import EmbeddingClient
        client = EmbeddingClient(settings)
        runner.siglip2_embed_fn = client.embed_image
    except Exception as exc:
        try:
            import io
            import onnxruntime as ort
            from PIL import Image
            from app.siglip2_runtime import canonical_siglip2_preprocess, _validate_embedding, SIGLIP2_SPACE_ID
            onnx_path = Path("/app/models/siglip2-vision-opset18.onnx")
            if not onnx_path.exists():
                onnx_path = Path(__file__).resolve().parents[1] / "benchmarks" / "models" / "siglip2-vision-opset18.onnx"
            if onnx_path.exists():
                opts = ort.SessionOptions()
                opts.intra_op_num_threads = 4
                opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
                session = ort.InferenceSession(str(onnx_path), sess_options=opts, providers=["CPUExecutionProvider"])
                input_name = session.get_inputs()[0].name
                output_name = session.get_outputs()[0].name
                def _siglip2_vision_embed(b: bytes) -> list[float]:
                    with Image.open(io.BytesIO(b)) as img:
                        t = canonical_siglip2_preprocess(img)
                    out = session.run([output_name], {input_name: t})
                    return _validate_embedding(out[0][0], space_id=SIGLIP2_SPACE_ID).tolist()
                runner.siglip2_embed_fn = _siglip2_vision_embed
                print(f"Initialized local SigLIP2 Vision ONNX model from {onnx_path}")
            else:
                print(f"Note: SigLIP2 ONNX model not found at {onnx_path}. Skipping inference.")
        except Exception as onnx_exc:
            print(f"Note: SigLIP2 Vision embed client not initialized ({exc}; ONNX: {onnx_exc}). Skipping inference.")

    if runner.siglip2_embed_fn:
        s_assets = runner.backfill_siglip2_asset_space(limit=args.limit, dry_run=dry_run)
        print(f"Task 3 (SigLIP2 assets): {s_assets} rows embedded.")
        s_refs = runner.backfill_siglip2_reference_space(limit=args.limit, dry_run=dry_run)
        print(f"Task 4 (SigLIP2 references): {s_refs} rows embedded.")

    # Run Suite E Audit at the end
    print("=== Running Suite E Integrity Audit ===")
    report = runner.run_suite_e_audit()
    print(json.dumps(asdict(report), indent=2))
    Path(args.output_report).write_text(json.dumps(asdict(report), indent=2), encoding="utf-8")

    return 0 if report.passed else (0 if dry_run else 1)


if __name__ == "__main__":
    sys.exit(main())