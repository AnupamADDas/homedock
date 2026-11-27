/**
 * API Client & Network Service for HomeDock.
 */

import { animateElement } from "./utils/motion.js";

class ApiService {
  constructor() {
    this.token = localStorage.getItem("homedock_token") || null;
    this.currentUser = null;
  }

  setToken(token) {
    this.token = token;
    if (token) {
      localStorage.setItem("homedock_token", token);
    } else {
      localStorage.removeItem("homedock_token");
    }
  }

  async request(endpoint, options = {}) {
    const headers = options.headers || {};
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    if (!(options.body instanceof FormData) && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    const config = {
      ...options,
      headers,
    };

    try {
      const response = await fetch(endpoint, config);

      if (response.status === 401) {
        // Token expired or invalid
        this.setToken(null);
        window.dispatchEvent(new CustomEvent("homedock:auth_required"));
        throw new Error("Session expired. Please log in again.");
      }

      if (response.status === 429) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.detail || "Rate limit reached. Please try again later.");
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const message = errorData.detail || errorData.message || `Request failed with status ${response.status}`;
        throw new Error(message);
      }

      // Check if response has content
      const contentType = response.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        return await response.json();
      }
      return await response.text();
    } catch (err) {
      console.error(`API Error [${endpoint}]:`, err);
      throw err;
    }
  }

  // Auth
  async login(username, password) {
    const data = await this.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    this.setToken(data.access_token);
    this.currentUser = data.user;
    return data;
  }

  async logout() {
    try {
      await this.request("/api/auth/logout", { method: "POST" });
    } catch (e) {
      // Ignore
    }
    this.setToken(null);
    this.currentUser = null;
  }

  async getMe() {
    const user = await this.request("/api/auth/me");
    this.currentUser = user;
    return user;
  }

  async changePassword(oldPassword, newPassword) {
    return await this.request("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
    });
  }

  async changeUsername(newUsername, currentPassword) {
    const data = await this.request("/api/auth/change-username", {
      method: "POST",
      body: JSON.stringify({ new_username: newUsername, current_password: currentPassword }),
    });
    if (data.access_token) {
      this.setToken(data.access_token);
    }
    if (data.user) {
      this.currentUser = data.user;
    }
    return data;
  }

  // System & Storage
  async getMetrics() {
    return await this.request("/api/system/metrics");
  }

  async getSystemInfo() {
    return await this.request("/api/system/info");
  }

  async getStorageDevices() {
    return await this.request("/api/storage/devices");
  }

  async getMountedLocations() {
    return await this.request("/api/storage/mounted");
  }

  async refreshStorage() {
    return await this.request("/api/storage/refresh", { method: "POST" });
  }

  // Files
  async listFiles(path = null, showHidden = false) {
    const params = new URLSearchParams();
    if (path) params.append("path", path);
    if (showHidden) params.append("show_hidden", "true");
    return await this.request(`/api/files/list?${params.toString()}`);
  }

  async getFileInfo(path) {
    return await this.request(`/api/files/info?path=${encodeURIComponent(path)}`);
  }

  getFilePreviewUrl(path) {
    return `${this.getFileDownloadUrl(path)}&inline=true`;
  }

  getFileDownloadUrl(path) {
    const tokenParam = this.token ? `&homedock_token=${encodeURIComponent(this.token)}` : "";
    return `/api/files/download?path=${encodeURIComponent(path)}${tokenParam}`;
  }

  /**
   * Upload a file as a series of small raw-body requests so reverse proxies and
   * tunnels (body-size limits, idle timeouts) cannot cut it off. Each chunk is
   * retried on network errors, stalls and 5xx responses; a 413 from a proxy makes
   * the chunks smaller automatically.
   *
   * @param {File} file
   * @param {string} destination
   * @param {Object} [opts]
   * @param {(percent:number, loaded:number, total:number) => void} [opts.onProgress]
   * @param {(controller:{abort:() => void}) => void} [opts.onStart] receives a cancel handle
   * @param {(message:string) => void} [opts.onStatus] retry / slow-connection notices
   */
  uploadFileChunked(file, destination, { onProgress, onStart, onStatus } = {}) {
    const MIN_CHUNK = 256 * 1024;
    const MAX_RETRIES = 6;
    const STALL_MS = 25000;
    const uploadId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");
    const total = file.size;
    let chunkSize = Math.min(this.uploadChunkSize || 4 * 1024 * 1024, 8 * 1024 * 1024);
    let cancelled = false;
    let currentXhr = null;

    const base = (offset) => `/api/files/upload/chunk?${new URLSearchParams({
      destination, filename: file.name, upload_id: uploadId, offset: String(offset), total: String(total),
    })}`;

    const controller = {
      abort: () => {
        if (cancelled) return;
        cancelled = true;
        currentXhr?.abort();
        // Remove the partial file on the server (best effort).
        fetch(`/api/files/upload/chunk?${new URLSearchParams({ destination, upload_id: uploadId })}`, {
          method: "DELETE",
          headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
        }).catch(() => {});
      },
    };
    onStart?.(controller);

    const sendChunk = (offset, blob) => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      currentXhr = xhr;
      let stalled = false;
      let watchdog = null;
      const arm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => { stalled = true; xhr.abort(); }, STALL_MS);
      };
      xhr.open("PUT", base(offset));
      if (this.token) xhr.setRequestHeader("Authorization", `Bearer ${this.token}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.addEventListener("progress", (e) => {
        arm();
        onProgress?.(((offset + e.loaded) / (total || 1)) * 100, offset + e.loaded, total);
      });
      xhr.onload = () => {
        clearTimeout(watchdog);
        let body = null;
        try { body = JSON.parse(xhr.responseText); } catch { /* non-JSON (e.g. proxy error page) */ }
        resolve({ status: xhr.status, body });
      };
      xhr.onerror = () => { clearTimeout(watchdog); reject(Object.assign(new Error("Network error"), { retryable: true })); };
      xhr.onabort = () => {
        clearTimeout(watchdog);
        reject(stalled
          ? Object.assign(new Error("Connection stalled"), { retryable: true })
          : Object.assign(new Error("Upload cancelled"), { cancelled: true }));
      };
      arm();
      xhr.send(blob);
    });

    return (async () => {
      let offset = 0;
      let retries = 0;
      // Zero-byte files still need one (empty) request to be created.
      while (!cancelled && (offset < total || (total === 0 && offset === 0))) {
        const end = Math.min(offset + chunkSize, total);
        let result;
        try {
          result = await sendChunk(offset, file.slice(offset, end));
        } catch (err) {
          if (cancelled || err.cancelled) throw new Error("Upload cancelled");
          if (++retries > MAX_RETRIES) throw new Error(`${err.message} — gave up after ${MAX_RETRIES} retries. Check your connection or proxy.`);
          onStatus?.(`${err.message}, retrying (${retries}/${MAX_RETRIES})…`);
          await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** (retries - 1), 15000)));
          continue;
        }

        const { status, body } = result;
        const detail = body?.detail;
        if (status >= 200 && status < 300) {
          retries = 0;
          this.uploadChunkSize = chunkSize; // remember what this connection accepts
          offset = body?.received ?? end;
          onProgress?.((offset / (total || 1)) * 100, offset, total);
          if (body?.complete) return body;
          if (total === 0) return body;
          continue;
        }
        if (status === 401) {
          this.setToken(null);
          window.dispatchEvent(new CustomEvent("homedock:auth_required"));
          throw new Error("Session expired. Please log in again.");
        }
        if (status === 413) {
          if (chunkSize <= MIN_CHUNK) throw new Error("The proxy in front of HomeDock rejects even small uploads (413). Raise its request size limit.");
          chunkSize = Math.max(MIN_CHUNK, Math.floor(chunkSize / 2));
          onStatus?.(`Proxy limit hit, using ${Math.round(chunkSize / 1024)} KB chunks…`);
          continue;
        }
        if (status === 409 && typeof detail?.received === "number") {
          offset = detail.received; // resync with what the server actually has
          continue;
        }
        if (status >= 500 || status === 0 || status === 408 || status === 429) {
          if (++retries > MAX_RETRIES) throw new Error(`Server error (${status}) — gave up after ${MAX_RETRIES} retries.`);
          onStatus?.(`Server error (${status}), retrying (${retries}/${MAX_RETRIES})…`);
          await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** (retries - 1), 15000)));
          continue;
        }
        const message = typeof detail === "string" ? detail : detail?.message;
        throw new Error(message || `Upload failed (HTTP ${status})`);
      }
      throw new Error("Upload cancelled");
    })();
  }

  async uploadFile(file, destination, onProgress = null, onStart = null) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      if (onStart) onStart(xhr);
      xhr.open("POST", "/api/files/upload");

      if (this.token) {
        xhr.setRequestHeader("Authorization", `Bearer ${this.token}`);
      }

      if (onProgress && xhr.upload) {
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) {
            const percent = (e.loaded / e.total) * 100;
            onProgress(percent, e.loaded, e.total);
          }
        });
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (e) {
            resolve(xhr.responseText);
          }
        } else {
          try {
            const err = JSON.parse(xhr.responseText);
            reject(new Error(err.detail || "Upload failed"));
          } catch (e) {
            reject(new Error(`Upload failed: ${xhr.statusText}`));
          }
        }
      };

      xhr.onabort = () => reject(new Error("Upload cancelled"));
      xhr.onerror = () => reject(new Error("Network error during upload"));

      const formData = new FormData();
      formData.append("destination", destination);
      formData.append("file", file);
      xhr.send(formData);
    });
  }

  async createFolder(path) {
    return await this.request("/api/files/mkdir", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
  }

  async renameItem(source, newName) {
    return await this.request("/api/files/rename", {
      method: "POST",
      body: JSON.stringify({ source, new_name: newName }),
    });
  }

  async deleteItems(paths) {
    return await this.request("/api/files/delete", {
      method: "POST",
      body: JSON.stringify({ paths }),
    });
  }

  async copyItems(sources, destination, taskId = null) {
    return await this.request("/api/files/copy", {
      method: "POST",
      body: JSON.stringify({ sources, destination, task_id: taskId }),
    });
  }

  async moveItems(sources, destination, taskId = null) {
    return await this.request("/api/files/move", {
      method: "POST",
      body: JSON.stringify({ sources, destination, task_id: taskId }),
    });
  }

  async extractArchive(archivePath, destination = null, taskId = null) {
    return await this.request("/api/files/extract", {
      method: "POST",
      body: JSON.stringify({ archive_path: archivePath, destination, task_id: taskId }),
    });
  }

  async getTask(taskId) {
    return await this.request(`/api/files/tasks/${encodeURIComponent(taskId)}`);
  }

  async cancelTask(taskId) {
    return await this.request(`/api/files/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: "POST",
    });
  }

  async browseFolders(path = null) {
    const url = path ? `/api/files/browse-folders?path=${encodeURIComponent(path)}` : "/api/files/browse-folders";
    return await this.request(url);
  }

  // Downloads
  async listDownloads() {
    return await this.request("/api/downloads/list");
  }

  async getDownloadStats() {
    return await this.request("/api/downloads/stats");
  }

  async getDefaultDownloadDir() {
    return await this.request("/api/downloads/default-dir");
  }

  async setDefaultDownloadDir(defaultDir) {
    return await this.request("/api/downloads/default-dir", {
      method: "PUT",
      body: JSON.stringify({ default_dir: defaultDir }),
    });
  }

  async addUriDownload(uris, destination = null, maxDownloadLimit = 0, filename = null, saveAsDefault = false) {
    return await this.request("/api/downloads/add", {
      method: "POST",
      body: JSON.stringify({
        uris,
        destination,
        max_download_limit: maxDownloadLimit,
        filename,
        save_as_default: saveAsDefault,
      }),
    });
  }

  async addTorrentDownload(file, destination = null, maxDownloadLimit = 0, saveAsDefault = false) {
    const formData = new FormData();
    formData.append("file", file);
    if (destination) formData.append("destination", destination);
    if (maxDownloadLimit) formData.append("max_download_limit", maxDownloadLimit);
    if (saveAsDefault) formData.append("save_as_default", "true");
    return await this.request("/api/downloads/add-torrent", {
      method: "POST",
      body: formData,
    });
  }

  async probeYoutube(url) {
    return await this.request("/api/downloads/youtube/probe", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
  }

  async addYoutubeDownload(payload) {
    return await this.request("/api/downloads/youtube/add", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async pauseDownload(gid) {
    return await this.request(`/api/downloads/${gid}/pause`, { method: "POST" });
  }

  async unpauseDownload(gid) {
    return await this.request(`/api/downloads/${gid}/unpause`, { method: "POST" });
  }

  async removeDownload(gid) {
    return await this.request(`/api/downloads/${gid}/remove`, { method: "POST" });
  }

  async retryDownload(gid) {
    return await this.request(`/api/downloads/${gid}/retry`, { method: "POST" });
  }

  async deleteDownload(gid, deleteFiles = false) {
    return await this.request(`/api/downloads/${gid}/delete`, {
      method: "POST",
      body: JSON.stringify({ delete_files: deleteFiles }),
    });
  }

  async setDownloadLimit(gid, limitBytes) {
    return await this.request(`/api/downloads/${gid}/limit`, {
      method: "POST",
      body: JSON.stringify({ limit_bytes_sec: limitBytes }),
    });
  }

  async setGlobalLimits(downloadLimit, uploadLimit) {
    return await this.request("/api/downloads/global-limits", {
      method: "POST",
      body: JSON.stringify({ download_limit: downloadLimit, upload_limit: uploadLimit }),
    });
  }

  // Settings & Users
  async getSettings() {
    return await this.request("/api/settings");
  }

  async updateSettings(settings) {
    return await this.request("/api/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
  }

  async addAllowedRoot(path) {
    return await this.request("/api/settings/allowed-roots", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
  }

  async removeAllowedRoot(path) {
    return await this.request(`/api/settings/allowed-roots?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    });
  }

  async listUsers() {
    return await this.request("/api/users");
  }

  async createUser(userData) {
    return await this.request("/api/users", {
      method: "POST",
      body: JSON.stringify(userData),
    });
  }

  async updateUser(userId, userData) {
    return await this.request(`/api/users/${userId}`, {
      method: "PUT",
      body: JSON.stringify(userData),
    });
  }

  async deleteUser(userId) {
    return await this.request(`/api/users/${userId}`, { method: "DELETE" });
  }
}

export const api = new ApiService();

function dismissToast(toast) {
  if (!toast.isConnected || toast._dismissing) return;
  toast._dismissing = true;
  animateElement(toast, [
    { opacity: 1, transform: "none" },
    { opacity: 0, transform: "translateX(20px)" },
  ], { duration: 160 }).then(() => toast.remove());
}

/**
 * Show a toast. Errors stay longer (and can be dismissed), every toast pauses its
 * timer while hovered/focused, and an optional action button (e.g. Undo) is supported.
 * Returns { el, update(message, type), dismiss() } so long operations can reuse one toast.
 */
export function showToast(message, type = "info", duration, options = {}) {
  const container = document.getElementById("toastContainer");
  if (!container) return null;
  if (duration === undefined || duration === null) duration = type === "error" ? 8000 : 3500;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  const label = document.createElement("span");
  label.className = "toast-message";
  label.textContent = message;
  toast.appendChild(label);

  if (options.action) {
    const actionBtn = document.createElement("button");
    actionBtn.type = "button";
    actionBtn.className = "toast-action";
    actionBtn.textContent = options.action.label;
    actionBtn.addEventListener("click", () => {
      dismissToast(toast);
      options.action.onClick?.();
    });
    toast.appendChild(actionBtn);
  }

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "toast-close";
  closeBtn.setAttribute("aria-label", "Dismiss notification");
  closeBtn.textContent = "\u00d7";
  closeBtn.addEventListener("click", () => {
    clearTimeout(toast._timer);
    dismissToast(toast);
    options.onDismiss?.();
  });
  toast.appendChild(closeBtn);

  let remaining = duration;
  let startedAt = 0;
  const arm = () => {
    clearTimeout(toast._timer);
    if (!(remaining > 0) || !Number.isFinite(remaining)) return;
    startedAt = Date.now();
    toast._timer = setTimeout(() => { dismissToast(toast); options.onTimeout?.(); }, remaining);
  };
  const pause = () => {
    if (!toast._timer) return;
    clearTimeout(toast._timer);
    remaining -= Date.now() - startedAt;
  };
  toast.addEventListener("mouseenter", pause);
  toast.addEventListener("focusin", pause);
  toast.addEventListener("mouseleave", arm);
  toast.addEventListener("focusout", arm);

  container.appendChild(toast);
  animateElement(toast, [
    { opacity: 0, transform: "translateY(12px) scale(0.97)" },
    { opacity: 1, transform: "none" },
  ]);
  arm();

  return {
    el: toast,
    update(nextMessage, nextType = type, nextDuration = 3500) {
      label.textContent = nextMessage;
      toast.className = `toast toast-${nextType}`;
      toast.setAttribute("role", nextType === "error" ? "alert" : "status");
      remaining = nextType === "error" ? Math.max(nextDuration, 8000) : nextDuration;
      arm();
    },
    dismiss() { clearTimeout(toast._timer); dismissToast(toast); },
  };
}
