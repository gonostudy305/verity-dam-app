#!/usr/bin/env python3
"""Promote approved media assets to sku_references and compute SigLIP2 embeddings.

Supports both local execution (with automated SSH delegation to VPS) and direct
execution on VPS host.

Usage:
    # Dry-run
    python backend/scripts/promote_sku_references.py --input scratch/approved_30_candidates.json

    # Execute and commit to database
    python backend/scripts/promote_sku_references.py --input scratch/approved_30_candidates.json --confirm
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
import requests

CANONICAL_MAP = {
    "Acme A100": "AC-S02",
    "Verity C02": "MT-C02-Pro",
    "Lockin V5 Max": "XFCL201",
    "Acme M100": "AC-S20",
    "Imex K2C": "K2C-H(W)-B",
    "Eden DL05": "DEMO-007",
    "Acme N100": "AC-S16",
    "Lockin X9": "TFPL408",
    "Lockin S30 Pro": "PFPL908",
    "Acme D200": "ML-D01D",
    "Lockin S50F": "XFCL108",
}

DEFAULT_EMBEDDING_URL = "http://127.0.0.1:8801"
EXPECTED_SPACE_ID = "verity-siglip2-b32-256-webli-v1"
EXPECTED_DIMENSION = 768


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Promote candidates to sku_references")
    parser.add_argument(
        "--input",
        type=Path,
        required=True,
        help="Path to candidates JSON (flat list or dictionary by model)",
    )
    parser.add_argument(
        "--ssh-key",
        default=r"C:\Users\ADMIN\.ssh\verity_vps_deploy_ed25519",
        help="Path to SSH deploy key for remote mode",
    )
    parser.add_argument(
        "--ssh-host",
        default="root@203.0.113.10",
        help="SSH host (e.g. root@203.0.113.10)",
    )
    parser.add_argument(
        "--confirm",
        action="store_true",
        default=False,
        help="Actually insert and commit rows into database. If not set, runs in dry-run mode.",
    )
    parser.add_argument(
        "--local-direct",
        action="store_true",
        default=False,
        help="Force direct local execution (used on VPS host)",
    )
    parser.add_argument(
        "--output-report",
        type=Path,
        default=None,
        help="Path to output execution report JSON",
    )
    return parser.parse_args()


def load_candidates(file_path: Path) -> list[dict[str, Any]]:
    with open(file_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    flat: list[dict[str, Any]] = []
    if isinstance(data, list):
        for it in data:
            model_name = it.get("model_name", "")
            sku = it.get("sku") or CANONICAL_MAP.get(model_name, model_name)
            flat.append({
                "asset_id": it.get("asset_id") or it.get("id"),
                "sku": sku,
                "model_name": model_name,
                "file_url": it["file_url"],
                "score": int(round(it.get("score", 90))),
                "title": it.get("title", ""),
            })
    elif isinstance(data, dict):
        for model_name, items in data.items():
            sku = CANONICAL_MAP.get(model_name, model_name)
            for it in items:
                flat.append({
                    "asset_id": it.get("asset_id") or it.get("id"),
                    "sku": sku,
                    "model_name": model_name,
                    "file_url": it["file_url"],
                    "score": int(round(it.get("score", 90))),
                    "title": it.get("title", ""),
                })
    return flat


def execute_vps_payload(candidates: list[dict[str, Any]], confirm: bool) -> dict[str, Any]:
    """Runs directly on the VPS host with direct access to local embedding runtime and DB."""
    session = requests.Session()
    session.headers.update({"User-Agent": "verity-sku-promoter/1.0"})

    print(f"[*] Verifying SigLIP2 embedding runtime at {DEFAULT_EMBEDDING_URL}/health...")
    try:
        h_resp = session.get(f"{DEFAULT_EMBEDDING_URL}/health", timeout=10)
        h_resp.raise_for_status()
        h_data = h_resp.json()
        print(f"[+] SigLIP2 runtime healthy: {h_data}")
    except Exception as exc:
        print(f"[!] Cannot connect to SigLIP2 runtime: {exc}", file=sys.stderr)
        sys.exit(1)

    processed_count = 0
    success_count = 0
    sql_statements: list[str] = ["BEGIN;"]
    primary_requested_for: set[str] = set()
    results_summary: list[dict[str, Any]] = []

    print(f"[*] Processing {len(candidates)} candidates...")
    for idx, c in enumerate(candidates, 1):
        asset_id = c["asset_id"]
        sku = c["sku"]
        model_name = c["model_name"]
        file_url = c["file_url"]
        score = c["score"]
        print(f"[{idx:02d}/{len(candidates):02d}] {model_name} ({sku}) -> Asset {asset_id}...", end=" ", flush=True)

        try:
            # 1. Download image
            img_resp = session.get(file_url, timeout=30)
            img_resp.raise_for_status()
            img_bytes = img_resp.content
            sha256 = hashlib.sha256(img_bytes).hexdigest()

            # 2. Embed image
            embed_resp = session.post(
                f"{DEFAULT_EMBEDDING_URL}/embed/image",
                headers={"Content-Type": "image/webp"},
                data=img_bytes,
                timeout=45,
            )
            embed_resp.raise_for_status()
            embed_data = embed_resp.json()

            dim = embed_data.get("dimension")
            space_id = embed_data.get("space_id")
            if dim != EXPECTED_DIMENSION or space_id != EXPECTED_SPACE_ID:
                raise ValueError(f"Unexpected embedding shape: dim={dim}, space={space_id}")

            embedding = embed_data["embedding"]
            vec_str = "[" + ",".join(str(x) for x in embedding) + "]"

            # First successfully prepared reference in each SKU batch is the
            # requested primary anchor. The upsert preserves an existing
            # primary on reruns. Failed candidates do not consume the slot.
            requested_primary = sku not in primary_requested_for
            primary_requested_for.add(sku)

            # 3. Formulate SQL
            sql_statements.append(f"""
-- Item {idx}: {model_name} ({sku})
INSERT INTO public.sku_references (
    reference_id, sku, source_media_asset_id, source_url,
    verified, match_eligible, reference_role, image_category, curation_status,
    quality_score, is_primary, is_active, is_frozen_benchmark,
    updated_at
) VALUES (
    gen_random_uuid(), '{sku}', '{asset_id}'::uuid, '{file_url}',
    true, true, 'INSTALLATION', 'REAL', 'REVIEWED',
    {score}, {str(requested_primary).lower()}, true, false,
    now()
)
ON CONFLICT (sku, source_media_asset_id) WHERE source_media_asset_id IS NOT NULL
DO UPDATE SET
    reference_role = 'INSTALLATION',
    image_category = 'REAL',
    curation_status = 'REVIEWED',
    quality_score = EXCLUDED.quality_score,
    verified = true,
    match_eligible = true,
    is_primary = public.sku_references.is_primary OR EXCLUDED.is_primary,
    is_active = true,
    updated_at = now();

INSERT INTO public.reference_embeddings (
    id, reference_id, space_id, vector, source_sha256, created_at
) VALUES (
    gen_random_uuid(),
    (SELECT reference_id FROM public.sku_references WHERE sku = '{sku}' AND source_media_asset_id = '{asset_id}'::uuid),
    '{EXPECTED_SPACE_ID}',
    '{vec_str}'::vector,
    '{sha256}',
    now()
)
ON CONFLICT (reference_id, space_id)
DO UPDATE SET
    vector = EXCLUDED.vector,
    source_sha256 = EXCLUDED.source_sha256;

INSERT INTO public.asset_embeddings (
    embedding_id, asset_id, space_id, kind, vector, source_sha256, created_at
) VALUES (
    gen_random_uuid(),
    '{asset_id}'::uuid,
    '{EXPECTED_SPACE_ID}',
    'global',
    '{vec_str}'::vector,
    '{sha256}',
    now()
)
ON CONFLICT (asset_id, space_id) WHERE kind = 'global'
DO UPDATE SET
    vector = EXCLUDED.vector,
    source_sha256 = EXCLUDED.source_sha256;
""")
            success_count += 1
            results_summary.append({
                "sku": sku,
                "model_name": model_name,
                "asset_id": asset_id,
                "score": score,
                "sha256": sha256,
                "status": "EMBEDDED_OK",
            })
            print(f"OK (dim=768, sha={sha256[:10]})")
        except Exception as exc:
            print(f"FAILED: {exc}")
            results_summary.append({
                "sku": sku,
                "model_name": model_name,
                "asset_id": asset_id,
                "status": f"FAILED: {exc}",
            })

        processed_count += 1

    if not confirm:
        sql_statements.append("ROLLBACK;")
        print("\n[DRY-RUN] Transactions tested with ROLLBACK. No persistent changes made.")
    else:
        sql_statements.append("COMMIT;")
        print(f"\n[*] Committing {success_count} entries to database...")

    full_sql = "\n".join(sql_statements)
    proc = subprocess.run(
        ["docker", "exec", "-i", "verity_native_media_db", "psql", "-U", "verity", "-d", "verity_media"],
        input=full_sql,
        text=True,
        capture_output=True,
    )

    if proc.returncode != 0:
        print(f"[!] PostgreSQL Execution Failed (Code {proc.returncode}):", file=sys.stderr)
        print(proc.stderr, file=sys.stderr)
        sys.exit(proc.returncode)

    # Verification Query
    verify_sql = f"""
SELECT 
    r.sku,
    count(r.reference_id) as total_references,
    count(re.id) as total_siglip2_embeddings,
    array_agg(DISTINCT r.reference_role) as roles,
    array_agg(DISTINCT r.curation_status) as curation_statuses
FROM public.sku_references r
LEFT JOIN public.reference_embeddings re 
    ON r.reference_id = re.reference_id AND re.space_id = '{EXPECTED_SPACE_ID}'
WHERE r.sku IN ({','.join(f"'{c['sku']}'" for c in candidates)})
GROUP BY r.sku
ORDER BY r.sku;
"""
    v_proc = subprocess.run(
        ["docker", "exec", "-i", "verity_native_media_db", "psql", "-U", "verity", "-d", "verity_media", "-c", verify_sql],
        text=True,
        capture_output=True,
    )
    print("\n=== Post-Execution Verification ===")
    print(v_proc.stdout)

    return {
        "status": "SUCCESS" if success_count == len(candidates) else "PARTIAL",
        "processed": processed_count,
        "success": success_count,
        "mode": "COMMIT" if confirm else "DRY-RUN",
        "results": results_summary,
    }


def delegate_remote(args: argparse.Namespace) -> None:
    """Copies candidates and runner to VPS, then executes remotely."""
    print(f"[*] Delegating execution to remote VPS ({args.ssh_host})...")

    # 1. SCP input file
    print(f"[*] Uploading {args.input} to /tmp/candidates_to_promote.json...")
    scp_cmd = [
        "scp", "-i", args.ssh_key,
        str(args.input),
        f"{args.ssh_host}:/tmp/candidates_to_promote.json",
    ]
    res = subprocess.run(scp_cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print(f"[!] SCP input failed: {res.stderr}", file=sys.stderr)
        sys.exit(res.returncode)

    # 2. SCP this script
    script_path = Path(__file__).resolve()
    print(f"[*] Uploading runner script to /tmp/promote_sku_references.py...")
    scp_cmd2 = [
        "scp", "-i", args.ssh_key,
        str(script_path),
        f"{args.ssh_host}:/tmp/promote_sku_references.py",
    ]
    res2 = subprocess.run(scp_cmd2, capture_output=True, text=True)
    if res2.returncode != 0:
        print(f"[!] SCP script failed: {res2.stderr}", file=sys.stderr)
        sys.exit(res2.returncode)

    # 3. SSH execution
    confirm_flag = "--confirm" if args.confirm else ""
    remote_cmd = f"python3 /tmp/promote_sku_references.py --input /tmp/candidates_to_promote.json --local-direct {confirm_flag}"
    print(f"[*] Running command on VPS: {remote_cmd}")

    ssh_cmd = [
        "ssh", "-i", args.ssh_key,
        args.ssh_host,
        remote_cmd,
    ]
    res3 = subprocess.run(ssh_cmd)
    if res3.returncode != 0:
        print(f"[!] Remote execution failed with code {res3.returncode}", file=sys.stderr)
        sys.exit(res3.returncode)


def main() -> None:
    args = parse_args()
    if not args.input.is_file():
        print(f"Error: Input file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    # Detect if we should delegate to VPS or execute locally
    is_vps = os.path.exists("/.dockerenv") or (sys.platform == "linux" and os.path.exists("/etc/debian_version"))
    if not is_vps and not args.local_direct:
        delegate_remote(args)
        return

    # Direct execution on VPS
    candidates = load_candidates(args.input)
    print(f"Loaded {len(candidates)} candidates.")
    report = execute_vps_payload(candidates, confirm=args.confirm)

    if args.output_report:
        args.output_report.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"[*] Report saved to {args.output_report}")


if __name__ == "__main__":
    main()
