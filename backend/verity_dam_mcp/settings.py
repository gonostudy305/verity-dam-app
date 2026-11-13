"""Native PostgreSQL + Cloudflare R2 settings for VerityDAM MCP server."""
from __future__ import annotations
import os
from dataclasses import dataclass
from pathlib import Path
from dotenv import load_dotenv

_ROOT = Path(__file__).resolve().parent.parent
_REPO_ROOT = _ROOT.parent

load_dotenv(_REPO_ROOT / '.env.local')
load_dotenv(_REPO_ROOT / '.env')
load_dotenv(_ROOT / '.env.local')
load_dotenv(_ROOT / '.env')

class ConfigurationError(RuntimeError): pass
def _required(*names: str) -> str:
    for name in names:
        value = os.environ.get(name, '').strip()
        if value:
            return value
    raise ConfigurationError(f'Missing required MCP server setting (one of): {", ".join(names)}')

@dataclass(frozen=True)
class McpSettings:
    database_url: str
    r2_endpoint: str
    r2_access_key_id: str
    r2_secret_access_key: str
    r2_bucket: str
    r2_region: str
    r2_public_base_url: str | None
    bot_email: str
    bot_user_id: str | None
    vision_config_master_key: str
    siglip2_vision_model_path: str | None
    openclip_vision_model_path: str | None
    next_api_base_url: str
    internal_service_key: str
    public_base_url: str

    @classmethod
    def from_environment(cls) -> 'McpSettings':
        return cls(
            database_url=_required('DATABASE_URL'),
            r2_endpoint=_required('R2_ENDPOINT'),
            r2_access_key_id=_required('R2_ACCESS_KEY_ID'),
            r2_secret_access_key=_required('R2_SECRET_ACCESS_KEY'),
            r2_bucket=_required('R2_BUCKET'),
            r2_region=os.environ.get('R2_REGION', 'auto').strip() or 'auto',
            r2_public_base_url=os.environ.get('R2_PUBLIC_BASE_URL', '').strip().rstrip('/') or None,
            bot_email=(
                os.environ.get('VERITY_MCP_EMAIL')
                or os.environ.get('Verity_MEDIA_MCP_EMAIL')
                or 'mcp-agent@veritydam.internal'
            ).strip(),
            bot_user_id=(
                os.environ.get('VERITY_MCP_USER_ID')
                or os.environ.get('Verity_MEDIA_MCP_USER_ID', '').strip()
                or None
            ),
            vision_config_master_key=_required('VERITY_VISION_CONFIG_MASTER_KEY', 'Verity_VISION_CONFIG_MASTER_KEY'),
            siglip2_vision_model_path=(
                os.environ.get('VERITY_SIGLIP2_VISION_MODEL_PATH')
                or os.environ.get('Verity_SIGLIP2_VISION_MODEL_PATH')
                or '/app/models/siglip2-vision-opset18.onnx'
            ).strip() or None,
            openclip_vision_model_path=(
                os.environ.get('VERITY_OPENCLIP_MODEL_PATH')
                or os.environ.get('Verity_OPENCLIP_MODEL_PATH')
                or '/app/models/openclip-256.onnx'
            ).strip() or None,
            next_api_base_url=os.environ.get('NEXT_PUBLIC_APP_URL', 'http://localhost:3000').strip().rstrip('/'),
            internal_service_key=_required('VERITY_INTERNAL_SERVICE_KEY', 'Verity_INTERNAL_SERVICE_KEY'),
            public_base_url=(
                os.environ.get('VERITY_MCP_PUBLIC_BASE_URL', '').strip().rstrip('/')
                or os.environ.get('Verity_MCP_PUBLIC_BASE_URL', '').strip().rstrip('/')
                or os.environ.get('NEXT_PUBLIC_APP_URL', '').strip().rstrip('/')
                or 'http://localhost:3000'
            ),
        )
