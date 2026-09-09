"""
Security services: bcrypt password hashing, JWT token generation,
brute-force rate limiting, and filesystem path validation.
"""

import time
import uuid
import os
from pathlib import Path
from typing import Optional, Dict, Any, List
import bcrypt
import jwt
from app.config import (
    SECRET_KEY,
    JWT_ALGORITHM,
    SESSION_EXPIRE_HOURS,
    RATE_LIMIT_MAX_ATTEMPTS,
    RATE_LIMIT_LOCKOUT_SECONDS
)
from app.database import get_db_connection

def hash_password(password: str) -> str:
    """Hashes a password using bcrypt with salt."""
    salt = bcrypt.gensalt(rounds=12)
    return bcrypt.hashpw(password.encode("utf-8"), salt).decode("utf-8")

def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verifies a plain password against the stored bcrypt hash."""
    try:
        return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))
    except Exception:
        return False

def create_access_token(user_id: int, username: str, role: str) -> str:
    """Generates a signed JWT access token with expiration and jti."""
    now = time.time()
    expires_at = now + (SESSION_EXPIRE_HOURS * 3600)
    jti = str(uuid.uuid4())
    
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "iat": int(now),
        "exp": int(expires_at),
        "jti": jti,
    }
    
    token = jwt.encode(payload, SECRET_KEY, algorithm=JWT_ALGORITHM)
    return token

def decode_access_token(token: str) -> Optional[Dict[str, Any]]:
    """Decodes and validates a JWT token, checking revocation."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALGORITHM])
        jti = payload.get("jti")
        
        # Check revocation in database
        if jti and is_token_revoked(jti):
            return None
            
        return payload
    except (jwt.PyJWTError, Exception):
        return None

def revoke_token(token: str):
    """Revokes a JWT token so it cannot be reused."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALGORITHM], options={"verify_exp": False})
        jti = payload.get("jti")
        exp = payload.get("exp", time.time() + 3600)
        if jti:
            with get_db_connection() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO revoked_tokens (token_jti, revoked_at, expires_at) VALUES (?, ?, ?)",
                    (jti, time.time(), exp)
                )
                conn.commit()
    except Exception:
        pass

def is_token_revoked(jti: str) -> bool:
    """Checks if a token JTI has been revoked."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT 1 FROM revoked_tokens WHERE token_jti = ?", (jti,))
        return cursor.fetchone() is not None

def check_rate_limit(ip_address: str) -> bool:
    """
    Checks if an IP address is currently locked out from login attempts.
    Returns True if allowed, False if locked out.
    """
    now = time.time()
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT attempts, locked_until FROM login_attempts WHERE ip_address = ?", (ip_address,))
        row = cursor.fetchone()
        if not row:
            return True
            
        locked_until = row["locked_until"]
        if locked_until > now:
            return False
            
        return True

def record_failed_attempt(ip_address: str):
    """Increments failed login counter for an IP, triggering lockout if threshold met."""
    now = time.time()
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT attempts FROM login_attempts WHERE ip_address = ?", (ip_address,))
        row = cursor.fetchone()
        
        if row:
            new_attempts = row["attempts"] + 1
            locked_until = (now + RATE_LIMIT_LOCKOUT_SECONDS) if new_attempts >= RATE_LIMIT_MAX_ATTEMPTS else 0
            cursor.execute(
                "UPDATE login_attempts SET attempts = ?, last_attempt = ?, locked_until = ? WHERE ip_address = ?",
                (new_attempts, now, locked_until, ip_address)
            )
        else:
            cursor.execute(
                "INSERT INTO login_attempts (ip_address, attempts, last_attempt, locked_until) VALUES (?, 1, ?, 0)",
                (ip_address, now)
            )
        conn.commit()

def record_successful_login(ip_address: str, user_id: int):
    """Resets rate limiting attempts upon successful login and updates user's last_login."""
    from datetime import datetime, timezone
    now_iso = datetime.now(timezone.utc).isoformat()
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM login_attempts WHERE ip_address = ?", (ip_address,))
        cursor.execute("UPDATE users SET last_login = ? WHERE id = ?", (now_iso, user_id))
        conn.commit()

# --- Strict Filesystem Security Validation ---

def is_within_directory(base_dir: Path, target_path: Path) -> bool:
    """Verifies that target_path is within base_dir without symlink bypass."""
    try:
        base = base_dir.resolve()
        target = target_path.resolve()
        return str(target) == str(base) or str(target).startswith(str(base) + os.sep)
    except Exception:
        return False

def validate_path_against_roots(requested_path: str, allowed_roots: List[str]) -> Path:
    """
    Validates that a requested path is located within one of the allowed roots.
    Resolves symlinks to their real target and blocks path traversal attempts.
    Raises PermissionError if path violates boundary.
    """
    if not requested_path or "\0" in requested_path:
        raise PermissionError("Invalid path characters detected")

    raw_path = Path(requested_path)
    
    # Resolve real path to prevent symlink traversal attacks
    try:
        resolved = raw_path.resolve()
    except Exception:
        raise PermissionError("Path resolution failed")

    # If the file does not exist yet (e.g. creating new file or folder), check parent
    check_target = resolved
    while not check_target.exists() and check_target.parent != check_target:
        check_target = check_target.parent

    for root_str in allowed_roots:
        root_path = Path(root_str).resolve()
        if is_within_directory(root_path, resolved) or is_within_directory(root_path, check_target):
            return resolved

    raise PermissionError(f"Access denied: path is outside allowed roots")
