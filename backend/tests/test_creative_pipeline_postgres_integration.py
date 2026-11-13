"""Live PostgreSQL contract tests for migrations 0044-0049.

They are transaction-scoped and skip cleanly without DATABASE_URL. CI/staging
must run them against a PostgreSQL 16 database after applying native migrations.
"""

from __future__ import annotations

import os
import unittest
import uuid

import psycopg2
from dotenv import load_dotenv


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(ROOT, ".env"))


def database_url() -> str:
    value = os.environ.get("DATABASE_URL", "")
    if not value.startswith("postgres"):
        raise unittest.SkipTest("DATABASE_URL is required for creative PostgreSQL integration tests.")
    return value


class CreativePipelinePostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        try:
            connection = psycopg2.connect(database_url(), connect_timeout=10)
            with connection.cursor() as cursor:
                cursor.execute("""
                    select to_regprocedure('public.sync_creative_review_states()'),
                           to_regclass('public.creative_library_asset_eligibilities'),
                           to_regclass('public.verity_ai_creative_config'),
                           exists (
                             select 1
                               from information_schema.columns
                              where table_schema = 'public'
                                and table_name = 'ai_image_generations'
                                and column_name = 'retry_of_generation_id'
                           )
                """)
                available = cursor.fetchone()
            connection.close()
            if not all(available):
                raise unittest.SkipTest("Creative migrations 0044-0049 are not applied.")
        except unittest.SkipTest:
            raise
        except Exception as error:  # pragma: no cover - local environment variance
            raise unittest.SkipTest(f"Creative PostgreSQL integration database unavailable: {error}") from error

    def setUp(self) -> None:
        self.connection = psycopg2.connect(database_url(), connect_timeout=10)
        self.connection.autocommit = False
        self.ids = {name: str(uuid.uuid4()) for name in ("brand_profile", "brand_version", "channel_profile", "channel_version", "template", "template_version", "request", "slot_a", "slot_b", "generation_a", "generation_b", "asset_a", "asset_b", "output_a", "output_b", "synthetic")}
        sha = "a" * 64
        with self.connection.cursor() as cursor:
            cursor.execute("insert into public.creative_brand_profiles(id, slug, display_name) values (%s, %s, 'test')", (self.ids["brand_profile"], f"creative-test-{self.ids['brand_profile'][:8]}"))
            cursor.execute("insert into public.creative_brand_versions(id, brand_profile_id, version, config_hash) values (%s,%s,1,%s)", (self.ids["brand_version"], self.ids["brand_profile"], sha))
            cursor.execute("insert into public.creative_channel_profiles(id, slug, display_name) values (%s,%s,'test')", (self.ids["channel_profile"], f"creative-test-{self.ids['channel_profile'][:8]}"))
            cursor.execute("insert into public.creative_channel_versions(id, channel_profile_id, version, config_hash) values (%s,%s,1,%s)", (self.ids["channel_version"], self.ids["channel_profile"], sha))
            cursor.execute("insert into public.creative_templates(id, slug, display_name) values (%s,%s,'test')", (self.ids["template"], f"creative-test-{self.ids['template'][:8]}"))
            cursor.execute("insert into public.creative_template_versions(id, template_id, version, template_family, config_hash) values (%s,%s,1,'test',%s)", (self.ids["template_version"], self.ids["template"], sha))
            cursor.execute("""insert into public.creative_requests(id, brand_version_id, channel_version_id, external_source, external_article_id, external_revision, idempotency_key, payload_hash)
                              values (%s,%s,%s,'creative-integration',%s,'r1',%s,%s)""", (self.ids["request"], self.ids["brand_version"], self.ids["channel_version"], self.ids["request"], self.ids["request"], sha))
            for suffix in ("a", "b"):
                cursor.execute("insert into public.creative_slots(id, request_id, slot_key, slot_kind, template_version_id, selection_seed) values (%s,%s,%s,'section',%s,%s)", (self.ids[f"slot_{suffix}"], self.ids["request"], suffix, self.ids["template_version"], sha))
                cursor.execute("insert into public.ai_image_generations(id, slot_id, attempt_no, provider, model, prompt_hash, provider_call_state) values (%s,%s,1,'openai','gpt-image-2.5-flare-2026-09-08',%s,'succeeded')", (self.ids[f"generation_{suffix}"], self.ids[f"slot_{suffix}"], sha))
                cursor.execute("insert into public.media_assets(id, title, storage_path, review_state, ai_flags) values (%s,%s,%s,'pending','{\"is_ai\":true}')", (self.ids[f"asset_{suffix}"], f"creative {suffix}", f"creative-test/{self.ids[f'asset_{suffix}']}"))
                cursor.execute("""insert into public.ai_image_generation_outputs(id, generation_id, candidate_index, creative_state, review_state, temp_storage_key, temp_sha256, media_asset_id)
                                  values (%s,%s,0,'promoted','pending',%s,%s,%s)""", (self.ids[f"output_{suffix}"], self.ids[f"generation_{suffix}"], f"temp/{suffix}", sha, self.ids[f"asset_{suffix}"]))
                cursor.execute("insert into public.creative_slot_resolutions(slot_id, source_kind, media_asset_id, generation_output_id, status) values (%s,'ai',%s,%s,'proposed')", (self.ids[f"slot_{suffix}"], self.ids[f"asset_{suffix}"], self.ids[f"output_{suffix}"]))
            cursor.execute("insert into public.media_assets(id, title, review_state, ai_flags) values (%s,'synthetic','pending','{\"is_ai\":true}')", (self.ids["synthetic"],))

    def tearDown(self) -> None:
        self.connection.rollback()
        self.connection.close()

    def test_statement_review_sync_activates_each_proposal_once(self) -> None:
        with self.connection.cursor() as cursor:
            cursor.execute("update public.media_assets set review_state = 'approved' where id in (%s, %s)", (self.ids["asset_a"], self.ids["asset_b"]))
            cursor.execute("select status from public.creative_slot_resolutions where slot_id in (%s,%s) order by slot_id", (self.ids["slot_a"], self.ids["slot_b"]))
            self.assertEqual([row[0] for row in cursor.fetchall()], ["active", "active"])
            cursor.execute("select review_state from public.ai_image_generation_outputs where id in (%s,%s) order by id", (self.ids["output_a"], self.ids["output_b"]))
            self.assertEqual([row[0] for row in cursor.fetchall()], ["approved", "approved"])

    def test_direct_sql_cannot_promote_synthetic_asset_to_active_few_shot(self) -> None:
        with self.connection.cursor() as cursor:
            with self.assertRaises(psycopg2.Error) as raised:
                cursor.execute("insert into public.metadata_few_shot_examples(source_media_asset_id, accepted_metadata, is_active) values (%s, '{}'::jsonb, true)", (self.ids["synthetic"],))
            self.assertIn("SYNTHETIC_REFERENCE_FORBIDDEN", str(raised.exception))

    def test_terminal_generation_failure_recomputes_slot_and_request(self) -> None:
        with self.connection.cursor() as cursor:
            cursor.execute("update public.creative_slot_resolutions set status = 'dismissed' where slot_id in (%s, %s)", (self.ids["slot_a"], self.ids["slot_b"]))
            cursor.execute("update public.ai_image_generations set provider_call_state = 'failed' where id in (%s, %s)", (self.ids["generation_a"], self.ids["generation_b"]))
            cursor.execute("select public.recompute_creative_slots(array[%s::uuid, %s::uuid])", (self.ids["slot_a"], self.ids["slot_b"]))
            cursor.execute("select status from public.creative_slots where id in (%s, %s) order by id", (self.ids["slot_a"], self.ids["slot_b"]))
            self.assertEqual(cursor.fetchall(), [("failed",), ("failed",)])
            cursor.execute("select status from public.creative_requests where id = %s", (self.ids["request"],))
            self.assertEqual(cursor.fetchone(), ("failed",))

    def test_safe_retry_queue_keeps_slot_and_request_generating(self) -> None:
        with self.connection.cursor() as cursor:
            cursor.execute("update public.creative_slot_resolutions set status = 'dismissed' where slot_id in (%s, %s)", (self.ids["slot_a"], self.ids["slot_b"]))
            cursor.execute("update public.ai_image_generations set provider_call_state = 'queued' where id = %s", (self.ids["generation_a"],))
            cursor.execute("update public.ai_image_generations set provider_call_state = 'failed' where id = %s", (self.ids["generation_b"],))
            cursor.execute("select public.recompute_creative_slots(array[%s::uuid, %s::uuid])", (self.ids["slot_a"], self.ids["slot_b"]))
            cursor.execute("select status from public.creative_slots where id = %s", (self.ids["slot_a"],))
            self.assertEqual(cursor.fetchone(), ("generating",))
            cursor.execute("select status from public.creative_requests where id = %s", (self.ids["request"],))
            self.assertEqual(cursor.fetchone(), ("generating",))

    def test_failed_generation_has_at_most_one_manual_retry_child(self) -> None:
        with self.connection.cursor() as cursor:
            retry_a, retry_b = str(uuid.uuid4()), str(uuid.uuid4())
            cursor.execute(
                """insert into public.ai_image_generations
                   (id, slot_id, attempt_no, provider, model, prompt_hash, retry_of_generation_id)
                   values (%s,%s,2,'openai','gpt-image-2.5-flare-2026-09-08',%s,%s)""",
                (retry_a, self.ids["slot_a"], "a" * 64, self.ids["generation_a"]),
            )
            cursor.execute("savepoint duplicate_retry")
            with self.assertRaises(psycopg2.Error):
                cursor.execute(
                    """insert into public.ai_image_generations
                       (id, slot_id, attempt_no, provider, model, prompt_hash, retry_of_generation_id)
                       values (%s,%s,3,'openai','gpt-image-2.5-flare-2026-09-08',%s,%s)""",
                    (retry_b, self.ids["slot_a"], "a" * 64, self.ids["generation_a"]),
                )
            cursor.execute("rollback to savepoint duplicate_retry")

    def test_stale_promotion_saga_no_longer_blocks_candidate_expiry(self) -> None:
        """Match the worker's TTL recovery query after R2 copy/verify crashes."""
        saga_output = str(uuid.uuid4())
        with self.connection.cursor() as cursor:
            cursor.execute(
                """insert into public.ai_image_generation_outputs
                   (id, generation_id, candidate_index, creative_state, review_state,
                    temp_storage_key, temp_sha256, expires_at)
                   values (%s,%s,1,'candidate','not_submitted',%s,%s,now() - interval '1 second')""",
                (saga_output, self.ids["generation_a"], "temp/stale-saga", "a" * 64),
            )
            cursor.execute(
                """insert into public.creative_storage_sagas
                   (output_id, temp_storage_key, canonical_storage_key, expected_sha256, state)
                   values (%s,%s,%s,%s,'verified')""",
                (saga_output, "temp/stale-saga", "creative/stale-saga.webp", "a" * 64),
            )
            cursor.execute(
                """update public.creative_storage_sagas s
                       set state = 'failed', updated_at = now()
                      from public.ai_image_generation_outputs o
                     where o.id = s.output_id
                       and o.creative_state = 'candidate'
                       and o.expires_at <= now()
                       and s.state in ('pending_copy', 'copied', 'verified')"""
            )
            cursor.execute("select * from public.expire_creative_candidates()")
            self.assertEqual(cursor.fetchone()[0], saga_output)
            cursor.execute(
                "select creative_state from public.ai_image_generation_outputs where id = %s",
                (saga_output,),
            )
            self.assertEqual(cursor.fetchone(), ("expired",))


if __name__ == "__main__":
    unittest.main()
