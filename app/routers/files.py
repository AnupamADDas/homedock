"""
File Operations Router for HomeDock.
Enforces strict allowed-roots validation, safe archive extraction,
and chunked file upload/download streaming.
"""

import os
import shutil
import mimetypes
from pathlib import Path
from typing import Dict, Any, List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query, UploadFile, File, Form, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from app.services.file_service import file_service, TaskCancelledException
from app.services.task_manager import task_manager
from app.deps import get_current_user, get_user_allowed_roots

router = APIRouter(prefix="/api/files", tags=["files"])

class MkdirRequest(BaseModel):
    path: str

class RenameRequest(BaseModel):
    source: str
    new_name: str

class DeleteRequest(BaseModel):
    paths: List[str]

class TransferRequest(BaseModel):
    sources: List[str]
    destination: str
    task_id: Optional[str] = None

class ExtractRequest(BaseModel):
    archive_path: str
    destination: Optional[str] = None
    task_id: Optional[str] = None

@router.get("/list")
async def list_files(
    path: Optional[str] = Query(None),
    show_hidden: bool = Query(False),
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    allowed_roots = get_user_allowed_roots(current_user)
    target_path = path or (allowed_roots[0] if allowed_roots else str(Path.home()))

    try:
        data = file_service.list_directory(Path(target_path), allowed_roots, show_hidden=show_hidden)
        data["allowed_roots"] = allowed_roots

        # Build accessible storage chips for file manager
        storage_chips = []
        seen = set()
        for r in allowed_roots:
            if os.path.exists(r):
                rp = str(Path(r).resolve())
                if rp not in seen:
                    if rp == "/":
                        label = "Root System (/)"
                    elif rp == str(Path.home().resolve()):
                        label = f"Home (~/{Path(r).name})"
                    else:
                        label = f"Storage: {Path(r).name or r}"
                    storage_chips.append({"label": label, "path": rp, "type": "root"})
                    seen.add(rp)

        try:
            from app.services.storage_manager import storage_manager
            mounts = storage_manager.get_mounted_locations()
            for m in mounts:
                mp = str(Path(m["mountpoint"]).resolve())
                if mp not in seen and os.path.exists(mp) and os.access(mp, os.R_OK):
                    if any(mp == str(Path(ar).resolve()) or Path(mp).is_relative_to(Path(ar).resolve()) for ar in allowed_roots):
                        storage_chips.append({
                            "label": m.get("label") or mp,
                            "path": mp,
                            "type": m.get("type", "drive")
                        })
                        seen.add(mp)
        except Exception:
            pass

        data["storage_chips"] = storage_chips
        return data
    except PermissionError as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    except NotADirectoryError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@router.get("/browse-folders")
async def browse_folders(
    path: Optional[str] = Query(None),
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Returns directory hierarchy, breadcrumbs, quick mount points, and subdirectories
    for interactive visual directory selection (matching PulseDL folder browser).
    """
    is_admin = current_user.get("role") == "admin"
    allowed_roots = get_user_allowed_roots(current_user)

    # 1. Resolve starting path
    if path and path.strip():
        target_path = Path(path.strip()).resolve()
        if not is_admin:
            target_path = file_service.validate_path(str(target_path), allowed_roots, check_exists=True)
        elif not target_path.exists():
            target_path = Path(allowed_roots[0]).resolve() if allowed_roots else Path.home().resolve()
    else:
        if allowed_roots and os.path.exists(allowed_roots[0]):
            target_path = Path(allowed_roots[0]).resolve()
        else:
            target_path = Path.home().resolve()

    if not target_path.is_dir():
        target_path = target_path.parent

    # 2. Build breadcrumbs
    parts = str(target_path).strip("/").split("/") if str(target_path) != "/" else []
    crumbs = [{"name": "/", "path": "/"}]
    curr = ""
    for p in parts:
        if not p:
            continue
        curr += "/" + p
        crumbs.append({"name": p, "path": curr})

    if not is_admin:
        def is_within_allowed(p_str):
            for root in allowed_roots:
                if p_str == root or p_str.startswith(root.rstrip("/") + "/"):
                    return True
            return False
        crumbs = [c for c in crumbs if is_within_allowed(c["path"])]

    # 3. Parent path
    parent_path = None
    if target_path != Path("/"):
        cand_parent = target_path.parent
        if is_admin:
            parent_path = str(cand_parent)
        else:
            for root in allowed_roots:
                if str(cand_parent) == root or str(cand_parent).startswith(root.rstrip("/") + "/"):
                    parent_path = str(cand_parent)
                    break

    # 4. Quick locations / storage presets
    from app.services.storage_manager import storage_manager
    from app.database import get_setting
    from app.config import get_default_download_dir
    
    quick_locations = []
    seen_paths = set()
    
    for r in allowed_roots:
        if os.path.exists(r) and r not in seen_paths:
            name = Path(r).name or r
            quick_locations.append({"name": f"Root: {name}", "path": r, "icon": "storage"})
            seen_paths.add(r)

    try:
        mounts = storage_manager.get_mounted_locations()
        for m in mounts:
            mp = m["mountpoint"]
            if mp not in seen_paths and os.path.exists(mp) and os.access(mp, os.R_OK):
                if is_admin or any(mp == ar or mp.startswith(ar.rstrip("/") + "/") for ar in allowed_roots):
                    name = f"Drive: {m.get('label') or Path(mp).name or mp}"
                    quick_locations.append({"name": name, "path": mp, "icon": "drive"})
                    seen_paths.add(mp)
    except Exception:
        pass

    home_dir = str(Path.home().resolve())
    if home_dir not in seen_paths and os.path.exists(home_dir):
        if is_admin or any(home_dir == ar or home_dir.startswith(ar.rstrip("/") + "/") for ar in allowed_roots):
            quick_locations.append({"name": "User Home (~)", "path": home_dir, "icon": "home"})
            seen_paths.add(home_dir)

    default_dl = get_setting("default_download_dir", get_default_download_dir())
    if default_dl and os.path.exists(default_dl) and default_dl not in seen_paths:
        quick_locations.append({"name": "Downloads", "path": default_dl, "icon": "download"})
        seen_paths.add(default_dl)

    # 5. List subdirectories
    subdirs = []
    try:
        with os.scandir(target_path) as it:
            for entry in it:
                try:
                    if entry.is_dir(follow_symlinks=False) and not entry.name.startswith("."):
                        p_str = entry.path
                        if not is_admin:
                            allowed = False
                            for ar in allowed_roots:
                                if p_str == ar or p_str.startswith(ar.rstrip("/") + "/") or ar.startswith(p_str.rstrip("/") + "/"):
                                    allowed = True
                                    break
                            if not allowed:
                                continue
                        subdirs.append({
                            "name": entry.name,
                            "path": p_str,
                            "writable": os.access(p_str, os.W_OK)
                        })
                except (PermissionError, OSError):
                    continue
    except (PermissionError, OSError):
        pass

    subdirs.sort(key=lambda x: x["name"].lower())

    return {
        "current_path": str(target_path),
        "parent_path": parent_path,
        "breadcrumbs": crumbs,
        "quick_locations": quick_locations,
        "directories": subdirs,
        "writable": os.access(str(target_path), os.W_OK),
        "is_admin": is_admin
    }

@router.get("/info")
async def get_info(path: str = Query(...), current_user: Dict[str, Any] = Depends(get_current_user)):
    allowed_roots = get_user_allowed_roots(current_user)
    try:
        return file_service.get_item_info(Path(path), allowed_roots)
    except PermissionError as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))

@router.get("/download")
async def download_file(
    request: Request,
    path: str = Query(...),
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    allowed_roots = get_user_allowed_roots(current_user)
    try:
        resolved = file_service.validate_path(path, allowed_roots, check_exists=True)
        if not resolved.is_file():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Target is not a file")

        file_size = resolved.stat().st_size
        mime_type, _ = mimetypes.guess_type(str(resolved))
        mime_type = mime_type or "application/octet-stream"

        # Buffer size: 1 MB chunks to eliminate small-block disk thrashing and maximize throughput
        CHUNK_SIZE = 1024 * 1024

        range_header = request.headers.get("range") or request.headers.get("Range")

        if range_header and range_header.startswith("bytes="):
            try:
                range_val = range_header.replace("bytes=", "").strip()
                parts = range_val.split("-")
                
                if len(parts) == 2:
                    start_str, end_str = parts[0].strip(), parts[1].strip()
                    if start_str and end_str:
                        start = int(start_str)
                        end = min(int(end_str), file_size - 1)
                    elif start_str:
                        start = int(start_str)
                        end = file_size - 1
                    elif end_str:
                        suffix = int(end_str)
                        start = max(file_size - suffix, 0)
                        end = file_size - 1
                    else:
                        start = 0
                        end = file_size - 1
                else:
                    start = 0
                    end = file_size - 1

                if start > end or start >= file_size:
                    raise HTTPException(
                        status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
                        headers={"Content-Range": f"bytes */{file_size}"}
                    )

                content_length = end - start + 1

                def iter_range():
                    with open(resolved, "rb") as f:
                        f.seek(start)
                        remaining = content_length
                        while remaining > 0:
                            read_size = min(remaining, CHUNK_SIZE)
                            data = f.read(read_size)
                            if not data:
                                break
                            remaining -= len(data)
                            yield data

                headers = {
                    "Content-Range": f"bytes {start}-{end}/{file_size}",
                    "Accept-Ranges": "bytes",
                    "Content-Length": str(content_length),
                    "Content-Disposition": f'attachment; filename="{resolved.name}"',
                    "Content-Type": mime_type,
                    "Cache-Control": "public, max-age=3600",
                }

                return StreamingResponse(
                    iter_range(),
                    status_code=status.HTTP_206_PARTIAL_CONTENT,
                    headers=headers
                )

            except (ValueError, IndexError):
                pass

        # Full file stream with 1MB chunks and Accept-Ranges advertisement
        def iter_full():
            with open(resolved, "rb") as f:
                while chunk := f.read(CHUNK_SIZE):
                    yield chunk

        headers = {
            "Accept-Ranges": "bytes",
            "Content-Length": str(file_size),
            "Content-Disposition": f'attachment; filename="{resolved.name}"',
            "Content-Type": mime_type,
            "Cache-Control": "public, max-age=3600",
        }

        return StreamingResponse(
            iter_full(),
            status_code=status.HTTP_200_OK,
            headers=headers
        )

    except PermissionError as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))

@router.post("/upload")
async def upload_file(
    destination: str = Form(...),
    file: UploadFile = File(...),
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    allowed_roots = get_user_allowed_roots(current_user)
    try:
        dest_dir = file_service.validate_path(destination, allowed_roots, check_exists=True)
        if not dest_dir.is_dir():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Destination must be a directory")

        # Sanitize filename
        safe_filename = os.path.basename(file.filename or "uploaded_file")
        if not safe_filename or safe_filename in (".", ".."):
            safe_filename = "uploaded_file"

        target_file = dest_dir / safe_filename
        target_file = file_service.validate_path(str(target_file), allowed_roots, check_exists=False)

        # Stream chunked write to disk
        with open(target_file, "wb") as buffer:
            while content := await file.read(1024 * 1024):  # 1MB chunks
                buffer.write(content)

        return {
            "success": True,
            "filename": safe_filename,
            "path": str(target_file),
            "size": target_file.stat().st_size
        }
    except PermissionError as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@router.post("/mkdir")
async def create_directory(req: MkdirRequest, current_user: Dict[str, Any] = Depends(get_current_user)):
    allowed_roots = get_user_allowed_roots(current_user)
    is_admin = current_user.get("role") == "admin"
    try:
        if is_admin:
            target = Path(req.path).resolve()
            if target.exists():
                raise FileExistsError(f"Directory already exists: {target.name}")
            target.mkdir(parents=True, exist_ok=True)
            return {"success": True, "path": str(target)}
        else:
            created = file_service.create_directory(Path(req.path), allowed_roots)
            return {"success": True, "path": str(created)}
    except PermissionError as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))
    except FileExistsError as e:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@router.post("/rename")
async def rename_item(req: RenameRequest, current_user: Dict[str, Any] = Depends(get_current_user)):
    allowed_roots = get_user_allowed_roots(current_user)
    try:
        renamed = file_service.rename_item(Path(req.source), req.new_name, allowed_roots)
        return {"success": True, "path": str(renamed)}
    except PermissionError as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))
    except FileExistsError as e:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

import asyncio

@router.post("/delete")
async def delete_items(req: DeleteRequest, current_user: Dict[str, Any] = Depends(get_current_user)):
    allowed_roots = get_user_allowed_roots(current_user)
    try:
        deleted = await asyncio.to_thread(file_service.delete_items, req.paths, allowed_roots)
        return {"success": True, "deleted": deleted}
    except PermissionError as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@router.post("/copy")
async def copy_items(req: TransferRequest, current_user: Dict[str, Any] = Depends(get_current_user)):
    allowed_roots = get_user_allowed_roots(current_user)
    task_id = req.task_id
    if task_id:
        task_manager.set_loop(asyncio.get_running_loop())
        sample_name = req.sources[0].split("/")[-1] if req.sources else "items"
        title = f"Copying {sample_name}" if len(req.sources) == 1 else f"Copying {len(req.sources)} items"
        task_manager.create_task(task_id, "copy", title)

    def progress_cb(pct: float, detail: str, done: int, total: int):
        if task_id:
            task_manager.update_task(task_id, pct, detail, done, total)

    try:
        copied = await asyncio.to_thread(
            file_service.copy_items,
            req.sources,
            req.destination,
            allowed_roots,
            progress_cb if task_id else None,
            (lambda: task_manager.is_cancelled(task_id)) if task_id else None
        )
        if task_id:
            if task_manager.is_cancelled(task_id):
                return {"success": False, "cancelled": True, "task_id": task_id}
            task_manager.complete_task(task_id, f"Copied {len(copied)} item(s)")
        return {"success": True, "copied": copied, "task_id": task_id}
    except TaskCancelledException:
        if task_id:
            task_manager.cancel_task(task_id)
        return {"success": False, "cancelled": True, "task_id": task_id}
    except PermissionError as e:
        if task_id:
            task_manager.fail_task(task_id, str(e))
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))
    except Exception as e:
        if task_id:
            task_manager.fail_task(task_id, str(e))
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@router.post("/move")
async def move_items(req: TransferRequest, current_user: Dict[str, Any] = Depends(get_current_user)):
    allowed_roots = get_user_allowed_roots(current_user)
    task_id = req.task_id
    if task_id:
        task_manager.set_loop(asyncio.get_running_loop())
        sample_name = req.sources[0].split("/")[-1] if req.sources else "items"
        title = f"Moving {sample_name}" if len(req.sources) == 1 else f"Moving {len(req.sources)} items"
        task_manager.create_task(task_id, "move", title)

    def progress_cb(pct: float, detail: str, done: int, total: int):
        if task_id:
            task_manager.update_task(task_id, pct, detail, done, total)

    try:
        moved = await asyncio.to_thread(
            file_service.move_items,
            req.sources,
            req.destination,
            allowed_roots,
            progress_cb if task_id else None,
            (lambda: task_manager.is_cancelled(task_id)) if task_id else None
        )
        if task_id:
            if task_manager.is_cancelled(task_id):
                return {"success": False, "cancelled": True, "task_id": task_id}
            task_manager.complete_task(task_id, f"Moved {len(moved)} item(s)")
        return {"success": True, "moved": moved, "task_id": task_id}
    except TaskCancelledException:
        if task_id:
            task_manager.cancel_task(task_id)
        return {"success": False, "cancelled": True, "task_id": task_id}
    except PermissionError as e:
        if task_id:
            task_manager.fail_task(task_id, str(e))
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))
    except FileExistsError as e:
        if task_id:
            task_manager.fail_task(task_id, str(e))
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))
    except Exception as e:
        if task_id:
            task_manager.fail_task(task_id, str(e))
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@router.post("/extract")
async def extract_archive(req: ExtractRequest, current_user: Dict[str, Any] = Depends(get_current_user)):
    allowed_roots = get_user_allowed_roots(current_user)
    task_id = req.task_id
    if task_id:
        task_manager.set_loop(asyncio.get_running_loop())
        archive_name = req.archive_path.split("/")[-1]
        task_manager.create_task(task_id, "extract", f"Extracting {archive_name}")

    def progress_cb(pct: float, detail: str, done: int, total: int):
        if task_id:
            task_manager.update_task(task_id, pct, detail, done, total)

    try:
        result = await asyncio.to_thread(
            file_service.extract_archive,
            req.archive_path,
            req.destination,
            allowed_roots,
            progress_cb if task_id else None,
            (lambda: task_manager.is_cancelled(task_id)) if task_id else None
        )
        if task_id:
            if task_manager.is_cancelled(task_id):
                return {"success": False, "cancelled": True, "task_id": task_id}
            task_manager.complete_task(task_id, f"Extracted {result.get('files_extracted', 0)} files")
        result["task_id"] = task_id
        return result
    except TaskCancelledException:
        if task_id:
            task_manager.cancel_task(task_id)
        return {"success": False, "cancelled": True, "task_id": task_id}
    except PermissionError as e:
        if task_id:
            task_manager.fail_task(task_id, str(e))
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))
    except ValueError as e:
        if task_id:
            task_manager.fail_task(task_id, str(e))
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        if task_id:
            task_manager.fail_task(task_id, str(e))
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@router.get("/tasks/{task_id}")
async def get_task_status(task_id: str, current_user: Dict[str, Any] = Depends(get_current_user)):
    task = task_manager.get_task(task_id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return {"task": task, **task}

@router.post("/tasks/{task_id}/cancel")
async def cancel_task_endpoint(task_id: str, current_user: Dict[str, Any] = Depends(get_current_user)):
    task = task_manager.get_task(task_id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    task_manager.cancel_task(task_id)
    return {"success": True, "task_id": task_id, "status": "cancelled"}
