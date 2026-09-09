/**
 * Reusable Confirmation Dialog Modal Component for HomeDock.
 * Replaces blocking browser confirm() with an accessible, styled modal.
 */

let activeResolve = null;
let keydownHandler = null;

/**
 * Display a modern, non-blocking confirmation dialog.
 * @param {Object} options
 * @param {string} options.title - Header title of the modal
 * @param {string} options.message - Body explanation
 * @param {string} [options.confirmText="Confirm"] - Text for confirm button
 * @param {string} [options.cancelText="Cancel"] - Text for cancel button
 * @param {boolean} [options.danger=false] - True if this is a destructive action (styles confirm button red)
 * @param {Object} [options.checkbox=null] - Optional checkbox { id, label, checked }
 * @returns {Promise<boolean|{confirmed: boolean, checkbox: boolean}>}
 */
export function showConfirmDialog({
  title = "Confirm Action",
  message = "Are you sure you want to proceed?",
  confirmText = "Confirm",
  cancelText = "Cancel",
  danger = false,
  checkbox = null,
} = {}) {
  return new Promise((resolve) => {
    // If a previous dialog is somehow unresolved, resolve it with false
    if (activeResolve) {
      activeResolve(false);
      activeResolve = null;
    }

    // Blur any currently focused element to prevent keyboard focus bounce
    if (document.activeElement && typeof document.activeElement.blur === "function") {
      document.activeElement.blur();
    }

    const modal = document.getElementById("confirmDialogModal");
    const titleEl = document.getElementById("confirmDialogTitle");
    const msgEl = document.getElementById("confirmDialogMessage");
    const closeBtn = document.getElementById("closeConfirmDialogBtn");
    const cancelBtn = document.getElementById("cancelConfirmDialogBtn");
    const okBtn = document.getElementById("okConfirmDialogBtn");
    const cbContainer = document.getElementById("confirmDialogCheckboxContainer");
    const cbInput = document.getElementById("confirmDialogCheckbox");
    const cbLabel = document.getElementById("confirmDialogCheckboxLabel");

    if (!modal || !okBtn) {
      // Fallback if modal DOM element is missing
      const result = window.confirm(`${title}\n\n${message}`);
      resolve(result);
      return;
    }

    titleEl.textContent = title;
    msgEl.textContent = message;

    okBtn.textContent = confirmText;
    okBtn.className = danger ? "btn btn-danger btn-sm" : "btn btn-primary btn-sm";
    cancelBtn.textContent = cancelText;

    if (checkbox && cbContainer && cbInput && cbLabel) {
      cbContainer.style.display = "flex";
      cbInput.checked = Boolean(checkbox.checked);
      cbLabel.textContent = checkbox.label || "";
    } else if (cbContainer) {
      cbContainer.style.display = "none";
    }

    function cleanup() {
      modal.classList.remove("active");
      if (keydownHandler) {
        document.removeEventListener("keydown", keydownHandler);
        keydownHandler = null;
      }
      closeBtn?.removeEventListener("click", onCancel);
      cancelBtn?.removeEventListener("click", onCancel);
      okBtn?.removeEventListener("click", onOk);
      modal.removeEventListener("click", onBackdrop);
      activeResolve = null;
    }

    function onCancel() {
      cleanup();
      resolve(false);
    }

    function onOk() {
      const cbChecked = cbInput ? cbInput.checked : false;
      cleanup();
      if (checkbox) {
        resolve({ confirmed: true, checkbox: cbChecked });
      } else {
        resolve(true);
      }
    }

    function onBackdrop(e) {
      if (e.target === modal) {
        onCancel();
      }
    }

    keydownHandler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey) {
        if (document.activeElement === cancelBtn) {
          e.preventDefault();
          onCancel();
        } else {
          e.preventDefault();
          onOk();
        }
      }
    };

    activeResolve = resolve;

    closeBtn?.addEventListener("click", onCancel);
    cancelBtn?.addEventListener("click", onCancel);
    okBtn?.addEventListener("click", onOk);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", keydownHandler);

    modal.classList.add("active");
    // Default focus to cancel button to safeguard destructive operations
    if (cancelBtn) {
      cancelBtn.focus();
    }
  });
}
