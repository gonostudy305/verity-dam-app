"""Standalone OpenCLIP Shadow Worker (Sidecar).

Evaluates production media traffic asynchronously with OpenCLIP ONNX without touching production tables.

Strict Invariants:
1. Zero writes to media_assets.sku / media_assets.image_embedding / sku_reference_embeddings.
2. Writes ONLY to public.media_asset_shadow_predictions.
3. Isolated sidecar: fails open, never crashes main media worker or API.
4. Uses canonical aspect-ratio preserving OpenCLIP preprocessing.
5. Verifies model artifact SHA-256 binary at startup.
6. Evaluates ONLY completed ('ready') production assets.
7. Matches exact Production SKU Aggregation & Primary-Weighted Scoring formula:
   similarity = coalesce(prim_sim, max_sim * 0.85) * 0.7 + max_sim * 0.3
8. Bounded exponential backoff retries (max 5 attempts before transitioning to DEAD).
9. Deterministic hash-bucket sampling for staged rollouts.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import os
import signal
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from app.openclip_runtime import (
    CANONICAL_SPACE_ID,
    OpenCLIPONNXRuntime,
)
from app.postgres_repository import PostgresRepository, PostgresSettings
from app.r2_storage import R2Storage, R2Settings

Image.MAX_IMAGE_PIXELS = None

logger = logging.getLogger("shadow_worker")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [ShadowWorker] %(message)s",
)

SHADOW_SPACE_ID = CANONICAL_SPACE_ID
MAX_RETRY_ATTEMPTS = 5


@dataclass
class ShadowWorkerConfig:
    onnx_model_path: Path
    space_id: str = SHADOW_SPACE_ID
    sample_rate: float = 1.0
    poll_interval_sec: float = 5.0
    batch_size: int = 5
    max_images_to_process: int | None = None


def is_sample_in_canary(asset_id: str, space_id: str, sample_rate: float) -> bool:
    """Deterministic hash bucket 0-99 to ensure idempotent sampling."""
    if sample_rate >= 1.0:
        return True
    if sample_rate <= 0.0:
        return False
    hash_val = int(hashlib.sha256(f"{asset_id}:{space_id}".encode()).hexdigest()[:8], 16)
    bucket = hash_val % 100
    threshold = int(sample_rate * 100)
    return bucket < threshold


class OpenCLIPShadowWorker:
    def __init__(self, config: ShadowWorkerConfig):
        self.config = config
        self.repo = PostgresRepository(PostgresSettings.from_environment())
        self.r2 = None
        try:
            self.r2 = R2Storage(R2Settings.from_environment())
        except Exception as err:
            logger.warning(f"R2 storage not configured: {err}")

        self.encoder = OpenCLIPONNXRuntime(config.onnx_model_path)
        self._running = True
        self.processed_count = 0

    def stop(self) -> None:
        self._running = False

    def fetch_unprocessed_assets(self) -> list[dict[str, Any]]:
        """Fetch ready production assets lacking shadow prediction or with bounded pending retries."""
        query = """
            select 
                ma.id as media_asset_id,
                ma.storage_path,
                ma.cdn_url,
                ma.file_url,
                ma.title as original_filename,
                ma.sku as jina_production_sku,
                ma.ai_confidence,
                coalesce(sp.attempt_count, 0) as current_attempts
            from public.media_assets ma
            left join public.media_asset_shadow_predictions sp
                on ma.id = sp.media_asset_id and sp.space_id = %(space_id)s
            where ma.ingest_status = 'ready'
              and (
                sp.id is null 
                or (sp.status = 'FAILED' and sp.attempt_count < %(max_attempts)s and sp.next_retry_at <= now())
              )
            order by ma.created_at desc
            limit %(batch_size)s
        """
        return self.repo.fetch_all(query, {
            "space_id": self.config.space_id,
            "max_attempts": MAX_RETRY_ATTEMPTS,
            "batch_size": self.config.batch_size,
        })

    def match_shadow_sku_candidates(self, query_vec: np.ndarray, match_count: int = 20) -> list[dict[str, Any]]:
        """Match SKU candidates mirroring exact Production Weighted Scoring CTE."""
        vec_list = [round(float(x), 6) for x in query_vec.tolist()]
        query = """
            with raw_hits as (
                select r.sku, r.embedding <=> %(vec)s::vector as dist
                from public.sku_reference_embeddings_shadow r
                where r.space_id = %(space_id)s
                  and r.is_active = true
                  and r.match_eligible = true
                order by dist
                limit least(greatest(%(match_count)s * 8, 80), 300)
            ),
            raw_candidates as (
                select sku, min(dist) as min_dist
                from raw_hits
                group by sku
                order by min_dist
                limit least(greatest(%(match_count)s * 2, 30), 100)
            ),
            sku_stats as (
                select c.sku,
                       (
                           select (1 - (r.embedding <=> %(vec)s::vector))::real
                           from public.sku_reference_embeddings_shadow r
                           where r.space_id = %(space_id)s
                             and r.sku = c.sku
                             and r.is_active = true
                             and r.match_eligible = true
                           order by r.embedding <=> %(vec)s::vector
                           limit 1
                       ) as max_sim,
                       (
                           select (1 - (r.embedding <=> %(vec)s::vector))::real
                           from public.sku_reference_embeddings_shadow r
                           where r.space_id = %(space_id)s
                             and r.sku = c.sku
                             and r.is_active = true
                             and r.is_primary = true
                             and r.match_eligible = true
                           order by r.embedding <=> %(vec)s::vector
                           limit 1
                       ) as prim_sim
                from raw_candidates c
            )
            select sku,
                   (coalesce(prim_sim, max_sim * 0.85) * 0.7 + max_sim * 0.3)::real as similarity,
                   max_sim,
                   prim_sim
            from sku_stats
            order by (coalesce(prim_sim, max_sim * 0.85) * 0.7 + max_sim * 0.3) desc, max_sim desc
            limit least(greatest(%(match_count)s, 2), 50);
        """
        return self.repo.fetch_all(query, {
            "space_id": self.config.space_id,
            "vec": json.dumps(vec_list),
            "match_count": match_count,
        })

    def process_asset(self, asset: dict[str, Any]) -> None:
        asset_id = str(asset["media_asset_id"])
        storage_path = asset.get("storage_path")
        cdn_url = asset.get("cdn_url")
        file_url = asset.get("file_url")
        jina_sku = asset.get("jina_production_sku")
        ai_conf = asset.get("ai_confidence") or {}
        current_attempts = int(asset.get("current_attempts") or 0)
        jina_conf = None
        if isinstance(ai_conf, dict):
            jina_conf = ai_conf.get("confidence") or ai_conf.get("similarity") or ai_conf.get("sku_confidence")

        # Deterministic sampling check (Canary rollout)
        if not is_sample_in_canary(asset_id, self.config.space_id, self.config.sample_rate):
            logger.debug(f"Asset {asset_id} outside canary sample rate {self.config.sample_rate:.2f}")
            with self.repo.connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        insert into public.media_asset_shadow_predictions (
                            media_asset_id, space_id, model_sha256,
                            jina_production_sku, jina_confidence,
                            status, created_at
                        ) values (
                            %(asset_id)s, %(space_id)s, %(model_sha)s,
                            %(jina_sku)s, %(jina_conf)s,
                            'SKIPPED_CANARY', now()
                        ) on conflict (media_asset_id, space_id) do nothing
                        """,
                        {
                            "asset_id": asset_id,
                            "space_id": self.config.space_id,
                            "model_sha": self.encoder.model_sha256,
                            "jina_sku": jina_sku,
                            "jina_conf": jina_conf,
                        },
                    )
                conn.commit()
            return

        t0 = time.time()
        try:
            payload = None
            if storage_path and self.r2 is not None:
                try:
                    payload = self.r2.get_bytes(storage_path)
                except Exception as r2_err:
                    logger.debug(f"R2 get_bytes for {storage_path} failed: {r2_err}")
                    payload = None

            if payload is None:
                url_to_fetch = cdn_url or file_url
                if url_to_fetch and (url_to_fetch.startswith("http://") or url_to_fetch.startswith("https://")):
                    import requests
                    res = requests.get(url_to_fetch, timeout=20)
                    if res.status_code == 200:
                        payload = res.content
                    else:
                        logger.debug(f"HTTP fetch {url_to_fetch} returned status {res.status_code}")

            if payload is None:
                raise ValueError(f"Cannot load image bytes for asset {asset_id} (storage_path={storage_path}, cdn_url={cdn_url}, file_url={file_url})")

            query_vec = self.encoder.encode_bytes(payload)

            # Match SKU candidates using exact production scoring formula
            candidates = self.match_shadow_sku_candidates(query_vec, match_count=20)

            if not candidates:
                top1_sku = None
                top1_sim = None
                top2_sku = None
                top2_sim = None
                margin = None
            else:
                top1_sku = str(candidates[0]["sku"]).strip()
                top1_sim = float(candidates[0]["similarity"])
                top2_sku = str(candidates[1]["sku"]).strip() if len(candidates) > 1 else None
                top2_sim = float(candidates[1]["similarity"]) if len(candidates) > 1 else None
                margin = (top1_sim - top2_sim) if top2_sim is not None else top1_sim

            agreement = (top1_sku.lower() == jina_sku.lower()) if (top1_sku and jina_sku) else None
            latency_ms = round((time.time() - t0) * 1000, 2)

            # Insert or update shadow prediction record
            with self.repo.connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        insert into public.media_asset_shadow_predictions (
                            media_asset_id, space_id, model_sha256,
                            openclip_top1_sku, openclip_top1_similarity,
                            openclip_top2_sku, openclip_top2_similarity,
                            openclip_margin, jina_production_sku, jina_confidence,
                            agreement, latency_ms, status, attempt_count, created_at
                        ) values (
                            %(asset_id)s, %(space_id)s, %(model_sha)s,
                            %(top1_sku)s, %(top1_sim)s,
                            %(top2_sku)s, %(top2_sim)s,
                            %(margin)s, %(jina_sku)s, %(jina_conf)s,
                            %(agreement)s, %(latency_ms)s, 'SUCCESS', 1, now()
                        ) on conflict (media_asset_id, space_id) 
                        do update set
                            openclip_top1_sku = excluded.openclip_top1_sku,
                            openclip_top1_similarity = excluded.openclip_top1_similarity,
                            openclip_top2_sku = excluded.openclip_top2_sku,
                            openclip_top2_similarity = excluded.openclip_top2_similarity,
                            openclip_margin = excluded.openclip_margin,
                            jina_production_sku = excluded.jina_production_sku,
                            jina_confidence = excluded.jina_confidence,
                            agreement = excluded.agreement,
                            latency_ms = excluded.latency_ms,
                            status = 'SUCCESS',
                            error_message = null,
                            attempt_count = media_asset_shadow_predictions.attempt_count + 1
                        """,
                        {
                            "asset_id": asset_id,
                            "space_id": self.config.space_id,
                            "model_sha": self.encoder.model_sha256,
                            "top1_sku": top1_sku,
                            "top1_sim": top1_sim,
                            "top2_sku": top2_sku,
                            "top2_sim": top2_sim,
                            "margin": margin,
                            "jina_sku": jina_sku,
                            "jina_conf": jina_conf,
                            "agreement": agreement,
                            "latency_ms": latency_ms,
                        },
                    )
                conn.commit()

            self.processed_count += 1
            agree_str = "AGREE ✅" if agreement else "DISAGREE ⚠️"
            logger.info(
                f"Processed {asset_id} in {latency_ms:.1f}ms: "
                f"Jina='{jina_sku}' vs OpenCLIP='{top1_sku}' (weighted_sim={top1_sim:.3f}, margin={margin:.3f}) -> {agree_str}"
            )

        except Exception as error:
            latency_ms = round((time.time() - t0) * 1000, 2)
            new_attempts = current_attempts + 1
            new_status = "DEAD" if new_attempts >= MAX_RETRY_ATTEMPTS else "FAILED"
            backoff_minutes = min(60, 2 ** new_attempts)

            logger.error(f"Failed shadow evaluation for {asset_id} (Attempt {new_attempts}/{MAX_RETRY_ATTEMPTS} -> {new_status}): {error}")
            try:
                with self.repo.connection() as conn:
                    with conn.cursor() as cur:
                        cur.execute(
                            """
                            insert into public.media_asset_shadow_predictions (
                                media_asset_id, space_id, model_sha256,
                                jina_production_sku, jina_confidence,
                                status, error_message, latency_ms, attempt_count,
                                next_retry_at, created_at
                            ) values (
                                %(asset_id)s, %(space_id)s, %(model_sha)s,
                                %(jina_sku)s, %(jina_conf)s,
                                %(status)s, %(error)s, %(latency_ms)s, %(attempt_count)s,
                                now() + (%(backoff_min)s || ' minutes')::interval, now()
                            ) on conflict (media_asset_id, space_id) 
                            do update set
                                status = excluded.status,
                                error_message = excluded.error_message,
                                latency_ms = excluded.latency_ms,
                                attempt_count = excluded.attempt_count,
                                next_retry_at = excluded.next_retry_at
                            """,
                            {
                                "asset_id": asset_id,
                                "space_id": self.config.space_id,
                                "model_sha": self.encoder.model_sha256,
                                "jina_sku": jina_sku,
                                "jina_conf": jina_conf,
                                "status": new_status,
                                "error": str(error),
                                "latency_ms": latency_ms,
                                "attempt_count": new_attempts,
                                "backoff_min": backoff_minutes,
                            },
                        )
                    conn.commit()
            except Exception:
                pass

    def run(self) -> None:
        logger.info(f"Starting OpenCLIP Shadow Worker (Space: {self.config.space_id}, Sample Rate: {self.config.sample_rate:.2f})")
        while self._running:
            try:
                assets = self.fetch_unprocessed_assets()
                if not assets:
                    time.sleep(self.config.poll_interval_sec)
                    continue

                for asset in assets:
                    if not self._running:
                        break
                    self.process_asset(asset)
                    if self.config.max_images_to_process and self.processed_count >= self.config.max_images_to_process:
                        logger.info(f"Reached max target of {self.config.max_images_to_process} images. Stopping.")
                        return

            except Exception as loop_err:
                logger.error(f"Loop error in shadow worker: {loop_err}")
                time.sleep(self.config.poll_interval_sec)

        logger.info("OpenCLIP Shadow Worker stopped gracefully.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run OpenCLIP Shadow Worker")
    parser.add_argument(
        "--onnx-model",
        default="/app/models/openclip-256.onnx",
        help="Path to openclip-256.onnx model",
    )
    parser.add_argument(
        "--sample-rate",
        type=float,
        default=1.0,
        help="Canary sample rate from 0.0 to 1.0 (default: 1.0 = 100%)",
    )
    parser.add_argument(
        "--max-images",
        type=int,
        default=None,
        help="Optional max images to process for canary runs (e.g. 20)",
    )
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=5.0,
        help="Polling interval in seconds when queue is idle",
    )
    args = parser.parse_args()

    onnx_candidates = [
        Path(args.onnx_model),
        Path("/app/models/openclip-256.onnx"),
        Path("/opt/verity-media/benchmarks/models/openclip-256.onnx"),
        Path(__file__).resolve().parent / "models" / "openclip-256.onnx",
    ]
    onnx_path = None
    for candidate in onnx_candidates:
        if candidate.exists():
            onnx_path = candidate
            break

    if not onnx_path:
        logger.info(
            "OpenCLIP model not found (OpenCLIP is retired). "
            "Shadow worker entering idle standby mode to maintain sidecar health."
        )
        stop_requested = False

        def sig_handler(signum, frame):
            nonlocal stop_requested
            logger.info("Received termination signal in standby. Shutting down...")
            stop_requested = True

        signal.signal(signal.SIGINT, sig_handler)
        signal.signal(signal.SIGTERM, sig_handler)

        while not stop_requested:
            time.sleep(5)

        logger.info("OpenCLIP Shadow Worker stopped gracefully from standby.")
        return 0

    cfg = ShadowWorkerConfig(
        onnx_model_path=onnx_path,
        sample_rate=args.sample_rate,
        poll_interval_sec=args.poll_interval,
        max_images_to_process=args.max_images,
    )
    worker = OpenCLIPShadowWorker(cfg)

    def sig_handler(signum, frame):
        logger.info("Received termination signal. Shutting down...")
        worker.stop()

    signal.signal(signal.SIGINT, sig_handler)
    signal.signal(signal.SIGTERM, sig_handler)

    worker.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
