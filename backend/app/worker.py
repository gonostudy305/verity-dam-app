"""Durable worker for Verity's separated production media pipeline.

``analyze_image`` runs API embedding SKU/dedup work and Vision open-metadata
work in parallel. The only value allowed to populate ``sku`` is the gated
embedding-reference result.
``publish_canonical_media`` creates immutable WebP URLs for every ready image.
``publish_wordpress`` remains the separate external-export lane for approved
public assets and reuses the same canonical rendition contract.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.catalog_text import clean_text_values, fuse_sku_candidates, sanitize_brand_prior
from app.contracts import apply_brand_conflict_gate, apply_consistency_gate, gate_sku_candidates
from app.embed import cosine_similarity, parse_embedding
from app.embedding_api import EmbeddingClient
from app.image_processing import (
    build_public_image_slug,
    build_rendition_fingerprint,
    generate_canonical_renditions,
    image_features,
    vision_rendition,
    wordpress_rendition,
)
from app.native_gateway import GatewayError, NativeGateway
from app.openclip_runtime import CANONICAL_SPACE_ID, OpenCLIPONNXRuntime
from app.production_config import ConfigurationError, WorkerSettings
from app.r2_publisher import R2Publisher
from app.shared_embedding_config import apply_shared_embedding_config
from app.shared_vision_config import apply_shared_vision_config
from app.siglip2_runtime import SIGLIP2_SPACE_ID, canonical_siglip2_preprocess, _validate_embedding
from app.vision_metadata import PROMPT_VERSION, call_vision_metadata


class NonRetryableWorkerError(RuntimeError):
    pass


def vector_literal(values: list[float]) -> str:
    return "[" + ",".join(format(value, ".9g") for value in values) + "]"


def json_matches(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep worker-to-RPC payloads bounded and typed."""
    matches: list[dict[str, Any]] = []
    for row in rows[:10]:
        candidate_id = row.get("candidate_media_asset_id")
        if not isinstance(candidate_id, str):
            continue
        item: dict[str, Any] = {"candidate_media_asset_id": candidate_id}
        for key in ("similarity", "hamming_distance"):
            if isinstance(row.get(key), (int, float)):
                item[key] = row[key]
        matches.append(item)
    return matches


def enrich_catalog_identity(
    metadata_draft: dict[str, Any],
    sku_match_payload: dict[str, Any],
    catalog_product: dict[str, Any] | None,
) -> None:
    """Add authoritative catalog identity without overwriting visible Vision text."""

    if not catalog_product:
        return
    catalog_brand = catalog_product.get("brand")
    catalog_model_name = catalog_product.get("model_name")
    catalog_display_name = catalog_product.get("display_name")
    catalog_identity = {
        key: value.strip()[:300]
        for key, value in (
            ("brand", catalog_brand),
            ("model_name", catalog_model_name),
            ("display_name", catalog_display_name),
            ("catalog_sku_kind", catalog_product.get("catalog_sku_kind")),
        )
        if isinstance(value, str) and value.strip()
    }
    if catalog_identity:
        sku_match_payload["catalog_identity"] = catalog_identity
    if isinstance(catalog_brand, str) and catalog_brand.strip() and catalog_brand.casefold() != "unknown":
        vision_brand = metadata_draft.get("brand")
        if (
            not isinstance(vision_brand, str)
            or not vision_brand.strip()
            or vision_brand.strip().casefold() == "unknown"
        ):
            metadata_draft["brand"] = catalog_brand.strip()
            metadata_draft["brand_confidence"] = max(
                float(metadata_draft.get("brand_confidence", 0) or 0), 0.95
            )


class MediaWorker:
    def __init__(self, settings: WorkerSettings, gateway: Any | None = None):
        self.settings = settings
        self.gateway = gateway or NativeGateway(settings)
        self.openclip_runtime: OpenCLIPONNXRuntime | None = None
        self.siglip2_runtime: bool = False
        self._siglip2_session = None

        if self.settings.embedding_profile in ("local_siglip2", "local_openclip"):
            siglip2_candidates = [
                Path(os.environ.get("Verity_SIGLIP2_MODEL_PATH", "")) if os.environ.get("Verity_SIGLIP2_MODEL_PATH") else None,
                Path("/app/models/siglip2-vision-opset18.onnx"),
                Path("/opt/verity-media/benchmarks/models/siglip2-vision-opset18.onnx"),
                Path("models/siglip2-vision-opset18.onnx"),
                Path(__file__).resolve().parents[1] / "benchmarks" / "models" / "siglip2-vision-opset18.onnx",
            ]
            if self.settings.embedding_profile == "local_siglip2":
                for sp in siglip2_candidates:
                    if sp and sp.exists():
                        try:
                            import onnxruntime as ort
                            opts = ort.SessionOptions()
                            opts.intra_op_num_threads = 2
                            opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
                            self._siglip2_session = ort.InferenceSession(str(sp), sess_options=opts, providers=["CPUExecutionProvider"])
                            self._siglip2_input = self._siglip2_session.get_inputs()[0].name
                            self._siglip2_output = self._siglip2_session.get_outputs()[0].name
                            self.siglip2_runtime = True
                            print(f"[MediaWorker] Initialized Canonical SigLIP2 Vision ONNX Runtime from {sp} (Space: {SIGLIP2_SPACE_ID})")
                            break
                        except Exception as err:
                            print(f"[MediaWorker] Warning: Failed to load SigLIP2 ONNX at {sp}: {err}")

                if not self.siglip2_runtime:
                    raise ConfigurationError(
                        "FATAL: embedding_profile is 'local_siglip2' but Canonical SigLIP2 ONNX model failed to load or was not found. "
                        "Fallback to OpenCLIP 512-d is prohibited to avoid vector dimension corruption."
                    )
            elif self.settings.embedding_profile == "local_openclip":
                openclip_env_path = os.environ.get("Verity_OPENCLIP_MODEL_PATH")
                candidate_paths = [
                    Path(openclip_env_path) if openclip_env_path else None,
                    Path("/app/models/openclip-256.onnx"),
                    Path("/opt/verity-media/benchmarks/models/openclip-256.onnx"),
                    Path("models/openclip-256.onnx"),
                ]
                for cp in candidate_paths:
                    if cp and cp.exists():
                        try:
                            self.openclip_runtime = OpenCLIPONNXRuntime(cp)
                            print(f"[MediaWorker] Initialized Canonical OpenCLIP ONNX Runtime from {cp} (Space: {self.openclip_runtime.space_id})")
                            break
                        except Exception as err:
                            raise ConfigurationError(f"Failed to initialize Canonical OpenCLIP ONNX runtime at {cp}: {err}") from err

                if self.openclip_runtime is None:
                    raise ConfigurationError(
                        "FATAL: embedding_profile is 'local_openclip' but OpenCLIP ONNX model was not found in candidate paths."
                    )

    def run_once(self) -> bool:
        job = self.gateway.claim_job()
        if not job:
            return False
        job_id = str(job["id"])
        try:
            if job["job_kind"] == "analyze_image":
                self._analyze_image(job)
            elif job["job_kind"] == "publish_wordpress":
                self._publish_wordpress(job)
            elif job["job_kind"] == "publish_canonical_media":
                self._publish_canonical_media(job)
            elif job["job_kind"] == "prepare_reference":
                self._prepare_product_intake_reference(job)
            else:
                raise NonRetryableWorkerError(f"Unsupported job kind: {job['job_kind']}")
        except NonRetryableWorkerError as error:
            self._fail(job_id, str(error), retryable=False)
        except (ConfigurationError, GatewayError) as error:
            # A missing configuration or transient database/object-store
            # failure must remain visible and retryable after ops fixes it.
            self._fail(job_id, str(error), retryable=True)
        except Exception as error:  # noqa: BLE001 - all worker failures must be persisted
            self._fail(job_id, f"{type(error).__name__}: {error}", retryable=True)
        return True

    def _fail(self, job_id: str, message: str, retryable: bool) -> None:
        # Failures are persisted on the job row, but nothing used to reach the
        # container log, so `docker logs` looked healthy while jobs kept retrying.
        outcome = "failed, will retry" if retryable else "failed permanently"
        print(f"[MediaWorker] job {job_id} {outcome}: {message[:300]}", flush=True)
        try:
            self.gateway.rpc(
                "fail_media_ingest_job",
                {"p_job_id": job_id, "p_error_message": message[:2000], "p_retryable": retryable},
            )
        except Exception as error:  # noqa: BLE001
            # The original job lease will expire and be reclaimed. Do not leak secrets.
            print(f"failed to persist worker error for job {job_id}: {type(error).__name__}")

    def _download_asset(self, asset: dict[str, Any]) -> tuple[bytes, str]:
        storage_path = asset.get("storage_path")
        if not isinstance(storage_path, str) or not storage_path:
            raise NonRetryableWorkerError("Asset does not have a private storage path")
        dimensions = asset.get("dimensions")
        if not isinstance(dimensions, dict):
            dimensions = {}
        mime_type = str(dimensions.get("mime_type") or asset.get("mime_type") or "")
        if not mime_type:
            mime_type = mimetypes.guess_type(storage_path)[0] or "image/jpeg"
        return self.gateway.download_object(storage_path), mime_type

    def _analyze_image(self, job: dict[str, Any]) -> None:
        asset_id = str(job["media_asset_id"])
        asset = self.gateway.get_media_asset(asset_id)
        if asset.get("media_type") == "video":
            return self._analyze_video(job, asset)
        source, mime_type = self._download_asset(asset)
        if not mime_type.startswith("image/"):
            raise NonRetryableWorkerError(f"Unsupported analysis MIME type: {mime_type}")
        examples = self.gateway.metadata_examples()
        taxonomy_options = self.gateway.taxonomy_options()
        origin_info = asset.get("origin_info")
        batch_context = origin_info.get("batch_context") if isinstance(origin_info, dict) else None
        if not isinstance(batch_context, str):
            batch_context = None

        if getattr(self, "siglip2_runtime", False) and self._siglip2_session is not None:
            import io
            from PIL import Image

            def embedding_callback(payload: bytes, _mime: str = "image/jpeg") -> list[float]:
                with Image.open(io.BytesIO(payload)) as img:
                    t = canonical_siglip2_preprocess(img)
                out = self._siglip2_session.run([self._siglip2_output], {self._siglip2_input: t})
                return _validate_embedding(out[0][0], space_id=SIGLIP2_SPACE_ID).tolist()
        elif self.openclip_runtime is not None:
            # Canonical Local OpenCLIP ONNX Path
            def embedding_callback(payload: bytes, _mime: str = "image/jpeg") -> list[float]:
                return self.openclip_runtime.embed_image_bytes(payload)
        else:
            # Legacy API Embedding Path (preserved for staged rollout)
            embedding_settings = apply_shared_embedding_config(self.settings, self.gateway.shared_embedding_config())
            embedding_client = EmbeddingClient(embedding_settings)
            embedding_callback = embedding_client.embed_image
            if embedding_settings.embedding_input_mode == "url":
                signed_url = self.gateway.presign_download_url(str(asset["storage_path"]), expires_in=900)

                def embedding_callback(_payload: bytes, _mime_type: str = "image/jpeg") -> list[float]:
                    return embedding_client.embed_image_url(signed_url)

        vision_settings = apply_shared_vision_config(self.settings, self.gateway.shared_vision_config())
        suffix = mimetypes.guess_extension(mime_type) or ".jpg"
        with tempfile.NamedTemporaryFile(prefix="verity-media-", suffix=suffix, delete=False) as temporary:
            temporary.write(source)
            image_path = Path(temporary.name)
        try:
            # SKU/dedup and metadata have independent latency and failure modes.
            def run_vision_metadata() -> dict[str, Any]:
                vision_source, vision_mime_type = vision_rendition(source)
                return call_vision_metadata(
                    vision_settings,
                    vision_source,
                    vision_mime_type,
                    examples,
                    taxonomy_options=taxonomy_options,
                    batch_context=batch_context,
                )

            with ThreadPoolExecutor(max_workers=2, thread_name_prefix="verity-tag") as executor:
                visual_future = executor.submit(image_features, image_path, embedding_callback)
                vision_future = executor.submit(run_vision_metadata)
                phash, embedding, width, height = visual_future.result()
                vector = embedding
                try:
                    metadata_draft = vision_future.result()
                    metadata_error: str | None = None
                except Exception as error:  # Vision failure must not fabricate or erase SKU.
                    metadata_draft = {}
                    metadata_error = f"{type(error).__name__}: {error}"[:2000]
        finally:
            image_path.unlink(missing_ok=True)

        brand_hint = sanitize_brand_prior(metadata_draft.get("brand") or asset.get("brand"))
        image_sku_candidates = self.gateway.rpc(
            "match_sku_reference_candidates", {
                "p_embedding": embedding,
                "p_match_count": 20,
                "p_brand": brand_hint,
            }
        )
        text_values: list[object] = []
        if isinstance(asset.get("title"), str):
            text_values.append(asset["title"])
        if isinstance(asset.get("storage_path"), str):
            text_values.append(Path(asset["storage_path"]).stem)
        visible_text_confidence = metadata_draft.get("visible_text_confidence")
        if (
            isinstance(metadata_draft.get("visible_text"), list)
            and isinstance(visible_text_confidence, (int, float))
            and visible_text_confidence >= 0.75
        ):
            text_values.extend(metadata_draft["visible_text"])
        text_matcher = getattr(self.gateway, "match_catalog_text_candidates", None)
        text_sku_candidates: list[dict[str, Any]] = []
        if callable(text_matcher):
            try:
                text_sku_candidates = text_matcher(text_values, match_count=20)
            except Exception as error:
                print(f"catalog text matching failed for asset {asset_id}: {type(error).__name__}: {error}")
        sku_candidates = fuse_sku_candidates(
            image_sku_candidates if isinstance(image_sku_candidates, list) else [],
            text_sku_candidates,
        )
        decision = gate_sku_candidates(sku_candidates if isinstance(sku_candidates, list) else [])
        if decision.confidence_band == "high" and decision.sku:
            reference_rows = self.gateway.get_sku_references(decision.sku)
            reference_similarities: list[float] = []
            primary_similarities: list[float] = []
            for row in reference_rows:
                raw_embedding = row.get("embedding")
                if raw_embedding is None:
                    continue
                similarity = cosine_similarity(embedding, parse_embedding(raw_embedding))
                reference_similarities.append(similarity)
                if row.get("is_primary"):
                    primary_similarities.append(similarity)
            primary_similarity = max(primary_similarities) if primary_similarities else None
            decision = apply_consistency_gate(decision, reference_similarities, primary_similarity)

        phash_matches = self.gateway.rpc(
            "match_phash_duplicate_candidates",
            {
                "p_media_asset_id": asset_id,
                "p_phash": phash,
                "p_max_distance": self.settings.phash_max_distance,
                "p_match_count": 10,
            },
        )
        scene_matches = self.gateway.rpc(
            "match_scene_duplicate_candidates",
            {
                "p_media_asset_id": asset_id,
                "p_embedding": embedding,
                "p_threshold": self.settings.scene_duplicate_threshold,
                "p_match_count": 10,
            },
        )
        catalog_product = None
        catalog_lookup = getattr(self.gateway, "get_catalog_product", None)
        if decision.sku and callable(catalog_lookup):
            try:
                candidate_product = catalog_lookup(decision.sku)
                if isinstance(candidate_product, dict):
                    catalog_product = candidate_product
            except Exception as error:
                metadata_draft["catalog_identity_error"] = f"{type(error).__name__}: {error}"[:500]

        if catalog_product:
            # A brand printed on the item that contradicts the catalog brand is
            # evidence against the embedding proposal: withhold the SKU.
            decision = apply_brand_conflict_gate(
                decision,
                metadata_draft.get("brand"),
                metadata_draft.get("brand_confidence"),
                catalog_product.get("brand"),
            )
            if not decision.sku:
                catalog_product = None
        sku_match_payload = decision.as_dict()

        enrich_catalog_identity(metadata_draft, sku_match_payload, catalog_product)

        # Generate web-friendly preview JPEG for HEIC/HEIF so desktop browsers can display them
        is_heif = (
            mime_type in ("image/heic", "image/heif")
            or str(asset.get("storage_path") or "").lower().endswith((".heic", ".heif"))
        )
        thumbnail_storage_path: str | None = None
        thumbnail_url: str | None = None
        if is_heif:
            try:
                storage_path = str(asset.get("storage_path") or f"photos/{asset_id}")
                owner_prefix = storage_path.split("/")[0] if "/" in storage_path else "uploads"
                thumbnail_storage_path = f"{owner_prefix}/thumb-{asset_id}.jpg"
                thumb_bytes, _, _, _ = wordpress_rendition(source, maximum_edge=2048)
                publisher = R2Publisher(self.settings)
                thumbnail_url = publisher.publish(thumbnail_storage_path, thumb_bytes, "image/jpeg")
            except Exception as upload_err:
                print(f"Failed to generate HEIF preview thumbnail for {asset_id}: {upload_err}")
                thumbnail_storage_path = None
                thumbnail_url = None

        if getattr(self, "siglip2_runtime", False):
            sku_model_name = "siglip2-b32-256"
        elif self.openclip_runtime:
            sku_model_name = "openclip-b32-datacomp-256"
        else:
            sku_model_name = embedding_settings.embedding_model

        resolver = getattr(self.gateway, "space_resolver", None)
        active_space = resolver.get_active_space_id() if resolver else (SIGLIP2_SPACE_ID if getattr(self, "siglip2_runtime", False) else CANONICAL_SPACE_ID)
        embeddings_by_space = {active_space: embedding}
        if not getattr(self, "siglip2_runtime", False) and CANONICAL_SPACE_ID not in embeddings_by_space:
            embeddings_by_space[CANONICAL_SPACE_ID] = embedding

        self.gateway.rpc(
            "complete_media_analysis",
            {
                "p_job_id": str(job["id"]),
                "p_phash": phash,
                "p_image_embedding": embedding,
                "p_embeddings_by_space": embeddings_by_space,
                "p_content_hash": asset.get("content_hash"),
                "p_sku_suggestion": decision.sku or "",
                "p_sku_match": sku_match_payload,
                "p_metadata_draft": metadata_draft,
                "p_phash_matches": json_matches(phash_matches if isinstance(phash_matches, list) else []),
                "p_scene_matches": json_matches(scene_matches if isinstance(scene_matches, list) else []),
                "p_metadata_error": metadata_error,
                "p_sku_model": sku_model_name,
                "p_metadata_model": vision_settings.vision_model,
                "p_prompt_version": PROMPT_VERSION,
                "p_width": width,
                "p_height": height,
                "p_thumbnail_path": thumbnail_storage_path,
                "p_thumbnail_url": thumbnail_url,
            },
        )

    def _analyze_video(self, job: dict[str, Any], asset: dict[str, Any]) -> None:
        asset_id = str(job["media_asset_id"])
        source, mime_type = self._download_asset(asset)
        suffix = mimetypes.guess_extension(mime_type) or ".mp4"
        with tempfile.NamedTemporaryFile(prefix="verity-video-", suffix=suffix, delete=False) as temporary:
            temporary.write(source)
            video_path = Path(temporary.name)

        thumb_path = video_path.with_suffix(".thumb.jpg")
        try:
            from app.video_processing import extract_video_thumbnail, is_ffmpeg_available, probe_video_metadata

            metadata_error: str | None = None
            width = 0
            height = 0
            duration = ""
            thumbnail_bytes: bytes | None = None

            if is_ffmpeg_available():
                try:
                    probe = probe_video_metadata(video_path)
                    width = int(probe.get("width") or 0)
                    height = int(probe.get("height") or 0)
                    duration = str(probe.get("duration") or "")

                    thumbnail_bytes = extract_video_thumbnail(video_path, thumb_path, target_timestamp=1.0)
                except Exception as err:
                    metadata_error = f"Video processing error: {err}"[:500]
            else:
                metadata_error = "ffmpeg/ffprobe not installed on worker"

            thumbnail_storage_path: str | None = None
            thumbnail_url: str | None = None

            if thumbnail_bytes and self.settings.r2_bucket:
                storage_path = str(asset.get("storage_path") or f"videos/{asset_id}")
                owner_prefix = storage_path.split("/")[0] if "/" in storage_path else "uploads"
                thumbnail_storage_path = f"{owner_prefix}/thumb-{asset_id}.jpg"
                try:
                    publisher = R2Publisher(self.settings)
                    thumbnail_url = publisher.publish(thumbnail_storage_path, thumbnail_bytes, "image/jpeg")
                except Exception as upload_err:
                    metadata_error = f"Thumbnail upload error: {upload_err}"[:500]

            self.gateway.rpc(
                "complete_video_analysis",
                {
                    "p_job_id": str(job["id"]),
                    "p_thumbnail_path": thumbnail_storage_path,
                    "p_thumbnail_url": thumbnail_url,
                    "p_duration": duration,
                    "p_width": width,
                    "p_height": height,
                    "p_metadata_error": metadata_error,
                },
            )
        finally:
            video_path.unlink(missing_ok=True)
            thumb_path.unlink(missing_ok=True)

    @staticmethod
    def _canonical_upload_prefix(asset: dict[str, Any]) -> str:
        """Return the stable WordPress-compatible folder for one asset.

        The timestamp comes from creation provenance, never from republish
        time, so metadata corrections produce a new immutable object without
        moving an existing canonical URL to a different month.
        """

        created_at = asset.get("created_at")
        if isinstance(created_at, datetime):
            timestamp = created_at
        else:
            raw = str(created_at or "").strip().replace("Z", "+00:00")
            try:
                timestamp = datetime.fromisoformat(raw)
            except ValueError:
                timestamp = datetime.now(timezone.utc)
        return f"wp-content/uploads/{timestamp.year:04d}/{timestamp.month:02d}"

    def _publish_canonical_renditions(self, asset: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
        """Upload every WebP variant before mutating the database pointer."""

        source, _ = self._download_asset(asset)
        publisher = R2Publisher(self.settings)
        slug = build_public_image_slug(asset)

        # Merge org-wide license config into asset metadata
        license_cfg: dict[str, Any] = {}
        try:
            license_cfg = self.gateway.get_license_config()
        except Exception:
            license_cfg = {}
        asset_with_license = {**asset, **{k: v for k, v in license_cfg.items() if v is not None and k not in asset}}

        fingerprint = build_rendition_fingerprint(source, asset_with_license)
        renditions = generate_canonical_renditions(source, asset_with_license)
        prefix = self._canonical_upload_prefix(asset)

        uploaded_renditions: list[dict[str, Any]] = []
        for r in renditions:
            pub_key = f"{prefix}/{slug}-{fingerprint}-{r.width}x{r.height}.{r.format}"
            cdn_url = publisher.publish_immutable(pub_key, r.payload, r.mime_type, fingerprint=fingerprint)
            uploaded_renditions.append({
                "purpose": r.purpose,
                "format": r.format,
                "width": r.width,
                "height": r.height,
                "size_bytes": r.size_bytes,
                "cdn_key": pub_key,
                "cdn_url": cdn_url,
                "mime_type": r.mime_type,
                "rendition_fingerprint": fingerprint,
                "metadata_version": 1,
            })
        largest = max(uploaded_renditions, key=lambda x: x["width"])
        return uploaded_renditions, largest, slug

    def _publish_canonical_media(self, job: dict[str, Any]) -> None:
        asset = self.gateway.get_media_asset(str(job["media_asset_id"]))
        if asset.get("media_type") not in {"photo", "render", "screenshot"}:
            raise NonRetryableWorkerError("Canonical media pipeline supports image assets only")
        if not str(asset.get("storage_path") or ""):
            raise NonRetryableWorkerError("Asset does not have a private storage path")
        renditions, largest, slug = self._publish_canonical_renditions(asset)
        payload = job.get("payload") if isinstance(job.get("payload"), dict) else {}
        canonical_version = int(payload.get("canonical_version") or asset.get("canonical_version") or 1)
        self.gateway.rpc(
            "complete_canonical_media_publish",
            {
                "p_job_id": str(job["id"]),
                "p_canonical_version": canonical_version,
                "p_canonical_slug": slug,
                "p_cdn_key": largest["cdn_key"],
                "p_cdn_url": largest["cdn_url"],
                "p_width": largest["width"],
                "p_height": largest["height"],
                "p_mime_type": largest["mime_type"],
                "p_renditions": renditions,
            },
        )

    def _prepare_product_intake_reference(self, job: dict[str, Any]) -> None:
        """Prove the selected source bytes before the gateway activates a reference.

        The gateway performs all lifecycle and active-space checks atomically.
        This worker downloads the private source and supplies its SHA-256 so a
        stale embedding cannot become a usable product reference.
        """
        asset = self.gateway.get_media_asset(str(job["media_asset_id"]))
        source, mime_type = self._download_asset(asset)
        if not mime_type.startswith("image/"):
            raise NonRetryableWorkerError("Product references require an image asset")
        self.gateway.rpc(
            "complete_product_intake_reference",
            {
                "p_job_id": str(job["id"]),
                "p_source_sha256": hashlib.sha256(source).hexdigest(),
            },
        )

    def _publish_wordpress(self, job: dict[str, Any]) -> None:
        asset_id = str(job["media_asset_id"])
        asset = self.gateway.get_media_asset(asset_id)
        storage_path = str(asset.get("storage_path") or "")
        if not storage_path:
            raise NonRetryableWorkerError("Asset does not have a private storage path")

        if asset.get("media_type") == "video":
            _source, mime_type = self._download_asset(asset)
            cdn_url = asset.get("file_url") or f"{self.settings.r2_public_base_url}/{storage_path}"
            dims = asset.get("dimensions") or {}
            self.gateway.rpc(
                "complete_wordpress_publish",
                {
                    "p_job_id": str(job["id"]),
                    "p_cdn_key": storage_path,
                    "p_cdn_url": cdn_url,
                    "p_width": dims.get("width", 0),
                    "p_height": dims.get("height", 0),
                    "p_mime_type": mime_type,
                },
            )
            return

        renditions, largest, _slug = self._publish_canonical_renditions(asset)

        self.gateway.rpc(
            "complete_wordpress_publish",
            {
                "p_job_id": str(job["id"]),
                "p_cdn_key": largest["cdn_key"],
                "p_cdn_url": largest["cdn_url"],
                "p_width": largest["width"],
                "p_height": largest["height"],
                "p_mime_type": largest["mime_type"],
                "p_renditions": renditions,
            },
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="VerityDAM worker")
    parser.add_argument("--once", action="store_true", help="Process one available job and exit")
    parser.add_argument("--poll-interval", type=float, default=2.0, help="Seconds to sleep when idle")
    args = parser.parse_args()

    settings = WorkerSettings.from_environment()
    worker = MediaWorker(settings)

    if args.once:
        worker.run_once()
        return

    while True:
        try:
            handled = worker.run_once()
        except Exception as error:  # noqa: BLE001
            print(f"uncaught worker loop error: {type(error).__name__}: {error}")
            handled = False
        if not handled:
            time.sleep(args.poll_interval)


if __name__ == "__main__":
    main()
