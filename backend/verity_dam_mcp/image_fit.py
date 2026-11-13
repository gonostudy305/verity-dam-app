"""Image-fit evaluation engine for VerityDAM MCP.

Evaluates how well a specific image fits an article or social media post text,
applying the standard 0-3 relevance grading scale from gold_nlp_search/labeling_guide.md:
  Grade 3: Ideal / Exact Match
  Grade 2: Highly Relevant
  Grade 1: Marginally Relevant
  Grade 0: Irrelevant / Hallucination / Hard constraint violation
"""

from __future__ import annotations

import base64
import binascii
import io
import json
import re
from typing import Any, Callable
from urllib.parse import urlparse

import httpx

from verity_dam_mcp.models import (
    CandidateFit,
    ContextRelevance,
    EvaluateImageFitInput,
    EvaluateImageFitOutput,
    FindBestImageInput,
    FindBestImageOutput,
    MediaSearchInput,
    ProductMatch,
    RecentUsageCheck,
    TechnicalSuitability,
)

PROMPT_VERSION = "image-fit-v1"

_GRADE_LABELS = {
    3: "Ideal",
    2: "Highly Relevant",
    1: "Marginally Relevant",
    0: "Irrelevant",
}

# Standard ideal aspect ratios by marketing channel
_CHANNEL_SPECS: dict[str, dict[str, Any]] = {
    "facebook": {
        "feed_ratios": [(1.0, 1.0), (4.0, 5.0), (1.91, 1.0)],
        "story_ratios": [(9.0, 16.0)],
        "preferred_feed": "1:1 hoặc 4:5",
        "preferred_story": "9:16",
    },
    "instagram": {
        "feed_ratios": [(1.0, 1.0), (4.0, 5.0)],
        "story_ratios": [(9.0, 16.0)],
        "preferred_feed": "1:1 hoặc 4:5",
        "preferred_story": "9:16",
    },
    "zalo": {
        "feed_ratios": [(1.0, 1.0), (16.0, 9.0), (4.0, 3.0)],
        "story_ratios": [(9.0, 16.0)],
        "preferred_feed": "1:1 hoặc 16:9",
        "preferred_story": "9:16",
    },
    "website": {
        "feed_ratios": [(16.0, 9.0), (4.0, 3.0), (1.0, 1.0)],
        "story_ratios": [],
        "preferred_feed": "16:9 hoặc 4:3",
        "preferred_story": "Không áp dụng",
    },
    "tiktok": {
        "feed_ratios": [(9.0, 16.0)],
        "story_ratios": [(9.0, 16.0)],
        "preferred_feed": "9:16",
        "preferred_story": "9:16",
    },
}


def evaluate_technical_suitability(
    channel: str,
    width: int | None,
    height: int | None,
) -> TechnicalSuitability:
    """Evaluate aspect ratio and dimension suitability for a target marketing channel."""
    ch = channel.lower().strip()
    specs = _CHANNEL_SPECS.get(ch, _CHANNEL_SPECS["facebook"])

    if not width or not height or width <= 0 or height <= 0:
        return TechnicalSuitability(
            channel=ch,
            aspect_ratio="unknown",
            suitable_for_feed=True,
            suitable_for_story=False,
            recommendation=f"Kênh {ch}: khuyến nghị ảnh tỷ lệ {specs['preferred_feed']}.",
        )

    ratio = width / height
    # Format readable aspect ratio string
    gcd_val = _approx_aspect_ratio(width, height)

    suitable_feed = False
    for target_w, target_h in specs["feed_ratios"]:
        target_ratio = target_w / target_h
        if abs(ratio - target_ratio) <= 0.15:
            suitable_feed = True
            break

    suitable_story = False
    for target_w, target_h in specs["story_ratios"]:
        target_ratio = target_w / target_h
        if abs(ratio - target_ratio) <= 0.15:
            suitable_story = True
            break

    rec_parts = []
    if suitable_feed:
        rec_parts.append(f"Chuẩn feed {ch}")
    else:
        rec_parts.append(f"Cần crop về {specs['preferred_feed']} cho feed")

    if suitable_story:
        rec_parts.append(f"Chuẩn story {ch}")

    return TechnicalSuitability(
        channel=ch,
        aspect_ratio=gcd_val,
        suitable_for_feed=suitable_feed,
        suitable_for_story=suitable_story,
        recommendation="; ".join(rec_parts),
    )


def _approx_aspect_ratio(w: int, h: int) -> str:
    r = w / h
    candidates = [(1, 1), (4, 5), (5, 4), (16, 9), (9, 16), (4, 3), (3, 4), (1.91, 1)]
    for cw, ch in candidates:
        if abs(r - (cw / ch)) < 0.05:
            return f"{cw}:{ch}" if isinstance(cw, int) and isinstance(ch, int) else f"{r:.2f}:1"
    return f"{r:.2f}:1"


def check_product_match(
    confirmed_matches: list[dict[str, Any]],
    product_hint: str | None,
) -> ProductMatch:
    """Verify whether candidate asset matches confirmed product SKU or product hint."""
    if not confirmed_matches and not product_hint:
        return ProductMatch(matched=True, details="Không có yêu cầu SKU cụ thể.")

    hint_norm = (product_hint or "").strip().lower()

    if confirmed_matches:
        top = confirmed_matches[0]
        if isinstance(top, str):
            code = top
            brand = ""
            name = top.lower()
            confidence = 1.0
        elif isinstance(top, dict):
            code = str(top.get("code") or top.get("primary_sku") or "")
            brand = str(top.get("brand") or "").lower()
            name = str(top.get("display_name") or "").lower()
            confidence = float(top.get("confidence") or 1.0)
        else:
            code = str(getattr(top, "code", getattr(top, "primary_sku", "")))
            brand = str(getattr(top, "brand", "")).lower()
            name = str(getattr(top, "display_name", "")).lower()
            confidence = float(getattr(top, "confidence", 1.0))

        if hint_norm:
            if hint_norm in code.lower() or (brand and brand in hint_norm) or (name and hint_norm in name):
                return ProductMatch(
                    matched=True,
                    confirmed_sku=code,
                    confidence=confidence,
                    details=f"Khớp SKU {code} với gợi ý '{product_hint}'.",
                )
            return ProductMatch(
                matched=False,
                confirmed_sku=code,
                confidence=confidence,
                details=f"Asset gắn SKU {code} khác với gợi ý '{product_hint}'.",
            )
        return ProductMatch(
            matched=True,
            confirmed_sku=code,
            confidence=confidence,
            details=f"Asset gắn SKU {code} đã xác nhận.",
        )

    # No confirmed SKU in DB, but hint requested
    return ProductMatch(
        matched=False,
        confirmed_sku=None,
        confidence=0.0,
        details=f"Asset chưa có SKU liên kết để đối chiếu với '{product_hint}'.",
    )


def fit_messages(
    article_text: str,
    image_data_url: str,
    product_hint: str | None = None,
) -> list[dict[str, Any]]:
    """Construct chat completion messages for AI Vision image-fit evaluation."""
    clean_article = article_text.strip()[:3000]
    hint_text = f"\nGợi ý sản phẩm/SKU cần đối chiếu: {product_hint.strip()}" if product_hint else ""

    system_prompt = (
        "Bạn là chuyên gia thẩm định hình ảnh cho hệ thống tự động đăng bài tiếp thị gia dụng Verity (Studio.verity).\n"
        "Nhiệm vụ của bạn là đánh giá mức độ phù hợp (image-fit) giữa hình ảnh và nội dung bài viết tiếp thị theo thang đo 4 mức (0-3):\n\n"
        "THANG ĐO ĐÁNH GIÁ (RELEVANCE SCALE 0-3):\n"
        "- Grade 3 (Ideal / Exact Match): Hình ảnh đáp ứng hoàn hảo nội dung bài viết. Đúng chính xác sản phẩm/SKU được nói tới (hoặc không gian kiến trúc/bối cảnh sống nếu bài viết về không gian). Tính thẩm mỹ cao, phù hợp đăng ngay.\n"
        "- Grade 2 (Highly Relevant): Thỏa mãn tốt nội dung với khác biệt nhỏ (ví dụ: biến thể màu cùng dòng sản phẩm, bối cảnh phòng liền kề, hình ảnh thể hiện đúng phong cách kiến trúc mà marketer sẵn sàng chấp nhận thay thế).\n"
        "- Grade 1 (Marginally Relevant): Liên hệ lỏng lẻo (cùng danh mục thiết bị nhưng khác thương hiệu/hệ sinh thái, sản phẩm chỉ xuất hiện mờ ở góc xa nền, bối cảnh không ăn nhập).\n"
        "- Grade 0 (Irrelevant / Hallucination / Unsafe): Hoàn toàn lệch chủ đề (bài viết về khóa cửa nhưng ảnh chụp robot hút bụi), vi phạm ràng buộc cấm (bài viết yêu cầu không có người nhưng ảnh có mặt người), hoặc ảnh chất lượng kém, lỗi kỹ thuật.\n\n"
        "YÊU CẦU ĐẦU RA:\n"
        "Trả về DUY NHẤT một chuỗi JSON hợp lệ (không markdown block, không chú thích ngoài) với các trường:\n"
        "{\n"
        '  "fit_grade": 0..3 (số nguyên),\n'
        '  "rationale": "giải thích súc tích bằng tiếng Việt vì sao ảnh đạt/không đạt điểm này",\n'
        '  "relevance_score": 0.0..1.0 (số thực chuẩn hóa),\n'
        '  "context_explanation": "mô tả ngắn gọn bối cảnh và chủ thể chính trong ảnh",\n'
        '  "visual_subject": "chủ thể chính nhìn thấy trong ảnh (ví dụ: khóa thông minh Acme M100 trên cửa gỗ)"\n'
        "}"
    )

    user_content: list[dict[str, Any]] = [
        {
            "type": "text",
            "text": f"NỘI DUNG BÀI VIẾT:\n\"\"\"\n{clean_article}\n\"\"\"{hint_text}\n\nHãy thẩm định ảnh đính kèm có phù hợp để làm ảnh minh họa cho bài viết trên không.",
        },
        {
            "type": "image_url",
            "image_url": {"url": image_data_url, "detail": "auto"},
        },
    ]

    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]


def sanitize_image_fit_response(raw_content: str) -> dict[str, Any]:
    """Parse and sanitize the JSON output from the Vision LLM, clamping values into bounds."""
    text = (raw_content or "").strip()
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        text = match.group(0)

    try:
        data = json.loads(text)
    except Exception as exc:
        raise ValueError(f"Vision provider did not return valid JSON: {exc}") from exc

    raw_grade = data.get("fit_grade")
    try:
        grade = int(raw_grade)
        grade = max(0, min(3, grade))
    except (ValueError, TypeError):
        grade = 0

    raw_score = data.get("relevance_score")
    try:
        score = float(raw_score)
        score = max(0.0, min(1.0, score))
    except (ValueError, TypeError):
        score = grade / 3.0

    rationale = str(data.get("rationale") or "").strip()[:500]
    if not rationale:
        rationale = f"Được xếp hạng {grade}/3 ({_GRADE_LABELS.get(grade, 'Unknown')})."

    return {
        "fit_grade": grade,
        "fit_label": _GRADE_LABELS.get(grade, "Irrelevant"),
        "rationale": rationale,
        "relevance_score": score,
        "context_explanation": str(data.get("context_explanation") or "").strip()[:300],
        "visual_subject": str(data.get("visual_subject") or "").strip()[:200] or None,
    }


def call_vision_fit(
    base_url: str,
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    timeout: float = 45.0,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    """Call the OpenAI-compatible Vision API endpoint with the fit evaluation prompt."""
    target = f"{base_url.rstrip('/')}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": 800,
        "temperature": 0.2,
    }

    own_client = client is None
    c = client or httpx.Client(timeout=timeout)
    try:
        resp = c.post(target, headers=headers, json=payload)
        resp.raise_for_status()
        res_data = resp.json()
        content = res_data["choices"][0]["message"]["content"]
        return sanitize_image_fit_response(content)
    finally:
        if own_client:
            c.close()


def _resolve_image_data_url(
    gateway: Any,
    params: EvaluateImageFitInput,
) -> tuple[str, int | None, int | None]:
    """Extract image data URL (data:image/...;base64,...) and pixel dimensions."""
    if params.image_base64:
        b64_clean = params.image_base64.strip()
        # Detect mime or header if provided as data url
        if b64_clean.startswith("data:"):
            data_url = b64_clean
            try:
                raw_bytes = base64.b64decode(b64_clean.split(",", 1)[1])
            except Exception:
                raw_bytes = b""
        else:
            data_url = f"data:image/jpeg;base64,{b64_clean}"
            try:
                raw_bytes = base64.b64decode(b64_clean)
            except Exception:
                raw_bytes = b""

        w, h = None, None
        if raw_bytes:
            try:
                from PIL import Image

                with Image.open(io.BytesIO(raw_bytes)) as img:
                    w, h = img.size
            except Exception:
                pass
        return data_url, w, h

    if params.media_asset_id:
        rows = gateway.select("media_assets", {"id": f"eq.{params.media_asset_id}", "limit": "1"})
        if not rows:
            raise RuntimeError(f"Asset {params.media_asset_id} was not found or is not accessible.")

        asset = rows[0]
        dims = asset.get("dimensions") if isinstance(asset.get("dimensions"), dict) else {}
        w = dims.get("width")
        h = dims.get("height")

        # Prefer direct storage bytes if available
        thumb_path = asset.get("thumbnail_path") or asset.get("storage_path")
        if thumb_path:
            try:
                if hasattr(gateway, "storage") and hasattr(gateway.storage, "get_bytes"):
                    raw_bytes = gateway.storage.get_bytes(thumb_path)
                    import mimetypes

                    mime, _ = mimetypes.guess_type(thumb_path)
                    mime = mime or "image/webp"
                    data_url = f"data:{mime};base64,{base64.b64encode(raw_bytes).decode('ascii')}"
                    if not w or not h:
                        try:
                            from PIL import Image

                            with Image.open(io.BytesIO(raw_bytes)) as img:
                                w, h = img.size
                        except Exception:
                            pass
                    return data_url, w, h
            except Exception:
                pass

        signed_map = gateway.create_signed_urls([thumb_path]) if thumb_path else {}
        url = signed_map.get(thumb_path)
        if not url:
            raise RuntimeError(f"Could not generate access URL for asset {params.media_asset_id}.")
        return url, w, h

    raise ValueError("Either media_asset_id or image_base64 is required.")


def evaluate_image_fit(
    gateway: Any,
    settings: Any,
    params: EvaluateImageFitInput,
) -> EvaluateImageFitOutput:
    """Evaluate image fit for content across vision, technical suitability, product identity, and recency."""
    # 1. Resolve image source & dimensions
    try:
        image_data_url, width, height = _resolve_image_data_url(gateway, params)
    except Exception as exc:
        return EvaluateImageFitOutput(
            media_asset_id=params.media_asset_id,
            fit_grade=0,
            fit_label="Irrelevant",
            rationale=f"Không thể đọc ảnh: {exc}",
            context_relevance=ContextRelevance(relevance_score=0.0, explanation=str(exc)),
            technical_suitability=TechnicalSuitability(channel=params.channel, suitable_for_feed=False),
            product_match=ProductMatch(matched=False, details="Lỗi đọc ảnh"),
            already_used_recently=RecentUsageCheck(used=False),
            markdown_summary=f"### Đánh giá độ phù hợp: 0/3 (Irrelevant)\n- **Lỗi:** {exc}",
        )

    # 2. Technical suitability
    tech_suitability = evaluate_technical_suitability(params.channel, width, height)

    # 3. Product identity check
    confirmed_skus = (
        gateway.fetch_confirmed_sku_matches(params.media_asset_id) if params.media_asset_id else []
    )
    product_match = check_product_match(confirmed_skus, params.product_hint)

    # 4. Recent usage on channel check
    if params.media_asset_id:
        if params.within_days > 0:
            usage_info = None
            if hasattr(gateway, "usage_stats_on_channel"):
                res = gateway.usage_stats_on_channel(
                    params.media_asset_id, params.channel, within_days=params.within_days
                )
                if isinstance(res, dict):
                    usage_info = res
            if usage_info is None and hasattr(gateway, "recent_usage_on_channel"):
                res = gateway.recent_usage_on_channel(
                    params.media_asset_id, params.channel, within_days=params.within_days
                )
                if isinstance(res, dict):
                    usage_info = res
            if not isinstance(usage_info, dict):
                usage_info = {}

            raw_recent = usage_info.get("recent_count", usage_info.get("count", 0))
            try:
                recent_count = int(raw_recent)
            except (ValueError, TypeError):
                recent_count = 1 if usage_info.get("used") else 0

            raw_total = usage_info.get("total_count", recent_count)
            try:
                total_count = int(raw_total)
            except (ValueError, TypeError):
                total_count = recent_count

            last_used_at = usage_info.get("last_used_at")
            last_used_at_str = str(last_used_at) if last_used_at is not None else None
            is_used = bool(usage_info.get("used", recent_count > 0))

            recent_usage = RecentUsageCheck(
                used=is_used,
                usage_count=recent_count,
                recent_count=recent_count,
                total_count=total_count,
                last_used_at=last_used_at_str,
                warning=(
                    f"Ảnh đã được đăng {recent_count} lần trên kênh {params.channel} "
                    f"trong {params.within_days} ngày qua."
                )
                if is_used
                else None,
            )
        else:
            # Rotation disabled (within_days == 0): fetch all-time stats without penalizing recency
            usage_info = None
            if hasattr(gateway, "usage_stats_on_channel"):
                res = gateway.usage_stats_on_channel(
                    params.media_asset_id, params.channel, within_days=0
                )
                if isinstance(res, dict):
                    usage_info = res
            if usage_info is None and hasattr(gateway, "recent_usage_on_channel"):
                res = gateway.recent_usage_on_channel(
                    params.media_asset_id, params.channel, within_days=0
                )
                if isinstance(res, dict):
                    usage_info = res
            if not isinstance(usage_info, dict):
                usage_info = {}

            raw_total = usage_info.get("total_count", usage_info.get("count", 0))
            try:
                total_count = int(raw_total)
            except (ValueError, TypeError):
                total_count = 0

            last_used_at = usage_info.get("last_used_at")
            last_used_at_str = str(last_used_at) if last_used_at is not None else None

            recent_usage = RecentUsageCheck(
                used=False,
                usage_count=0,
                recent_count=0,
                total_count=total_count,
                last_used_at=last_used_at_str,
                warning=None,
            )
    else:
        recent_usage = RecentUsageCheck(used=False)

    # 5. AI Vision LLM fit evaluation (Fail-closed)
    fit_verdict: dict[str, Any]
    try:
        v_config = gateway.shared_vision_config()
        # Decrypt API key using shared_vision_config decryptor
        from app.shared_vision_config import _decrypt_api_key

        api_key = _decrypt_api_key(v_config)
        base_url = v_config.get("base_url")
        model = v_config.get("model")

        msgs = fit_messages(params.article_text, image_data_url, params.product_hint)
        fit_verdict = call_vision_fit(base_url, api_key, model, msgs)
    except Exception as exc:
        # Fail closed on Vision failure
        fit_verdict = {
            "fit_grade": 0,
            "fit_label": "Irrelevant",
            "rationale": f"Lỗi gọi AI Vision ({exc}); cần kiểm duyệt thủ công.",
            "relevance_score": 0.0,
            "context_explanation": "Không thể phân tích ngữ cảnh ảnh qua Vision API.",
            "visual_subject": None,
        }

    grade = fit_verdict["fit_grade"]
    label = fit_verdict["fit_label"]
    rationale = fit_verdict["rationale"]

    # If product hint was explicitly given but mismatched, cap grade to max 1
    if params.product_hint and not product_match.matched and grade > 1:
        grade = 1
        label = "Marginally Relevant"
        rationale += f" (Hạ điểm xuống 1 do không khớp với sản phẩm '{params.product_hint}')."

    # If already used recently, note in rationale
    if recent_usage.used:
        rationale += f" [CẢNH BÁO: Đã dùng trên kênh {params.channel} gần đây]."

    context_rel = ContextRelevance(
        relevance_score=fit_verdict["relevance_score"],
        explanation=fit_verdict["context_explanation"],
        visual_subject=fit_verdict["visual_subject"],
    )

    # Markdown summary construction
    md_lines = [
        f"### Đánh giá độ phù hợp: **{grade}/3 ({label})**",
        f"- **Giải trình:** {rationale}",
        f"- **Chủ thể phát hiện:** {context_rel.visual_subject or 'Chưa xác định'}",
        f"- **Quy cách kênh ({params.channel}):** Tỷ lệ `{tech_suitability.aspect_ratio}` — {tech_suitability.recommendation}",
        f"- **Kiểm tra SKU:** {product_match.details}",
    ]
    if recent_usage.used:
        md_lines.append(f"- ⚠️ **Lịch sử đăng bài:** {recent_usage.warning}")
    elif params.within_days > 0:
        md_lines.append(f"- **Lịch sử đăng bài:** Chưa đăng trên kênh {params.channel} trong {params.within_days} ngày qua (An toàn).")
    else:
        md_lines.append(f"- **Lịch sử đăng bài:** Kiểm tra chu kỳ ngày tắt (exclude_used_within_days=0).")

    return EvaluateImageFitOutput(
        media_asset_id=params.media_asset_id,
        fit_grade=grade,
        fit_label=label,
        rationale=rationale,
        context_relevance=context_rel,
        technical_suitability=tech_suitability,
        product_match=product_match,
        already_used_recently=recent_usage,
        markdown_summary="\n".join(md_lines),
    )


def extract_search_query(post_text: str, product_hint: str | None = None) -> str:
    """Extract a concise search retrieval query from post or article text."""
    lines = [ln.strip() for ln in post_text.splitlines() if ln.strip()]
    first_line = lines[0] if lines else ""

    # Strip markdown headers, bullets, and formatting markers
    clean = re.sub(r"^[#\s*\->]+", "", first_line).strip()
    clean = re.sub(r"[*_~`]", "", clean).strip()

    sentence_parts = re.split(r"[.!?]\s+", clean)
    extracted = sentence_parts[0].strip() if sentence_parts else clean
    if len(extracted) > 120:
        extracted = extracted[:120].rsplit(" ", 1)[0]

    if product_hint:
        hint_clean = product_hint.strip()
        if hint_clean.lower() not in extracted.lower():
            extracted = f"{hint_clean} {extracted}".strip()

    return extracted or product_hint or "thiết bị thông minh"


def render_find_best_markdown(output: FindBestImageOutput, min_fit_grade: int) -> str:
    """Format human-readable markdown recommendations for FindBestImageOutput."""
    lines = [f"## Khuyến nghị ảnh đăng bài ({output.channel.upper()})"]
    if output.best_pick:
        bp = output.best_pick
        lines.extend([
            f"\n### 🌟 Ảnh tối ưu nhất: **{bp.title}**",
            f"- **Asset ID:** `{bp.asset_id}`",
            f"- **Độ phù hợp:** **{bp.fit_grade}/3 ({bp.fit_label})**",
            f"- **Giải trình:** {bp.rationale}",
            f"- **SKU khớp:** {', '.join(bp.matched_skus) if bp.matched_skus else '—'}",
        ])
        if bp.technical_suitability:
            lines.append(
                f"- **Quy cách kênh:** Tỷ lệ `{bp.technical_suitability.aspect_ratio}` — {bp.technical_suitability.recommendation}"
            )
        if bp.thumbnail_url:
            lines.append(f"- **Thumbnail:** {bp.thumbnail_url}")
        if bp.file_url:
            lines.append(f"- **File tải về:** {bp.file_url}")
    else:
        lines.append(
            f"\n⚠️ **Không tìm thấy ảnh đạt chuẩn:** Không có ứng viên nào đạt mức tối thiểu "
            f"**{min_fit_grade}/3** và thỏa mãn quy tắc sử dụng trên kênh {output.channel}."
        )

    if output.ranked_candidates:
        lines.extend([
            f"\n### Danh sách ứng viên đã đánh giá ({output.total_evaluated})",
            "| # | Tiêu đề | Grade | Trạng thái sử dụng | Điểm search | Ghi chú |",
            "|---|---------|-------|-------------------|-------------|---------|",
        ])
        for idx, cand in enumerate(output.ranked_candidates, 1):
            if cand.already_used_recently:
                used_str = "⚠️ Đã dùng gần đây"
            elif cand.total_usage_count > 0:
                used_str = "🔄 Đã dùng trước đó"
            else:
                used_str = "✅ Chưa dùng"
            skus = f"[{', '.join(cand.matched_skus)}] " if cand.matched_skus else ""
            notes = f"{skus}{cand.rationale[:45]}..." if len(cand.rationale) > 45 else f"{skus}{cand.rationale}"
            lines.append(
                f"| {idx} | `{cand.asset_id[:8]}` {cand.title[:25]} | {cand.fit_grade}/3 ({cand.fit_label}) | {used_str} | {cand.score:.2f} | {notes} |"
            )
    else:
        lines.append("\n*Không tìm thấy ứng viên nào từ thư viện.*")

    return "\n".join(lines)


def find_best_image(
    gateway: Any,
    settings: Any,
    search_fn: Callable[[MediaSearchInput], Any],
    params: FindBestImageInput,
) -> FindBestImageOutput:
    """Orchestrate search candidate retrieval, image-fit evaluation, and optimal candidate selection."""
    query = (
        params.search_query.strip()
        if params.search_query and params.search_query.strip()
        else extract_search_query(params.post_text, params.product_hint)
    )

    search_req = MediaSearchInput(
        query=query,
        limit=params.candidate_count,
    )

    raw_candidates = []
    try:
        search_res = search_fn(search_req)
        raw_candidates = getattr(search_res, "results", [])
    except Exception:
        raw_candidates = []

    # Fallback to product_hint query if primary search produced zero candidates
    if not raw_candidates and params.product_hint and query.lower() != params.product_hint.lower():
        try:
            fallback_res = search_fn(
                MediaSearchInput(
                    query=params.product_hint.strip(),
                    limit=params.candidate_count,
                )
            )
            raw_candidates = getattr(fallback_res, "results", [])
        except Exception:
            raw_candidates = []

    ranked: list[CandidateFit] = []
    for cand in raw_candidates:
        eval_req = EvaluateImageFitInput(
            article_text=params.post_text,
            media_asset_id=cand.asset_id,
            channel=params.channel,
            within_days=params.exclude_used_within_days,
            product_hint=params.product_hint,
        )
        try:
            eval_res = evaluate_image_fit(gateway, settings, eval_req)
        except Exception as exc:
            eval_res = EvaluateImageFitOutput(
                media_asset_id=cand.asset_id,
                fit_grade=0,
                fit_label="Irrelevant",
                rationale=f"Đánh giá thất bại: {exc}",
                context_relevance=ContextRelevance(relevance_score=0.0, explanation=str(exc)),
                technical_suitability=TechnicalSuitability(channel=params.channel, suitable_for_feed=False),
                product_match=ProductMatch(matched=False, details="Lỗi"),
                already_used_recently=RecentUsageCheck(used=False),
            )

        cand_fit = CandidateFit(
            asset_id=cand.asset_id,
            title=cand.title,
            fit_grade=eval_res.fit_grade,
            fit_label=eval_res.fit_label,
            score=getattr(cand, "score", 1.0),
            rationale=eval_res.rationale,
            thumbnail_url=getattr(cand, "thumbnail_url", None),
            file_url=getattr(cand, "file_url", None),
            matched_skus=[m.code for m in getattr(cand, "canonical_sku_matches", [])],
            already_used_recently=eval_res.already_used_recently.used,
            total_usage_count=eval_res.already_used_recently.total_count,
            last_used_at=eval_res.already_used_recently.last_used_at,
            technical_suitability=eval_res.technical_suitability,
        )
        ranked.append(cand_fit)

    # 1. Quality Gate: Candidates meeting min_fit_grade qualify for selection
    qualifying = [c for c in ranked if c.fit_grade >= params.min_fit_grade]
    rejected = [c for c in ranked if c.fit_grade < params.min_fit_grade]

    if not qualifying:
        ordered_qualifying: list[CandidateFit] = []
    elif params.exclude_used_within_days == 0:
        # Explicit opt-out from usage-based rotation: pure quality + search score
        ordered_qualifying = sorted(
            qualifying,
            key=lambda c: (-c.fit_grade, -c.score),
        )
    else:
        # 3-Tier Rotation: never_used > outside_window > recent (LRU fallback)
        never_used = sorted(
            [c for c in qualifying if c.total_usage_count == 0],
            key=lambda c: (-c.fit_grade, -c.score),
        )
        outside_window = sorted(
            [
                c for c in qualifying
                if c.total_usage_count > 0 and not c.already_used_recently
            ],
            key=lambda c: (
                c.last_used_at or "9999-12-31T23:59:59+00:00",
                -c.fit_grade,
                -c.score,
            ),
        )
        recent = sorted(
            [c for c in qualifying if c.already_used_recently],
            key=lambda c: (
                c.last_used_at or "9999-12-31T23:59:59+00:00",
                -c.fit_grade,
                -c.score,
            ),
        )
        ordered_qualifying = never_used + outside_window + recent

    ordered_rejected = sorted(rejected, key=lambda c: (-c.fit_grade, -c.score))
    all_ranked = ordered_qualifying + ordered_rejected
    best_pick = ordered_qualifying[0] if ordered_qualifying else None

    output = FindBestImageOutput(
        best_pick=best_pick,
        ranked_candidates=all_ranked,
        total_evaluated=len(all_ranked),
        channel=params.channel,
    )
    output.markdown_summary = render_find_best_markdown(output, params.min_fit_grade)
    return output
