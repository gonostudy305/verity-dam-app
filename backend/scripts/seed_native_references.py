"""Seed native PostgreSQL SKU references with the production Jina CLIP space.

The command is intentionally a dry-run unless ``--confirm`` is supplied::

    python -m scripts.seed_native_references --source products.json
    python -m scripts.seed_native_references --source products.json --confirm

It reads WooCommerce image URLs and asks the same shared production embedding
configuration used by the native worker to create Jina CLIP v2 vectors.  Local
CLIP is not imported or used by this script.  Existing ``(sku, source_url)``
pairs are skipped only when their stored provider/model/version/dimension are
the production space returned by ``NativeGateway``.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse

from app.embedding_api import EmbeddingClient
from app.catalog_normalization import catalog_brand, classify_catalog_sku, normalize_catalog_sku
from app.native_gateway import NativeGateway
from app.production_config import WorkerSettings
from app.shared_embedding_config import apply_shared_embedding_config


DEFAULT_MAX_IMAGES = 3
MAX_ALLOWED_IMAGES = 10


@dataclass(frozen=True)
class SkuImages:
    """The deduplicated source images selected for one WooCommerce SKU."""

    sku: str
    display_name: str
    brand: str | None
    sku_kind: str
    urls: tuple[str, ...]


def parse_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Seed native production Jina CLIP v2 SKU references from WooCommerce"
    )
    parser.add_argument(
        "--source",
        default=os.environ.get("WOOCOMMERCE_DATALAKE", "").strip() or None,
        help="Path to WooCommerce products.json (defaults to WOOCOMMERCE_DATALAKE)",
    )
    parser.add_argument(
        "--limit-skus",
        type=int,
        default=0,
        help="Optional maximum number of unique SKUs to inspect; 0 means all",
    )
    parser.add_argument(
        "--offset-skus",
        type=int,
        default=0,
        help="Optional number of unique SKUs to skip before applying --limit-skus",
    )
    parser.add_argument(
        "--max-images",
        type=int,
        default=DEFAULT_MAX_IMAGES,
        help=f"Maximum HTTPS references per SKU (1..{MAX_ALLOWED_IMAGES}, default {DEFAULT_MAX_IMAGES})",
    )
    parser.add_argument(
        "--min-request-interval",
        type=float,
        default=4.5,
        help="Minimum seconds between embedding requests; protects the Jina token/minute quota",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--dry-run",
        dest="dry_run",
        action="store_true",
        help="Inspect and report planned references without embedding or writing (default)",
    )
    mode.add_argument(
        "--confirm",
        dest="dry_run",
        action="store_false",
        help="Call the production embedding API and write references",
    )
    parser.set_defaults(dry_run=True)
    args = parser.parse_args(argv)

    if not args.source:
        parser.error("--source is required when WOOCOMMERCE_DATALAKE is not set")
    if args.limit_skus < 0:
        parser.error("--limit-skus must be >= 0")
    if args.offset_skus < 0:
        parser.error("--offset-skus must be >= 0")
    if not 1 <= args.max_images <= MAX_ALLOWED_IMAGES:
        parser.error(f"--max-images must be between 1 and {MAX_ALLOWED_IMAGES}")
    if not 0 <= args.min_request_interval <= 60:
        parser.error("--min-request-interval must be between 0 and 60")
    return args


def load_products(source: str | Path) -> list[dict[str, Any]]:
    path = Path(source)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise SystemExit(f"Cannot read WooCommerce source {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise SystemExit(f"WooCommerce source is not valid JSON: {path}: {error}") from error
    if not isinstance(payload, list):
        raise SystemExit("WooCommerce source must be a JSON array")
    return [product for product in payload if isinstance(product, dict)]


def _https_image_url(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    url = value.strip()
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        return None
    return url


def image_urls(product: dict[str, Any], max_images: int) -> tuple[str, ...]:
    """Return unique, public HTTPS image URLs in WooCommerce order."""

    urls: list[str] = []
    seen: set[str] = set()
    for image in product.get("images") or []:
        if not isinstance(image, dict):
            continue
        url = _https_image_url(image.get("src"))
        if url and url not in seen:
            seen.add(url)
            urls.append(url)
        if len(urls) == max_images:
            break
    return tuple(urls)


def select_skus(products: Iterable[dict[str, Any]], max_images: int, limit_skus: int) -> list[SkuImages]:
    """Merge duplicate WooCommerce rows by SKU and retain catalog identity."""

    merged: dict[str, list[str]] = {}
    seen_urls: dict[str, set[str]] = {}
    display_names: dict[str, str] = {}
    brands: dict[str, str | None] = {}
    for product in products:
        sku = normalize_catalog_sku(product.get("sku"))
        if not sku:
            continue

        name = product.get("name")
        if isinstance(name, str):
            name = name.strip()[:300]
            if name and len(name) > len(display_names.get(sku, "")):
                display_names[sku] = name
            inferred_brand = catalog_brand(product)
            if inferred_brand and not brands.get(sku):
                brands[sku] = inferred_brand

        urls = merged.setdefault(sku, [])
        sku_seen = seen_urls.setdefault(sku, set())
        if len(urls) >= max_images:
            continue
        for url in image_urls(product, max_images):
            if url not in sku_seen:
                sku_seen.add(url)
                urls.append(url)
            if len(urls) == max_images:
                break

    selected = [
        SkuImages(
            sku=sku,
            display_name=display_names.get(sku, sku),
            brand=brands.get(sku),
            sku_kind=classify_catalog_sku(sku),
            urls=tuple(urls),
        )
        for sku, urls in merged.items()
        if urls
    ]
    return selected[:limit_skus] if limit_skus else selected


def source_sku_summary(products: Iterable[dict[str, Any]], max_images: int) -> tuple[int, int, int]:
    """Return source row count, unique SKU count, and unique SKUs with images."""

    rows = 0
    skus: set[str] = set()
    image_skus: set[str] = set()
    for product in products:
        if not isinstance(product, dict):
            continue
        rows += 1
        sku = normalize_catalog_sku(product.get("sku"))
        if not sku:
            continue
        skus.add(sku)
        if image_urls(product, max_images):
            image_skus.add(sku)
    return rows, len(skus), len(image_skus)


def main(argv: list[str] | None = None) -> int:
    args = parse_arguments(argv)
    products = load_products(args.source)
    source_rows, source_skus, source_image_skus = source_sku_summary(products, args.max_images)
    selected = select_skus(products, args.max_images, 0)
    if args.offset_skus:
        selected = selected[args.offset_skus :]
    if args.limit_skus:
        selected = selected[: args.limit_skus]

    settings = WorkerSettings.from_environment()
    # This command only touches PostgreSQL. Passing a sentinel storage object
    # keeps it usable on the VPS even when the worker's R2 publication settings
    # are not loaded in the shell running the one-off catalog import.
    gateway = NativeGateway(settings, storage=object())
    failed = 0
    seeded = 0
    skipped = 0
    try:
        shared_config = gateway.shared_embedding_config()
        embedding_settings = apply_shared_embedding_config(settings, shared_config)
        existing = gateway.list_existing_production_reference_pairs()
        planned = [
            (item.sku, url)
            for item in selected
            for url in item.urls
            if (item.sku, url) not in existing
        ]
        planned_pairs = set(planned)
        skipped = sum(len(item.urls) for item in selected) - len(planned)

        mode = "DRY-RUN" if args.dry_run else "CONFIRM"
        print(
            f"[{mode}] source={source_rows} rows/{source_skus} SKU "
            f"({source_image_skus} SKU co anh HTTPS), selected={len(selected)} SKU, "
            f"{len(planned)} reference pending, "
            f"{skipped} existing in production embedding space"
        )
        if args.dry_run:
            for sku, url in planned:
                print(f"  [plan] {sku} <- {url}")
            return 0

        embedding_client = EmbeddingClient(embedding_settings)
        existing_skus = {existing_sku for existing_sku, _ in existing}
        planned_index = 0
        last_request_at = 0.0
        for item in selected:
            try:
                gateway.upsert_catalog_product(
                    sku=item.sku,
                    display_name=item.display_name,
                    brand=item.brand,
                    model_name=item.sku if item.sku_kind == "model_name" else None,
                    catalog_sku_kind=item.sku_kind,
                )
            except Exception as error:  # noqa: BLE001 - continue the batch and report failures
                failed += 1
                print(f"  [!] {item.sku} product: {type(error).__name__}: {error}")
                continue

            for url in item.urls:
                if (item.sku, url) not in planned_pairs:
                    continue
                planned_index += 1
                try:
                    wait_for = args.min_request_interval - (time.monotonic() - last_request_at)
                    if wait_for > 0:
                        time.sleep(wait_for)
                    last_request_at = time.monotonic()
                    vector = embedding_client.embed_image_url(url)
                    gateway.insert_catalog_reference(
                        sku=item.sku,
                        source_url=url,
                        embedding=vector,
                        is_primary=item.sku not in existing_skus,
                    )
                    existing.add((item.sku, url))
                    existing_skus.add(item.sku)
                    seeded += 1
                    print(f"  [{planned_index}/{len(planned)}] {item.sku} <- {url}")
                except Exception as error:  # noqa: BLE001 - continue the batch and report failures
                    message = str(error)
                    if "AUTHZ_INSUFFICIENT_BALANCE" in message or "insufficient account balance" in message.lower():
                        raise SystemExit(
                            "Jina balance is insufficient; top up the production account and resume the same partitions"
                        ) from error
                    failed += 1
                    print(f"  [!] {item.sku} <- {url}: {type(error).__name__}: {error}")
            try:
                gateway.ensure_catalog_reference_primary(item.sku)
            except Exception as error:  # noqa: BLE001 - continue the batch and report failures
                failed += 1
                print(f"  [!] {item.sku} primary: {type(error).__name__}: {error}")

        print(f"Hoan tat: {seeded} reference da ghi, {failed} loi, {skipped} bo qua.")
        return 1 if failed else 0
    finally:
        gateway.close()


if __name__ == "__main__":
    raise SystemExit(main())
