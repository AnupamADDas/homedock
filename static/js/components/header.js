/**
 * Global Header Live Telemetry Component.
 */

import { formatBytes, formatSpeed } from "../utils/formatters.js";

export class HeaderComponent {
  constructor() {
    this.cpuValEl = document.getElementById("headerCpuVal");
    this.memValEl = document.getElementById("headerMemVal");
    this.netValEl = document.getElementById("headerNetVal");
  }

  update(metrics) {
    if (!metrics) return;

    // CPU
    if (this.cpuValEl && metrics.cpu) {
      const tempStr = metrics.cpu.temperature ? ` (${metrics.cpu.temperature}°C)` : "";
      this.cpuValEl.textContent = `${metrics.cpu.usage_percent}%${tempStr}`;
    }

    // RAM
    if (this.memValEl && metrics.memory) {
      const usedStr = formatBytes(metrics.memory.used, 1);
      const totalStr = formatBytes(metrics.memory.total, 0);
      this.memValEl.textContent = `${metrics.memory.percent}% (${usedStr} / ${totalStr})`;
    }

    // Network
    if (this.netValEl && metrics.network) {
      const downStr = formatSpeed(metrics.network.download_speed);
      const upStr = formatSpeed(metrics.network.upload_speed);
      this.netValEl.textContent = `↓ ${downStr}  ↑ ${upStr}`;
    }
  }
}

export const headerComponent = new HeaderComponent();
