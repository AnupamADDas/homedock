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
import { updateAlertBadge } from "./utils/alerts.js";

class App {
  constructor() {
    this.currentView = "dashboard";
  }

  /** Give icon-only buttons an accessible name from their title (or tooltip). */
  labelIconButtons(root = document) {
    root.querySelectorAll?.("button[title]:not([aria-label]), a[title]:not([aria-label])").forEach(el => {
      if (!el.textContent.trim()) el.setAttribute("aria-label", el.getAttribute("title"));
    });
  }

  async init() {
    this.labelIconButtons();
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach(node => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          if (node.matches?.("button[title]:not([aria-label]), a[title]:not([aria-label])") && !node.textContent.trim()) {
            node.setAttribute("aria-label", node.getAttribute("title"));
          }
          this.labelIconButtons(node);
        });
      }
    }).observe(document.body, { childList: true, subtree: true });
    initMotion();
    this.setupTheme();
    this.setupEventListeners();
    windowManager.init();
    folderBrowser.init();
    await this.checkAuth();
  }

  setupTheme() {
    const savedTheme = localStorage.getItem("homedock_theme") || "light";
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
    try {
      localStorage.removeItem("homedock_username");
    } catch (_) {}

    const DEFAULT_LOCK_ICON = '<svg viewBox="0 0 24 24" width="38" height="38" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: block; margin: auto;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>';
    const unameInput = document.getElementById("loginUsername");
    const lockName = document.getElementById("lockUserName");
    const lockInitial = document.getElementById("lockUserAvatarInitial");

    if (unameInput) unameInput.value = "";
    if (lockName) lockName.textContent = "Sign In";
    if (lockInitial) lockInitial.innerHTML = DEFAULT_LOCK_ICON;

    if (unameInput) {
      unameInput.addEventListener("input", (e) => {
        const val = e.target.value.trim();
        if (lockName) lockName.textContent = val || "Sign In";
        if (lockInitial) {
          if (val) {
            lockInitial.textContent = val.charAt(0).toUpperCase();
          } else {
            lockInitial.innerHTML = DEFAULT_LOCK_ICON;
          }
        }
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
        const user = document.getElementById("loginUsername")?.value.trim() || "";
        const pass = document.getElementById("loginPassword").value;
        const errorEl = document.getElementById("loginErrorMsg");

        if (errorEl) errorEl.style.display = "none";

        if (!user || !pass) {
          if (errorEl) {
            errorEl.textContent = "Please enter both username and password";
            errorEl.style.display = "block";
          }
          if (submitButton) {
            submitButton.disabled = false;
            submitButton.removeAttribute("aria-busy");
          }
          return;
        }

        try {
          await api.login(user, pass);
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

    // Logout
    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", async () => {
        wsManager.disconnect();
        await api.logout();
        this.showAuthView();
      });
    }

    // "Show in Files" from the Download Manager
    window.addEventListener("homedock:show_in_files", async (e) => {
      const path = e.detail?.path;
      if (!path) return;
      await windowManager.openWindow("files");
      await fileManagerComponent.navigate(path);
    });

    // Live connection status pill
    window.addEventListener("homedock:ws_status", (e) => {
      const pill = document.getElementById("connStatusPill");
      if (!pill) return;
      const reconnecting = e.detail.state === "reconnecting";
      pill.hidden = !reconnecting;
      document.body.classList.toggle("live-data-stale", reconnecting);
      if (!reconnecting && this._wasReconnecting) showToast("Live connection restored", "success", 2000);
      this._wasReconnecting = reconnecting;
    });

    // Auth required event
    window.addEventListener("homedock:auth_required", () => {
      wsManager.disconnect();
      this.showAuthView();
    });

    // Real-time telemetry events from WebSocket
    window.addEventListener("homedock:telemetry", (e) => {
      const data = e.detail;
      updateAlertBadge(data);
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
    const unameInput = document.getElementById("loginUsername");
    const passInput = document.getElementById("loginPassword");
    const lockName = document.getElementById("lockUserName");
    const lockInitial = document.getElementById("lockUserAvatarInitial");
    const errorEl = document.getElementById("loginErrorMsg");

    if (unameInput) {
      unameInput.value = "";
      unameInput.focus();
    }
    if (passInput) passInput.value = "";
    if (errorEl) {
      errorEl.textContent = "";
      errorEl.style.display = "none";
    }
    if (lockName) lockName.textContent = "Sign In";
    if (lockInitial) {
      lockInitial.innerHTML = '<svg viewBox="0 0 24 24" width="38" height="38" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: block; margin: auto;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>';
    }
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
