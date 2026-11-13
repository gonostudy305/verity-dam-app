"""Embedding ảnh cho SKU-matching. Model tự host -- CLIP ViT-B/32 (512 chiều),
không phải PhoBERT (PhoBERT là model text, dành cho semantic search câu tiếng
Việt ở tầng khác, không so ảnh với ảnh). Tải model 1 lần, dùng lại cho mọi lần
embed trong tiến trình."""

from io import BytesIO

from PIL import Image, ImageOps
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    pass

_model = None


def _get_model():
    global _model
    if _model is None:
        # Lazy import keeps the API-only production worker free of torch and
        # sentence-transformers. This module is for the personal local profile.
        from sentence_transformers import SentenceTransformer

        _model = SentenceTransformer("clip-ViT-B-32")
    return _model


def embed_image(path):
    """Trả về vector 512 chiều, đã chuẩn hoá (unit vector) -- để pgvector's
    cosine distance (`<=>`) và phép trừ 1-distance cho ra similarity đúng nghĩa."""
    model = _get_model()
    with Image.open(path) as source:
        img = ImageOps.exif_transpose(source).convert("RGB")
        return model.encode(img, convert_to_numpy=True, normalize_embeddings=True)


def embed_image_bytes(payload: bytes):
    """Embed a catalog reference without persisting an untrusted download to disk."""
    with Image.open(BytesIO(payload)) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
        return _get_model().encode(image, convert_to_numpy=True, normalize_embeddings=True)


def parse_embedding(raw) -> list[float]:
    """Read back a pgvector value returned by PostgreSQL as a literal string
    "[0.1,0.2,...]", not JSON, so this can't just be `list(raw)` for that case."""
    if isinstance(raw, str):
        return [float(x) for x in raw.strip("[]").split(",") if x]
    return list(raw)


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Plain cosine similarity for two already-fetched vectors. Both CLIP vectors
    coming out of this module are already unit-normalised, but this does not
    assume that -- callers passing raw pgvector reads back get a correct result
    either way."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(x * x for x in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)
