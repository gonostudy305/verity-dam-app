"""Image-only processing for pHash, API embedding input, and renditions."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
from typing import Callable

import imagehash
from PIL import Image, ImageOps

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:
    pass

from app.embed import embed_image


def image_features(
    path: Path,
    embedder: Callable[[bytes, str], list[float]] | None = None,
) -> tuple[str, list[float], int, int]:
    """Return pHash plus an embedding.

    Production passes the API embedder. The no-argument form is only for
    personal local CLIP tooling and must not write to the production database.
    """
    with Image.open(path) as image:
        image = ImageOps.exif_transpose(image).convert("RGB")
        width, height = image.size
        phash = str(imagehash.phash(image, hash_size=8)).lower()
    if embedder is None:
        embedding = embed_image(path)
        values = embedding.tolist()
    else:
        values = embedder(path.read_bytes(), "image/jpeg")
    return phash, [float(value) for value in values], width, height


def wordpress_rendition(payload: bytes, maximum_edge: int = 2560) -> tuple[bytes, int, int, str]:
    """Make the cacheable public derivative; originals remain in private storage."""
    with Image.open(BytesIO(payload)) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
        image.thumbnail((maximum_edge, maximum_edge), Image.Resampling.LANCZOS)
        output = BytesIO()
        image.save(output, format="JPEG", quality=88, optimize=True, progressive=True)
        return output.getvalue(), image.width, image.height, "image/jpeg"


def vision_rendition(payload: bytes, maximum_edge: int = 1600, maximum_bytes: int = 4_000_000) -> tuple[bytes, str]:
    """Bound the vision request without changing the original used by embedding/pHash."""
    with Image.open(BytesIO(payload)) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
        image.thumbnail((maximum_edge, maximum_edge), Image.Resampling.LANCZOS)
        for quality in (84, 76, 68, 60):
            output = BytesIO()
            image.save(output, format="JPEG", quality=quality, optimize=True, progressive=True)
            if output.tell() <= maximum_bytes:
                return output.getvalue(), "image/jpeg"
    raise ValueError("Image remains larger than the Vision request limit after compression")


from dataclasses import dataclass
import hashlib
import re
import unicodedata
from typing import Any
from xml.sax.saxutils import escape as xml_escape

CANONICAL_TARGET_WIDTHS = (480, 800, 1600)
DEFAULT_WEBP_QUALITY = 82
DEFAULT_WEBP_METHOD = 4
PUBLICATION_PIPELINE_VERSION = "v2.2"
TARGET_WIDTH_POLICY_VERSION = 1
METADATA_SCHEMA_VERSION = 1
MAX_ICC_PROFILE_BYTES = 128 * 1024  # 128 KB sanity ceiling
DEFAULT_CREATOR = "VerityDAM Platform"
DEFAULT_CREDIT = "VerityDAM Platform"
DEFAULT_COPYRIGHT = "Copyright 2026 VerityDAM Platform. All rights reserved."
DEFAULT_AI_SOURCE_TYPE = "https://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"
DEFAULT_REAL_SOURCE_TYPE = "https://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture"
DEFAULT_LICENSE_URL = "https://veritydam.example/chinh-sach-ban-quyen-hinh-anh"
DEFAULT_LICENSOR_NAME = "VerityDAM Platform"
DEFAULT_LICENSOR_URL = "https://veritydam.example/cap-phep-hinh-anh"


def extract_safe_icc_profile(image_or_bytes: Any) -> bytes | None:
    """Extract and validate safe ICC color profile from an Image or raw bytes.

    Returns None if:
    - No ICC profile is present
    - Profile length is outside [128, MAX_ICC_PROFILE_BYTES]
    - Header does not match standard 'acsp' ICC signature at bytes 36..40
    """
    raw: Any = None
    if isinstance(image_or_bytes, (bytes, bytearray, memoryview)):
        b = bytes(image_or_bytes)
        if len(b) >= 128 and b[36:40] == b"acsp":
            raw = b
        else:
            try:
                with Image.open(BytesIO(b)) as img:
                    raw = img.info.get("icc_profile")
            except Exception:
                raw = None
    elif hasattr(image_or_bytes, "info") and isinstance(image_or_bytes.info, dict):
        raw = image_or_bytes.info.get("icc_profile")

    if not isinstance(raw, bytes):
        return None

    if len(raw) < 128 or len(raw) > MAX_ICC_PROFILE_BYTES:
        return None

    # Verify standard ICC header signature 'acsp'
    if raw[36:40] != b"acsp":
        return None

    return raw


def get_canonical_encoder_identity() -> str:
    """Resolve standard Pillow and libwebp encoder version strings via public API."""
    import PIL
    from PIL import features
    webp_ver = features.version("webp") or ""
    return f"pillow-{PIL.__version__}-webp-{webp_ver}"


@dataclass(frozen=True)
class CanonicalRendition:
    width: int
    height: int
    payload: bytes
    size_bytes: int
    format: str
    mime_type: str
    purpose: str


def target_widths(original_width: int) -> list[int]:
    """Calculate deterministic responsive target widths without upscaling.

    Invariant:
    - If original_width < 480: returns [original_width]
    - Returns subsets of (480, 800, 1600) strictly smaller than original_width
    - Always appends the largest usable size (original_width if <= 1600, else 1600)
    """
    if original_width < 480:
        return [original_width]
    widths = [w for w in (480, 800, 1600) if w < original_width]
    if original_width <= 1600:
        widths.append(original_width)
    else:
        widths.append(1600)
    return sorted(set(widths))


def _canonical_text(value: Any) -> str:
    text = str(value or "").strip()
    return "" if text in {"", "—", "-"} else text


def is_generic_or_raw_title(title: str | None) -> bool:
    """Identify names that must not become the only canonical SEO signal.

    This is deliberately mirrored by ``src/lib/image-slug.ts``.  A raw title
    is still retained as a last resort; it is replaced only when the asset has
    stronger reviewed metadata (SKU, brand, category/space, or caption).
    """

    text = _canonical_text(title)
    if not text or text.lower() in {"upload", "untitled"}:
        return True
    if re.match(
        r"^(chatgpt\s*image|thiet[-_\s]*ke[-_\s]*chua[-_\s]*co[-_\s]*ten|thiết\s*kế\s*chưa\s*có\s*tên|img[-_]|dsc[-_]|pxl[-_]|screenshot|screen\s*shot|capture|image[-_]|asset[-_]|z\d{6,})",
        text,
        flags=re.IGNORECASE,
    ):
        return True
    if re.search(r"\.(png|jpe?g|webp|gif|heic|heif|bmp|tiff|svg)$", text, flags=re.IGNORECASE):
        return True
    if re.fullmatch(r"\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}|\d{2,4}x\d{2,4}(?:\s*\(\d+\))?", text, flags=re.IGNORECASE):
        return True
    return False


def _first_clause(value: Any) -> str:
    text = _canonical_text(value)
    return re.split(r"[.,;\n]", text, maxsplit=1)[0].strip()


def compose_canonical_title(asset: dict[str, Any]) -> str:
    """Use reviewed identity/context whenever the upload title is raw."""

    title = _canonical_text(asset.get("title"))
    if title and not is_generic_or_raw_title(title):
        return title
    brand = _canonical_text(asset.get("brand"))
    sku = _canonical_text(asset.get("sku"))
    identity: list[str] = []
    if sku and brand and sku.casefold().startswith(brand.casefold() + " "):
        identity.append(sku)
    else:
        if brand:
            identity.append(brand)
        if sku:
            identity.append(sku)
    context = _canonical_text(asset.get("space")) or _canonical_text(asset.get("category"))
    if identity and context:
        return f"{' '.join(identity)} - {context}"
    if identity:
        caption = _first_clause(asset.get("suggested_caption") or asset.get("description"))
        return f"{' '.join(identity)} - {caption}" if caption else " ".join(identity)
    category = _canonical_text(asset.get("category"))
    space = _canonical_text(asset.get("space"))
    no_entity_parts = [p for p in [category, space] if p and p != "—"]
    if no_entity_parts:
        return " - ".join(no_entity_parts)
    return _first_clause(asset.get("suggested_caption") or asset.get("description")) or title


def build_public_image_slug(asset: dict[str, Any]) -> str:
    """Build the universal canonical slug shared with the TypeScript UI.

    URL identity intentionally combines stable source fingerprint with this
    human-readable slug, so a title edit never overwrites an old CDN object.
    """

    brand = _canonical_text(asset.get("brand"))
    sku = _canonical_text(asset.get("sku"))
    title = _canonical_text(asset.get("title"))
    if is_generic_or_raw_title(title):
        candidate = compose_canonical_title(asset)
        if candidate and not is_generic_or_raw_title(candidate):
            title = candidate

    identity: list[str] = []
    if sku and brand and sku.casefold().startswith(brand.casefold() + " "):
        identity.append(sku)
    else:
        if brand:
            identity.append(brand)
        if sku:
            identity.append(sku)

    # Avoid common slug duplication: a product title often repeats its brand
    # and SKU.  Identity remains present at the beginning of the URL.
    for entity in identity:
        title = re.sub(re.escape(entity), " ", title, flags=re.IGNORECASE)
    title = re.sub(r"\s+", " ", title).strip(" -")

    parts = identity + ([title] if title else [])
    if not parts:
        parts.append(str(asset.get("id") or "asset")[:8])

    combined = " ".join(parts).replace("đ", "d").replace("Đ", "D")
    normalized = unicodedata.normalize("NFKD", combined)
    without_diacritics = "".join(c for c in normalized if not unicodedata.combining(c))
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", without_diacritics).strip("-").lower()
    return slug[:120].strip("-") or "asset"


def build_rendition_fingerprint(
    source_bytes: bytes,
    asset_metadata: dict[str, Any],
    pipeline_version: str = PUBLICATION_PIPELINE_VERSION,
    target_width_policy_version: int = TARGET_WIDTH_POLICY_VERSION,
    webp_quality: int = DEFAULT_WEBP_QUALITY,
    webp_method: int = DEFAULT_WEBP_METHOD,
    metadata_schema_version: int = METADATA_SCHEMA_VERSION,
    encoder_identity: str | None = None,
) -> str:
    """Generate deterministic 64-bit (16-hex) fingerprint across byte hash, metadata, and pipeline policy."""
    source_sha256 = hashlib.sha256(source_bytes).hexdigest()
    is_ai = bool(
        asset_metadata.get("is_ai")
        or (isinstance(asset_metadata.get("ai_flags"), dict) and asset_metadata["ai_flags"].get("is_ai"))
    )
    digital_source_type = str(
        asset_metadata.get("digital_source_type")
        or (DEFAULT_AI_SOURCE_TYPE if is_ai else DEFAULT_REAL_SOURCE_TYPE)
    )

    safe_icc = extract_safe_icc_profile(source_bytes)
    icc_sha256 = hashlib.sha256(safe_icc).hexdigest() if safe_icc else ""

    resolved_encoder = encoder_identity or get_canonical_encoder_identity()

    raw_kw = asset_metadata.get("keywords") or []
    if isinstance(raw_kw, (list, tuple)):
        kw_normalized = ",".join(sorted(str(k).strip() for k in raw_kw if str(k).strip()))
    else:
        kw_normalized = str(raw_kw).strip()

    web_statement = str(asset_metadata.get("web_statement_url") or asset_metadata.get("license_url") or "").strip()
    licensor_name = str(asset_metadata.get("licensor_name") or "")
    licensor_url = str(asset_metadata.get("acquire_license_page") or asset_metadata.get("licensor_url") or "").strip()

    fields = [
        source_sha256,
        str(asset_metadata.get("title") or ""),
        str(asset_metadata.get("suggested_caption") or asset_metadata.get("description") or ""),
        str(asset_metadata.get("author") or DEFAULT_CREATOR),
        str(asset_metadata.get("credit") or DEFAULT_CREDIT),
        str(asset_metadata.get("copyright") or DEFAULT_COPYRIGHT),
        str(asset_metadata.get("brand") or ""),
        str(asset_metadata.get("sku") or ""),
        kw_normalized,
        str(is_ai),
        digital_source_type,
        str(pipeline_version),
        str(target_width_policy_version),
        str(webp_quality),
        str(webp_method),
        metadata_schema_version,
        resolved_encoder,
        icc_sha256,
        web_statement,
        licensor_name,
        licensor_url,
    ]
    raw = "\n".join(str(f) for f in fields).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def _to_ascii_safe(text: str) -> str:
    text = text.replace("đ", "d").replace("Đ", "D")
    normalized = unicodedata.normalize("NFKD", text)
    without_marks = "".join(c for c in normalized if not unicodedata.combining(c))
    sanitized = without_marks.replace("©", "(c)").replace("\u00a9", "(c)")
    return sanitized.encode("ascii", "ignore").decode("ascii")


def build_canonical_metadata_packages(asset_metadata: dict[str, Any]) -> tuple[bytes, Image.Exif]:
    """Construct rights & provenance XMP packet and compatibility EXIF with privacy allowlist."""
    creator = xml_escape(str(asset_metadata.get("author") or DEFAULT_CREATOR))
    credit = xml_escape(str(asset_metadata.get("credit") or DEFAULT_CREDIT))
    copyright_notice = xml_escape(str(asset_metadata.get("copyright") or DEFAULT_COPYRIGHT))
    description = xml_escape(str(asset_metadata.get("suggested_caption") or asset_metadata.get("description") or asset_metadata.get("title") or ""))
    title_text = xml_escape(str(asset_metadata.get("title") or "").strip())

    raw_keywords = asset_metadata.get("keywords") or []
    if isinstance(raw_keywords, str):
        base_keywords = [k.strip() for k in raw_keywords.split(",") if k.strip()]
    elif isinstance(raw_keywords, (list, tuple)):
        base_keywords = [str(k).strip() for k in raw_keywords if str(k).strip()]
    else:
        base_keywords = []

    # Auto-enrich with Brand and SKU if available (e.g. "Verity SL108", "SL108", "Verity")
    brand = str(asset_metadata.get("brand") or "").strip()
    sku = str(asset_metadata.get("sku") or "").strip()

    merged_keywords: list[str] = []
    seen_kw: set[str] = set()

    candidates: list[str] = []
    if brand and sku:
        if sku.lower().startswith(brand.lower()):
            candidates.append(sku)
            bare_sku = sku[len(brand):].strip(" -_")
            if bare_sku:
                candidates.append(bare_sku)
        else:
            candidates.append(f"{brand} {sku}")
            candidates.append(sku)
    elif sku:
        candidates.append(sku)
    if brand:
        candidates.append(brand)
    candidates.extend(base_keywords)

    for cand in candidates:
        norm = cand.strip()
        if norm and norm.lower() not in seen_kw:
            seen_kw.add(norm.lower())
            merged_keywords.append(norm)

    keywords_list = [xml_escape(k) for k in merged_keywords]

    is_ai = bool(
        asset_metadata.get("is_ai")
        or (isinstance(asset_metadata.get("ai_flags"), dict) and asset_metadata["ai_flags"].get("is_ai"))
    )
    digital_source_type = str(asset_metadata.get("digital_source_type") or "").strip()
    if not digital_source_type:
        digital_source_type = DEFAULT_AI_SOURCE_TYPE if is_ai else DEFAULT_REAL_SOURCE_TYPE

    dst_tag = ""
    if digital_source_type:
        dst_tag = f"\n   <Iptc4xmpExt:DigitalSourceType>{xml_escape(digital_source_type)}</Iptc4xmpExt:DigitalSourceType>"

    title_tag = ""
    if title_text:
        title_tag = f"\n   <dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">{title_text}</rdf:li></rdf:Alt></dc:title>"

    subject_tag = ""
    if keywords_list:
        kw_items = "".join(f"\n     <rdf:li>{kw}</rdf:li>" for kw in keywords_list)
        subject_tag = f"\n   <dc:subject><rdf:Bag>{kw_items}\n   </rdf:Bag></dc:subject>"

    web_statement = str(asset_metadata.get("web_statement_url") or asset_metadata.get("license_url") or "").strip()
    licensor_name = xml_escape(str(asset_metadata.get("licensor_name") or (DEFAULT_CREATOR if web_statement else "")))
    licensor_url = str(
        asset_metadata.get("acquire_license_page")
        or asset_metadata.get("licensor_url")
        or (DEFAULT_LICENSOR_URL if web_statement else "")
    ).strip()

    license_tags = ""
    if web_statement:
        license_tags += f"\n   <xmpRights:WebStatement>{xml_escape(web_statement)}</xmpRights:WebStatement>"
        if licensor_name or licensor_url:
            license_tags += (
                f"\n   <plus:Licensor><rdf:Seq><rdf:li rdf:parseType=\"Resource\">"
                f"<plus:LicensorName>{licensor_name}</plus:LicensorName>"
                f"<plus:LicensorURL>{xml_escape(licensor_url)}</plus:LicensorURL>"
                f"</rdf:li></rdf:Seq></plus:Licensor>"
            )

    xmp_str = f"""<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
    xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/"
    xmlns:plus="http://ns.useplus.org/ldf/xmp/1.0/"
    xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/">
   <dc:creator><rdf:Seq><rdf:li>{creator}</rdf:li></rdf:Seq></dc:creator>{title_tag}
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">{description}</rdf:li></rdf:Alt></dc:description>{subject_tag}
   <photoshop:Credit>{credit}</photoshop:Credit>
   <dc:rights><rdf:Alt><rdf:li xml:lang="x-default">{copyright_notice}</rdf:li></rdf:Alt></dc:rights>
   <xmpRights:Marked>True</xmpRights:Marked>{license_tags}{dst_tag}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>"""
    xmp_bytes = xmp_str.encode("utf-8")

    # Strict Privacy Allowlist for EXIF (G6): only write description, artist, copyright, software, XP tags
    exif = Image.Exif()
    plain_desc = str(asset_metadata.get("suggested_caption") or asset_metadata.get("description") or asset_metadata.get("title") or "")
    plain_title = str(asset_metadata.get("title") or "").strip()
    if plain_desc:
        exif[0x010E] = _to_ascii_safe(plain_desc)[:250]  # ImageDescription (ASCII safe compatibility)
        exif[0x9C9C] = plain_desc[:500].encode("utf-16le")  # XPComment: UTF-16LE for Windows Explorer
    if plain_title:
        exif[0x9C9B] = plain_title[:250].encode("utf-16le")  # XPTitle: UTF-16LE for Windows Explorer
    elif plain_desc:
        exif[0x9C9B] = plain_desc[:250].encode("utf-16le")
    if merged_keywords:
        raw_kw_str = ";".join(merged_keywords)
        if raw_kw_str:
            exif[0x9C9E] = raw_kw_str[:300].encode("utf-16le")  # XPKeywords: UTF-16LE for Windows Explorer

    exif[0x013B] = _to_ascii_safe(str(asset_metadata.get("author") or DEFAULT_CREATOR))[:120]  # Artist
    exif[0x8298] = _to_ascii_safe(str(asset_metadata.get("copyright") or DEFAULT_COPYRIGHT))[:150]  # Copyright
    exif[0x0131] = "VerityDAM Studio v2.0"  # Software

    return xmp_bytes, exif


def generate_canonical_renditions(
    payload: bytes,
    asset_metadata: dict[str, Any] | None = None,
    quality: int = DEFAULT_WEBP_QUALITY,
    method: int = DEFAULT_WEBP_METHOD,
) -> list[CanonicalRendition]:
    """Generate responsive WebP renditions with embedded rights & AI disclosure metadata.

    Ensures:
    - G1: Format is strictly WebP (image/webp) with valid RIFF header
    - G2/G3: Target widths follow canonical target_widths without upscaling
    - G4: XMP + EXIF rights embedded
    - G5: AI disclosure (DigitalSourceType) propagated if marked as AI
    - G6: Private camera metadata (GPS, serials, MakerNotes) completely stripped
    """
    metadata = asset_metadata or {}
    xmp_bytes, exif = build_canonical_metadata_packages(metadata)

    with Image.open(BytesIO(payload)) as source:
        # Normalize EXIF orientation
        source = ImageOps.exif_transpose(source)
        # Retain alpha if present (RGBA/LA/P with transparency), else RGB
        if source.mode in ("RGBA", "LA") or (source.mode == "P" and "transparency" in source.info):
            base_image = source.convert("RGBA")
        else:
            base_image = source.convert("RGB")

        safe_icc = extract_safe_icc_profile(source)
        orig_w, orig_h = base_image.size
        widths = target_widths(orig_w)
        renditions: list[CanonicalRendition] = []

        for target_w in widths:
            if target_w == orig_w:
                target_img = base_image
                w, h = orig_w, orig_h
            else:
                scale = target_w / float(orig_w)
                h = max(1, round(orig_h * scale))
                w = target_w
                target_img = base_image.resize((w, h), Image.Resampling.LANCZOS)

            output = BytesIO()
            save_kwargs: dict[str, Any] = {
                "format": "WEBP",
                "quality": quality,
                "method": method,
                "exif": exif,
                "xmp": xmp_bytes,
            }
            if safe_icc is not None:
                save_kwargs["icc_profile"] = safe_icc

            target_img.save(output, **save_kwargs)
            raw_bytes = output.getvalue()
            if not raw_bytes.startswith(b"RIFF") or b"WEBP" not in raw_bytes[:16]:
                raise ValueError("Generated rendition failed magic WebP verification")

            renditions.append(
                CanonicalRendition(
                    width=w,
                    height=h,
                    payload=raw_bytes,
                    size_bytes=len(raw_bytes),
                    format="webp",
                    mime_type="image/webp",
                    purpose="web-responsive",
                )
            )

        return renditions
