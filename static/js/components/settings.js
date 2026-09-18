/**
 * Settings & RBAC User Administration Component for HomeDock.
 */

import { api, showToast } from "../api.js";
import { folderBrowser } from "./folder_browser.js";
import { showConfirmDialog } from "./confirm_dialog.js";

export class SettingsComponent {
  constructor() {
    this.settings = {};
    this.users = [];
    this.allowedRoots = [];
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    this.setupEventListeners();
    await this.refresh();
    this.initialized = true;
  }

  setupEventListeners() {
    // Browse Default Download Directory Button
    const browseDlBtn = document.getElementById("btnBrowseDefaultDlDir");
    if (browseDlBtn) {
      browseDlBtn.addEventListener("click", () => {
        const dlInput = document.getElementById("settingDefaultDlDir");
        folderBrowser.open({
          title: "Select Default Download Directory",
          initialPath: dlInput ? dlInput.value.trim() : null,
          onSelect: async (selectedPath) => {
            if (dlInput) dlInput.value = selectedPath;
            try {
              await api.setDefaultDownloadDir(selectedPath);
              window.dispatchEvent(new CustomEvent("homedock:default_dir_changed", { detail: { dir: selectedPath } }));
              showToast(`Default download directory saved: ${selectedPath}`, "success");
              await this.refresh();
            } catch (err) {
              showToast(`Failed to update default directory: ${err.message}`, "error");
            }
          }
        });
      });
    }

    // Add Allowed Storage Root Button (Browse)
    const addRootBtn = document.getElementById("btnAddAllowedRoot");
    if (addRootBtn) {
      addRootBtn.addEventListener("click", () => {
        folderBrowser.open({
          title: "Select Storage Location to Allow",
          onSelect: async (selectedPath) => {
            try {
              const res = await api.addAllowedRoot(selectedPath);
              this.allowedRoots = res.global_allowed_roots || [];
              this.renderAllowedRootsList();
              window.dispatchEvent(new CustomEvent("homedock:roots_changed", { detail: { roots: this.allowedRoots } }));
              showToast(`Added and saved "${selectedPath}" to allowed storage roots`, "success");
            } catch (err) {
              showToast(err.message || "Failed to add storage root", "error");
            }
          }
        });
      });
    }

    // Add Allowed Storage Root (Manual Path Input)
    const manualInput = document.getElementById("inputManualAllowedRoot");
    const addManualBtn = document.getElementById("btnAddManualRoot");
    if (manualInput && addManualBtn) {
      const handleAddManual = async () => {
        const val = manualInput.value.trim();
        if (!val) {
          showToast("Please enter a valid directory path", "warning");
          return;
        }
        try {
          const res = await api.addAllowedRoot(val);
          this.allowedRoots = res.global_allowed_roots || [];
          manualInput.value = "";
          this.renderAllowedRootsList();
          window.dispatchEvent(new CustomEvent("homedock:roots_changed", { detail: { roots: this.allowedRoots } }));
          showToast(`Added and saved "${res.added || val}" to allowed storage roots`, "success");
        } catch (err) {
          showToast(err.message || "Failed to add storage root", "error");
        }
      };

      addManualBtn.addEventListener("click", handleAddManual);
      manualInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          handleAddManual();
        }
      });
    }

    // Save App Settings Form
    const appSettingsForm = document.getElementById("appSettingsForm");
    if (appSettingsForm) {
      appSettingsForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const dlDir = document.getElementById("settingDefaultDlDir").value.trim();
        const roots = [...this.allowedRoots];

        if (dlDir && !roots.includes(dlDir)) {
          roots.push(dlDir);
          this.allowedRoots = roots;
        }

        const payload = {
          global_allowed_roots: roots,
        };
        if (dlDir) {
          payload.default_download_dir = dlDir;
        }

        try {
          await api.updateSettings(payload);
          if (dlDir) {
            window.dispatchEvent(new CustomEvent("homedock:default_dir_changed", { detail: { dir: dlDir } }));
          }
          window.dispatchEvent(new CustomEvent("homedock:roots_changed", { detail: { roots } }));
          showToast("Configuration saved successfully", "success");
          await this.refresh();
        } catch (err) {
          showToast(err.message || "Failed to save configuration", "error");
        }
      });
    }

    // Change Username Form
    const changeUnameForm = document.getElementById("changeUsernameForm");
    if (changeUnameForm) {
      changeUnameForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const newUname = document.getElementById("unameNew").value.trim();
        const pwd = document.getElementById("unamePwd").value;

        if (!newUname) {
          showToast("Please provide a valid username", "error");
          return;
        }

        try {
          const res = await api.changeUsername(newUname, pwd);
          showToast("Username updated successfully", "success");
          document.getElementById("unameNew").value = "";
          document.getElementById("unamePwd").value = "";
          const currDisp = document.getElementById("currentUsernameDisplay");
          if (currDisp) currDisp.value = res.user.username;
          window.dispatchEvent(new CustomEvent("homedock:user_updated", { detail: { user: res.user } }));
          if (res.user.role === "admin") {
            await this.refreshUsers();
          }
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    }

    // Change Password Form
    const changePwdForm = document.getElementById("changePasswordForm");
    if (changePwdForm) {
      changePwdForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const oldPwd = document.getElementById("pwdOld").value;
        const newPwd = document.getElementById("pwdNew").value;
        const confirmPwd = document.getElementById("pwdConfirm").value;

        if (newPwd !== confirmPwd) {
          showToast("New passwords do not match", "error");
          return;
        }

        try {
          await api.changePassword(oldPwd, newPwd);
          showToast("Password updated successfully", "success");
          changePwdForm.reset();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    }

    // Create User Form
    const createUserBtn = document.getElementById("openCreateUserModalBtn");
    const createUserModal = document.getElementById("createUserModal");
    const closeCreateUserBtn = document.getElementById("closeCreateUserModalBtn");
    const createUserForm = document.getElementById("createUserForm");

    if (createUserBtn && createUserModal) {
      createUserBtn.addEventListener("click", () => createUserModal.classList.add("active"));
    }

    if (closeCreateUserBtn && createUserModal) {
      closeCreateUserBtn.addEventListener("click", () => createUserModal.classList.remove("active"));
    }

    if (createUserForm && createUserModal) {
      createUserForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const uName = document.getElementById("newUsername").value.trim();
        const uPass = document.getElementById("newUserPassword").value;
        const uRole = document.getElementById("newUserRole").value;
        const uRootsText = document.getElementById("newUserRoots").value.trim();
        const uRoots = uRootsText ? uRootsText.split("\n").map(r => r.trim()).filter(Boolean) : null;

        try {
          await api.createUser({
            username: uName,
            password: uPass,
            role: uRole,
            allowed_roots: uRoots,
          });
          showToast("User created successfully", "success");
          createUserModal.classList.remove("active");
          createUserForm.reset();
          await this.refreshUsers();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    }

    // Edit User Modal & Form
    const editUserModal = document.getElementById("editUserModal");
    const closeEditUserBtn = document.getElementById("closeEditUserModalBtn");
    const editUserForm = document.getElementById("editUserForm");

    if (closeEditUserBtn && editUserModal) {
      closeEditUserBtn.addEventListener("click", () => editUserModal.classList.remove("active"));
    }

    if (editUserForm && editUserModal) {
      editUserForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const userId = parseInt(document.getElementById("editUserId").value, 10);
        const uName = document.getElementById("editUsername").value.trim();
        const uRole = document.getElementById("editUserRole").value;
        const uActive = document.getElementById("editUserActive").value === "1";
        const uPass = document.getElementById("editUserPassword").value;
        const uRootsText = document.getElementById("editUserRoots").value.trim();
        const uRoots = uRootsText ? uRootsText.split("\n").map(r => r.trim()).filter(Boolean) : null;

        const payload = {
          username: uName,
          role: uRole,
          is_active: uActive,
          allowed_roots: uRoots,
        };
        if (uPass) {
          payload.password = uPass;
        }

        try {
          await api.updateUser(userId, payload);
          showToast("User updated successfully", "success");
          editUserModal.classList.remove("active");
          editUserForm.reset();
          await this.refreshUsers();

          // In case current logged-in user details changed
          const me = await api.getMe();
          const currDisp = document.getElementById("currentUsernameDisplay");
          if (currDisp) currDisp.value = me.username;
          window.dispatchEvent(new CustomEvent("homedock:user_updated", { detail: { user: me } }));
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    }
  }

  async refresh() {
    try {
      const user = await api.getMe();
      const currDisp = document.getElementById("currentUsernameDisplay");
      if (currDisp) currDisp.value = user.username;

      const isAdmin = user.role === "admin";

      const adminSections = document.querySelectorAll(".admin-only-section");
      adminSections.forEach(sec => {
        sec.style.display = isAdmin ? "block" : "none";
      });

      if (isAdmin) {
        const settings = await api.getSettings();
        this.settings = settings;
        this.populateSettingsForm(settings);
        await this.refreshUsers();
      }
    } catch (e) {
      console.warn("Failed to load settings:", e);
    }
  }

  populateSettingsForm(settings) {
    const dlDirInput = document.getElementById("settingDefaultDlDir");
    const rootsInput = document.getElementById("settingAllowedRoots");

    if (dlDirInput && settings.default_download_dir) {
      dlDirInput.value = settings.default_download_dir;
    }

    if (settings.global_allowed_roots) {
      this.allowedRoots = Array.isArray(settings.global_allowed_roots)
        ? [...settings.global_allowed_roots]
        : settings.global_allowed_roots.split("\n").map(r => r.trim()).filter(Boolean);
    } else {
      this.allowedRoots = [];
    }

    if (rootsInput) {
      rootsInput.value = this.allowedRoots.join("\n");
    }

    this.renderAllowedRootsList();
  }

  renderAllowedRootsList() {
    const container = document.getElementById("allowedRootsList");
    const rootsInput = document.getElementById("settingAllowedRoots");

    if (rootsInput) {
      rootsInput.value = this.allowedRoots.join("\n");
    }

    if (!container) return;

    if (this.allowedRoots.length === 0) {
      container.innerHTML = `
        <div style="color: var(--text-muted); font-size: 0.8rem; padding: 0.75rem; background: var(--bg-primary); border: 1px dashed var(--border-color); border-radius: var(--radius-sm); text-align: center;">
          No allowed storage roots configured. Click <strong>+ Add Folder</strong> to select a folder from server drives.
        </div>
      `;
      return;
    }

    container.innerHTML = this.allowedRoots.map(root => `
      <div class="allowed-root-chip">
        <div style="display: flex; align-items: center; gap: 0.6rem; overflow: hidden;">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-primary); flex-shrink: 0;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <span style="font-family: var(--font-mono); font-size: 0.84rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${root}">${root}</span>
        </div>
        <button type="button" class="btn btn-icon btn-sm text-danger btn-remove-root" data-path="${root}" title="Remove this location" style="padding: 0.25rem; border: none; background: none; cursor: pointer; display: flex; align-items: center; justify-content: center;">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    `).join("");

    container.querySelectorAll(".btn-remove-root").forEach(btn => {
      btn.addEventListener("click", async () => {
        const pathToRemove = btn.dataset.path;
        try {
          const res = await api.removeAllowedRoot(pathToRemove);
          this.allowedRoots = res.global_allowed_roots || [];
          this.renderAllowedRootsList();
          window.dispatchEvent(new CustomEvent("homedock:roots_changed", { detail: { roots: this.allowedRoots } }));
          showToast(`Removed "${pathToRemove}" from allowed roots`, "info");
        } catch (err) {
          showToast(err.message || "Failed to remove storage root", "error");
        }
      });
    });
  }

  async refreshUsers() {
    try {
      const users = await api.listUsers();
      this.users = users;
      this.renderUsersTable(users);
    } catch (e) {
      console.warn("Error loading users:", e);
    }
  }

  renderUsersTable(users) {
    const tbody = document.getElementById("usersTableBody");
    if (!tbody) return;

    tbody.innerHTML = users.map(u => {
      const roleBadge = u.role === "admin"
        ? `<span class="badge-tag badge-nvme">ADMIN</span>`
        : `<span class="badge-tag badge-usb">USER</span>`;
      
      const statusBadge = u.is_active
        ? `<span style="color: var(--color-success); font-size: 0.8rem;">● Active</span>`
        : `<span style="color: var(--color-danger); font-size: 0.8rem;">● Inactive</span>`;

      const rootsDisplay = u.allowed_roots
        ? (Array.isArray(u.allowed_roots) ? u.allowed_roots.join(", ") : u.allowed_roots)
        : `<em style="color: var(--text-muted);">Global default</em>`;

      return `
        <tr>
          <td><strong>${u.username}</strong></td>
          <td>${roleBadge}</td>
          <td style="font-size: 0.8rem; font-family: var(--font-mono);">${rootsDisplay}</td>
          <td>${statusBadge}</td>
          <td style="text-align: right;">
            <div style="display: inline-flex; gap: 0.35rem;">
              <button class="btn btn-secondary btn-sm btn-edit-user" data-id="${u.id}">
                Edit
              </button>
              <button class="btn btn-secondary btn-sm btn-toggle-active" data-id="${u.id}" data-active="${u.is_active}">
                ${u.is_active ? "Deactivate" : "Activate"}
              </button>
              <button class="btn btn-secondary btn-sm btn-delete-user text-danger" data-id="${u.id}" data-name="${u.username}">
                Delete
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join("");

    tbody.querySelectorAll(".btn-edit-user").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = parseInt(btn.dataset.id, 10);
        const user = this.users.find(u => u.id === id);
        if (!user) return;

        const editModal = document.getElementById("editUserModal");
        const editIdInput = document.getElementById("editUserId");
        const editUsernameInput = document.getElementById("editUsername");
        const editRoleSelect = document.getElementById("editUserRole");
        const editActiveSelect = document.getElementById("editUserActive");
        const editPasswordInput = document.getElementById("editUserPassword");
        const editRootsInput = document.getElementById("editUserRoots");

        if (editIdInput) editIdInput.value = user.id;
        if (editUsernameInput) editUsernameInput.value = user.username;
        if (editRoleSelect) editRoleSelect.value = user.role;
        if (editActiveSelect) editActiveSelect.value = user.is_active ? "1" : "0";
        if (editPasswordInput) editPasswordInput.value = "";
        if (editRootsInput) {
          editRootsInput.value = user.allowed_roots
            ? (Array.isArray(user.allowed_roots) ? user.allowed_roots.join("\n") : user.allowed_roots)
            : "";
        }

        if (editModal) editModal.classList.add("active");
      });
    });

    tbody.querySelectorAll(".btn-toggle-active").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = parseInt(btn.dataset.id, 10);
        const currentActive = btn.dataset.active === "1";
        try {
          await api.updateUser(id, { is_active: !currentActive });
          showToast("User status updated", "success");
          await this.refreshUsers();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    });

    tbody.querySelectorAll(".btn-delete-user").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.blur();
        const id = parseInt(btn.dataset.id, 10);
        const name = btn.dataset.name;
        const confirmed = await showConfirmDialog({
          title: "Delete User",
          message: `Are you sure you want to permanently delete user "${name}"?`,
          confirmText: "Delete User",
          danger: true
        });
        if (!confirmed) return;

        try {
          await api.deleteUser(id);
          showToast("User deleted", "success");
          await this.refreshUsers();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    });
  }
}

export const settingsComponent = new SettingsComponent();
