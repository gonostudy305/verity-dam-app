"""
VPS Curated Ingestion Receiver.
Reads JSON payload from stdin containing WebP image bytes and metadata,
uploads to R2 and commits to Postgres via MediaMcpGateway._finalize.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import sys
from pathlib import Path

mimetypes.add_type('image/webp', '.webp')
mimetypes.add_type('image/heic', '.heic')
mimetypes.add_type('image/heif', '.heif')

if "/app" not in sys.path:
    sys.path.insert(0, "/app")

from verity_dam_mcp.settings import McpSettings
from verity_dam_mcp.auth import BotSession
from verity_dam_mcp.gateway import MediaMcpGateway


def main():
    settings = McpSettings.from_environment()
    bot = BotSession(settings)
    gateway = MediaMcpGateway(settings, bot)

    data = json.load(sys.stdin)
    storage_path = data["storage_path"]
    file_name = data["file_name"]
    content = base64.b64decode(data["content_b64"])
    upload_item = data["upload_item"]

    # 1. Upload to R2
    gateway.upload_object(storage_path, content, file_name)

    # 2. Finalize in Postgres
    result = gateway._finalize({
        "p_uploads": [upload_item],
        "p_context": upload_item.get("project_hint"),
    })

    print(json.dumps(result[0] if result else {"error": "No result"}))


if __name__ == "__main__":
    main()
