"""
Settings Router for HomeDock.
Allows administrators to manage allowed filesystem roots,
default download paths, and application options.
"""

import json
from pathlib import Path
from typing import Dict, Any, List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from app.deps import require_admin, get_current_user
from app.database import get_all_settings, set_setting, get_setting

router = APIRouter(prefix="/api/settings", tags=["settings"])

class UpdateSettingsRequest(BaseModel):
    global_allowed_roots: Optional[List[str]] = None
    default_download_dir: Optional[str] = None
    max_download_limit: Optional[int] = None
    max_upload_limit: Optional[int] = None
    session_timeout_hours: Optional[int] = None

@router.get("")
async def get_settings(current_user: Dict[str, Any] = Depends(get_current_user)):
    settings = get_all_settings()
    if current_user.get("role") != "admin":
        # Filter for normal users
        return {
            "default_download_dir": settings.get("default_download_dir"),
            "max_download_limit": settings.get("max_download_limit"),
            "max_upload_limit": settings.get("max_upload_limit"),
        }
    return settings

@router.put("")
async def update_settings(req: UpdateSettingsRequest, admin_user: Dict[str, Any] = Depends(require_admin)):
    if req.global_allowed_roots is not None:
        validated_roots = []
        for r in req.global_allowed_roots:
            p = Path(r).resolve()
            if not p.exists():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Directory does not exist on server: {r}"
                )
            if not p.is_dir():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Path is not a directory: {r}"
                )
            validated_roots.append(str(p))
        set_setting("global_allowed_roots", json.dumps(validated_roots))

    if req.default_download_dir is not None:
        p = Path(req.default_download_dir).resolve()
        try:
            p.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Cannot create or access default download directory: {e}"
            )
        set_setting("default_download_dir", str(p))
        try:
            from app.services.download_manager import download_manager
            await download_manager.set_global_dir(str(p))
        except Exception:
            pass

        # Ensure default_download_dir is covered by global_allowed_roots
        try:
            current_roots = json.loads(get_setting("global_allowed_roots", "[]"))
            is_covered = any(
                p == Path(r).resolve() or p.is_relative_to(Path(r).resolve())
                for r in current_roots
                if Path(r).exists()
            )
            if not is_covered:
                current_roots.append(str(p))
                set_setting("global_allowed_roots", json.dumps(current_roots))
        except Exception:
            pass

    if req.max_download_limit is not None:
        set_setting("max_download_limit", str(req.max_download_limit))
        from app.services.download_manager import download_manager
        ul = int(get_setting("max_upload_limit", "0"))
        try:
            await download_manager.set_global_limits(req.max_download_limit, ul)
        except Exception:
            pass

    if req.max_upload_limit is not None:
        set_setting("max_upload_limit", str(req.max_upload_limit))
        from app.services.download_manager import download_manager
        dl = int(get_setting("max_download_limit", "0"))
        try:
            await download_manager.set_global_limits(dl, req.max_upload_limit)
        except Exception:
            pass

    if req.session_timeout_hours is not None:
        if req.session_timeout_hours < 1:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Session timeout must be >= 1 hour")
        set_setting("session_timeout_hours", str(req.session_timeout_hours))

    return {"success": True, "settings": get_all_settings()}
