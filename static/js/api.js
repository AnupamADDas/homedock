/**
 * API Client & Network Service for HomeDock.
 */

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

  getFileDownloadUrl(path) {
    const tokenParam = this.token ? `&homedock_token=${encodeURIComponent(this.token)}` : "";
    return `/api/files/download?path=${encodeURIComponent(path)}${tokenParam}`;
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

export function showToast(message, type = "info", duration = 3500) {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span>${message}</span>
  `;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(100%)";
    setTimeout(() => toast.remove(), 250);
  }, duration);
}
