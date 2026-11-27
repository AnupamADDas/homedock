/**
 * Lightweight server health alerts.
 * Evaluates live telemetry against fixed thresholds and surfaces a badge on the
 * Desktop dock icon (plus a one-time toast when something newly crosses a threshold).
 */

import { showToast } from "../api.js";

const THRESHOLDS = {
  cpuTemp: { warn: 80, critical: 90 },   // degrees C
  memory: { warn: 90, critical: 97 },    // percent used
  disk: { warn: 90, critical: 97 },      // percent used per partition
};

const known = new Map(); // alert id -> severity, so toasts only fire on new/worse alerts

function severityFor(value, limits) {
  if (value >= limits.critical) return "critical";
  if (value >= limits.warn) return "warn";
  return null;
}

export function evaluateAlerts({ metrics, storage }) {
  const alerts = [];

  const temp = metrics?.cpu?.temperature;
  if (typeof temp === "number" && temp > 0) {
    const sev = severityFor(temp, THRESHOLDS.cpuTemp);
    if (sev) alerts.push({ id: "cpu-temp", severity: sev, text: `CPU temperature is ${temp}°C` });
  }

  const mem = metrics?.memory?.percent;
  if (typeof mem === "number") {
    const sev = severityFor(mem, THRESHOLDS.memory);
    if (sev) alerts.push({ id: "memory", severity: sev, text: `Memory usage is ${mem}%` });
  }

  if (Array.isArray(storage)) {
    for (const device of storage) {
      for (const part of device.partitions || []) {
        const used = part.usage_percent;
        if (typeof used !== "number") continue;
        // Read-only images (snaps, live media, system images) are always "100% full" by design.
        const fstype = String(part.fstype || "").toLowerCase();
        const mount = String(part.mountpoint || "");
        if (["squashfs", "erofs", "iso9660", "udf", "cramfs"].includes(fstype)
            || mount.startsWith("/snap") || mount.startsWith("/var/lib/snapd")) continue;
        const sev = severityFor(used, THRESHOLDS.disk);
        if (sev) {
          const label = part.mountpoint || part.name || device.name;
          alerts.push({ id: `disk:${label}`, severity: sev, text: `${label} is ${used}% full` });
        }
      }
    }
  }
  return alerts;
}

let lastStorage = null;

/** Call with each telemetry payload; storage may be omitted when unchanged. */
export function updateAlertBadge(payload) {
  if (payload.storage) lastStorage = payload.storage;
  const alerts = evaluateAlerts({ metrics: payload.metrics, storage: lastStorage });

  const dock = document.querySelector('.dock-item[data-app="dashboard"]');
  const badge = document.getElementById("dockAlertBadge");
  if (badge) {
    if (alerts.length) {
      const critical = alerts.some(a => a.severity === "critical");
      badge.textContent = String(alerts.length);
      badge.style.display = "inline-flex";
      badge.classList.toggle("dock-badge-critical", critical);
      badge.classList.toggle("dock-badge-alert", !critical);
      badge.title = alerts.map(a => a.text).join("\n");
      badge.setAttribute("aria-label", `${alerts.length} server alert${alerts.length > 1 ? "s" : ""}: ${alerts.map(a => a.text).join("; ")}`);
    } else {
      badge.style.display = "none";
    }
  }
  if (dock) dock.title = alerts.length ? `Desktop & Metrics — ${alerts.map(a => a.text).join("; ")}` : "Desktop & Metrics";

  const current = new Set(alerts.map(a => a.id));
  for (const alert of alerts) {
    const previous = known.get(alert.id);
    if (previous !== alert.severity && (previous === undefined || alert.severity === "critical")) {
      showToast(alert.text, alert.severity === "critical" ? "error" : "info", alert.severity === "critical" ? 10000 : 5000);
    }
    known.set(alert.id, alert.severity);
  }
  for (const id of [...known.keys()]) if (!current.has(id)) known.delete(id);
}
