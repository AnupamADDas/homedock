/**
 * HomeDock Main SPA Application Router & State Orchestrator.
 * Powered by macOS / UmbrelOS Desktop Architecture.
 */

import { api, showToast } from "./api.js";
import { wsManager } from "./ws.js";
import { headerComponent } from "./components/header.js";
import { dashboardComponent } from "./components/dashboard.js";
import { fileManagerComponent } from "./components/files.js";
import { downloadManagerComponent } from "./components/downloads.js";
import { settingsComponent } from "./components/settings.js";
import { folderBrowser } from "./components/folder_browser.js";
import { windowManager } from "./components/window_manager.js";
import { initMotion, showScreen, animateElement } from "./utils/motion.js";

class App {
  constructor() {
    this.currentView = "dashboard";
  }

  async init() {
    initMotion();
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
        animateElement(themeToggleBtn, [
          { transform: "rotate(-25deg) scale(0.85)" },
          { transform: "none" },
        ]);
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
        const submitButton = loginForm.querySelector("button[type=submit]");
        if (submitButton?.disabled) return;
        if (submitButton) {
          submitButton.disabled = true;
          submitButton.setAttribute("aria-busy", "true");
        }
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
            animateElement(lockCard, [
              { transform: "translateX(0)" }, { transform: "translateX(-6px)" },
              { transform: "translateX(6px)" }, { transform: "translateX(-4px)" },
              { transform: "translateX(4px)" }, { transform: "translateX(0)" },
            ], { duration: 360, easing: "ease-in-out" });
          }
        } finally {
          if (submitButton) {
            submitButton.disabled = false;
            submitButton.removeAttribute("aria-busy");
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
    showScreen("auth");
  }

  showAppView(user) {
    showScreen("app");

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
