from app.contracts import sanitize_vision_metadata
from app.vision_metadata import metadata_messages, normalize_taxonomy_metadata, taxonomy_hint


def test_vision_taxonomy_hint_uses_shared_labels_without_static_values():
    hint = taxonomy_hint(
        [
            {"facet": "category", "value": "install", "label": "Thi công"},
            {"facet": "space", "value": "kitchen", "label": "Bếp mở"},
            {"facet": "status", "value": "ready", "label": "Sẵn sàng"},
            {"facet": "brand", "value": "custom", "label": "Hãng mới"},
        ]
    )

    assert "Thi công" in hint
    assert "Bếp mở" in hint
    assert "Sẵn sàng" in hint
    assert "Công trình" not in hint
    assert "Phòng khách" not in hint


def test_vision_taxonomy_normalizes_editable_labels_to_stable_values():
    normalized = normalize_taxonomy_metadata(
        {"category": "Thi công", "space": "unknown", "status": "ready", "brand": "Hãng mới"},
        [
            {"facet": "category", "value": "install", "label": "Thi công"},
            {"facet": "space", "value": "kitchen", "label": "Bếp mở"},
            {"facet": "status", "value": "ready", "label": "Sẵn sàng"},
            {"facet": "brand", "value": "custom", "label": "Hãng mới"},
        ],
    )

    assert normalized == {"category": "install", "status": "ready", "brand": "custom"}


def test_vision_taxonomy_preserves_confident_brand_outside_current_admin_list():
    normalized = normalize_taxonomy_metadata(
        {"brand": "Rover", "brand_confidence": 0.96},
        [{"facet": "brand", "value": "Acme", "label": "Acme"}],
    )

    assert normalized == {"brand": "Rover", "brand_confidence": 0.96}


def test_vision_taxonomy_drops_unknown_low_confidence_brand():
    normalized = normalize_taxonomy_metadata(
        {"brand": "PossiblyBrand", "brand_confidence": 0.4},
        [{"facet": "brand", "value": "Acme", "label": "Acme"}],
    )

    assert normalized == {"brand_confidence": 0.4}


def test_sanitize_keeps_visible_text_as_bounded_evidence_but_drops_sku_key():
    normalized = sanitize_vision_metadata(
        {
            "sku": "Tabo C125",
            "visible_text": [" Tabo C125 ", "Tabo C125", "x" * 200],
            "visible_text_confidence": 1.2,
        }
    )

    assert "sku" not in normalized
    assert normalized["visible_text"] == ["Tabo C125", "x" * 120]
    assert normalized["visible_text_confidence"] == 1.0


def test_metadata_messages_includes_the_uploaders_batch_context_as_a_soft_hint():
    """Regression: UploadView.tsx's "Ngữ cảnh chung cho cả lô" chip is stored on
    media_assets.origin_info.batch_context but was never read by the worker at
    all -- the AI prompt had no way to see it despite the UI claiming it helps
    tagging. It must appear in the prompt, but framed so the model can still
    override it against what the image actually shows.
    """
    messages = metadata_messages(
        b"fake-bytes", "image/jpeg", [], "", "high", batch_context="Cả lô là ảnh showroom"
    )
    system_content = messages[0]["content"]
    assert "Cả lô là ảnh showroom" in system_content
    assert "hint" in system_content.lower()


def test_metadata_messages_without_batch_context_says_so_explicitly():
    messages = metadata_messages(b"fake-bytes", "image/jpeg", [], "", "high", batch_context=None)
    system_content = messages[0]["content"]
    assert "did not provide" in system_content


def test_taxonomy_hint_warns_ecosystem_badges_not_brands():
    hint = taxonomy_hint([{"facet": "brand", "value": "Acme", "label": "Acme"}])
    assert "Compatibility platforms" in hint
    assert "NOT the manufacturer brand" in hint


def test_household_synonyms_resolve_only_to_configured_taxonomy():
    options = [{"facet": "space", "value": "kitchen", "label": "Bếp"}]
    assert normalize_taxonomy_metadata({"space": "nhà bếp"}, options) == {"space": "kitchen"}
    assert normalize_taxonomy_metadata({"space": "fridge"}, options) == {}
    assert normalize_taxonomy_metadata({"space": "trong nhà"}, options) == {}


def test_metadata_prompt_is_neutral_and_requires_visible_evidence():
    prompt = metadata_messages(b"image", "image/jpeg", [], "", "high")[0]["content"]
    assert "Do not infer material grade, capacity" in prompt
    assert "mặt đọc vân tay" not in prompt
    assert "Never infer, return, rank" in prompt


def test_vision_taxonomy_normalizes_synonyms_to_canonical_options():
    normalized = normalize_taxonomy_metadata(
        {"status": "Đã lắp đặt", "space": "lối vào ngoài trời"},
        [
            {"facet": "status", "value": "Đã bàn giao", "label": "Đã bàn giao"},
            {"facet": "space", "value": "Ngoài trời / Cổng", "label": "Ngoài trời / Cổng"},
        ],
    )
    assert normalized["status"] == "Đã bàn giao"
    assert normalized["space"] == "Ngoài trời / Cổng"


def test_sanitize_shot_type_valid_enum():
    for valid in ("front", "angle", "top_down", "closeup", "wide", "lifestyle"):
        res = sanitize_vision_metadata({"shot_type": f" {valid.upper()} "})
        assert res["shot_type"] == valid


def test_sanitize_shot_type_invalid_enum_becomes_none():
    assert sanitize_vision_metadata({"shot_type": "side_angle"})["shot_type"] is None
    assert sanitize_vision_metadata({"shot_type": "unknown"})["shot_type"] is None
    assert sanitize_vision_metadata({"shot_type": ""})["shot_type"] is None
    assert sanitize_vision_metadata({}) == {}


def test_metadata_prompt_v7_includes_shot_type_and_evidence_keywords():
    prompt = metadata_messages(b"image", "image/jpeg", [], "", "high")[0]["content"]
    assert "shot_type" in prompt
    assert "'front', 'angle', 'top_down', 'closeup', 'wide', 'lifestyle'" in prompt
    assert "cánh cửa tủ lạnh" in prompt
    assert "xếp chồng" in prompt
