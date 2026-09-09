"""
FastAPI dependency injection utilities for authentication, authorization, and allowed roots.
"""

import os
import json
from typing import Optional, List, Dict, Any
from fastapi import Depends, HTTPException, status, Request, Cookie
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.security import decode_access_token
from app.database import get_db_connection, get_setting

security_bearer = HTTPBearer(auto_error=False)

async def get_current_user(
    request: Request,
    auth_header: Optional[HTTPAuthorizationCredentials] = Depends(security_bearer),
    homedock_token: Optional[str] = Cookie(None)
) -> Dict[str, Any]:
    """
    Extracts and authenticates the current user from Authorization header or cookie.
    Raises 401 Unauthorized if invalid or missing.
    """
    token = None
    if auth_header and auth_header.credentials:
        token = auth_header.credentials
    elif homedock_token:
        token = homedock_token
    elif "homedock_token" in request.query_params:
        token = request.query_params.get("homedock_token")
    elif "token" in request.query_params:
        token = request.query_params.get("token")

    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )

    payload = decode_access_token(token)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired authentication token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user_id = payload.get("sub")
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, username, role, allowed_roots, is_active FROM users WHERE id = ?",
            (user_id,)
        )
        user = cursor.fetchone()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account no longer exists",
        )

    if not user["is_active"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User account is deactivated",
        )

    user_dict = dict(user)
    user_dict["token"] = token
    return user_dict

async def require_admin(current_user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
    """Ensures the authenticated user possesses the 'admin' role."""
    if current_user.get("role") != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrative privileges required",
        )
    return current_user

def get_user_allowed_roots(user: Dict[str, Any]) -> List[str]:
    """
    Retrieves the allowed filesystem roots for a user.
    If the user has custom roots assigned, returns them.
    Otherwise, returns global allowed roots.
    """
    if user.get("allowed_roots"):
        try:
            custom = json.loads(user["allowed_roots"])
            if isinstance(custom, list) and custom:
                return custom
        except Exception:
            pass

    # Fallback to global setting
    raw_global = get_setting("global_allowed_roots", "[]")
    try:
        global_roots = json.loads(raw_global)
        if isinstance(global_roots, list) and global_roots:
            existing = [r for r in global_roots if os.path.exists(r)]
            if existing:
                return existing
    except Exception:
        pass

    from app.config import get_initial_allowed_roots
    return get_initial_allowed_roots()
