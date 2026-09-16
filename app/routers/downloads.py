"""
Download Manager Router for HomeDock.
Exposes AriaNg-style download controls (HTTP, Torrents, Magnets),
speed limiting, and destination management.
"""

import os
from pathlib import Path
from typing import Dict, Any, List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Form
from pydantic import BaseModel, Field
from app.services.download_manager import download_manager
from app.services.file_service import file_service
from app.deps import get_current_user, get_user_allowed_roots
from app.database import get_setting, set_setting

router = APIRouter(prefix="/api/downloads", tags=["downloads"])

class AddUriRequest(BaseModel):
    uris: List[str]
    destination: Optional[str] = None
    max_download_limit: Optional[int] = 0
    filename: Optional[str] = None
    save_as_default: Optional[bool] = False

class UpdateDefaultDirRequest(BaseModel):
    default_dir: str

class DeleteDownloadRequest(BaseModel):
    delete_files: bool = False

class SpeedLimitRequest(BaseModel):
    limit_bytes_sec: int = Field(ge=0)

class GlobalLimitsRequest(BaseModel):
    download_limit: int = Field(ge=0)
    upload_limit: int = Field(ge=0)

class YoutubeProbeRequest(BaseModel):
    url: str

class YoutubeAddRequest(BaseModel):
    url: str
    destination: Optional[str] = None
    destination_dir: Optional[str] = None
    mode: Optional[str] = "video"
    media_type: Optional[str] = None
    resolution: Optional[str] = "best"
    video_format: Optional[str] = "mp4"
    audio_format: Optional[str] = "mp3"
    audio_quality: Optional[str] = "best"
    embed_subtitles: Optional[bool] = False
    embed_thumbnail: Optional[bool] = True
    embed_metadata: Optional[bool] = True
    playlist_items: Optional[str] = None
    save_as_default: Optional[bool] = False
    title_hint: Optional[str] = None
    thumbnail_hint: Optional[str] = None
    channel_hint: Optional[str] = None

@router.get("/list")
async def list_downloads(current_user: Dict[str, Any] = Depends(get_current_user)):
    try:
        downloads = await download_manager.get_all_downloads()
        return downloads
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@router.get("/stats")
async def get_download_stats(current_user: Dict[str, Any] = Depends(get_current_user)):
    try:
        return await download_manager.get_global_stat()
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@router.get("/default-dir")
async def get_default_directory(current_user: Dict[str, Any] = Depends(get_current_user)):
    from app.config import get_default_download_dir
    default_dir = get_setting("default_download_dir", get_default_download_dir())
    if not os.path.exists(default_dir):
        try:
            Path(default_dir).mkdir(parents=True, exist_ok=True)
        except Exception:
            default_dir = get_default_download_dir()
    return {"default_dir": default_dir}

@router.put("/default-dir")
async def set_default_directory(req: UpdateDefaultDirRequest, current_user: Dict[str, Any] = Depends(get_current_user)):
    is_admin = current_user.get("role") == "admin"
    allowed_roots = get_user_allowed_roots(current_user)
    try:
        if is_admin:
            resolved = Path(req.default_dir.strip()).resolve()
        else:
            resolved = file_service.validate_path(req.default_dir.strip(), allowed_roots, check_exists=False)
        resolved.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid download directory: {e}")

    set_setting("default_download_dir", str(resolved))
    try:
        await download_manager.set_global_dir(str(resolved))
    except Exception:
        pass

    # Ensure default_download_dir is covered in global_allowed_roots
    try:
        import json
        current_roots = json.loads(get_setting("global_allowed_roots", "[]"))
        is_covered = any(
            resolved == Path(r).resolve() or resolved.is_relative_to(Path(r).resolve())
            for r in current_roots
            if Path(r).exists()
        )
        if not is_covered:
            current_roots.append(str(resolved))
            set_setting("global_allowed_roots", json.dumps(current_roots))
    except Exception:
        pass

    return {"success": True, "default_dir": str(resolved)}

@router.post("/add")
async def add_uri_download(req: AddUriRequest, current_user: Dict[str, Any] = Depends(get_current_user)):
    allowed_roots = get_user_allowed_roots(current_user)
    
    # Destination directory resolution
    if req.destination and req.destination.strip():
        dest = req.destination.strip()
    else:
        from app.config import get_default_download_dir
        dest = get_setting("default_download_dir", get_default_download_dir())

    try:
        resolved_dest = file_service.validate_path(dest, allowed_roots, check_exists=False)
    except PermissionError as e:
        from app.config import get_default_download_dir
        default_configured = get_setting("default_download_dir", get_default_download_dir())
        if Path(dest).resolve() == Path(default_configured).resolve():
            resolved_dest = Path(dest).resolve()
        else:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"Target directory outside permitted storage: {e}")

    resolved_dest.mkdir(parents=True, exist_ok=True)

    if req.save_as_default and req.destination and req.destination.strip():
        set_setting("default_download_dir", str(resolved_dest))
        try:
            await download_manager.set_global_dir(str(resolved_dest))
        except Exception:
            pass
        try:
            import json
            current_roots = json.loads(get_setting("global_allowed_roots", "[]"))
            if not any(resolved_dest == Path(r).resolve() or resolved_dest.is_relative_to(Path(r).resolve()) for r in current_roots if Path(r).exists()):
                current_roots.append(str(resolved_dest))
                set_setting("global_allowed_roots", json.dumps(current_roots))
        except Exception:
            pass

    try:
        gid = await download_manager.add_uri(
            uris=req.uris,
            destination_dir=str(resolved_dest),
            max_download_limit=req.max_download_limit,
            filename=req.filename
        )
        return {"success": True, "gid": gid}
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

@router.post("/add-torrent")
async def add_torrent_download(
    file: UploadFile = File(...),
    destination: Optional[str] = Form(None),
    max_download_limit: Optional[int] = Form(0),
    save_as_default: Optional[bool] = Form(False),
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    allowed_roots = get_user_allowed_roots(current_user)
    
    if destination and destination.strip():
        dest = destination.strip()
    else:
        from app.config import get_default_download_dir
        dest = get_setting("default_download_dir", get_default_download_dir())

    try:
        resolved_dest = file_service.validate_path(dest, allowed_roots, check_exists=False)
    except PermissionError as e:
        from app.config import get_default_download_dir
        default_configured = get_setting("default_download_dir", get_default_download_dir())
        if Path(dest).resolve() == Path(default_configured).resolve():
            resolved_dest = Path(dest).resolve()
        else:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"Target directory outside permitted storage: {e}")

    resolved_dest.mkdir(parents=True, exist_ok=True)

    if save_as_default and destination and destination.strip():
        set_setting("default_download_dir", str(resolved_dest))
        try:
            await download_manager.set_global_dir(str(resolved_dest))
        except Exception:
            pass
        try:
            import json
            current_roots = json.loads(get_setting("global_allowed_roots", "[]"))
            if not any(resolved_dest == Path(r).resolve() or resolved_dest.is_relative_to(Path(r).resolve()) for r in current_roots if Path(r).exists()):
                current_roots.append(str(resolved_dest))
                set_setting("global_allowed_roots", json.dumps(current_roots))
        except Exception:
            pass

    content = await file.read()
    try:
        gid = await download_manager.add_torrent(
            torrent_bytes=content,
            destination_dir=str(resolved_dest),
            max_download_limit=max_download_limit
        )
        return {"success": True, "gid": gid}
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

@router.post("/{gid}/pause")
async def pause_download(gid: str, current_user: Dict[str, Any] = Depends(get_current_user)):
    try:
        res = await download_manager.pause(gid)
        return {"success": True, "gid": res}
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

@router.post("/{gid}/unpause")
async def unpause_download(gid: str, current_user: Dict[str, Any] = Depends(get_current_user)):
    try:
        res = await download_manager.unpause(gid)
        return {"success": True, "gid": res}
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

@router.post("/{gid}/remove")
async def remove_download(gid: str, current_user: Dict[str, Any] = Depends(get_current_user)):
    try:
        res = await download_manager.remove(gid)
        return {"success": True, "gid": res}
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

@router.post("/{gid}/retry")
async def retry_download(gid: str, current_user: Dict[str, Any] = Depends(get_current_user)):
    try:
        new_gid = await download_manager.retry(gid)
        return {"success": True, "gid": new_gid}
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

@router.post("/{gid}/delete")
async def delete_download(
    gid: str,
    req: DeleteDownloadRequest,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    allowed_roots = get_user_allowed_roots(current_user)
    try:
        res = await download_manager.delete_download(gid, delete_files=req.delete_files, allowed_roots=allowed_roots)
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

@router.post("/{gid}/limit")
async def set_download_limit(
    gid: str,
    req: SpeedLimitRequest,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    try:
        await download_manager.set_download_limit(gid, req.limit_bytes_sec)
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

@router.post("/global-limits")
async def set_global_speed_limits(
    req: GlobalLimitsRequest,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    # Only admin can set global limits
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin permissions required")

    try:
        await download_manager.set_global_limits(req.download_limit, req.upload_limit)
        set_setting("max_download_limit", str(req.download_limit))
        set_setting("max_upload_limit", str(req.upload_limit))
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

@router.post("/youtube/probe")
async def probe_youtube_url(
    req: YoutubeProbeRequest,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    """Fetches video/playlist metadata, available resolutions, and stream details."""
    url = req.url.strip()
    if not url:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="URL cannot be empty")
    try:
        from app.services.youtube_downloader import youtube_downloader
        data = await youtube_downloader.probe_url(url)
        return data
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

@router.post("/youtube/add")
async def add_youtube_download(
    req: YoutubeAddRequest,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    """Queues a YouTube/streaming media download task with Stacher-grade format/quality options."""
    url = req.url.strip()
    if not url:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="URL cannot be empty")

    from app.config import get_default_download_dir
    allowed_roots = get_user_allowed_roots(current_user)

    target_dir = req.destination or req.destination_dir
    if not target_dir or not target_dir.strip():
        target_dir = get_setting("default_download_dir", get_default_download_dir())

    target_dir = target_dir.strip()

    try:
        resolved_dest = file_service.validate_path(target_dir, allowed_roots, check_exists=False)
        resolved_dest.mkdir(parents=True, exist_ok=True)
    except PermissionError as e:
        default_configured = get_setting("default_download_dir", get_default_download_dir())
        if Path(target_dir).resolve() == Path(default_configured).resolve():
            resolved_dest = Path(target_dir).resolve()
            resolved_dest.mkdir(parents=True, exist_ok=True)
        else:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"Destination directory is outside permitted storage: {e}")
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"Destination directory is outside permitted storage: {e}")

    if req.save_as_default:
        set_setting("default_download_dir", str(resolved_dest))
        try:
            await download_manager.set_global_dir(str(resolved_dest))
        except Exception:
            pass

    media_mode = req.media_type or req.mode or "video"
    from app.services.youtube_downloader import youtube_downloader
    gid = youtube_downloader.start_download(
        url=url,
        destination_dir=str(resolved_dest),
        mode=media_mode,
        resolution=req.resolution,
        video_format=req.video_format,
        audio_format=req.audio_format,
        audio_quality=req.audio_quality,
        embed_subtitles=bool(req.embed_subtitles),
        embed_thumbnail=bool(req.embed_thumbnail),
        embed_metadata=bool(req.embed_metadata),
        playlist_items=req.playlist_items,
        title_hint=req.title_hint,
        thumbnail_hint=req.thumbnail_hint,
        channel_hint=req.channel_hint,
    )

    return {"success": True, "gid": gid}
