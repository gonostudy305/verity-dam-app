"""
Re-rank and refresh AI candidate suggestions for pending items in review_queue.

Usage:
    python -m scripts.re_rank_pending_review_queue [--confirm]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import psycopg2
from psycopg2.extras import RealDictCursor

SPACE_ID = "verity-siglip2-b32-256-webli-v1"
DIMENSION = 768


def vector_literal(value: list[float]) -> str:
    if not isinstance(value, list) or len(value) != DIMENSION:
        raise ValueError(f"expected a {DIMENSION}-dimensional vector")
    return "[" + ",".join(format(float(item), ".9g") for item in value) + "]"


def match_candidates(cursor, vector_str: str, brand: str | None) -> list[dict]:
    brand_param = brand.strip() if brand and brand.strip() and brand.strip().upper() != "Verity" else None
    query = """
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
    limit 20;
    """
    cursor.execute(query, (vector_str, SPACE_ID, brand_param, brand_param))
    return cursor.fetchall()


def gate_candidates(candidates: list[dict]) -> dict:
    if not candidates:
        return {
            "sku": None,
            "similarity": None,
            "confidence_band": "unmatched",
            "requires_reviewer_confirmation": True,
            "candidates": [],
            "catalog_candidates": [],
        }
    winner = candidates[0]
    runner_up = candidates[1] if len(candidates) > 1 else None
    sim = float(winner["similarity"])
    runner_sim = float(runner_up["similarity"]) if runner_up else 0.0
    margin = sim - runner_sim

    if sim >= 0.90:
        band = "high"
    elif sim >= 0.70:
        band = "low"
    else:
        band = "unmatched"

    ambiguity = margin < 0.08 if len(candidates) > 1 else False
    requires_confirmation = True if (ambiguity or band != "high") else False

    payload = {
        "sku": winner["sku"],
        "similarity": sim,
        "runner_up_similarity": runner_sim,
        "margin": margin,
        "source": "embedding_reference",
        "confidence_band": band,
        "ambiguity_warning": ambiguity,
        "requires_reviewer_confirmation": requires_confirmation,
        "candidates": [
            {"sku": c["sku"], "similarity": float(c["similarity"])}
            for c in candidates[:5]
        ],
        "catalog_candidates": [
            {
                "sku": c["sku"],
                "similarity": float(c["similarity"]),
                "brand": c.get("brand"),
                "model_name": c.get("model_name"),
                "display_name": c.get("display_name"),
            }
            for c in candidates[:5]
        ],
    }
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Re-rank pending review queue items.")
    parser.add_argument("--confirm", action="store_true", help="Commit changes to database")
    args = parser.parse_args()

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL environment variable is required", file=sys.stderr)
        sys.exit(1)

    conn = psycopg2.connect(db_url)
    conn.autocommit = False

    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # 1. Fetch pending review queue items with their asset vector and brand
            cur.execute("""
                SELECT 
                    rq.id as queue_id,
                    rq.media_asset_id,
                    rq.sku_match as old_sku_match,
                    ma.title,
                    ma.brand,
                    ma.ai_flags,
                    ma.ai_confidence,
                    ae.vector
                FROM public.review_queue rq
                JOIN public.media_assets ma ON ma.id = rq.media_asset_id
                JOIN public.asset_embeddings ae ON ae.asset_id = ma.id AND ae.space_id = %s
                WHERE rq.status = 'pending'
                  AND ma.deleted_at IS NULL
                ORDER BY rq.created_at ASC;
            """, (SPACE_ID,))

            rows = cur.fetchall()
            print(f"Found {len(rows)} pending review queue items to re-rank in space '{SPACE_ID}'.")

            updated_count = 0
            improved_count = 0

            for idx, item in enumerate(rows, 1):
                queue_id = item["queue_id"]
                asset_id = item["media_asset_id"]
                brand = item["brand"]
                title = item["title"]
                old_match = item["old_sku_match"] or {}
                old_winner = old_match.get("sku")
                old_sim = old_match.get("similarity")

                # Parse vector
                raw_vec = item["vector"]
                if isinstance(raw_vec, str):
                    raw_vec = json.loads(raw_vec)
                vec_str = vector_literal(raw_vec)

                # Match against current reference_embeddings
                candidates = match_candidates(cur, vec_str, brand)
                new_sku_match = gate_candidates(candidates)

                new_winner = new_sku_match.get("sku")
                new_sim = new_sku_match.get("similarity")

                is_changed = old_winner != new_winner or (old_sim is not None and new_sim is not None and abs(old_sim - new_sim) > 0.001)

                if is_changed:
                    improved_count += 1
                    top3_new = ", ".join(f"{c['sku']} ({c['similarity']*100:.1f}%)" for c in new_sku_match.get("candidates", [])[:3])
                    print(f"[{idx}/{len(rows)}] Asset {asset_id[:8]} ('{title[:40]}...'):")
                    print(f"    OLD: {old_winner} ({old_sim*100 if old_sim else 0:.1f}%)")
                    print(f"    NEW: {new_winner} ({new_sim*100 if new_sim else 0:.1f}%) -> Top 3: {top3_new}")

                if args.confirm:
                    # Update review_queue
                    cur.execute("""
                        UPDATE public.review_queue
                        SET sku_match = %s
                        WHERE id = %s;
                    """, (json.dumps(new_sku_match), queue_id))

                    # Update media_assets ai_flags and ai_confidence
                    new_ai_flags = dict(item["ai_flags"] or {})
                    new_ai_flags["sku_match_source"] = "embedding_reference"
                    new_ai_flags["sku_confidence_band"] = new_sku_match.get("confidence_band")
                    new_ai_flags["sku_requires_reviewer_confirmation"] = new_sku_match.get("requires_reviewer_confirmation")

                    new_ai_confidence = dict(item["ai_confidence"] or {})
                    new_ai_confidence["sku"] = round(new_sim * 100) if new_sim is not None else 0

                    cur.execute("""
                        UPDATE public.media_assets
                        SET ai_flags = %s,
                            ai_confidence = %s,
                            updated_at = now()
                        WHERE id = %s;
                    """, (json.dumps(new_ai_flags), json.dumps(new_ai_confidence), asset_id))

                updated_count += 1

            if args.confirm:
                conn.commit()
                print(f"\nSUCCESS: Committed re-rank updates for {updated_count} items ({improved_count} items with updated candidate winners).")
            else:
                conn.rollback()
                print(f"\nDRY RUN complete: {improved_count}/{updated_count} items would be updated with new candidate rankings. Use --confirm to save.")

    except Exception as e:
        conn.rollback()
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
