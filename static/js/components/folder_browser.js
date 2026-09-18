/**
 * Interactive Server Folder Browser Component for HomeDock.
 * Provides visual folder navigation with breadcrumbs, quick storage chips,
 * subfolder listings, and on-the-fly directory creation.
 */

import { api, showToast } from "../api.js";

export class FolderBrowser {
  constructor() {
    this.modal = null;
    this.currentPath = "/";
    this.onSelectCallback = null;
    this.initialized = false;
  }

  init() {
    if (this.initialized) return;
    this.modal = document.getElementById("folderBrowserModal");
    if (!this.modal) return;
    this.setupListeners();
    this.initialized = true;
  }

  setupListeners() {
    const closeBtn = document.getElementById("closeFolderBrowserBtn");
    const cancelBtn = document.getElementById("cancelFolderBrowserBtn");
    const confirmBtn = document.getElementById("confirmFolderBrowserBtn");
    const createFolderBtn = document.getElementById("fbCreateFolderBtn");
    const newFolderInput = document.getElementById("fbNewFolderName");

    if (closeBtn) closeBtn.addEventListener("click", () => this.close());
    if (cancelBtn) cancelBtn.addEventListener("click", () => this.close());

    if (confirmBtn) {
      confirmBtn.addEventListener("click", () => {
        if (this.onSelectCallback && this.currentPath) {
          this.onSelectCallback(this.currentPath);
        }
        this.close();
      });
    }

    const pathInput = document.getElementById("fbPathInput");
    const pathGoBtn = document.getElementById("fbPathGoBtn");
    if (pathInput && pathGoBtn) {
      const handleJump = () => {
        const val = pathInput.value.trim();
        if (val) this.loadDirectory(val);
      };
      pathGoBtn.addEventListener("click", handleJump);
      pathInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          handleJump();
        }
      });
    }

    if (createFolderBtn && newFolderInput) {
      const handleCreate = async () => {
        const name = newFolderInput.value.trim();
        if (!name) return;
        try {
          const newPath = this.currentPath.endsWith("/")
            ? `${this.currentPath}${name}`
            : `${this.currentPath}/${name}`;
          await api.createFolder(newPath);
          showToast(`Folder "${name}" created`, "success");
          newFolderInput.value = "";
          await this.loadDirectory(this.currentPath);
        } catch (e) {
          showToast(e.message || "Failed to create folder", "error");
        }
      };

      createFolderBtn.addEventListener("click", handleCreate);
      newFolderInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          handleCreate();
        }
      });
    }
  }

  async open({ initialPath = null, title = "Select Folder", onSelect = null } = {}) {
    this.init();
    if (!this.modal) return;

    this.onSelectCallback = onSelect;
    const titleEl = document.getElementById("folderBrowserTitle");
    if (titleEl) titleEl.textContent = title;

    this.modal.classList.add("active");
    await this.loadDirectory(initialPath);
  }

  close() {
    if (this.modal) this.modal.classList.remove("active");
    this.onSelectCallback = null;
  }

  async loadDirectory(targetPath) {
    const dirListEl = document.getElementById("fbDirList");
    const crumbsEl = document.getElementById("fbBreadcrumbs");
    const quickLocsEl = document.getElementById("fbQuickLocations");
    const pathDisplayEl = document.getElementById("fbCurrentPathDisplay");

    if (dirListEl) {
      dirListEl.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: center; gap: 0.5rem; color: var(--text-muted); padding: 2rem;">
          <div class="spinner" style="width: 18px; height: 18px; border-width: 2px;"></div>
          <span>Loading folders...</span>
        </div>
      `;
    }

    try {
      const data = await api.browseFolders(targetPath);
      this.currentPath = data.current_path;

      if (pathDisplayEl) {
        pathDisplayEl.textContent = data.current_path;
        pathDisplayEl.title = data.current_path;
      }

      const pathInput = document.getElementById("fbPathInput");
      if (pathInput) {
        pathInput.value = data.current_path;
      }

      // Render Quick Locations
      if (quickLocsEl && data.quick_locations) {
        quickLocsEl.innerHTML = data.quick_locations.map(loc => {
          const isActive = loc.path === data.current_path;
          return `
            <button type="button" class="quick-dest-chip ${isActive ? 'active' : ''}" data-path="${loc.path}">
              <span>📁</span>
              <span>${loc.name}</span>
            </button>
          `;
        }).join("");

        quickLocsEl.querySelectorAll(".quick-dest-chip").forEach(btn => {
          btn.addEventListener("click", () => this.loadDirectory(btn.dataset.path));
        });
      }

      // Render Breadcrumbs
      if (crumbsEl && data.breadcrumbs) {
        crumbsEl.innerHTML = data.breadcrumbs.map((crumb, idx) => {
          const isLast = idx === data.breadcrumbs.length - 1;
          return `
            <span class="fb-crumb ${isLast ? 'active' : ''}" data-path="${crumb.path}">${crumb.name}</span>
            ${!isLast ? '<span class="fb-crumb-sep">/</span>' : ''}
          `;
        }).join("");

        crumbsEl.querySelectorAll(".fb-crumb").forEach(crumb => {
          crumb.addEventListener("click", () => this.loadDirectory(crumb.dataset.path));
        });
      }

      // Render Directory List
      if (dirListEl) {
        let itemsHtml = "";

        if (data.parent_path) {
          itemsHtml += `
            <div class="fb-dir-item fb-parent-item" data-path="${data.parent_path}">
              <div style="display: flex; align-items: center; gap: 0.5rem;">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 17l-5-5m0 0l5-5m-5 5h12"/></svg>
                <span style="font-weight: 500;">.. (Parent Directory)</span>
              </div>
            </div>
          `;
        }

        if (data.directories && data.directories.length > 0) {
          data.directories.forEach(d => {
            itemsHtml += `
              <div class="fb-dir-item" data-path="${d.path}">
                <div style="display: flex; align-items: center; gap: 0.5rem; overflow: hidden;">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-primary); flex-shrink: 0;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                  <span class="fb-dir-name">${d.name}</span>
                </div>
                ${d.writable ? '<span class="badge-tag" style="background: var(--color-success-alpha); color: var(--color-success); font-size: 0.65rem;">writable</span>' : ''}
              </div>
            `;
          });
        } else if (!data.parent_path) {
          itemsHtml = `<div style="text-align: center; color: var(--text-muted); padding: 2rem;">No subdirectories found</div>`;
        }

        dirListEl.innerHTML = itemsHtml;

        dirListEl.querySelectorAll(".fb-dir-item").forEach(item => {
          item.addEventListener("click", () => this.loadDirectory(item.dataset.path));
        });
      }
    } catch (e) {
      if (dirListEl) {
        dirListEl.innerHTML = `
          <div style="color: var(--color-danger); padding: 1.5rem; text-align: center;">
            <p>Error loading folder: ${e.message}</p>
            <button type="button" class="btn btn-secondary btn-sm" style="margin-top: 0.5rem;" onclick="folderBrowser.loadDirectory('/')">Go to Root (/)</button>
          </div>
        `;
      }
    }
  }
}

export const folderBrowser = new FolderBrowser();
