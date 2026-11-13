import logging
import sys
from pathlib import Path
from typing import Optional

# Ensure unbuffered and UTF-8 output
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True, errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", line_buffering=True, errors="replace")

logging.basicConfig(level=logging.INFO, format="%(message)s")

try:
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from googleapiclient.discovery import build, Resource
except ImportError:
    Request = None  # type: ignore
    Credentials = None  # type: ignore
    InstalledAppFlow = None  # type: ignore
    build = None  # type: ignore
    Resource = None  # type: ignore

# Scopes needed for census and image streaming
SCOPES = [
    "https://www.googleapis.com/auth/drive.readonly",
]

DEFAULT_CREDENTIALS_PATH = Path(__file__).parent / "credentials.json"
DEFAULT_TOKEN_PATH = Path(__file__).parent / "token.json"


def get_credentials(
    credentials_path: Path = DEFAULT_CREDENTIALS_PATH,
    token_path: Path = DEFAULT_TOKEN_PATH,
) -> Credentials:
    """Load cached credentials or run local server desktop OAuth flow."""
    if Credentials is None:
        raise RuntimeError("Google client libraries (google-auth, google-api-python-client) are required for Google Drive authentication.")

    creds: Optional[Credentials] = None

    if token_path.exists():
        try:
            creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)
        except Exception as e:
            print(f"[auth] Failed to load cached token: {e}. Re-authenticating...")
            creds = None

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            try:
                print("[auth] Refreshing expired access token...")
                creds.refresh(Request())
            except Exception as e:
                print(f"[auth] Refresh failed: {e}. Running fresh OAuth flow...")
                creds = None

        if not creds:
            if not credentials_path.exists():
                raise FileNotFoundError(
                    f"OAuth credentials file not found at: {credentials_path.resolve()}\n"
                    f"Please place your client_secret JSON at this path."
                )

            print("[auth] Initiating desktop OAuth flow...")
            print("[auth] A browser window should open. Please log in and authorize Google Drive access.")
            flow = InstalledAppFlow.from_client_secrets_file(
                str(credentials_path),
                SCOPES,
            )
            # Use random free port on localhost
            creds = flow.run_local_server(port=0, open_browser=True)

        # Save credentials for next run
        token_path.parent.mkdir(parents=True, exist_ok=True)
        with open(token_path, "w", encoding="utf-8") as f:
            f.write(creds.to_json())
        print(f"[auth] Saved credentials to {token_path}")

    return creds


def get_drive_service(
    credentials_path: Path = DEFAULT_CREDENTIALS_PATH,
    token_path: Path = DEFAULT_TOKEN_PATH,
) -> Resource:
    """Build and return an authorized Drive API v3 service resource."""
    creds = get_credentials(credentials_path, token_path)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


if __name__ == "__main__":
    print("[auth] Testing Drive API authorization...")
    service = get_drive_service()
    about = service.about().get(fields="user").execute()
    print(f"[auth] Success! Authenticated as: {about.get('user', {}).get('displayName')} ({about.get('user', {}).get('emailAddress')})")
