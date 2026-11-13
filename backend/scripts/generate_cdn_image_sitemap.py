"""Generate Google-compliant Image Sitemap for VerityDAM CDN renditions.

Outputs sitemap-images.xml containing <image:image> tags linking canonical
landing pages on veritydam.example to immutable high-res WebP renditions on assets.verity.internal.
"""

from __future__ import annotations

import argparse
import sys
from xml.sax.saxutils import escape as xml_escape
from app.production_config import WorkerSettings
from app.native_gateway import NativeGateway

CDN_BASE_URL = "https://assets.verity.internal"
SITE_BASE_URL = "https://veritydam.example"


def generate_image_sitemap(output_file: str = "sitemap-images.xml", upload_r2: bool = False) -> str:
    settings = WorkerSettings.from_environment()
    gateway = NativeGateway(settings)

    query = """
    WITH highest_renditions AS (
        SELECT DISTINCT ON (media_asset_id)
            media_asset_id,
            cdn_key,
            width,
            height
        FROM public.media_renditions
        WHERE cdn_key IS NOT NULL
        ORDER BY media_asset_id, width DESC
    )
    SELECT
        a.id,
        a.title,
        COALESCE(a.suggested_caption, a.description, a.title) as caption,
        a.canonical_slug,
        a.guide_url,
        a.sku,
        r.cdn_key,
        r.width,
        r.height,
        a.updated_at
    FROM public.media_assets a
    JOIN highest_renditions r ON r.media_asset_id = a.id
    WHERE a.deleted_at IS NULL
      AND a.review_state = 'approved'
      AND a.permission = 'public'
    ORDER BY a.updated_at DESC;
    """

    rows = []
    with gateway.repository.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(query)
            for row in cur.fetchall():
                rows.append({
                    "id": str(row[0]),
                    "title": row[1] or "",
                    "caption": row[2] or "",
                    "canonical_slug": row[3] or "",
                    "guide_url": row[4] or "",
                    "sku": row[5] or "",
                    "cdn_key": row[6] or "",
                    "width": row[7],
                    "height": row[8],
                    "updated_at": row[9].strftime("%Y-%m-%d") if row[9] else "2026-09-09",
                })

    print(f"Loaded {len(rows)} public approved assets with highest-res renditions.")

    xml_parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
        '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
    ]

    for item in rows:
        if item["guide_url"] and item["guide_url"].startswith("http"):
            page_loc = item["guide_url"]
        elif item["canonical_slug"]:
            page_loc = f"{SITE_BASE_URL}/hinh-anh/{item['canonical_slug']}"
        else:
            page_loc = f"{SITE_BASE_URL}/thu-vien-anh/{item['id']}"

        image_loc = f"{CDN_BASE_URL}/{item['cdn_key']}"
        title = xml_escape(item["title"])
        caption = xml_escape(item["caption"])

        xml_parts.append("  <url>")
        xml_parts.append(f"    <loc>{xml_escape(page_loc)}</loc>")
        xml_parts.append(f"    <lastmod>{item['updated_at']}</lastmod>")
        xml_parts.append("    <image:image>")
        xml_parts.append(f"      <image:loc>{xml_escape(image_loc)}</image:loc>")
        if title:
            xml_parts.append(f"      <image:title>{title}</image:title>")
        if caption:
            xml_parts.append(f"      <image:caption>{caption}</image:caption>")
        xml_parts.append("    </image:image>")
        xml_parts.append("  </url>")

    xml_parts.append("</urlset>\n")
    sitemap_content = "\n".join(xml_parts)

    with open(output_file, "w", encoding="utf-8") as f:
        f.write(sitemap_content)

    print(f"Generated {output_file} ({len(sitemap_content)} bytes, {len(rows)} URLs).")

    if upload_r2:
        print("Uploading sitemap-images.xml directly to Cloudflare R2 bucket root...")
        settings.require_r2()
        import boto3
        s3 = boto3.client(
            "s3",
            endpoint_url=settings.r2_endpoint,
            aws_access_key_id=settings.r2_access_key_id,
            aws_secret_access_key=settings.r2_secret_access_key,
            region_name=settings.r2_region,
        )
        s3.put_object(
            Bucket=settings.r2_bucket,
            Key="sitemap-images.xml",
            Body=sitemap_content.encode("utf-8"),
            ContentType="application/xml",
            CacheControl="public, max-age=3600",
        )
        print(f"SUCCESS: Published to {CDN_BASE_URL}/sitemap-images.xml!")

    return sitemap_content


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate Google-compliant Image Sitemap for Verity CDN")
    parser.add_argument("--output", default="/tmp/sitemap-images.xml", help="Output file path")
    parser.add_argument("--upload-r2", action="store_true", help="Upload directly to R2 bucket root")
    args = parser.parse_args()

    generate_image_sitemap(output_file=args.output, upload_r2=args.upload_r2)
