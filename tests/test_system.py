"""
System Monitoring & Sensor Tests for HomeDock.
Tests CPU, RAM, Network, Fan RPM, Temperatures, and graceful sensor degradation.
"""

import pytest
from app.services.system_monitor import system_monitor

def test_system_metrics_sampling():
    metrics = system_monitor.sample_metrics()
    assert "cpu" in metrics
    assert "memory" in metrics
    assert "network" in metrics
    assert "sensors" in metrics
    assert "system_info" in metrics

    # CPU assertions
    cpu = metrics["cpu"]
    assert 0.0 <= cpu["usage_percent"] <= 100.0
    assert len(cpu["cores"]) > 0
    assert len(cpu["load_average"]) == 3
    assert len(cpu["history"]) > 0
    assert "power_watts" in cpu
    if cpu["power_watts"] is not None:
        assert cpu["power_watts"] >= 0.0

    # Memory assertions
    mem = metrics["memory"]
    assert mem["total"] > 0
    assert mem["used"] > 0
    assert 0.0 <= mem["percent"] <= 100.0

    # Network assertions
    net = metrics["network"]
    assert net["download_speed"] >= 0.0
    assert net["upload_speed"] >= 0.0
    assert "total_download_bytes" in net
    assert "total_upload_bytes" in net
    assert isinstance(net["interfaces"], list)

    # Sensors graceful degradation assertions
    sensors = metrics["sensors"]
    assert "fan_rpm" in sensors
    assert "fan_available" in sensors
    assert "fan_status" in sensors
    assert "nvme_temp" in sensors
    assert "pch_temp" in sensors
    assert "wifi_temp" in sensors
    assert isinstance(sensors["fan_status"], str)

def test_static_host_info():
    info = system_monitor.get_static_info()
    assert info["hostname"] != ""
    assert "Linux" in info["os"]
    assert "cpu_model" in info
    assert info["cpu_model"] != ""
    assert info["logical_cpus"] >= 1
    assert info["uptime_seconds"] > 0
