"""Vision metadata adapter. It is intentionally unable to return an SKU."""

from __future__ import annotations

import base64
from typing import Any

import requests

from app.contracts import sanitize_vision_metadata
from app.production_config import ConfigurationError, WorkerSettings

PROMPT_VERSION = "metadata-v7.2-strict-zero-speculation"


def taxonomy_hint(options: list[dict[str, Any]]) -> str:
    """Build the Vision constraint from the shared native taxonomy."""
    if not options:
        return "Shared taxonomy constraints are unavailable; use null for unclear taxonomy values and do not invent labels."
    by_facet: dict[str, list[str]] = {"category": [], "space": [], "status": [], "brand": []}
    for option in options:
        facet = option.get("facet")
        label = option.get("label")
        if facet in by_facet and isinstance(label, str) and label.strip():
            by_facet[facet].append(label.strip())
    return (
        "Allowed category values: " + ", ".join(by_facet["category"]) + ". "
        "Allowed space values: " + ", ".join(by_facet["space"]) + ". "
        "Allowed status values: " + ", ".join(by_facet["status"]) + ". "
        "Allowed brand values: " + ", ".join(by_facet["brand"]) + ". "
        "Prefer an allowed canonical brand when it matches. If another brand is clearly visible, "
        "return its observed brand name rather than forcing a wrong allowed value. "
        "Use null if the value is unclear rather than inventing a brand. "
        "Compatibility platforms and certification badges are NOT the manufacturer brand. "
        "Only identify a manufacturer when supported by visible evidence."
    )


TAXONOMY_SYNONYM_MAPPINGS: dict[str, dict[str, str]] = {
    "status": {
        "đã lắp đặt": "Đã bàn giao",
        "installed": "Đã bàn giao",
        "hoàn thành": "Đã bàn giao",
        "hoàn thiện": "Đã bàn giao",
        "đang lắp đặt": "Đang lắp",
        "đang thi công": "Đang lắp",
        "installation": "Đang lắp",
        "chưa lắp đặt": "Mới",
        "uninstalled": "Mới",
        "new": "Mới",
        "mới": "Mới",
    },
    "space": {
        "nhà bếp": "Bếp",
        "kitchen": "Bếp",
        "fridge": "Tủ lạnh",
        "refrigerator": "Tủ lạnh",
        "dining room": "Phòng ăn",
        "office": "Văn phòng",
        "ngoài trời": "Ngoài trời / Cổng",
        "lối vào ngoài trời": "Ngoài trời / Cổng",
        "cổng ngoài trời": "Ngoài trời / Cổng",
        "outdoor": "Ngoài trời / Cổng",
        "cửa cổng": "Ngoài trời / Cổng",
        "cổng": "Ngoài trời / Cổng",
        "ngoại thất": "Ngoài trời / Cổng",
        "exterior": "Ngoài trời / Cổng",
        "lối vào nhà": "Cửa chính",
        "lối vào": "Cửa chính",
        "lối vào công trình": "Cửa chính",
        "cửa ra vào": "Cửa chính",
        "entrance": "Cửa chính",
        "cửa gỗ": "Cửa chính",
    },
}


def normalize_taxonomy_metadata(
    metadata: dict[str, Any], options: list[dict[str, Any]]
) -> dict[str, Any]:
    """Convert editable Vision labels back to stable media storage values."""
    if not options:
        return dict(metadata)
    mappings: dict[str, dict[str, str]] = {"category": {}, "space": {}, "status": {}, "brand": {}}
    for option in options:
        facet = option.get("facet")
        value = option.get("value")
        label = option.get("label")
        if facet not in mappings or not isinstance(value, str) or not isinstance(label, str):
            continue
        mappings[facet][value.casefold()] = value
        mappings[facet][label.casefold()] = value

    normalized = dict(metadata)
    for field, mapping in mappings.items():
        raw = normalized.get(field)
        if not isinstance(raw, str) or not raw.strip():
            continue
        canonical = mapping.get(raw.strip().casefold())
        if canonical is None and field in TAXONOMY_SYNONYM_MAPPINGS:
            synonym_target = TAXONOMY_SYNONYM_MAPPINGS[field].get(raw.strip().casefold())
            if synonym_target:
                canonical = mapping.get(synonym_target.casefold())
        if canonical is None:
            brand_confidence = normalized.get("brand_confidence")
            if field == "brand" and isinstance(brand_confidence, (int, float)) and brand_confidence >= 0.75:
                normalized[field] = raw.strip()[:200]
            else:
                normalized.pop(field, None)
        else:
            normalized[field] = canonical
    return normalized


def _example_text(examples: list[dict[str, Any]]) -> str:
    if not examples:
        return "No reviewer correction examples are available yet."
    lines: list[str] = []
    for example in examples[:8]:
        meta = example.get("accepted_metadata", {})
        if not isinstance(meta, dict):
            continue
        desc = str(meta.get("description") or "").strip()
        cap = str(meta.get("suggested_caption") or "").strip()
        if not desc or len(desc) < 60 or desc.lower() == cap.lower():
            continue
        lines.append(
            "Correction example (context then reviewer-approved metadata): "
            f"{example.get('input_context', {})} => {meta}"
        )
    if not lines:
        return "No reviewer correction examples with rich descriptions are available yet."
    return "\n".join(lines)


def _uploader_hint(batch_context: str | None) -> str:
    """Soft, overridable hint from the person who uploaded this batch."""
    cleaned = (batch_context or "").strip()
    if not cleaned:
        return "The uploader did not provide any batch context; rely only on the image itself."
    return (
        f'The uploader described this whole upload batch as: "{cleaned}". Treat this as a hint, not '
        "a fact -- use it only when the image itself is consistent with it, and ignore it if the image "
        "clearly shows something else."
    )


def metadata_messages(
    image_bytes: bytes,
    mime_type: str,
    examples: list[dict[str, Any]],
    system_prompt: str,
    image_detail: str,
    taxonomy_options: list[dict[str, Any]] | None = None,
    batch_context: str | None = None,
) -> list[dict[str, Any]]:
    image_data_url = f"data:{mime_type};base64,{base64.b64encode(image_bytes).decode('ascii')}"
    return [
        {
            "role": "system",
            "content": (
                "You generate open Verity media metadata in Vietnamese. Never infer, return, rank, "
                "or mention a SKU/product code; SKU matching is a separate embedding-reference system. "
                "Return JSON only with keys: caption, description, brand, category, space, status, "
                "shot_type, has_people, keywords, visible_text, visible_text_confidence, brand_confidence, "
                "category_confidence, space_confidence, status_confidence.\n"
                "Rules:\n"
                "1. caption: 1-2 concise Vietnamese sentences summarizing the visible subject and scene (used for alt-text and preview).\n"
                "2. description: Rich visual description in clear, comprehensive Vietnamese sentences. "
                "Do NOT repeat the wording of the caption. Methodically describe observable visual layers when clearly visible: "
                "(a) Component Structure: Geometric shape (cylindrical, rectangular, tapered), lid mechanism (sliding lock, clip, twist-off), handle, mouth rim, visible compartments; "
                "(b) Colors & Surface Finishes: Primary color tone, surface finish (matte vs glossy, transparent vs metallic), contrasting accents if clearly observable; "
                "(c) Scene & Angle: Setting (e.g. outdoor greenery bokeh, kitchen counter, studio plain background), camera perspective, whether an object is held or placed on a surface; "
                "(d) Brand & Markings: Visible logo placement and legible text. "
                "Zero-Speculation Rule: Describe only directly observable physical traits and geometric shapes. "
                "Do not infer material grade, capacity, technical claims, brand or other specifications from appearance; "
                "state them only when clearly supported by readable visible text. Never invent missing details. "
                "Specifically: Do NOT use functional claims such as 'giữ nhiệt', 'cách nhiệt', 'chống tràn', or 'giữ lạnh' "
                "in caption, description, or keywords unless that exact claim is legible on visible labels/text.\n"
                "3. shot_type: Exactly one enum string from: 'front', 'angle', 'top_down', 'closeup', 'wide', 'lifestyle', or null. "
                "Definitions: 'front' (straight eye-level view), 'angle' (3/4 or isometric view), 'top_down' (looking straight down), "
                "'closeup' (macro/detail of lid, seal, label, or texture), 'wide' (wide scene in a room), 'lifestyle' (in-use context, e.g. food packed, on table, fridge door, or handled). "
                "Do not invent other values; return null if unclear.\n"
                "4. If category is 'Banner' or 'Studio', space must be null.\n"
                "5. keywords: array of 5 to 8 relevant lowercase Vietnamese search tags. You MAY translate or interpret visible English label text "
                "into standard Vietnamese functional keywords ONLY when directly evidenced by visible OCR text (e.g. 'DOOR POCKET SYSTEM' -> 'cánh cửa tủ lạnh', "
                "'INTER-LOCKING' -> 'xếp chồng', 'SPACE SAVING' -> 'tiết kiệm không gian'). NEVER invent speculative use-cases or unobserved food items.\n"
                "6. visible_text: array of up to 8 strings transcribed exactly from clearly visible labels/logos.\n"
                "7. All confidence values must be 0..1.\n"
                "8. has_people: boolean (true if any person or human body part, such as a hand holding a product, is visible; false otherwise).\n"
                + taxonomy_hint(taxonomy_options or []) + "\n"
                + _example_text(examples)
                + "\n" + _uploader_hint(batch_context)
                + "\nShared configuration instructions:\n"
                + system_prompt
            ),
        },
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Describe this image with the required open metadata JSON including mandatory description."},
                {"type": "image_url", "image_url": {"url": image_data_url, "detail": image_detail}},
            ],
        },
    ]


def call_vision_metadata(
    settings: WorkerSettings,
    image_bytes: bytes,
    mime_type: str,
    examples: list[dict[str, Any]],
    session: requests.Session | None = None,
    taxonomy_options: list[dict[str, Any]] | None = None,
    batch_context: str | None = None,
) -> dict[str, Any]:
    if not settings.vision_is_configured:
        raise ConfigurationError("Vision metadata is not configured")
    assert settings.vision_base_url and settings.vision_api_key and settings.vision_model
    target = f"{settings.vision_base_url.rstrip('/')}/chat/completions"
    if not target.startswith("https://"):
        raise ConfigurationError("AI_VISION_BASE_URL must use HTTPS")
    response = (session or requests.Session()).post(
        target,
        headers={"Authorization": f"Bearer {settings.vision_api_key}", "Content-Type": "application/json"},
        json={
            "model": settings.vision_model,
            "messages": metadata_messages(
                image_bytes,
                mime_type,
                examples,
                settings.vision_system_prompt,
                settings.vision_detail,
                taxonomy_options,
                batch_context,
            ),
            "max_tokens": settings.vision_max_tokens,
            "stream": False,
        },
        timeout=45,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Vision provider returned HTTP {response.status_code}")
    payload = response.json()
    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise RuntimeError("Vision provider returned no chat completion") from error
    metadata = sanitize_vision_metadata(content)
    return normalize_taxonomy_metadata(metadata, taxonomy_options or [])
