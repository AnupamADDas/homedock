"""
Storage Router for HomeDock.
Provides block device hierarchy, filesystems, dynamic hot-plug discovery,
temperatures, and I/O throughput.
"""

from typing import Dict, Any, List
from fastapi import APIRouter, Depends
from app.services.storage_manager import storage_manager
from app.deps import get_current_user

router = APIRouter(prefix="/api/storage", tags=["storage"])

@router.get("/devices")
async def get_storage_devices(current_user: Dict[str, Any] = Depends(get_current_user)) -> List[Dict[str, Any]]:
    """Returns all attached storage devices, partitions, mountpoints, and I/O speeds."""
    return storage_manager.get_devices()

@router.get("/mounted")
async def get_mounted_locations(current_user: Dict[str, Any] = Depends(get_current_user)) -> List[Dict[str, Any]]:
    """Returns quick-access mounted directories and storage usage stats."""
    return storage_manager.get_mounted_locations()

@router.post("/refresh")
async def refresh_storage(current_user: Dict[str, Any] = Depends(get_current_user)) -> List[Dict[str, Any]]:
    """Forces an immediate storage re-scan."""
    return storage_manager.refresh_devices()
