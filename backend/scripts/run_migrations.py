"""Entry point for executing VerityDAM database migrations."""
import sys
from pathlib import Path

# Add backend to sys.path
BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from scripts.apply_native_migrations import main

if __name__ == "__main__":
    main()
