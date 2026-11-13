import os
from pathlib import Path

from dotenv import load_dotenv

_ROOT = Path(__file__).resolve().parent.parent
_REPO_ROOT = _ROOT.parent

load_dotenv(_REPO_ROOT / ".env.local")
load_dotenv(_REPO_ROOT / ".env")
load_dotenv(_ROOT / ".env.local")
load_dotenv(_ROOT / ".env")

WOOCOMMERCE_DATALAKE = os.environ.get("WOOCOMMERCE_DATALAKE")
DATA_DIR = _ROOT / "data"
