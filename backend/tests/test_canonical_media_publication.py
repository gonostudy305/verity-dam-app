"""Unit and contract tests for the Canonical Media Publication Pipeline (Image SEO V2).

Tests compliance with Acceptance Gates:
- G0: Migration Governance Unfreeze
- G1: Format Integrity (WebP magic bytes & MIME)
- G2 & G3: Target Widths & No-Upscale
- G4: Rights Metadata in XMP & EXIF
- G5: AI Disclosure Propagation Compliance
- G6: Privacy Allowlist (GPS/Serial Stripping)
- G9: Immutable Fingerprinting & Cache Safety
- P0-5: Largest Rendition as Legacy cdn_url Fallback
- T1-T4: Fingerprint Sensitivity (Determinism, Source, Metadata, Pipeline Mutations)
- T5-T6: Idempotent Retry & Partial-Failure Safety (E3)
"""

from __future__ import annotations

from io import BytesIO
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image

from app.image_processing import (
    CANONICAL_TARGET_WIDTHS,
    DEFAULT_AI_SOURCE_TYPE,
    build_canonical_metadata_packages,
    build_public_image_slug,
    build_rendition_fingerprint,
    generate_canonical_renditions,
    target_widths,
)
from app.production_config import WorkerSettings
from app.worker import MediaWorker


def _make_worker_settings() -> WorkerSettings:
    return WorkerSettings(
        worker_id="test",
        poll_seconds=3,
        scene_duplicate_threshold=0.92,
        phash_max_distance=12,
        embedding_profile="production_api",
        embedding_provider="jina_9router",
        embedding_base_url="https://api.example.com/v1",
        embedding_api_key="router_test_key",
        embedding_model="jina-ai/jina-clip-v2",
        embedding_version="jina-clip-v2-v1",
        embedding_dimension=512,
        embedding_input_mode="bytes",
        vision_base_url=None,
        vision_api_key=None,
        vision_model=None,
        vision_detail="high",
        vision_max_tokens=900,
        vision_system_prompt="",
        r2_endpoint="https://fake-r2.cloudflarestorage.com",
        r2_access_key_id="fake-key",
        r2_secret_access_key="fake-secret",
        r2_bucket="fake-bucket",
        r2_region="auto",
        r2_public_base_url="https://assets.verity.internal",
        database_url="postgresql://verity:password@postgres/verity_media",
    )


def _make_test_image(width: int, height: int, color: tuple[int, int, int] = (255, 0, 0)) -> bytes:
    img = Image.new("RGB", (width, height), color=color)
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


class CanonicalMediaPublicationTests(unittest.TestCase):
    def test_g2_g3_canonical_target_widths(self):
        # Invariants:
        # - if < 480: [original]
        # - subsets of (480, 800, 1600) strictly smaller than original
        # - appends original if <= 1600, else 1600
        self.assertEqual(target_widths(320), [320])
        self.assertEqual(target_widths(480), [480])
        self.assertEqual(target_widths(600), [480, 600])
        self.assertEqual(target_widths(800), [480, 800])
        self.assertEqual(target_widths(1200), [480, 800, 1200])
        self.assertEqual(target_widths(1600), [480, 800, 1600])
        self.assertEqual(target_widths(2400), [480, 800, 1600])

    def test_slug_generation_and_normalization(self):
        asset = {
            "brand": "EDEN",
            "sku": "DEMO-007",
            "title": "Khóa Cửa Thông Minh Nhận Diện Khuôn Mặt 3D",
        }
        slug = build_public_image_slug(asset)
        self.assertEqual(slug, "eden-demo-007-khoa-cua-thong-minh-nhan-dien-khuon-mat-3d")

        # Fallback when SKU and brand are missing
        fallback_slug = build_public_image_slug({"id": "12345678-abcd-ef00-1122-334455667788"})
        self.assertEqual(fallback_slug, "12345678")

    def test_python_slug_matches_shared_typescript_parity_fixtures(self):
        fixture_path = Path(__file__).resolve().parents[2] / "shared" / "canonical-media-slug-fixtures.json"
        for fixture in json.loads(fixture_path.read_text(encoding="utf-8")):
            self.assertEqual(build_public_image_slug(fixture["input"]), fixture["slug"])

    def test_g1_g4_g5_g6_generate_canonical_renditions(self):
        source = _make_test_image(1200, 800)
        metadata = {
            "title": "Camera Eden",
            "suggested_caption": "Camera giám sát gia đình độ nét cao",
            "author": "VerityDAM Platform",
            "credit": "VerityDAM Platform",
            "copyright": "© 2026 VerityDAM Platform. All rights reserved.",
            "is_ai": True,
            "keywords": ["camera", "giám sát", "eden"],
        }
        renditions = generate_canonical_renditions(source, metadata)

        # G2 & G3: source 1200 produces widths [480, 800, 1200]
        self.assertEqual([r.width for r in renditions], [480, 800, 1200])
        # Check proportional height
        self.assertEqual([r.height for r in renditions], [320, 533, 800])

        for r in renditions:
            # G1: Format is strictly webp and has valid RIFF/WEBP magic bytes
            self.assertEqual(r.format, "webp")
            self.assertEqual(r.mime_type, "image/webp")
            self.assertTrue(r.payload.startswith(b"RIFF"))
            self.assertIn(b"WEBP", r.payload[:16])
            self.assertEqual(len(r.payload), r.size_bytes)

            # Read back image and verify metadata
            parsed = Image.open(BytesIO(r.payload))
            self.assertEqual(parsed.format, "WEBP")
            self.assertEqual(parsed.size, (r.width, r.height))

            # G4: EXIF compatibility mirror (Option B: ASCII safe + Windows XP UTF-16LE)
            exif = parsed.getexif()
            self.assertEqual(exif.get(0x013B), "VerityDAM Platform")  # Artist
            self.assertEqual(exif.get(0x8298), "(c) 2026 VerityDAM Platform. All rights reserved.")  # Copyright
            self.assertEqual(exif.get(0x010E), "Camera giam sat gia dinh do net cao")  # ImageDescription (ASCII safe)
            self.assertEqual(bytes(exif.get(0x9C9B)).decode("utf-16le"), "Camera Eden")  # XPTitle
            self.assertEqual(bytes(exif.get(0x9C9C)).decode("utf-16le"), "Camera giám sát gia đình độ nét cao")  # XPComment
            self.assertEqual(bytes(exif.get(0x9C9E)).decode("utf-16le"), "camera;giám sát;eden")  # XPKeywords

            # G6: Privacy - GPS info (0x8825) must NOT exist
            self.assertNotIn(0x8825, exif)

            # G5: XMP parsing for rights, title, keywords & AI disclosure
            xmp_bytes = parsed.info.get("xmp") or b""
            self.assertGreater(len(xmp_bytes), 0)
            root = ET.fromstring(xmp_bytes)
            ns = {
                "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
                "dc": "http://purl.org/dc/elements/1.1/",
                "photoshop": "http://ns.adobe.com/photoshop/1.0/",
                "Iptc4xmpExt": "http://iptc.org/std/Iptc4xmpExt/2008-02-29/",
            }
            title_elem = root.find(".//dc:title/rdf:Alt/rdf:li", ns)
            self.assertIsNotNone(title_elem)
            self.assertEqual(title_elem.text, "Camera Eden")

            desc_elem = root.find(".//dc:description/rdf:Alt/rdf:li", ns)
            self.assertIsNotNone(desc_elem)
            self.assertEqual(desc_elem.text, "Camera giám sát gia đình độ nét cao")

            subject_elems = [e.text for e in root.findall(".//dc:subject/rdf:Bag/rdf:li", ns)]
            self.assertEqual(subject_elems, ["camera", "giám sát", "eden"])

            creator_elem = root.find(".//dc:creator/rdf:Seq/rdf:li", ns)
            self.assertIsNotNone(creator_elem)
            self.assertEqual(creator_elem.text, "VerityDAM Platform")

            credit_elem = root.find(".//photoshop:Credit", ns)
            self.assertIsNotNone(credit_elem)
            self.assertEqual(credit_elem.text, "VerityDAM Platform")

            dst_elem = root.find(".//Iptc4xmpExt:DigitalSourceType", ns)
            self.assertIsNotNone(dst_elem)
            self.assertEqual(dst_elem.text, DEFAULT_AI_SOURCE_TYPE)

    def test_g5_real_photo_defaults_to_digital_capture(self):
        source = _make_test_image(500, 500)
        metadata = {
            "title": "Khóa cửa SL108 thực tế",
            "is_ai": False,
        }
        renditions = generate_canonical_renditions(source, metadata)
        parsed = Image.open(BytesIO(renditions[0].payload))
        xmp_bytes = parsed.info.get("xmp") or b""
        root = ET.fromstring(xmp_bytes)
        ns = {
            "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
            "Iptc4xmpExt": "http://iptc.org/std/Iptc4xmpExt/2008-02-29/",
        }
        dst_elem = root.find(".//Iptc4xmpExt:DigitalSourceType", ns)
        self.assertIsNotNone(dst_elem)
        from app.image_processing import DEFAULT_REAL_SOURCE_TYPE
        self.assertEqual(dst_elem.text, DEFAULT_REAL_SOURCE_TYPE)

    def test_g5_preserves_existing_trusted_digital_source_type(self):
        source = _make_test_image(500, 500)
        custom_dst = "https://cv.iptc.org/newscodes/digitalsourcetype/compositeSynthetic"
        metadata = {
            "title": "Composite Image",
            "is_ai": True,
            "digital_source_type": custom_dst,
        }
        renditions = generate_canonical_renditions(source, metadata)
        parsed = Image.open(BytesIO(renditions[0].payload))
        root = ET.fromstring(parsed.info["xmp"])
        ns = {"Iptc4xmpExt": "http://iptc.org/std/Iptc4xmpExt/2008-02-29/"}
        dst_elem = root.find(".//Iptc4xmpExt:DigitalSourceType", ns)
        self.assertIsNotNone(dst_elem)
        self.assertEqual(dst_elem.text, custom_dst)

    def test_g6_license_url_embedded_in_xmp_rights_and_plus_licensor(self):
        source = _make_test_image(500, 500)
        metadata = {
            "title": "Photo with license",
            "license_url": "https://veritydam.example/chinh-sach-ban-quyen",
            "licensor_name": "VerityDAM Platform",
            "licensor_url": "https://veritydam.example",
            "acquire_license_page": "https://veritydam.example/lien-he",
        }
        renditions = generate_canonical_renditions(source, metadata)
        parsed = Image.open(BytesIO(renditions[0].payload))
        root = ET.fromstring(parsed.info["xmp"])
        ns = {
            "xmpRights": "http://ns.adobe.com/xap/1.0/rights/",
            "plus": "http://ns.useplus.org/ldf/xmp/1.0/",
            "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
        }
        web_statement = root.find(".//xmpRights:WebStatement", ns)
        self.assertIsNotNone(web_statement)
        self.assertEqual(web_statement.text, "https://veritydam.example/chinh-sach-ban-quyen")

        licensor_name = root.find(".//plus:Licensor/rdf:Seq/rdf:li/plus:LicensorName", ns)
        self.assertIsNotNone(licensor_name)
        self.assertEqual(licensor_name.text, "VerityDAM Platform")

        # Plus Licensor URL must follow Google spec: prefer acquire_license_page
        licensor_url = root.find(".//plus:Licensor/rdf:Seq/rdf:li/plus:LicensorURL", ns)
        self.assertIsNotNone(licensor_url)
        self.assertEqual(licensor_url.text, "https://veritydam.example/lien-he")

    def test_g6_brand_and_sku_auto_enrich_keywords(self):
        source = _make_test_image(500, 500)
        metadata = {
            "title": "Verity SL108 Smart Lock",
            "brand": "Verity",
            "sku": "SL108",
            "keywords": ["khóa cửa điện tử", "cửa nhôm"],
        }
        renditions = generate_canonical_renditions(source, metadata)
        parsed = Image.open(BytesIO(renditions[0].payload))
        root = ET.fromstring(parsed.info["xmp"])
        ns = {
            "dc": "http://purl.org/dc/elements/1.1/",
            "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
        }
        items = [elem.text for elem in root.findall(".//dc:subject/rdf:Bag/rdf:li", ns)]
        self.assertIn("Verity SL108", items)
        self.assertIn("SL108", items)
        self.assertIn("Verity", items)
        self.assertIn("khóa cửa điện tử", items)
        self.assertIn("cửa nhôm", items)

        # Check EXIF XPKeywords
        exif = parsed.getexif()
        xp_kw = exif[0x9C9E].decode("utf-16le").rstrip("\x00")
        self.assertIn("Verity SL108", xp_kw)
        self.assertIn("SL108", xp_kw)
        self.assertIn("Verity", xp_kw)

    def test_g6_brand_prefixed_sku_does_not_duplicate_its_brand_keyword(self):
        source = _make_test_image(500, 500)
        renditions = generate_canonical_renditions(source, {
            "title": "Drift robot vacuum",
            "brand": "Drift",
            "sku": "Drift RLX85CE-B",
        })
        parsed = Image.open(BytesIO(renditions[0].payload))
        root = ET.fromstring(parsed.info["xmp"])
        ns = {
            "dc": "http://purl.org/dc/elements/1.1/",
            "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
        }
        items = [elem.text for elem in root.findall(".//dc:subject/rdf:Bag/rdf:li", ns)]
        self.assertIn("Drift RLX85CE-B", items)
        self.assertIn("RLX85CE-B", items)
        self.assertIn("Drift", items)
        self.assertNotIn("Drift Drift RLX85CE-B", items)

    def test_g6_no_license_url_emits_no_webstatement(self):
        source = _make_test_image(500, 500)
        metadata = {
            "title": "Photo without license",
        }
        renditions = generate_canonical_renditions(source, metadata)
        parsed = Image.open(BytesIO(renditions[0].payload))
        root = ET.fromstring(parsed.info["xmp"])
        ns = {
            "xmpRights": "http://ns.adobe.com/xap/1.0/rights/",
            "plus": "http://ns.useplus.org/ldf/xmp/1.0/",
        }
        self.assertIsNone(root.find(".//xmpRights:WebStatement", ns))
        self.assertIsNone(root.find(".//plus:Licensor", ns))

    def test_g6_fingerprint_changes_on_licensing_and_keyword_mutation(self):
        source = _make_test_image(500, 500)
        base_meta = {"title": "Test Title", "license_url": "https://veritydam.example/chinh-sach-ban-quyen"}
        fp_base = build_rendition_fingerprint(source, base_meta)

        # Brand change triggers fingerprint mutation
        fp_brand = build_rendition_fingerprint(source, {**base_meta, "brand": "Verity"})
        self.assertNotEqual(fp_base, fp_brand)

        # SKU change triggers fingerprint mutation
        fp_sku = build_rendition_fingerprint(source, {**base_meta, "sku": "SL108"})
        self.assertNotEqual(fp_base, fp_sku)

        # Licensor URL change triggers fingerprint mutation
        fp_lic_url = build_rendition_fingerprint(source, {**base_meta, "licensor_url": "https://veritydam.example/lien-he"})
        self.assertNotEqual(fp_base, fp_lic_url)

        # Keywords change triggers fingerprint mutation
        fp_kw = build_rendition_fingerprint(source, {**base_meta, "keywords": ["khóa thông minh"]})
        self.assertNotEqual(fp_base, fp_kw)

    def test_t1_t2_t3_t4_fingerprint_sensitivity(self):
        source_a = _make_test_image(600, 400, color=(100, 100, 100))
        source_b = _make_test_image(600, 400, color=(200, 200, 200))
        meta_1 = {"title": "Title 1", "credit": "VerityDAM Platform"}
        meta_2 = {"title": "Title 2", "credit": "VerityDAM Platform"}

        # T1: Determinism
        fp1_a = build_rendition_fingerprint(source_a, meta_1)
        fp1_b = build_rendition_fingerprint(source_a, meta_1)
        self.assertEqual(fp1_a, fp1_b)
        self.assertEqual(len(fp1_a), 16)  # 64-bit

        # T2: Source byte mutation
        fp_source_b = build_rendition_fingerprint(source_b, meta_1)
        self.assertNotEqual(fp1_a, fp_source_b)

        # T3: Metadata mutation
        fp_meta_2 = build_rendition_fingerprint(source_a, meta_2)
        self.assertNotEqual(fp1_a, fp_meta_2)

        # T4: Pipeline version / quality mutation
        fp_pipeline = build_rendition_fingerprint(source_a, meta_1, pipeline_version="v3")
        self.assertNotEqual(fp1_a, fp_pipeline)
        fp_quality = build_rendition_fingerprint(source_a, meta_1, webp_quality=80)
        self.assertNotEqual(fp1_a, fp_quality)

        # T5: Author mutation
        meta_author = {"title": "Same Title", "author": "Custom Photographer"}
        fp_author = build_rendition_fingerprint(source_a, meta_author)
        self.assertNotEqual(fp1_a, fp_author)

    def test_p0_5_largest_rendition_fallback_and_two_phase_protocol(self):
        settings = _make_worker_settings()
        worker = MediaWorker(settings, gateway=MagicMock())
        worker.gateway = MagicMock()
        worker.gateway.get_media_asset.return_value = {
            "id": "11111111-2222-3333-4444-555555555555",
            "media_type": "photo",
            "storage_path": "user-1/sample.jpg",
            "title": "Camera Test",
            "brand": "Acme",
            "sku": "G3",
        }
        # 2000px source -> widths: 480, 800, 1600
        worker.gateway.download_object.return_value = _make_test_image(2000, 1000)

        mock_rpc_calls: list[tuple[str, dict]] = []
        worker.gateway.rpc.side_effect = lambda name, payload: mock_rpc_calls.append((name, payload))

        # Mock publisher
        with unittest.mock.patch("app.worker.R2Publisher") as mock_pub_cls:
            mock_inst = MagicMock()
            mock_inst.publish_immutable.side_effect = lambda key, payload, mime, **kwargs: f"https://assets.verity.internal/{key}"
            mock_pub_cls.return_value = mock_inst

            worker._publish_wordpress({"id": "job-1", "media_asset_id": "11111111-2222-3333-4444-555555555555"})

        pub_calls = [payload for name, payload in mock_rpc_calls if name == "complete_wordpress_publish"]
        self.assertEqual(len(pub_calls), 1)
        payload = pub_calls[0]

        renditions = payload["p_renditions"]
        self.assertEqual(len(renditions), 3)
        self.assertEqual([r["width"] for r in renditions], [480, 800, 1600])

        # The legacy pointer targets the largest immutable canonical rendition.
        self.assertEqual(payload["p_width"], 1600)
        self.assertEqual(payload["p_height"], 800)
        self.assertEqual(payload["p_mime_type"], "image/webp")
        self.assertTrue(payload["p_cdn_key"].endswith("-1600x800.webp"))
        self.assertTrue(payload["p_cdn_key"].startswith("wp-content/uploads/"))
        self.assertEqual(payload["p_cdn_url"], f"https://assets.verity.internal/{payload['p_cdn_key']}")

    def test_t6_e3_partial_r2_failure_prevents_db_commit(self):
        settings = _make_worker_settings()
        worker = MediaWorker(settings, gateway=MagicMock())
        worker.gateway = MagicMock()
        worker.gateway.get_media_asset.return_value = {
            "id": "22222222-3333-4444-5555-666666666666",
            "media_type": "photo",
            "storage_path": "user-1/photo.jpg",
            "title": "Broken Upload Test",
        }
        worker.gateway.download_object.return_value = _make_test_image(1000, 1000)

        # Mock publisher to fail on the second rendition upload
        call_count = 0
        def failing_publish_immutable(key, payload, mime, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                raise RuntimeError("Simulated R2 network drop on second variant")
            return f"https://assets.verity.internal/{key}"

        with unittest.mock.patch("app.worker.R2Publisher") as mock_pub_cls:
            mock_inst = MagicMock()
            mock_inst.publish_immutable.side_effect = failing_publish_immutable
            mock_pub_cls.return_value = mock_inst

            # Execution must raise error
            with self.assertRaisesRegex(RuntimeError, "Simulated R2 network drop"):
                worker._publish_wordpress({"id": "job-fail-1", "media_asset_id": "22222222-3333-4444-5555-666666666666"})

            # E3: Database complete_wordpress_publish must NEVER have been called
            worker.gateway.rpc.assert_not_called()

    def test_universal_job_publishes_wordpress_compatible_canonical_key_without_public_label(self):
        settings = _make_worker_settings()
        worker = MediaWorker(settings, gateway=MagicMock())
        worker.gateway = MagicMock()
        worker.gateway.get_media_asset.return_value = {
            "id": "292579ed-3717-4581-96f2-9c3c6cd3cd3d",
            "media_type": "photo",
            "storage_path": "owner/gdrive/c02/source.webp",
            "title": "z7684347947726_8e215e16eb2296ee273030c1fb5e8db4.webp",
            "brand": "Verity",
            "sku": "Verity C02",
            "space": "Cửa chính",
            "created_at": "2026-08-01T10:00:00+00:00",
            "canonical_version": 2,
            "permission": "internal",
            "review_state": "pending",
        }
        worker.gateway.download_object.return_value = _make_test_image(768, 768)
        calls: list[tuple[str, dict]] = []
        worker.gateway.rpc.side_effect = lambda name, payload: calls.append((name, payload))
        with unittest.mock.patch("app.worker.R2Publisher") as publisher_type:
            publisher = MagicMock()
            publisher.publish_immutable.side_effect = lambda key, payload, mime, **kwargs: f"https://assets.verity.internal/{key}"
            publisher_type.return_value = publisher
            worker._publish_canonical_media({
                "id": "job-2", "media_asset_id": "292579ed-3717-4581-96f2-9c3c6cd3cd3d", "payload": {"canonical_version": 2},
            })

        name, payload = calls[0]
        self.assertEqual(name, "complete_canonical_media_publish")
        self.assertEqual(payload["p_canonical_slug"], "verity-c02-cua-chinh")
        self.assertTrue(payload["p_cdn_key"].startswith("wp-content/uploads/2026/08/verity-c02-cua-chinh-"))
        self.assertTrue(payload["p_cdn_key"].endswith("-768x768.webp"))


class CanonicalPublicationSetLifecycleTest(unittest.TestCase):
    def _make_gateway_and_cursor(self, media_type="photo", review_state="approved", permission="public"):
        from app.native_gateway import NativeGateway, GatewayError

        cursor = MagicMock()
        # Row returned by select for update includes canonical_version.
        cursor.fetchone.return_value = (
            "asset-123",
            "Robot Vacuum",
            "A smart robot cleaner",
            review_state,
            permission,
            media_type,
            1,
        )

        class MockRepo:
            def transaction(self):
                class Ctx:
                    def __enter__(self):
                        return cursor
                    def __exit__(self, exc_type, exc_val, exc_tb):
                        pass
                return Ctx()

        settings = _make_worker_settings()
        gateway = NativeGateway(settings, repository=MockRepo(), storage=MagicMock())
        return gateway, cursor

    def test_complete_wordpress_publish_deletes_current_set_before_insert(self):
        gateway, cursor = self._make_gateway_and_cursor()

        payload = {
            "p_job_id": "00000000-0000-0000-0000-000000000001",
            "p_cdn_key": "public/v2/asset-123/fp1/slug-800w.webp",
            "p_cdn_url": "https://assets.verity.internal/public/v2/asset-123/fp1/slug-800w.webp",
            "p_width": 800,
            "p_height": 600,
            "p_mime_type": "image/webp",
            "p_renditions": [
                {
                    "purpose": "web-responsive",
                    "format": "webp",
                    "width": 480,
                    "height": 360,
                    "size_bytes": 24000,
                    "cdn_key": "public/v2/asset-123/fp1/slug-480w.webp",
                    "cdn_url": "https://assets.verity.internal/public/v2/asset-123/fp1/slug-480w.webp",
                    "mime_type": "image/webp",
                    "rendition_fingerprint": "fp1",
                    "metadata_version": 1,
                },
                {
                    "purpose": "web-responsive",
                    "format": "webp",
                    "width": 800,
                    "height": 600,
                    "size_bytes": 50000,
                    "cdn_key": "public/v2/asset-123/fp1/slug-800w.webp",
                    "cdn_url": "https://assets.verity.internal/public/v2/asset-123/fp1/slug-800w.webp",
                    "mime_type": "image/webp",
                    "rendition_fingerprint": "fp1",
                    "metadata_version": 1,
                },
            ],
        }

        gateway.rpc("complete_wordpress_publish", payload)

        # Trace execute SQL statements
        executed_sqls = [call[0][0].strip().lower() for call in cursor.execute.call_args_list]

        # Verify that DELETE occurs before INSERT
        delete_indices = [i for i, sql in enumerate(executed_sqls) if sql.startswith("delete from public.media_renditions")]
        insert_indices = [i for i, sql in enumerate(executed_sqls) if sql.startswith("insert into public.media_renditions")]

        self.assertEqual(len(delete_indices), 1, "Expected 1 delete statement for (purpose, format) pair")
        self.assertEqual(len(insert_indices), 2, "Expected 2 insert statements for 2 incoming renditions")
        self.assertLess(delete_indices[0], insert_indices[0], "DELETE must precede INSERT in completion transaction")

    def test_complete_wordpress_publish_fails_closed_on_empty_renditions_for_photo(self):
        from app.native_gateway import GatewayError
        gateway, cursor = self._make_gateway_and_cursor(media_type="photo")

        payload = {
            "p_job_id": "00000000-0000-0000-0000-000000000001",
            "p_cdn_key": "some-key",
            "p_cdn_url": "https://assets.verity.internal/some-key",
            "p_renditions": [],
        }

        with self.assertRaisesRegex(GatewayError, "Photo publication requires non-empty renditions"):
            gateway.rpc("complete_wordpress_publish", payload)

    def test_complete_wordpress_publish_rejects_duplicate_width_within_pair(self):
        from app.native_gateway import GatewayError
        gateway, cursor = self._make_gateway_and_cursor(media_type="photo")

        payload = {
            "p_job_id": "00000000-0000-0000-0000-000000000001",
            "p_cdn_key": "some-key",
            "p_cdn_url": "https://assets.verity.internal/some-key",
            "p_renditions": [
                {
                    "purpose": "web-responsive",
                    "format": "webp",
                    "width": 800,
                    "height": 600,
                    "size_bytes": 50000,
                    "cdn_key": "k1",
                    "cdn_url": "u1",
                    "mime_type": "image/webp",
                    "rendition_fingerprint": "fp1",
                },
                {
                    "purpose": "web-responsive",
                    "format": "webp",
                    "width": 800,
                    "height": 600,
                    "size_bytes": 50000,
                    "cdn_key": "k2",
                    "cdn_url": "u2",
                    "mime_type": "image/webp",
                    "rendition_fingerprint": "fp1",
                },
            ],
        }

        with self.assertRaisesRegex(GatewayError, "Duplicate rendition width 800"):
            gateway.rpc("complete_wordpress_publish", payload)

    def test_complete_wordpress_publish_rejects_fingerprint_mismatch_within_pair(self):
        from app.native_gateway import GatewayError
        gateway, cursor = self._make_gateway_and_cursor(media_type="photo")

        payload = {
            "p_job_id": "00000000-0000-0000-0000-000000000001",
            "p_cdn_key": "some-key",
            "p_cdn_url": "https://assets.verity.internal/some-key",
            "p_renditions": [
                {
                    "purpose": "web-responsive",
                    "format": "webp",
                    "width": 480,
                    "height": 360,
                    "size_bytes": 24000,
                    "cdn_key": "k1",
                    "cdn_url": "u1",
                    "mime_type": "image/webp",
                    "rendition_fingerprint": "fp_alpha",
                },
                {
                    "purpose": "web-responsive",
                    "format": "webp",
                    "width": 800,
                    "height": 600,
                    "size_bytes": 50000,
                    "cdn_key": "k2",
                    "cdn_url": "u2",
                    "mime_type": "image/webp",
                    "rendition_fingerprint": "fp_beta",
                },
            ],
        }

        with self.assertRaisesRegex(GatewayError, "Mismatched rendition fingerprint"):
            gateway.rpc("complete_wordpress_publish", payload)

    def test_complete_universal_publish_updates_canonical_pointer_without_wordpress_export(self):
        gateway, cursor = self._make_gateway_and_cursor(review_state="pending", permission="internal")
        payload = {
            "p_job_id": "00000000-0000-0000-0000-000000000001",
            "p_canonical_version": 1,
            "p_canonical_slug": "verity-c02-cua-chinh",
            "p_cdn_key": "wp-content/uploads/2026/09/verity-c02-cua-chinh-fp1-800x600.webp",
            "p_cdn_url": "https://assets.verity.internal/wp-content/uploads/2026/09/verity-c02-cua-chinh-fp1-800x600.webp",
            "p_width": 800,
            "p_height": 600,
            "p_mime_type": "image/webp",
            "p_renditions": [{
                "purpose": "web-responsive", "format": "webp", "width": 800, "height": 600,
                "size_bytes": 50000, "cdn_key": "wp-content/uploads/2026/09/verity-c02-cua-chinh-fp1-800x600.webp",
                "cdn_url": "https://assets.verity.internal/wp-content/uploads/2026/09/verity-c02-cua-chinh-fp1-800x600.webp",
                "mime_type": "image/webp", "rendition_fingerprint": "fp1",
            }],
        }

        gateway.rpc("complete_canonical_media_publish", payload)
        statements = [call.args[0].lower() for call in cursor.execute.call_args_list]
        self.assertTrue(any("canonical_published_version" in statement for statement in statements))
        self.assertFalse(any("wordpress_media_exports" in statement for statement in statements))


class CanonicalPublisherImmutabilityAndIccTest(unittest.TestCase):
    def test_extract_safe_icc_profile_valid_and_invalid(self):
        from app.image_processing import extract_safe_icc_profile

        # Valid ICC: 128 bytes with 'acsp' at bytes 36..40
        valid_icc = bytearray(128)
        valid_icc[36:40] = b"acsp"
        extracted = extract_safe_icc_profile(bytes(valid_icc))
        self.assertEqual(extracted, bytes(valid_icc))

        # Invalid ICC: missing 'acsp'
        invalid_icc = bytearray(128)
        invalid_icc[36:40] = b"xxxx"
        self.assertIsNone(extract_safe_icc_profile(bytes(invalid_icc)))

        # Invalid ICC: too short (< 128 bytes)
        short_icc = b"short"
        self.assertIsNone(extract_safe_icc_profile(short_icc))

        # Invalid ICC: too large (> 128 KB)
        large_icc = bytearray(128 * 1024 + 1)
        large_icc[36:40] = b"acsp"
        self.assertIsNone(extract_safe_icc_profile(bytes(large_icc)))

    def test_fingerprint_changes_with_safe_icc_profile(self):
        from app.image_processing import build_rendition_fingerprint

        source = _make_test_image(800, 600)
        fp_plain = build_rendition_fingerprint(source, {"title": "Test"})

        # Embed safe ICC profile into image
        valid_icc = bytearray(128)
        valid_icc[36:40] = b"acsp"

        from PIL import Image
        from io import BytesIO
        with Image.open(BytesIO(source)) as img:
            out = BytesIO()
            img.save(out, format="JPEG", icc_profile=bytes(valid_icc))
            source_with_icc = out.getvalue()

        fp_icc = build_rendition_fingerprint(source_with_icc, {"title": "Test"})
        self.assertNotEqual(fp_plain, fp_icc, "Fingerprint must change when safe ICC profile is present")

    def test_publish_immutable_conditional_put_success(self):
        from app.r2_publisher import R2Publisher

        settings = _make_worker_settings()
        with unittest.mock.patch("boto3.client") as mock_boto:
            mock_s3 = MagicMock()
            mock_boto.return_value = mock_s3

            pub = R2Publisher(settings)
            payload = b"test-webp-data"
            url = pub.publish_immutable("public/v2/test.webp", payload, "image/webp", fingerprint="fp123")

            self.assertEqual(url, "https://assets.verity.internal/public/v2/test.webp")
            mock_s3.put_object.assert_called_once()
            call_kwargs = mock_s3.put_object.call_args[1]
            self.assertEqual(call_kwargs["IfNoneMatch"], "*")
            self.assertEqual(call_kwargs["Metadata"]["verity-fingerprint"], "fp123")
            self.assertEqual(call_kwargs["Metadata"]["verity-sha256"], hashlib.sha256(payload).hexdigest())

    def test_publish_immutable_idempotent_match_on_412(self):
        from app.r2_publisher import R2Publisher
        from botocore.exceptions import ClientError

        settings = _make_worker_settings()
        payload = b"test-webp-data"
        payload_sha256 = hashlib.sha256(payload).hexdigest()

        with unittest.mock.patch("boto3.client") as mock_boto:
            mock_s3 = MagicMock()
            mock_boto.return_value = mock_s3

            # Simulate 412 PreconditionFailed on put_object
            mock_s3.put_object.side_effect = ClientError(
                {"Error": {"Code": "PreconditionFailed", "Message": "At least one precondition failed"}},
                "PutObject",
            )
            # Simulate head_object returning matching verity-sha256
            mock_s3.head_object.return_value = {
                "Metadata": {"verity-sha256": payload_sha256, "verity-fingerprint": "fp123"}
            }

            pub = R2Publisher(settings)
            url = pub.publish_immutable("public/v2/test.webp", payload, "image/webp", fingerprint="fp123")

            self.assertEqual(url, "https://assets.verity.internal/public/v2/test.webp")

    def test_publish_immutable_conflict_on_412_with_different_hash(self):
        from app.r2_publisher import R2Publisher
        from botocore.exceptions import ClientError

        settings = _make_worker_settings()
        payload = b"test-webp-data-1"

        with unittest.mock.patch("boto3.client") as mock_boto:
            mock_s3 = MagicMock()
            mock_boto.return_value = mock_s3

            mock_s3.put_object.side_effect = ClientError(
                {"Error": {"Code": "PreconditionFailed"}},
                "PutObject",
            )
            mock_s3.head_object.return_value = {
                "Metadata": {"verity-sha256": "different_sha256_hash"}
            }

            pub = R2Publisher(settings)
            with self.assertRaisesRegex(RuntimeError, "Immutable key conflict"):
                pub.publish_immutable("public/v2/test.webp", payload, "image/webp")

    def test_publish_immutable_legacy_412_streams_and_computes_sha256(self):
        from app.r2_publisher import R2Publisher
        from botocore.exceptions import ClientError
        from io import BytesIO

        settings = _make_worker_settings()
        payload = b"legacy-test-webp-data"
        payload_sha256 = hashlib.sha256(payload).hexdigest()

        with unittest.mock.patch("boto3.client") as mock_boto:
            mock_s3 = MagicMock()
            mock_boto.return_value = mock_s3

            mock_s3.put_object.side_effect = ClientError(
                {"Error": {"Code": "PreconditionFailed"}},
                "PutObject",
            )
            # Legacy object without metadata
            mock_s3.head_object.return_value = {"Metadata": {}}
            mock_s3.get_object.return_value = {"Body": BytesIO(payload)}

            pub = R2Publisher(settings)
            url = pub.publish_immutable("public/v2/test.webp", payload, "image/webp")

            self.assertEqual(url, "https://assets.verity.internal/public/v2/test.webp")
            mock_s3.get_object.assert_called_once()

    def test_publish_immutable_conflict_on_same_size_different_bytes(self):
        """P0 regression test: same size must NOT be assumed idempotent if bytes differ."""
        from app.r2_publisher import R2Publisher
        from botocore.exceptions import ClientError
        from io import BytesIO

        settings = _make_worker_settings()
        payload_a = b"AAAABBBB"  # 8 bytes
        payload_b = b"CCCCDDDD"  # 8 bytes (identical length, completely different content)

        with unittest.mock.patch("boto3.client") as mock_boto:
            mock_s3 = MagicMock()
            mock_boto.return_value = mock_s3

            mock_s3.put_object.side_effect = ClientError(
                {"Error": {"Code": "PreconditionFailed"}},
                "PutObject",
            )
            mock_s3.head_object.return_value = {"Metadata": {}}
            mock_s3.get_object.return_value = {"Body": BytesIO(payload_b)}

            pub = R2Publisher(settings)
            with self.assertRaisesRegex(RuntimeError, "Immutable key conflict"):
                pub.publish_immutable("public/v2/test.webp", payload_a, "image/webp")

    def test_publish_immutable_final_409_settles_and_verifies_success(self):
        """P1: Final 409 attempt settles and checks existing object; succeeds if SHA-256 matches."""
        from app.r2_publisher import R2Publisher
        from botocore.exceptions import ClientError

        settings = _make_worker_settings()
        payload = b"concurrent-payload"
        payload_sha256 = hashlib.sha256(payload).hexdigest()

        with unittest.mock.patch("boto3.client") as mock_boto:
            mock_s3 = MagicMock()
            mock_boto.return_value = mock_s3

            # 409 on all put_object attempts
            mock_s3.put_object.side_effect = ClientError(
                {"Error": {"Code": "Conflict", "Message": "Conflict on upload"}},
                "PutObject",
            )
            mock_s3.head_object.return_value = {
                "Metadata": {"verity-sha256": payload_sha256}
            }

            pub = R2Publisher(settings)
            url = pub.publish_immutable("public/v2/test.webp", payload, "image/webp")
            self.assertEqual(url, "https://assets.verity.internal/public/v2/test.webp")
            self.assertEqual(mock_s3.put_object.call_count, 3)
            mock_s3.head_object.assert_called_once()

    def test_publish_immutable_final_409_settles_and_propagates_on_404(self):
        """P1: Final 409 attempt settles; if object still 404, propagates retryable ClientError."""
        from app.r2_publisher import R2Publisher
        from botocore.exceptions import ClientError

        settings = _make_worker_settings()
        payload = b"concurrent-payload"

        with unittest.mock.patch("boto3.client") as mock_boto:
            mock_s3 = MagicMock()
            mock_boto.return_value = mock_s3

            mock_s3.put_object.side_effect = ClientError(
                {"Error": {"Code": "Conflict"}},
                "PutObject",
            )
            mock_s3.head_object.side_effect = ClientError(
                {"Error": {"Code": "NotFound"}},
                "HeadObject",
            )

            pub = R2Publisher(settings)
            with self.assertRaises(ClientError):
                pub.publish_immutable("public/v2/test.webp", payload, "image/webp")

    def test_canonical_metadata_contract_fixture_matches_constants(self):
        """Governance/Contract: ensure public_metadata_contract.json is in lockstep with implementation constants."""
        import json
        fixture_path = Path(__file__).resolve().parent.parent.parent / "fixtures" / "public_metadata_contract.json"
        self.assertTrue(fixture_path.exists(), f"Fixture not found at {fixture_path}")
        with open(fixture_path, "r", encoding="utf-8") as f:
            contract = json.load(f)

        from app.image_processing import (
            CANONICAL_TARGET_WIDTHS,
            DEFAULT_AI_SOURCE_TYPE,
            DEFAULT_CREATOR,
            DEFAULT_CREDIT,
            DEFAULT_WEBP_METHOD,
            DEFAULT_WEBP_QUALITY,
            METADATA_SCHEMA_VERSION,
            PUBLICATION_PIPELINE_VERSION,
        )

        self.assertEqual(contract["pipeline_version"], PUBLICATION_PIPELINE_VERSION)
        self.assertEqual(contract["metadata_schema_version"], METADATA_SCHEMA_VERSION)
        self.assertEqual(contract["default_ai_source_type"], DEFAULT_AI_SOURCE_TYPE)
        self.assertEqual(contract["creator"], DEFAULT_CREATOR)
        self.assertEqual(contract["credit"], DEFAULT_CREDIT)
        self.assertEqual(list(contract["target_widths"]), list(CANONICAL_TARGET_WIDTHS))
        self.assertEqual(contract["webp_quality"], DEFAULT_WEBP_QUALITY)
        self.assertEqual(contract["webp_method"], DEFAULT_WEBP_METHOD)


if __name__ == "__main__":
    unittest.main()
