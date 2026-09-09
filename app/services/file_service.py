"""
File Service for HomeDock.
Provides secure browsing, uploads, downloads, operations (rename, delete, move, copy),
metadata inspection, and path-traversal protected archive extraction.
"""

import os
import shutil
import stat
import mimetypes
import zipfile
import tarfile
import subprocess
import time
import re
from pathlib import Path
from typing import List, Dict, Any, Optional, Callable
from datetime import datetime, timezone
from app.services.storage_manager import storage_manager

ARCHIVE_EXTENSIONS = {
    ".zip", ".tar", ".gz", ".tgz", ".bz2", ".tbz2", ".xz", ".txz", ".7z"
}

class TaskCancelledException(Exception):
    """Raised when an ongoing file task is cancelled by user."""
    pass

class FileService:
    @staticmethod
    def validate_path(requested_path: str, allowed_roots: List[str], check_exists: bool = True) -> Path:
        """
        Validates that requested_path is within allowed_roots.
        Resolves symlinks, checks for null bytes, and prevents traversal attacks.
        """
        if not requested_path or "\0" in requested_path:
            raise PermissionError("Invalid path")

        raw_path = Path(requested_path)
        try:
            resolved = raw_path.resolve()
        except Exception:
            raise PermissionError("Cannot resolve path")

        # Ensure parent exists if file is yet to be created
        check_target = resolved
        while not check_target.exists() and check_target.parent != check_target:
            check_target = check_target.parent

        is_allowed = False
        for root_str in allowed_roots:
            try:
                root_path = Path(root_str).resolve()
                if (
                    resolved == root_path
                    or resolved.is_relative_to(root_path)
                    or check_target == root_path
                    or check_target.is_relative_to(root_path)
                ):
                    is_allowed = True
                    break
            except Exception:
                continue

        if not is_allowed:
            raise PermissionError("Access denied: Path is outside allowed roots")

        if check_exists and not resolved.exists():
            raise FileNotFoundError(f"Path does not exist: {requested_path}")

        return resolved

    @staticmethod
    def is_root_dir(path: Path, allowed_roots: List[str]) -> bool:
        """Determines if path matches one of the allowed roots directly."""
        resolved = path.resolve()
        for r in allowed_roots:
            if resolved == Path(r).resolve():
                return True
        return False

    @staticmethod
    def list_directory(directory_path: Path, allowed_roots: List[str], show_hidden: bool = False) -> Dict[str, Any]:
        """Lists entries in a directory with comprehensive metadata."""
        resolved_dir = FileService.validate_path(str(directory_path), allowed_roots, check_exists=True)
        if not resolved_dir.is_dir():
            raise NotADirectoryError(f"Path is not a directory: {directory_path}")

        items = []
        try:
            with os.scandir(resolved_dir) as entries:
                for entry in entries:
                    if not show_hidden and entry.name.startswith("."):
                        continue
                    try:
                        entry_stat = entry.stat(follow_symlinks=False)
                        is_dir = entry.is_dir(follow_symlinks=False)
                        is_symlink = entry.is_symlink()
                        size = entry_stat.st_size if not is_dir else 0
                        mtime = datetime.fromtimestamp(entry_stat.st_mtime, tz=timezone.utc).isoformat()
                        
                        ext = Path(entry.name).suffix.lower()
                        # Multi-extension check like .tar.gz
                        double_ext = "".join(Path(entry.name).suffixes[-2:]).lower()
                        is_archive = ext in ARCHIVE_EXTENSIONS or double_ext in ARCHIVE_EXTENSIONS
                        
                        mime_type, _ = mimetypes.guess_type(entry.name)
                        mode_str = stat.filemode(entry_stat.st_mode)

                        items.append({
                            "name": entry.name,
                            "path": str(Path(entry.path).resolve()),
                            "is_dir": is_dir,
                            "is_symlink": is_symlink,
                            "is_archive": is_archive,
                            "size": size,
                            "mtime": mtime,
                            "mode": mode_str,
                            "mime_type": mime_type or ("inode/directory" if is_dir else "application/octet-stream"),
                            "extension": ext.lstrip("."),
                        })
                    except (PermissionError, FileNotFoundError, OSError):
                        continue
        except PermissionError:
            raise PermissionError(f"Permission denied accessing {directory_path}")

        # Sort: directories first, then alphabetical by name
        items.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))

        # Build breadcrumbs scoped to allowed roots
        # Find which allowed root contains resolved_dir (highest / shortest path if multiple)
        matched_root = None
        for r in allowed_roots:
            try:
                rp = Path(r).resolve()
                if resolved_dir == rp or resolved_dir.is_relative_to(rp):
                    if matched_root is None or len(str(rp)) < len(str(matched_root)):
                        matched_root = rp
            except Exception:
                continue

        stop_at = matched_root if matched_root is not None else Path(resolved_dir.root)
        curr = resolved_dir
        chain = []
        while curr != curr.parent and curr != stop_at:
            chain.append({"name": curr.name or str(curr), "path": str(curr)})
            curr = curr.parent
        chain.append({"name": curr.name or str(curr), "path": str(curr)})
        chain.reverse()

        can_go_up = resolved_dir != resolved_dir.parent and (matched_root is None or resolved_dir != matched_root)
        parent_path = str(resolved_dir.parent) if can_go_up else None

        return {
            "current_path": str(resolved_dir),
            "parent_path": parent_path,
            "items": items,
            "breadcrumbs": chain,
            "is_root": FileService.is_root_dir(resolved_dir, allowed_roots),
        }

    @staticmethod
    def get_item_info(target_path: Path, allowed_roots: List[str]) -> Dict[str, Any]:
        """Retrieves in-depth statistics for a file or directory."""
        resolved = FileService.validate_path(str(target_path), allowed_roots, check_exists=True)
        st = resolved.stat()
        is_dir = resolved.is_dir()
        
        info = {
            "name": resolved.name,
            "path": str(resolved),
            "is_dir": is_dir,
            "is_symlink": resolved.is_symlink(),
            "size": st.st_size,
            "created": datetime.fromtimestamp(st.st_ctime, tz=timezone.utc).isoformat(),
            "modified": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
            "permissions": stat.filemode(st.st_mode),
            "uid": st.st_uid,
            "gid": st.st_gid,
        }

        if is_dir:
            total_size = 0
            file_count = 0
            dir_count = 0
            try:
                for root, dirs, files in os.walk(resolved):
                    dir_count += len(dirs)
                    file_count += len(files)
                    for f in files:
                        try:
                            fp = os.path.join(root, f)
                            total_size += os.path.getsize(fp)
                        except OSError:
                            pass
            except Exception:
                pass
            info["total_size"] = total_size
            info["file_count"] = file_count
            info["dir_count"] = dir_count

        return info

    @staticmethod
    def create_directory(dir_path: Path, allowed_roots: List[str]) -> Path:
        """Creates a new folder safely."""
        target = FileService.validate_path(str(dir_path), allowed_roots, check_exists=False)
        if target.exists():
            raise FileExistsError(f"Directory already exists: {target.name}")
        target.mkdir(parents=True, exist_ok=True)
        return target

    @staticmethod
    def rename_item(src_path: Path, target_name: str, allowed_roots: List[str]) -> Path:
        """Renames an item within its directory safely."""
        src = FileService.validate_path(str(src_path), allowed_roots, check_exists=True)
        if FileService.is_root_dir(src, allowed_roots):
            raise PermissionError("Cannot rename a configured root directory")

        # Sanitize target name
        clean_name = os.path.basename(target_name.strip())
        if not clean_name or clean_name in (".", "..") or "/" in clean_name or "\\" in clean_name:
            raise ValueError("Invalid target filename")

        dest = src.parent / clean_name
        dest = FileService.validate_path(str(dest), allowed_roots, check_exists=False)
        if dest.exists():
            raise FileExistsError(f"An item named {clean_name} already exists")

        src.rename(dest)
        return dest

    @staticmethod
    def delete_items(paths: List[str], allowed_roots: List[str]) -> List[str]:
        """Deletes files or directories safely."""
        deleted = []
        for p_str in paths:
            target = FileService.validate_path(p_str, allowed_roots, check_exists=True)
            if FileService.is_root_dir(target, allowed_roots):
                raise PermissionError(f"Refusing to delete root directory: {target}")
            
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            else:
                target.unlink()
            deleted.append(str(target))
        return deleted

    @staticmethod
    def _copy_file_chunked(
        src: Path,
        dst: Path,
        chunk_callback: Optional[Callable[[int], None]] = None,
        chunk_size: int = 2 * 1024 * 1024,
        is_cancelled: Optional[Callable[[], bool]] = None
    ):
        try:
            with open(src, "rb") as fsrc, open(dst, "wb") as fdst:
                while True:
                    if is_cancelled and is_cancelled():
                        raise TaskCancelledException("Task cancelled by user")
                    buf = fsrc.read(chunk_size)
                    if not buf:
                        break
                    fdst.write(buf)
                    if chunk_callback:
                        chunk_callback(len(buf))
            shutil.copystat(src, dst)
        except TaskCancelledException:
            if dst.exists():
                try:
                    dst.unlink()
                except OSError:
                    pass
            raise

    @staticmethod
    def copy_items(
        src_paths: List[str],
        dest_dir_str: str,
        allowed_roots: List[str],
        progress_callback: Optional[Callable[[float, str, int, int], None]] = None,
        is_cancelled: Optional[Callable[[], bool]] = None
    ) -> List[str]:
        """Copies files or directories to a destination directory with live progress tracking and cancellation."""
        dest_dir = FileService.validate_path(dest_dir_str, allowed_roots, check_exists=True)
        if not dest_dir.is_dir():
            raise NotADirectoryError(f"Destination is not a directory: {dest_dir_str}")

        # Measure total bytes across all sources for accurate progress calculation
        total_bytes = 0
        items_plan = []
        for s_str in src_paths:
            src = FileService.validate_path(s_str, allowed_roots, check_exists=True)
            if src.is_dir() and not src.is_symlink():
                dir_size = 0
                for root, _, files in os.walk(src):
                    for f in files:
                        fp = Path(root) / f
                        if not fp.is_symlink():
                            try:
                                dir_size += fp.stat().st_size
                            except OSError:
                                pass
                total_bytes += dir_size
                items_plan.append((src, True, dir_size))
            else:
                sz = src.stat().st_size
                total_bytes += sz
                items_plan.append((src, False, sz))

        copied_bytes = 0
        last_report = 0
        current_name = ""

        def on_chunk(n: int):
            nonlocal copied_bytes, last_report
            copied_bytes += n
            now = time.time()
            if progress_callback and (now - last_report >= 0.1 or copied_bytes >= total_bytes):
                pct = round((copied_bytes / total_bytes * 100.0), 1) if total_bytes > 0 else 100.0
                progress_callback(pct, f"Copying {current_name}...", copied_bytes, total_bytes)
                last_report = now

        copied = []
        for src, is_dir, sz in items_plan:
            if is_cancelled and is_cancelled():
                raise TaskCancelledException("Task cancelled by user")
            target = dest_dir / src.name
            target = FileService.validate_path(str(target), allowed_roots, check_exists=False)
            
            if target.exists():
                # Append copy suffix if exists
                target = dest_dir / f"{src.stem}_copy{src.suffix}"

            current_name = src.name
            if progress_callback and last_report == 0:
                pct = round((copied_bytes / total_bytes * 100.0), 1) if total_bytes > 0 else 0.0
                progress_callback(pct, f"Copying {current_name}...", copied_bytes, total_bytes)

            if is_dir:
                target.mkdir(parents=True, exist_ok=True)
                for root, dirs, files in os.walk(src):
                    if is_cancelled and is_cancelled():
                        raise TaskCancelledException("Task cancelled by user")
                    rel = Path(root).relative_to(src)
                    cur_dst = target / rel
                    cur_dst.mkdir(parents=True, exist_ok=True)
                    for d in dirs:
                        (cur_dst / d).mkdir(parents=True, exist_ok=True)
                    for f in files:
                        if is_cancelled and is_cancelled():
                            raise TaskCancelledException("Task cancelled by user")
                        s_file = Path(root) / f
                        d_file = cur_dst / f
                        if s_file.is_symlink():
                            continue
                        current_name = s_file.name
                        FileService._copy_file_chunked(s_file, d_file, on_chunk, is_cancelled=is_cancelled)
                shutil.copystat(src, target)
            else:
                FileService._copy_file_chunked(src, target, on_chunk, is_cancelled=is_cancelled)
            
            copied.append(str(target))

        if progress_callback:
            progress_callback(100.0, "Copy completed successfully", total_bytes, total_bytes)

        return copied

    @staticmethod
    def move_items(
        src_paths: List[str],
        dest_dir_str: str,
        allowed_roots: List[str],
        progress_callback: Optional[Callable[[float, str, int, int], None]] = None,
        is_cancelled: Optional[Callable[[], bool]] = None
    ) -> List[str]:
        """Moves files or directories to a destination directory with atomic rename or cross-device progress."""
        dest_dir = FileService.validate_path(dest_dir_str, allowed_roots, check_exists=True)
        if not dest_dir.is_dir():
            raise NotADirectoryError(f"Destination is not a directory: {dest_dir_str}")

        moved = []
        for s_str in src_paths:
            if is_cancelled and is_cancelled():
                raise TaskCancelledException("Task cancelled by user")
            src = FileService.validate_path(s_str, allowed_roots, check_exists=True)
            if FileService.is_root_dir(src, allowed_roots):
                raise PermissionError(f"Cannot move root directory: {src}")

            target = dest_dir / src.name
            target = FileService.validate_path(str(target), allowed_roots, check_exists=False)
            if target.exists():
                raise FileExistsError(f"Item already exists at destination: {target.name}")

            try:
                # Same-filesystem atomic rename
                os.replace(src, target)
                if progress_callback:
                    progress_callback(100.0, f"Moved {src.name}", 1, 1)
            except OSError as ex:
                if ex.errno == 18:  # EXDEV: Cross-device move
                    FileService.copy_items([str(src)], str(dest_dir), allowed_roots, progress_callback, is_cancelled=is_cancelled)
                    if is_cancelled and is_cancelled():
                        raise TaskCancelledException("Task cancelled by user")
                    if src.is_dir() and not src.is_symlink():
                        shutil.rmtree(src)
                    else:
                        src.unlink()
                else:
                    raise

            moved.append(str(target))
        return moved

    @staticmethod
    def extract_archive(
        archive_path_str: str,
        dest_dir_str: Optional[str],
        allowed_roots: List[str],
        progress_callback: Optional[Callable[[float, str, int, int], None]] = None,
        is_cancelled: Optional[Callable[[], bool]] = None
    ) -> Dict[str, Any]:
        """
        Extracts zip, tar, tar.gz, tar.bz2, tar.xz, or 7z safely with live progress.
        Strictly prevents path traversal outside the destination directory.
        """
        archive_path = FileService.validate_path(archive_path_str, allowed_roots, check_exists=True)
        
        # If dest_dir not specified, extract into a folder named after archive in same directory
        if not dest_dir_str:
            base_name = archive_path.name
            for ext in (".tar.gz", ".tar.bz2", ".tar.xz", ".tgz", ".tbz2", ".txz", ".zip", ".tar", ".7z"):
                if base_name.lower().endswith(ext):
                    base_name = base_name[:-len(ext)]
                    break
            dest_dir = archive_path.parent / f"{base_name}_extracted"
        else:
            dest_dir = Path(dest_dir_str)

        dest_dir = FileService.validate_path(str(dest_dir), allowed_roots, check_exists=False)
        dest_dir.mkdir(parents=True, exist_ok=True)
        resolved_dest = dest_dir.resolve()

        extracted_files = 0
        name_lower = archive_path.name.lower()

        # 1. ZIP Archives
        if name_lower.endswith(".zip"):
            with zipfile.ZipFile(archive_path, "r") as zf:
                members = zf.infolist()
                for member in members:
                    target_member_path = (resolved_dest / member.filename).resolve()
                    if (
                        str(target_member_path) != str(resolved_dest)
                        and not str(target_member_path).startswith(str(resolved_dest) + os.sep)
                    ):
                        raise PermissionError(f"Malicious archive entry detected: {member.filename}")

                total_files = len(members)
                total_bytes = sum(m.file_size for m in members)
                done_bytes = 0
                last_report = 0

                for idx, member in enumerate(members):
                    if is_cancelled and is_cancelled():
                        raise TaskCancelledException("Extraction cancelled by user")
                    zf.extract(member, resolved_dest)
                    done_bytes += member.file_size
                    now = time.time()
                    if progress_callback and (now - last_report >= 0.1 or idx == total_files - 1):
                        pct = round((done_bytes / total_bytes * 100.0), 1) if total_bytes > 0 else round(((idx + 1) / total_files * 100.0), 1)
                        progress_callback(pct, f"Extracting {Path(member.filename).name} ({idx+1}/{total_files})...", done_bytes, total_bytes)
                        last_report = now
                extracted_files = total_files

        # 2. TAR Archives (.tar, .tar.gz, .tgz, .tar.bz2, .tar.xz)
        elif any(name_lower.endswith(e) for e in (".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz")):
            with tarfile.open(archive_path, "r:*") as tf:
                members = tf.getmembers()
                for member in members:
                    target_member_path = (resolved_dest / member.name).resolve()
                    if (
                        str(target_member_path) != str(resolved_dest)
                        and not str(target_member_path).startswith(str(resolved_dest) + os.sep)
                    ):
                        raise PermissionError(f"Malicious tar entry detected: {member.name}")
                    if member.islnk() or member.issym():
                        link_target = (target_member_path.parent / member.linkname).resolve()
                        if not str(link_target).startswith(str(resolved_dest) + os.sep):
                            raise PermissionError(f"Malicious symlink in tar: {member.name} -> {member.linkname}")

                total_files = len(members)
                total_bytes = sum(m.size for m in members)
                done_bytes = 0
                last_report = 0

                for idx, member in enumerate(members):
                    if is_cancelled and is_cancelled():
                        raise TaskCancelledException("Extraction cancelled by user")
                    try:
                        tf.extract(member, resolved_dest, filter="data")
                    except TypeError:
                        tf.extract(member, resolved_dest)
                    done_bytes += member.size
                    now = time.time()
                    if progress_callback and (now - last_report >= 0.1 or idx == total_files - 1):
                        pct = round((done_bytes / total_bytes * 100.0), 1) if total_bytes > 0 else round(((idx + 1) / total_files * 100.0), 1)
                        progress_callback(pct, f"Extracting {Path(member.name).name} ({idx+1}/{total_files})...", done_bytes, total_bytes)
                        last_report = now
                extracted_files = total_files

        # 3. 7Z Archives
        elif name_lower.endswith(".7z"):
            cmd_check = ["7z", "l", "-slt", str(archive_path)]
            proc_check = subprocess.run(cmd_check, capture_output=True, text=True, check=True)
            for line in proc_check.stdout.splitlines():
                if line.startswith("Path = "):
                    entry_name = line[len("Path = "):].strip()
                    target_member_path = (resolved_dest / entry_name).resolve()
                    if (
                        str(target_member_path) != str(resolved_dest)
                        and not str(target_member_path).startswith(str(resolved_dest) + os.sep)
                    ):
                        raise PermissionError(f"Malicious 7z entry detected: {entry_name}")
            
            cmd_extract = ["7z", "x", "-y", "-bsp1", f"-o{resolved_dest}", str(archive_path)]
            proc = subprocess.Popen(cmd_extract, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            if proc.stdout:
                for line in proc.stdout:
                    if is_cancelled and is_cancelled():
                        proc.terminate()
                        try:
                            proc.wait(timeout=2)
                        except subprocess.TimeoutExpired:
                            proc.kill()
                        raise TaskCancelledException("Extraction cancelled by user")
                    m = re.search(r'(\d+)%', line)
                    if m and progress_callback:
                        pct = float(m.group(1))
                        progress_callback(pct, f"Extracting {archive_path.name} ({pct:.0f}%)...", 0, 0)
            proc.wait()
            if is_cancelled and is_cancelled():
                raise TaskCancelledException("Extraction cancelled by user")
            if proc.returncode != 0:
                raise RuntimeError(f"7z extraction failed with exit code {proc.returncode}")
            extracted_files = len([f for f in os.listdir(resolved_dest)])
        else:
            raise ValueError(f"Unsupported archive format: {archive_path.name}")

        if progress_callback:
            progress_callback(100.0, "Extraction completed successfully", 1, 1)

        return {
            "success": True,
            "destination": str(resolved_dest),
            "files_extracted": extracted_files,
        }

file_service = FileService()
