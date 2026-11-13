from app.catalog_text import fuse_sku_candidates, text_query_variants


def test_text_variants_keep_model_spans_without_inventing_codes():
    variants = text_query_variants(["Tabo C125 label", "Tabo C125 label"])

    assert "tabo c125 label" in variants
    assert "tabo c125" in variants
    assert variants.count("tabo c125 label") == 1


def test_text_variants_extract_single_token_sku_from_filename_or_ocr():
    variants = text_query_variants(["lhc8015-b32181271-1.webp"])

    assert "lhc8015" in variants
    assert "b32181271" in variants
    assert "lhc8015 b32181271 1 webp" in variants


def test_text_reranking_keeps_image_similarity_as_the_gate_score():
    fused = fuse_sku_candidates(
        [{"sku": "wrong", "similarity": 0.88}, {"sku": "right", "similarity": 0.87}],
        [{"sku": "right", "text_score": 1.0, "text_evidence": "Tabo C125"}],
    )

    assert fused[0]["sku"] == "right"
    assert fused[0]["similarity"] == 0.87
    assert fused[0]["text_score"] == 1.0


def test_text_without_image_candidate_is_negative_evidence_only():
    fused = fuse_sku_candidates(
        [{"sku": "wrong", "similarity": 0.88}],
        [{"sku": "right", "text_score": 1.0}],
    )

    right = next(candidate for candidate in fused if candidate["sku"] == "right")
    assert right["similarity"] == -1.0


def test_sanitize_brand_prior_filters_ecosystem_badges():
    from app.catalog_text import sanitize_brand_prior

    assert sanitize_brand_prior("Lyra") == "Lyra"
    assert sanitize_brand_prior("Acme") == "Acme"
    assert sanitize_brand_prior("EDEN") == "EDEN"
    assert sanitize_brand_prior("Matter") is None
    assert sanitize_brand_prior("matter") is None
    assert sanitize_brand_prior("Works with Apple Home") is None
    assert sanitize_brand_prior("Apple HomeKit") is None
    assert sanitize_brand_prior("Apple") is None
    assert sanitize_brand_prior("Zigbee 3.0") is None
    assert sanitize_brand_prior("Google Home") is None
    assert sanitize_brand_prior("Hỗ trợ Apple Home") is None
    assert sanitize_brand_prior(None) is None
    assert sanitize_brand_prior("") is None
