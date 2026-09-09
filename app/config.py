"""
HomeDock configuration module.
Loads settings from environment variables and provides sensible defaults.
"""

import os
import secrets
from pathlib import Path
from typing import List

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("HOMEDOCK_DATA_DIR", str(BASE_DIR / "data")))
DATA_DIR.mkdir(parents=True, exist_ok=True)

# Secret key persistence for session security
SECRET_KEY_FILE = DATA_DIR / ".secret_key"
if not SECRET_KEY_FILE.exists():
    SECRET_KEY_FILE.write_text(secrets.token_hex(32))
    try:
        SECRET_KEY_FILE.chmod(0o600)
    except Exception:
        pass

SECRET_KEY = os.environ.get("HOMEDOCK_SECRET_KEY", SECRET_KEY_FILE.read_text().strip())

# Aria2 RPC secret persistence
ARIA2_SECRET_FILE = DATA_DIR / ".aria2_secret"
if not ARIA2_SECRET_FILE.exists():
    ARIA2_SECRET_FILE.write_text(secrets.token_hex(24))
    try:
        ARIA2_SECRET_FILE.chmod(0o600)
    except Exception:
        pass

ARIA2_SECRET = os.environ.get("HOMEDOCK_ARIA2_SECRET", ARIA2_SECRET_FILE.read_text().strip())

# Server binding
HOST = os.environ.get("HOMEDOCK_HOST", "0.0.0.0")
PORT = int(os.environ.get("HOMEDOCK_PORT", "8090"))

# Aria2 daemon settings
ARIA2_BIN = os.environ.get("HOMEDOCK_ARIA2_BIN", str(BASE_DIR / "bin" / "aria2c"))
ARIA2_RPC_HOST = "127.0.0.1"
ARIA2_RPC_PORT = int(os.environ.get("HOMEDOCK_ARIA2_PORT", "6810"))

# Database path
DB_PATH = DATA_DIR / "homedock.db"

# Security & Sessions
JWT_ALGORITHM = "HS256"
SESSION_EXPIRE_HOURS = int(os.environ.get("HOMEDOCK_SESSION_EXPIRE_HOURS", "24"))
RATE_LIMIT_MAX_ATTEMPTS = int(os.environ.get("HOMEDOCK_RATE_LIMIT_MAX", "5"))
RATE_LIMIT_LOCKOUT_SECONDS = int(os.environ.get("HOMEDOCK_RATE_LIMIT_LOCKOUT", "900")) # 15 mins

# Default allowed filesystem roots
DEFAULT_ALLOWED_ROOTS: List[str] = [
    "/DATA/HDD",
    "/home/asus",
]

def get_initial_allowed_roots() -> List[str]:
    roots = []
    for r in DEFAULT_ALLOWED_ROOTS:
        if os.path.exists(r):
            roots.append(str(Path(r).resolve()))
    if not roots:
        roots.append(str(Path.home().resolve()))
    return roots

def get_default_download_dir() -> str:
    hdd_dl = Path("/DATA/HDD/Downloads")
    home_dl = Path.home() / "Downloads"
    if Path("/DATA/HDD").exists():
        try:
            hdd_dl.mkdir(parents=True, exist_ok=True)
            return str(hdd_dl.resolve())
        except Exception:
            pass
    home_dl.mkdir(parents=True, exist_ok=True)
    return str(home_dl.resolve())
