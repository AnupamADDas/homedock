"""
User Management Router for HomeDock.
RBAC administration for creating, updating, and managing user roles and permissions.
"""

import json
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from app.deps import require_admin
from app.database import get_db_connection
from app.security import hash_password

router = APIRouter(prefix="/api/users", tags=["users"])

class CreateUserRequest(BaseModel):
    username: str = Field(min_length=3, max_length=50)
    password: str = Field(min_length=6)
    role: str = Field(default="user")
    allowed_roots: Optional[List[str]] = None

class UpdateUserRequest(BaseModel):
    username: Optional[str] = Field(None, min_length=3, max_length=50)
    role: Optional[str] = None
    is_active: Optional[bool] = None
    allowed_roots: Optional[List[str]] = None
    password: Optional[str] = Field(None, min_length=6)

@router.get("")
async def list_users(admin_user: Dict[str, Any] = Depends(require_admin)):
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, username, role, allowed_roots, is_active, created_at, last_login FROM users ORDER BY id ASC")
        rows = cursor.fetchall()
        
        users = []
        for r in rows:
            u = dict(r)
            if u["allowed_roots"]:
                try:
                    u["allowed_roots"] = json.loads(u["allowed_roots"])
                except Exception:
                    pass
            users.append(u)
        return users

@router.post("")
async def create_user(req: CreateUserRequest, admin_user: Dict[str, Any] = Depends(require_admin)):
    if req.role not in ("admin", "user"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Role must be 'admin' or 'user'")

    pwd_hash = hash_password(req.password)
    now = datetime.now(timezone.utc).isoformat()
    roots_json = json.dumps(req.allowed_roots) if req.allowed_roots is not None else None

    try:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO users (username, password_hash, role, allowed_roots, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)",
                (req.username.strip(), pwd_hash, req.role, roots_json, now)
            )
            new_id = cursor.lastrowid
            conn.commit()
            return {"success": True, "id": new_id, "username": req.username}
    except Exception as e:
        if "UNIQUE constraint" in str(e):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username already exists")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@router.put("/{user_id}")
async def update_user(user_id: int, req: UpdateUserRequest, admin_user: Dict[str, Any] = Depends(require_admin)):
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, username, role FROM users WHERE id = ?", (user_id,))
        user = cursor.fetchone()
        if not user:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

        updates = []
        params = []

        if req.username is not None:
            new_username = req.username.strip()
            if len(new_username) < 3 or len(new_username) > 50:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Username must be between 3 and 50 characters")
            cursor.execute("SELECT id FROM users WHERE username = ? AND id != ?", (new_username, user_id))
            if cursor.fetchone():
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username already exists")
            updates.append("username = ?")
            params.append(new_username)

        if req.role is not None:
            if req.role not in ("admin", "user"):
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid role")
            # Prevent demoting the only admin
            if user["role"] == "admin" and req.role != "admin":
                cursor.execute("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND is_active = 1")
                if cursor.fetchone()["count"] <= 1:
                    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot demote the only active administrator")
            updates.append("role = ?")
            params.append(req.role)

        if req.is_active is not None:
            if user_id == admin_user["id"] and not req.is_active:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot deactivate your own account")
            updates.append("is_active = ?")
            params.append(1 if req.is_active else 0)

        if req.allowed_roots is not None:
            updates.append("allowed_roots = ?")
            params.append(json.dumps(req.allowed_roots))

        if req.password is not None:
            updates.append("password_hash = ?")
            params.append(hash_password(req.password))

        if updates:
            params.append(user_id)
            query = f"UPDATE users SET {', '.join(updates)} WHERE id = ?"
            cursor.execute(query, tuple(params))
            conn.commit()

        return {"success": True, "message": "User updated"}

@router.delete("/{user_id}")
async def delete_user(user_id: int, admin_user: Dict[str, Any] = Depends(require_admin)):
    if user_id == admin_user["id"]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot delete your own account")

    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT role FROM users WHERE id = ?", (user_id,))
        user = cursor.fetchone()
        if not user:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

        if user["role"] == "admin":
            cursor.execute("SELECT COUNT(*) as count FROM users WHERE role = 'admin'")
            if cursor.fetchone()["count"] <= 1:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot delete the sole administrator")

        cursor.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()

    return {"success": True, "message": "User deleted"}
