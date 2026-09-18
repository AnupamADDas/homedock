/**
 * File Manager Component for HomeDock.
 * Provides file browsing, breadcrumb navigation, mounted storage chips,
 * drag-and-drop uploads, safe archive extraction, and bulk file operations.
 */

import { api, showToast } from "../api.js";
import { formatBytes, formatDate, formatSpeed, formatTime } from "../utils/formatters.js";
import { folderBrowser } from "./folder_browser.js";
import { showConfirmDialog } from "./confirm_dialog.js";

export class FileManagerComponent {
  constructor() {
    this.currentPath = null;
    this.allowedRoots = [];
    this.history = [];
    this.historyIndex = -1;
    this.selectedItems = new Set();
    this.showHidden = false;
    this.clipboard = null; // { action: 'copy'|'move', items: [...] }
    this.mountedDrives = [];
    this.transferModalItems = [];
    this.activeTaskId = null;
    this.taskPollTimer = null;
    this.taskHideTimeout = null;
    this.activeUploadXhr = null;
    this.uploadCancelled = false;
    this.initialized = false;
    this.isDeleting = false;
  }

  async init() {
    if (this.initialized) {
      await this.loadMountedDrives();
      if (this.currentPath) {
        await this.refresh();
      }
      return;
    }
    this.initialized = true;
    this.setupEventListeners();
    await this.loadMountedDrives();
    await this.navigate(null);
  }

  setupEventListeners() {
    // Dropzone for Drag-and-Drop upload
    const contentArea = document.getElementById("fmContentArea");
    const dropOverlay = document.getElementById("fmDropOverlay");

    if (contentArea && dropOverlay) {
      let dragCounter = 0;

      contentArea.addEventListener("dragenter", (e) => {
        e.preventDefault();
        dragCounter++;
        dropOverlay.classList.add("active");
      });

      contentArea.addEventListener("dragleave", (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
          dropOverlay.classList.remove("active");
          dragCounter = 0;
        }
      });

      contentArea.addEventListener("dragover", (e) => {
        e.preventDefault();
      });

      contentArea.addEventListener("drop", async (e) => {
        e.preventDefault();
        dragCounter = 0;
        dropOverlay.classList.remove("active");

        if (e.dataTransfer && e.dataTransfer.files.length > 0) {
          await this.handleFilesUpload(e.dataTransfer.files);
        }
      });
    }

    // Hidden files toggle
    const hiddenToggle = document.getElementById("fmToggleHiddenBtn");
    if (hiddenToggle) {
      hiddenToggle.addEventListener("click", () => {
        this.showHidden = !this.showHidden;
        hiddenToggle.classList.toggle("active", this.showHidden);
        this.refresh();
      });
    }

    // Refresh button
    const refreshBtn = document.getElementById("fmRefreshBtn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => this.refresh());
    }

    // File input trigger
    const uploadInput = document.getElementById("fmUploadInput");
    const uploadBtn = document.getElementById("fmUploadBtn");
    if (uploadBtn && uploadInput) {
      uploadBtn.addEventListener("click", () => uploadInput.click());
      uploadInput.addEventListener("change", async () => {
        if (uploadInput.files.length > 0) {
          await this.handleFilesUpload(uploadInput.files);
          uploadInput.value = "";
        }
      });
    }

    // New folder button
    const newFolderBtn = document.getElementById("fmNewFolderBtn");
    if (newFolderBtn) {
      newFolderBtn.addEventListener("click", () => this.promptNewFolder());
    }

    // Bulk actions
    const bulkCopyBtn = document.getElementById("fmBulkCopyBtn");
    if (bulkCopyBtn) {
      bulkCopyBtn.addEventListener("click", () => {
        if (this.selectedItems.size > 0) {
          this.setClipboard("copy", Array.from(this.selectedItems));
        }
      });
    }

    const bulkMoveBtn = document.getElementById("fmBulkMoveBtn");
    if (bulkMoveBtn) {
      bulkMoveBtn.addEventListener("click", () => {
        if (this.selectedItems.size > 0) {
          this.setClipboard("move", Array.from(this.selectedItems));
        }
      });
    }

    const bulkTransferBtn = document.getElementById("fmBulkTransferBtn");
    if (bulkTransferBtn) {
      bulkTransferBtn.addEventListener("click", () => {
        if (this.selectedItems.size > 0) {
          this.openTransferModal(Array.from(this.selectedItems));
        }
      });
    }

    const bulkDeleteBtn = document.getElementById("fmBulkDeleteBtn");
    if (bulkDeleteBtn) {
      bulkDeleteBtn.addEventListener("click", (e) => {
        e.preventDefault();
        bulkDeleteBtn.blur();
        this.bulkDelete();
      });
    }

    // Clipboard bar actions
    const pasteBtn = document.getElementById("fmPasteBtn");
    if (pasteBtn) {
      pasteBtn.addEventListener("click", () => this.executePaste());
    }

    const cancelClipboardBtn = document.getElementById("fmCancelClipboardBtn");
    if (cancelClipboardBtn) {
      cancelClipboardBtn.addEventListener("click", () => this.clearClipboard());
    }

    // Transfer modal actions
    const closeTransferBtn = document.getElementById("closeTransferModalBtn");
    const cancelTransferBtn = document.getElementById("cancelTransferModalBtn");
    if (closeTransferBtn) closeTransferBtn.addEventListener("click", () => this.closeTransferModal());
    if (cancelTransferBtn) cancelTransferBtn.addEventListener("click", () => this.closeTransferModal());

    const transferForm = document.getElementById("fmTransferForm");
    if (transferForm) {
      transferForm.addEventListener("submit", (e) => this.handleTransferSubmit(e));
    }

    const browseTransferBtn = document.getElementById("btnBrowseTransferDest");
    if (browseTransferBtn) {
      browseTransferBtn.addEventListener("click", () => {
        const destInput = document.getElementById("fmTransferDestInput");
        folderBrowser.open({
          initialPath: destInput ? destInput.value.trim() || this.currentPath : this.currentPath,
          title: "Choose Destination Folder",
          onSelect: (selectedPath) => {
            if (destInput) destInput.value = selectedPath;
          }
        });
      });
    }

    // Keyboard shortcuts for copy/cut/paste
    document.addEventListener("keydown", (e) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
      const fmView = document.getElementById("filesView");
      if (!fmView || !fmView.classList.contains("active")) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        if (this.selectedItems.size > 0) {
          e.preventDefault();
          this.setClipboard("copy", Array.from(this.selectedItems));
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x") {
        if (this.selectedItems.size > 0) {
          e.preventDefault();
          this.setClipboard("move", Array.from(this.selectedItems));
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
        if (this.clipboard && this.clipboard.items && this.clipboard.items.length > 0) {
          e.preventDefault();
          this.executePaste();
        }
      } else if (e.key === "Escape") {
        const transferModal = document.getElementById("fmTransferModal");
        if (transferModal && transferModal.classList.contains("active")) {
          this.closeTransferModal();
        } else if (this.clipboard) {
          this.clearClipboard();
        }
      }
    });

    const selectAllCheckbox = document.getElementById("fmSelectAll");
    if (selectAllCheckbox) {
      selectAllCheckbox.addEventListener("change", (e) => {
        const checkboxes = document.querySelectorAll(".fm-item-checkbox");
        checkboxes.forEach(cb => {
          cb.checked = e.target.checked;
          const itemPath = cb.dataset.path;
          if (e.target.checked) {
            this.selectedItems.add(itemPath);
          } else {
            this.selectedItems.delete(itemPath);
          }
        });
        this.updateSelectionToolbar();
      });
    }

    // Listen for real-time file task progress from WebSocket
    window.addEventListener("homedock:file_task_progress", (e) => {
      if (e.detail) {
        this.handleFileTaskProgress(e.detail);
      }
    });

    // Listen for storage roots changes to refresh storage chips and view
    window.addEventListener("homedock:roots_changed", async () => {
      if (this.currentPath) {
        try {
          await this.refresh();
          return;
        } catch {
          // If current path became inaccessible, fall back to default
        }
      }
      await this.navigate(null, false);
    });

    // Task Cancel button
    const taskCancelBtn = document.getElementById("fmTaskCancelBtn");
    if (taskCancelBtn) {
      taskCancelBtn.addEventListener("click", () => this.cancelCurrentTask());
    }
  }

  renderStorageChips(chips) {
    const chipsContainer = document.getElementById("fmStorageChips");
    if (!chipsContainer) return;

    if (!chips || chips.length === 0) {
      chipsContainer.innerHTML = "";
      return;
    }

    chipsContainer.innerHTML = chips.map(c => {
      const isActive = this.currentPath && (this.currentPath === c.path || (c.path !== "/" && this.currentPath.startsWith(c.path + "/")));
      return `
        <div class="storage-chip ${isActive ? 'active' : ''}" data-path="${c.path}" title="${c.path}">
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none">
            <line x1="22" y1="12" x2="2" y2="12"></line>
            <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>
            <line x1="6" y1="16" x2="6.01" y2="16"></line>
            <line x1="10" y1="16" x2="10.01" y2="16"></line>
          </svg>
          <span>${c.label}</span>
        </div>
      `;
    }).join("");

    chipsContainer.querySelectorAll(".storage-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        const path = chip.dataset.path;
        if (this.currentPath !== path) {
          this.navigate(path);
        }
      });
    });
  }

  async loadMountedDrives() {
    if (this.currentPath) {
      await this.refresh();
    }
  }

  async navigate(targetPath, pushHistory = true) {
    try {
      const data = await api.listFiles(targetPath, this.showHidden);
      this.currentPath = data.current_path;
      this.allowedRoots = data.allowed_roots || [];

      if (pushHistory) {
        if (this.historyIndex < this.history.length - 1) {
          this.history = this.history.slice(0, this.historyIndex + 1);
        }
        this.history.push(this.currentPath);
        this.historyIndex = this.history.length - 1;
      }

      this.selectedItems.clear();
      this.renderBreadcrumbs(data.breadcrumbs);
      if (data.storage_chips) {
        this.renderStorageChips(data.storage_chips);
      }
      this.renderFileList(data.items);
      this.updateSelectionToolbar();
      this.updateClipboardToolbar();
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  async refresh() {
    if (this.currentPath) {
      await this.navigate(this.currentPath, false);
    }
  }

  renderBreadcrumbs(breadcrumbs) {
    const container = document.getElementById("fmBreadcrumbs");
    if (!container || !breadcrumbs) return;

    container.innerHTML = breadcrumbs.map((crumb, idx) => {
      const isLast = idx === breadcrumbs.length - 1;
      return `
        <span class="crumb-link" data-path="${crumb.path}">${crumb.name}</span>
        ${!isLast ? '<span class="crumb-separator">/</span>' : ""}
      `;
    }).join("");

    container.querySelectorAll(".crumb-link").forEach(link => {
      link.addEventListener("click", () => {
        const path = link.dataset.path;
        this.navigate(path);
      });
    });
  }

  renderFileList(items) {
    const tableBody = document.getElementById("fmTableBody");
    const selectAll = document.getElementById("fmSelectAll");
    if (selectAll) selectAll.checked = false;

    if (!tableBody) return;

    if (!items || items.length === 0) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 3rem;">
            Folder is empty
          </td>
        </tr>
      `;
      return;
    }

    tableBody.innerHTML = items.map(item => {
      const isCut = this.clipboard && this.clipboard.action === "move" && this.clipboard.items.includes(item.path);
      const iconClass = item.is_dir ? "folder" : (item.is_archive ? "archive" : "");
      let iconSvg = "";

      if (item.is_dir) {
        iconSvg = `<svg class="file-icon folder" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;
      } else if (item.is_archive) {
        iconSvg = `<svg class="file-icon archive" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8v13H3V8M1 3h22v5H1z"/><path d="M10 12h4"/></svg>`;
      } else {
        iconSvg = `<svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
      }

      return `
        <tr class="file-row ${isCut ? 'is-cut' : ''}" data-path="${item.path}" data-isdir="${item.is_dir}" data-archive="${item.is_archive}">
          <td style="width: 40px; text-align: center;">
            <input type="checkbox" class="fm-item-checkbox" data-path="${item.path}">
          </td>
          <td>
            <div class="file-name-cell">
              ${iconSvg}
              <span class="file-item-name">${item.name}</span>
            </div>
          </td>
          <td style="font-family: var(--font-mono); font-size: 0.82rem; color: var(--text-secondary);">
            ${item.is_dir ? "--" : formatBytes(item.size)}
          </td>
          <td style="font-size: 0.82rem; color: var(--text-muted);">
            ${formatDate(item.mtime)}
          </td>
          <td style="text-align: right;">
            <div class="file-item-actions" style="display: inline-flex; gap: 0.25rem;">
              ${!item.is_dir ? `
                <a href="${api.getFileDownloadUrl(item.path)}" download class="btn btn-secondary btn-icon btn-sm" title="Download">
                  <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                </a>
              ` : ""}
              ${item.is_archive ? `
                <button class="btn btn-secondary btn-icon btn-sm btn-extract" data-path="${item.path}" title="Extract Archive">
                  <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
                </button>
              ` : ""}
              <button class="btn btn-secondary btn-icon btn-sm btn-copy" data-path="${item.path}" data-name="${item.name}" title="Copy">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              </button>
              <button class="btn btn-secondary btn-icon btn-sm btn-move" data-path="${item.path}" data-name="${item.name}" title="Cut / Move">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>
              </button>
              <button class="btn btn-secondary btn-icon btn-sm btn-rename" data-path="${item.path}" data-name="${item.name}" title="Rename">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
              </button>
              <button class="btn btn-secondary btn-icon btn-sm btn-info" data-path="${item.path}" title="Details">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
              </button>
              <button class="btn btn-secondary btn-icon btn-sm btn-delete text-danger" data-path="${item.path}" data-name="${item.name}" title="Delete">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join("");

    // Attach row click listeners
    tableBody.querySelectorAll(".file-row").forEach(row => {
      const isDir = row.dataset.isdir === "true";
      const path = row.dataset.path;
      const nameCell = row.querySelector(".file-name-cell");

      nameCell.addEventListener("click", () => {
        if (isDir) {
          this.navigate(path);
        } else {
          // Open or trigger download
          window.open(api.getFileDownloadUrl(path), "_blank");
        }
      });
    });

    // Checkboxes
    tableBody.querySelectorAll(".fm-item-checkbox").forEach(cb => {
      cb.addEventListener("change", (e) => {
        const path = cb.dataset.path;
        if (e.target.checked) {
          this.selectedItems.add(path);
        } else {
          this.selectedItems.delete(path);
        }
        this.updateSelectionToolbar();
      });
    });

    // Action buttons
    tableBody.querySelectorAll(".btn-copy").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.setClipboard("copy", [btn.dataset.path]);
      });
    });

    tableBody.querySelectorAll(".btn-move").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.setClipboard("move", [btn.dataset.path]);
      });
    });

    tableBody.querySelectorAll(".btn-rename").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.promptRename(btn.dataset.path, btn.dataset.name);
      });
    });

    tableBody.querySelectorAll(".btn-delete").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        btn.blur();
        this.confirmDelete([btn.dataset.path], btn.dataset.name);
      });
    });

    tableBody.querySelectorAll(".btn-info").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.showItemInfo(btn.dataset.path);
      });
    });

    tableBody.querySelectorAll(".btn-extract").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.confirmExtract(btn.dataset.path);
      });
    });
  }

  updateSelectionToolbar() {
    const count = this.selectedItems.size;
    const bulkBar = document.getElementById("fmBulkActions");
    const countSpan = document.getElementById("fmSelectedCount");

    if (bulkBar && countSpan) {
      if (count > 0) {
        bulkBar.style.display = "flex";
        countSpan.textContent = `${count} item${count > 1 ? "s" : ""} selected`;
      } else {
        bulkBar.style.display = "none";
      }
    }
  }

  getTaskIconSvg(action) {
    if (action === "copy") {
      return `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    } else if (action === "move") {
      return `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>`;
    } else if (action === "extract") {
      return `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`;
    } else if (action === "upload") {
      return `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
    }
    return `<svg class="spin" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>`;
  }

  showTaskProgress(title, detail = "", percent = 0, action = "task") {
    const card = document.getElementById("fmTaskProgressBar");
    const statusText = document.getElementById("fmTaskStatusText");
    const detailText = document.getElementById("fmTaskDetailText");
    const pctText = document.getElementById("fmTaskPercentText");
    const fill = document.getElementById("fmTaskProgressFill");
    const icon = document.getElementById("fmTaskIcon");
    const cancelBtn = document.getElementById("fmTaskCancelBtn");

    if (!card) return;
    if (this.taskHideTimeout) {
      clearTimeout(this.taskHideTimeout);
      this.taskHideTimeout = null;
    }

    card.style.display = "block";
    if (icon) icon.innerHTML = this.getTaskIconSvg(action);
    if (statusText) statusText.textContent = title;
    if (detailText) detailText.textContent = detail;
    const rounded = Math.round(percent);
    if (pctText) pctText.textContent = `${rounded}%`;
    if (fill) fill.style.width = `${rounded}%`;
    if (cancelBtn) {
      cancelBtn.style.display = "inline-flex";
      cancelBtn.disabled = false;
    }
  }

  async cancelCurrentTask() {
    const cancelBtn = document.getElementById("fmTaskCancelBtn");
    if (cancelBtn) cancelBtn.disabled = true;

    if (this.activeUploadXhr) {
      this.uploadCancelled = true;
      try {
        this.activeUploadXhr.abort();
      } catch (e) {}
      this.activeUploadXhr = null;
      showToast("Upload cancelled", "info");
      this.updateTaskProgress({
        title: "Cancelled: Upload",
        detail: "Upload cancelled by user",
      });
      this.hideTaskProgress(1500);
      await this.refresh();
      return;
    }

    if (this.activeTaskId) {
      try {
        showToast("Cancelling task...", "info");
        await api.cancelTask(this.activeTaskId);
        this.updateTaskProgress({
          title: "Cancelling...",
          detail: "Stopping operation...",
        });
      } catch (err) {
        showToast(err.message, "error");
        if (cancelBtn) cancelBtn.disabled = false;
      }
    }
  }

  updateTaskProgress({ title, percent, detail, action }) {
    const card = document.getElementById("fmTaskProgressBar");
    const statusText = document.getElementById("fmTaskStatusText");
    const detailText = document.getElementById("fmTaskDetailText");
    const pctText = document.getElementById("fmTaskPercentText");
    const fill = document.getElementById("fmTaskProgressFill");
    const icon = document.getElementById("fmTaskIcon");

    if (!card || card.style.display === "none") {
      this.showTaskProgress(title || "Processing...", detail || "", percent || 0, action || "task");
      return;
    }

    if (action && icon) icon.innerHTML = this.getTaskIconSvg(action);
    if (title && statusText) statusText.textContent = title;
    if (detail !== undefined && detailText) detailText.textContent = detail;
    if (percent !== undefined) {
      const p = Math.max(0, Math.min(100, percent));
      const rounded = Math.round(p);
      if (pctText) pctText.textContent = `${rounded}%`;
      if (fill) fill.style.width = `${p}%`;
    }
  }

  hideTaskProgress(delay = 1200) {
    if (this.taskPollTimer) {
      clearInterval(this.taskPollTimer);
      this.taskPollTimer = null;
    }
    if (this.taskHideTimeout) {
      clearTimeout(this.taskHideTimeout);
    }
    this.taskHideTimeout = setTimeout(() => {
      const card = document.getElementById("fmTaskProgressBar");
      if (card) card.style.display = "none";
      this.activeTaskId = null;
      this.taskHideTimeout = null;
    }, delay);
  }

  trackTask(taskId, fallbackTitle = "Processing task...") {
    this.activeTaskId = taskId;
    this.showTaskProgress(fallbackTitle, "Starting...", 0);

    if (this.taskPollTimer) {
      clearInterval(this.taskPollTimer);
      this.taskPollTimer = null;
    }

    // Polling fallback every 600ms in case WebSocket is unavailable
    this.taskPollTimer = setInterval(async () => {
      if (!this.activeTaskId || this.activeTaskId !== taskId) {
        clearInterval(this.taskPollTimer);
        this.taskPollTimer = null;
        return;
      }
      try {
        const res = await api.getTask(taskId);
        const taskData = (res && res.task) ? res.task : res;
        if (taskData && taskData.task_id) {
          this.handleFileTaskProgress(taskData);
          if (taskData.status === "completed" || taskData.status === "failed" || taskData.status === "cancelled") {
            clearInterval(this.taskPollTimer);
            this.taskPollTimer = null;
          }
        }
      } catch (e) {
        // Ignored during polling
      }
    }, 600);
  }

  handleFileTaskProgress(task) {
    if (!task) return;
    if (this.activeTaskId && task.task_id && this.activeTaskId !== task.task_id) {
      return;
    }
    if (!this.activeTaskId && task.task_id && task.status === "running") {
      this.activeTaskId = task.task_id;
    }

    const action = task.type || task.action || "task";
    let detailStr = task.detail || "";

    if (task.total_bytes && task.total_bytes > 0 && task.done_bytes !== undefined) {
      const bytesStr = `${formatBytes(task.done_bytes)} / ${formatBytes(task.total_bytes)}`;
      let extra = [];
      if (task.speed_bps && task.speed_bps > 0) {
        extra.push(formatSpeed(task.speed_bps));
      }
      if (task.eta_seconds !== null && task.eta_seconds !== undefined && task.eta_seconds > 0) {
        extra.push(`ETA ${formatTime(task.eta_seconds)}`);
      }
      const telemetry = extra.length > 0 ? ` (${extra.join(" • ")})` : "";
      detailStr = `${bytesStr}${telemetry}`;
    }

    const percent = task.percent !== undefined ? task.percent : (task.status === "completed" ? 100 : 0);

    let title = task.title || "File Operation";
    if (task.status === "completed") {
      title = `Completed: ${task.title || "Operation finished"}`;
      detailStr = task.detail || "Success";
    } else if (task.status === "failed") {
      title = `Failed: ${task.title || "Operation failed"}`;
      detailStr = task.error || task.detail || "Error";
    } else if (task.status === "cancelled") {
      title = `Cancelled: ${task.title || "Operation"}`;
      detailStr = task.detail || "Cancelled by user";
    }

    const cancelBtn = document.getElementById("fmTaskCancelBtn");
    if (cancelBtn) {
      if (task.status === "running") {
        cancelBtn.style.display = "inline-flex";
        cancelBtn.disabled = false;
      } else {
        cancelBtn.style.display = "none";
      }
    }

    this.updateTaskProgress({
      title,
      percent,
      detail: detailStr,
      action,
    });

    if (task.status === "completed") {
      if (this.taskPollTimer) {
        clearInterval(this.taskPollTimer);
        this.taskPollTimer = null;
      }
      this.hideTaskProgress(1500);
      this.refresh();
    } else if (task.status === "failed") {
      if (this.taskPollTimer) {
        clearInterval(this.taskPollTimer);
        this.taskPollTimer = null;
      }
      this.hideTaskProgress(3000);
    } else if (task.status === "cancelled") {
      if (this.taskPollTimer) {
        clearInterval(this.taskPollTimer);
        this.taskPollTimer = null;
      }
      this.hideTaskProgress(2000);
      this.refresh();
    }
  }

  async handleFilesUpload(fileList) {
    if (!this.currentPath || !fileList || fileList.length === 0) return;
    const count = fileList.length;
    this.uploadCancelled = false;

    let totalBytes = 0;
    for (let i = 0; i < count; i++) {
      totalBytes += fileList[i].size || 0;
    }

    this.showTaskProgress(
      `Uploading ${count} file${count > 1 ? "s" : ""}...`,
      `0 B / ${formatBytes(totalBytes)}`,
      0,
      "upload"
    );

    let bytesCompletedBefore = 0;
    let uploadedCount = 0;

    for (let i = 0; i < count; i++) {
      if (this.uploadCancelled) break;
      const file = fileList[i];
      const fileName = file.name;

      try {
        await api.uploadFile(
          file,
          this.currentPath,
          (percent, loaded) => {
            if (this.uploadCancelled) return;
            const currentLoaded = loaded !== undefined ? loaded : (percent / 100) * file.size;
            const currentTotalLoaded = bytesCompletedBefore + currentLoaded;
            const overallPct = totalBytes > 0 ? (currentTotalLoaded / totalBytes) * 100 : percent;

            this.updateTaskProgress({
              title: `Uploading (${i + 1}/${count}): ${fileName}`,
              percent: overallPct,
              detail: `${formatBytes(currentTotalLoaded)} / ${formatBytes(totalBytes)}`,
              action: "upload",
            });
          },
          (xhr) => {
            this.activeUploadXhr = xhr;
          }
        );
        this.activeUploadXhr = null;
        bytesCompletedBefore += file.size;
        uploadedCount++;
      } catch (err) {
        this.activeUploadXhr = null;
        if (this.uploadCancelled) break;
        showToast(`Failed to upload ${fileName}: ${err.message}`, "error");
      }
    }

    if (this.uploadCancelled) {
      this.hideTaskProgress(1000);
      await this.refresh();
      return;
    }

    this.updateTaskProgress({
      title: `Upload completed (${uploadedCount}/${count} file${count > 1 ? "s" : ""})`,
      percent: 100,
      detail: formatBytes(totalBytes),
      action: "upload",
    });
    showToast(`Uploaded ${uploadedCount} file(s)`, "success");
    this.hideTaskProgress(1500);
    await this.refresh();
  }

  promptNewFolder() {
    if (document.activeElement && typeof document.activeElement.blur === "function") {
      document.activeElement.blur();
    }
    const name = prompt("Enter new folder name:");
    if (!name || !name.trim()) return;

    const newPath = `${this.currentPath}/${name.trim()}`;
    api.createFolder(newPath)
      .then(() => {
        showToast("Folder created", "success");
        this.refresh();
      })
      .catch(err => showToast(err.message, "error"));
  }

  promptRename(path, currentName) {
    if (document.activeElement && typeof document.activeElement.blur === "function") {
      document.activeElement.blur();
    }
    const newName = prompt(`Rename '${currentName}' to:`, currentName);
    if (!newName || !newName.trim() || newName.trim() === currentName) return;

    api.renameItem(path, newName.trim())
      .then(() => {
        showToast("Renamed successfully", "success");
        this.refresh();
      })
      .catch(err => showToast(err.message, "error"));
  }

  async confirmDelete(paths, displayName) {
    if (this.isDeleting) return;
    const count = paths ? paths.length : 0;
    if (count === 0) return;

    const itemName = displayName || (paths[0] ? paths[0].split("/").filter(Boolean).pop() : "item");
    const title = count === 1 ? "Delete Item" : "Delete Multiple Items";
    const msg = count === 1
      ? `Are you sure you want to permanently delete "${itemName}"?`
      : `Are you sure you want to permanently delete ${count} selected items?`;

    const confirmed = await showConfirmDialog({
      title,
      message: msg,
      confirmText: "Delete",
      danger: true
    });

    if (!confirmed) return;

    this.isDeleting = true;
    try {
      await api.deleteItems(paths);
      showToast(count === 1 ? `Deleted "${itemName}"` : `Deleted ${count} items`, "success");
      this.selectedItems.clear();
      await this.refresh();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      this.isDeleting = false;
    }
  }

  bulkDelete() {
    if (this.selectedItems.size === 0) return;
    this.confirmDelete(Array.from(this.selectedItems), "");
  }

  async confirmExtract(archivePath) {
    const archiveName = archivePath.split("/").filter(Boolean).pop();
    const confirmed = await showConfirmDialog({
      title: "Extract Archive",
      message: `Extract archive "${archiveName}" safely into destination folder?`,
      confirmText: "Extract",
      danger: false
    });
    if (!confirmed) return;

    showToast("Extracting archive...", "info");
    const taskId = `task-extract-${Date.now()}`;
    this.trackTask(taskId, `Extracting ${archiveName}...`);

    try {
      const res = await api.extractArchive(archivePath, null, taskId);
      showToast(`Archive extracted: ${res.files_extracted} files`, "success");
      await this.refresh();
    } catch (err) {
      showToast(err.message, "error");
      this.hideTaskProgress(500);
    }
  }

  async showItemInfo(path) {
    try {
      const info = await api.getFileInfo(path);
      const modal = document.getElementById("fileInfoModal");
      const body = document.getElementById("fileInfoModalBody");
      if (!modal || !body) return;

      body.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 0.75rem; font-size: 0.9rem;">
          <div><strong>Name:</strong> ${info.name}</div>
          <div><strong>Type:</strong> ${info.is_dir ? "Directory" : "File"}</div>
          <div><strong>Path:</strong> <code style="font-size: 0.8rem;">${info.path}</code></div>
          <div><strong>Size:</strong> ${info.is_dir ? formatBytes(info.total_size) : formatBytes(info.size)}</div>
          ${info.is_dir ? `<div><strong>Contains:</strong> ${info.file_count || 0} files, ${info.dir_count || 0} folders</div>` : ""}
          <div><strong>Permissions:</strong> <code>${info.permissions}</code></div>
          <div><strong>Modified:</strong> ${formatDate(info.modified)}</div>
        </div>
      `;
      modal.classList.add("active");
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  setClipboard(action, paths) {
    if (!paths || paths.length === 0) return;
    this.clipboard = { action, items: [...paths] };
    this.updateClipboardToolbar();

    // Visually mark cut items in the current table if applicable
    const rows = document.querySelectorAll(".file-row");
    rows.forEach(row => {
      if (action === "move" && this.clipboard.items.includes(row.dataset.path)) {
        row.classList.add("is-cut");
      } else {
        row.classList.remove("is-cut");
      }
    });

    const count = paths.length;
    const sampleName = paths[0].split("/").pop();
    const displayName = count === 1 ? `'${sampleName}'` : `${count} items`;

    if (action === "copy") {
      showToast(`Copied ${displayName} to clipboard. Open target folder and click Paste.`, "info");
    } else {
      showToast(`Cut ${displayName}. Open target folder and click Move Here.`, "info");
    }
  }

  clearClipboard() {
    this.clipboard = null;
    this.updateClipboardToolbar();
    const rows = document.querySelectorAll(".file-row.is-cut");
    rows.forEach(r => r.classList.remove("is-cut"));
  }

  updateClipboardToolbar() {
    const bar = document.getElementById("fmClipboardBar");
    const text = document.getElementById("fmClipboardText");
    const pasteBtnText = document.getElementById("fmPasteBtnText");

    if (!bar || !text || !pasteBtnText) return;

    if (!this.clipboard || !this.clipboard.items || this.clipboard.items.length === 0) {
      bar.style.display = "none";
      return;
    }

    bar.style.display = "flex";
    const count = this.clipboard.items.length;
    const sampleName = this.clipboard.items[0].split("/").pop();
    const label = count === 1 ? sampleName : `${count} items`;

    if (this.clipboard.action === "copy") {
      text.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy: ${label}`;
      pasteBtnText.textContent = "Paste Here";
    } else {
      text.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg> Cut: ${label}`;
      pasteBtnText.textContent = "Move Here";
    }
  }

  async executePaste() {
    if (!this.clipboard || !this.clipboard.items || this.clipboard.items.length === 0) return;
    if (!this.currentPath) {
      showToast("Cannot paste: destination folder not selected", "error");
      return;
    }

    const { action, items } = this.clipboard;
    const pasteBtn = document.getElementById("fmPasteBtn");
    if (pasteBtn) pasteBtn.disabled = true;

    const taskId = `task-${action}-${Date.now()}`;
    const actionLabel = action === "copy" ? "Copying" : "Moving";
    const count = items.length;
    const title = `${actionLabel} ${count} item${count > 1 ? "s" : ""}...`;
    this.trackTask(taskId, title);

    try {
      if (action === "copy") {
        showToast("Copying items...", "info");
        const res = await api.copyItems(items, this.currentPath, taskId);
        showToast(`Copied ${res.copied.length} item(s) successfully`, "success");
      } else {
        showToast("Moving items...", "info");
        const res = await api.moveItems(items, this.currentPath, taskId);
        showToast(`Moved ${res.moved.length} item(s) successfully`, "success");
        this.clearClipboard();
      }
      await this.refresh();
    } catch (err) {
      showToast(err.message, "error");
      this.hideTaskProgress(500);
    } finally {
      if (pasteBtn) pasteBtn.disabled = false;
      this.updateClipboardToolbar();
    }
  }

  openTransferModal(items, defaultAction = "copy") {
    if (!items || items.length === 0) return;
    this.transferModalItems = items;

    const modal = document.getElementById("fmTransferModal");
    const itemList = document.getElementById("fmTransferItemList");
    const destInput = document.getElementById("fmTransferDestInput");
    const chipsContainer = document.getElementById("fmTransferQuickDestList");
    const title = document.getElementById("fmTransferModalTitle");

    if (!modal || !itemList || !destInput) return;

    title.textContent = defaultAction === "move" ? "Move Items" : "Copy Items";

    // Set radio selection
    const radios = document.getElementsByName("fmTransferAction");
    radios.forEach(r => {
      r.checked = (r.value === defaultAction);
    });

    // Populate item list preview
    itemList.innerHTML = items.map(p => `<div>${p.split("/").pop()} <span style="color: var(--text-muted); font-size: 0.75rem;">(${p})</span></div>`).join("");

    // Pre-fill destination with current path
    destInput.value = this.currentPath || "";

    // Populate quick destination chips
    if (chipsContainer) {
      const locations = [];
      if (this.currentPath) {
        locations.push({ label: "Current Folder", path: this.currentPath });
      }
      if (this.mountedDrives && this.mountedDrives.length > 0) {
        this.mountedDrives.forEach(d => {
          if (!locations.some(l => l.path === d.mountpoint)) {
            locations.push({ label: d.label, path: d.mountpoint });
          }
        });
      }

      chipsContainer.innerHTML = locations.map(loc => `
        <span class="quick-dest-chip ${loc.path === destInput.value ? 'active' : ''}" data-path="${loc.path}">
          <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <span>${loc.label}</span>
        </span>
      `).join("");

      chipsContainer.querySelectorAll(".quick-dest-chip").forEach(chip => {
        chip.addEventListener("click", () => {
          destInput.value = chip.dataset.path;
          chipsContainer.querySelectorAll(".quick-dest-chip").forEach(c => c.classList.remove("active"));
          chip.classList.add("active");
        });
      });
    }

    modal.classList.add("active");
  }

  closeTransferModal() {
    const modal = document.getElementById("fmTransferModal");
    if (modal) modal.classList.remove("active");
    this.transferModalItems = [];
  }

  async handleTransferSubmit(e) {
    e.preventDefault();
    const destInput = document.getElementById("fmTransferDestInput");
    const dest = destInput ? destInput.value.trim() : "";
    if (!dest) {
      showToast("Please enter or select a destination directory", "error");
      return;
    }

    const radios = document.getElementsByName("fmTransferAction");
    let action = "copy";
    radios.forEach(r => {
      if (r.checked) action = r.value;
    });

    const items = this.transferModalItems;
    if (!items || items.length === 0) {
      this.closeTransferModal();
      return;
    }

    const submitBtn = document.getElementById("submitTransferModalBtn");
    if (submitBtn) submitBtn.disabled = true;

    const taskId = `task-${action}-${Date.now()}`;
    const actionLabel = action === "copy" ? "Copying" : "Moving";
    const count = items.length;
    const destName = dest.split("/").pop() || dest;
    const title = `${actionLabel} ${count} item${count > 1 ? "s" : ""} to ${destName}...`;
    this.trackTask(taskId, title);

    try {
      if (action === "copy") {
        showToast("Copying items...", "info");
        const res = await api.copyItems(items, dest, taskId);
        showToast(`Copied ${res.copied.length} item(s) to ${dest}`, "success");
      } else {
        showToast("Moving items...", "info");
        const res = await api.moveItems(items, dest, taskId);
        showToast(`Moved ${res.moved.length} item(s) to ${dest}`, "success");
        if (this.clipboard && this.clipboard.items.some(p => items.includes(p))) {
          this.clearClipboard();
        }
      }
      this.closeTransferModal();
      this.selectedItems.clear();
      await this.refresh();
    } catch (err) {
      showToast(err.message, "error");
      this.hideTaskProgress(500);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }
}

export const fileManagerComponent = new FileManagerComponent();
