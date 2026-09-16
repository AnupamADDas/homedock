"""
Download Manager Service for HomeDock.
Manages an unprivileged, localhost-bound aria2c daemon and provides
AriaNg-inspired download capabilities (HTTP, HTTPS, Torrents, Magnets)
with global and per-download rate limiting.
"""

import os
import time
import base64
import asyncio
import subprocess
from pathlib import Path
from typing import List, Dict, Any, Optional
import httpx
from app.config import (
    ARIA2_BIN,
    ARIA2_RPC_HOST,
    ARIA2_RPC_PORT,
    ARIA2_SECRET,
    DATA_DIR
)
from app.database import get_setting

PUBLIC_TRACKERS = (
    "udp://tracker.opentrackr.org:1337/announce,"
    "udp://open.stealth.si:80/announce,"
    "udp://tracker.torrent.eu.org:451/announce,"
    "udp://tracker.bittor.pw:1337/announce,"
    "udp://public.tracker.vraphim.com:6969/announce,"
    "udp://tracker.moeking.me:6969/announce,"
    "udp://explodie.org:6969/announce,"
    "udp://exodus.desync.com:6969/announce,"
    "http://tracker.openbittorrent.com:80/announce,"
    "udp://tracker.dler.org:6969/announce,"
    "udp://tracker.tiny-vps.com:6969/announce"
)

class DownloadManagerService:
    def __init__(self):
        self._process: Optional[subprocess.Popen] = None
        self._rpc_url = f"http://{ARIA2_RPC_HOST}:{ARIA2_RPC_PORT}/jsonrpc"
        self._session_file = DATA_DIR / "aria2.session"
        self._log_file = DATA_DIR / "aria2.log"
        self._req_id = 1
        self._daemon_verified = False

    def _is_daemon_alive(self) -> bool:
        """Checks if aria2c daemon is already responding on RPC port."""
        if self._process and self._process.poll() is None:
            return True
        import socket
        try:
            with socket.create_connection((ARIA2_RPC_HOST, ARIA2_RPC_PORT), timeout=0.3):
                return True
        except (socket.timeout, ConnectionRefusedError, OSError):
            self._daemon_verified = False
            return False

    def ensure_daemon_started(self):
        """Starts the local aria2c daemon if not already executing with optimized PulseDL-level socket & chunk settings."""
        if self._is_daemon_alive():
            if self._daemon_verified:
                return

            needs_restart = False
            try:
                import urllib.request, json
                req = urllib.request.Request(
                    self._rpc_url,
                    data=json.dumps({
                        "jsonrpc": "2.0",
                        "id": "probe",
                        "method": "aria2.getGlobalOption",
                        "params": [f"token:{ARIA2_SECRET}"]
                    }).encode("utf-8"),
                    headers={"Content-Type": "application/json"}
                )
                with urllib.request.urlopen(req, timeout=1.0) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    opts = data.get("result", {})
                    # Restart if running daemon has outdated/crippled configurations
                    if (
                        opts.get("max-connection-per-server") != "16"
                        or opts.get("stream-piece-selector") == "geom"
                        or opts.get("socket-recv-buffer-size") in ("64K", "65536")
                    ):
                        needs_restart = True
            except Exception:
                pass

            if not needs_restart:
                self._daemon_verified = True
                return

            self.stop_daemon()
            time.sleep(0.5)

        self._daemon_verified = False
        if not self._session_file.exists():
            self._session_file.touch()

        cmd = [
            ARIA2_BIN,
            "--enable-rpc",
            "--rpc-listen-all=false",
            f"--rpc-listen-port={ARIA2_RPC_PORT}",
            f"--rpc-secret={ARIA2_SECRET}",
            "--rpc-max-request-size=64M",
            f"--input-file={str(self._session_file)}",
            f"--save-session={str(self._session_file)}",
            "--save-session-interval=30",
            "--max-concurrent-downloads=5",
            "--continue=true",
            "--always-resume=true",
            "--check-integrity=true",
            "--max-connection-per-server=16",
            "--split=16",
            "--min-split-size=1M",
            "--piece-length=1M",
            "--stream-piece-selector=default",
            "--conditional-get=true",
            "--disk-cache=64M",
            "--file-allocation=falloc",
            "--optimize-concurrent-downloads=true",
            "--http-accept-gzip=true",
            "--content-disposition-default-utf8=true",
            "--timeout=30",
            "--connect-timeout=30",
            "--max-tries=10",
            "--retry-wait=5",
            "--follow-torrent=mem",
            "--listen-port=6881-6999",
            "--dht-listen-port=6881-6999",
            "--enable-dht=true",
            "--enable-dht6=true",
            "--enable-peer-exchange=true",
            "--bt-enable-lpd=true",
            "--bt-max-peers=100",
            "--bt-request-peer-speed-limit=50M",
            "--bt-save-metadata=true",
            "--seed-ratio=1.0",
            "--seed-time=120",
            "--peer-id-prefix=-HD1000-",
            "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            f"--bt-tracker={PUBLIC_TRACKERS}",
            f"--log={str(self._log_file)}",
            "--log-level=warn",
            "--quiet=true",
        ]

        # Respect configured global limits
        dl_limit = get_setting("max_download_limit", "0")
        ul_limit = get_setting("max_upload_limit", "0")
        if dl_limit and dl_limit != "0":
            cmd.append(f"--max-overall-download-limit={dl_limit}")
        if ul_limit and ul_limit != "0":
            cmd.append(f"--max-overall-upload-limit={ul_limit}")

        # Respect configured default download dir
        from app.config import get_default_download_dir
        default_dir = get_setting("default_download_dir", get_default_download_dir())
        if default_dir:
            try:
                Path(default_dir).mkdir(parents=True, exist_ok=True)
                cmd.append(f"--dir={default_dir}")
            except Exception:
                pass

        try:
            self._process = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True
            )
            time.sleep(0.3)
            self._daemon_verified = True
        except Exception as e:
            raise RuntimeError(f"Failed to start aria2c daemon: {e}")

    def stop_daemon(self):
        """Gracefully stops the aria2c child process."""
        self._daemon_verified = False
        if self._process and self._process.poll() is None:
            try:
                self._process.terminate()
                self._process.wait(timeout=3)
            except Exception:
                self._process.kill()
            self._process = None

        # Terminate any lingering aria2 instances listening on ARIA2_RPC_PORT
        try:
            import psutil
            for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
                try:
                    cmdline = proc.info.get('cmdline') or []
                    cmd_str = " ".join(cmdline)
                    if ("aria2c" in cmd_str or "aria2c.bin" in cmd_str) and f"--rpc-listen-port={ARIA2_RPC_PORT}" in cmd_str:
                        proc.terminate()
                        try:
                            proc.wait(timeout=2)
                        except Exception:
                            proc.kill()
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
        except Exception:
            pass

    async def _rpc_call(self, method: str, params: Optional[List[Any]] = None) -> Any:
        """Issues an authenticated JSON-RPC call to local aria2c instance."""
        self.ensure_daemon_started()
        
        rpc_params = [f"token:{ARIA2_SECRET}"]
        if params:
            rpc_params.extend(params)

        self._req_id += 1
        payload = {
            "jsonrpc": "2.0",
            "id": f"hd-{self._req_id}",
            "method": method,
            "params": rpc_params,
        }

        async with httpx.AsyncClient(timeout=10.0) as client:
            try:
                resp = await client.post(self._rpc_url, json=payload)
                resp.raise_for_status()
                data = resp.json()
                if "error" in data:
                    err = data["error"]
                    raise RuntimeError(f"Aria2 error {err.get('code')}: {err.get('message')}")
                return data.get("result")
            except httpx.ConnectError:
                # Retry once after restarting daemon
                self.ensure_daemon_started()
                resp = await client.post(self._rpc_url, json=payload)
                resp.raise_for_status()
                data = resp.json()
                if "error" in data:
                    err = data["error"]
                    raise RuntimeError(f"Aria2 error {err.get('code')}: {err.get('message')}")
                return data.get("result")

    async def add_uri(
        self,
        uris: List[str],
        destination_dir: str,
        max_download_limit: Optional[int] = None,
        filename: Optional[str] = None
    ) -> str:
        """Queues a new download (HTTP, HTTPS, FTP, Magnet) in destination_dir."""
        options: Dict[str, Any] = {
            "dir": destination_dir,
            "max-connection-per-server": "16",
            "split": "16",
            "min-split-size": "1M",
            "conditional-get": "true",
        }
        if max_download_limit and max_download_limit > 0:
            options["max-download-limit"] = str(max_download_limit)
        if filename:
            options["out"] = filename

        return await self._rpc_call("aria2.addUri", [uris, options])

    async def add_torrent(
        self,
        torrent_bytes: bytes,
        destination_dir: str,
        max_download_limit: Optional[int] = None
    ) -> str:
        """Queues a new torrent download using raw .torrent file bytes."""
        b64_content = base64.b64encode(torrent_bytes).decode("ascii")
        options: Dict[str, Any] = {
            "dir": destination_dir,
            "max-connection-per-server": "16",
            "split": "16",
        }
        if max_download_limit and max_download_limit > 0:
            options["max-download-limit"] = str(max_download_limit)

        return await self._rpc_call("aria2.addTorrent", [b64_content, [], options])

    async def pause(self, gid: str) -> str:
        if gid.startswith("yt-"):
            from app.services.youtube_downloader import youtube_downloader
            youtube_downloader.cancel_task(gid)
            return "OK"
        return await self._rpc_call("aria2.pause", [gid])

    async def unpause(self, gid: str) -> str:
        if gid.startswith("yt-"):
            return "OK"
        return await self._rpc_call("aria2.unpause", [gid])

    async def remove(self, gid: str) -> str:
        if gid.startswith("yt-"):
            from app.services.youtube_downloader import youtube_downloader
            youtube_downloader.cancel_task(gid)
            return "OK"
        try:
            return await self._rpc_call("aria2.remove", [gid])
        except Exception:
            return await self._rpc_call("aria2.removeDownloadResult", [gid])

    async def retry(self, gid: str) -> str:
        """Restarts a failed or stopped download."""
        status = await self.tell_status(gid)
        files = status.get("files", [])
        uris = []
        for f in files:
            for u in f.get("uris", []):
                uris.append(u.get("uri"))
        
        target_dir = status.get("dir")
        # Remove old result
        try:
            await self._rpc_call("aria2.removeDownloadResult", [gid])
        except Exception:
            pass

        if uris:
            return await self.add_uri(uris, target_dir)
        raise ValueError("Cannot retry download: original URI is unavailable")

    async def delete_download(self, gid: str, delete_files: bool = False, allowed_roots: Optional[List[str]] = None) -> bool:
        """Removes download and optionally deletes files from disk within allowed roots."""
        if gid.startswith("yt-"):
            from app.services.youtube_downloader import youtube_downloader
            return youtube_downloader.delete_task(gid, delete_files=delete_files, allowed_roots=allowed_roots)

        status = None
        try:
            status = await self.tell_status(gid)
        except Exception:
            pass

        try:
            await self.remove(gid)
        except Exception:
            pass

        if delete_files and status and allowed_roots:
            from app.services.file_service import file_service
            files = status.get("files", [])
            for f in files:
                f_path = f.get("path")
                if f_path and os.path.exists(f_path):
                    try:
                        validated = file_service.validate_path(f_path, allowed_roots, check_exists=True)
                        if validated.is_file():
                            validated.unlink()
                        # Also delete .aria2 control file
                        aria2_ctrl = Path(f"{f_path}.aria2")
                        if aria2_ctrl.exists():
                            aria2_ctrl.unlink()
                    except Exception:
                        pass
        return True

    async def set_download_limit(self, gid: str, limit_bytes_sec: int) -> str:
        """Sets a per-download rate limit in bytes/sec (0 = unlimited)."""
        options = {"max-download-limit": str(limit_bytes_sec)}
        return await self._rpc_call("aria2.changeOption", [gid, options])

    async def set_global_limits(self, download_limit_bytes: int, upload_limit_bytes: int) -> str:
        """Configures global aria2 download and upload limits."""
        options = {
            "max-overall-download-limit": str(download_limit_bytes),
            "max-overall-upload-limit": str(upload_limit_bytes),
        }
        return await self._rpc_call("aria2.changeGlobalOption", [options])

    async def set_global_dir(self, new_dir: str) -> str:
        """Configures global aria2 default download directory dynamically."""
        Path(new_dir).mkdir(parents=True, exist_ok=True)
        return await self._rpc_call("aria2.changeGlobalOption", [{"dir": str(new_dir)}])

    async def tell_status(self, gid: str) -> Dict[str, Any]:
        return await self._rpc_call("aria2.tellStatus", [gid])

    async def get_global_stat(self) -> Dict[str, Any]:
        """Retrieves global download/upload throughput, speed limits, and active counts."""
        res = await self._rpc_call("aria2.getGlobalStat")
        global_opts = {}
        try:
            global_opts = await self._rpc_call("aria2.getGlobalOption")
        except Exception:
            pass

        yt_speed = 0
        yt_active = 0
        try:
            from app.services.youtube_downloader import youtube_downloader
            yt_speed = youtube_downloader.get_total_download_speed()
            yt_active = youtube_downloader.get_active_count()
        except Exception:
            pass

        return {
            "download_speed": int(res.get("downloadSpeed", 0)) + yt_speed,
            "upload_speed": int(res.get("uploadSpeed", 0)),
            "num_active": int(res.get("numActive", 0)) + yt_active,
            "num_waiting": int(res.get("numWaiting", 0)),
            "num_stopped": int(res.get("numStopped", 0)),
            "max_download_limit": int(global_opts.get("max-overall-download-limit", 0)),
            "max_upload_limit": int(global_opts.get("max-overall-upload-limit", 0)),
        }

    async def get_all_downloads(self) -> List[Dict[str, Any]]:
        """Aggregates active, waiting, and stopped downloads into a uniform schema with limits."""
        fields = [
            "gid", "status", "totalLength", "completedLength",
            "uploadLength", "downloadSpeed", "uploadSpeed",
            "infoHash", "numSeeders", "connections", "errorCode",
            "errorMessage", "followedBy", "following", "dir", "files",
            "bittorrent"
        ]
        
        active = await self._rpc_call("aria2.tellActive", [fields]) or []
        waiting = await self._rpc_call("aria2.tellWaiting", [0, 100, fields]) or []
        stopped = await self._rpc_call("aria2.tellStopped", [0, 100, fields]) or []

        # Collect per-download limits for active and waiting downloads
        target_gids = [item.get("gid") for item in (active + waiting)]
        async def fetch_limit(g):
            try:
                opts = await self._rpc_call("aria2.getOption", [g])
                return g, int(opts.get("max-download-limit", 0))
            except Exception:
                return g, 0

        limits_map = {}
        if target_gids:
            limit_results = await asyncio.gather(*(fetch_limit(g) for g in target_gids))
            limits_map = dict(limit_results)

        all_raw = active + waiting + stopped
        results = []

        for item in all_raw:
            gid = item.get("gid")
            total = int(item.get("totalLength", 0))
            completed = int(item.get("completedLength", 0))
            dl_speed = int(item.get("downloadSpeed", 0))
            ul_speed = int(item.get("uploadSpeed", 0))
            status = item.get("status")  # active, waiting, paused, error, complete, removed

            # Determine title/filename
            title = "Unknown"
            bt = item.get("bittorrent")
            if bt and bt.get("info") and bt["info"].get("name"):
                title = bt["info"]["name"]
            else:
                files = item.get("files", [])
                if files and files[0].get("path"):
                    title = Path(files[0]["path"]).name
                elif files and files[0].get("uris") and files[0]["uris"]:
                    uri = files[0]["uris"][0].get("uri", "")
                    title = uri.split("?")[0].split("/")[-1] or uri

            # Progress %
            pct = round((completed / total * 100.0), 1) if total > 0 else 0.0

            # ETA calculation
            eta_seconds = None
            if dl_speed > 0 and total > completed:
                eta_seconds = int((total - completed) / dl_speed)

            results.append({
                "gid": gid,
                "name": title,
                "status": status,
                "total_bytes": total,
                "completed_bytes": completed,
                "percent": pct,
                "download_speed": dl_speed,
                "upload_speed": ul_speed,
                "max_download_limit": limits_map.get(gid, 0),
                "eta_seconds": eta_seconds,
                "dir": item.get("dir"),
                "connections": int(item.get("connections", 0)),
                "num_seeders": int(item.get("numSeeders", 0)),
                "error_code": item.get("errorCode"),
                "error_message": item.get("errorMessage"),
                "is_bittorrent": bool(bt),
                "is_youtube": False,
            })

        # Prepend YouTube downloads
        try:
            from app.services.youtube_downloader import youtube_downloader
            yt_tasks = youtube_downloader.get_tasks()
            return yt_tasks + results
        except Exception:
            return results

download_manager = DownloadManagerService()
