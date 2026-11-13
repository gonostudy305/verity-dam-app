import unittest

from verity_dam_mcp.gateway import GatewayError, MediaMcpGateway


class FakeCursor:
    """Stands in for a psycopg cursor. `fetch_results` is the exact queue of
    fetchone() return values _finalize() will pull, in call order -- there is
    no real database here, so the test has to know that order up front.
    """

    def __init__(self, fetch_results):
        self._fetch_results = list(fetch_results)
        self.queries: list[tuple[str, tuple]] = []

    def execute(self, sql, params=None):
        self.queries.append((sql, params))

    def fetchone(self):
        return self._fetch_results.pop(0)

    def fetchall(self):
        if self._fetch_results and isinstance(self._fetch_results[0], list):
            return self._fetch_results.pop(0)
        return []


class FakeTransaction:
    def __init__(self, cursor):
        self._cursor = cursor

    def __enter__(self):
        return self._cursor

    def __exit__(self, *exc_info):
        return False


class FakeRepository:
    def __init__(self, cursor):
        self._cursor = cursor

    def transaction(self):
        return FakeTransaction(self._cursor)


def make_gateway(cursor: FakeCursor) -> MediaMcpGateway:
    # __init__ opens a real PostgresRepository/R2Storage connection, which
    # this test has no business standing up -- go through __new__ instead and
    # fill in only what _finalize() touches (self.repository, self._user_id,
    # self._role so user_id() short-circuits without a DB round trip).
    gateway = MediaMcpGateway.__new__(MediaMcpGateway)
    gateway._user_id = "user-1"
    gateway._role = "contributor"
    gateway.repository = FakeRepository(cursor)
    return gateway


class FinalizeBatchContextTests(unittest.TestCase):
    """Regression: UploadAssetInput.context (models.py) is documented as
    "stored on the asset's origin_info", but _finalize() -- a hand-rolled
    re-implementation of the finalize_upload_batch SQL function, not a call
    to it -- used to never read payload['p_context'] at all. Neither the
    column nor (therefore) the vision-prompt batch-context hint wired up in
    the web upload path ever saw an MCP-agent-supplied context.
    """

    def test_new_asset_persists_p_context_as_batch_context(self):
        cursor = FakeCursor([None, ("asset-1",), ("queue-1",)])
        gateway = make_gateway(cursor)

        result = gateway._finalize(
            {
                "p_uploads": [{"storage_path": "user-1/photo.jpg"}],
                "p_context": "Cả lô là ảnh showroom",
            }
        )

        self.assertEqual(
            result,
            [
                {
                    "media_asset_id": "asset-1",
                    "review_queue_id": "queue-1",
                    "is_duplicate": False,
                    "duplicate_asset_ids": [],
                }
            ],
        )
        insert_sql, insert_params = cursor.queries[1]
        self.assertIn("origin_info", insert_sql)
        self.assertIn("batch_context", insert_sql)
        # (file_name, path, path, path, path, media_type, permission,
        #  uploader, batch_context, created_by) -- batch_context is second
        # from the end of the bound params, right before created_by.
        self.assertEqual(insert_params[-2], "Cả lô là ảnh showroom")

    def test_missing_p_context_persists_none_not_empty_string(self):
        cursor = FakeCursor([None, ("asset-1",), ("queue-1",)])
        gateway = make_gateway(cursor)

        gateway._finalize({"p_uploads": [{"storage_path": "user-1/photo.jpg"}]})

        _insert_sql, insert_params = cursor.queries[1]
        self.assertIsNone(insert_params[-2])

    def test_blank_p_context_is_treated_as_absent(self):
        cursor = FakeCursor([None, ("asset-1",), ("queue-1",)])
        gateway = make_gateway(cursor)

        gateway._finalize(
            {"p_uploads": [{"storage_path": "user-1/photo.jpg"}], "p_context": "   "}
        )

        _insert_sql, insert_params = cursor.queries[1]
        self.assertIsNone(insert_params[-2])

    def test_sha256_and_source_ref_are_persisted_on_the_standard_lane(self):
        cursor = FakeCursor([None, ("asset-1",), ("queue-1",)])
        gateway = make_gateway(cursor)

        gateway._finalize(
            {
                "p_uploads": [
                    {"storage_path": "user-1/photo.jpg", "sha256": "AB" * 32, "source_ref": " zalo:marketing:9 "}
                ],
                "p_context": "Zalo Marketing 2026-10-28",
            }
        )

        insert_sql, insert_params = cursor.queries[1]
        self.assertIn("content_hash", insert_sql)
        self.assertIn("source_ref", insert_sql)
        self.assertIn("ab" * 32, insert_params)
        self.assertIn("zalo:marketing:9", insert_params)
        self.assertEqual(insert_params[-2], "Zalo Marketing 2026-10-28")

    def test_missing_sha256_and_source_ref_persist_none(self):
        cursor = FakeCursor([None, ("asset-1",), ("queue-1",)])
        gateway = make_gateway(cursor)

        gateway._finalize({"p_uploads": [{"storage_path": "user-1/photo.jpg"}]})

        _insert_sql, insert_params = cursor.queries[1]
        self.assertEqual(insert_params[7:9], (None, None))

    def test_existing_asset_by_storage_path_is_not_reinserted(self):
        # Matches the web upload path's behaviour: batch_context is only ever
        # set at asset creation, never patched onto an asset that already
        # exists for that storage_path.
        cursor = FakeCursor([("existing-asset",), ("queue-1",)])
        gateway = make_gateway(cursor)

        result = gateway._finalize(
            {
                "p_uploads": [{"storage_path": "user-1/photo.jpg"}],
                "p_context": "Cả lô là ảnh showroom",
            }
        )

        self.assertEqual(result[0]["media_asset_id"], "existing-asset")
        insert_queries = [sql for sql, _ in cursor.queries if "insert into public.media_assets" in sql]
        self.assertEqual(insert_queries, [])

    def test_standard_numeric_filename_gets_pending_review_label(self):
        cursor = FakeCursor([None, ("asset-1",), ("queue-1",)])
        gateway = make_gateway(cursor)

        gateway._finalize({"p_uploads": [{"storage_path": "user-1/16.jpg", "file_name": "16.jpg"}]})

        _insert_sql, insert_params = cursor.queries[1]
        self.assertEqual(insert_params[0], "Ảnh chờ duyệt")

    def test_existing_curated_asset_does_not_overwrite_title_with_numeric_filename(self):
        cursor = FakeCursor([("existing-asset",)])
        gateway = make_gateway(cursor)

        gateway._finalize({
            "p_uploads": [{
                "is_curated_import": True,
                "storage_path": "user-1/16.jpg",
                "file_name": "16.jpg",
                "update_existing_metadata": True,
            }]
        })

        _update_sql, update_params = cursor.queries[1]
        self.assertIsNone(update_params[0])


class ResolveActorTests(unittest.TestCase):
    def test_approval_sets_human_actor_for_native_trigger(self):
        cursor = FakeCursor([("asset-1", {}, {"title": "Existing asset"}), ({},)])
        gateway = make_gateway(cursor)

        gateway._resolve({"p_review_queue_id": "queue-1", "p_decision": "approved", "p_patch": {}})

        actor_calls = [(sql, params) for sql, params in cursor.queries if "set_config" in sql]
        self.assertEqual(actor_calls[0][1], ("human",))
        self.assertEqual(actor_calls[1][1], ("user-1",))

    def test_rejection_explicitly_sets_machine_actor(self):
        cursor = FakeCursor([("asset-1", {}, {})])
        gateway = make_gateway(cursor)

        gateway._resolve({"p_review_queue_id": "queue-1", "p_decision": "rejected", "p_patch": {}})

        actor_calls = [(sql, params) for sql, params in cursor.queries if "set_config" in sql]
        self.assertEqual(actor_calls[0][1], ("machine",))
        self.assertEqual(actor_calls[1][1], ("user-1",))

    def test_approval_rejects_numeric_title(self):
        cursor = FakeCursor([("asset-1", {}, {"title": "16"})])
        gateway = make_gateway(cursor)

        with self.assertRaises(GatewayError) as caught:
            gateway._resolve({"p_review_queue_id": "queue-1", "p_decision": "approved", "p_patch": {}})

        self.assertIn("human-readable title", str(caught.exception))


class CuratedFinalizeTests(unittest.TestCase):
    def test_curated_import_approved_bypass_and_768d_gate(self):
        # 1. source_file_id lookup returns None
        # 2. storage_path lookup returns None
        # 3. insert into media_assets returns asset-curated-1
        # 4. verity_products lookup returns prod-1
        cursor = FakeCursor([None, None, ("asset-curated-1",), ("prod-1",)])
        gateway = make_gateway(cursor)

        payload = {
            "p_uploads": [
                {
                    "is_curated_import": True,
                    "storage_path": "user-1/gdrive/photo.webp",
                    "file_name": "photo.webp",
                    "source_provider": "google_drive",
                    "source_file_id": "gdrive-file-123",
                    "sku": "Verity C02",
                    "brand": "Verity",
                    "category": "Khóa thông minh",
                    "space": "Cửa chính",
                    "embedding": {
                        "space_id": "verity-siglip2-b32-256-webli-v1",
                        "vector": [0.01] * 768,
                    },
                    "sha256": "abcdef123456",
                    "is_duplicate": False,
                    "approved_by_policy": True,
                }
            ],
            "p_context": "Khóa cổng Verity C02",
        }
        result = gateway._finalize(payload)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["media_asset_id"], "asset-curated-1")
        self.assertEqual(result[0]["review_state"], "approved")
        self.assertIsNone(result[0]["review_queue_id"])

        # Check queries:
        queries = [sql for sql, _ in cursor.queries]
        # Should have inserted into media_assets with ingest_status='ready'
        insert_calls = [q for q in cursor.queries if "insert into public.media_assets" in q[0]]
        self.assertEqual(len(insert_calls), 1)
        insert_sql, insert_params = insert_calls[0]
        self.assertIn("ingest_status, ingested_at, canonical_slug", insert_sql)
        self.assertIn("description", insert_sql)
        self.assertIn("'ready', now()", insert_sql)
        # title should be clean composed title: "Verity C02 - Cửa chính"
        self.assertEqual(insert_params[0], "Verity C02 - Cửa chính")
        # canonical_slug should be present
        self.assertEqual(insert_params[-1], "verity-c02-cua-chinh")

        # Should have inserted into asset_embeddings
        self.assertTrue(any("insert into public.asset_embeddings" in q for q in queries))
        # Should have inserted into media_asset_products (confirmed)
        self.assertTrue(any("insert into public.media_asset_products" in q for q in queries))
        # Should NOT have inserted into review_queue
        self.assertFalse(any("insert into public.review_queue" in q for q in queries))
        # Should NOT have inserted into media_ingest_jobs (DB trigger handles canonical publication!)
        self.assertFalse(any("insert into public.media_ingest_jobs" in q for q in queries))

    def test_curated_import_preserves_explicit_clean_title(self):
        cursor = FakeCursor([None, None, ("asset-curated-2",), ("prod-2",)])
        gateway = make_gateway(cursor)
        payload = {
            "p_uploads": [
                {
                    "is_curated_import": True,
                    "storage_path": "user-1/gdrive/photo.webp",
                    "file_name": "photo.webp",
                    "title": "Verity C02 - Khóa Cổng Biệt Thự Hiện Đại",
                    "source_provider": "google_drive",
                    "source_file_id": "gdrive-file-456",
                    "sku": "Verity C02",
                    "brand": "Verity",
                    "category": "Khóa thông minh",
                    "space": "Cửa chính",
                    "embedding": {
                        "space_id": "verity-siglip2-b32-256-webli-v1",
                        "vector": [0.01] * 768,
                    },
                    "approved_by_policy": True,
                }
            ],
        }
        res = gateway._finalize(payload)
        self.assertEqual(res[0]["media_asset_id"], "asset-curated-2")
        insert_calls = [q for q in cursor.queries if "insert into public.media_assets" in q[0]]
        _, insert_params = insert_calls[0]
        self.assertEqual(insert_params[0], "Verity C02 - Khóa Cổng Biệt Thự Hiện Đại")

    def test_curated_import_rejects_1152_dim_hard_gate(self):
        from verity_dam_mcp.gateway import GatewayError
        cursor = FakeCursor([None, None])
        gateway = make_gateway(cursor)

        payload = {
            "p_uploads": [
                {
                    "is_curated_import": True,
                    "storage_path": "user-1/gdrive/photo.webp",
                    "source_provider": "google_drive",
                    "source_file_id": "gdrive-file-123",
                    "embedding": {
                        "space_id": "verity-siglip2-b32-256-webli-v1",
                        "vector": [0.01] * 1152,  # WRONG DIMENSION
                    },
                }
            ]
        }
        with self.assertRaises(GatewayError) as ctx:
            gateway._finalize(payload)
        self.assertIn("[HARD GATE] Embedding dimension 1152 != 768 rejected", str(ctx.exception))

    def test_curated_import_server_side_dedup_routes_to_review_queue(self):
        cursor = FakeCursor([
            None,  # source_file_id
            None,  # storage_path
            [("existing-dup-asset-1", 0.96)],  # dedup similarity query via fetchall()
            ("asset-curated-dup",),  # insert media_assets
            ("prod-1",),  # sku product lookup
            ("queue-dup-1",),  # review_queue returning id
        ])
        gateway = make_gateway(cursor)
        payload = {
            "p_uploads": [
                {
                    "is_curated_import": True,
                    "storage_path": "user-1/gdrive/photo.webp",
                    "file_name": "photo.webp",
                    "source_provider": "google_drive",
                    "source_file_id": "gdrive-file-789",
                    "sku": "Verity C02",
                    "embedding": {
                        "space_id": "verity-siglip2-b32-256-webli-v1",
                        "vector": [0.01] * 768,
                    },
                }
            ]
        }
        res = gateway._finalize(payload)
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["media_asset_id"], "asset-curated-dup")
        self.assertTrue(res[0]["is_duplicate"])
        self.assertEqual(res[0]["review_state"], "pending")
        self.assertEqual(res[0]["duplicate_asset_ids"], ["existing-dup-asset-1"])
        queries = [sql for sql, _ in cursor.queries]
        self.assertTrue(any("insert into public.review_queue" in q for q in queries))


class FindAssetByContentHashTests(unittest.TestCase):
    def _gateway(self, role: str):
        from unittest.mock import MagicMock

        gateway = MediaMcpGateway.__new__(MediaMcpGateway)
        gateway._user_id = "user-1"
        gateway._role = role
        gateway.repository = MagicMock()
        return gateway

    def test_viewer_cannot_probe_for_existing_hashes(self):
        gateway = self._gateway("viewer")
        with self.assertRaises(GatewayError):
            gateway.find_asset_by_content_hash("a" * 64)
        gateway.repository.fetch_one.assert_not_called()

    def test_lookup_is_lowercased_and_ignores_soft_deleted_assets(self):
        gateway = self._gateway("contributor")
        gateway.repository.fetch_one.return_value = {"id": "asset-1"}

        found = gateway.find_asset_by_content_hash("AB" * 32)

        self.assertEqual(found, {"id": "asset-1"})
        sql, params = gateway.repository.fetch_one.call_args[0]
        self.assertIn("a.deleted_at is null", sql)
        self.assertEqual(params, ("ab" * 32,))


if __name__ == "__main__":
    unittest.main()
