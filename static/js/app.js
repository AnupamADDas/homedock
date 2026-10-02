/**
 * HomeDock Main SPA Application Router & State Orchestrator.
 * Powered by macOS / UmbrelOS Desktop Architecture.
 */

import { api, showToast } from "./api.js?v=macos_motion_v6";
import { wsManager } from "./ws.js?v=macos_motion_v6";
import { headerComponent } from "./components/header.js?v=macos_motion_v6";
import { dashboardComponent } from "./components/dashboard.js?v=macos_motion_v6";
import { fileManagerComponent } from "./components/files.js?v=macos_motion_v6";
import { downloadManagerComponent } from "./components/downloads.js?v=macos_motion_v6";
import { settingsComponent } from "./components/settings.js?v=macos_motion_v6";
import { folderBrowser } from "./components/folder_browser.js?v=macos_motion_v6";
import { windowManager } from "./components/window_manager.js?v=macos_motion_v6";

class App {
  constructor() {
    this.currentView = "dashboard";
  }

  async init() {
    this.setupTheme();
    this.setupEventListeners();
    windowManager.init();
    folderBrowser.init();
    await this.checkAuth();
  }

  setupTheme() {
    const savedTheme = localStorage.getItem("homedock_theme") || "dark";
    document.documentElement.setAttribute("data-theme", savedTheme);
    this.updateThemeIcon(savedTheme);

    const themeToggleBtn = document.getElementById("themeToggleBtn");
    if (themeToggleBtn) {
      themeToggleBtn.addEventListener("click", () => {
        const current = document.documentElement.getAttribute("data-theme");
        const next = current === "light" ? "dark" : "light";
        document.documentElement.setAttribute("data-theme", next);
        localStorage.setItem("homedock_theme", next);
        this.updateThemeIcon(next);
      });
    }
  }

  updateThemeIcon(theme) {
    const sun = document.getElementById("themeSunIcon");
    const moon = document.getElementById("themeMoonIcon");
    if (sun && moon) {
      if (theme === "light") {
        sun.style.display = "none";
        moon.style.display = "block";
      } else {
        sun.style.display = "block";
        moon.style.display = "none";
      }
    }
  }

  setupEventListeners() {
    // Mobile nav toggle fallback
    const mobileToggle = document.getElementById("mobileNavToggle");
    const sidebar = document.getElementById("appSidebar");
    if (mobileToggle && sidebar) {
      mobileToggle.addEventListener("click", () => {
        sidebar.classList.toggle("open");
      });
    }

    // Setup Lock Screen Username and initial
    const savedUser = localStorage.getItem("homedock_username") || "anupam";
    const unameInput = document.getElementById("loginUsername");
    const lockName = document.getElementById("lockUserName");
    const lockInitial = document.getElementById("lockUserAvatarInitial");

    if (unameInput) unameInput.value = savedUser;
    if (lockName) lockName.textContent = savedUser;
    if (lockInitial) lockInitial.textContent = savedUser.charAt(0).toUpperCase();

    if (unameInput) {
      unameInput.addEventListener("input", (e) => {
        const val = e.target.value.trim();
        if (lockName) lockName.textContent = val || "User";
        if (lockInitial) lockInitial.textContent = (val || "U").charAt(0).toUpperCase();
      });
    }

    // Login Form Submit (macOS Lock Screen)
    const loginForm = document.getElementById("loginForm");
    if (loginForm) {
      loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const user = document.getElementById("loginUsername")?.value.trim() || "anupam";
        const pass = document.getElementById("loginPassword").value;
        const errorEl = document.getElementById("loginErrorMsg");

        if (errorEl) errorEl.style.display = "none";

        try {
          await api.login(user, pass);
          localStorage.setItem("homedock_username", user);
          document.getElementById("loginPassword").value = "";
          await this.checkAuth();
        } catch (err) {
          if (errorEl) {
            errorEl.textContent = err.message;
            errorEl.style.display = "block";
          }
          const lockCard = document.querySelector(".macos-lock-card");
          if (lockCard) {
            lockCard.classList.remove("shake");
            void lockCard.offsetWidth; // Reflow for animation trigger
            lockCard.classList.add("shake");
          }
        }
      });
    }

    // Power buttons on lock screen
    const sleepBtn = document.getElementById("lockSleepBtn");
    if (sleepBtn) {
      sleepBtn.addEventListener("click", () => {
        showToast("Display sleep mode activated", "info");
      });
    }

    const restartBtn = document.getElementById("lockRestartBtn");
    if (restartBtn) {
      restartBtn.addEventListener("click", () => {
        showToast("HomeDock server is active and running", "info");
      });
    }

    const shutdownBtn = document.getElementById("lockShutdownBtn");
    if (shutdownBtn) {
      shutdownBtn.addEventListener("click", () => {
        showToast("Server shutdown requires administrator console access", "info");
      });
    }

    // Logout
    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", async () => {
        wsManager.disconnect();
        await api.logout();
        this.showAuthView();
      });
    }

    // Auth required event
    window.addEventListener("homedock:auth_required", () => {
      wsManager.disconnect();
      this.showAuthView();
    });

    // Real-time telemetry events from WebSocket
    window.addEventListener("homedock:telemetry", (e) => {
      const data = e.detail;
      if (data.metrics) {
        headerComponent.update(data.metrics);
        dashboardComponent.updateMetrics(data.metrics);
      }
      if (data.storage) {
        dashboardComponent.updateStorage(data.storage);
      }
      if (data.download_stats) {
        downloadManagerComponent.updateLive(data.download_stats, data.downloads);
        const badge = document.getElementById("dockDownloadBadge");
        if (badge) {
          const active = (data.download_stats.num_active !== undefined) ? data.download_stats.num_active : (data.download_stats.numActive || 0);
          if (active > 0) {
            badge.textContent = active;
            badge.style.display = "inline-flex";
          } else {
            badge.style.display = "none";
          }
        }
      }
    });

    // Initial state event from WebSocket
    window.addEventListener("homedock:initial_state", (e) => {
      const data = e.detail;
      if (data.metrics) {
        headerComponent.update(data.metrics);
        dashboardComponent.updateMetrics(data.metrics);
      }
      if (data.storage) {
        dashboardComponent.updateStorage(data.storage);
      }
      if (data.download_stats && data.downloads) {
        downloadManagerComponent.updateLive(data.download_stats, data.downloads);
      }
    });

    // Storage change event (Hot-plug!)
    window.addEventListener("homedock:storage_update", (e) => {
      const devices = e.detail;
      dashboardComponent.updateStorage(devices);
      fileManagerComponent.loadMountedDrives();
      showToast("Storage device change detected", "info");
    });

    // User profile update event (e.g., username change)
    window.addEventListener("homedock:user_updated", (e) => {
      if (e.detail && e.detail.user) {
        this.showAppView(e.detail.user);
      }
    });
  }

  async checkAuth() {
    if (!api.token) {
      this.showAuthView();
      return;
    }

    try {
      const user = await api.getMe();
      this.showAppView(user);
      wsManager.connect();
      this.switchView("dashboard");
    } catch (e) {
      this.showAuthView();
    }
  }

  showAuthView() {
    const authContainer = document.getElementById("authContainer");
    const appContainer = document.getElementById("appContainer");
    if (authContainer && appContainer) {
      authContainer.classList.remove("unlocking");
      authContainer.classList.add("locking");
      authContainer.style.display = "flex";
      setTimeout(() => {
        appContainer.style.display = "none";
        authContainer.classList.remove("locking");
      }, 350);
    }
  }

  showAppView(user) {
    const authContainer = document.getElementById("authContainer");
    const appContainer = document.getElementById("appContainer");

    if (authContainer && authContainer.style.display !== "none") {
      authContainer.classList.add("unlocking");
      if (appContainer) {
        appContainer.style.display = "flex";
        appContainer.classList.add("desktop-entering");
      }

      setTimeout(() => {
        if (authContainer) {
          authContainer.style.display = "none";
          authContainer.classList.remove("unlocking");
        }
        if (appContainer) {
          appContainer.classList.remove("desktop-entering");
        }
      }, 380);
    } else {
      if (authContainer) authContainer.style.display = "none";
      if (appContainer) appContainer.style.display = "flex";
    }

    // Update user info across navigation, menubar & lock screen
    const nameEl = document.getElementById("sidebarUserName");
    const roleEl = document.getElementById("sidebarUserRole");
    const avatarEl = document.getElementById("sidebarUserAvatar");
    const lockNameEl = document.getElementById("lockUserName");
    const lockInitialEl = document.getElementById("lockUserAvatarInitial");
    const menuLogoutUname = document.getElementById("menuLogoutUsername");

    if (nameEl) nameEl.textContent = user.username;
    if (roleEl) roleEl.textContent = user.role;
    if (avatarEl) avatarEl.textContent = user.username.charAt(0).toUpperCase();
    if (lockNameEl) lockNameEl.textContent = user.username;
    if (lockInitialEl) lockInitialEl.textContent = user.username.charAt(0).toUpperCase();
    if (menuLogoutUname) menuLogoutUname.textContent = user.username;

    // Toggle admin-only sections
    const adminSections = document.querySelectorAll(".admin-only-section");
    adminSections.forEach(el => {
      el.style.display = user.role === "admin" ? "block" : "none";
    });
  }

  switchView(viewName) {
    this.currentView = viewName;
    if (viewName === "dashboard") {
      windowManager.showDesktop();
    } else {
      windowManager.openWindow(viewName);
    }
  }
}

export const app = new App();
window.addEventListener("DOMContentLoaded", () => app.init());
