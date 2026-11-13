from app.native_gateway import _active_duplicate_matches


def test_active_duplicate_matches_drops_deleted_and_malformed_candidates() -> None:
    active_id = "11111111-1111-4111-8111-111111111111"
    deleted_id = "22222222-2222-4222-8222-222222222222"

    matches = _active_duplicate_matches(
        [
            {"candidate_media_asset_id": active_id, "similarity": 0.98},
            {"candidate_media_asset_id": deleted_id, "similarity": 0.99},
            {"candidate_media_asset_id": "not-a-uuid", "similarity": 1.0},
            {"similarity": 0.9},
        ],
        {active_id},
    )

    assert matches == [{"candidate_media_asset_id": active_id, "similarity": 0.98}]


def test_active_duplicate_matches_accepts_empty_or_non_list_payloads() -> None:
    assert _active_duplicate_matches(None, set()) == []
    assert _active_duplicate_matches([], set()) == []
