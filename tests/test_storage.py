"""
Storage & Hot-Plug Service Tests for HomeDock.
Tests block device discovery, mounted locations, I/O rates, and change notifications.
"""

import pytest
from app.services.storage_manager import storage_manager

def test_storage_device_discovery():
    devices = storage_manager.get_devices()
    assert isinstance(devices, list)
    assert len(devices) >= 1

    for dev in devices:
        assert "device" in dev
        assert "model" in dev
        assert "type" in dev
        assert "transport" in dev
        assert "partitions" in dev
        assert isinstance(dev["partitions"], list)

def test_mounted_locations():
    locations = storage_manager.get_mounted_locations()
    assert isinstance(locations, list)
    assert len(locations) >= 1

    # / filesystem must be present
    root_mount = next((l for l in locations if l["mountpoint"] == "/"), None)
    assert root_mount is not None
    assert root_mount["total_bytes"] > 0
    assert root_mount["used_bytes"] > 0
    assert 0 <= root_mount["usage_percent"] <= 100

def test_hot_plug_callback_registration():
    events = []
    def on_change(devs):
        events.append(len(devs))

    storage_manager.register_callback(on_change)
    # Trigger refresh
    storage_manager.refresh_devices()
    # Ensure system does not raise exceptions
    assert isinstance(storage_manager.get_devices(), list)

def test_storage_live_io_stats():
    # Calling update_io_stats should calculate rates and update cached devices
    devices = storage_manager.update_io_stats()
    assert isinstance(devices, list)
    for dev in devices:
        assert "read_speed" in dev
        assert "write_speed" in dev
        assert dev["read_speed"] >= 0.0
        assert dev["write_speed"] >= 0.0
        for p in dev.get("partitions", []):
            assert "read_speed" in p
            assert "write_speed" in p
            assert p["read_speed"] >= 0.0
            assert p["write_speed"] >= 0.0
