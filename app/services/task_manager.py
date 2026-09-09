"""
Task Manager Service for HomeDock.
Tracks real-time progress of long-running file operations (copy, move, extract, upload)
and broadcasts live telemetry updates via WebSocket to connected clients.
"""

import time
import asyncio
from typing import Dict, Any, Optional
from app.routers.ws import ws_manager

class TaskManager:
    def __init__(self):
        self._tasks: Dict[str, Dict[str, Any]] = {}
        self._cancelled: set[str] = set()
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def set_loop(self, loop: asyncio.AbstractEventLoop):
        self._loop = loop

    def get_loop(self) -> Optional[asyncio.AbstractEventLoop]:
        if self._loop and not self._loop.is_closed():
            return self._loop
        try:
            self._loop = asyncio.get_running_loop()
            return self._loop
        except RuntimeError:
            return None

    def create_task(self, task_id: str, op_type: str, title: str, total_bytes: int = 0) -> Dict[str, Any]:
        now = time.time()
        self._cancelled.discard(task_id)
        task = {
            "task_id": task_id,
            "type": op_type,  # 'copy', 'move', 'extract', 'upload'
            "title": title,
            "status": "running",  # 'running', 'completed', 'failed', 'cancelled'
            "percent": 0.0,
            "detail": "Starting...",
            "done_bytes": 0,
            "total_bytes": total_bytes,
            "speed_bps": 0.0,
            "eta_seconds": None,
            "error": None,
            "start_time": now,
            "updated_at": now,
        }
        self._tasks[task_id] = task
        self._broadcast(task)
        return task

    def cancel_task(self, task_id: str):
        self._cancelled.add(task_id)
        if task_id in self._tasks:
            task = self._tasks[task_id]
            task["status"] = "cancelled"
            task["detail"] = "Operation cancelled by user"
            task["speed_bps"] = 0.0
            task["eta_seconds"] = None
            task["updated_at"] = time.time()
            self._broadcast(task)

    def is_cancelled(self, task_id: Optional[str]) -> bool:
        if not task_id:
            return False
        return task_id in self._cancelled

    def update_task(
        self,
        task_id: str,
        percent: float,
        detail: str,
        done_bytes: int = 0,
        total_bytes: int = 0,
        status: str = "running"
    ):
        if task_id not in self._tasks:
            return

        task = self._tasks[task_id]
        if task.get("status") == "cancelled":
            return

        now = time.time()
        elapsed = now - task["start_time"]

        speed = 0.0
        eta = None
        if done_bytes > 0 and elapsed > 0.5:
            speed = done_bytes / elapsed
            if total_bytes > done_bytes and speed > 0:
                eta = int((total_bytes - done_bytes) / speed)

        task["percent"] = min(round(float(percent), 1), 100.0)
        task["detail"] = detail
        task["done_bytes"] = done_bytes
        if total_bytes > 0:
            task["total_bytes"] = total_bytes
        task["speed_bps"] = speed
        task["eta_seconds"] = eta
        task["status"] = status
        task["updated_at"] = now

        self._broadcast(task)

    def complete_task(self, task_id: str, detail: str = "Completed successfully"):
        if task_id not in self._tasks:
            return
        task = self._tasks[task_id]
        if task.get("status") == "cancelled":
            return
        task["status"] = "completed"
        task["percent"] = 100.0
        task["detail"] = detail
        task["speed_bps"] = 0.0
        task["eta_seconds"] = 0
        task["updated_at"] = time.time()
        self._broadcast(task)

    def fail_task(self, task_id: str, error: str):
        if task_id not in self._tasks:
            return
        task = self._tasks[task_id]
        if task.get("status") == "cancelled":
            return
        task["status"] = "failed"
        task["error"] = error
        task["detail"] = f"Failed: {error}"
        task["speed_bps"] = 0.0
        task["eta_seconds"] = None
        task["updated_at"] = time.time()
        self._broadcast(task)

    def get_task(self, task_id: str) -> Optional[Dict[str, Any]]:
        return self._tasks.get(task_id)

    def _broadcast(self, task: Dict[str, Any]):
        loop = self.get_loop()
        if loop and not loop.is_closed():
            payload = {
                "type": "file_task_progress",
                "data": task
            }
            try:
                asyncio.run_coroutine_threadsafe(ws_manager.broadcast_json(payload), loop)
            except Exception:
                pass

task_manager = TaskManager()
