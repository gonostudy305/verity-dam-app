import json
from pathlib import Path

from app.reference_promotion import (
    resolve_reference_role,
    should_promote_to_reference_corpus,
)


def test_reference_promotion_gate_parity_with_fixture():
    fixture_path = Path(__file__).parent / "fixtures" / "reference_gate_vectors.json"
    with open(fixture_path, "r", encoding="utf-8") as f:
        fixtures = json.load(f)

    for item in fixtures:
        desc = item["description"]
        inp = item["input"]
        exp = item["expected"]

        is_promoted = should_promote_to_reference_corpus(
            context=inp["context"],
            has_people=inp.get("hasPeople", False),
            sku_confidence=inp.get("skuConfidence"),
            explicit_opt_in=inp.get("explicitOptIn", False),
        )
        assert is_promoted == exp["isPromoted"], f"[{desc}] isPromoted mismatch"

        role, curation, match_eligible, image_category = resolve_reference_role(
            is_promoted=is_promoted,
            has_active_reference_for_sku=inp.get("hasActiveReferenceForSku", False),
            category=inp.get("category"),
            product_link_count=inp.get("productLinkCount", 1),
        )

        assert role == exp["role"], f"[{desc}] role mismatch"
        assert curation == exp["curationStatus"], f"[{desc}] curationStatus mismatch"
        assert match_eligible == exp["matchEligible"], f"[{desc}] matchEligible mismatch"
        if "imageCategory" in exp:
            assert image_category == exp["imageCategory"], f"[{desc}] imageCategory mismatch"
