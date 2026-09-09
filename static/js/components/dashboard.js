/**
 * Dashboard Component for HomeDock.
 * Renders live server overview, hardware sensors, telemetry charts, and storage devices.
 */

import { formatBytes, formatSpeed, formatTime } from "../utils/formatters.js";
import { SparklineChart } from "../utils/charts.js";
import { api } from "../api.js";

export class DashboardComponent {
  constructor() {
    this.container = document.getElementById("dashboardView");
    this.cpuChart = null;
    this.memChart = null;
    this.netChart = null;
    this.initialized = false;
    this.maxObservedNetSpeed = 5 * 1024 * 1024; // 5 MB/s baseline dynamic scale
  }

  init() {
    if (this.initialized) return;

    const cpuCanvas = document.getElementById("cpuHistoryChart");
    const memCanvas = document.getElementById("memHistoryChart");
    const netCanvas = document.getElementById("netHistoryChart");

    if (cpuCanvas) {
      this.cpuChart = new SparklineChart(cpuCanvas, {
        color: "#38bdf8",
        fillColor: "rgba(56, 189, 248, 0.12)",
        maxVal: 100,
        autoScale: false,
      });
    }

    if (memCanvas) {
      this.memChart = new SparklineChart(memCanvas, {
        color: "#a855f7",
        fillColor: "rgba(168, 85, 247, 0.12)",
        maxVal: 100,
        autoScale: false,
      });
    }

    if (netCanvas) {
      this.netChart = new SparklineChart(netCanvas, {
        color: "#10b981", // RX Download
        fillColor: "rgba(16, 185, 129, 0.12)",
        secondaryColor: "#f59e0b", // TX Upload
        secondaryFillColor: "rgba(245, 158, 11, 0.12)",
        autoScale: true,
      });
    }

    this.initialized = true;
  }

  _getTempClass(temp) {
    if (temp == null) return "";
    if (temp < 60) return "temp-normal";
    if (temp < 80) return "temp-warm";
    return "temp-hot";
  }

  _updateThermalChip(chipElId, textElId, tempVal) {
    const chipEl = document.getElementById(chipElId);
    const textEl = document.getElementById(textElId);
    if (!textEl) return;

    if (tempVal != null && tempVal > 0) {
      textEl.textContent = `${tempVal}°C`;
      if (chipEl) {
        chipEl.className = `sensor-chip ${this._getTempClass(tempVal)}`;
      }
    } else {
      textEl.textContent = "N/A";
      if (chipEl) chipEl.className = "sensor-chip";
    }
  }

  updateMetrics(metrics) {
    if (!metrics) return;
    this.init();

    try {
      // 1. CPU Widget
      if (metrics.cpu) {
        const cpu = metrics.cpu;
        const cpuPctEl = document.getElementById("cpuPercentVal");
        const cpuBarEl = document.getElementById("cpuBarFill");
        const cpuTempEl = document.getElementById("cpuTempDetail");
        const cpuLoadEl = document.getElementById("cpuLoadDetail");
        const cpuFreqEl = document.getElementById("cpuFreqDetail");

        if (cpuPctEl) cpuPctEl.textContent = `${cpu.usage_percent}%`;
        if (cpuBarEl) cpuBarEl.style.width = `${cpu.usage_percent}%`;
        if (cpuTempEl) cpuTempEl.textContent = cpu.temperature ? `${cpu.temperature}°C` : "Unavailable";
        if (cpuLoadEl) cpuLoadEl.textContent = cpu.load_average ? cpu.load_average.join(", ") : "--";
        if (cpuFreqEl) cpuFreqEl.textContent = cpu.frequency_mhz ? `${cpu.frequency_mhz} MHz` : "--";

        // Per-core mini bars
        const coresContainer = document.getElementById("cpuCoresList");
        if (coresContainer && cpu.cores && cpu.cores.length > 0) {
          coresContainer.innerHTML = cpu.cores.map((val, idx) => `
            <div class="core-mini-item" title="Core ${idx}: ${val}%">
              <div class="core-mini-bar" style="height: ${Math.max(val, 6)}%"></div>
            </div>
          `).join("");
        }

        if (this.cpuChart && cpu.history) {
          this.cpuChart.draw(cpu.history);
        }
      }

      // 2. Memory Widget
      if (metrics.memory) {
        const mem = metrics.memory;
        const memPctEl = document.getElementById("memPercentVal");
        const memBarEl = document.getElementById("memBarFill");
        const memUsedEl = document.getElementById("memUsedDetail");
        const memAvailEl = document.getElementById("memAvailDetail");
        const memSwapEl = document.getElementById("memSwapDetail");

        if (memPctEl) memPctEl.textContent = `${mem.percent}%`;
        if (memBarEl) memBarEl.style.width = `${mem.percent}%`;
        if (memUsedEl) memUsedEl.textContent = `${formatBytes(mem.used)} / ${formatBytes(mem.total)}`;
        if (memAvailEl) memAvailEl.textContent = `${formatBytes(mem.available)} Avail`;
        
        if (memSwapEl) {
          const swapStr = mem.swap_total > 0 
            ? `${formatBytes(mem.swap_used)} / ${formatBytes(mem.swap_total)} (${mem.swap_percent}%)` 
            : "Disabled";
          memSwapEl.textContent = swapStr;
        }

        if (this.memChart && mem.history) {
          this.memChart.draw(mem.history);
        }
      }

      // 3. Network Widget & Dynamic Meters
      if (metrics.network) {
        const net = metrics.network;
        const dlEl = document.getElementById("netDownloadSpeed");
        const ulEl = document.getElementById("netUploadSpeed");
        const dlBarEl = document.getElementById("netDownloadBarFill");
        const ulBarEl = document.getElementById("netUploadBarFill");
        const totalRxEl = document.getElementById("netTotalRx");
        const totalTxEl = document.getElementById("netTotalTx");
        const totalSumEl = document.getElementById("netTotalSummary");

        if (dlEl) dlEl.textContent = formatSpeed(net.download_speed);
        if (ulEl) ulEl.textContent = formatSpeed(net.upload_speed);
        
        if (totalRxEl) totalRxEl.textContent = `Σ ${formatBytes(net.total_download_bytes || 0)}`;
        if (totalTxEl) totalTxEl.textContent = `Σ ${formatBytes(net.total_upload_bytes || 0)}`;
        if (totalSumEl) {
          totalSumEl.textContent = `Total: ↓ ${formatBytes(net.total_download_bytes || 0)}  ↑ ${formatBytes(net.total_upload_bytes || 0)}`;
        }

        // Dynamically adjust scale based on peak network throughput
        const currentPeak = Math.max(net.download_speed || 0, net.upload_speed || 0);
        if (currentPeak > this.maxObservedNetSpeed) {
          this.maxObservedNetSpeed = currentPeak * 1.25;
        }

        // Progress bar percentage (with 3% floor when active so user sees activity)
        if (dlBarEl) {
          const dlPct = (net.download_speed > 100) 
            ? Math.min(Math.max(Math.round((net.download_speed / this.maxObservedNetSpeed) * 100), 3), 100) 
            : 0;
          dlBarEl.style.width = `${dlPct}%`;
        }
        if (ulBarEl) {
          const ulPct = (net.upload_speed > 100) 
            ? Math.min(Math.max(Math.round((net.upload_speed / this.maxObservedNetSpeed) * 100), 3), 100) 
            : 0;
          ulBarEl.style.width = `${ulPct}%`;
        }

        // Interface status pills
        const ifaceContainer = document.getElementById("netInterfacesList");
        if (ifaceContainer && net.interfaces) {
          ifaceContainer.innerHTML = net.interfaces
            .filter(i => i.name !== "lo" && !i.name.startsWith("veth") && !i.name.startsWith("br-"))
            .map(i => `
              <div class="iface-pill" title="${i.name} • Total: In ${formatBytes(i.rx_total)} / Out ${formatBytes(i.tx_total)}">
                <span class="iface-name">${i.name}</span>
                <span class="iface-speeds">↓${formatSpeed(i.rx_rate)} ↑${formatSpeed(i.tx_rate)}</span>
              </div>
            `).join("");
        }

        if (this.netChart && net.rx_history && net.tx_history) {
          this.netChart.draw(net.rx_history, net.tx_history);
        }
      }

      // 4. Sensors & Hardware Host Identity
      if (metrics.sensors) {
        const s = metrics.sensors;
        
        // Fan Status & Icon
        const fanTextEl = document.getElementById("fanRpmText");
        const fanIconEl = document.getElementById("fanIconSvg");
        const fanBadgeEl = document.getElementById("fanStatusVal");

        if (fanTextEl) {
          if (s.fan_available && s.fan_rpm != null) {
            fanTextEl.textContent = `${s.fan_rpm} RPM`;
            if (fanIconEl) fanIconEl.classList.toggle("idle", s.fan_rpm === 0);
            if (fanBadgeEl) {
              fanBadgeEl.style.background = "var(--color-info-alpha, rgba(99,102,241,0.15))";
              fanBadgeEl.style.color = "var(--color-info)";
            }
          } else {
            fanTextEl.textContent = s.fan_status || "Unavailable";
            if (fanIconEl) fanIconEl.classList.add("idle");
          }
        }

        // Thermals
        this._updateThermalChip("sensorChipNvme", "nvmeTempDetail", s.nvme_temp);
        this._updateThermalChip("sensorChipPch", "pchTempDetail", s.pch_temp);
        this._updateThermalChip("sensorChipWifi", "wifiTempDetail", s.wifi_temp);
        this._updateThermalChip("sensorChipAcpi", "acpiTempDetail", s.acpi_temp);

        // Battery / Power
        const batEl = document.getElementById("batteryDetail");
        if (batEl) {
          if (s.battery) {
            const plugStr = s.battery.power_plugged ? " (AC Charging)" : " (On Battery)";
            batEl.textContent = `${s.battery.percent}%${plugStr}`;
          } else {
            batEl.textContent = "AC Power Connected";
          }
        }
      }

      // Per-Core CPU Temperatures
      if (metrics.cpu && metrics.cpu.core_temperatures) {
        const coreTempsContainer = document.getElementById("sensorCoreTemps");
        if (coreTempsContainer && metrics.cpu.core_temperatures.length > 0) {
          coreTempsContainer.innerHTML = metrics.cpu.core_temperatures.map(c => `
            <span class="sensor-chip ${this._getTempClass(c.temp)}">
              ${c.label}: <strong>${c.temp}°C</strong>
            </span>
          `).join("");
        }
      }

      // System Host Info
      if (metrics.system_info) {
        const sys = metrics.system_info;
        const hostEl = document.getElementById("hostNameDetail");
        const cpuModelEl = document.getElementById("sensorCpuModel");
        const hostKernelEl = document.getElementById("sensorHostKernel");
        const uptimeEl = document.getElementById("uptimeDetail");

        if (hostEl) hostEl.textContent = `${sys.hostname} (${sys.os})`;
        if (cpuModelEl) cpuModelEl.textContent = sys.cpu_model || "Intel Core i7-8550U";
        if (hostKernelEl) hostKernelEl.textContent = `${sys.hostname} • ${sys.os}`;
        if (uptimeEl) uptimeEl.textContent = formatTime(sys.uptime_seconds);
      }
    } catch (err) {
      console.error("HomeDock dashboard update error:", err);
    }
  }

  updateStorage(devices) {
    const container = document.getElementById("storageDevicesList");
    if (!container) return;

    if (!devices || devices.length === 0) {
      container.innerHTML = `<div class="empty-state">No storage devices detected.</div>`;
      return;
    }

    container.innerHTML = devices.map(dev => {
      const isUsb = dev.transport === "usb";
      const badgeClass = isUsb ? "badge-usb" : "badge-nvme";
      const transportLabel = isUsb ? "USB External" : (dev.transport === "nvme" ? "NVMe" : "Internal");

      const devReadActive = dev.read_speed && dev.read_speed > 1024;
      const devWriteActive = dev.write_speed && dev.write_speed > 1024;

      const partitionsHtml = (dev.partitions || []).map(p => {
        const usedStr = formatBytes(p.used_bytes);
        const totalStr = formatBytes(p.total_bytes);
        const freeStr = formatBytes(p.free_bytes);
        const isMounted = p.mounted && p.mountpoint;
        
        const partReadActive = p.read_speed && p.read_speed > 1024;
        const partWriteActive = p.write_speed && p.write_speed > 1024;

        return `
          <div class="partition-item">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem;">
              <div>
                <strong>${p.name}</strong>
                ${isMounted ? `<span style="color: var(--accent-primary); font-family: var(--font-mono); font-size: 0.8rem; margin-left: 0.5rem;">${p.mountpoint}</span>` : '<span style="color: var(--text-muted); font-size: 0.78rem; margin-left: 0.5rem;">(Unmounted)</span>'}
              </div>
              <div style="font-size: 0.75rem; font-family: var(--font-mono); color: var(--text-muted);">
                ${p.fstype || "raw"}
              </div>
            </div>

            ${isMounted ? `
              <div class="progress-bar-bg" style="height: 6px;">
                <div class="progress-bar-fill" style="width: ${p.usage_percent}%; background-color: ${p.usage_percent > 90 ? 'var(--color-danger)' : (p.usage_percent > 75 ? 'var(--color-warning)' : 'var(--accent-primary)')};"></div>
              </div>
              <div style="display: flex; justify-content: space-between; font-size: 0.78rem; color: var(--text-secondary); font-family: var(--font-mono);">
                <span>${usedStr} / ${totalStr} (${p.usage_percent}%)</span>
                <span>Free: ${freeStr}</span>
              </div>
              <div style="display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--text-muted); font-family: var(--font-mono); margin-top: 0.35rem; border-top: 1px dashed var(--border-color); padding-top: 0.25rem;">
                <span class="io-badge ${partReadActive ? 'active-read' : ''}">Read: ${formatSpeed(p.read_speed || 0)}</span>
                <span class="io-badge ${partWriteActive ? 'active-write' : ''}">Write: ${formatSpeed(p.write_speed || 0)}</span>
              </div>
            ` : `
              <div style="font-size: 0.8rem; color: var(--text-muted);">Capacity: ${totalStr}</div>
            `}
          </div>
        `;
      }).join("");

      return `
        <div class="storage-card">
          <div class="storage-card-header">
            <div>
              <div class="storage-drive-title">${dev.model}</div>
              <div class="storage-drive-meta">${dev.device} • ${dev.type}</div>
            </div>
            <div style="display: flex; gap: 0.4rem; align-items: center;">
              <span class="badge-tag ${badgeClass}">${transportLabel}</span>
            </div>
          </div>

          <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.78rem; color: var(--text-muted); margin-bottom: 0.75rem; flex-wrap: wrap; gap: 0.5rem;">
            <span>Serial: ${dev.serial}</span>
            <div style="display: flex; gap: 0.5rem; align-items: center;">
              ${dev.temperature ? `<span>Temp: <strong>${dev.temperature}°C</strong></span>` : ""}
              <span class="io-badge ${devReadActive ? 'active-read' : ''}">R: ${formatSpeed(dev.read_speed || 0)}</span>
              <span class="io-badge ${devWriteActive ? 'active-write' : ''}">W: ${formatSpeed(dev.write_speed || 0)}</span>
            </div>
          </div>

          <div class="partitions-wrapper">
            ${partitionsHtml}
          </div>
        </div>
      `;
    }).join("");
  }
}

export const dashboardComponent = new DashboardComponent();
