/**
 * HomeDock Main SPA Application Router & State Orchestrator.
 */

import { api, showToast } from "./api.js";
import { wsManager } from "./ws.js";
import { headerComponent } from "./components/header.js";
import { dashboardComponent } from "./components/dashboard.js";
import { fileManagerComponent } from "./components/files.js";
import { downloadManagerComponent } from "./components/downloads.js";
import { settingsComponent } from "./components/settings.js";
import { folderBrowser } from "./components/folder_browser.js";

class App {
  constructor() {
    this.currentView = "dashboard";
  }

  async init() {
    this.setupTheme();
    this.setupEventListeners();
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
    // Navigation items
    const navItems = document.querySelectorAll(".nav-item[data-view]");
    navItems.forEach(item => {
      item.addEventListener("click", (e) => {
        e.preventDefault();
        const view = item.dataset.view;
        this.switchView(view);

        // Close mobile drawer if open
        const sidebar = document.getElementById("appSidebar");
        if (sidebar) sidebar.classList.remove("open");
      });
    });

    // Mobile nav toggle
    const mobileToggle = document.getElementById("mobileNavToggle");
    const sidebar = document.getElementById("appSidebar");
    if (mobileToggle && sidebar) {
      mobileToggle.addEventListener("click", () => {
        sidebar.classList.toggle("open");
      });
    }

    // Login Form Submit
    const loginForm = document.getElementById("loginForm");
    if (loginForm) {
      loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const user = document.getElementById("loginUsername").value.trim();
        const pass = document.getElementById("loginPassword").value;
        const errorEl = document.getElementById("loginErrorMsg");

        if (errorEl) errorEl.style.display = "none";

        try {
          await api.login(user, pass);
          loginForm.reset();
          await this.checkAuth();
        } catch (err) {
          if (errorEl) {
            errorEl.textContent = err.message;
            errorEl.style.display = "block";
          }
        }
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
        if (this.currentView === "dashboard") {
          dashboardComponent.updateMetrics(data.metrics);
        }
      }
      if (data.storage && this.currentView === "dashboard") {
        dashboardComponent.updateStorage(data.storage);
      }
      if (data.download_stats && this.currentView === "downloads") {
        downloadManagerComponent.updateLive(data.download_stats, data.downloads);
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
    document.getElementById("authContainer").style.display = "flex";
    document.getElementById("appContainer").style.display = "none";
  }

  showAppView(user) {
    document.getElementById("authContainer").style.display = "none";
    document.getElementById("appContainer").style.display = "flex";

    // Update user info in sidebar
    const nameEl = document.getElementById("sidebarUserName");
    const roleEl = document.getElementById("sidebarUserRole");
    const avatarEl = document.getElementById("sidebarUserAvatar");

    if (nameEl) nameEl.textContent = user.username;
    if (roleEl) roleEl.textContent = user.role;
    if (avatarEl) avatarEl.textContent = user.username.charAt(0).toUpperCase();

    // Toggle admin-only navigation
    const adminNavs = document.querySelectorAll(".admin-nav-item");
    adminNavs.forEach(el => {
      el.style.display = user.role === "admin" ? "flex" : "none";
    });
  }

  switchView(viewName) {
    this.currentView = viewName;

    // Update Nav
    document.querySelectorAll(".nav-item[data-view]").forEach(item => {
      item.classList.toggle("active", item.dataset.view === viewName);
    });

    // Update View DOM
    document.querySelectorAll(".view-section").forEach(sec => {
      sec.classList.remove("active");
    });

    const activeView = document.getElementById(`${viewName}View`);
    if (activeView) activeView.classList.add("active");

    // Initialize/Refresh component
    if (viewName === "dashboard") {
      dashboardComponent.init();
      api.getStorageDevices().then(d => dashboardComponent.updateStorage(d));
    } else if (viewName === "files") {
      fileManagerComponent.init();
    } else if (viewName === "downloads") {
      downloadManagerComponent.init();
      downloadManagerComponent.fetchDefaultDir();
      downloadManagerComponent.refresh();
    } else if (viewName === "settings") {
      settingsComponent.init();
      settingsComponent.refresh();
    }
  }
}

export const app = new App();
window.addEventListener("DOMContentLoaded", () => app.init());
