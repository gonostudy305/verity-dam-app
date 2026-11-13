"""Line-oriented production SKU matcher for the workstation importer.

Reads one JSON object per line from stdin and writes one JSON result per line.
It performs read-only nearest-reference matching against the canonical
SigLIP2 768-dim space; it never writes assets, vectors, or SKU links.
"""

from __future__ import annotations

import json
import math
import sys
from typing import Any

from verity_dam_mcp.auth import BotSession
from verity_dam_mcp.gateway import MediaMcpGateway
from verity_dam_mcp.settings import McpSettings

try:
    from app.catalog_text import sanitize_brand_prior
except ModuleNotFoundError:
    try:
        from backend.app.catalog_text import sanitize_brand_prior
    except ModuleNotFoundError:
        def sanitize_brand_prior(raw: Any) -> str | None:
            return raw.strip() if isinstance(raw, str) and raw.strip() else None

SPACE_ID = "verity-siglip2-b32-256-webli-v1"
DIMENSION = 768


def vector_literal(value: Any) -> str:
    if not isinstance(value, list) or len(value) != DIMENSION:
        raise ValueError(f"expected a {DIMENSION}-dimensional vector")
    if not all(isinstance(item, (int, float)) and math.isfinite(float(item)) for item in value):
        raise ValueError("vector contains non-finite values")
    return "[" + ",".join(format(float(item), ".9g") for item in value) + "]"


def match(gateway: MediaMcpGateway, vector: Any, brand: str | None = None) -> list[dict[str, Any]]:
    literal = vector_literal(vector)
    brand_param = sanitize_brand_prior(brand)
    rows = gateway.repository.fetch_all(
        """
        with raw_hits as (
            select r.sku, re.vector <=> %s::vector as dist
            from public.reference_embeddings re
            join public.sku_references r on r.reference_id = re.reference_id
            where re.space_id = %s
              and r.is_active = true
              and r.match_eligible = true
            order by dist
            limit 160
        ), raw_candidates as (
            select sku, min(dist) as min_dist
            from raw_hits
            group by sku
            order by min_dist
            limit 40
        ), scored as (
            select c.sku,
                   (1 - c.min_dist)::real as similarity
            from raw_candidates c
        )
        select s.sku, s.similarity,
               p.model_name, p.display_name, p.brand
        from scored s
        left join lateral (
            select model_name, display_name, brand
            from public.verity_products
            where lower(primary_sku) = lower(s.sku)
               or lower(code) = lower(s.sku)
               or s.sku = any(aliases)
            order by (lifecycle = 'active') desc, updated_at desc
            limit 1
        ) p on true
        order by (case when %s::text is not null and p.brand is not null and lower(trim(p.brand)) = lower(trim(%s::text)) then 1 else 0 end) desc,
                 s.similarity desc, s.sku
        limit 20
        """,
        (
            literal, SPACE_ID,
            brand_param, brand_param,
        ),
    )
    return rows


def main() -> None:
    settings = McpSettings.from_environment()
    gateway = MediaMcpGateway(settings, BotSession(settings))
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            try:
                payload = json.loads(line)
                vector = payload.get("vector")
                brand = payload.get("brand")
                result = {"candidates": match(gateway, vector, brand=brand)}
            except Exception as error:
                result = {"error": f"{type(error).__name__}: {error}"}
            print(json.dumps(result, ensure_ascii=False, separators=(",", ":")), flush=True)
    finally:
        gateway.repository.close()


if __name__ == "__main__":
    main()

