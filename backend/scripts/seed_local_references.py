"""Create a personal local CLIP reference store without touching production."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import requests

from app.config import DATA_DIR
from app.catalog_normalization import catalog_brand, classify_catalog_sku, normalize_catalog_sku
from app.embed import embed_image_bytes


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed personal local CLIP references")
    parser.add_argument("--source", required=True, help="WooCommerce products.json")
    parser.add_argument("--output", default=str(DATA_DIR / "local_references.json"))
    parser.add_argument("--max-images", type=int, default=3)
    args = parser.parse_args()
    if not 1 <= args.max_images <= 10:
        raise SystemExit("--max-images must be between 1 and 10")

    products = json.loads(Path(args.source).read_text(encoding="utf-8"))
    rows = []
    for product in products:
        sku = normalize_catalog_sku(product.get("sku") if isinstance(product, dict) else None)
        if not sku:
            continue
        images = product.get("images") or []
        seen_urls: set[str] = set()
        selected_images = []
        for image in images:
            url = image.get("src") if isinstance(image, dict) else None
            if isinstance(url, str) and url.startswith("https://") and url not in seen_urls:
                seen_urls.add(url)
                selected_images.append(image)
            if len(selected_images) >= args.max_images:
                break
        for index, image in enumerate(selected_images):
            url = image.get("src") if isinstance(image, dict) else None
            if not isinstance(url, str) or not url.startswith("https://"):
                continue
            response = requests.get(url, timeout=30)
            response.raise_for_status()
            vector = embed_image_bytes(response.content)
            rows.append({
                "sku": sku.strip(),
                "sku_kind": classify_catalog_sku(sku),
                "brand": catalog_brand(product),
                "source_url": url,
                "embedding": [float(value) for value in vector.tolist()],
                "is_primary": index == 0,
                "profile": "local_clip",
                "model": "clip-ViT-B-32",
                "dimension": 512,
            })

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    print(f"Da ghi {len(rows)} local references vao {output}; khong cham vao production.")


if __name__ == "__main__":
    main()
