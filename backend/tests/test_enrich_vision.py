import json
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from app.vision_metadata import PROMPT_VERSION
from scripts import enrich_vision
from scripts.enrich_vision import enrich_asset, rollback_query, rollback_run, selection_query, snapshot

ASSET = {
    "id": "a1",
    "title": "LHC4282 - Bếp",
    "storage_path": "media/a1.webp",
    "sku": "LHC4282",
    "brand": "LocknLock",
    "suggested_caption": "old caption",
    "description": "old description",
    "keywords": ["cũ"],
    "visible_text": [],
    "category": "Studio",
    "space": None,
    "status": "Mới",
    "ai_flags": {"has_people": False, "shot_type": "front"},
}

VISION_RESULT = {
    "caption": "new caption",
    "description": "new description",
    "keywords": ["mới"],
    "visible_text": ["LocknLock"],
    "category": "Studio",
    "space": None,
    "status": "Mới",
    "has_people": False,
    "shot_type": "angle",
    "brand_confidence": 0.9,
}


class FakeCursor:
    def __init__(self):
        self.statements = []

    def execute(self, sql, params=()):
        self.statements.append((" ".join(sql.split()), params))


class FakeGateway:
    def __init__(self):
        self.cursor = FakeCursor()
        self.transactions = 0
        self.repository = SimpleNamespace(transaction=self._transaction)

    @contextmanager
    def _transaction(self):
        self.transactions += 1
        yield self.cursor

    def get_media_asset(self, asset_id):
        return dict(ASSET)

    def download_object(self, path):
        return b"img"


VISION_SETTINGS = SimpleNamespace(vision_model="test-model")


def _run(monkeypatch, gateway, result=None, error=None, dry_run=False, confirm_products=False):
    def fake_call(*args, **kwargs):
        if error:
            raise error
        return dict(result or VISION_RESULT)

    monkeypatch.setattr(enrich_vision, "call_vision_metadata", fake_call)
    monkeypatch.setattr(enrich_vision.time, "sleep", lambda s: None)
    return enrich_asset("a1", gateway, VISION_SETTINGS, [], [], "LocknLock",
                        dry_run=dry_run, confirm_products=confirm_products)


def _tagging_inserts(gateway):
    return [p for sql, p in gateway.cursor.statements if sql.startswith("insert into public.media_tagging_runs")]


def test_dry_run_never_touches_the_database(monkeypatch):
    gateway = FakeGateway()
    record = _run(monkeypatch, gateway, dry_run=True)
    assert gateway.transactions == 0
    assert record["status"] == "dry_run"
    assert record["before"]["description"] == "old description"
    assert record["after"]["description"] == "new description"


def test_success_updates_asset_and_records_versioned_run_in_same_transaction(monkeypatch):
    gateway = FakeGateway()
    record = _run(monkeypatch, gateway)
    assert gateway.transactions == 1
    sqls = [sql for sql, _ in gateway.cursor.statements]
    assert sqls[0].startswith("UPDATE public.media_assets")
    inserts = _tagging_inserts(gateway)
    assert len(inserts) == 1
    asset_id, status, model, prompt_version, output, error = inserts[0]
    assert (asset_id, status, model, prompt_version, error) == ("a1", "succeeded", "test-model", PROMPT_VERSION, None)
    payload = json.loads(output)
    assert payload["description"] == "new description"
    assert payload["_enrich"]["previous"]["description"] == "old description"
    assert record["status"] == "succeeded"


def test_failure_is_recorded_and_asset_untouched(monkeypatch):
    gateway = FakeGateway()
    with pytest.raises(RuntimeError, match="provider down"):
        _run(monkeypatch, gateway, error=RuntimeError("provider down"))
    sqls = [sql for sql, _ in gateway.cursor.statements]
    assert not any(sql.startswith("UPDATE public.media_assets") for sql in sqls)
    inserts = _tagging_inserts(gateway)
    assert len(inserts) == 1
    assert inserts[0][1] == "failed"
    assert "provider down" in inserts[0][5]


def test_failure_in_dry_run_writes_nothing(monkeypatch):
    gateway = FakeGateway()
    with pytest.raises(RuntimeError):
        _run(monkeypatch, gateway, error=RuntimeError("x"), dry_run=True)
    assert gateway.transactions == 0


def test_snapshot_keeps_only_enrichable_fields():
    snap = snapshot(ASSET)
    assert snap["caption"] == "old caption"
    assert snap["shot_type"] == "front"
    assert "storage_path" not in snap and "sku" not in snap


@pytest.mark.parametrize("mode,sku", [("all", None), ("missing_desc", None), ("sku", "LHC4282")])
def test_selection_skips_assets_already_at_current_prompt_version(mode, sku):
    sql, params = selection_query(mode, sku, force=False)
    assert "not exists" in sql
    assert PROMPT_VERSION in params


@pytest.mark.parametrize("mode,sku", [("all", None), ("missing_desc", None), ("sku", "LHC4282")])
def test_force_reprocesses_everything(mode, sku):
    sql, params = selection_query(mode, sku, force=True)
    assert "not exists" not in sql
    assert PROMPT_VERSION not in params


def test_sku_mode_is_parameterized():
    sql, params = selection_query("sku", "LHC4282'; drop table x;--", force=False)
    assert "LHC4282" not in sql
    assert params[0] == "LHC4282'; drop table x;--"


def _product_link_updates(gateway):
    return [sql for sql, _ in gateway.cursor.statements if sql.startswith("UPDATE public.media_asset_products")]


def test_product_links_are_not_confirmed_by_default(monkeypatch):
    gateway = FakeGateway()
    _run(monkeypatch, gateway)
    assert _product_link_updates(gateway) == []


def test_product_links_confirmed_only_with_explicit_flag(monkeypatch):
    gateway = FakeGateway()
    _run(monkeypatch, gateway, confirm_products=True)
    assert len(_product_link_updates(gateway)) == 1


# --- rollback ---------------------------------------------------------------

PREVIOUS = snapshot(ASSET)


def _run_row(changed_after=False, output=None):
    return {
        "run_id": "r1",
        "asset_id": "a1",
        "sku": "LHC4282",
        "title": "x",
        "changed_after": changed_after,
        "output": output if output is not None else {"description": "new", "_enrich": {"previous": PREVIOUS}},
    }


def test_rollback_query_targets_enrich_runs_at_current_version_and_is_parameterized():
    sql, params = rollback_query("sku", "LHC4282")
    assert "'previous'" in sql and "distinct on" in sql.lower()
    assert params == (PROMPT_VERSION, "LHC4282")
    sql_all, params_all = rollback_query("all", None)
    assert params_all == (PROMPT_VERSION,)


def test_rollback_restores_previous_values_and_audits_in_one_transaction():
    gateway = FakeGateway()
    record = rollback_run(gateway, _run_row())
    assert record["status"] == "rolled_back"
    assert gateway.transactions == 1
    sqls = [sql for sql, _ in gateway.cursor.statements]
    assert sqls[0].startswith("UPDATE public.media_assets")
    restore_params = gateway.cursor.statements[0][1]
    assert "old description" in restore_params and "old caption" in restore_params
    assert any(s.startswith("UPDATE public.media_tagging_runs SET status = 'rolled_back'") for s in sqls)
    audit = _tagging_inserts(gateway)
    assert len(audit) == 1 and audit[0][1] == "rollback"
    assert json.loads(audit[0][4])["_rollback_of"] == "r1"


def test_rollback_accepts_json_string_output():
    gateway = FakeGateway()
    row = _run_row(output=json.dumps({"_enrich": {"previous": PREVIOUS}}))
    assert rollback_run(gateway, row)["status"] == "rolled_back"


def test_rollback_skips_asset_edited_after_the_run_unless_forced():
    gateway = FakeGateway()
    record = rollback_run(gateway, _run_row(changed_after=True))
    assert record["status"] == "skipped"
    assert gateway.transactions == 0
    assert rollback_run(gateway, _run_row(changed_after=True), force=True)["status"] == "rolled_back"


def test_rollback_dry_run_writes_nothing():
    gateway = FakeGateway()
    record = rollback_run(gateway, _run_row(), dry_run=True)
    assert record["status"] == "dry_run_rollback"
    assert record["restore"]["description"] == "old description"
    assert gateway.transactions == 0


def test_rollback_skips_runs_without_snapshot():
    gateway = FakeGateway()
    record = rollback_run(gateway, _run_row(output={"description": "worker output"}))
    assert record["status"] == "skipped"
    assert gateway.transactions == 0
