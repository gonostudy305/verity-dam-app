"""Match one image against the personal local reference store.

This script intentionally does not import the production worker or database gateway.
Local CLIP vectors are compared only with ``data/local_references.json`` and
can never be sent to a production RPC.
"""

import json
import os
import sys
from pathlib import Path

from app.config import DATA_DIR
from app.contracts import apply_consistency_gate, gate_sku_candidates
from app.embed import cosine_similarity, embed_image, parse_embedding

TOP_K = 3


def _reference_path() -> Path:
    return Path(os.environ.get("Verity_LOCAL_REFERENCE_FILE", str(DATA_DIR / "local_references.json")))


def _load_references() -> list[dict]:
    path = _reference_path()
    if not path.exists():
        raise SystemExit(
            f"Chua co local reference store: {path}. "
            "Chay scripts.seed_local_references.py tren profile ca nhan."
        )
    rows = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(rows, list):
        raise SystemExit("Local reference store must be a JSON array")
    return [row for row in rows if isinstance(row, dict) and isinstance(row.get("sku"), str)]


def main():
    if len(sys.argv) < 2:
        print("Dung: python -m scripts.test_match <duong-dan-anh-test>")
        raise SystemExit(1)

    vector = [float(value) for value in embed_image(sys.argv[1]).tolist()]
    references = _load_references()
    scored = []
    for row in references:
        raw = row.get("embedding")
        if raw is None:
            continue
        score = cosine_similarity(vector, parse_embedding(raw))
        scored.append({"sku": row["sku"], "similarity": score, "is_primary": bool(row.get("is_primary"))})
    scored.sort(key=lambda row: row["similarity"], reverse=True)
    rows = scored[: max(TOP_K, 20)]
    if not rows:
        print("Local reference store is empty.")
        return

    print(f"Anh test: {sys.argv[1]}\n")
    for rank, row in enumerate(rows[:TOP_K], start=1):
        print(f"  #{rank}  {row['sku']:20s}  similarity={row['similarity']:.4f}")

    decision = gate_sku_candidates(rows)
    if decision.confidence_band == "high" and decision.sku:
        sku_rows = [row for row in references if row.get("sku") == decision.sku]
        similarities = [
            cosine_similarity(vector, parse_embedding(row["embedding"]))
            for row in sku_rows
            if row.get("embedding") is not None
        ]
        primary = [
            cosine_similarity(vector, parse_embedding(row["embedding"]))
            for row in sku_rows
            if row.get("embedding") is not None and row.get("is_primary")
        ]
        decision = apply_consistency_gate(decision, similarities, max(primary) if primary else None)
        print(f"  Doi chieu {len(similarities)} anh local ref cua {decision.sku}: "
              f"{[round(value, 4) for value in similarities]}")
    print(f"  Ket luan: {decision.sku or 'de trong'} ({decision.confidence_band})")


if __name__ == "__main__":
    main()
