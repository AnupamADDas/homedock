"""
Authentication Router for HomeDock.
Handles login, logout, user profile, password change, and rate-limiting.
"""

from typing import Dict, Any, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Request, Response
from pydantic import BaseModel, Field
from app.security import (
    verify_password,
    hash_password,
    create_access_token,
    revoke_token,
    check_rate_limit,
    record_failed_attempt,
    record_successful_login
)
from app.deps import get_current_user
from app.database import get_db_connection

router = APIRouter(prefix="/api/auth", tags=["auth"])

class LoginRequest(BaseModel):
    username: str
    password: str

class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str = Field(min_length=6)

@router.post("/login")
async def login(req: LoginRequest, request: Request, response: Response):
    client_ip = request.client.host if request.client else "unknown"
    
    # Rate-limiting check
    if not check_rate_limit(client_ip):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed login attempts. IP temporarily locked out. Please wait 15 minutes."
        )

    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, username, password_hash, role, is_active FROM users WHERE username = ?", (req.username.strip(),))
        user = cursor.fetchone()

    if not user or not verify_password(req.password, user["password_hash"]):
        record_failed_attempt(client_ip)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password"
        )

    if not user["is_active"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User account has been deactivated"
        )

    record_successful_login(client_ip, user["id"])
    token = create_access_token(user["id"], user["username"], user["role"])

    # Set secure cookie
    response.set_cookie(
        key="homedock_token",
        value=token,
        httponly=True,
        samesite="lax",
        secure=False,  # Set to True when HTTPS is configured
        max_age=86400 * 7
    )

    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": user["id"],
            "username": user["username"],
            "role": user["role"]
        }
    }

@router.post("/logout")
async def logout(response: Response, current_user: Dict[str, Any] = Depends(get_current_user)):
    token = current_user.get("token")
    if token:
        revoke_token(token)
    response.delete_cookie("homedock_token")
    return {"message": "Successfully logged out"}

@router.get("/me")
async def get_me(current_user: Dict[str, Any] = Depends(get_current_user)):
    from app.deps import get_user_allowed_roots
    allowed = get_user_allowed_roots(current_user)
    return {
        "id": current_user["id"],
        "username": current_user["username"],
        "role": current_user["role"],
        "allowed_roots": allowed,
    }

@router.post("/change-password")
async def change_password(req: ChangePasswordRequest, current_user: Dict[str, Any] = Depends(get_current_user)):
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT password_hash FROM users WHERE id = ?", (current_user["id"],))
        row = cursor.fetchone()
        if not row or not verify_password(req.old_password, row["password_hash"]):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Current password verification failed"
            )

        new_hash = hash_password(req.new_password)
        cursor.execute("UPDATE users SET password_hash = ? WHERE id = ?", (new_hash, current_user["id"]))
        conn.commit()

    return {"message": "Password updated successfully"}
