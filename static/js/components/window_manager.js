/**
 * HomeDock macOS Window Manager & Desktop Environment Controller.
 * Implements macOS/UmbrelOS window lifecycle, dock management, titlebar dragging,
 * traffic light controls, live menu bar clock, and desktop state.
 */

import { fileManagerComponent } from "./files.js";
import { downloadManagerComponent } from "./downloads.js";
import { settingsComponent } from "./settings.js";
import { dashboardComponent } from "./dashboard.js";
import { openModal, revealElements, animateElement, cancelMotion, finishMotion, motion, showScreen } from "../utils/motion.js";

import { api, showToast } from "../api.js";

export class WindowManager {
  constructor() {
    this.windows = {};
    this.activeWindow = null;
    this.zIndexCounter = 100;
    this.dragState = null;
  }

  init() {
    this.setupClock();
    this.setupWindows();
    this.setupDock();
    this.setupMenubar();
    this.setupKeyboardShortcuts();
  }

  setupClock() {
    const updateTime = () => {
      const now = new Date();
      // Format: Wed Sep 30 11:45 AM
      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const menubarTimeStr = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + '  ' + timeStr;
      
      const menubarClock = document.getElementById("menubarClock");
      if (menubarClock) {
        menubarClock.textContent = menubarTimeStr;
        menubarClock.dataset.time = timeStr;
      }

      // Lock screen clock & date
      const lockTime = document.getElementById("lockScreenTime");
      const lockDate = document.getElementById("lockScreenDate");
      if (lockTime) {
        lockTime.textContent = timeStr;
      }
      if (lockDate) {
        lockDate.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
      }
    };

    updateTime();
    setInterval(updateTime, 1000);
  }

  setupWindows() {
    const winElements = document.querySelectorAll(".macos-window");
    winElements.forEach(win => {
      const id = win.dataset.window;
      this.windows[id] = {
        el: win,
        isOpen: false,
        isMinimized: false,
        isMaximized: false,
        originalBounds: null
      };
      win.inert = true;
      win.setAttribute("aria-hidden", "true");

      // Bring to front on click
      win.addEventListener("mousedown", () => {
        this.focusWindow(id);
      });

      // Traffic light buttons
      const closeBtn = win.querySelector(".traffic-close");
      const minBtn = win.querySelector(".traffic-minimize");
      const maxBtn = win.querySelector(".traffic-maximize");

      if (closeBtn) {
        closeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.closeWindow(id);
        });
      }

      if (minBtn) {
        minBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.minimizeWindow(id);
        });
      }

      if (maxBtn) {
        maxBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.toggleMaximizeWindow(id);
        });
      }

      // Titlebar dragging & double click to maximize
      const titlebar = win.querySelector(".window-titlebar");
      if (titlebar) {
        titlebar.addEventListener("dblclick", (e) => {
          if (e.target.closest(".traffic-lights") || e.target.closest(".traffic-btn") || e.target.closest("button") || e.target.closest("input")) return;
          this.toggleMaximizeWindow(id);
        });

        titlebar.addEventListener("pointerdown", (e) => {
          if (e.button !== 0 || window.innerWidth <= 768) return;
          if (e.target.closest(".traffic-lights") || e.target.closest(".traffic-btn") || e.target.closest("button") || e.target.closest("input")) return;
          if (this.windows[id].isMaximized) return;

          this.focusWindow(id);
          const rect = win.getBoundingClientRect();
          cancelMotion(win);
          win.style.transformOrigin = "";
          win.style.left = `${rect.left}px`;
          win.style.top = `${rect.top}px`;
          win.style.transform = "none";
          this.dragState = {
            id,
            win,
            offsetX: e.clientX - rect.left,
            offsetY: e.clientY - rect.top,
            startLeft: rect.left,
            startTop: rect.top,
            left: rect.left,
            top: rect.top,
            frame: null,
          };
          titlebar.setPointerCapture(e.pointerId);
          e.preventDefault();
          document.body.classList.add("window-dragging");
        });
      }
    });

    // Global drag handlers
    window.addEventListener("pointermove", (e) => {
      if (!this.dragState) return;
      const { win, offsetX, offsetY } = this.dragState;
      let left = e.clientX - offsetX;
      let top = e.clientY - offsetY;

      // Keep within bounds
      const minTop = 32; // Menu bar height
      const maxTop = window.innerHeight - 80; // Above dock
      const minLeft = -win.offsetWidth + 80;
      const maxLeft = window.innerWidth - 80;

      top = Math.max(minTop, Math.min(top, maxTop));
      left = Math.max(minLeft, Math.min(left, maxLeft));

      const drag = this.dragState;
      drag.left = left;
      drag.top = top;
      if (drag.frame === null) {
        drag.frame = requestAnimationFrame(() => {
          drag.frame = null;
          if (this.dragState !== drag) return;
          win.style.transform = `translate(${drag.left - drag.startLeft}px, ${drag.top - drag.startTop}px)`;
        });
      }
    });

    window.addEventListener("pointerup", () => this.finishDrag());
    window.addEventListener("pointercancel", () => this.finishDrag());
    window.addEventListener("blur", () => this.finishDrag());
    window.addEventListener("resize", () => {
      this.finishDrag();
      Object.values(this.windows).forEach(({ el, isMaximized }) => {
        finishMotion(el);
        el.style.transformOrigin = "";
        if (window.innerWidth <= 768 || isMaximized || !el.style.width) return;
        this.fitWindow(el);
      });
    });
  }

  finishDrag() {
    if (!this.dragState) return;
    const { win, left, top, frame } = this.dragState;
    if (frame !== null) cancelAnimationFrame(frame);
    win.style.left = `${left}px`;
    win.style.top = `${top}px`;
    win.style.transform = "none";
    this.dragState = null;
    document.body.classList.remove("window-dragging");
  }

  fitWindow(el) {
    if (window.innerWidth <= 768) return;
    const width = Math.min(parseFloat(el.style.width), window.innerWidth - 32);
    const height = Math.max(180, Math.min(parseFloat(el.style.height), window.innerHeight - 132));
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    el.style.left = `${Math.max(16, Math.min(parseFloat(el.style.left), window.innerWidth - width - 16))}px`;
    el.style.top = `${Math.max(40, Math.min(parseFloat(el.style.top), window.innerHeight - height - 92))}px`;
  }

  setupDock() {
    const dockItems = document.querySelectorAll(".macos-dock .dock-item[data-app]");
    dockItems.forEach(item => {
      item.addEventListener("click", (e) => {
        e.preventDefault();
        const app = item.dataset.app;
        if (app === "dashboard") {
          this.showDesktop();
        } else {
          this.toggleWindow(app);
        }
      });
    });

    // Rescan disks dock item (if present)
    const rescanBtn = document.getElementById("dockRescanBtn");
    if (rescanBtn) {
      rescanBtn.addEventListener("click", () => this.rescanDrives());
    }

    // Lock screen dock item (if present)
    const lockBtn = document.getElementById("dockLockBtn");
    if (lockBtn) {
      lockBtn.addEventListener("click", () => {
        this.lockScreen();
      });
    }
  }

  async rescanDrives() {
    try {
      showToast("Scanning storage devices...", "info");
      const devices = await api.refreshStorage();
      dashboardComponent.updateStorage(devices);
      fileManagerComponent.loadMountedDrives();
      showToast("Storage scan completed", "success");
    } catch (err) {
      showToast("Failed to refresh storage: " + err.message, "error");
    }
  }

  setupMenubar() {
    // Apple dropdown
    const appleTrigger = document.getElementById("appleMenuTrigger");
    const appleDropdown = document.getElementById("appleMenuDropdown");
    if (appleTrigger && appleDropdown) {
      appleTrigger.addEventListener("click", (e) => {
        e.stopPropagation();
        appleDropdown.classList.toggle("show");
      });
    }

    // Close any open menubar dropdowns when clicking outside
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".menubar-item")) {
        document.querySelectorAll(".macos-dropdown-menu.show").forEach(menu => {
          menu.classList.remove("show");
        });
      }
    });

    // Nav menus hover/click
    const navMenus = document.querySelectorAll(".menubar-nav-menu");
    navMenus.forEach(menu => {
      menu.addEventListener("click", (e) => {
        e.stopPropagation();
        const dropdown = menu.querySelector(".macos-dropdown-menu");
        if (dropdown) {
          const isOpen = dropdown.classList.contains("show");
          document.querySelectorAll(".macos-dropdown-menu.show").forEach(m => m.classList.remove("show"));
          if (!isOpen) dropdown.classList.add("show");
        }
      });
    });

    // Menubar actions
    document.querySelectorAll("[data-action]").forEach(el => {
      el.addEventListener("click", (e) => {
        const action = el.dataset.action;
        document.querySelectorAll(".macos-dropdown-menu.show").forEach(m => m.classList.remove("show"));
        this.handleAction(action);
      });
    });

    // About HomeDock modal trigger
    const aboutBtn = document.getElementById("menuAboutHomeDock");
    const aboutModal = document.getElementById("aboutHomeDockModal");
    if (aboutBtn && aboutModal) {
      aboutBtn.addEventListener("click", () => {
        openModal(aboutModal);
      });
    }

    // Lock Screen menu item
    const lockMenu = document.getElementById("menuLockScreen");
    if (lockMenu) {
      lockMenu.addEventListener("click", () => {
        this.lockScreen();
      });
    }

    // Logout menu item
    const logoutMenu = document.getElementById("menuLogout");
    if (logoutMenu) {
      logoutMenu.addEventListener("click", () => {
        const logoutBtn = document.getElementById("logoutBtn");
        if (logoutBtn) logoutBtn.click();
      });
    }
  }

  setupKeyboardShortcuts() {
    window.addEventListener("keydown", (e) => {
      // ⌘M or Ctrl+M to minimize active window
      if ((e.metaKey || e.ctrlKey) && e.key === "m" && this.activeWindow) {
        e.preventDefault();
        this.minimizeWindow(this.activeWindow);
      }
      // F11 or ⌘D to toggle Desktop
      if (e.key === "F11" || ((e.metaKey || e.ctrlKey) && e.key === "d")) {
        e.preventDefault();
        this.showDesktop();
      }
    });
  }

  async handleAction(action) {
    switch (action) {
      case "show-desktop":
        this.showDesktop();
        break;
      case "open-files":
        this.openWindow("files");
        break;
      case "open-downloads":
        this.openWindow("downloads");
        break;
      case "open-settings":
        this.openWindow("settings");
        break;
      case "new-download":
        if (await this.openWindow("downloads") && this.activeWindow === "downloads") {
          document.getElementById("openAddDownloadModalBtn")?.click();
        }
        break;
      case "upload-file":
        if (await this.openWindow("files") && this.activeWindow === "files") {
          document.getElementById("fmUploadBtn")?.click();
        }
        break;
      case "new-folder":
        if (await this.openWindow("files") && this.activeWindow === "files") {
          document.getElementById("fmNewFolderBtn")?.click();
        }
        break;
      case "rescan-drives":
        this.rescanDrives();
        break;
      case "minimize-all":
        this.showDesktop();
        break;
      case "zoom-window":
        if (this.activeWindow) this.toggleMaximizeWindow(this.activeWindow);
        break;
      case "refresh-view":
        if (this.activeWindow === "files") fileManagerComponent.refresh();
        else if (this.activeWindow === "downloads") downloadManagerComponent.refresh();
        else if (this.activeWindow === "settings") settingsComponent.refresh();
        else api.getStorageDevices().then(d => dashboardComponent.updateStorage(d));
        break;
    }
  }

  toggleWindow(id) {
    const winObj = this.windows[id];
    if (!winObj) {
      console.warn("Window not found:", id);
      return;
    }

    if (!winObj.isOpen) {
      this.openWindow(id);
    } else if (winObj.isMinimized) {
      this.restoreWindow(id);
    } else if (this.activeWindow === id) {
      this.minimizeWindow(id);
    } else {
      this.focusWindow(id);
    }
  }

  openWindow(id) {
    const winObj = this.windows[id];
    if (!winObj) {
      console.warn("Window not found:", id);
      return;
    }

    if (winObj.isOpen) {
      if (winObj.isMinimized) this.restoreWindow(id);
      else this.focusWindow(id);
      return winObj.ready || Promise.resolve(true);
    }
    cancelMotion(winObj.el);
    winObj.el.style.transformOrigin = "";
    winObj.isOpen = true;
    const lifecycleSequence = winObj.lifecycleSequence = (winObj.lifecycleSequence || 0) + 1;
    winObj.isMinimized = false;
    winObj.el.classList.remove("minimized", "window-exiting");
    winObj.el.classList.add("active");
    winObj.el.style.display = "flex";
    winObj.el.inert = false;
    winObj.el.setAttribute("aria-hidden", "false");

    // Set centered bounds if not maximized
    if (!winObj.isMaximized) {
      if (!winObj.el.style.left || !winObj.el.style.width) {
        this.centerWindow(winObj.el);
      }
    }

    this.focusWindow(id);
    this.updateDockState();
    this.animateWindow(id, [
      { opacity: 0, transform: "translateY(18px) scale(0.96)" },
      { opacity: 1, transform: "none" },
    ], { duration: motion.enter });
    this.bounceDock(id);

    // Give the window's first frame time to paint before hydrating its content.
    winObj.ready = new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!winObj.isOpen || lifecycleSequence !== winObj.lifecycleSequence) {
        resolve(false);
        return;
      }
      const component = { files: fileManagerComponent, downloads: downloadManagerComponent, settings: settingsComponent }[id];
      if (!component) { resolve(true); return; }
      const initialized = component.initialized;
      Promise.resolve(component.init()).then(() => {
        if (initialized && id !== "files") return component.refresh();
      }).then(() => resolve(true)).catch(err => {
        console.error("Component init error:", id, err);
        resolve(false);
      });
      revealElements(winObj.el.querySelectorAll(".card, .dl-stat-card, .fm-toolbar, .dl-header"));
    })));
    return winObj.ready;
  }

  bounceDock(id) {
    const icon = document.querySelector(`.dock-item[data-app="${id}"] .dock-icon`);
    animateElement(icon, [
      { transform: "translateY(0)" }, { transform: "translateY(-12px)", offset: 0.4 },
      { transform: "translateY(0)", offset: 0.75 }, { transform: "translateY(-3px)", offset: 0.88 },
      { transform: "translateY(0)" },
    ], { duration: 420 });
  }

  animateWindow(id, frames, options = {}) {
    const win = this.windows[id];
    const sequence = win.motionSequence = (win.motionSequence || 0) + 1;
    win.el.classList.add("window-geometry-motion");
    return animateElement(win.el, frames, options).then(completed => {
      // An interrupted transition must not strip the next one's cached layer.
      if (sequence === win.motionSequence) win.el.classList.remove("window-geometry-motion");
      return completed;
    });
  }

  dockTransform(id) {
    const win = this.windows[id].el;
    const dock = document.querySelector(`.dock-item[data-app="${id}"]`);
    if (!dock) return "translateY(48px) scale(0.9)";
    const target = dock.getBoundingClientRect();
    // Use layout bounds, unaffected by an interrupted window animation.
    const x = target.left + target.width / 2 - (win.offsetLeft + win.offsetWidth * 0.18 / 2);
    const y = target.top + target.height / 2 - (win.offsetTop + win.offsetHeight * 0.18 / 2);
    return `translate(${x}px, ${y}px) scale(0.18)`;
  }

  centerWindow(el) {
    const winW = Math.min(Math.max(window.innerWidth * 0.88, 360), 1100);
    const winH = Math.max(180, Math.min(window.innerHeight - 132, 780));
    const left = Math.max(16, (window.innerWidth - winW) / 2);
    const top = Math.max(40, (window.innerHeight - winH) / 2);

    el.style.width = `${Math.round(winW)}px`;
    el.style.height = `${Math.round(winH)}px`;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  restoreWindow(id) {
    const winObj = this.windows[id];
    if (!winObj || !winObj.isOpen || !winObj.isMinimized) return;

    const from = getComputedStyle(winObj.el).transform;
    const opacity = getComputedStyle(winObj.el).opacity;
    const hidden = winObj.el.classList.contains("minimized");
    cancelMotion(winObj.el);
    winObj.isMinimized = false;
    winObj.el.classList.remove("minimized", "window-exiting");
    winObj.el.classList.add("active");
    winObj.el.style.display = "flex";
    winObj.el.inert = false;
    winObj.el.setAttribute("aria-hidden", "false");
    this.focusWindow(id);
    this.updateDockState();
    this.animateWindow(id, [
      { opacity: hidden ? 0 : opacity, transform: hidden ? this.dockTransform(id) : from },
      { opacity: 1, transform: "none" },
    ], { duration: motion.window });
  }

  closeWindow(id) {
    const winObj = this.windows[id];
    if (!winObj || !winObj.isOpen) return;
    this.finishDrag();

    const from = getComputedStyle(winObj.el).transform;
    const opacity = getComputedStyle(winObj.el).opacity;
    const minimized = winObj.isMinimized;
    winObj.isOpen = false;
    winObj.lifecycleSequence = (winObj.lifecycleSequence || 0) + 1;
    winObj.isMinimized = false;
    winObj.el.inert = true;
    winObj.el.setAttribute("aria-hidden", "true");
    winObj.el.classList.add("window-exiting");
    const hide = () => {
      if (winObj.isOpen) return;
      winObj.el.classList.remove("active", "minimized", "focused", "window-exiting");
      winObj.el.style.display = "none";
    };
    if (minimized) {
      cancelMotion(winObj.el);
      hide();
    } else {
      this.animateWindow(id, [
        { opacity, transform: from },
        { opacity: 0, transform: "translateY(8px) scale(0.97)" },
      ], { duration: motion.quick }).then(completed => { if (completed) hide(); });
    }

    // Clear active window
    if (this.activeWindow === id) {
      const remaining = Object.keys(this.windows).filter(wId => this.windows[wId].isOpen && !this.windows[wId].isMinimized);
      if (remaining.length > 0) {
        this.focusWindow(remaining[remaining.length - 1]);
      } else {
        this.activeWindow = null;
        this.setMenubarAppTitle("HomeDock");
      }
    }
    this.updateDockState();
  }

  minimizeWindow(id) {
    const winObj = this.windows[id];
    if (!winObj || !winObj.isOpen || winObj.isMinimized) return;
    this.finishDrag();

    const from = getComputedStyle(winObj.el).transform;
    const opacity = getComputedStyle(winObj.el).opacity;
    winObj.isMinimized = true;
    winObj.el.classList.add("window-exiting");
    winObj.el.classList.remove("focused");
    winObj.el.inert = true;
    winObj.el.setAttribute("aria-hidden", "true");
    this.animateWindow(id, [
      { opacity, transform: from },
      { opacity: 0, transform: this.dockTransform(id) },
    ], { duration: motion.standard }).then(completed => {
      if (completed && winObj.isOpen && winObj.isMinimized) {
        winObj.el.classList.add("minimized");
        winObj.el.classList.remove("window-exiting");
        winObj.el.style.display = "none";
      }
    });

    // Find next top open window to focus
    const remaining = Object.keys(this.windows).filter(wId => this.windows[wId].isOpen && !this.windows[wId].isMinimized);
    if (remaining.length > 0) {
      this.focusWindow(remaining[remaining.length - 1]);
    } else {
      this.activeWindow = null;
      this.setMenubarAppTitle("HomeDock");
    }
    this.updateDockState();
  }

  toggleMaximizeWindow(id) {
    const winObj = this.windows[id];
    if (!winObj || !winObj.isOpen || winObj.isMinimized) return;
    this.finishDrag();
    const before = winObj.el.getBoundingClientRect();
    cancelMotion(winObj.el);

    if (winObj.isMaximized) {
      // Restore previous bounds
      winObj.isMaximized = false;
      winObj.el.classList.remove("maximized");
      if (winObj.originalBounds) {
        winObj.el.style.left = winObj.originalBounds.left;
        winObj.el.style.top = winObj.originalBounds.top;
        winObj.el.style.width = winObj.originalBounds.width;
        winObj.el.style.height = winObj.originalBounds.height;
      } else {
        this.centerWindow(winObj.el);
      }
      this.fitWindow(winObj.el);
    } else {
      // Save current bounds & maximize
      winObj.originalBounds = {
        left: winObj.el.style.left,
        top: winObj.el.style.top,
        width: winObj.el.style.width,
        height: winObj.el.style.height
      };
      winObj.isMaximized = true;
      winObj.el.classList.add("maximized");
      winObj.el.style.left = "0px";
      winObj.el.style.top = "var(--menubar-height)";
      winObj.el.style.width = "100vw";
      winObj.el.style.height = "calc(100dvh - var(--menubar-height) - var(--dock-height) - 28px)";
    }
    const after = winObj.el.getBoundingClientRect();
    if (!after.width || !after.height) return;
    // Mobile windows already fill their available space; don't animate a no-op.
    if (["left", "top", "width", "height"].every(key => Math.abs(before[key] - after[key]) < 0.5)) return;
    // Set layout once, then animate the inverse transform on the compositor.
    this.animateWindow(id, [
      { transform: `translate(${before.left - after.left}px, ${before.top - after.top}px) scale(${before.width / after.width}, ${before.height / after.height})` },
      { transform: "none" },
    ], { duration: motion.window });
  }

  focusWindow(id) {
    const winObj = this.windows[id];
    if (!winObj || !winObj.isOpen || winObj.isMinimized) return;

    this.zIndexCounter += 2;
    winObj.el.style.zIndex = this.zIndexCounter;

    // Remove focused class from other windows
    Object.keys(this.windows).forEach(wId => {
      this.windows[wId].el.classList.toggle("focused", wId === id);
    });

    this.activeWindow = id;
    this.updateDockState();

    const titles = {
      files: "File Manager",
      downloads: "Download Manager",
      settings: "Settings",
    };
    this.setMenubarAppTitle(titles[id] || "HomeDock");
  }

  showDesktop() {
    // Minimize all open windows so user sees desktop metrics
    Object.keys(this.windows).forEach(id => {
      if (this.windows[id].isOpen && !this.windows[id].isMinimized) {
        this.minimizeWindow(id);
      }
    });
    this.activeWindow = null;
    this.setMenubarAppTitle("HomeDock");
    this.updateDockState();

    // Ensure dashboard metrics are rendered
    dashboardComponent.init();
    api.getStorageDevices().then(d => dashboardComponent.updateStorage(d));
  }

  setMenubarAppTitle(title) {
    const el = document.getElementById("menubarAppTitle");
    if (el) el.textContent = title;
  }

  updateDockState() {
    // Update active/running dots on dock items
    const dockItems = document.querySelectorAll(".macos-dock .dock-item[data-app]");
    dockItems.forEach(item => {
      const app = item.dataset.app;
      if (app === "dashboard") {
        item.classList.toggle("active", this.activeWindow === null);
      } else {
        const winObj = this.windows[app];
        const isRunning = winObj && winObj.isOpen;
        const isFocused = this.activeWindow === app;
        item.classList.toggle("running", isRunning);
        item.classList.toggle("active", isFocused);
      }
    });
  }

  lockScreen() {
    const authContainer = document.getElementById("authContainer");
    const appContainer = document.getElementById("appContainer");
    if (authContainer && appContainer) {
      showScreen("auth");
      const pwdInput = document.getElementById("loginPassword");
      if (pwdInput) {
        pwdInput.value = "";
        pwdInput.focus();
      }
    }
  }
}

export const windowManager = new WindowManager();
