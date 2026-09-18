"""
HomeDock configuration module.
Loads settings from environment variables and provides sensible defaults.
"""

import os
import secrets
import shutil
import subprocess
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
def _resolve_aria2_bin() -> str:
    env_bin = os.environ.get("HOMEDOCK_ARIA2_BIN")
    if env_bin:
        return env_bin
    bundled = BASE_DIR / "bin" / "aria2c"
    if bundled.exists() and os.access(bundled, os.X_OK):
        try:
            res = subprocess.run(
                [str(bundled), "--version"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=1
            )
            if res.returncode == 0:
                return str(bundled)
        except Exception:
            pass
    # Fallback to system-installed aria2c
    sys_bin = shutil.which("aria2c")
    if sys_bin:
        return sys_bin
    return str(bundled)

ARIA2_BIN = _resolve_aria2_bin()
ARIA2_RPC_HOST = "127.0.0.1"
ARIA2_RPC_PORT = int(os.environ.get("HOMEDOCK_ARIA2_PORT", "6810"))

# Database path
DB_PATH = DATA_DIR / "homedock.db"

# Security & Sessions
JWT_ALGORITHM = "HS256"
SESSION_EXPIRE_HOURS = int(os.environ.get("HOMEDOCK_SESSION_EXPIRE_HOURS", "24"))
RATE_LIMIT_MAX_ATTEMPTS = int(os.environ.get("HOMEDOCK_RATE_LIMIT_MAX", "5"))
RATE_LIMIT_LOCKOUT_SECONDS = int(os.environ.get("HOMEDOCK_RATE_LIMIT_LOCKOUT", "900")) # 15 mins

# Allowed filesystem roots
def get_initial_allowed_roots() -> List[str]:
    """
    Determines initial allowed roots dynamically:
    1. Reads HOMEDOCK_ALLOWED_ROOTS environment variable if specified (comma-separated)
    2. Includes the user's home directory
    3. Discovers readable mount points under standard Linux mount locations (/media, /mnt)
    """
    env_roots = os.environ.get("HOMEDOCK_ALLOWED_ROOTS")
    if env_roots:
        custom_roots = [
            str(Path(r.strip()).resolve())
            for r in env_roots.replace(";", ",").split(",")
            if r.strip() and os.path.exists(r.strip())
        ]
        if custom_roots:
            return custom_roots

    roots: List[str] = [str(Path.home().resolve())]

    # Auto-discover readable mount points under standard Linux media locations
    for base in ("/media", "/mnt"):
        if os.path.isdir(base):
            try:
                for entry in Path(base).iterdir():
                    if entry.is_dir() and os.access(entry, os.R_OK):
                        resolved = str(entry.resolve())
                        if resolved not in roots:
                            roots.append(resolved)
            except Exception:
                pass

    return roots

DEFAULT_ALLOWED_ROOTS: List[str] = get_initial_allowed_roots()

def get_default_download_dir() -> str:
    """
    Determines default download directory dynamically:
    1. HOMEDOCK_DEFAULT_DOWNLOAD_DIR environment variable if specified
    2. ~/Downloads folder
    """
    env_dl = os.environ.get("HOMEDOCK_DEFAULT_DOWNLOAD_DIR")
    if env_dl:
        try:
            dl_path = Path(env_dl).resolve()
            dl_path.mkdir(parents=True, exist_ok=True)
            return str(dl_path)
        except Exception:
            pass

    home_dl = Path.home() / "Downloads"
    try:
        home_dl.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    return str(home_dl.resolve())
