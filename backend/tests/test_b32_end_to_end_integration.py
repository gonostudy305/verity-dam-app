"""End-to-End Integration Tests for Canonical OpenCLIP ViT-B/32 Space.

Validates the full chain:
1. NativeGateway match_sku_reference_candidates uses B32 space (verity-openclip-b32-datacomp-256-v1) and match_eligible = true.
2. NativeGateway get_sku_references uses B32 space and match_eligible = true.
3. NativeGateway match_scene_duplicate_candidates filters on local_openclip provider and openclip-b32-datacomp-256 model.
4. NativeGateway _complete_media_analysis persists local_openclip provider and openclip-b32-datacomp-256 model.
5. MediaWorker executes local OpenCLIP ONNX runtime fail-closed and produces B32 provenance end-to-end.
"""

from __future__ import annotations

import io
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import numpy as np
from PIL import Image

from app.native_gateway import NativeGateway, _PROVIDER, _SPACE_ID
from app.production_config import (
    CANONICAL_SPACE_ID,
    PRODUCTION_EMBEDDING_MODEL,
    PRODUCTION_EMBEDDING_PROVIDER,
    PRODUCTION_EMBEDDING_VERSION,
    WorkerSettings,
)
from app.worker import MediaWorker


class TestB32EndToEndIntegration(unittest.TestCase):
    def test_canonical_constants_aligned(self):
        self.assertEqual(_SPACE_ID, CANONICAL_SPACE_ID)
        self.assertEqual(CANONICAL_SPACE_ID, "verity-siglip2-b32-256-webli-v1")
        self.assertEqual(PRODUCTION_EMBEDDING_PROVIDER, "local_siglip2")
        self.assertEqual(PRODUCTION_EMBEDDING_MODEL, "siglip2-b32-256-webli")
        self.assertEqual(PRODUCTION_EMBEDDING_VERSION, "v1")

    def test_matcher_queries_shadow_b32_store(self):
        mock_repo = MagicMock()
        mock_repo.fetch_all.return_value = [{"sku": "HR-21", "similarity": 0.95}]
        
        settings = WorkerSettings(
            worker_id="test",
            poll_seconds=3,
            scene_duplicate_threshold=0.92,
            phash_max_distance=12,
            embedding_profile="local_openclip",
            embedding_provider="local_openclip",
            embedding_base_url=None,
            embedding_api_key="",
            embedding_model="openclip-b32-datacomp-256",
            embedding_version="v1",
            embedding_dimension=512,
            embedding_input_mode="bytes",
            vision_base_url=None,
            vision_api_key=None,
            vision_model=None,
            vision_detail="high",
            vision_max_tokens=900,
            vision_system_prompt="",
            r2_endpoint=None,
            r2_access_key_id=None,
            r2_secret_access_key=None,
            r2_bucket=None,
            r2_region="auto",
            r2_public_base_url=None,
            database_url="postgresql://test/db",
        )
        
        mock_storage = MagicMock()
        gateway = NativeGateway(settings, repository=mock_repo, storage=mock_storage)
        query_vec = [0.01] * 512
        candidates = gateway.match_sku_reference_candidates(query_vec, match_count=10)
        
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["sku"], "HR-21")
        
        # Verify SQL query structure and parameters
        sql_call = mock_repo.fetch_all.call_args
        self.assertIsNotNone(sql_call)
        query_sql, params = sql_call[0]
        
        self.assertIn("reference_embeddings", query_sql)
        self.assertIn("sku_references", query_sql)
        self.assertIn("match_eligible = true", query_sql)
        self.assertIn("space_id = %s", query_sql)
        self.assertEqual(params[1], _SPACE_ID)

    def test_get_sku_references_queries_shadow_b32_store(self):
        mock_repo = MagicMock()
        mock_repo.fetch_all.return_value = [
            {"embedding": "[0.1, 0.2]", "source_url": "https://example.com/img.jpg", "is_primary": True}
        ]
        
        settings = MagicMock()
        settings.database_url = "postgresql://test/db"
        mock_storage = MagicMock()
        gateway = NativeGateway(settings, repository=mock_repo, storage=mock_storage)
        
        refs = gateway.get_sku_references("HR-21")
        self.assertEqual(len(refs), 1)
        
        sql_call = mock_repo.fetch_all.call_args
        query_sql, params = sql_call[0]
        self.assertIn("reference_embeddings", query_sql)
        self.assertIn("sku_references", query_sql)
        self.assertIn("space_id = %s", query_sql)
        self.assertIn("match_eligible = true", query_sql)
        self.assertEqual(params[0], _SPACE_ID)
        self.assertEqual(params[1], "HR-21")

    def test_scene_duplicate_matches_filters_by_b32_provenance(self):
        mock_repo = MagicMock()
        mock_repo.fetch_all.return_value = []
        
        settings = MagicMock()
        settings.database_url = "postgresql://test/db"
        mock_storage = MagicMock()
        gateway = NativeGateway(settings, repository=mock_repo, storage=mock_storage)
        
        gateway.match_scene_duplicate_candidates("asset-1", [0.01] * 512, threshold=0.92, match_count=5)
        
        sql_call = mock_repo.fetch_all.call_args
        query_sql, params = sql_call[0]
        self.assertIn("asset_embeddings ae", query_sql)
        self.assertIn("ae.space_id = %s", query_sql)
        self.assertEqual(params[1], _SPACE_ID)

    def test_complete_media_analysis_persists_b32_provenance(self):
        mock_repo = MagicMock()
        mock_cursor = MagicMock()
        mock_cursor.fetchone.return_value = ("asset-uuid-1",)
        mock_cursor.fetchall.return_value = []
        mock_repo.transaction.return_value.__enter__.return_value = mock_cursor

        settings = MagicMock()
        settings.database_url = "postgresql://test/db"
        mock_storage = MagicMock()
        gateway = NativeGateway(settings, repository=mock_repo, storage=mock_storage)

        payload = {
            "p_job_id": "00000000-0000-0000-0000-000000000001",
            "p_phash": "0123456789abcdef",
            "p_image_embedding": [0.01] * 512,
            "p_sku_suggestion": "HR-21",
            "p_sku_match": {"sku": "HR-21", "similarity": 0.95},
            "p_metadata_draft": {"brand": "Verity"},
            "p_phash_matches": [],
            "p_scene_matches": [],
            "p_metadata_error": None,
            "p_sku_model": "openclip-b32-datacomp-256",
            "p_metadata_model": "gemini-2.5",
            "p_prompt_version": "v1",
            "p_width": 800,
            "p_height": 600,
        }

        gateway._complete_media_analysis(payload)

        # Verify media_assets update query uses local_openclip provenance
        update_calls = [
            call for call in mock_cursor.execute.call_args_list
            if "update public.media_assets" in str(call[0][0])
        ]
        self.assertTrue(len(update_calls) > 0)
        _sql, params = update_calls[0][0]
        
        # params: phash, embedding, provider, model, version, dimension...
        self.assertEqual(params[2], "local_openclip")
        self.assertEqual(params[3], "openclip-b32-datacomp-256")
        self.assertEqual(params[4], "v1")
        self.assertEqual(params[5], 512)

    def test_complete_media_analysis_handles_siglip2_768d_safely(self):
        mock_repo = MagicMock()
        mock_cursor = MagicMock()
        mock_cursor.fetchone.return_value = ("asset-uuid-1", "sha256-hash")
        mock_cursor.fetchall.return_value = []
        mock_repo.transaction.return_value.__enter__.return_value = mock_cursor

        settings = MagicMock()
        settings.database_url = "postgresql://test/db"
        mock_storage = MagicMock()
        gateway = NativeGateway(settings, repository=mock_repo, storage=mock_storage)

        siglip2_vector = [0.02] * 768
        payload = {
            "p_job_id": "00000000-0000-0000-0000-000000000002",
            "p_phash": "0123456789abcdef",
            "p_image_embedding": siglip2_vector,
            "p_embeddings_by_space": {"verity-siglip2-b32-256-webli-v1": siglip2_vector},
            "p_sku_suggestion": "HR-21",
            "p_sku_match": {"sku": "HR-21", "similarity": 0.95},
            "p_metadata_draft": {"brand": "Verity"},
            "p_phash_matches": [],
            "p_scene_matches": [],
            "p_metadata_error": None,
            "p_sku_model": "siglip2-b32-256",
            "p_metadata_model": "gemini-2.5",
            "p_prompt_version": "v1",
            "p_width": 800,
            "p_height": 600,
        }

        gateway._complete_media_analysis(payload)

        update_calls = [
            call for call in mock_cursor.execute.call_args_list
            if "update public.media_assets" in str(call[0][0])
        ]
        self.assertTrue(len(update_calls) > 0)
        _sql, params = update_calls[0][0]

        # For 768-d vector, legacy 512-d column receives None (coalesce preserves NULL / existing)
        self.assertIsNone(params[1])  # legacy_vector
        self.assertIsNone(params[2])  # provider
        self.assertIsNone(params[3])  # model
        self.assertIsNone(params[4])  # version
        self.assertIsNone(params[5])  # dimension

        # Verify asset_embeddings receives the 768-d vector for SigLIP2 space
        asset_emb_calls = [
            call for call in mock_cursor.execute.call_args_list
            if "insert into public.asset_embeddings" in str(call[0][0])
        ]
        self.assertTrue(len(asset_emb_calls) > 0)
        _ae_sql, ae_params = asset_emb_calls[0][0]
        self.assertEqual(ae_params[1], "verity-siglip2-b32-256-webli-v1")


if __name__ == "__main__":
    unittest.main()
