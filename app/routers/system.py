"""
System Telemetry Router for HomeDock.
Provides live metrics (CPU, RAM, Net, Fan, Temperature) and host information.
"""

from typing import Dict, Any
from fastapi import APIRouter, Depends
from app.services.system_monitor import system_monitor
from app.deps import get_current_user

router = APIRouter(prefix="/api/system", tags=["system"])

@router.get("/metrics")
async def get_metrics(current_user: Dict[str, Any] = Depends(get_current_user)):
    """Returns real-time hardware telemetry and 60-second rolling history."""
    return system_monitor.sample_metrics()

@router.get("/info")
async def get_system_info(current_user: Dict[str, Any] = Depends(get_current_user)):
    """Returns static hardware configuration and host details."""
    return system_monitor.get_static_info()
