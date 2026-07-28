import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

MOCK_GENERATION = os.getenv("GENBLAZE_MOCK", "true").lower() in ("1", "true", "yes")

B2_BUCKET = os.getenv("B2_BUCKET") or None
B2_KEY_ID = os.getenv("B2_KEY_ID") or None
B2_APP_KEY = os.getenv("B2_APP_KEY") or None
B2_REGION = os.getenv("B2_REGION", "us-west-004")

STORAGE_ENABLED = bool(B2_BUCKET and B2_KEY_ID and B2_APP_KEY)

RUNS_INDEX_PATH = Path(__file__).resolve().parent.parent / "runs_index.json"
