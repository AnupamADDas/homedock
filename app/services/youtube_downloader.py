"""
YouTube & Streaming Media Downloader Service for HomeDock.
Powered by yt-dlp and ffmpeg.
Supports Stacher7-grade capabilities:
- Video (Best, 4K, 1440p, 1080p, 720p, 480p, 360p) with MP4/MKV/WebM remuxing
- Audio only (MP3, M4A, FLAC, OPUS, WAV, AAC) with variable/fixed bitrates (320k, 256k, 192k, 128k, Best)
- Real-time metadata probing (Title, Channel, Duration, Thumbnails, Resolutions)
- Subtitle embedding, metadata tagging, thumbnail cover art embedding
- Live progress, ETA, and throughput reporting
- Task cancellation and file management
"""

import os
import sys
import time
import json
import uuid
import shutil
import asyncio
import threading
from pathlib import Path
from typing import Dict, Any, List, Optional
import yt_dlp

from app.database import get_db_connection

class YoutubeDownloaderService:
    def __init__(self):
        self._tasks: Dict[str, Dict[str, Any]] = {}
        self._cancel_events: Dict[str, threading.Event] = {}
        self._lock = threading.Lock()
        self._load_tasks_from_db()

    def _load_tasks_from_db(self):
        """Restores recent tasks from database on startup."""
        try:
            with get_db_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("""
                    SELECT * FROM youtube_tasks ORDER BY created_at DESC LIMIT 100;
                """)
                rows = cursor.fetchall()
                for row in rows:
                    gid = row["gid"]
                    status = row["status"]
                    # If server restarted while downloading, mark as error or stopped
                    if status == "active":
                        status = "error"
                        status_detail = "Interrupted by server restart"
                    else:
                        status_detail = row["status_detail"]

                    output_files = []
                    if row["output_files"]:
                        try:
                            output_files = json.loads(row["output_files"])
                        except Exception:
                            output_files = [row["output_files"]]

                    self._tasks[gid] = {
                        "gid": gid,
                        "url": row["url"],
                        "name": row["title"],
                        "title": row["title"],
                        "channel": row["channel"] or "",
                        "thumbnail_url": row["thumbnail_url"] or "",
                        "duration": row["duration"] or 0,
                        "mode": row["mode"],
                        "format": row["format"],
                        "quality_label": row["quality_label"],
                        "status": status,
                        "status_detail": status_detail,
                        "percent": float(row["percent"] or 0.0),
                        "completed_bytes": int(row["completed_bytes"] or 0),
                        "total_bytes": int(row["total_bytes"] or 0),
                        "download_speed": 0,
                        "upload_speed": 0,
                        "max_download_limit": 0,
                        "eta_seconds": None,
                        "dir": row["destination_dir"],
                        "output_files": output_files,
                        "error_message": row["error_message"],
                        "is_youtube": True,
                        "created_at": float(row["created_at"] or time.time()),
                        "connections": 1,
                        "num_seeders": 0,
                    }
        except Exception:
            pass

    def _persist_task(self, task: Dict[str, Any]):
        """Persists or updates a task in the database."""
        try:
            with get_db_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("""
                    INSERT INTO youtube_tasks (
                        gid, url, title, channel, thumbnail_url, duration,
                        mode, format, quality_label, status, status_detail,
                        percent, completed_bytes, total_bytes, destination_dir,
                        output_files, error_message, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(gid) DO UPDATE SET
                        status = excluded.status,
                        status_detail = excluded.status_detail,
                        percent = excluded.percent,
                        completed_bytes = excluded.completed_bytes,
                        total_bytes = excluded.total_bytes,
                        output_files = excluded.output_files,
                        error_message = excluded.error_message,
                        updated_at = excluded.updated_at;
                """, (
                    task["gid"],
                    task["url"],
                    task["title"],
                    task.get("channel", ""),
                    task.get("thumbnail_url", ""),
                    task.get("duration", 0),
                    task.get("mode", "video"),
                    task.get("format", ""),
                    task.get("quality_label", ""),
                    task["status"],
                    task.get("status_detail", ""),
                    task.get("percent", 0.0),
                    task.get("completed_bytes", 0),
                    task.get("total_bytes", 0),
                    task.get("dir", ""),
                    json.dumps(task.get("output_files", [])),
                    task.get("error_message"),
                    task.get("created_at", time.time()),
                    time.time()
                ))
                conn.commit()
        except Exception:
            pass

    async def probe_url(self, url: str) -> Dict[str, Any]:
        """Extracts media metadata, available formats, and resolutions without downloading."""
        return await asyncio.to_thread(self._probe_sync, url)

    def _probe_sync(self, url: str) -> Dict[str, Any]:
        ydl_opts = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "remote_components": ["ejs:github"],
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            try:
                info = ydl.extract_info(url, download=False)
            except Exception as e:
                raise ValueError(f"Failed to fetch video information: {e}")

            is_playlist = info.get("_type") == "playlist" or "entries" in info
            entries = info.get("entries", []) if is_playlist else []

            title = info.get("title") or "Unknown Media"
            uploader = info.get("uploader") or info.get("channel") or info.get("creator") or ""
            duration = info.get("duration") or 0
            thumbnail = info.get("thumbnail") or ""
            view_count = info.get("view_count")

            # Extract resolutions from single video or first video in playlist
            sample_info = entries[0] if (is_playlist and entries) else info
            formats = sample_info.get("formats", []) if sample_info else []

            resolutions = sorted(list(set(
                f.get("height") for f in formats
                if f.get("height") and f.get("vcodec") != "none"
            )), reverse=True)

            return {
                "url": url,
                "title": title,
                "uploader": uploader,
                "duration": duration,
                "thumbnail": thumbnail,
                "view_count": view_count,
                "is_playlist": is_playlist,
                "playlist_count": len(entries) if is_playlist else 1,
                "resolutions": resolutions,
                "default_video_formats": ["mp4", "mkv", "webm"],
                "default_audio_formats": ["mp3", "m4a", "flac", "opus", "wav", "aac"],
                "default_audio_qualities": [
                    {"label": "Best Quality (320 kbps VBR)", "value": "best"},
                    {"label": "320 kbps (High Quality)", "value": "320"},
                    {"label": "256 kbps", "value": "256"},
                    {"label": "192 kbps (Standard)", "value": "192"},
                    {"label": "128 kbps", "value": "128"},
                ]
            }

    def start_download(
        self,
        url: str,
        destination_dir: str,
        mode: str = "video",
        resolution: Optional[str] = "best",
        video_format: Optional[str] = "mp4",
        audio_format: Optional[str] = "mp3",
        audio_quality: Optional[str] = "best",
        embed_subtitles: bool = False,
        embed_thumbnail: bool = True,
        embed_metadata: bool = True,
        playlist_items: Optional[str] = None,
        title_hint: Optional[str] = None,
        thumbnail_hint: Optional[str] = None,
        channel_hint: Optional[str] = None,
    ) -> str:
        """Queues and initiates an asynchronous YouTube/media download task."""
        gid = f"yt-{uuid.uuid4().hex[:10]}"
        cancel_event = threading.Event()
        self._cancel_events[gid] = cancel_event

        # Resolve quality label
        if mode == "video":
            res_str = f"{resolution}p" if (resolution and resolution != "best") else "Best"
            fmt_str = (video_format or "mp4").upper()
            quality_label = f"{res_str} {fmt_str}"
        else:
            fmt_str = (audio_format or "mp3").upper()
            q_str = "320k" if audio_quality in ("best", "320") else f"{audio_quality}k"
            quality_label = f"Audio {fmt_str} ({q_str})"

        now = time.time()
        task_data = {
            "gid": gid,
            "url": url,
            "name": title_hint or "Fetching media info...",
            "title": title_hint or "Fetching media info...",
            "channel": channel_hint or "",
            "thumbnail_url": thumbnail_hint or "",
            "duration": 0,
            "mode": mode,
            "media_type": mode,
            "format": video_format if mode == "video" else audio_format,
            "format_id": video_format if mode == "video" else audio_format,
            "quality": resolution if mode == "video" else audio_quality,
            "quality_label": quality_label,
            "status": "active",
            "status_detail": "Queued for download...",
            "percent": 0.0,
            "completed_bytes": 0,
            "total_bytes": 0,
            "download_speed": 0,
            "upload_speed": 0,
            "max_download_limit": 0,
            "eta_seconds": None,
            "dir": str(destination_dir),
            "output_files": [],
            "error_message": None,
            "is_youtube": True,
            "created_at": now,
            "connections": 1,
            "num_seeders": 0,
        }

        with self._lock:
            self._tasks[gid] = task_data
        self._persist_task(task_data)

        # Launch background task
        asyncio.create_task(self._run_download_task(
            gid=gid,
            url=url,
            destination_dir=destination_dir,
            mode=mode,
            resolution=resolution,
            video_format=video_format,
            audio_format=audio_format,
            audio_quality=audio_quality,
            embed_subtitles=embed_subtitles,
            embed_thumbnail=embed_thumbnail,
            embed_metadata=embed_metadata,
            playlist_items=playlist_items,
            cancel_event=cancel_event
        ))

        return gid

    async def _run_download_task(
        self,
        gid: str,
        url: str,
        destination_dir: str,
        mode: str,
        resolution: Optional[str],
        video_format: Optional[str],
        audio_format: Optional[str],
        audio_quality: Optional[str],
        embed_subtitles: bool,
        embed_thumbnail: bool,
        embed_metadata: bool,
        playlist_items: Optional[str],
        cancel_event: threading.Event
    ):
        """Worker executing yt-dlp in a dedicated thread."""
        await asyncio.to_thread(
            self._execute_yt_dlp,
            gid, url, destination_dir, mode, resolution, video_format,
            audio_format, audio_quality, embed_subtitles, embed_thumbnail,
            embed_metadata, playlist_items, cancel_event
        )

    def _execute_yt_dlp(
        self,
        gid: str,
        url: str,
        destination_dir: str,
        mode: str,
        resolution: Optional[str],
        video_format: Optional[str],
        audio_format: Optional[str],
        audio_quality: Optional[str],
        embed_subtitles: bool,
        embed_thumbnail: bool,
        embed_metadata: bool,
        playlist_items: Optional[str],
        cancel_event: threading.Event
    ):
        task = self._tasks.get(gid)
        if not task:
            return

        dest_path = Path(destination_dir)
        dest_path.mkdir(parents=True, exist_ok=True)

        v_fmt = (video_format or "mp4").lower()
        a_fmt = (audio_format or "mp3").lower()
        output_files = []

        def progress_hook(d):
            if cancel_event.is_set():
                raise Exception("Download cancelled by user")

            status = d.get("status")
            if status == "downloading":
                downloaded = d.get("downloaded_bytes", 0)
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                speed = int(d.get("speed") or 0)
                eta = d.get("eta")

                pct = round((downloaded / total * 100.0), 1) if total > 0 else 0.0

                with self._lock:
                    task["status"] = "active"
                    task["status_detail"] = f"Downloading ({pct}%)..."
                    task["percent"] = pct
                    task["completed_bytes"] = downloaded
                    task["total_bytes"] = total
                    task["download_speed"] = speed
                    task["eta_seconds"] = int(eta) if eta is not None else None

                # Capture filename if known
                fn = d.get("filename")
                if fn and fn not in output_files:
                    output_files.append(fn)

            elif status == "finished":
                with self._lock:
                    task["status_detail"] = "Processing & finalizing media..."
                    task["download_speed"] = 0
                    task["percent"] = 100.0
                fn = d.get("filename")
                if fn and fn not in output_files:
                    output_files.append(fn)

        def postprocessor_hook(d):
            if cancel_event.is_set():
                raise Exception("Download cancelled by user")
            pp = d.get("postprocessor")
            status = d.get("status")
            if status == "started":
                with self._lock:
                    if pp == "ExtractAudio":
                        task["status_detail"] = f"Extracting {a_fmt.upper()} audio..."
                    elif pp == "EmbedThumbnail":
                        task["status_detail"] = "Embedding cover art & thumbnail..."
                    elif pp == "FFmpegMetadata":
                        task["status_detail"] = "Writing tags & metadata..."
                    elif pp == "FFmpegEmbedSubtitle":
                        task["status_detail"] = "Embedding subtitles..."
                    elif pp == "MoveFiles":
                        task["status_detail"] = "Finalizing file..."

        # Build format selection string
        if mode == "video":
            if not resolution or resolution == "best":
                fmt_selector = f"bestvideo[ext={v_fmt}]+bestaudio[ext=m4a]/bestvideo+bestaudio/best"
            else:
                fmt_selector = (
                    f"bestvideo[height<={resolution}][ext={v_fmt}]+bestaudio[ext=m4a]/"
                    f"bestvideo[height<={resolution}]+bestaudio/"
                    f"best[height<={resolution}]/best"
                )
        else:
            fmt_selector = "bestaudio/best"

        postprocessors = []

        if mode == "audio":
            q_val = "320" if audio_quality in ("best", "320") else (audio_quality or "192")
            postprocessors.append({
                "key": "FFmpegExtractAudio",
                "preferredcodec": a_fmt,
                "preferredquality": q_val,
            })

        if embed_metadata:
            postprocessors.append({
                "key": "FFmpegMetadata",
                "add_metadata": True,
                "add_chapters": True,
            })

        if embed_thumbnail:
            postprocessors.append({
                "key": "EmbedThumbnail",
                "already_have_thumbnail": False,
            })

        if mode == "video" and embed_subtitles:
            postprocessors.append({
                "key": "FFmpegEmbedSubtitle",
            })

        ydl_opts: Dict[str, Any] = {
            "format": fmt_selector,
            "outtmpl": f"{str(dest_path)}/%(title)s.%(ext)s",
            "quiet": True,
            "no_warnings": True,
            "progress_hooks": [progress_hook],
            "postprocessor_hooks": [postprocessor_hook],
            "postprocessors": postprocessors,
            "remote_components": ["ejs:github"],
        }

        if mode == "video":
            ydl_opts["merge_output_format"] = v_fmt

        if embed_thumbnail:
            ydl_opts["writethumbnail"] = True

        if embed_subtitles:
            ydl_opts["writesubtitles"] = True
            ydl_opts["subtitleslangs"] = ["en", "all"]

        if playlist_items:
            ydl_opts["playlist_items"] = playlist_items

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                # Pre-fetch info to get accurate title and thumbnail
                try:
                    info = ydl.extract_info(url, download=False)
                    if info:
                        title = info.get("title") or task["name"]
                        thumb = info.get("thumbnail") or task.get("thumbnail_url")
                        channel = info.get("uploader") or info.get("channel") or task.get("channel")
                        duration = info.get("duration") or task.get("duration")
                        with self._lock:
                            task["title"] = title
                            task["name"] = title
                            task["thumbnail_url"] = thumb
                            task["channel"] = channel
                            task["duration"] = duration
                        self._persist_task(task)
                except Exception:
                    pass

                # Perform download
                ydl.download([url])

            with self._lock:
                task["status"] = "complete"
                task["status_detail"] = "Completed"
                task["percent"] = 100.0
                task["download_speed"] = 0
                task["eta_seconds"] = None
                task["output_files"] = output_files
            self._persist_task(task)

        except Exception as e:
            err_msg = str(e)
            is_cancelled = "cancelled by user" in err_msg.lower() or cancel_event.is_set()

            with self._lock:
                task["status"] = "cancelled" if is_cancelled else "error"
                task["status_detail"] = "Cancelled by user" if is_cancelled else f"Error: {err_msg}"
                task["error_message"] = None if is_cancelled else err_msg
                task["download_speed"] = 0
                task["eta_seconds"] = None
            self._persist_task(task)

            # Cleanup partial/temporary files on cancellation
            if is_cancelled:
                try:
                    for part_file in dest_path.glob("*.part"):
                        part_file.unlink(missing_ok=True)
                    for ytdl_file in dest_path.glob("*.ytdl"):
                        ytdl_file.unlink(missing_ok=True)
                except Exception:
                    pass

        finally:
            self._cancel_events.pop(gid, None)

    def get_tasks(self) -> List[Dict[str, Any]]:
        """Returns all YouTube download tasks formatted for HomeDock downloads list."""
        with self._lock:
            return list(self._tasks.values())

    def get_active_count(self) -> int:
        """Returns the number of actively downloading tasks."""
        with self._lock:
            return sum(1 for t in self._tasks.values() if t.get("status") == "active")

    def get_total_download_speed(self) -> int:
        """Returns the combined download speed in bytes/sec across all active tasks."""
        with self._lock:
            return sum(int(t.get("download_speed", 0)) for t in self._tasks.values() if t.get("status") == "active")

    def cancel_task(self, gid: str) -> bool:
        """Cancels an active YouTube download task."""
        event = self._cancel_events.get(gid)
        if event:
            event.set()
        task = self._tasks.get(gid)
        if task and task.get("status") == "active":
            with self._lock:
                task["status"] = "cancelled"
                task["status_detail"] = "Cancelled by user"
                task["download_speed"] = 0
            self._persist_task(task)
            return True
        return False

    def delete_task(self, gid: str, delete_files: bool = False, allowed_roots: Optional[List[str]] = None) -> bool:
        """Deletes a YouTube task and optionally deletes downloaded media files from disk."""
        self.cancel_task(gid)
        with self._lock:
            task = self._tasks.pop(gid, None)

        if not task:
            return False

        if delete_files and allowed_roots and task.get("dir"):
            from app.services.file_service import file_service
            dest_dir = task.get("dir")
            output_files = task.get("output_files", [])
            title = task.get("title")

            for fn in output_files:
                p = Path(fn)
                if p.exists():
                    try:
                        validated = file_service.validate_path(str(p), allowed_roots, check_exists=True)
                        if validated.is_file():
                            validated.unlink()
                    except Exception:
                        pass

            # Search in dest_dir for matching title if specific file wasn't registered
            if title and dest_dir and os.path.exists(dest_dir):
                try:
                    for f in Path(dest_dir).glob(f"{title}.*"):
                        if f.is_file():
                            try:
                                validated = file_service.validate_path(str(f), allowed_roots, check_exists=True)
                                validated.unlink()
                            except Exception:
                                pass
                except Exception:
                    pass

        try:
            with get_db_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("DELETE FROM youtube_tasks WHERE gid = ?;", (gid,))
                conn.commit()
        except Exception:
            pass

        return True

youtube_downloader = YoutubeDownloaderService()
