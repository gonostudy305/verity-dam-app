"""
Google Drive Census & Manifest Generator for VerityDAM Importer.
Crawls Drive folder hierarchy recursively into a local SQLite manifest.
"""

import argparse
import os
import sqlite3
import sys
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True, errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", line_buffering=True, errors="replace")

# Ensure project root is in sys.path
PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.importers.google_drive.auth import get_drive_service

DEFAULT_ROOT_FOLDER_ID = "1ho1zGla5QZOpiJFaNW10GvCXgw5n6Y2D"
DEFAULT_DB_PATH = Path(__file__).parent / "manifest.sqlite3"
FOLDER_MIME = "application/vnd.google-apps.folder"


def init_db(db_path: Path) -> sqlite3.Connection:
    """Initialize SQLite database with schema and indexes."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")

    with conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS folders (
                folder_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                parent_id TEXT,
                folder_path TEXT NOT NULL,
                depth INTEGER NOT NULL DEFAULT 0,
                visited_at TEXT,
                item_count INTEGER DEFAULT 0
            );
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS files (
                file_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                size_bytes INTEGER,
                md5_checksum TEXT,
                folder_id TEXT NOT NULL,
                folder_path TEXT NOT NULL,
                drive_id TEXT,
                created_time TEXT,
                modified_time TEXT,
                crawled_at TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'discovered',
                error_message TEXT,
                FOREIGN KEY (folder_id) REFERENCES folders(folder_id)
            );
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_files_folder_id ON files(folder_id);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_files_md5 ON files(md5_checksum);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_files_mime ON files(mime_type);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);")

    return conn


def list_folder_contents(
    service,
    folder_id: str,
) -> Tuple[List[dict], List[dict]]:
    """List all immediate child folders and files inside a Google Drive folder."""
    folders = []
    files = []
    page_token = None

    query = f"'{folder_id}' in parents and trashed = false"

    retries = 0
    max_retries = 5
    while True:
        try:
            response = service.files().list(
                q=query,
                fields="nextPageToken, files(id, name, mimeType, size, md5Checksum, modifiedTime, createdTime, parents, driveId)",
                pageSize=1000,
                supportsAllDrives=True,
                includeItemsFromAllDrives=True,
                pageToken=page_token,
            ).execute()
        except Exception as e:
            retries += 1
            if retries > max_retries:
                print(f"  [error] Drive API list error for folder {folder_id} after {max_retries} retries: {e}")
                raise
            wait_time = 2 ** retries
            print(f"  [warn] Drive API list error for folder {folder_id}: {e}. Retrying in {wait_time}s ({retries}/{max_retries})...")
            time.sleep(wait_time)
            continue

        retries = 0

        items = response.get("files", [])
        for item in items:
            if item.get("mimeType") == FOLDER_MIME:
                folders.append(item)
            else:
                files.append(item)

        page_token = response.get("nextPageToken")
        if not page_token:
            break

    return folders, files


def run_census(
    service,
    conn: sqlite3.Connection,
    root_folder_id: str = DEFAULT_ROOT_FOLDER_ID,
    root_folder_name: str = "Hình ảnh thi công",
    limit_folders: Optional[int] = None,
    max_depth: Optional[int] = None,
    force_rescan: bool = False,
):
    """Recursively scan Google Drive folder structure into SQLite manifest."""
    now_str = datetime.now(timezone.utc).isoformat()

    # Ensure root folder is registered
    with conn:
        conn.execute("""
            INSERT INTO folders (folder_id, name, parent_id, folder_path, depth)
            VALUES (?, ?, NULL, ?, 0)
            ON CONFLICT(folder_id) DO UPDATE SET
                name=excluded.name,
                folder_path=excluded.folder_path;
        """, (root_folder_id, root_folder_name, root_folder_name))

    # BFS Queue: (folder_id, folder_name, folder_path, depth)
    queue: deque[Tuple[str, str, str, int]] = deque()
    queue.append((root_folder_id, root_folder_name, root_folder_name, 0))

    folders_processed = 0
    total_files_discovered = 0

    print(f"\n[census] Starting crawl from root: '{root_folder_name}' ({root_folder_id})")
    if limit_folders:
        print(f"[census] Subfolder limit set to: {limit_folders}")
    if max_depth is not None:
        print(f"[census] Max crawl depth set to: {max_depth}")

    while queue:
        current_id, current_name, current_path, current_depth = queue.popleft()

        # Check if already visited
        cursor = conn.execute(
            "SELECT visited_at, item_count FROM folders WHERE folder_id = ?",
            (current_id,),
        )
        row = cursor.fetchone()
        if row and row[0] and not force_rescan:
            print(f"  [skip] Already scanned: '{current_path}' ({row[1]} items)")
            # Need to enqueue children if we want deeper levels
            if max_depth is None or current_depth < max_depth:
                child_cursor = conn.execute(
                    "SELECT folder_id, name, folder_path, depth FROM folders WHERE parent_id = ?",
                    (current_id,),
                )
                for child in child_cursor.fetchall():
                    queue.append((child[0], child[1], child[2], child[3]))
            continue

        if limit_folders and folders_processed >= limit_folders:
            print(f"\n[census] Reached folder limit ({limit_folders}). Stopping queue.")
            break

        print(f"\n[census] [{folders_processed + 1}] Scanning '{current_path}' (depth={current_depth})...")
        child_folders, child_files = list_folder_contents(service, current_id)
        visited_at = datetime.now(timezone.utc).isoformat()
        total_items = len(child_folders) + len(child_files)

        with conn:
            # Upsert child folders
            for cf in child_folders:
                c_id = cf["id"]
                c_name = cf.get("name", "Untitled")
                c_path = f"{current_path}/{c_name}"
                conn.execute("""
                    INSERT INTO folders (folder_id, name, parent_id, folder_path, depth)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(folder_id) DO UPDATE SET
                        name=excluded.name,
                        parent_id=excluded.parent_id,
                        folder_path=excluded.folder_path,
                        depth=excluded.depth;
                """, (c_id, c_name, current_id, c_path, current_depth + 1))

                if max_depth is None or (current_depth + 1) <= max_depth:
                    queue.append((c_id, c_name, c_path, current_depth + 1))

            # Upsert files
            for f in child_files:
                f_id = f["id"]
                f_name = f.get("name", "Untitled")
                mime_type = f.get("mimeType", "application/octet-stream")
                size_bytes = int(f.get("size")) if f.get("size") is not None else None
                md5 = f.get("md5Checksum")
                drive_id = f.get("driveId")
                created_time = f.get("createdTime")
                mod_time = f.get("modifiedTime")

                conn.execute("""
                    INSERT INTO files (
                        file_id, name, mime_type, size_bytes, md5_checksum,
                        folder_id, folder_path, drive_id, created_time, modified_time,
                        crawled_at, status
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered')
                    ON CONFLICT(file_id) DO UPDATE SET
                        status = CASE
                            WHEN files.md5_checksum IS NOT NULL AND excluded.md5_checksum IS NOT NULL AND files.md5_checksum != excluded.md5_checksum THEN 'discovered'
                            WHEN files.modified_time IS NOT NULL AND excluded.modified_time IS NOT NULL AND files.modified_time != excluded.modified_time THEN 'discovered'
                            ELSE files.status
                        END,
                        name=excluded.name,
                        mime_type=excluded.mime_type,
                        size_bytes=excluded.size_bytes,
                        md5_checksum=excluded.md5_checksum,
                        folder_id=excluded.folder_id,
                        folder_path=excluded.folder_path,
                        drive_id=excluded.drive_id,
                        modified_time=excluded.modified_time,
                        crawled_at=excluded.crawled_at;
                """, (
                    f_id, f_name, mime_type, size_bytes, md5,
                    current_id, current_path, drive_id, created_time, mod_time,
                    visited_at
                ))

            # Mark current folder as visited
            conn.execute("""
                UPDATE folders
                SET visited_at = ?, item_count = ?
                WHERE folder_id = ?;
            """, (visited_at, total_items, current_id))

        folders_processed += 1
        total_files_discovered += len(child_files)
        print(f"  -> Discovered {len(child_folders)} subfolders, {len(child_files)} files. (Queue: {len(queue)})")

    print(f"\n[census] Scan complete. Processed {folders_processed} folders, found {total_files_discovered} files in this run.")


def print_stats(conn: sqlite3.Connection):
    """Print statistical summary of the manifest."""
    print("\n" + "=" * 60)
    print("               Verity MEDIA DRIVE CENSUS REPORT")
    print("=" * 60)

    # 1. Folders
    row = conn.execute("SELECT count(*), count(visited_at) FROM folders;").fetchone()
    total_folders, visited_folders = row[0], row[1]
    print(f"Folders Discovered: {total_folders} (Scanned: {visited_folders})")

    # 2. Files & Sizes
    row = conn.execute("SELECT count(*), sum(size_bytes), avg(size_bytes) FROM files;").fetchone()
    total_files = row[0] or 0
    total_bytes = row[1] or 0
    avg_bytes = row[2] or 0
    total_mb = total_bytes / (1024 * 1024)
    total_gb = total_bytes / (1024 * 1024 * 1024)
    print(f"Total Files:        {total_files:,}")
    print(f"Total Size:         {total_mb:,.1f} MB ({total_gb:,.2f} GB)")
    if total_files > 0:
        print(f"Average File Size:  {avg_bytes / 1024:,.1f} KB")

    # 3. MIME Types breakdown
    print("\n--- Files by MIME Type ---")
    rows = conn.execute("""
        SELECT mime_type, count(*), sum(size_bytes)
        FROM files
        GROUP BY mime_type
        ORDER BY count(*) DESC
        LIMIT 15;
    """).fetchall()
    for mime, count, size in rows:
        mb = (size or 0) / (1024 * 1024)
        print(f"  {mime:<40} : {count:>5} files ({mb:>8.1f} MB)")

    # 4. Duplicate Checksums
    row = conn.execute("""
        SELECT count(*), sum(dup_count) FROM (
            SELECT md5_checksum, count(*) as dup_count
            FROM files
            WHERE md5_checksum IS NOT NULL
            GROUP BY md5_checksum
            HAVING count(*) > 1
        );
    """).fetchone()
    unique_dups = row[0] or 0
    total_dup_files = row[1] or 0
    if total_files > 0:
        dup_pct = (total_dup_files / total_files) * 100
        print(f"\n--- Duplicate Checksums (MD5) ---")
        print(f"  Unique Hashes with Duplicates: {unique_dups:,}")
        print(f"  Total Redundant File Copies:    {total_dup_files:,} ({dup_pct:.1f}% of all files)")

    # 5. Top 10 Subfolders by File Count
    print("\n--- Top Folders by File Count ---")
    rows = conn.execute("""
        SELECT folder_path, count(*) as f_count, sum(size_bytes)
        FROM files
        GROUP BY folder_path
        ORDER BY f_count DESC
        LIMIT 10;
    """).fetchall()
    for path, count, size in rows:
        mb = (size or 0) / (1024 * 1024)
        print(f"  {count:>4} files ({mb:>6.1f} MB) : {path}")

    # 6. Sample Images
    print("\n--- Sample Discovered Images (First 15) ---")
    sample_rows = conn.execute("""
        SELECT name, mime_type, round(size_bytes / 1024.0, 1), folder_path
        FROM files
        WHERE mime_type LIKE 'image/%'
        LIMIT 15;
    """).fetchall()
    for name, mime, kb, fpath in sample_rows:
        print(f"  {name:<25} | {mime:<12} | {kb:>7.1f} KB | {fpath}")

    print("=" * 60 + "\n")


def main():
    parser = argparse.ArgumentParser(description="Google Drive Census & Manifest Generator")
    parser.add_argument("--root-id", default=DEFAULT_ROOT_FOLDER_ID, help="Root folder ID to crawl")
    parser.add_argument("--db-path", default=str(DEFAULT_DB_PATH), help="Path to SQLite manifest database")
    parser.add_argument("--limit-folders", type=int, default=None, help="Max subfolders to crawl")
    parser.add_argument("--max-depth", type=int, default=None, help="Max depth from root (0=root only, 1=direct subfolders)")
    parser.add_argument("--stats-only", action="store_true", help="Only display stats without crawling")
    parser.add_argument("--force-rescan", action="store_true", help="Rescan folders even if visited")
    args = parser.parse_args()

    db_path = Path(args.db_path)
    conn = init_db(db_path)

    if args.stats_only:
        print_stats(conn)
        conn.close()
        return

    service = get_drive_service()
    run_census(
        service=service,
        conn=conn,
        root_folder_id=args.root_id,
        limit_folders=args.limit_folders,
        max_depth=args.max_depth,
        force_rescan=args.force_rescan,
    )

    print_stats(conn)
    conn.close()


if __name__ == "__main__":
    main()
