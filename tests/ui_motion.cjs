/** Browser regression checks. Run: node tests/ui_motion.cjs (requires Playwright).
 * Uses an isolated static server and API fixtures; no server data is changed.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const previews = path.join(root, "data", "ui-motion-preview");
const user = { id: 1, username: "admin", role: "admin", is_active: true };
const task = { gid: "test-task", name: "Ubuntu.iso", dir: "/downloads", status: "active", percent: 25,
  completed_bytes: 250000000, total_bytes: 1000000000, download_speed: 2500000, upload_speed: 0,
  eta_seconds: 300, connections: 4, max_download_limit: 0 };
const stats = { download_speed: 2500000, upload_speed: 0, num_active: 1, num_waiting: 0, num_stopped: 0 };
const metrics = {
  cpu: { usage_percent: 32, temperature: 49, frequency_mhz: 2400, cores: [20, 35, 40, 32], load_average: [0.8, 0.7, 0.6], history: [{ v: 20 }, { v: 32 }] },
  memory: { percent: 48, used: 8000000000, total: 16000000000, available: 8000000000, swap_total: 0, history: [{ v: 40 }, { v: 48 }] },
  network: { download_speed: 2500000, upload_speed: 420000, interfaces: [] },
  sensors: { fan_rpm: 2100, cpu_temp: 49, core_temps: [] },
  system: { hostname: "HomeDock", uptime: 7200 },
};

async function main() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const file = url.pathname === "/" && process.env.UI_HTML_FILE
      ? path.resolve(process.env.UI_HTML_FILE)
      : path.resolve(root, url.pathname === "/" ? "static/index.html" : `.${url.pathname}`);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      const body = await fs.readFile(file);
      res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" })[path.extname(file)] || "application/octet-stream");
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const errors = [];
  const calls = [];
  let downloads = [{ ...task }];
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.UI_BROWSER ? { channel: process.env.UI_BROWSER } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", async route => {
      const request = route.request();
      const url = new URL(request.url());
      calls.push({ path: url.pathname, method: request.method() });
      let body = {};
      let status = 200;
      if (url.pathname === "/api/auth/login") {
        if (request.postDataJSON().password === "wrong") { status = 401; body = { detail: "Invalid credentials" }; }
        else body = { access_token: "test-token", user };
      } else if (url.pathname === "/api/auth/me") body = user;
      else if (url.pathname === "/api/users") body = [user];
      else if (url.pathname === "/api/settings") body = { default_download_dir: "/downloads", global_allowed_roots: ["/downloads"], max_download_limit: "0", max_upload_limit: "0" };
      else if (url.pathname === "/api/downloads/default-dir") body = { default_dir: "/downloads" };
      else if (url.pathname === "/api/downloads/list") body = downloads;
      else if (url.pathname === "/api/downloads/stats") body = stats;
      else if (/\/pause$/.test(url.pathname)) downloads[0].status = "paused";
      else if (/\/unpause$/.test(url.pathname)) downloads[0].status = "active";
      else if (url.pathname === "/api/storage/devices" || url.pathname === "/api/storage/refresh") body = [];
      else if (url.pathname === "/api/files/list") {
        const current = url.searchParams.get("path") || "/downloads";
        if (current === "/slow") await new Promise(resolve => setTimeout(resolve, 180));
        body = { current_path: current, allowed_roots: ["/downloads"], storage_chips: [], breadcrumbs: [{ name: current, path: current }],
          items: [{ name: "Documents", path: `${current}/Documents`, is_dir: true, is_archive: false, size: 0, mtime: 1720000000 },
            { name: "readme.txt", path: `${current}/readme.txt`, is_dir: false, is_archive: false, size: 4096, mtime: 1720000000 }] };
      } else if (url.pathname === "/api/files/browse-folders") {
        const current = url.searchParams.get("path") || "/downloads";
        body = { current_path: current, parent_path: "/", quick_locations: [{ name: "Downloads", path: "/downloads" }],
          breadcrumbs: [{ name: "Downloads", path: current }], directories: [{ name: "Documents", path: `${current}/Documents`, writable: true }] };
      }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.routeWebSocket("**/api/ws**", socket => {
      socket.send(JSON.stringify({ type: "initial_state", data: { metrics, storage: [], download_stats: stats, downloads } }));
    });
    await page.goto(base);
    await page.evaluate(async () => {
      window.ui = {
        manager: (await import("/static/js/components/window_manager.js")).windowManager,
        downloads: (await import("/static/js/components/downloads.js")).downloadManagerComponent,
        files: (await import("/static/js/components/files.js")).fileManagerComponent,
        folder: (await import("/static/js/components/folder_browser.js")).folderBrowser,
        motion: await import("/static/js/utils/motion.js"),
        confirm: (await import("/static/js/components/confirm_dialog.js")).showConfirmDialog,
        api: await import("/static/js/api.js"),
      };
    });
    const settle = () => page.waitForFunction(() => document.getAnimations().every(animation =>
      animation.effect.getComputedTiming().iterations === Infinity || animation.playState === "finished"));
    const visible = selector => page.locator(selector).first().waitFor({ state: "visible" });
    const hidden = selector => page.locator(selector).waitFor({ state: "hidden" });
    const passed = name => console.log(`PASS ${name}`);

    await page.locator("#loginUsername").fill("admin");
    await page.locator("#loginPassword").fill("wrong");
    await page.locator("#loginForm button[type=submit]").click();
    await visible("#loginErrorMsg");
    await page.locator("#loginUsername").fill("admin");
    await page.locator("#loginPassword").fill("correct");
    await page.locator("#loginForm button[type=submit]").click();
    await visible("#appContainer");
    await settle();
    const chartHasData = () => page.locator("#cpuHistoryChart").evaluate(canvas =>
      canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0));
    assert.equal(await chartHasData(), true, "Chart data survives initial ResizeObserver callback");
    passed("login error feedback and desktop entrance");

    const animated = await page.evaluate(() => {
      ui.manager.openWindow("files");
      const el = ui.manager.windows.files.el;
      return el.getAnimations().length > 0 && Number(getComputedStyle(el).opacity) < 1;
    });
    assert.equal(animated, true, "Window entrance must animate, without CSS overriding it");
    await visible(".file-row");
    await settle();
    await page.evaluate(() => { for (let i = 0; i < 12; i++) { ui.manager.closeWindow("files"); ui.manager.openWindow("files"); } });
    await settle();
    assert.equal(await page.locator("#windowFiles").isVisible(), true);
    await page.evaluate(() => ui.manager.minimizeWindow("files"));
    await page.waitForTimeout(35);
    await page.evaluate(() => ui.manager.restoreWindow("files"));
    await settle();
    assert.equal(await page.locator("#windowFiles").evaluate(el => !el.inert && !el.classList.contains("window-exiting")), true);
    passed("window open/close/minimize interruption");

    const fileRequests = calls.filter(call => call.path === "/api/files/list").length;
    await page.locator(".fm-item-checkbox").first().check();
    await page.locator('[data-fm-view="grid"]').click();
    assert.equal(await page.locator('[data-fm-view="grid"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#fmTableBody").evaluate(el => getComputedStyle(el).display), "grid");
    assert.equal(await page.locator(".fm-item-checkbox").first().isChecked(), true);
    assert.equal(await page.locator(".file-row.selected").count(), 1);
    assert.equal(await page.locator("#fmSelectAll").evaluate(el => el.indeterminate), true);
    assert.equal(await page.locator(".folder-front").evaluate(el => getComputedStyle(el).fill), "rgb(107, 197, 248)");
    await page.locator("#fmSelectAll").check();
    assert.equal(await page.locator(".file-row.selected").count(), 2);
    await page.locator('[data-fm-view="list"]').click();
    assert.equal(await page.locator(".fm-item-checkbox:checked").count(), 2);
    assert.equal(await page.locator("#fmTableBody").evaluate(el => getComputedStyle(el).display), "table-row-group");
    assert.equal(calls.filter(call => call.path === "/api/files/list").length, fileRequests, "View changes preserve loaded files");
    await page.locator('[data-fm-view="grid"]').click();
    assert.equal(await page.evaluate(async () => {
      const { FileManagerComponent } = await import("/static/js/components/files.js");
      return new FileManagerComponent().viewMode;
    }), "grid", "Saved preference survives a new component instance");
    await page.locator('.file-row[data-isdir="true"] .file-name-cell').focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => ui.files.currentPath === "/downloads/Documents");
    assert.equal(await page.locator(".fm-item-checkbox:checked").count(), 0);
    assert.equal(await page.locator("#fmContentArea").evaluate(el => el.classList.contains("fm-grid-view")), true);
    await page.locator(".btn-more").first().click();
    await page.locator('[data-menu-action="copy"]').click();
    assert.deepEqual(await page.evaluate(() => ui.files.clipboard.items), ["/downloads/Documents/Documents"]);
    await page.locator(".btn-more").first().click();
    await page.locator('[data-menu-action="move"]').click();
    assert.equal(await page.locator(".file-row.is-cut").count(), 1);
    await page.locator('[data-fm-view="list"]').click();
    assert.equal(await page.locator(".file-row.is-cut").count(), 1);
    await page.evaluate(() => ui.files.clearClipboard());
    await page.locator('[data-fm-view="grid"]').click();
    await page.evaluate(() => { document.getElementById("fmContentArea").style.width = "320px"; });
    assert.equal(await page.locator("#fmContentArea").evaluate(el => el.scrollWidth <= el.clientWidth), true, "Grid fits narrow windows");
    await page.evaluate(() => {
      document.getElementById("fmContentArea").style.width = "";
      ui.files.items = [];
      ui.files.renderFileList();
    });
    assert.match(await page.locator(".fm-empty-row").innerText(), /This folder is empty/);
    await page.evaluate(() => ui.files.navigate("/downloads"));
    await settle();
    await fs.mkdir(previews, { recursive: true });
    await page.locator("#windowFiles").screenshot({ path: path.join(previews, "files-grid.png") });
    await page.locator('[data-fm-view="list"]').click();
    await page.locator("#windowFiles").screenshot({ path: path.join(previews, "files-list.png") });
    passed("file views, folder colors, selection, saved preference, keyboard navigation, clipboard, narrow grid and empty folder");

    // --- UX improvements: sorting, filter, escaping, menu, inline edit, undo, preview, shortcuts ---
    await page.evaluate(() => ui.files.navigate("/downloads"));
    await settle();
    await page.evaluate(() => {
      const f = ui.files;
      f.items = [
        { name: "b.txt", path: "/downloads/b.txt", is_dir: false, is_archive: false, size: 10, mtime: 300 },
        { name: "a.png", path: "/downloads/a.png", is_dir: false, is_archive: false, size: 900, mtime: 100 },
        { name: "<img src=x onerror=window.__xss=1>", path: "/downloads/evil", is_dir: false, is_archive: false, size: 5, mtime: 200 },
        { name: "Docs", path: "/downloads/Docs", is_dir: true, is_archive: false, size: 0, mtime: 50 },
      ];
      f.renderFileList({ animate: false });
    });
    const names = () => page.locator("#fmTableBody .file-item-name").allInnerTexts();
    assert.deepEqual((await names()).map(n => n.slice(0, 4)), ["Docs", "<img", "a.pn", "b.tx"], "folders first, then name order");
    assert.equal(await page.evaluate(() => window.__xss), undefined, "file names are escaped");
    await page.locator('[data-sort="size"]').click();
    assert.deepEqual((await names()).slice(-1), ["a.png"], "size ascending puts the largest file last");
    assert.equal(await page.locator('[data-sort-th="size"]').getAttribute("aria-sort"), "ascending");
    await page.locator("#fmSortSelect").selectOption("mtime:desc");
    assert.equal((await names())[1], "b.txt", "select box sorts by modified date");
    await page.locator("#fmFilterInput").fill("png");
    assert.deepEqual(await names(), ["a.png"], "filter narrows the list");
    await page.locator("#fmFilterInput").fill("nomatch");
    assert.match(await page.locator(".fm-empty-row").innerText(), /No items match/);
    await page.locator('[data-empty-action="clear-filter"]').click();
    assert.equal((await names()).length, 4);

    // Row menu and keyboard navigation
    await page.locator('.file-row[data-path="/downloads/a.png"] .btn-more').click();
    assert.equal(await page.locator(".fm-menu").count(), 1);
    assert.equal(await page.locator('.fm-menu [data-menu-action="open"]').innerText(), "Preview");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".fm-menu").count(), 0);
    await page.evaluate(() => { document.activeElement?.blur(); ui.files.focusedPath = null; });
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => ui.files.focusedPath), "/downloads/Docs");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("x");
    assert.equal(await page.evaluate(() => ui.files.selectedItems.size), 1, "x toggles selection of the highlighted row");
    await page.keyboard.press("Control+a");
    assert.equal(await page.evaluate(() => ui.files.selectedItems.size), 4);
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => ui.files.selectedItems.size), 0);

    // Inline rename with validation
    await page.evaluate(() => ui.files.setFocusedRow("/downloads/b.txt"));
    await page.keyboard.press("F2");
    const renameInput = page.locator(".fm-inline-input");
    assert.equal(await renameInput.inputValue(), "b.txt");
    assert.equal(await renameInput.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd)), "b", "extension is not selected");
    await renameInput.fill("a.png");
    await page.keyboard.press("Enter");
    assert.match(await page.locator(".fm-inline-error").innerText(), /already exists/);
    await renameInput.fill("c.txt");
    await page.keyboard.press("Enter");
    await settle();
    assert.equal(calls.filter(call => call.path === "/api/files/rename").length, 1);

    // Inline new folder, rejecting a duplicate name
    await page.locator("#fmNewFolderBtn").click();
    const folderInput = page.locator(".fm-inline-input");
    assert.equal(await folderInput.inputValue(), "untitled folder");
    await folderInput.fill("Documents");
    await page.keyboard.press("Enter");
    assert.match(await page.locator(".fm-inline-error").innerText(), /already exists/);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".fm-new-row").count(), 0);

    // Delete is undoable: nothing is sent until the undo window closes
    const deletesBefore = calls.filter(call => call.path === "/api/files/delete").length;
    await page.evaluate(() => { ui.files.items = [
      { name: "keep.txt", path: "/downloads/keep.txt", is_dir: false, is_archive: false, size: 1, mtime: 1 },
      { name: "oops.txt", path: "/downloads/oops.txt", is_dir: false, is_archive: false, size: 1, mtime: 1 }]; ui.files.renderFileList({ animate: false }); });
    await page.evaluate(() => ui.files.confirmDelete(["/downloads/oops.txt"]));
    assert.deepEqual(await names(), ["keep.txt"]);
    await page.locator(".toast-action", { hasText: "Undo" }).click();
    assert.deepEqual(await names(), ["keep.txt", "oops.txt"]);
    assert.equal(calls.filter(call => call.path === "/api/files/delete").length, deletesBefore, "undo never reaches the server");

    // Preview + shortcuts help
    await page.evaluate(() => ui.files.items.push({ name: "pic.png", path: "/downloads/pic.png", is_dir: false, is_archive: false, size: 1, mtime: 1 }));
    await page.evaluate(() => { ui.files.renderFileList({ animate: false }); ui.files.openPreview("/downloads/pic.png"); });
    assert.equal(await page.locator("#filePreviewBody img").getAttribute("src").then(src => src.includes("inline=true")), true);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("filePreviewModal").classList.contains("active"));
    assert.equal(await page.locator("#filePreviewBody").evaluate(el => el.children.length), 0, "closing the preview clears its media");
    await page.evaluate(() => { document.activeElement?.blur(); });
    await page.keyboard.press("?");
    assert.equal(await page.locator("#fmShortcutsModal").evaluate(el => el.classList.contains("active")), true);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("fmShortcutsModal").classList.contains("active"));
    await page.evaluate(() => ui.files.navigate("/downloads"));
    await settle();
    passed("file sorting, filter, escaping, row menu, keyboard navigation, inline rename/new folder, undo delete, preview and shortcuts");

    // Connection status pill
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("homedock:ws_status", { detail: { state: "reconnecting" } })));
    assert.equal(await page.locator("#connStatusPill").isVisible(), true);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("homedock:ws_status", { detail: { state: "connected" } })));
    assert.equal(await page.locator("#connStatusPill").isVisible(), false);
    // Alert badge
    await page.evaluate(async () => {
      const { updateAlertBadge } = await import("/static/js/utils/alerts.js");
      updateAlertBadge({ metrics: { cpu: { temperature: 95 }, memory: { percent: 10 } }, storage: [] });
    });
    assert.equal(await page.locator("#dockAlertBadge").isVisible(), true);
    await page.evaluate(async () => {
      const { updateAlertBadge } = await import("/static/js/utils/alerts.js");
      updateAlertBadge({ metrics: { cpu: { temperature: 40 }, memory: { percent: 10 } }, storage: [] });
    });
    assert.equal(await page.locator("#dockAlertBadge").isVisible(), false);
    passed("connection status pill and dock alert badge");

    const geometry = await page.evaluate(() => {
      const win = ui.manager.windows.files.el;
      const before = win.getBoundingClientRect();
      ui.manager.toggleMaximizeWindow("files");
      const start = win.getBoundingClientRect();
      const animations = win.getAnimations();
      return {
        keepsPosition: Math.abs(before.x - start.x) < 1 && Math.abs(before.width - start.width) < 1,
        duration: Math.max(...animations.map(animation => animation.effect.getTiming().duration)),
        repaintTransitions: animations.filter(animation => animation.transitionProperty?.startsWith("border")).length,
        windowBlur: getComputedStyle(win).backdropFilter,
        cardBlur: getComputedStyle(document.querySelector("#windowSettings .card")).backdropFilter,
      };
    });
    assert.equal(geometry.keepsPosition, true, "The first zoom frame matches the previous window bounds");
    assert.ok(geometry.duration <= 240, "Window resize responds quickly");
    assert.equal(geometry.repaintTransitions, 0, "Resize must not start border-color repaint transitions");
    assert.equal(geometry.windowBlur, "none");
    assert.equal(geometry.cardBlur, "none");
    await page.waitForTimeout(40);
    const interruptedZoom = await page.evaluate(() => {
      const win = ui.manager.windows.files.el;
      const before = win.getBoundingClientRect();
      ui.manager.toggleMaximizeWindow("files");
      const after = win.getBoundingClientRect();
      return Math.abs(before.x - after.x) < 1 && Math.abs(before.width - after.width) < 1;
    });
    assert.equal(interruptedZoom, true, "Reversing a resize starts at the current visual position");
    await settle();
    assert.equal(await page.locator("#windowFiles").evaluate(el => el.classList.contains("window-geometry-motion")), false);
    passed("fast maximize/restore, compositor-only motion, reversal continuity, layer cleanup");

    await page.locator("#windowFiles .traffic-maximize").click();
    await settle();
    const bounds = await page.locator("#windowFiles").boundingBox();
    assert.equal(Math.round(bounds.y), 32);
    assert.ok(bounds.y + bounds.height < 900, "Maximized windows leave room for dock");
    await page.setViewportSize({ width: 900, height: 760 });
    await page.locator("#windowFiles .traffic-maximize").click();
    await settle();
    const resizedBounds = await page.locator("#windowFiles").boundingBox();
    assert.ok(resizedBounds.x >= 0 && resizedBounds.x + resizedBounds.width <= 900);
    await page.setViewportSize({ width: 1440, height: 960 });
    await settle();
    const title = await page.locator("#windowFiles .window-title").boundingBox();
    const beforeDrag = await page.locator("#windowFiles").boundingBox();
    await page.mouse.move(title.x + title.width / 2, title.y + 12);
    await page.mouse.down();
    await page.mouse.move(title.x + title.width / 2 + 70, title.y + 42, { steps: 8 });
    await page.mouse.up();
    const afterDrag = await page.locator("#windowFiles").boundingBox();
    assert.ok(afterDrag.x > beforeDrag.x + 60);
    assert.equal(await page.locator("body").evaluate(el => el.classList.contains("window-dragging")), false);
    await page.evaluate(() => ui.manager.minimizeWindow("files"));
    await page.setViewportSize({ width: 1366, height: 900 });
    await hidden("#windowFiles");
    await page.evaluate(() => ui.manager.restoreWindow("files"));
    await settle();
    passed("maximize, pointer drag, resize during minimize");

    await page.evaluate(() => Promise.all([ui.files.navigate("/slow"), ui.files.navigate("/fast")]));
    assert.equal(await page.evaluate(() => ui.files.currentPath), "/fast");
    passed("fast folder navigation ignores stale responses");

    await page.evaluate(() => ui.manager.handleAction("new-download"));
    await visible("#addDownloadModal");
    await page.keyboard.press("Escape");
    await hidden("#addDownloadModal");
    passed("menu New Download initializes its window on first use");
    await visible(".download-item");
    await settle();
    await page.locator(".btn-pause-dl").focus();
    const preserved = await page.evaluate(() => {
      const fill = document.querySelector(".download-progress-fill");
      const button = document.activeElement;
      for (let percent = 30; percent < 34; percent++) {
        ui.downloads.updateLive(null, [{ ...ui.downloads.downloads[0], percent }]);
      }
      return fill === document.querySelector(".download-progress-fill") && button === document.activeElement;
    });
    assert.equal(preserved, true, "Live updates preserve progress bar and keyboard focus");
    const pausesBefore = calls.filter(call => call.path.endsWith("/pause")).length;
    await page.locator(".btn-pause-dl").click();
    await visible(".btn-unpause-dl");
    assert.equal(calls.filter(call => call.path.endsWith("/pause")).length, pausesBefore + 1);
    await page.locator(".btn-unpause-dl").click();
    await visible(".btn-pause-dl");
    passed("live progress continuity, focus preservation, pause/resume without duplicate listeners");

    // Downloads: counts, friendly empty states, completed-download actions
    assert.equal(await page.locator('.dl-tab-count[data-count="all"]').innerText(), "1");
    assert.equal(await page.locator('.dl-tab-count[data-count="active"]').innerText(), "1");
    await page.locator('.dl-filter-tab[data-filter="error"]').click();
    assert.match(await page.locator(".dl-empty-state").innerText(), /No failed downloads/);
    await page.locator('.dl-filter-tab[data-filter="all"]').click();
    passed("download tab counts and empty states");


    await page.locator("#openAddDownloadModalBtn").click();
    await visible("#addDownloadModal");
    await page.locator("#btnBrowseDownloadDest").click();
    await visible("#folderBrowserModal");
    assert.equal(await page.locator("#addDownloadModal").evaluate(el => el.inert), true);
    await page.keyboard.press("Escape");
    await hidden("#folderBrowserModal");
    assert.equal(await page.locator("#addDownloadModal").evaluate(el => el.inert), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), "btnBrowseDownloadDest");
    await page.locator("#btnTabYoutubeDl").click();
    await visible("#paneYoutubeDl");
    await page.locator("#btnYtModeAudio").click();
    await visible("#ytAudioControls");
    await page.keyboard.press("Escape");
    await hidden("#addDownloadModal");
    await page.evaluate(() => {
      const modal = document.getElementById("addDownloadModal");
      ui.motion.openModal(modal); ui.motion.closeModal(modal); ui.motion.openModal(modal);
    });
    await settle();
    assert.equal(await page.locator("#addDownloadModal").isVisible(), true);
    await page.evaluate(() => ui.motion.closeModal(document.getElementById("addDownloadModal")));
    await hidden("#addDownloadModal");
    await page.evaluate(() => { window.confirmResult = null; ui.confirm({ title: "Test", message: "Test cancellation" }).then(result => window.confirmResult = result); });
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => window.confirmResult), false);
    passed("nested dialogs, focus restoration, tab switching, rapid reopening, confirmation cancellation");

    await page.locator('.dock-item[data-app="settings"]').click();
    await visible("#usersTableBody tr");
    await page.locator("#openCreateUserModalBtn").click();
    await visible("#createUserModal");
    await page.locator("#createUserModal button[type=submit]").focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.closest(".modal-overlay")?.id), "createUserModal");
    await page.keyboard.press("Escape");
    await hidden("#createUserModal");
    passed("settings and dialog keyboard focus trap");

    await page.evaluate(() => ui.manager.showDesktop());
    assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
    await settle();
    await fs.mkdir(previews, { recursive: true });
    await page.screenshot({ path: path.join(previews, "desktop-light.png") });
    await page.locator("#themeToggleBtn").click();
    await settle();
    await page.screenshot({ path: path.join(previews, "desktop-dark.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await settle();
    const overflow = await page.locator(".macos-desktop-surface").evaluate(el => el.scrollWidth > el.clientWidth);
    assert.equal(overflow, false, "Dashboard fits a mobile viewport");
    await page.screenshot({ path: path.join(previews, "mobile-dashboard.png") });
    await page.locator('.dock-item[data-app="downloads"]').click();
    await settle();
    const mobileWindow = await page.locator("#windowDownloads").boundingBox();
    assert.ok(mobileWindow.x >= 0 && mobileWindow.width <= 390 && mobileWindow.y + mobileWindow.height <= 844);
    await page.screenshot({ path: path.join(previews, "mobile-downloads.png") });
    passed("light/dark themes and mobile dashboard/windows");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => { ui.manager.closeWindow("downloads"); ui.manager.openWindow("downloads"); });
    await settle();
    assert.equal(await page.locator("#windowDownloads").evaluate(el => el.getAnimations().length), 0);
    await page.evaluate(() => ui.api.showToast("Motion test", "success", 50));
    await page.locator(".toast-success").waitFor({ state: "visible" });
    await page.locator(".toast-success").waitFor({ state: "hidden" });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => ui.manager.minimizeWindow("downloads"));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await hidden("#windowDownloads");
    passed("reduced motion and changing preference during an exit");

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => ui.manager.lockScreen());
    await visible("#authContainer");
    await settle();
    assert.equal(await page.locator("#appContainer").evaluate(el => el.inert), true);
    passed("lock screen transition");

    assert.deepEqual(errors, [], "No unhandled browser errors");
    console.log(`Screenshots: ${previews}`);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
