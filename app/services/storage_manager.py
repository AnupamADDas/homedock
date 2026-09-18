"""
Storage Management & Drive Hot-Plug Detection Service.
Dynamically tracks internal SSDs and external USB HDDs/SSDs,
calculates read/write throughput from /proc/diskstats,
tracks mount points, and monitors uevents for hot-plug events.
"""

import os
import json
import time
import socket
import select
import asyncio
import threading
import subprocess
from pathlib import Path
from typing import Dict, Any, List, Optional, Callable, Set

class StorageManagerService:
    def __init__(self):
        self._cached_devices: List[Dict[str, Any]] = []
        self._last_diskstats: Dict[str, Dict[str, float]] = {}
        self._last_stats_time = time.time()
        self._callbacks: List[Callable[[List[Dict[str, Any]]], None]] = []
        self._known_device_keys: Set[str] = set()
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        
        # Initial scan
        self.refresh_devices()

    def register_callback(self, callback: Callable[[List[Dict[str, Any]]], None]):
        """Registers a callback to be invoked whenever a drive is plugged/unplugged/mounted."""
        self._callbacks.append(callback)

    def _notify_callbacks(self, devices: List[Dict[str, Any]]):
        for cb in self._callbacks:
            try:
                cb(devices)
            except Exception:
                pass

    def _read_diskstats(self) -> Dict[str, Dict[str, int]]:
        """Parses /proc/diskstats for sectors read and written."""
        stats = {}
        try:
            with open("/proc/diskstats", "r") as f:
                for line in f:
                    parts = line.strip().split()
                    if len(parts) >= 11:
                        dev_name = parts[2]
                        # Field 5 is sectors read, Field 9 is sectors written
                        try:
                            stats[dev_name] = {
                                "read_bytes": int(parts[5]) * 512,
                                "write_bytes": int(parts[9]) * 512,
                            }
                        except ValueError:
                            pass
        except Exception:
            pass
        return stats

    def _get_hwmon_disk_temp(self, dev_name: str) -> Optional[float]:
        """Tries to find disk temperature in hwmon or sysfs without root."""
        # Check if nvme
        if dev_name.startswith("nvme"):
            for h in os.listdir("/sys/class/hwmon"):
                p = os.path.join("/sys/class/hwmon", h)
                name_f = os.path.join(p, "name")
                if os.path.exists(name_f):
                    try:
                        with open(name_f) as nf:
                            if nf.read().strip() == "nvme":
                                temp_f = os.path.join(p, "temp1_input")
                                if os.path.exists(temp_f):
                                    with open(temp_f) as tf:
                                        return round(float(tf.read().strip()) / 1000.0, 1)
                    except Exception:
                        pass
        return None

    def refresh_devices(self) -> List[Dict[str, Any]]:
        """Scans block devices using lsblk -J and /proc/diskstats."""
        now = time.time()
        dt = max(now - self._last_stats_time, 0.1)
        current_diskstats = self._read_diskstats()
        
        devices_result = []
        current_keys = set()

        try:
            res = subprocess.run(
                [
                    "lsblk", "-e", "7", "-J", "-b",
                    "-o", "NAME,KNAME,TYPE,FSTYPE,SIZE,MOUNTPOINT,LABEL,MODEL,SERIAL,ROTA,TRAN"
                ],
                capture_output=True,
                text=True,
                check=True
            )
            data = json.loads(res.stdout)
            blockdevices = data.get("blockdevices", [])
        except Exception as e:
            blockdevices = []

        for bdev in blockdevices:
            dev_name = bdev.get("name") or ""
            dev_type = (bdev.get("type") or "").lower()
            fstype = (bdev.get("fstype") or "").lower()
            mountpoint = bdev.get("mountpoint") or ""

            # Filter out virtual loop devices, squashfs packages, and snap mounts
            if dev_type == "loop" or dev_name.startswith("loop") or fstype == "squashfs":
                continue
            if mountpoint.startswith("/snap") or mountpoint.startswith("/var/lib/snapd"):
                continue

            kname = bdev.get("kname") or dev_name
            tran = bdev.get("tran") or ("usb" if "usb" in (bdev.get("subsystems") or "") else "sata/internal")
            is_rotational = bdev.get("rota", False)
            model = (bdev.get("model") or "").strip()
            serial = (bdev.get("serial") or "").strip()
            
            # Compute I/O rates for whole disk
            read_rate = 0.0
            write_rate = 0.0
            if kname in current_diskstats and kname in self._last_diskstats:
                curr = current_diskstats[kname]
                prev = self._last_diskstats[kname]
                read_rate = max(curr["read_bytes"] - prev["read_bytes"], 0) / dt
                write_rate = max(curr["write_bytes"] - prev["write_bytes"], 0) / dt

            temp = self._get_hwmon_disk_temp(kname)

            # Classify drive type
            if tran == "nvme":
                drive_type = "NVMe SSD"
            elif tran == "usb":
                drive_type = "External USB HDD" if is_rotational else "External USB SSD"
            elif is_rotational:
                drive_type = "Internal HDD"
            else:
                drive_type = "Internal SSD"

            # Parse partitions / children
            children = bdev.get("children", [])
            partitions = []
            
            # Check if whole disk is directly mounted
            mountpoint = bdev.get("mountpoint")
            fstype = bdev.get("fstype")
            size = bdev.get("size") or 0
            
            if mountpoint and os.path.exists(mountpoint):
                stat = self._get_fs_usage(mountpoint)
                partitions.append({
                    "name": dev_name,
                    "kname": kname,
                    "mountpoint": mountpoint,
                    "fstype": fstype,
                    "total_bytes": stat["total"],
                    "used_bytes": stat["used"],
                    "free_bytes": stat["free"],
                    "usage_percent": stat["percent"],
                    "read_speed": round(read_rate, 1),
                    "write_speed": round(write_rate, 1),
                    "mounted": True,
                })
            
            for part in children:
                p_name = part.get("name") or ""
                p_kname = part.get("kname") or p_name
                p_type = (part.get("type") or "").lower()
                p_mount = part.get("mountpoint") or ""
                p_fstype = (part.get("fstype") or "").lower()
                p_size = part.get("size") or 0

                # Ignore loop devices and snap mounts within children
                if p_type == "loop" or p_name.startswith("loop") or p_fstype == "squashfs":
                    continue
                if p_mount.startswith("/snap") or p_mount.startswith("/var/lib/snapd"):
                    continue
                
                p_read_rate = 0.0
                p_write_rate = 0.0
                if p_kname in current_diskstats and p_kname in self._last_diskstats:
                    p_curr = current_diskstats[p_kname]
                    p_prev = self._last_diskstats[p_kname]
                    p_read_rate = max(p_curr["read_bytes"] - p_prev["read_bytes"], 0) / dt
                    p_write_rate = max(p_curr["write_bytes"] - p_prev["write_bytes"], 0) / dt
                
                is_mounted = bool(p_mount and os.path.exists(p_mount))
                if is_mounted and p_mount:
                    stat = self._get_fs_usage(p_mount)
                    p_total = stat["total"]
                    p_used = stat["used"]
                    p_free = stat["free"]
                    p_pct = stat["percent"]
                else:
                    p_total = p_size
                    p_used = 0
                    p_free = p_size
                    p_pct = 0.0

                partitions.append({
                    "name": p_name,
                    "kname": p_kname,
                    "mountpoint": p_mount,
                    "fstype": p_fstype,
                    "total_bytes": p_total,
                    "used_bytes": p_used,
                    "free_bytes": p_free,
                    "usage_percent": p_pct,
                    "read_speed": round(p_read_rate if p_read_rate > 0 else read_rate, 1),
                    "write_speed": round(p_write_rate if p_write_rate > 0 else write_rate, 1),
                    "mounted": is_mounted,
                })

            device_info = {
                "device": f"/dev/{dev_name}",
                "name": dev_name,
                "model": model or ("External USB Drive" if tran == "usb" else "Generic Drive"),
                "serial": serial or "Unavailable",
                "transport": tran,
                "type": drive_type,
                "is_rotational": is_rotational,
                "size_bytes": size,
                "temperature": temp,
                "smart_health": "Unavailable (unprivileged access)",
                "read_speed": round(read_rate, 1),
                "write_speed": round(write_rate, 1),
                "partitions": partitions,
            }
            devices_result.append(device_info)
            
            # Key for change detection
            current_keys.add(f"{dev_name}:{model}:{len(partitions)}:{[p['mountpoint'] for p in partitions]}")

        self._last_diskstats = current_diskstats
        self._last_stats_time = now

        # Check if set of devices or mount points changed
        with self._lock:
            if current_keys != self._known_device_keys:
                self._known_device_keys = current_keys
                self._cached_devices = devices_result
                self._notify_callbacks(devices_result)
            else:
                self._cached_devices = devices_result

        return devices_result

    def _get_fs_usage(self, mountpoint: str) -> Dict[str, Any]:
        """Gets filesystem storage usage stats safely."""
        try:
            st = os.statvfs(mountpoint)
            total = st.f_blocks * st.f_frsize
            free = st.f_bavail * st.f_frsize
            used = max(total - free, 0)
            pct = round((used / total * 100.0), 1) if total > 0 else 0.0
            return {"total": total, "used": used, "free": free, "percent": pct}
        except Exception:
            return {"total": 0, "used": 0, "free": 0, "percent": 0.0}

    def update_io_stats(self) -> List[Dict[str, Any]]:
        """Calculates instantaneous read/write speeds from /proc/diskstats and updates cached devices in-place."""
        now = time.time()
        dt = max(now - self._last_stats_time, 0.1)
        current_diskstats = self._read_diskstats()

        with self._lock:
            if not self._cached_devices:
                return self.refresh_devices()

            for dev in self._cached_devices:
                kname = dev.get("name")
                read_rate = 0.0
                write_rate = 0.0
                if kname in current_diskstats and kname in self._last_diskstats:
                    curr = current_diskstats[kname]
                    prev = self._last_diskstats[kname]
                    read_rate = max(curr["read_bytes"] - prev["read_bytes"], 0) / dt
                    write_rate = max(curr["write_bytes"] - prev["write_bytes"], 0) / dt
                dev["read_speed"] = round(read_rate, 1)
                dev["write_speed"] = round(write_rate, 1)

                for part in dev.get("partitions", []):
                    p_kname = part.get("kname") or part.get("name")
                    p_read_rate = 0.0
                    p_write_rate = 0.0
                    if p_kname in current_diskstats and p_kname in self._last_diskstats:
                        p_curr = current_diskstats[p_kname]
                        p_prev = self._last_diskstats[p_kname]
                        p_read_rate = max(p_curr["read_bytes"] - p_prev["read_bytes"], 0) / dt
                        p_write_rate = max(p_curr["write_bytes"] - p_prev["write_bytes"], 0) / dt
                    
                    part["read_speed"] = round(p_read_rate if p_read_rate > 0 else read_rate, 1)
                    part["write_speed"] = round(p_write_rate if p_write_rate > 0 else write_rate, 1)

                    if part.get("mounted") and part.get("mountpoint"):
                        stat = self._get_fs_usage(part["mountpoint"])
                        part["total_bytes"] = stat["total"]
                        part["used_bytes"] = stat["used"]
                        part["free_bytes"] = stat["free"]
                        part["usage_percent"] = stat["percent"]

            self._last_diskstats = current_diskstats
            self._last_stats_time = now
            return self._cached_devices

    def get_devices(self, update_io: bool = True) -> List[Dict[str, Any]]:
        """Returns cached devices with live I/O stats."""
        if update_io:
            return self.update_io_stats()
        with self._lock:
            if self._cached_devices:
                return self._cached_devices
        return self.refresh_devices()

    def get_mounted_locations(self) -> List[Dict[str, Any]]:
        """Returns a convenient list of all currently mounted storage locations."""
        devices = self.get_devices()
        locations = []
        for dev in devices:
            for part in dev["partitions"]:
                if part.get("mounted") and part.get("mountpoint"):
                    mp = part["mountpoint"]
                    if mp.startswith("/snap") or mp.startswith("/var/lib/snapd"):
                        continue
                    label = f"{dev['model']} ({part['mountpoint']})"
                    locations.append({
                        "name": part["name"],
                        "mountpoint": part["mountpoint"],
                        "device": dev["device"],
                        "type": dev["type"],
                        "label": label,
                        "total_bytes": part["total_bytes"],
                        "used_bytes": part["used_bytes"],
                        "free_bytes": part["free_bytes"],
                        "usage_percent": part["usage_percent"],
                    })
        return locations

    def is_path_safe_and_mounted(self, path: Path) -> bool:
        """Verifies that a given path's storage device is still mounted and accessible."""
        try:
            resolved = path.resolve()
            if not resolved.exists():
                return False
            # Ensure mount is active in /proc/mounts
            mounts = set()
            with open("/proc/mounts", "r") as f:
                for line in f:
                    parts = line.split()
                    if len(parts) >= 2:
                        mounts.add(parts[1])
            
            # Find the best matching mountpoint
            curr = resolved
            while curr != curr.parent:
                if str(curr) in mounts:
                    return True
                curr = curr.parent
            return str(curr) in mounts
        except Exception:
            return False

    def start_monitoring(self):
        """Starts background hot-plug listener and reconciliation watchdog."""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._monitor_loop, daemon=True, name="StorageHotplugWatcher")
        self._thread.start()

    def stop_monitoring(self):
        self._running = False

    def _monitor_loop(self):
        """Monitors kernel uevents and polls mounts for hot-plug events."""
        netlink_sock = None
        try:
            # AF_NETLINK, SOCK_DGRAM, NETLINK_KOBJECT_UEVENT (15)
            netlink_sock = socket.socket(socket.AF_NETLINK, socket.SOCK_DGRAM, 15)
            netlink_sock.bind((os.getpid(), 1))
            netlink_sock.setblocking(False)
        except Exception:
            netlink_sock = None

        while self._running:
            try:
                # Use select with 3-second timeout
                readers = [netlink_sock] if netlink_sock else []
                readable, _, _ = select.select(readers, [], [], 3.0)
                
                event_detected = False
                if netlink_sock and netlink_sock in readable:
                    while True:
                        try:
                            data = netlink_sock.recv(4096)
                            if b"subsystem=block" in data.lower() or b"block" in data:
                                event_detected = True
                        except (BlockingIOError, socket.error):
                            break
                            
                # Refresh devices on uevent or every 3 seconds
                self.refresh_devices()
            except Exception:
                time.sleep(3.0)

storage_manager = StorageManagerService()
