/** Shared, interruptible UI motion. Only animate transforms and opacity. */
const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
const animations = new Map();
const modalFocus = new WeakMap();
const modalStack = [];
const revealedScreens = new WeakSet();
export const motion = {
  ease: "cubic-bezier(0.22, 1, 0.36, 1)",
  quick: 160,
  standard: 260,
  enter: 360,
  window: 220,
};

export function cancelMotion(element) {
  animations.get(element)?.cancel();
}

export function finishMotion(element) {
  animations.get(element)?.finish();
}

/** Resolves false when superseded, so an old exit cannot hide a reopened UI. */
export function animateElement(element, frames, options = {}) {
  if (!element) return Promise.resolve(false);
  cancelMotion(element);
  if (preference.matches || !element.animate) return Promise.resolve(true);
  const animation = element.animate(frames, {
    duration: motion.standard, easing: motion.ease, fill: "both", ...options,
  });
  animations.set(element, animation);
  return animation.finished.then(() => true, () => false).then(completed => {
    const current = animations.get(element) === animation;
    if (current) animations.delete(element);
    // Release compositor layers and return control to hover/focus styles.
    animation.cancel();
    return completed && current;
  });
}

preference.addEventListener("change", () => {
  if (preference.matches) {
    // Finish rather than cancel: exits still need to perform their cleanup.
    for (const animation of animations.values()) animation.finish();
  }
});

export function revealElements(elements, { stagger = 35, distance = 12 } = {}) {
  if (preference.matches) return;
  Array.from(elements).slice(0, 16).forEach((element, index) => {
    if (!element.getClientRects().length || element.closest("[inert]")) return;
    animateElement(element, [
      { opacity: 0, transform: `translateY(${distance}px)` },
      { opacity: 1, transform: "none" },
    ], { duration: motion.enter, delay: Math.min(index * stagger, 210) });
  });
}

function syncModalStack() {
  const top = modalStack.at(-1);
  modalStack.forEach((modal, index) => {
    modal.style.zIndex = String(2000 + index * 10);
    modal.inert = modal !== top;
    modal.setAttribute("aria-hidden", String(modal !== top));
  });
}

export function openModal(modal) {
  if (!modal || modal.classList.contains("active")) return;
  modalFocus.set(modal, document.activeElement);
  cancelMotion(modal);
  cancelMotion(modal.querySelector(".modal"));
  modal.classList.remove("motion-exiting");
  modal.classList.add("active");
  modalStack.push(modal);
  syncModalStack();
  animateElement(modal, [{ opacity: 0 }, { opacity: 1 }], { duration: motion.quick });
  animateElement(modal.querySelector(".modal"), [
    { transform: "translateY(16px) scale(0.97)" },
    { transform: "none" },
  ], { duration: motion.enter });
  const focusTarget = [...modal.querySelectorAll("input:not([type=hidden]), textarea, select")]
    .find(element => !element.disabled && element.getClientRects().length)
    || modal.querySelector(".modal-footer button, button");
  (focusTarget || modal).focus({ preventScroll: true });
}

export function closeModal(modal) {
  if (!modal || !modal.classList.contains("active")) return;
  const wasTop = modalStack.at(-1) === modal;
  const opacity = getComputedStyle(modal).opacity;
  const sheet = modal.querySelector(".modal");
  const transform = sheet ? getComputedStyle(sheet).transform : "none";
  modal.classList.remove("active");
  modal.classList.add("motion-exiting");
  modal.inert = true;
  modal.setAttribute("aria-hidden", "true");
  const index = modalStack.indexOf(modal);
  if (index !== -1) modalStack.splice(index, 1);
  syncModalStack();
  animateElement(sheet, [{ transform }, { transform: "translateY(8px) scale(0.98)" }], { duration: motion.quick });
  animateElement(modal, [{ opacity }, { opacity: 0 }], { duration: motion.quick }).then(completed => {
    if (completed && !modal.classList.contains("active")) modal.classList.remove("motion-exiting");
  });
  if (wasTop) {
    const previous = modalFocus.get(modal);
    if (previous?.isConnected && !previous.closest("[inert]")) previous.focus({ preventScroll: true });
    else modalStack.at(-1)?.querySelector("button")?.focus({ preventScroll: true });
  }
}

/** Lock/unlock entrances without compositing a blurred full-screen layer. */
export function showScreen(screen) {
  const auth = document.getElementById("authContainer");
  const desktop = document.getElementById("appContainer");
  const entering = screen === "auth" ? auth : desktop;
  const leaving = screen === "auth" ? desktop : auth;
  if (!entering || !leaving) return;
  const alreadyVisible = entering.style.display !== "none" && leaving.style.display === "none";
  entering.style.display = "flex";
  leaving.style.display = "none";
  leaving.inert = true;
  entering.inert = false;
  if (screen === "auth") {
    // Dialogs belong to the authenticated screen and cannot stay above it.
    [...modalStack].reverse().forEach(closeModal);
  }
  if (alreadyVisible && revealedScreens.has(entering)) return;
  revealedScreens.add(entering);
  revealElements(entering.querySelectorAll(screen === "auth"
    ? ".macos-lock-header, .macos-lock-card, .macos-lock-footer"
    : ".desktop-greeting-bar, .dashboard-grid > .card, .storage-section"));
  if (screen !== "auth") {
    animateElement(entering.querySelector(".macos-dock"), [
      { opacity: 0, transform: "translateX(-50%) translateY(24px)" },
      { opacity: 1, transform: "translateX(-50%) translateY(0)" },
    ], { duration: 420 });
  }
}

/** Keep live download progress bars and focused controls in the DOM. */
export function reconcileContent(current, next) {
  if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName
      || (current.nodeName === "BUTTON" && current.className !== next.className)) {
    current.replaceWith(next);
    return;
  }
  if (current.nodeType === Node.TEXT_NODE) {
    if (current.textContent !== next.textContent) current.textContent = next.textContent;
    return;
  }
  if (current.nodeType !== Node.ELEMENT_NODE) return;
  for (const attribute of [...current.attributes]) {
    if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of next.attributes) {
    if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  }
  const existing = [...current.childNodes];
  const children = [...next.childNodes];
  children.forEach((child, index) => {
    if (existing[index]) reconcileContent(existing[index], child);
    else current.appendChild(child);
  });
  existing.slice(children.length).forEach(child => child.remove());
}

export function initMotion() {
  document.querySelectorAll(".modal-overlay").forEach(modal => {
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-hidden", "true");
    modal.tabIndex = -1;
    modal.inert = true;
    const title = modal.querySelector(".modal-title");
    if (title) {
      title.id ||= `${modal.id}Title`;
      modal.setAttribute("aria-labelledby", title.id);
    }
    modal.querySelectorAll(".modal-close").forEach(button => button.setAttribute("aria-label", "Close dialog"));
  });
  document.addEventListener("click", event => {
    const closeButton = event.target.closest("[data-close-modal]");
    if (closeButton) closeModal(document.getElementById(closeButton.dataset.closeModal));
  });
  document.addEventListener("keydown", event => {
    const top = modalStack.at(-1);
    if (!top) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      const button = top.querySelector(".modal-close");
      if (button) button.click();
      else closeModal(top);
    } else if (event.key === "Tab") {
      const items = [...top.querySelectorAll("button, input, select, textarea, a[href], [tabindex='0']")]
        .filter(element => !element.disabled && element.getClientRects().length);
      const first = items[0] || top;
      const last = items.at(-1) || top;
      if (!top.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }, true);
}
