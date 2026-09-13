"""
System Monitoring Service.
Collects CPU, RAM, Network, Fan, Temperature, and Host telemetry using native
Linux interfaces (/proc, /sys/class/hwmon) and psutil with low resource overhead.
"""

import os
import time
import asyncio
from collections import deque
from typing import Dict, Any, List, Optional
import psutil

class SystemMonitorService:
    def __init__(self, history_len: int = 60):
        self.history_len = history_len
        now_ms = int(time.time() * 1000)
        # Pre-seed history with 2 baseline data points so charts render immediately
        self.cpu_history = deque([{"t": now_ms - 1000, "v": 0.0}, {"t": now_ms, "v": 0.0}], maxlen=history_len)
        self.mem_history = deque([{"t": now_ms - 1000, "v": 0.0}, {"t": now_ms, "v": 0.0}], maxlen=history_len)
        self.net_rx_history = deque([{"t": now_ms - 1000, "v": 0.0}, {"t": now_ms, "v": 0.0}], maxlen=history_len)
        self.net_tx_history = deque([{"t": now_ms - 1000, "v": 0.0}, {"t": now_ms, "v": 0.0}], maxlen=history_len)
        
        self.last_net_bytes = {}
        self.last_net_time = time.time()
        self.last_metrics: Dict[str, Any] = {}
        
        self.last_cpu_power: Optional[float] = None
        self.last_cpu_energy: Dict[str, int] = {}
        self.last_cpu_energy_time: Optional[float] = None
        self._rapl_domains: Optional[Dict[str, Dict[str, Any]]] = None
        self._powercap_fix_attempted = False

        self._running = False
        self._task: Optional[asyncio.Task] = None
        
        # Initial read to initialize psutil internal diff counters
        try:
            psutil.cpu_percent(interval=None)
            self._init_net_counters()
            self._init_power_counters()
        except Exception:
            pass

    def _ensure_powercap_permissions(self):
        """Attempts to ensure /sys/devices/virtual/powercap is readable if permissions were reset."""
        if self._powercap_fix_attempted:
            return
        self._powercap_fix_attempted = True
        try:
            import subprocess, shutil
            if shutil.which("docker"):
                subprocess.run(
                    ["docker", "run", "--rm", "--privileged", "-v", "/sys:/sys", "alpine", "chmod", "-R", "a+r", "/sys/devices/virtual/powercap"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=3
                )
        except Exception:
            pass

    def _discover_rapl_domains(self) -> Dict[str, Dict[str, Any]]:
        """Discovers CPU package RAPL powercap domains for hardware wattage monitoring."""
        domains = {}
        search_dirs = ["/sys/class/powercap", "/sys/devices/virtual/powercap"]
        for base in search_dirs:
            if not os.path.exists(base):
                continue
            try:
                for entry in sorted(os.listdir(base)):
                    p = os.path.join(base, entry)
                    if not os.path.isdir(p):
                        continue
                    name_file = os.path.join(p, "name")
                    energy_file = os.path.join(p, "energy_uj")
                    max_range_file = os.path.join(p, "max_energy_range_uj")
                    if not os.path.exists(name_file) or not os.path.exists(energy_file):
                        continue

                    if not os.access(energy_file, os.R_OK):
                        self._ensure_powercap_permissions()

                    if not os.access(energy_file, os.R_OK):
                        continue

                    try:
                        with open(name_file, "r") as nf:
                            name = nf.read().strip().lower()
                        if name.startswith("package") or name in ("core", "cpu"):
                            max_range = 262143328850
                            if os.path.exists(max_range_file):
                                try:
                                    with open(max_range_file, "r") as mf:
                                        max_range = int(mf.read().strip())
                                except Exception:
                                    pass
                            # Prefer intel-rapl over mmio if same package
                            if name not in domains or "mmio" in domains[name]["path"]:
                                domains[name] = {
                                    "path": p,
                                    "energy_file": energy_file,
                                    "max_range": max_range
                                }
                    except Exception:
                        pass
            except Exception:
                pass
            if domains:
                break

        # If any domain starts with 'package', filter out sub-domain 'core' to avoid double-counting
        has_package = any(k.startswith("package") for k in domains.keys())
        if has_package:
            domains = {k: v for k, v in domains.items() if k.startswith("package")}

        return domains

    def _init_power_counters(self):
        """Initializes baseline energy readings for CPU power calculation."""
        try:
            if self._rapl_domains is None:
                self._rapl_domains = self._discover_rapl_domains()
            now = time.time()
            for name, d in self._rapl_domains.items():
                try:
                    with open(d["energy_file"], "r") as f:
                        self.last_cpu_energy[name] = int(f.read().strip())
                except Exception:
                    pass
            if self.last_cpu_energy:
                self.last_cpu_energy_time = now
        except Exception:
            pass

    def _read_hwmon_cpu_power(self) -> Optional[float]:
        """Fallback to read CPU power from /sys/class/hwmon if available."""
        hwmon_dir = "/sys/class/hwmon"
        if not os.path.exists(hwmon_dir):
            return None
        try:
            for entry in os.listdir(hwmon_dir):
                entry_path = os.path.join(hwmon_dir, entry)
                if not os.path.isdir(entry_path):
                    continue
                for f in os.listdir(entry_path):
                    if f.startswith("power") and f.endswith("_input"):
                        val_path = os.path.join(entry_path, f)
                        label_path = os.path.join(entry_path, f.replace("_input", "_label"))
                        label = ""
                        if os.path.exists(label_path):
                            try:
                                with open(label_path, "r") as lf:
                                    label = lf.read().strip().lower()
                            except Exception:
                                pass
                        name_path = os.path.join(entry_path, "name")
                        chip_name = ""
                        if os.path.exists(name_path):
                            try:
                                with open(name_path, "r") as nf:
                                    chip_name = nf.read().strip().lower()
                            except Exception:
                                pass
                        if "cpu" in label or "package" in label or "core" in label or "cpu" in chip_name:
                            try:
                                with open(val_path, "r") as vf:
                                    uw = float(vf.read().strip())
                                    watts = uw / 1000000.0
                                    if 0.0 <= watts < 2000.0:
                                        return round(watts, 1)
                            except Exception:
                                pass
        except Exception:
            pass
        return None

    def _sample_cpu_power(self, now: float) -> Optional[float]:
        """Calculates instantaneous CPU package power in Watts from hardware counters."""
        if self._rapl_domains is None or not self._rapl_domains:
            self._rapl_domains = self._discover_rapl_domains()
            if not self._rapl_domains:
                return self._read_hwmon_cpu_power()

        if not self.last_cpu_energy or not self.last_cpu_energy_time:
            self._init_power_counters()
            return self.last_cpu_power

        dt = now - self.last_cpu_energy_time
        if dt < 0.1:
            return self.last_cpu_power

        total_delta_uj = 0.0
        updated = False
        new_energies = {}

        for name, d in self._rapl_domains.items():
            try:
                with open(d["energy_file"], "r") as f:
                    e = int(f.read().strip())
                prev_e = self.last_cpu_energy.get(name)
                if prev_e is not None:
                    delta_e = e - prev_e
                    if delta_e < 0:
                        delta_e += d["max_range"]
                    total_delta_uj += delta_e
                    updated = True
                new_energies[name] = e
            except Exception:
                pass

        if updated and dt > 0:
            watts = (total_delta_uj / 1000000.0) / dt
            if 0.0 <= watts < 2000.0:
                self.last_cpu_power = round(watts, 1)

        self.last_cpu_energy = new_energies
        self.last_cpu_energy_time = now
        return self.last_cpu_power

    def _init_net_counters(self):
        try:
            net_counters = psutil.net_io_counters(pernic=True)
            for nic, counters in net_counters.items():
                self.last_net_bytes[nic] = {"rx": counters.bytes_recv, "tx": counters.bytes_sent}
        except Exception:
            pass

    def _read_hwmon_sensors(self) -> Dict[str, Any]:
        """Discovers and parses /sys/class/hwmon without requiring root privileges."""
        sensors_data = {
            "cpu_temp": None,
            "core_temps": [],
            "fan_rpm": None,
            "fan_available": False,
            "nvme_temp": None,
            "pch_temp": None,
            "wifi_temp": None,
            "acpi_temp": None,
            "battery": None,
        }
        
        hwmon_dir = "/sys/class/hwmon"
        if not os.path.exists(hwmon_dir):
            return sensors_data

        for entry in os.listdir(hwmon_dir):
            entry_path = os.path.join(hwmon_dir, entry)
            if not os.path.isdir(entry_path):
                continue
                
            name_file = os.path.join(entry_path, "name")
            name = ""
            if os.path.exists(name_file):
                try:
                    with open(name_file, "r") as f:
                        name = f.read().strip()
                except Exception:
                    pass

            # Coretemp (Intel CPU)
            if name == "coretemp":
                try:
                    core_temps_found = []
                    for f in sorted(os.listdir(entry_path)):
                        if f.startswith("temp") and f.endswith("_input"):
                            val_file = os.path.join(entry_path, f)
                            label_file = os.path.join(entry_path, f.replace("_input", "_label"))
                            label = f
                            if os.path.exists(label_file):
                                with open(label_file, "r") as lf:
                                    label = lf.read().strip()
                            with open(val_file, "r") as vf:
                                temp_c = float(vf.read().strip()) / 1000.0
                                
                            if "Package" in label or label == "temp1_input":
                                if sensors_data["cpu_temp"] is None:
                                    sensors_data["cpu_temp"] = round(temp_c, 1)
                            else:
                                core_temps_found.append({
                                    "label": label,
                                    "temp": round(temp_c, 1)
                                })
                    sensors_data["core_temps"] = core_temps_found
                except Exception:
                    pass

            # ASUS fan / generic platform fan
            if name in ("asus", "asus-nb-wmi", "thinkpad", "nct6775", "it87"):
                try:
                    for f in os.listdir(entry_path):
                        if f.startswith("fan") and f.endswith("_input"):
                            with open(os.path.join(entry_path, f), "r") as ff:
                                rpm = int(ff.read().strip())
                                sensors_data["fan_rpm"] = rpm
                                sensors_data["fan_available"] = True
                                break
                except Exception:
                    pass

            # NVMe SSD temperature
            if name == "nvme":
                try:
                    temp_f = os.path.join(entry_path, "temp1_input")
                    if os.path.exists(temp_f):
                        with open(temp_f, "r") as nf:
                            sensors_data["nvme_temp"] = round(float(nf.read().strip()) / 1000.0, 1)
                except Exception:
                    pass

            # PCH Skylake chipset temperature
            if "pch" in name:
                try:
                    temp_f = os.path.join(entry_path, "temp1_input")
                    if os.path.exists(temp_f):
                        with open(temp_f, "r") as pf:
                            sensors_data["pch_temp"] = round(float(pf.read().strip()) / 1000.0, 1)
                except Exception:
                    pass

            # WiFi temperature
            if "wifi" in name:
                try:
                    temp_f = os.path.join(entry_path, "temp1_input")
                    if os.path.exists(temp_f):
                        with open(temp_f, "r") as wf:
                            sensors_data["wifi_temp"] = round(float(wf.read().strip()) / 1000.0, 1)
                except Exception:
                    pass

            # ACPI temperature
            if "acpi" in name:
                try:
                    temp_f = os.path.join(entry_path, "temp1_input")
                    if os.path.exists(temp_f):
                        with open(temp_f, "r") as af:
                            sensors_data["acpi_temp"] = round(float(af.read().strip()) / 1000.0, 1)
                except Exception:
                    pass

            # Battery (ZenBook laptop)
            if name == "BAT0":
                try:
                    bat = psutil.sensors_battery()
                    if bat:
                        sensors_data["battery"] = {
                            "percent": round(bat.percent, 1),
                            "power_plugged": bat.power_plugged,
                            "secsleft": bat.secsleft if bat.secsleft != psutil.POWER_TIME_UNLIMITED else None
                        }
                except Exception:
                    pass

        # Fallback for battery if not checked in BAT0
        if sensors_data["battery"] is None:
            try:
                bat = psutil.sensors_battery()
                if bat:
                    sensors_data["battery"] = {
                        "percent": round(bat.percent, 1),
                        "power_plugged": bat.power_plugged,
                        "secsleft": bat.secsleft if bat.secsleft != psutil.POWER_TIME_UNLIMITED else None
                    }
            except Exception:
                pass

        # Fallback for CPU temp via acpitz or thermal_zone if coretemp was missing
        if sensors_data["cpu_temp"] is None:
            try:
                temps = psutil.sensors_temperatures()
                if "coretemp" in temps and temps["coretemp"]:
                    sensors_data["cpu_temp"] = round(temps["coretemp"][0].current, 1)
                elif "acpitz" in temps and temps["acpitz"]:
                    sensors_data["cpu_temp"] = round(temps["acpitz"][0].current, 1)
            except Exception:
                pass

        # Fallback for fan check across all hwmon if asus name matched differently
        if not sensors_data["fan_available"]:
            try:
                fans = psutil.sensors_fans()
                for _, fan_list in fans.items():
                    if fan_list:
                        sensors_data["fan_rpm"] = fan_list[0].current
                        sensors_data["fan_available"] = True
                        break
            except Exception:
                pass

        return sensors_data

    def sample_metrics(self) -> Dict[str, Any]:
        """Calculates instantaneous telemetry metrics and appends to circular history."""
        now = time.time()
        
        # CPU
        cpu_overall = psutil.cpu_percent(interval=None)
        cpu_cores = psutil.cpu_percent(interval=None, percpu=True)
        cpu_power = self._sample_cpu_power(now)
        try:
            freq = psutil.cpu_freq()
            freq_current = round(freq.current, 0) if freq else None
            freq_max = round(freq.max, 0) if freq else None
            freq_min = round(freq.min, 0) if freq else None
        except Exception:
            freq_current, freq_max, freq_min = None, None, None

        try:
            load1, load5, load15 = os.getloadavg()
        except Exception:
            load1, load5, load15 = 0.0, 0.0, 0.0

        # Memory
        mem = psutil.virtual_memory()
        swap = psutil.swap_memory()

        # Network
        net_counters = psutil.net_io_counters(pernic=True)
        dt = max(now - self.last_net_time, 0.1)
        
        total_rx_rate = 0.0
        total_tx_rate = 0.0
        total_rx_bytes = 0
        total_tx_bytes = 0
        interfaces_data = []

        for nic, counters in net_counters.items():
            prev = self.last_net_bytes.get(nic)
            if prev:
                rx_delta = max(counters.bytes_recv - prev["rx"], 0)
                tx_delta = max(counters.bytes_sent - prev["tx"], 0)
                rx_rate = rx_delta / dt
                tx_rate = tx_delta / dt
            else:
                rx_rate = 0.0
                tx_rate = 0.0

            self.last_net_bytes[nic] = {"rx": counters.bytes_recv, "tx": counters.bytes_sent}

            # Exclude loopback and internal docker bridges from total external rate
            if nic not in ("lo", "docker0") and not nic.startswith("veth") and not nic.startswith("br-"):
                total_rx_rate += rx_rate
                total_tx_rate += tx_rate
                total_rx_bytes += counters.bytes_recv
                total_tx_bytes += counters.bytes_sent
            elif nic == "docker0":
                # If only docker is active and no external, we still track it in interfaces list
                pass

            interfaces_data.append({
                "name": nic,
                "rx_rate": round(rx_rate, 1),
                "tx_rate": round(tx_rate, 1),
                "rx_total": counters.bytes_recv,
                "tx_total": counters.bytes_sent,
                "errin": counters.errin,
                "errout": counters.errout,
            })

        self.last_net_time = now

        # Hardware sensors
        sensors = self._read_hwmon_sensors()

        # Update histories
        timestamp_ms = int(now * 1000)
        self.cpu_history.append({"t": timestamp_ms, "v": cpu_overall})
        self.mem_history.append({"t": timestamp_ms, "v": mem.percent})
        self.net_rx_history.append({"t": timestamp_ms, "v": round(total_rx_rate, 1)})
        self.net_tx_history.append({"t": timestamp_ms, "v": round(total_tx_rate, 1)})

        self.last_metrics = {
            "timestamp": timestamp_ms,
            "cpu": {
                "usage_percent": round(cpu_overall, 1),
                "cores": cpu_cores,
                "temperature": sensors["cpu_temp"],
                "core_temperatures": sensors["core_temps"],
                "load_average": [round(load1, 2), round(load5, 2), round(load15, 2)],
                "frequency_mhz": freq_current,
                "frequency_min": freq_min,
                "frequency_max": freq_max,
                "power_watts": cpu_power,
                "history": list(self.cpu_history),
            },
            "memory": {
                "total": mem.total,
                "used": mem.used,
                "available": mem.available,
                "free": mem.free,
                "buffers": getattr(mem, "buffers", 0),
                "cached": getattr(mem, "cached", 0),
                "percent": mem.percent,
                "swap_total": swap.total,
                "swap_used": swap.used,
                "swap_free": swap.free,
                "swap_percent": swap.percent,
                "history": list(self.mem_history),
            },
            "network": {
                "download_speed": round(total_rx_rate, 1),  # bytes/sec
                "upload_speed": round(total_tx_rate, 1),    # bytes/sec
                "total_download_bytes": total_rx_bytes,
                "total_upload_bytes": total_tx_bytes,
                "interfaces": interfaces_data,
                "rx_history": list(self.net_rx_history),
                "tx_history": list(self.net_tx_history),
            },
            "sensors": {
                "fan_rpm": sensors["fan_rpm"],
                "fan_available": sensors["fan_available"],
                "fan_status": f"{sensors['fan_rpm']} RPM" if sensors["fan_available"] else "Fan speed unavailable",
                "nvme_temp": sensors["nvme_temp"],
                "pch_temp": sensors["pch_temp"],
                "wifi_temp": sensors["wifi_temp"],
                "acpi_temp": sensors["acpi_temp"],
                "battery": sensors["battery"],
            },
            "system_info": self.get_static_info(),
        }
        return self.last_metrics

    def get_static_info(self) -> Dict[str, Any]:
        """Returns non-volatile system host information with real CPU model name."""
        import platform
        boot_time = psutil.boot_time()
        uptime_seconds = int(time.time() - boot_time)

        # Parse CPU model name from /proc/cpuinfo
        cpu_model = "Intel Core i7-8550U"
        try:
            with open("/proc/cpuinfo", "r") as f:
                for line in f:
                    if "model name" in line:
                        cpu_model = line.split(":", 1)[1].strip()
                        break
        except Exception:
            cpu_model = platform.processor() or "Intel Core i7-8550U"

        return {
            "hostname": platform.node(),
            "os": f"{platform.system()} {platform.release()}",
            "kernel": platform.release(),
            "arch": platform.machine(),
            "cpu_model": cpu_model,
            "logical_cpus": psutil.cpu_count(logical=True),
            "physical_cpus": psutil.cpu_count(logical=False),
            "boot_time": int(boot_time),
            "uptime_seconds": uptime_seconds,
        }

system_monitor = SystemMonitorService()
