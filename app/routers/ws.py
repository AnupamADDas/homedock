"""
Real-Time WebSocket Hub for HomeDock.
Streams live system telemetry, drive hot-plug events, and download manager states
efficiently to connected clients with automatic disconnect cleanup.
"""

import asyncio
import json
from typing import Set, Dict, Any, Optional
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query, status
from app.security import decode_access_token
from app.services.system_monitor import system_monitor
from app.services.storage_manager import storage_manager
from app.services.download_manager import download_manager

router = APIRouter(tags=["websocket"])

class ConnectionManager:
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()
        self._broadcast_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        async with self._lock:
            self.active_connections.add(websocket)
            if self._broadcast_task is None or self._broadcast_task.done():
                self._broadcast_task = asyncio.create_task(self._broadcast_loop())

    async def disconnect(self, websocket: WebSocket):
        async with self._lock:
            self.active_connections.discard(websocket)

    async def broadcast_json(self, message: Dict[str, Any]):
        """Broadcasts a message to all active WebSocket clients."""
        text = json.dumps(message)
        disconnected = set()
        for connection in list(self.active_connections):
            try:
                await connection.send_text(text)
            except Exception:
                disconnected.add(connection)

        if disconnected:
            async with self._lock:
                self.active_connections.difference_update(disconnected)

    async def _broadcast_loop(self):
        """Streams telemetry and download updates at a measured 1.5s cadence when clients are connected."""
        while True:
            if not self.active_connections:
                await asyncio.sleep(2.0)
                if not self.active_connections:
                    break

            try:
                # System Telemetry
                metrics = system_monitor.sample_metrics()
                
                # Download Stats
                try:
                    dl_stats = await download_manager.get_global_stat()
                    # If active downloads exist, also send summary
                    downloads = []
                    if dl_stats.get("num_active", 0) > 0:
                        downloads = await download_manager.get_all_downloads()
                except Exception:
                    dl_stats = None
                    downloads = []

                # Storage & Disk I/O Speeds
                try:
                    storage_data = storage_manager.get_devices(update_io=True)
                except Exception:
                    storage_data = None

                payload = {
                    "type": "telemetry",
                    "data": {
                        "metrics": metrics,
                        "storage": storage_data,
                        "download_stats": dl_stats,
                        "downloads": downloads,
                    }
                }
                await self.broadcast_json(payload)
            except Exception:
                pass

            await asyncio.sleep(1.5)

ws_manager = ConnectionManager()

# Hook storage manager hot-plug callback to WebSocket broadcast
def on_storage_change(devices):
    asyncio.create_task(
        ws_manager.broadcast_json({
            "type": "storage_update",
            "data": devices
        })
    )

storage_manager.register_callback(on_storage_change)

@router.websocket("/api/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    token: Optional[str] = Query(None)
):
    # Verify authentication token
    auth_token = token
    if not auth_token:
        # Check cookie
        auth_token = websocket.cookies.get("homedock_token")

    if not auth_token:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    payload = decode_access_token(auth_token)
    if not payload:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await ws_manager.connect(websocket)
    try:
        # Send initial full state immediately
        initial_metrics = system_monitor.sample_metrics()
        initial_storage = storage_manager.get_devices()
        try:
            dl_stats = await download_manager.get_global_stat()
            downloads = await download_manager.get_all_downloads()
        except Exception:
            dl_stats = None
            downloads = []

        await websocket.send_text(json.dumps({
            "type": "initial_state",
            "data": {
                "metrics": initial_metrics,
                "storage": initial_storage,
                "download_stats": dl_stats,
                "downloads": downloads,
            }
        }))

        # Keep connection open and listen for client pings or messages
        while True:
            data = await websocket.receive_text()
            # Client can send ping or request refresh
            try:
                msg = json.loads(data)
                if msg.get("action") == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))
            except Exception:
                pass
    except WebSocketDisconnect:
        await ws_manager.disconnect(websocket)
    except Exception:
        await ws_manager.disconnect(websocket)
