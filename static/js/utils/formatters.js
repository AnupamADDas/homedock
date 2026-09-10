/**
 * Formatting helpers for HomeDock.
 */

export function formatBytes(bytes, decimals = 1) {
  if (bytes === 0 || bytes === null || bytes === undefined) return "0 B";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  if (i < 0) return bytes + " B";
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

export function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return "0 B/s";
  return formatBytes(bytesPerSec, 1) + "/s";
}

export function formatTime(seconds) {
  if (!seconds || seconds <= 0) return "--";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatDate(isoStr) {
  if (!isoStr) return "--";
  try {
    const d = new Date(isoStr);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch (e) {
    return isoStr;
  }
}

export function parseSpeedLimitStr(str) {
  if (!str) return 0;
  const s = String(str).trim().toUpperCase();
  if (s === "0" || s === "UNLIMITED" || s === "") return 0;
  if (s.endsWith("G") || s.endsWith("GB") || s.endsWith("G/S") || s.endsWith("GB/S")) {
    return Math.round(parseFloat(s) * 1024 * 1024 * 1024);
  }
  if (s.endsWith("M") || s.endsWith("MB") || s.endsWith("M/S") || s.endsWith("MB/S")) {
    return Math.round(parseFloat(s) * 1024 * 1024);
  }
  if (s.endsWith("K") || s.endsWith("KB") || s.endsWith("K/S") || s.endsWith("KB/S")) {
    return Math.round(parseFloat(s) * 1024);
  }
  const num = parseFloat(s);
  return isNaN(num) ? 0 : Math.round(num);
}

export function formatSpeedLimitStr(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return null;
  const mb = bytesPerSec / (1024 * 1024);
  if (mb >= 1) {
    const rounded = Number.isInteger(mb) ? mb : mb.toFixed(1);
    return `${rounded} MB/s`;
  }
  const kb = Math.round(bytesPerSec / 1024);
  return `${kb} KB/s`;
}
