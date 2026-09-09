/**
 * Download Manager Component for HomeDock.
 * AriaNg-inspired interface for managing HTTP, Torrent, and Magnet downloads
 * with per-download and global speed limit configurations.
 */

import { api, showToast } from "../api.js";
import { formatBytes, formatSpeed, formatTime } from "../utils/formatters.js";
import { folderBrowser } from "./folder_browser.js";
import { showConfirmDialog } from "./confirm_dialog.js";

export class DownloadManagerComponent {
  constructor() {
    this.currentFilter = "all";
    this.downloads = [];
    this.stats = null;
    this.defaultDir = "";
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    this.setupEventListeners();
    await this.fetchDefaultDir();
    await this.refresh();
    this.initialized = true;
  }

  async fetchDefaultDir() {
    try {
      const res = await api.getDefaultDownloadDir();
      this.defaultDir = res.default_dir || "";
      const destInput = document.getElementById("addDownloadDestInput");
      const helperEl = document.getElementById("addDownloadDestHelper");
      const globalDirInput = document.getElementById("globalDefaultDlDirInput");
      if (destInput) {
        destInput.placeholder = `Default: ${this.defaultDir || "/DATA/HDD/Downloads"}`;
      }
      if (helperEl && this.defaultDir) {
        helperEl.innerHTML = `Default download folder: <code style="font-size: 0.72rem;">${this.defaultDir}</code> (leave blank to use default, or Browse to customize)`;
      }
      if (globalDirInput && (!globalDirInput.value || !document.getElementById("globalLimitsModal")?.classList.contains("active"))) {
        globalDirInput.value = this.defaultDir;
      }
    } catch (e) {
      console.warn("Failed to get default download dir:", e);
    }
  }

  setupEventListeners() {
    // Listen for default download directory updates across components
    window.addEventListener("homedock:default_dir_changed", (e) => {
      if (e.detail?.dir) {
        this.defaultDir = e.detail.dir;
        this.fetchDefaultDir();
      }
    });

    // Add Download Button
    const addBtn = document.getElementById("openAddDownloadModalBtn");
    const modal = document.getElementById("addDownloadModal");
    const closeBtn = document.getElementById("closeAddDownloadModalBtn");

    if (addBtn && modal) {
      addBtn.addEventListener("click", async () => {
        await this.fetchDefaultDir();
        const destInput = document.getElementById("addDownloadDestInput");
        if (destInput) destInput.value = "";
        const saveDefCheckbox = document.getElementById("addDownloadSaveDefaultCheckbox");
        if (saveDefCheckbox) saveDefCheckbox.checked = false;
        modal.classList.add("active");
      });
    }

    if (closeBtn && modal) {
      closeBtn.addEventListener("click", () => modal.classList.remove("active"));
    }

    // Browse Destination Directory Button
    const browseDestBtn = document.getElementById("btnBrowseDownloadDest");
    if (browseDestBtn) {
      browseDestBtn.addEventListener("click", () => {
        const destInput = document.getElementById("addDownloadDestInput");
        folderBrowser.open({
          initialPath: destInput.value.trim() || this.defaultDir,
          title: "Choose Download Destination",
          onSelect: (path) => {
            if (destInput) destInput.value = path;
          }
        });
      });
    }

    // Add Download Form Submit
    const addForm = document.getElementById("addDownloadForm");
    if (addForm) {
      addForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const urlsText = document.getElementById("addDownloadUrls").value.trim();
        const dest = document.getElementById("addDownloadDestInput").value.trim() || null;
        const limitStr = document.getElementById("addDownloadLimitInput").value;
        const limit = limitStr ? parseInt(limitStr, 10) * 1024 : 0; // KB/s to B/s

        const torrentFile = document.getElementById("addTorrentFileInput").files[0];
        const saveAsDefault = document.getElementById("addDownloadSaveDefaultCheckbox")?.checked || false;

        try {
          if (torrentFile) {
            await api.addTorrentDownload(torrentFile, dest, limit, saveAsDefault);
            showToast("Torrent download added", "success");
          } else if (urlsText) {
            const uris = urlsText.split("\n").map(u => u.trim()).filter(Boolean);
            if (uris.length === 0) throw new Error("Please enter at least one URL");
            await api.addUriDownload(uris, dest, limit, null, saveAsDefault);
            showToast(`Added ${uris.length} download task(s)`, "success");
          } else {
            throw new Error("Provide download URLs or select a torrent file");
          }

          if (saveAsDefault && dest) {
            this.defaultDir = dest;
            window.dispatchEvent(new CustomEvent("homedock:default_dir_changed", { detail: { dir: dest } }));
          }

          modal.classList.remove("active");
          addForm.reset();
          const destInput = document.getElementById("addDownloadDestInput");
          if (destInput) destInput.value = "";
          const saveDefCheckbox = document.getElementById("addDownloadSaveDefaultCheckbox");
          if (saveDefCheckbox) saveDefCheckbox.checked = false;
          await this.fetchDefaultDir();
          await this.refresh();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    }

    // Filter tabs
    const tabs = document.querySelectorAll(".dl-filter-tab");
    tabs.forEach(tab => {
      tab.addEventListener("click", () => {
        tabs.forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        this.currentFilter = tab.dataset.filter;
        this.renderDownloads();
      });
    });

    // Global Limits & Settings Modal
    const globalLimitsBtn = document.getElementById("openGlobalLimitsModalBtn");
    const globalLimitsModal = document.getElementById("globalLimitsModal");
    const closeLimitsBtn = document.getElementById("closeGlobalLimitsModalBtn");
    const saveLimitsBtn = document.getElementById("saveGlobalLimitsBtn");

    if (globalLimitsBtn && globalLimitsModal) {
      globalLimitsBtn.addEventListener("click", async () => {
        try {
          const settings = await api.getSettings();
          const dlInput = document.getElementById("globalDownloadLimitInput");
          const ulInput = document.getElementById("globalUploadLimitInput");
          const defaultDirInput = document.getElementById("globalDefaultDlDirInput");
          if (dlInput) dlInput.value = Math.round(parseInt(settings.max_download_limit || "0", 10) / 1024);
          if (ulInput) ulInput.value = Math.round(parseInt(settings.max_upload_limit || "0", 10) / 1024);
          if (defaultDirInput) defaultDirInput.value = this.defaultDir || settings.default_download_dir || "";
          globalLimitsModal.classList.add("active");
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    }

    // Browse Global Default Download Dir Button
    const browseGlobalDirBtn = document.getElementById("btnBrowseGlobalDefaultDlDir");
    if (browseGlobalDirBtn) {
      browseGlobalDirBtn.addEventListener("click", () => {
        const dirInput = document.getElementById("globalDefaultDlDirInput");
        folderBrowser.open({
          initialPath: dirInput.value.trim() || this.defaultDir,
          title: "Choose Default Download Directory",
          onSelect: (path) => {
            if (dirInput) dirInput.value = path;
          }
        });
      });
    }

    if (closeLimitsBtn && globalLimitsModal) {
      closeLimitsBtn.addEventListener("click", () => globalLimitsModal.classList.remove("active"));
    }

    if (saveLimitsBtn && globalLimitsModal) {
      saveLimitsBtn.addEventListener("click", async () => {
        const dlVal = parseInt(document.getElementById("globalDownloadLimitInput").value || "0", 10) * 1024;
        const ulVal = parseInt(document.getElementById("globalUploadLimitInput").value || "0", 10) * 1024;
        const newDefaultDir = document.getElementById("globalDefaultDlDirInput")?.value?.trim();
        try {
          await api.setGlobalLimits(dlVal, ulVal);
          if (newDefaultDir && newDefaultDir !== this.defaultDir) {
            await api.setDefaultDownloadDir(newDefaultDir);
            this.defaultDir = newDefaultDir;
            window.dispatchEvent(new CustomEvent("homedock:default_dir_changed", { detail: { dir: newDefaultDir } }));
            await this.fetchDefaultDir();
          }
          showToast("Download settings applied", "success");
          globalLimitsModal.classList.remove("active");
          await this.refresh();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    }

    // Refresh button
    const refreshBtn = document.getElementById("refreshDownloadsBtn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => this.refresh());
    }
  }

  async refresh() {
    try {
      const [downloads, stats] = await Promise.all([
        api.listDownloads(),
        api.getDownloadStats(),
      ]);
      this.downloads = downloads || [];
      this.stats = stats;
      this.renderStats();
      this.renderDownloads();
    } catch (e) {
      console.warn("Error refreshing downloads:", e);
    }
  }

  updateLive(stats, downloads) {
    if (stats) {
      this.stats = stats;
      this.renderStats();
    }
    if (downloads && downloads.length > 0) {
      this.downloads = downloads;
      this.renderDownloads();
    }
  }

  renderStats() {
    if (!this.stats) return;
    const s = this.stats;

    const dlRateEl = document.getElementById("dlTotalSpeed");
    const ulRateEl = document.getElementById("ulTotalSpeed");
    const activeCountEl = document.getElementById("dlActiveCount");
    const waitingCountEl = document.getElementById("dlWaitingCount");

    if (dlRateEl) dlRateEl.textContent = formatSpeed(s.download_speed);
    if (ulRateEl) ulRateEl.textContent = formatSpeed(s.upload_speed);
    if (activeCountEl) activeCountEl.textContent = s.num_active;
    if (waitingCountEl) waitingCountEl.textContent = s.num_waiting + s.num_stopped;

    // Global speed limits display in stat cards and header badge
    const dlLimitSub = document.getElementById("dlGlobalLimitSub");
    const ulLimitSub = document.getElementById("ulGlobalLimitSub");
    const headerLimitPill = document.getElementById("dlGlobalLimitHeaderPill");

    const maxDl = s.max_download_limit || 0;
    const maxUl = s.max_upload_limit || 0;

    if (dlLimitSub) {
      if (maxDl > 0) {
        dlLimitSub.style.display = "inline";
        dlLimitSub.textContent = `Limit: ${formatSpeed(maxDl)}`;
      } else {
        dlLimitSub.style.display = "none";
      }
    }

    if (ulLimitSub) {
      if (maxUl > 0) {
        ulLimitSub.style.display = "inline";
        ulLimitSub.textContent = `Limit: ${formatSpeed(maxUl)}`;
      } else {
        ulLimitSub.style.display = "none";
      }
    }

    if (headerLimitPill) {
      if (maxDl > 0 || maxUl > 0) {
        const parts = [];
        if (maxDl > 0) parts.push(`↓ ${formatSpeed(maxDl)}`);
        if (maxUl > 0) parts.push(`↑ ${formatSpeed(maxUl)}`);
        headerLimitPill.style.display = "inline-flex";
        headerLimitPill.textContent = `⚡ Limit: ${parts.join(" | ")}`;
      } else {
        headerLimitPill.style.display = "none";
      }
    }
  }

  renderDownloads() {
    const listContainer = document.getElementById("downloadsList");
    if (!listContainer) return;

    let filtered = this.downloads;
    if (this.currentFilter === "active") {
      filtered = this.downloads.filter(d => d.status === "active");
    } else if (this.currentFilter === "waiting") {
      filtered = this.downloads.filter(d => d.status === "waiting" || d.status === "paused");
    } else if (this.currentFilter === "completed") {
      filtered = this.downloads.filter(d => d.status === "complete");
    } else if (this.currentFilter === "error") {
      filtered = this.downloads.filter(d => d.status === "error");
    }

    if (filtered.length === 0) {
      listContainer.innerHTML = `
        <div style="text-align: center; color: var(--text-muted); padding: 3rem; background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md);">
          No downloads in '${this.currentFilter}' category
        </div>
      `;
      return;
    }

    listContainer.innerHTML = filtered.map(item => {
      const isPaused = item.status === "paused";
      const isActive = item.status === "active";
      const isError = item.status === "error";
      const isComplete = item.status === "complete";
      const taskLimit = item.max_download_limit || 0;

      let statusBadge = `<span class="badge-tag" style="background: var(--bg-tertiary); color: var(--text-secondary);">${item.status}</span>`;
      if (isActive) {
        statusBadge = `<span class="badge-tag" style="background: var(--color-success-alpha); color: var(--color-success);">DOWNLOADING</span>`;
      } else if (isPaused) {
        statusBadge = `<span class="badge-tag" style="background: var(--color-warning-alpha); color: var(--color-warning);">PAUSED</span>`;
      } else if (isComplete) {
        statusBadge = `<span class="badge-tag" style="background: var(--accent-primary-alpha); color: var(--accent-primary);">COMPLETED</span>`;
      } else if (isError) {
        statusBadge = `<span class="badge-tag" style="background: var(--color-danger-alpha); color: var(--color-danger);">ERROR</span>`;
      }

      const limitBadge = taskLimit > 0
        ? `<span class="badge-tag" style="background: rgba(56, 189, 248, 0.15); color: var(--accent-primary); border: 1px solid rgba(56, 189, 248, 0.35); font-size: 0.72rem; display: inline-flex; align-items: center; gap: 0.25rem;" title="Speed limit: ${formatSpeed(taskLimit)}">
            <svg viewBox="0 0 24 24" width="11" height="11" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <span>Max: ${formatSpeed(taskLimit)}</span>
          </span>`
        : "";

      let fillClass = "";
      if (isPaused) fillClass = "paused";
      if (isError) fillClass = "error";

      return `
        <div class="download-item" data-gid="${item.gid}">
          <div class="download-item-header">
            <div style="flex: 1; overflow: hidden;">
              <div class="download-item-title" title="${item.name}">${item.name}</div>
              <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.2rem;">
                Destination: <code style="font-size: 0.72rem;">${item.dir || "--"}</code>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 0.4rem;">
              ${limitBadge}
              ${statusBadge}
            </div>
          </div>

          <div class="download-progress-bar">
            <div class="download-progress-fill ${fillClass}" style="width: ${item.percent}%;"></div>
          </div>

          <div class="download-item-meta">
            <div>
              <span>${formatBytes(item.completed_bytes)} / ${formatBytes(item.total_bytes)} (${item.percent}%)</span>
              ${isActive ? `<span style="margin-left: 0.75rem; color: var(--color-success);">↓ ${formatSpeed(item.download_speed)} ${taskLimit > 0 ? `<span style="color: var(--accent-primary); font-size: 0.75rem;">(capped at ${formatSpeed(taskLimit)})</span>` : ""}</span>` : ""}
              ${item.eta_seconds ? `<span style="margin-left: 0.75rem; color: var(--text-muted);">ETA: ${formatTime(item.eta_seconds)}</span>` : ""}
            </div>

            <div class="download-item-actions">
              ${isActive ? `
                <button class="btn btn-secondary btn-icon btn-sm btn-pause-dl" data-gid="${item.gid}" title="Pause">
                  <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                </button>
              ` : ""}
              ${isPaused ? `
                <button class="btn btn-secondary btn-icon btn-sm btn-unpause-dl" data-gid="${item.gid}" title="Resume">
                  <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                </button>
              ` : ""}
              ${isError ? `
                <button class="btn btn-secondary btn-icon btn-sm btn-retry-dl" data-gid="${item.gid}" title="Retry">
                  <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                </button>
              ` : ""}
              <button class="btn btn-secondary btn-icon btn-sm btn-limit-dl ${taskLimit > 0 ? 'active' : ''}" data-gid="${item.gid}" data-limit="${taskLimit}" title="Set Speed Limit (Current: ${taskLimit > 0 ? formatSpeed(taskLimit) : 'Unlimited'})">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              </button>
              ${(isActive || isPaused || item.status === "waiting") ? `
                <button class="btn btn-secondary btn-icon btn-sm btn-cancel-dl text-danger" data-gid="${item.gid}" data-name="${item.name}" title="Cancel Download">
                  <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              ` : `
                <button class="btn btn-secondary btn-icon btn-sm btn-delete-dl text-danger" data-gid="${item.gid}" data-name="${item.name}" title="Delete Task">
                  <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              `}
            </div>
          </div>

          ${isError && item.error_message ? `
            <div style="font-size: 0.78rem; color: var(--color-danger); background-color: var(--color-danger-alpha); padding: 0.4rem 0.6rem; border-radius: var(--radius-sm);">
              Error: ${item.error_message} (Code ${item.error_code})
            </div>
          ` : ""}
        </div>
      `;
    }).join("");

    // Hook listeners
    listContainer.querySelectorAll(".btn-pause-dl").forEach(btn => {
      btn.addEventListener("click", () => {
        api.pauseDownload(btn.dataset.gid).then(() => this.refresh());
      });
    });

    listContainer.querySelectorAll(".btn-unpause-dl").forEach(btn => {
      btn.addEventListener("click", () => {
        api.unpauseDownload(btn.dataset.gid).then(() => this.refresh());
      });
    });

    listContainer.querySelectorAll(".btn-retry-dl").forEach(btn => {
      btn.addEventListener("click", () => {
        api.retryDownload(btn.dataset.gid).then(() => this.refresh());
      });
    });

    listContainer.querySelectorAll(".btn-limit-dl").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.blur();
        const currentBytes = parseInt(btn.dataset.limit || "0", 10);
        const currentKb = Math.round(currentBytes / 1024);
        const val = prompt(
          `Set download rate limit for this task in KB/s (0 = unlimited):\nCurrent limit: ${currentKb > 0 ? `${currentKb} KB/s` : "Unlimited"}`,
          currentKb > 0 ? currentKb.toString() : "0"
        );
        if (val !== null) {
          const limitBytes = parseInt(val, 10) * 1024;
          api.setDownloadLimit(btn.dataset.gid, limitBytes)
            .then(() => {
              showToast(limitBytes > 0 ? `Speed limit set to ${formatSpeed(limitBytes)}` : "Speed limit removed (unlimited)", "success");
              this.refresh();
            })
            .catch(e => showToast(e.message, "error"));
        }
      });
    });

    listContainer.querySelectorAll(".btn-cancel-dl").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.blur();
        const name = btn.dataset.name || "download";
        const confirmed = await showConfirmDialog({
          title: "Cancel Download",
          message: `Are you sure you want to cancel and remove download "${name}"?`,
          confirmText: "Cancel Download",
          danger: true
        });
        if (!confirmed) return;

        try {
          await api.deleteDownload(btn.dataset.gid, true);
          showToast("Download cancelled", "success");
          await this.refresh();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    });

    listContainer.querySelectorAll(".btn-delete-dl").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.blur();
        const name = btn.dataset.name || "download task";
        const res = await showConfirmDialog({
          title: "Delete Download Task",
          message: `Are you sure you want to remove download task "${name}"?`,
          confirmText: "Remove Task",
          danger: true,
          checkbox: {
            id: "deleteDlFilesDisk",
            label: "Also delete downloaded files from disk",
            checked: false
          }
        });
        if (!res) return;

        const deleteFiles = Boolean(res.checkbox);
        try {
          await api.deleteDownload(btn.dataset.gid, deleteFiles);
          showToast("Download removed", "success");
          await this.refresh();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    });
  }
}

export const downloadManagerComponent = new DownloadManagerComponent();
