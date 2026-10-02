/**
 * HomeDock macOS Window Manager & Desktop Environment Controller.
 * Implements macOS/UmbrelOS window lifecycle, dock management, titlebar dragging,
 * traffic light controls, live menu bar clock, and desktop state.
 */

import { fileManagerComponent } from "./files.js?v=macos_motion_v8";
import { downloadManagerComponent } from "./downloads.js?v=macos_motion_v8";
import { settingsComponent } from "./settings.js?v=macos_motion_v8";
import { dashboardComponent } from "./dashboard.js?v=macos_motion_v8";
import { api, showToast } from "../api.js?v=macos_motion_v8";

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
    this.setupModals();
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
        isClosing: false,
        isMinimizing: false,
        originalBounds: null
      };

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

        titlebar.addEventListener("mousedown", (e) => {
          if (e.target.closest(".traffic-lights") || e.target.closest(".traffic-btn") || e.target.closest("button") || e.target.closest("input")) return;
          if (this.windows[id].isMaximized) return;

          this.focusWindow(id);
          const rect = win.getBoundingClientRect();
          this.dragState = {
            id,
            win,
            offsetX: e.clientX - rect.left,
            offsetY: e.clientY - rect.top,
          };
          document.body.classList.add("window-dragging");
        });
      }
    });

    // Global drag handlers
    window.addEventListener("mousemove", (e) => {
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

      win.style.left = `${left}px`;
      win.style.top = `${top}px`;
      win.style.transform = "none";
    });

    window.addEventListener("mouseup", () => {
      if (this.dragState) {
        this.dragState = null;
        document.body.classList.remove("window-dragging");
      }
    });
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

    this.setupDockMagnification();

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

  bounceDockIcon(appId) {
    const item = document.querySelector(`.macos-dock .dock-item[data-app="${appId}"]`);
    if (item) {
      item.style.transform = "";
      item.classList.remove("dock-bouncing");
      requestAnimationFrame(() => {
        item.classList.add("dock-bouncing");
        setTimeout(() => {
          item.classList.remove("dock-bouncing");
        }, 700);
      });
    }
  }

  setupDockMagnification() {
    const dock = document.querySelector(".macos-dock");
    if (!dock) return;

    const items = Array.from(dock.querySelectorAll(".dock-item"));
    const maxScale = 1.28;
    const maxDistance = 115;

    const resetScales = () => {
      items.forEach(item => {
        if (!item.classList.contains("dock-bouncing")) {
          item.style.transform = "";
        }
      });
    };

    let rafId = null;
    let pendingMouseX = null;

    const updateMagnification = () => {
      rafId = null;
      if (pendingMouseX === null) return;
      const mouseX = pendingMouseX;

      items.forEach(item => {
        if (item.classList.contains("dock-bouncing")) return;
        const rect = item.getBoundingClientRect();
        const itemCenterX = rect.left + rect.width / 2;
        const dist = Math.abs(mouseX - itemCenterX);

        if (dist < maxDistance) {
          const factor = Math.cos((dist / maxDistance) * (Math.PI / 2));
          const scale = 1 + (maxScale - 1) * factor;
          const translateY = -10 * factor;
          item.style.transform = `translateY(${translateY.toFixed(1)}px) scale(${scale.toFixed(3)})`;
        } else {
          item.style.transform = "";
        }
      });
    };

    dock.addEventListener("mousemove", (e) => {
      if (window.innerWidth <= 768) return;
      if (document.body.classList.contains("window-dragging")) return;

      pendingMouseX = e.clientX;
      if (!rafId) {
        rafId = requestAnimationFrame(updateMagnification);
      }
    });

    dock.addEventListener("mouseleave", () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      pendingMouseX = null;
      resetScales();
    });

    dock.addEventListener("click", () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      pendingMouseX = null;
      resetScales();
    });
  }

  setupModals() {
    // Intercept modal close buttons with smooth macOS sheet exit
    document.addEventListener("click", (e) => {
      const closeBtn = e.target.closest(".modal-close, [data-modal-close]");
      if (closeBtn) {
        const modal = closeBtn.closest(".modal-overlay");
        if (modal && modal.classList.contains("active") && !modal.classList.contains("closing")) {
          e.preventDefault();
          e.stopPropagation();
          modal.classList.add("closing");
          setTimeout(() => {
            modal.classList.remove("active", "closing");
          }, 180);
        }
      }
    }, true);

    // Backdrop click dismiss with animation
    document.addEventListener("click", (e) => {
      if (e.target.classList.contains("modal-overlay") && e.target.classList.contains("active") && !e.target.classList.contains("closing")) {
        const modal = e.target;
        modal.classList.add("closing");
        setTimeout(() => {
          modal.classList.remove("active", "closing");
        }, 180);
      }
    });

    // Escape key closes topmost active modal with animation
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const activeModals = Array.from(document.querySelectorAll(".modal-overlay.active:not(.closing)"));
        if (activeModals.length > 0) {
          const topModal = activeModals[activeModals.length - 1];
          if (topModal.id === "confirmDialogModal") return;
          topModal.classList.add("closing");
          setTimeout(() => {
            topModal.classList.remove("active", "closing");
          }, 180);
        }
      }
    });
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
        aboutModal.classList.add("active");
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

  handleAction(action) {
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
        this.openWindow("downloads");
        document.getElementById("openAddDownloadModalBtn")?.click();
        break;
      case "upload-file":
        this.openWindow("files");
        document.getElementById("fmUploadBtn")?.click();
        break;
      case "new-folder":
        this.openWindow("files");
        document.getElementById("fmNewFolderBtn")?.click();
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

    if (winObj.isMinimized) {
      this.restoreWindow(id);
      return;
    }

    const wasClosed = !winObj.isOpen || winObj.isClosing;

    winObj.isOpen = true;
    winObj.isMinimized = false;
    winObj.isClosing = false;
    winObj.isMinimizing = false;
    winObj.el.classList.remove("minimized", "closing", "minimizing", "restoring");
    winObj.el.classList.add("active");
    winObj.el.style.display = "flex";

    // Set centered bounds if not maximized
    if (!winObj.isMaximized) {
      if (!winObj.el.style.left || !winObj.el.style.width) {
        this.centerWindow(winObj.el);
      }
    }

    if (wasClosed) {
      winObj.el.classList.add("opening");
      this.bounceDockIcon(id);
      setTimeout(() => {
        winObj.el.classList.remove("opening");
      }, 190);
    }

    this.focusWindow(id);
    this.updateDockState();

    // Trigger component lifecycle asynchronously so window animation is never blocked
    const initComponent = () => {
      try {
        if (id === "files") {
          fileManagerComponent.init();
        } else if (id === "downloads") {
          downloadManagerComponent.init();
          downloadManagerComponent.fetchDefaultDir();
          downloadManagerComponent.refresh();
        } else if (id === "settings") {
          settingsComponent.init();
          settingsComponent.refresh();
        }
      } catch (err) {
        console.error("Component init error:", id, err);
      }
    };

    if (wasClosed) {
      // 60ms delay lets GPU begin the 180ms window appearance smoothly
      setTimeout(initComponent, 60);
    } else {
      initComponent();
    }
  }

  centerWindow(el) {
    const winW = Math.min(Math.max(window.innerWidth * 0.88, 360), 1100);
    const winH = Math.min(Math.max(window.innerHeight * 0.82, 320), 780);
    const left = Math.max(16, (window.innerWidth - winW) / 2);
    const top = Math.max(40, (window.innerHeight - winH) / 2);

    el.style.width = `${Math.round(winW)}px`;
    el.style.height = `${Math.round(winH)}px`;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  restoreWindow(id) {
    const winObj = this.windows[id];
    if (!winObj) return;

    winObj.isOpen = true;
    winObj.isMinimized = false;
    winObj.isMinimizing = false;
    winObj.isClosing = false;
    winObj.el.classList.remove("minimized", "minimizing", "closing", "opening", "flipping", "animating-bounds");
    winObj.el.classList.add("active");
    winObj.el.style.display = "flex";

    void winObj.el.offsetWidth; // Force reflow
    winObj.el.classList.add("restoring");

    this.focusWindow(id);
    this.updateDockState();

    setTimeout(() => {
      winObj.el.classList.remove("restoring");
    }, 190);
  }

  closeWindow(id) {
    const winObj = this.windows[id];
    if (!winObj || !winObj.isOpen || winObj.isClosing) return;

    winObj.isClosing = true;
    winObj.el.classList.remove("opening", "restoring", "flipping", "animating-bounds");
    void winObj.el.offsetWidth; // Force reflow
    winObj.el.classList.add("closing");
    winObj.el.classList.remove("focused");

    // Clear active window and focus remaining
    const remaining = Object.keys(this.windows).filter(wId => wId !== id && this.windows[wId].isOpen && !this.windows[wId].isMinimized && !this.windows[wId].isClosing);
    if (this.activeWindow === id) {
      if (remaining.length > 0) {
        this.focusWindow(remaining[remaining.length - 1]);
      } else {
        this.activeWindow = null;
        this.setMenubarAppTitle("HomeDock");
      }
    }
    this.updateDockState();

    setTimeout(() => {
      if (winObj.isClosing) {
        winObj.isOpen = false;
        winObj.isClosing = false;
        winObj.isMinimized = false;
        winObj.el.classList.remove("active", "closing", "minimized", "focused");
        winObj.el.style.display = "none";
        this.updateDockState();
      }
    }, 170);
  }

  minimizeWindow(id) {
    const winObj = this.windows[id];
    if (!winObj || !winObj.isOpen || winObj.isMinimized || winObj.isMinimizing || winObj.isClosing) return;

    winObj.isMinimizing = true;
    winObj.el.classList.remove("opening", "restoring", "flipping", "animating-bounds");

    void winObj.el.offsetWidth; // Force reflow
    winObj.el.classList.add("minimizing");
    winObj.el.classList.remove("focused");

    const remaining = Object.keys(this.windows).filter(wId => wId !== id && this.windows[wId].isOpen && !this.windows[wId].isMinimized && !this.windows[wId].isMinimizing && !this.windows[wId].isClosing);
    if (this.activeWindow === id) {
      if (remaining.length > 0) {
        this.focusWindow(remaining[remaining.length - 1]);
      } else {
        this.activeWindow = null;
        this.setMenubarAppTitle("HomeDock");
      }
    }
    this.updateDockState();

    setTimeout(() => {
      if (winObj.isMinimizing) {
        winObj.isMinimized = true;
        winObj.isMinimizing = false;
        winObj.el.classList.remove("minimizing");
        winObj.el.classList.add("minimized");
        winObj.el.style.display = "none";
        this.updateDockState();
      }
    }, 190);
  }

  toggleMaximizeWindow(id) {
    const winObj = this.windows[id];
    if (!winObj || winObj.isMinimizing || winObj.isClosing) return;

    if (winObj.isMaximizing) return;
    winObj.isMaximizing = true;

    const willMaximize = !winObj.isMaximized;

    // 1. FIRST: Capture starting visual rect
    const firstRect = {
      left: winObj.el.offsetLeft,
      top: winObj.el.offsetTop,
      width: winObj.el.offsetWidth,
      height: winObj.el.offsetHeight
    };

    // 2. LAST: Apply target dimension bounds
    winObj.el.classList.remove("flipping", "opening", "restoring", "closing", "minimizing");

    if (willMaximize) {
      winObj.originalBounds = {
        left: winObj.el.style.left,
        top: winObj.el.style.top,
        width: winObj.el.style.width,
        height: winObj.el.style.height
      };
      winObj.isMaximized = true;
      winObj.el.classList.add("maximized");
      winObj.el.style.left = "0px";
      winObj.el.style.top = "30px";
      winObj.el.style.width = "100vw";
      winObj.el.style.height = "calc(100vh - 30px)";
    } else {
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
    }

    const lastRect = {
      left: winObj.el.offsetLeft,
      top: winObj.el.offsetTop,
      width: winObj.el.offsetWidth,
      height: winObj.el.offsetHeight
    };

    // 3. INVERT: Calculate delta and scale factors
    const deltaX = firstRect.left - lastRect.left;
    const deltaY = firstRect.top - lastRect.top;
    const scaleX = firstRect.width / (lastRect.width || 1);
    const scaleY = firstRect.height / (lastRect.height || 1);

    // Apply inverted transform immediately with no transition
    winObj.el.classList.add("flipping");
    winObj.el.style.transformOrigin = "0 0";
    winObj.el.style.transform = `translate(${deltaX}px, ${deltaY}px) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)})`;
    winObj.el.style.transition = "none";

    // Force commit initial inverted position
    void winObj.el.offsetWidth;

    // 4. PLAY: Smoothly transition to identity on GPU
    requestAnimationFrame(() => {
      winObj.el.style.transition = "transform 0.18s cubic-bezier(0.16, 1, 0.3, 1)";
      winObj.el.style.transform = "translate(0px, 0px) scale(1, 1)";
    });

    setTimeout(() => {
      winObj.el.classList.remove("flipping");
      winObj.el.style.transition = "";
      winObj.el.style.transform = "";
      winObj.el.style.transformOrigin = "";
      winObj.isMaximizing = false;
    }, 200);
  }

  focusWindow(id) {
    const winObj = this.windows[id];
    if (!winObj) return;

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
      authContainer.classList.remove("unlocking");
      authContainer.classList.add("locking");
      authContainer.style.display = "flex";
      const pwdInput = document.getElementById("loginPassword");
      if (pwdInput) {
        pwdInput.value = "";
        pwdInput.focus();
      }
      setTimeout(() => {
        appContainer.style.display = "none";
        authContainer.classList.remove("locking");
      }, 350);
    }
  }
}

export const windowManager = new WindowManager();
