"""
WordPress Blog Census & Manifest Engine for VerityDAM Importer.
Crawls WordPress REST API (/wp/v2/posts) into a local SQLite manifest.
"""

import argparse
import hashlib
import json
import logging
import re
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from bs4 import BeautifulSoup

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True, errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", line_buffering=True, errors="replace")

logger = logging.getLogger("wp_census")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

DEFAULT_API_BASE = "https://veritydam.example/wp-json/wp/v2"
DEFAULT_DB_PATH = Path(__file__).parent / "manifest.sqlite3"


def init_db(db_path: Path) -> sqlite3.Connection:
    """Initialize SQLite database schema and indexes for WordPress manifest."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")

    with conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS posts (
                post_id INTEGER PRIMARY KEY,
                title TEXT NOT NULL,
                slug TEXT NOT NULL,
                url TEXT NOT NULL,
                date_gmt TEXT NOT NULL,
                categories TEXT,
                featured_media_id INTEGER,
                featured_media_url TEXT,
                image_count INTEGER DEFAULT 0,
                crawled_at TEXT NOT NULL
            );
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS images (
                image_id TEXT PRIMARY KEY,
                image_url TEXT NOT NULL UNIQUE,
                post_id INTEGER NOT NULL,
                post_title TEXT NOT NULL,
                post_slug TEXT NOT NULL,
                is_featured INTEGER NOT NULL DEFAULT 0,
                alt_text TEXT,
                caption_text TEXT,
                context_text TEXT,
                file_extension TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                error_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (post_id) REFERENCES posts (post_id)
            );
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_images_post_id ON images(post_id);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_images_status ON images(status);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_posts_date ON posts(date_gmt);")
    return conn


def clean_image_url(raw_url: str) -> Optional[str]:
    """Sanitize and normalize image URL."""
    if not raw_url or not isinstance(raw_url, str):
        return None
    raw_url = raw_url.strip()
    if not raw_url.startswith("http"):
        return None
    
    # Filter out gravatars, emojis, base64 data URIs
    if "gravatar.com" in raw_url or "s.w.org/images/core/emoji" in raw_url or raw_url.startswith("data:"):
        return None
    
    parsed = urllib.parse.urlparse(raw_url)
    clean = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, parsed.path, '', '', ''))
    return clean


def compute_image_id(url: str, post_id: int) -> str:
    """Generate stable image ID from URL and Post ID."""
    h = hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]
    return f"wp_p{post_id}_{h}"


def fetch_posts_page(api_base: str, page: int = 1, per_page: int = 50, after: Optional[str] = None) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Fetch a single page of posts with embedded media from WordPress REST API."""
    params = [
        f"per_page={per_page}",
        f"page={page}",
        "_embed=true",
    ]
    if after:
        params.append(f"after={urllib.parse.quote(after)}")
    
    query_str = "&".join(params)
    url = f"{api_base}/posts?{query_str}"
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) VerityMediaCensus/2.2",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=25) as resp:
        headers = dict(resp.headers)
        data = json.loads(resp.read().decode("utf-8"))
        return data, headers


def extract_post_images(post: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Extract featured image and in-body images from post payload."""
    post_id = post["id"]
    post_title = BeautifulSoup(post["title"]["rendered"], "html.parser").get_text().strip()
    post_slug = post.get("slug", "").strip()
    images = []
    seen_urls = set()

    # 1. Featured Image
    if "_embedded" in post and "wp:featuredmedia" in post["_embedded"]:
        fm_list = post["_embedded"]["wp:featuredmedia"]
        if fm_list and isinstance(fm_list, list) and isinstance(fm_list[0], dict):
            fm = fm_list[0]
            src_url = clean_image_url(fm.get("source_url", ""))
            if src_url:
                seen_urls.add(src_url)
                alt = fm.get("alt_text", "").strip() or post_title
                caption = BeautifulSoup(fm.get("caption", {}).get("rendered", "") or "", "html.parser").get_text().strip()
                ext = src_url.split(".")[-1].lower() if "." in src_url else "webp"
                images.append({
                    "image_id": compute_image_id(src_url, post_id),
                    "image_url": src_url,
                    "post_id": post_id,
                    "post_title": post_title,
                    "post_slug": post_slug,
                    "is_featured": 1,
                    "alt_text": alt,
                    "caption_text": caption,
                    "context_text": f"Ảnh đại diện bài viết: {post_title}",
                    "file_extension": ext,
                })

    # 2. Content Images
    html_content = post.get("content", {}).get("rendered", "")
    if html_content:
        soup = BeautifulSoup(html_content, "html.parser")
        for img in soup.find_all("img"):
            raw_src = img.get("src") or img.get("data-src") or img.get("data-orig-file")
            clean_src = clean_image_url(raw_src)
            if not clean_src or clean_src in seen_urls:
                continue
            seen_urls.add(clean_src)

            # Extract alt
            alt = (img.get("alt") or "").strip()
            
            # Extract caption (figcaption or parent element)
            caption = ""
            parent_fig = img.find_parent("figure")
            if parent_fig:
                figcaption = parent_fig.find("figcaption")
                if figcaption:
                    caption = figcaption.get_text().strip()

            # Surrounding text context
            context_text = ""
            parent_p = img.find_parent("p")
            if parent_p:
                context_text = parent_p.get_text().strip()[:200]
            elif parent_fig and not caption:
                # Find sibling text
                prev = parent_fig.find_previous_sibling(["p", "h2", "h3"])
                if prev:
                    context_text = prev.get_text().strip()[:200]

            ext = clean_src.split(".")[-1].lower() if "." in clean_src else "webp"
            images.append({
                "image_id": compute_image_id(clean_src, post_id),
                "image_url": clean_src,
                "post_id": post_id,
                "post_title": post_title,
                "post_slug": post_slug,
                "is_featured": 0,
                "alt_text": alt,
                "caption_text": caption,
                "context_text": context_text or f"Minh họa trong bài viết: {post_title}",
                "file_extension": ext,
            })

    return images


def run_census(api_base: str = DEFAULT_API_BASE, db_path: Path = DEFAULT_DB_PATH, after: Optional[str] = None) -> None:
    """Execute full or filtered census crawl."""
    conn = init_db(db_path)
    now_iso = datetime.now(timezone.utc).isoformat()

    logger.info(f"Starting WordPress Blog Census: API={api_base}, after={after or 'ALL_TIME'}")
    
    page = 1
    total_posts_crawled = 0
    total_images_found = 0

    while True:
        try:
            logger.info(f"Fetching posts page {page}...")
            posts, headers = fetch_posts_page(api_base, page=page, per_page=50, after=after)
            if not posts:
                break

            with conn:
                for post in posts:
                    post_id = post["id"]
                    title = BeautifulSoup(post["title"]["rendered"], "html.parser").get_text().strip()
                    slug = post.get("slug", "").strip()
                    post_url = post.get("link", "").strip()
                    date_gmt = post.get("date_gmt", "")
                    cats = json.dumps(post.get("categories", []))
                    
                    fm_id = post.get("featured_media") or None
                    fm_url = None
                    if "_embedded" in post and "wp:featuredmedia" in post["_embedded"]:
                        fm_list = post["_embedded"]["wp:featuredmedia"]
                        if fm_list and isinstance(fm_list, list) and isinstance(fm_list[0], dict):
                            fm_url = clean_image_url(fm_list[0].get("source_url"))

                    post_images = extract_post_images(post)
                    
                    conn.execute("""
                        INSERT OR REPLACE INTO posts (
                            post_id, title, slug, url, date_gmt, categories,
                            featured_media_id, featured_media_url, image_count, crawled_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        post_id, title, slug, post_url, date_gmt, cats,
                        fm_id, fm_url, len(post_images), now_iso
                    ))

                    for img in post_images:
                        conn.execute("""
                            INSERT OR IGNORE INTO images (
                                image_id, image_url, post_id, post_title, post_slug,
                                is_featured, alt_text, caption_text, context_text,
                                file_extension, status, created_at, updated_at
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                        """, (
                            img["image_id"], img["image_url"], img["post_id"],
                            img["post_title"], img["post_slug"], img["is_featured"],
                            img["alt_text"], img["caption_text"], img["context_text"],
                            img["file_extension"], now_iso, now_iso
                        ))

                    total_posts_crawled += 1
                    total_images_found += len(post_images)

            page += 1
            time.sleep(0.5)  # Friendly rate limiting

        except urllib.error.HTTPError as e:
            if e.code == 400:
                # Page out of bounds
                break
            logger.error(f"HTTP Error on page {page}: {e}")
            break
        except Exception as e:
            logger.error(f"Error crawling page {page}: {e}")
            break

    # Summary
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM posts")
    p_count = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM images")
    i_count = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM images WHERE is_featured = 1")
    f_count = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM images WHERE is_featured = 0")
    c_count = cur.fetchone()[0]

    logger.info("=== CENSUS COMPLETE ===")
    logger.info(f"Posts in manifest: {p_count}")
    logger.info(f"Total unique images: {i_count} (Featured: {f_count}, In-body: {c_count})")
    logger.info(f"Manifest database saved at: {db_path}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="WordPress Blog Census")
    parser.add_argument("--api-base", default=DEFAULT_API_BASE, help="WordPress REST API base")
    parser.add_argument("--db-path", type=Path, default=DEFAULT_DB_PATH, help="SQLite manifest path")
    parser.add_argument("--after", type=str, default="2026-04-01T00:00:00", help="Filter posts after ISO timestamp")
    args = parser.parse_args()

    run_census(api_base=args.api_base, db_path=args.db_path, after=args.after)
