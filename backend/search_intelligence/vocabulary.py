"""Real, observed vocabulary for search intelligence.

Every list in this module is transcribed from data that already exists in
this repository -- nothing here is invented, LLM-hallucinated, or sourced
from outside the codebase. Exact provenance is documented per constant.
Sources used:

  * ``backend/migrations/0008_expand_catalog_brand_taxonomy.sql``
    (real brand names imported from the live WooCommerce catalog export).
  * ``src/config/taxonomy.ts`` (``DEFAULT_TAXONOMY``: bootstrap brand/
    category/space labels, the same Vietnamese room/space vocabulary the
    production UI and Vision pipeline already use).
  * ``backend/benchmarks/embedding_v1/manifests/calibration_v2_sku_universe_v2.json``
    (the pre-registered, frozen 40-SKU universe -- real SKUs, real brands,
    real Vietnamese ``display_name`` strings, real product categories).
  * ``supabase/migrations/20260826140000_synonyms_config.sql`` (the seed
    rows of the production ``verity_synonyms_config`` table -- the real
    synonym dictionary the current ILIKE search already expands against).

If the underlying source files change, this module should be regenerated
from them -- it deliberately does not read the DB/live config at import
time so these offline modules stay usable without any network/DB
dependency, matching the "offline library/module/test code only" scope of
this checkpoint.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from typing import Any

from .vietnamese_normalizer import strip_diacritics, tokenize

# ---------------------------------------------------------------------------
# Brands. Source: backend/migrations/0008_expand_catalog_brand_taxonomy.sql
# (WooCommerce catalog import) union src/config/taxonomy.ts DEFAULT_TAXONOMY.brand
# (bootstrap UI/Vision taxonomy). Deduplicated case-insensitively, original
# casing preserved.
# ---------------------------------------------------------------------------
BRAND_VOCABULARY: tuple[str, ...] = (
    "Acme", "Lumos", "Apple HomeKit",  # src/config/taxonomy.ts DEFAULT_TAXONOMY.brand
    "Bear", "TP-Link", "Drift", "EDEN", "Imex", "Lexar", "Rover", "Nova",
    "Deerma", "Verity", "Tera", "Ecolo", "Joyoung", "SKG", "Tabo", "Philips",
    "Eufy", "Govee", "Tenda", "Enchen", "Hikon", "Vconnex", "Jisulife",
    "Tineco", "Philips Hue", "UGREEN", "UVGreen", "Mova", "Smartmi", "Breo",
    "Sandisk", "AQUA", "Lockin", "SwitchBot", "Lumi", "Totolink", "Usmile",
    "Nanoleaf", "T3 Smart", "Ruijie", "Wanbo", "D-Link", "Ticklock", "Anker",
    "Belkin", "Google", "Hoco", "LifeSmart", "365 Selection", "ASUS", "Kata",
    "Acerpure", "Goneo", "Kioxia", "Lumias", "Lydsto", "Skyworth", "Viomi",
    "Broadlink", "Orbit", "Laifen", "Mercusys", "Acome", "Apple", "Botslab",
    "Chint", "Logitech", "Metalock", "Reoqoo", "Amazon", "Arlo", "Bomidi",
    "Ecoflow", "JIUXUN", "Lofans", "Makihome", "Mixie", "Momoda", "OLLI",
    "Rapoo", "Solove", "T3", "Toshiba",
)


def load_brand_vocabulary(db: Any = None) -> tuple[str, ...]:
    """Load active brands from native PostgreSQL taxonomy options.

    Fall back to the frozen repository vocabulary when the database is
    unavailable or has no active brand rows.
    """
    if db is None:
        return BRAND_VOCABULARY
    try:
        rows = db.fetch_all(
            "SELECT value FROM public.verity_taxonomy_options "
            "WHERE facet = 'brand' AND is_active = true ORDER BY sort_order, value"
        )
        if rows:
            brands = [str(r.get("value")) for r in rows if r.get("value")]
            if brands:
                return tuple(brands)
    except Exception:
        pass
    return BRAND_VOCABULARY


@dataclass(frozen=True)
class SkuRecord:
    sku: str
    brand: str
    display_name: str
    category: str


# ---------------------------------------------------------------------------
# SKUs. Source: backend/benchmarks/embedding_v1/manifests/
# calibration_v2_sku_universe_v2.json -- the frozen, pre-registered 40-SKU
# universe (real SKU codes, real brands, real Vietnamese display names).
# ---------------------------------------------------------------------------
SKU_RECORDS: tuple[SkuRecord, ...] = (
    SkuRecord("HR-21", "Verity", "Khóa thông minh Verity N2 cổng sắt ngoài trời", "Product_Line_A"),
    SkuRecord("MT-C02-Pro", "Verity", "Khóa cửa cổng vân tay 2 chiều Verity MT-C02 Pro", "Product_Line_A"),
    SkuRecord("A1-B", "Verity", "Khóa cổng thông minh Verity A1-B", "Product_Line_A"),
    SkuRecord("HR-33", "Verity", "Khóa vân tay Face ID cửa nhôm XingFa Verity HR-33", "Product_Line_A"),
    SkuRecord("AC-S02", "ACME", "Khóa cửa vân tay thông minh Acme A100", "Product_Line_A"),
    SkuRecord("AC-S16", "ACME", "Khóa Thông Minh Acme N100 Smart Door Lock", "Product_Line_A"),
    SkuRecord("N200", "ACME", "Khoá Cửa Thông Minh Acme N200 phiên bản 2020", "Product_Line_A"),
    SkuRecord("AC-S20", "ACME", "Khóa cửa thông minh Acme M100 Zigbee", "Product_Line_A"),
    SkuRecord("DEMO-007", "EDEN", "Khóa vân tay thông minh Eden DL05", "Product_Line_A"),
    SkuRecord("DEMO-003", "EDEN", "Khóa cửa điện tử vân tay EDEN L2S A0 BLACK", "Product_Line_A"),
    SkuRecord("DEMO-004", "EDEN", "Camera Eden C6N 4MP Quay Quét Wifi", "Product_Line_B"),
    SkuRecord("DEMO-013", "EDEN", "Camera IP Wifi Eden C6 4MP 2K+ Xoay 360", "Product_Line_B"),
    SkuRecord("DEMO-008", "EDEN", "Camera Eden dùng pin BC1C", "Product_Line_B"),
    SkuRecord("DEMO-012", "EDEN", "Camera Wifi Trong Nhà Eden CB1", "Product_Line_B"),
    SkuRecord("DEMO-009", "EDEN", "Camera Quay Quét Wifi EDEN C8PF Ống Kính Kép", "Product_Line_B"),
    SkuRecord("PX-80x(8MP+2MP,4mm)", "EDEN", "Camera Ngoài Trời Eden H80x Dual 4K", "Product_Line_B"),
    SkuRecord("DEMO-002", "EDEN", "Camera WiFi trong Nhà Eden H6c Pro 2K", "Product_Line_B"),
    SkuRecord("AC-H03", "ACME", "Camera Acme G3 Indoor 2K AI Tracking", "Product_Line_B"),
    SkuRecord("AC-C01", "ACME", "Camera Acme G2H Pro", "Product_Line_B"),
    SkuRecord("AC-C01E", "ACME", "Camera Trong Nhà Acme E1 2K", "Product_Line_B"),
    SkuRecord("DEMO-017", "DRIFT", "Drift L10s Ultra Gen 3", "Product_Line_C"),
    SkuRecord("DEMO-016", "DRIFT", "Robot hút bụi lau sàn DriftBot DEMO-016", "Product_Line_C"),
    SkuRecord("DEMO-015", "DRIFT", "Robot Drift X50 Master", "Product_Line_C"),
    SkuRecord("DEMO-018", "DRIFT", "Robot Hút Bụi Lau Nhà Drift W10 Pro", "Product_Line_C"),
    SkuRecord("DEMO-019", "DRIFT", "Robot Hút Bụi Lau Nhà Drift D9 Max", "Product_Line_C"),
    SkuRecord("DEMO-020", "DRIFT", "Robot hút bụi lau nhà Drift Bot L10 Pro", "Product_Line_C"),
    SkuRecord("DEMO-005", "EDEN", "Robot hút bụi lau nhà Eden RS2", "Product_Line_C"),
    SkuRecord("Q10 VF", "ROVER", "Robot hút bụi lau nhà Rover Q10 Ultra", "Product_Line_C"),
    SkuRecord("DEMO-014", "ECOLO", "Robot hút bụi lau nhà Ecolo DEMO-014", "Product_Line_C"),
    SkuRecord("DEMO-021", "IMEX", "Robot hút bụi lau nhà IMEX L11-A", "Product_Line_C"),
    SkuRecord("DEMO-006", "EDEN", "Chuông cửa có hình thông minh EDEN HP5", "Product_Line_D"),
    SkuRecord("AC-D03", "ACME", "Camera Chuông Cửa Acme G4", "Product_Line_D"),
    SkuRecord("DEMO-010", "EDEN", "Chuông cửa có hình thông minh Eden HP4 1080P", "Product_Line_D"),
    SkuRecord("DEMO-011", "EDEN", "Chuông cửa có hình Eden HP7 2K mở cửa từ xa", "Product_Line_D"),
    SkuRecord("D210", "TP-LINK", "Camera chuông cửa Tabo D210 2K", "Product_Line_D"),
    SkuRecord("AC-G02", "ACME", "Acme Hub M2 Zigbee 3.0", "Product_Line_E"),
    SkuRecord("AC-G01", "ACME", "Acme Hub M1S Gen 2", "Product_Line_E"),
    SkuRecord("M300", "Verity", "Hub điều khiển trung tâm Verity M300", "Product_Line_E"),
    SkuRecord("DEMO-022", "TABO", "Smart Hub TP-Link DEMO-022", "Product_Line_E"),
    SkuRecord("AC-W11", "ACME", "Cảm biến nhiệt độ độ ẩm Acme", "Product_Line_E"),
)

# fast exact lookup: normalized (casefold + collapsed whitespace) SKU code -> record.
# Used by the entity extractor's conservative SKU guard -- exact match ONLY,
# never fuzzy/edit-distance corrected into a different SKU.
SKU_INDEX: dict[str, SkuRecord] = {
    " ".join(record.sku.split()).casefold(): record for record in SKU_RECORDS
}

# ---------------------------------------------------------------------------
# Product categories. Source: the same SKU universe manifest's category
# labels, mapped to the real Vietnamese trigger words already used in
# production for these categories -- "khóa"/"khoá" (lock), "rèm"/"rem"
# (curtain), "cảm biến"/"cam bien" (sensor), "hub" -- come directly from
# supabase/migrations/20260826140000_synonyms_config.sql; "camera",
# "chuông cửa" (doorbell), "robot hút bụi" (robot vacuum) are the recurring
# leading words of the real SKU display_name strings above.
# ---------------------------------------------------------------------------
CATEGORY_KEYWORDS: dict[str, str] = {
    "khóa": "Product_Line_A",
    "khoá": "Product_Line_A",
    "camera": "Product_Line_B",
    "robot hút bụi": "Product_Line_C",
    "chuông cửa": "Product_Line_D",
    "hub": "Product_Line_E",
    "cảm biến": "Product_Line_E",
    "rèm": "Curtains",
    "rem": "Curtains",
}

# ---------------------------------------------------------------------------
# Room/space vocabulary. Source: src/config/taxonomy.ts DEFAULT_TAXONOMY.space
# (the real production bootstrap taxonomy also used by the Vision pipeline).
# ---------------------------------------------------------------------------
SPACE_VOCABULARY: tuple[str, ...] = (
    "Phòng khách", "Bếp", "Cửa chính", "Phòng ngủ", "Toàn cảnh",
    "Sân vườn", "Ban công", "Cầu thang", "Gara", "Phòng thờ",
)

# Installation-context phrases -- distinct from the room vocabulary above,
# these describe indoor/outdoor mounting and recur verbatim across many real
# SKU display_name strings (e.g. "Camera Ngoài Trời Eden H80x", "Camera Wifi
# Trong Nhà Eden CB1").
INSTALLATION_CONTEXT_VOCABULARY: tuple[str, ...] = ("trong nhà", "ngoài trời")

# Protocol/technology terms literally present in the real SKU display_name
# strings above (e.g. "Khóa cửa thông minh Acme M100 Zigbee",
# "Camera IP Wifi Eden C6 4MP 2K+ Xoay 360").
PROTOCOL_VOCABULARY: tuple[str, ...] = ("zigbee", "wifi")

# Feature terms recurring in the same real display_name strings (fingerprint
# lock, pan-tilt camera, battery-powered, Face ID lock).
FEATURE_VOCABULARY: tuple[str, ...] = ("vân tay", "quay quét", "face id", "pin")

# ---------------------------------------------------------------------------
# The real production synonym seed dictionary. Source:
# supabase/migrations/20260826140000_synonyms_config.sql (the actual seed
# rows inserted into public.verity_synonyms_config, config_key='default').
# Kept here only as a reference/documentation constant -- the production
# synonym table is still the live source of truth for the ILIKE path; this
# checkpoint does not read or mutate that table.
# ---------------------------------------------------------------------------
PRODUCTION_SYNONYM_SEED: dict[str, tuple[str, ...]] = {
    "cam": ("Camera Hub G3", "Camera E1"),
    "khóa": ("Acme M100", "Acme A100", "Acme U100"),
    "khoa": ("Acme M100", "Acme A100", "Acme U100"),
    "rèm": ("Curtain Driver E1", "Track Motor"),
    "rem": ("Curtain Driver E1", "Track Motor"),
    "cảm biến": ("Sensor P1", "Cảm biến cửa", "Cảm biến hiện diện FP2"),
    "cam bien": ("Sensor P1", "Cảm biến cửa", "Cảm biến hiện diện FP2"),
    "hub": ("Hub M2", "Hub M1S Gen 2", "Hub E1"),
}


_TOKEN_SKIP_RE = re.compile(r"^\d+$")


def _derive_token_vocabulary() -> dict[str, str]:
    """Tokenize every real text source above into a single-word vocabulary.

    Every token here traces back to a real accented display_name, category
    keyword, space label, installation-context phrase, feature term, or
    brand name already transcribed above -- this derives single-word
    correction targets (e.g. "thông", "minh", "hút", "bụi", "cửa") without
    inventing anything: those words are literally substrings of the real
    Vietnamese product titles in ``SKU_RECORDS``.

    Returns a mapping of casefolded token -> the most frequently observed
    accented surface form (ties broken by first occurrence, for
    determinism).
    """

    surface_counts: Counter[str] = Counter()
    canonical_by_fold: dict[str, str] = {}
    sources = (
        [record.display_name for record in SKU_RECORDS]
        + list(CATEGORY_KEYWORDS.keys())
        + list(SPACE_VOCABULARY)
        + list(INSTALLATION_CONTEXT_VOCABULARY)
        + list(FEATURE_VOCABULARY)
        + list(PROTOCOL_VOCABULARY)
        + list(BRAND_VOCABULARY)
    )
    for text in sources:
        for token in tokenize(text.lower()):
            if _TOKEN_SKIP_RE.match(token) or len(token) < 2:
                continue
            key = token.casefold()
            surface_counts[(key, token)] += 1
            canonical_by_fold.setdefault(key, token)

    # Prefer the most-observed surface spelling per casefolded key.
    best_surface: dict[str, str] = {}
    best_count: dict[str, int] = {}
    for (key, token), count in surface_counts.items():
        if count > best_count.get(key, -1):
            best_count[key] = count
            best_surface[key] = token
    return best_surface


TOKEN_VOCABULARY: dict[str, str] = _derive_token_vocabulary()
