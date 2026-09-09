"""
Database management for HomeDock using SQLite.
Handles schema initialization, migrations, user records, and settings.
"""

import sqlite3
import json
import time
import os
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List
from app.config import DB_PATH, get_initial_allowed_roots, get_default_download_dir, DATA_DIR

def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn

def init_db():
    """Initializes SQLite database tables and default configuration."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        
        # Users table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user',
                allowed_roots TEXT,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                last_login TEXT
            );
        """)
        
        # Settings table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                description TEXT
            );
        """)
        
        # Login rate limiting table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS login_attempts (
                ip_address TEXT PRIMARY KEY,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_attempt REAL NOT NULL,
                locked_until REAL DEFAULT 0
            );
        """)
        
        # Revoked JWT tokens / Sessions table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS revoked_tokens (
                token_jti TEXT PRIMARY KEY,
                revoked_at REAL NOT NULL,
                expires_at REAL NOT NULL
            );
        """)
        
        conn.commit()

    _init_default_settings()
    _init_default_admin()

def _init_default_settings():
    defaults = {
        "global_allowed_roots": (
            json.dumps(get_initial_allowed_roots()),
            "JSON array of directories HomeDock is permitted to access"
        ),
        "default_download_dir": (
            get_default_download_dir(),
            "Default destination directory for new downloads"
        ),
        "max_download_limit": (
            "0",
            "Global download speed limit in bytes/sec (0 = unlimited)"
        ),
        "max_upload_limit": (
            "0",
            "Global upload speed limit in bytes/sec (0 = unlimited)"
        ),
        "session_timeout_hours": (
            "24",
            "Session expiration timeout in hours"
        ),
    }
    
    with get_db_connection() as conn:
        cursor = conn.cursor()
        for key, (val, desc) in defaults.items():
            cursor.execute(
                "INSERT OR IGNORE INTO settings (key, value, description) VALUES (?, ?, ?)",
                (key, val, desc)
            )

        # Self-healing: if global_allowed_roots in db has no existing paths, restore valid defaults
        cursor.execute("SELECT value FROM settings WHERE key = 'global_allowed_roots'")
        row = cursor.fetchone()
        if row:
            try:
                roots = json.loads(row["value"])
                if not isinstance(roots, list) or not any(os.path.exists(r) for r in roots):
                    cursor.execute(
                        "UPDATE settings SET value = ? WHERE key = 'global_allowed_roots'",
                        (defaults["global_allowed_roots"][0],)
                    )
            except Exception:
                pass

        # Self-healing: if default_download_dir points to non-existent path that cannot be created
        cursor.execute("SELECT value FROM settings WHERE key = 'default_download_dir'")
        row = cursor.fetchone()
        if row:
            dl_path = row["value"]
            if not os.path.exists(dl_path):
                try:
                    os.makedirs(dl_path, exist_ok=True)
                except Exception:
                    cursor.execute(
                        "UPDATE settings SET value = ? WHERE key = 'default_download_dir'",
                        (defaults["default_download_dir"][0],)
                    )

        conn.commit()

def _init_default_admin():
    from app.security import hash_password
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) as count FROM users")
        if cursor.fetchone()["count"] == 0:
            # Seed default admin
            admin_user = os.environ.get("HOMEDOCK_ADMIN_USER", "admin")
            admin_pass = os.environ.get("HOMEDOCK_ADMIN_PASSWORD", "homedock2026!")
            
            pwd_hash = hash_password(admin_pass)
            now = datetime.now(timezone.utc).isoformat()
            cursor.execute(
                "INSERT INTO users (username, password_hash, role, is_active, created_at) VALUES (?, ?, 'admin', 1, ?)",
                (admin_user, pwd_hash, now)
            )
            conn.commit()
            
            # Save notice for administrator
            creds_file = DATA_DIR / "initial_admin_credentials.txt"
            creds_file.write_text(f"HomeDock Initial Admin Credentials:\nUsername: {admin_user}\nPassword: {admin_pass}\n\nPlease change this password immediately after logging in.\n")
            try:
                creds_file.chmod(0o600)
            except Exception:
                pass

def get_setting(key: str, default: Optional[str] = None) -> Optional[str]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM settings WHERE key = ?", (key,))
        row = cursor.fetchone()
        return row["value"] if row else default

def set_setting(key: str, value: str, description: Optional[str] = None):
    with get_db_connection() as conn:
        cursor = conn.cursor()
        if description:
            cursor.execute(
                "INSERT INTO settings (key, value, description) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, description = excluded.description",
                (key, value, description)
            )
        else:
            cursor.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value)
            )
        conn.commit()

def get_all_settings() -> Dict[str, Any]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT key, value, description FROM settings")
        rows = cursor.fetchall()
        result = {}
        for r in rows:
            val = r["value"]
            # Parse json if applicable
            if r["key"] == "global_allowed_roots":
                try:
                    val = json.loads(val)
                except Exception:
                    pass
            result[r["key"]] = val
        return result
