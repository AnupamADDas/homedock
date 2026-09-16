/**
 * Download Manager Component for HomeDock.
 * AriaNg-inspired interface for managing HTTP, Torrent, and Magnet downloads
 * with per-download and global speed limit configurations.
 */

import { api, showToast } from "../api.js";
import { formatBytes, formatSpeed, formatTime, parseSpeedLimitStr, formatSpeedLimitStr } from "../utils/formatters.js";
import { folderBrowser } from "./folder_browser.js";
import { showConfirmDialog } from "./confirm_dialog.js";

function getFileIcon(name = "", isTorrent = false) {
  if (isTorrent) {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><path d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`;
  }
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm"].includes(ext)) {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2"><path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>`;
  }
  if (["zip", "rar", "7z", "tar", "gz", "bz2", "xz"].includes(ext)) {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/></svg>`;
  }
  if (["mp3", "flac", "wav", "aac", "ogg", "m4a"].includes(ext)) {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ec4899" stroke-width="2"><path d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"/></svg>`;
  }
  if (["iso", "img", "exe", "bin", "dmg", "apk", "deb", "AppImage"].includes(ext)) {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#06b6d4" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/></svg>`;
  }
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`;
}

export class DownloadManagerComponent {
  constructor() {
    this.currentFilter = "all";
    this.downloads = [];
    this.stats = null;
    this.defaultDir = "";
    this.initialized = false;
    this.ytMediaMode = "video";
    this.ytProbing = false;
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
      const ytDestInput = document.getElementById("inputYtDest");
      const helperEl = document.getElementById("addDownloadDestHelper");
      const globalDirInput = document.getElementById("globalDefaultDlDirInput");
      if (destInput) {
        destInput.placeholder = `Default: ${this.defaultDir || "/DATA/HDD/Downloads"}`;
      }
      if (ytDestInput) {
        ytDestInput.placeholder = `Default: ${this.defaultDir || "/DATA/HDD/Downloads"}`;
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

        // Reset YouTube form & preview
        const ytForm = document.getElementById("youtubeDownloadForm");
        if (ytForm) ytForm.reset();
        const ytPreview = document.getElementById("ytPreviewCard");
        if (ytPreview) ytPreview.style.display = "none";
        const ytStatus = document.getElementById("ytProbeStatus");
        if (ytStatus) ytStatus.textContent = "";
        const ytDest = document.getElementById("inputYtDest");
        if (ytDest) ytDest.value = "";
        const ytSaveDef = document.getElementById("checkYtSaveDefault");
        if (ytSaveDef) ytSaveDef.checked = false;

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

    // Global Limits & Settings Modal (PulseDL Style)
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
          const dlBytes = parseInt(settings.max_download_limit || "0", 10);
          const ulBytes = parseInt(settings.max_upload_limit || "0", 10);
          if (dlInput) dlInput.value = dlBytes > 0 ? (formatSpeedLimitStr(dlBytes) || "0") : "0";
          if (ulInput) ulInput.value = ulBytes > 0 ? (formatSpeedLimitStr(ulBytes) || "0") : "0";
          if (defaultDirInput) defaultDirInput.value = this.defaultDir || settings.default_download_dir || "";
          globalLimitsModal.classList.add("active");
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    }

    // Global speed presets click
    document.querySelectorAll(".global-speed-preset-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const preset = btn.dataset.preset;
        const input = document.getElementById("globalDownloadLimitInput");
        if (input) input.value = preset === "0" ? "0" : preset;
      });
    });

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
        const dlVal = parseSpeedLimitStr(document.getElementById("globalDownloadLimitInput").value);
        const ulVal = parseSpeedLimitStr(document.getElementById("globalUploadLimitInput").value);
        const newDefaultDir = document.getElementById("globalDefaultDlDirInput")?.value?.trim();
        try {
          await api.setGlobalLimits(dlVal, ulVal);
          if (newDefaultDir && newDefaultDir !== this.defaultDir) {
            await api.setDefaultDownloadDir(newDefaultDir);
            this.defaultDir = newDefaultDir;
            window.dispatchEvent(new CustomEvent("homedock:default_dir_changed", { detail: { dir: newDefaultDir } }));
            await this.fetchDefaultDir();
          }
          showToast("Speed limits & download settings applied", "success");
          globalLimitsModal.classList.remove("active");
          await this.refresh();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    }

    // Single Task Speed Limit Modal (PulseDL Style)
    const taskSpeedModal = document.getElementById("taskSpeedModal");
    const closeTaskSpeedBtn = document.getElementById("closeTaskSpeedModalBtn");
    const taskSpeedSaveBtn = document.getElementById("btnTaskSpeedSave");
    const taskSpeedClearBtn = document.getElementById("btnTaskSpeedClear");

    if (closeTaskSpeedBtn && taskSpeedModal) {
      closeTaskSpeedBtn.addEventListener("click", () => taskSpeedModal.classList.remove("active"));
    }

    document.querySelectorAll(".speed-preset-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const preset = btn.dataset.preset;
        const input = document.getElementById("inputTaskDlLimit");
        if (input) input.value = preset === "0" ? "0" : preset;
      });
    });

    if (taskSpeedClearBtn && taskSpeedModal) {
      taskSpeedClearBtn.addEventListener("click", async () => {
        const gid = document.getElementById("taskSpeedGid").value;
        if (!gid) return;
        try {
          await api.setDownloadLimit(gid, 0);
          showToast("Speed limit cleared (unlimited)", "success");
          taskSpeedModal.classList.remove("active");
          await this.refresh();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    }

    if (taskSpeedSaveBtn && taskSpeedModal) {
      taskSpeedSaveBtn.addEventListener("click", async () => {
        const gid = document.getElementById("taskSpeedGid").value;
        const valStr = document.getElementById("inputTaskDlLimit").value.trim();
        const limitBytes = parseSpeedLimitStr(valStr);
        if (!gid) return;
        try {
          await api.setDownloadLimit(gid, limitBytes);
          showToast(limitBytes > 0 ? `Speed limit set to ${formatSpeedLimitStr(limitBytes)}` : "Speed limit removed (unlimited)", "success");
          taskSpeedModal.classList.remove("active");
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

    // Initialize YouTube & Media downloader controls
    this.setupYoutubeDownloader();
  }

  setupYoutubeDownloader() {
    // Mode tabs: Direct/Torrent vs YouTube
    const tabDirect = document.getElementById("btnTabDirectDl");
    const tabYt = document.getElementById("btnTabYoutubeDl");
    const paneDirect = document.getElementById("paneDirectDl");
    const paneYt = document.getElementById("paneYoutubeDl");

    const switchTab = (mode) => {
      if (mode === "yt") {
        tabYt?.classList.add("active");
        tabDirect?.classList.remove("active");
        if (paneYt) paneYt.style.display = "block";
        if (paneDirect) paneDirect.style.display = "none";
        const ytDest = document.getElementById("inputYtDest");
        if (ytDest && !ytDest.value) {
          ytDest.placeholder = `Default: ${this.defaultDir || "/DATA/HDD/Downloads"}`;
        }
      } else {
        tabDirect?.classList.add("active");
        tabYt?.classList.remove("active");
        if (paneDirect) paneDirect.style.display = "block";
        if (paneYt) paneYt.style.display = "none";
      }
    };

    tabDirect?.addEventListener("click", () => switchTab("direct"));
    tabYt?.addEventListener("click", () => switchTab("yt"));

    // Media mode buttons: Video vs Audio
    const btnVideo = document.getElementById("btnYtModeVideo");
    const btnAudio = document.getElementById("btnYtModeAudio");
    const videoControls = document.getElementById("ytVideoControls");
    const audioControls = document.getElementById("ytAudioControls");
    const subWrap = document.getElementById("ytSubtitlesWrap");

    const setMediaMode = (mode) => {
      this.ytMediaMode = mode;
      if (mode === "audio") {
        btnAudio?.classList.add("active");
        btnVideo?.classList.remove("active");
        if (videoControls) videoControls.style.display = "none";
        if (audioControls) audioControls.style.display = "grid";
        if (subWrap) subWrap.style.display = "none";
      } else {
        btnVideo?.classList.add("active");
        btnAudio?.classList.remove("active");
        if (videoControls) videoControls.style.display = "grid";
        if (audioControls) audioControls.style.display = "none";
        if (subWrap) subWrap.style.display = "flex";
      }
    };

    btnVideo?.addEventListener("click", () => setMediaMode("video"));
    btnAudio?.addEventListener("click", () => setMediaMode("audio"));

    // Browse Destination button for YouTube
    const btnBrowseYt = document.getElementById("btnBrowseYtDest");
    if (btnBrowseYt) {
      btnBrowseYt.addEventListener("click", () => {
        const destInput = document.getElementById("inputYtDest");
        folderBrowser.open({
          initialPath: destInput?.value?.trim() || this.defaultDir,
          title: "Choose YouTube Download Destination",
          onSelect: (path) => {
            if (destInput) destInput.value = path;
          }
        });
      });
    }

    // URL Probe Logic
    const inputUrl = document.getElementById("inputYtUrl");
    const btnProbe = document.getElementById("btnProbeYt");
    const probeStatus = document.getElementById("ytProbeStatus");
    const previewCard = document.getElementById("ytPreviewCard");
    const previewThumb = document.getElementById("ytPreviewThumb");
    const previewTime = document.getElementById("ytPreviewDuration");
    const previewTitle = document.getElementById("ytPreviewTitle");
    const previewChannel = document.getElementById("ytPreviewChannel");
    const previewTags = document.getElementById("ytPreviewTags");
    const playlistWrap = document.getElementById("ytPlaylistWrap");
    const selectRes = document.getElementById("selectYtResolution");

    let probeTimer = null;

    const doProbe = async () => {
      const url = inputUrl?.value?.trim();
      if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
        return;
      }
      if (this.ytProbing) return;
      this.ytProbing = true;

      if (probeStatus) probeStatus.textContent = "Analyzing media...";
      if (btnProbe) {
        btnProbe.disabled = true;
      }

      try {
        const info = await api.probeYoutube(url);
        if (previewCard) previewCard.style.display = "flex";
        if (previewThumb) previewThumb.src = info.thumbnail || "";
        if (previewTitle) previewTitle.textContent = info.title || "Untitled Media";
        if (previewChannel) {
          previewChannel.textContent = info.uploader || (info.is_playlist ? "YouTube Playlist" : "YouTube");
        }
        if (previewTime) {
          previewTime.textContent = info.duration ? formatTime(info.duration) : (info.is_playlist ? `${info.playlist_count || 0} items` : "--");
        }

        // Tags
        if (previewTags) {
          const tags = [];
          if (info.is_playlist) {
            tags.push(`<span class="badge-tag-quality" style="background: rgba(239, 68, 68, 0.2); color: #ef4444;">Playlist (${info.playlist_count || '?'} videos)</span>`);
          }
          if (info.resolutions && info.resolutions.length > 0) {
            tags.push(`<span class="badge-tag-quality">Max ${info.resolutions[0]}p</span>`);
          }
          previewTags.innerHTML = tags.join(" ");
        }

        // Playlist range wrap
        if (playlistWrap) {
          playlistWrap.style.display = info.is_playlist ? "block" : "none";
        }

        // Dynamically populate available resolutions if present
        if (selectRes && info.resolutions && info.resolutions.length > 0) {
          const standardRes = [
            { val: "best", label: "Best Available (Max)" },
            { val: "2160", label: "4K Ultra HD (2160p)" },
            { val: "1440", label: "2K Quad HD (1440p)" },
            { val: "1080", label: "Full HD (1080p)" },
            { val: "720", label: "HD (720p)" },
            { val: "480", label: "Standard (480p)" },
            { val: "360", label: "Low (360p)" },
          ];
          const availableSet = new Set(info.resolutions.map(r => String(r)));
          const currentVal = selectRes.value || "best";
          selectRes.innerHTML = standardRes
            .filter(r => r.val === "best" || availableSet.has(r.val))
            .map(r => `<option value="${r.val}" ${r.val === currentVal ? "selected" : ""}>${r.label}</option>`)
            .join("");
          if (!selectRes.value) selectRes.value = "best";
        }

        if (probeStatus) probeStatus.textContent = "✓ Ready to download";
      } catch (err) {
        if (probeStatus) probeStatus.textContent = "Analysis failed";
        console.warn("Probe YouTube failed:", err);
      } finally {
        this.ytProbing = false;
        if (btnProbe) {
          btnProbe.disabled = false;
        }
      }
    };

    btnProbe?.addEventListener("click", doProbe);

    inputUrl?.addEventListener("input", () => {
      clearTimeout(probeTimer);
      const url = inputUrl.value.trim();
      if (url && (url.includes("youtube.com") || url.includes("youtu.be"))) {
        probeTimer = setTimeout(doProbe, 700);
      }
    });

    inputUrl?.addEventListener("paste", () => {
      setTimeout(doProbe, 150);
    });

    // YouTube Download Form Submit
    const ytForm = document.getElementById("youtubeDownloadForm");
    if (ytForm) {
      ytForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const url = inputUrl?.value?.trim();
        if (!url) {
          showToast("Please enter a YouTube video or playlist URL", "error");
          return;
        }

        const mediaType = this.ytMediaMode || "video";
        const isAudio = mediaType === "audio";

        const resSelect = document.getElementById("selectYtResolution");
        const vfmtSelect = document.getElementById("selectYtVideoFormat");
        const afmtSelect = document.getElementById("selectYtAudioFormat");
        const aqualSelect = document.getElementById("selectYtAudioQuality");

        const embedThumb = document.getElementById("checkYtEmbedThumb")?.checked ?? true;
        const embedMeta = document.getElementById("checkYtEmbedMeta")?.checked ?? true;
        const embedSubs = (!isAudio) && (document.getElementById("checkYtEmbedSubs")?.checked ?? false);
        const playlistItems = document.getElementById("inputYtPlaylistItems")?.value?.trim() || null;
        const destDir = document.getElementById("inputYtDest")?.value?.trim() || null;
        const saveDefault = document.getElementById("checkYtSaveDefault")?.checked || false;

        const payload = {
          url: url,
          media_type: mediaType,
          resolution: isAudio ? null : (resSelect?.value || "best"),
          video_format: isAudio ? null : (vfmtSelect?.value || "mp4"),
          audio_format: isAudio ? (afmtSelect?.value || "mp3") : null,
          audio_quality: isAudio ? (aqualSelect?.value || "best") : null,
          embed_thumbnail: embedThumb,
          embed_metadata: embedMeta,
          embed_subtitles: embedSubs,
          playlist_items: playlistItems,
          destination_dir: destDir,
          save_as_default: saveDefault
        };

        const submitBtn = document.getElementById("btnStartYtDownload");
        if (submitBtn) submitBtn.disabled = true;

        try {
          const res = await api.addYoutubeDownload(payload);
          showToast(`YouTube download queued: ${res.title || 'Media'}`, "success");

          if (saveDefault && destDir) {
            this.defaultDir = destDir;
            window.dispatchEvent(new CustomEvent("homedock:default_dir_changed", { detail: { dir: destDir } }));
          }

          document.getElementById("addDownloadModal")?.classList.remove("active");
          ytForm.reset();
          if (previewCard) previewCard.style.display = "none";
          if (probeStatus) probeStatus.textContent = "";
          if (playlistWrap) playlistWrap.style.display = "none";
          await this.fetchDefaultDir();
          await this.refresh();
        } catch (err) {
          showToast(err.message || "Failed to start YouTube download", "error");
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      });
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

    // Global speed limits display in stat cards and header badge (PulseDL Style)
    const dlLimitSub = document.getElementById("dlGlobalLimitSub");
    const ulLimitSub = document.getElementById("ulGlobalLimitSub");
    const headerLimitPill = document.getElementById("dlGlobalLimitHeaderPill");
    const headerLimitBtnLabel = document.getElementById("btnSpeedLimitLabel");

    const maxDl = s.max_download_limit || 0;
    const maxUl = s.max_upload_limit || 0;

    if (dlLimitSub) {
      if (maxDl > 0) {
        dlLimitSub.style.display = "inline";
        dlLimitSub.textContent = `⚡ Limit: ${formatSpeedLimitStr(maxDl)}`;
        dlLimitSub.style.color = "#f59e0b";
      } else {
        dlLimitSub.style.display = "none";
      }
    }

    if (ulLimitSub) {
      if (maxUl > 0) {
        ulLimitSub.style.display = "inline";
        ulLimitSub.textContent = `⚡ Limit: ${formatSpeedLimitStr(maxUl)}`;
        ulLimitSub.style.color = "#f59e0b";
      } else {
        ulLimitSub.style.display = "none";
      }
    }

    if (headerLimitPill) {
      if (maxDl > 0 || maxUl > 0) {
        const parts = [];
        if (maxDl > 0) parts.push(`⬇ ${formatSpeedLimitStr(maxDl)}`);
        if (maxUl > 0) parts.push(`⬆ ${formatSpeedLimitStr(maxUl)}`);
        headerLimitPill.style.display = "inline-flex";
        headerLimitPill.textContent = `⚡ Limit: ${parts.join(" | ")}`;
      } else {
        headerLimitPill.style.display = "none";
      }
    }

    if (headerLimitBtnLabel) {
      if (maxDl > 0) {
        headerLimitBtnLabel.textContent = `Limit: ${formatSpeedLimitStr(maxDl)}`;
      } else {
        headerLimitBtnLabel.textContent = "Speed Limits";
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
      const isWaiting = item.status === "waiting";
      const taskLimit = item.max_download_limit || 0;

      let statusBadge = `<span class="badge-tag" style="background: var(--bg-tertiary); color: var(--text-secondary);">${item.status}</span>`;
      if (isActive) {
        statusBadge = `<span class="badge-dl-active"><span class="download-pulse-dot"></span>Active</span>`;
      } else if (isPaused) {
        statusBadge = `<span class="badge-dl-paused">Paused</span>`;
      } else if (isComplete) {
        statusBadge = `<span class="badge-dl-complete">✓ Complete</span>`;
      } else if (isWaiting) {
        statusBadge = `<span class="badge-dl-waiting">Waiting</span>`;
      } else if (isError) {
        statusBadge = `<span class="badge-dl-error">Error</span>`;
      }

      const limitFormatted = formatSpeedLimitStr(taskLimit);
      const limitBadge = limitFormatted
        ? `<span class="download-badge-speed-limit" title="Speed limit active: ${limitFormatted}">
            <svg viewBox="0 0 24 24" width="12" height="12" stroke="#f59e0b" stroke-width="2.2" fill="none"><path d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
            <span>Limit: ${limitFormatted}</span>
          </span>`
        : "";

      const isYt = Boolean(item.is_youtube);

      let fillClass = "";
      if (isActive) fillClass = isYt ? "active youtube" : "active";
      else if (isPaused) fillClass = "paused";
      else if (isComplete) fillClass = "complete";
      else if (isError) fillClass = "error";

      let iconOrThumbHtml = "";
      if (isYt && item.thumbnail_url) {
        iconOrThumbHtml = `
          <div class="download-item-thumb-box">
            <img src="${item.thumbnail_url}" alt="thumbnail" loading="lazy" onerror="this.style.display='none'">
          </div>
        `;
      } else if (isYt) {
        iconOrThumbHtml = `
          <div class="download-item-icon-box" style="background: rgba(239, 68, 68, 0.12); border-color: rgba(239, 68, 68, 0.3);">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="#ef4444"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
          </div>
        `;
      } else {
        iconOrThumbHtml = `
          <div class="download-item-icon-box">
            ${getFileIcon(item.name, item.is_bittorrent)}
          </div>
        `;
      }

      let ytBadges = "";
      if (isYt) {
        const qText = item.media_type === "audio"
          ? `${(item.format_id || 'MP3').toUpperCase()} • ${item.quality || '320k'}`
          : `${item.quality ? (item.quality + 'p') : 'Auto'} ${(item.format_id || 'MP4').toUpperCase()}`;
        ytBadges = `
          <span class="badge-tag-yt">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
            <span>YouTube</span>
          </span>
          <span class="badge-tag-quality">${qText}</span>
        `;
      }

      let speedOrStatusHtml = "";
      if (isActive) {
        speedOrStatusHtml = `
          ${item.download_speed > 0 ? `<span style="color: #10b981; font-weight: 600;">⬇ ${formatSpeed(item.download_speed)}</span>` : '<span style="color: var(--text-muted);">⬇ 0 B/s</span>'}
          ${item.upload_speed > 0 ? `<span style="color: #60a5fa;">⬆ ${formatSpeed(item.upload_speed)}</span>` : ''}
          <span style="color: var(--text-muted);">ETA: ${item.eta_seconds ? formatTime(item.eta_seconds) : "--"}</span>
        `;
      } else if (isPaused) {
        speedOrStatusHtml = `<span style="color: #fbbf24; font-weight: 600;">⏸ Paused</span> <span style="color: var(--text-muted); margin-left: 0.4rem;">ETA: --</span>`;
      } else if (isComplete) {
        speedOrStatusHtml = `<span style="color: #10b981; font-weight: 600;">✓ Complete</span>`;
      } else if (isWaiting) {
        speedOrStatusHtml = `<span style="color: #60a5fa; font-weight: 600;">Waiting</span>`;
      } else if (isError) {
        speedOrStatusHtml = `<span style="color: #f43f5e; font-weight: 600;">Failed</span>`;
      }

      let actionsHtml = "";
      if (isYt) {
        if (isActive || isWaiting) {
          actionsHtml = `
            <button class="btn btn-secondary btn-icon btn-sm btn-cancel-dl text-danger" data-gid="${item.gid}" data-name="${item.name}" title="Cancel Download">
              <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          `;
        } else {
          actionsHtml = `
            <button class="btn btn-secondary btn-icon btn-sm btn-delete-dl text-danger" data-gid="${item.gid}" data-name="${item.name}" title="Delete Task">
              <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          `;
        }
      } else {
        actionsHtml = `
          ${isActive ? `
            <button class="btn btn-secondary btn-icon btn-sm btn-pause-dl" data-gid="${item.gid}" title="Pause">
              <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            </button>
          ` : ""}
          ${isPaused ? `
            <button class="btn btn-secondary btn-icon btn-sm btn-unpause-dl" data-gid="${item.gid}" title="Resume">
              <svg viewBox="0 0 24 24" width="14" height="14" stroke="#10b981" stroke-width="2" fill="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </button>
          ` : ""}
          ${isError ? `
            <button class="btn btn-secondary btn-icon btn-sm btn-retry-dl" data-gid="${item.gid}" title="Retry">
              <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            </button>
          ` : ""}
          <button class="btn btn-secondary btn-icon btn-sm btn-limit-dl ${taskLimit > 0 ? 'active' : ''}" data-gid="${item.gid}" data-limit="${taskLimit}" title="${limitFormatted ? `Speed Limit: ${limitFormatted} (Click to change)` : 'Set Speed Limit for this task'}">
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="#f59e0b" stroke-width="2.2" fill="none"><path d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
          </button>
          ${(isActive || isPaused || isWaiting) ? `
            <button class="btn btn-secondary btn-icon btn-sm btn-cancel-dl text-danger" data-gid="${item.gid}" data-name="${item.name}" title="Cancel Download">
              <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          ` : `
            <button class="btn btn-secondary btn-icon btn-sm btn-delete-dl text-danger" data-gid="${item.gid}" data-name="${item.name}" title="Delete Task">
              <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          `}
        `;
      }

      return `
        <div class="download-item" data-gid="${item.gid}">
          <div class="download-item-header">
            <!-- Icon and Main Titles (PulseDL Style) -->
            <div class="download-item-main">
              ${iconOrThumbHtml}
              <div class="download-item-titles">
                <div class="download-item-title-row">
                  <h4 class="download-item-title" title="${item.name}">${item.name}</h4>
                  ${ytBadges}
                  ${statusBadge}
                  ${limitBadge}
                </div>
                <div class="download-item-subtitle">
                  <span class="download-item-path btn-copy-path" data-path="${item.dir || ''}" title="Click to copy path: ${item.dir || ''}">
                    📁 ${item.dir || '--'}
                  </span>
                  ${item.channel ? `<span style="color: var(--text-secondary); font-weight: 500;">• 👤 ${item.channel}</span>` : ''}
                  ${item.connections > 0 ? `<span>• 🔗 ${item.connections} conns</span>` : (isPaused ? '<span style="color: #fbbf24;">• ⏸ Paused</span>' : '')}
                  ${item.num_seeders > 0 ? `<span>• ⬆ ${item.num_seeders} seeds</span>` : ''}
                  ${limitFormatted ? `<span style="color: #fbbf24; font-weight: 500;">• ⚡ Max ${limitFormatted}</span>` : ''}
                </div>
              </div>
            </div>

            <!-- Action Controls (PulseDL Style) -->
            <div class="download-item-actions">
              ${actionsHtml}
            </div>
          </div>

          <!-- Progress Bar (PulseDL Style) -->
          <div class="download-progress-bar">
            <div class="download-progress-fill ${fillClass}" style="width: ${item.percent}%;"></div>
          </div>

          <!-- Footer Metadata -->
          <div class="download-item-meta">
            <div class="download-meta-left">
              <span class="download-percent-val">${item.percent}%</span>
              <span>(${formatBytes(item.completed_bytes)} / ${formatBytes(item.total_bytes)})</span>
            </div>
            <div class="download-meta-right">
              ${speedOrStatusHtml}
              ${(isActive && limitFormatted) ? `<span style="color: #f59e0b; font-size: 0.73rem; font-weight: 500;">(capped at ${limitFormatted})</span>` : ""}
            </div>
          </div>

          ${isError && item.error_message ? `
            <div class="download-error-callout">
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
        const gid = btn.dataset.gid;
        const currentBytes = parseInt(btn.dataset.limit || "0", 10);
        const taskSpeedModal = document.getElementById("taskSpeedModal");
        const gidInput = document.getElementById("taskSpeedGid");
        const bannerVal = document.getElementById("taskSpeedCurrentVal");
        const inputVal = document.getElementById("inputTaskDlLimit");

        if (gidInput) gidInput.value = gid;
        if (bannerVal) {
          const disp = formatSpeedLimitStr(currentBytes);
          bannerVal.textContent = disp || "⚡ Unlimited";
          bannerVal.style.color = disp ? "#f59e0b" : "#10b981";
        }
        if (inputVal) {
          inputVal.value = currentBytes > 0 ? (formatSpeedLimitStr(currentBytes) || "0") : "0";
        }
        if (taskSpeedModal) taskSpeedModal.classList.add("active");
      });
    });

    listContainer.querySelectorAll(".btn-copy-path").forEach(span => {
      span.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const p = span.dataset.path;
        if (p) {
          navigator.clipboard.writeText(p).then(() => {
            showToast(`Copied path: ${p}`, "info", 2000);
          }).catch(() => {});
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
