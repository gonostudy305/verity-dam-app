"""Reference corpus promotion gate and role resolution.

Ensures strict parity with TypeScript implementation in src/lib/sku-context.ts
and src/lib/reference-role.ts.
"""
from typing import Optional


def should_promote_to_reference_corpus(
    context: str,
    has_people: bool = False,
    sku_confidence: Optional[float] = None,
    explicit_opt_in: bool = False,
) -> bool:
    """Gate for promoting an asset into the AI reference corpus.

    Rules:
    1. explicit_opt_in is True -> True (reviewer explicitly overrides)
    2. context != 'product' -> False (non-catalog, scene, marketing never auto-promote)
    3. has_people is True -> False (people shots never auto-promote)
    4. sku_confidence < 80 -> False (low-confidence SKU never auto-promotes; None/NaN fail-closed)
    5. Otherwise -> True (clean Studio catalog plate)
    """
    if explicit_opt_in is True:
        return True
    if context != "product":
        return False
    if has_people is True:
        return False
    if sku_confidence is None:
        return False
    try:
        conf = float(sku_confidence)
    except (ValueError, TypeError):
        return False
    if conf > 0 and conf <= 1:
        conf = conf * 100
    return conf >= 80



# Maps reference_role → image_category (3 nhóm lớn: REAL / STUDIO / DESIGN)
_ROLE_TO_CATEGORY: dict[str, str] = {
    "INSTALLATION":  "REAL",
    "REAL_WORLD":    "REAL",
    "LIFESTYLE":     "REAL",
    "MULTI_PRODUCT": "REAL",
    "HERO":          "STUDIO",
    "ANGLE":         "STUDIO",
    "UNCLASSIFIED":  "STUDIO",
    "BANNER":        "DESIGN",
    "RENDER_3D":     "DESIGN",
    "MOCKUP":        "DESIGN",
}


def resolve_reference_role(
    is_promoted: bool,
    has_active_reference_for_sku: bool = False,
    category: Optional[str] = None,
    product_link_count: int = 1,
) -> tuple[str, str, bool, str]:
    """Resolve reference role, curation status, match eligibility, and image category.

    Returns:
        tuple of (reference_role, curation_status, match_eligible, image_category)
    """
    if product_link_count >= 2:
        role = "MULTI_PRODUCT"
    else:
        cat = (category or "").strip().lower()
        if cat == "banner":
            role = "BANNER"
        elif cat in ("công trình", "cong trinh", "ảnh thực tế", "anh thuc te"):
            role = "INSTALLATION"
        elif cat in ("bảo hành", "bao hanh"):
            role = "REAL_WORLD"
        elif cat == "showroom":
            role = "LIFESTYLE"
        elif is_promoted:
            role = "ANGLE" if has_active_reference_for_sku else "HERO"
        else:
            role = "UNCLASSIFIED"

    curation_status = "VERIFIED" if is_promoted else "UNREVIEWED"
    match_eligible = bool(is_promoted)
    img_cat = _ROLE_TO_CATEGORY.get(role, "STUDIO")

    return role, curation_status, match_eligible, img_cat

