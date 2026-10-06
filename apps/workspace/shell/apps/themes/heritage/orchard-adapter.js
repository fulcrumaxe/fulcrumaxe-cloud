// ── Orchard Heritage Adapter ───────────────────────────────────────────
// Builds a macOS-style menu bar + dock on `activate`, tears them down on
// `deactivate`. Registers with FULCHeritage under the id "orchard".
//
// The dock itself is a composition of smaller modules:
//   - orchard-dock-layout   — persisted slot model (apps + folders)
//   - orchard-dock-state    — running/focused/minimized indicators
//   - orchard-dock-menu     — right-click context menus
//   - orchard-dock-folders  — folder items + Launchpad expansion + drag-drop
//   - orchard-dock-minimized — minimized-window zone with thumbnails
import { FULCHeritage } from "../../../core/heritage-shell.js";
// orchard-icons.js exports OrchardIcons/buildOrchardIcon/getOrchardIcon
// directly (the Trusted Types rewrite removed the old window global); the
// DOM builders import from it themselves, so this bare import only
// guarantees the module loads for build.mjs's reachability walk.
import "./orchard-icons.js";
import { buildOrchardMenuBarEl, buildOrchardDockEl, buildOrchardDockItem, orchardDockScale, formatOrchardClock, syncWorkspaceSwitcher, orchardItemToButton, } from "./orchard-dom.js";
import { loadLayout, saveLayout, isAppPinned, } from "./orchard-dock-layout.js";
import { createDockState } from "./orchard-dock-state.js";
import { createFolders } from "./orchard-dock-folders.js";
import { createMinimized } from "./orchard-dock-minimized.js";
import { showAppMenu, showFolderMenu, showDockMenu } from "./orchard-dock-menu.js";
import { bindMenuKeys, syncElsewhereMarker, elsewhereWorkspace } from "../../../core/workspace-actions.js";
let menuBar = null;
let dock = null;
let originalTaskbar = null;
let originalDataTheme = null;
let styleEl = null;
let bounceTimers = [];
let _origWMFocus = null;
let _entChangeHandle = null;
let layout = null;
let dockState = null;
let folders = null;
let minimized = null;
// D#37 WS-W2: keep the switcher in step with the workspace model through
// fulc-workspace-change (no polling). One listener per activation, removed in deactivate().
function onWorkspaceChange() {
    syncWorkspaceSwitcher(document.getElementById("orchard-workspaces"), window.FULCWM?.getActiveWorkspace?.() ?? 1);
    syncDockMarkers();
}
/** D#37 WS-W3: mark the dock items whose window is on another workspace. */
function syncDockMarkers() {
    document.querySelectorAll("button.orchard-dock-item[data-app-id]").forEach((item) => {
        const label = item.querySelector(".orchard-dock-label");
        syncElsewhereMarker(item, item.dataset.appId, "orchard-dock-item-elsewhere", label ? label.textContent : item.dataset.appId);
    });
}
function onWorkspaceClick(e) {
    const btn = e.target instanceof Element ? e.target.closest("button[data-workspace]") : null;
    if (btn && window.FULCWM?.switchWorkspace) window.FULCWM.switchWorkspace(parseInt(btn.dataset.workspace, 10));
}
function mountWorkspaceSwitcher() {
    const group = document.getElementById("orchard-workspaces");
    if (!group) return;
    group.addEventListener("click", onWorkspaceClick);
    // Its own group name: the hidden CRT #workspace-indicator still registers as "workspaces".
    window.FULCTaskbarKeyboard?.attach(group, { group: "heritage-workspaces", label: "Workspaces", itemSelector: "button" });
    document.addEventListener("fulc-workspace-change", onWorkspaceChange);
}
function buildMenuBar() {
    menuBar = buildOrchardMenuBarEl();
    // dom-insert-ok: buildOrchardMenuBarEl always returns the menu bar element (orchard-dom.js)
    document.body.prepend(menuBar);
    mountWorkspaceSwitcher();
    startClock();
}
function startClock() {
    const el = document.getElementById("orchard-time");
    if (!el || !menuBar)
        return;
    const tick = () => { el.textContent = formatOrchardClock(new Date()); };
    tick();
    menuBar._clockInterval = setInterval(tick, 10000);
}
function buildDock() {
    dock = buildOrchardDockEl();
    document.body.appendChild(dock);
    // D#37 WS-W3 criterion 6: right-click on the dock outside any item.
    // Item menus stop the event before it gets here.
    dock.addEventListener("contextmenu", (e) => {
        if (e.defaultPrevented || (e.target instanceof Element && e.target.closest(".orchard-dock-item")))
            return;
        showDockMenu(e);
    });
    // Use visible() ids so entitlement-hide apps are excluded from the dock
    // layout (consistent with desktop and crystal). Registered-but-denied
    // show-locked apps remain (renderDock's ent.isAppHidden check handles them).
    const availableIds = window.FULCApps?.visible
        ? window.FULCApps.visible().map((a) => a.id).filter((id) => !!id)
        : (window.FULCApps?.ids ? window.FULCApps.ids() : []);
    layout = loadLayout(availableIds);
    folders = createFolders({
        layout,
        rerender: renderDock,
    });
    minimized = createMinimized({
        layout,
        rerender: renderDock,
        openFolder: (id) => folders?.openFolder(id),
    });
    renderDock();
    dockState = createDockState();
    // Minimized zone refreshes every time state changes (poll tick) so a
    // close via the window's traffic-light button clears the thumbnail too.
    dockState.onChange(() => { minimized?.refresh(); });
    dockState.start();
    minimized.start();
}
/** Rebuild the main dock contents from layout. Also rebuilds the "open
 * non-pinned apps" section on the right (before the minimized zone). */
function renderDock() {
    const inner = document.getElementById("orchard-dock-inner");
    if (!inner || !layout || !folders)
        return;
    // Wipe everything; the minimized module will reattach its divider+zone on
    // the next refresh() call at the end.
    inner.replaceChildren();
    const ent = window.FULCEntitlements;
    // ── Main pinned slots ──
    layout.slots.forEach((slot, idx) => {
        let item;
        if (slot.type === "app") {
            const app = window.FULCApps?.get ? window.FULCApps.get(slot.id) : null;
            const def = app || { id: slot.id, title: slot.id, icon: "◈" };
            // Skip apps that should be fully hidden when denied
            if (ent && ent.isAppHidden(def))
                return;
            item = buildOrchardDockItem(def);
            item.addEventListener("click", () => launchWithBounce(slot.id, item));
            wireAppMenu(item, slot.id);
            // Apply lock overlay for denied-but-visible apps
            if (ent)
                ent.applyGate(item, def);
        }
        else {
            // A native button like the app items (criterion 7); the click that
            // orchard-dock-folders.js wired on its div does not carry over.
            item = orchardItemToButton(folders.buildFolderItemEl(slot), slot.name);
            item.addEventListener("click", (e) => {
                e.stopPropagation();
                folders?.openFolder(slot.id);
            });
            const openFolderMenu = (e) => {
                showFolderMenu(e, slot.id, { layout: layout, rerender: renderDock, openFolder: (id) => folders?.openFolder(id) });
            };
            item.addEventListener("contextmenu", openFolderMenu);
            bindMenuKeys(item, openFolderMenu);
        }
        folders.wireDragDrop(item, idx);
        inner.appendChild(item);
    });
    // ── Open non-pinned apps (right side) ──
    const wm = window.FULCWM;
    const open = wm?.getOpen ? wm.getOpen() : [];
    // Filter non-pinned: also exclude if app is hidden by entitlement
    const nonPinned = open.filter((w) => {
        if (!isAppPinned(layout, w.id)) {
            const app = window.FULCApps?.get ? window.FULCApps.get(w.id) : null;
            const def = app || { id: w.id, title: w.id, icon: "◈" };
            if (ent && ent.isAppHidden(def))
                return false;
            return true;
        }
        return false;
    });
    if (nonPinned.length > 0) {
        const divider = document.createElement("div");
        divider.className = "orchard-dock-divider orchard-dock-divider-running";
        inner.appendChild(divider);
        nonPinned.forEach((win) => {
            const app = window.FULCApps?.get ? window.FULCApps.get(win.id) : null;
            const def = app || { id: win.id, title: win.id, icon: "◈" };
            const item = buildOrchardDockItem(def);
            item.dataset.nonPinned = "true";
            item.addEventListener("click", () => {
                if (window.FULCWM) {
                    // open() on a running app jumps to it, wherever it is.
                    window.FULCWM.open(win.id);
                }
            });
            wireAppMenu(item, win.id);
            // Apply lock overlay for denied-but-visible apps
            if (ent)
                ent.applyGate(item, def);
            inner.appendChild(item);
        });
    }
    // ── Minimized zone (far right) — module re-attaches its own divider+zone ──
    minimized?.refresh();
    // D#37 WS-W3: markers for windows on other workspaces, and the dock as one
    // toolbar tab stop (re-attached after every render; attach is idempotent).
    syncDockMarkers();
    window.FULCTaskbarKeyboard?.attach(inner, { group: "orchard-dock", label: "Dock", itemSelector: ".orchard-dock-item" });
    // Re-wire magnification on the final set of items
    wireDockMagnification(inner);
    // Re-apply state indicators
    dockState?.refresh();
}
/** Right-click and Shift+F10 / ContextMenu both open an app item's menu. */
function wireAppMenu(item, appId) {
    const openMenu = (e) => {
        showAppMenu(e, appId, { layout: layout, rerender: renderDock, openFolder: (id) => folders?.openFolder(id) });
    };
    item.addEventListener("contextmenu", openMenu);
    bindMenuKeys(item, openMenu);
}
function wireDockMagnification(inner) {
    // idempotent: clear any previous listener by cloning the inner? No —
    // easier to just gate with a dataset flag. One handler lives for lifetime
    // of the dock.
    if (inner.dataset.magWired === "1")
        return;
    inner.dataset.magWired = "1";
    inner.addEventListener("mousemove", (e) => {
        const items = Array.from(inner.querySelectorAll(".orchard-dock-item"));
        items.forEach((item) => {
            const rect = item.getBoundingClientRect();
            const scale = orchardDockScale(e.clientX, rect.left, rect.width);
            item.style.transform = `scale(${scale})`;
            item.style.transformOrigin = "bottom center";
        });
    });
    inner.addEventListener("mouseleave", () => {
        inner.querySelectorAll(".orchard-dock-item").forEach((item) => {
            item.style.transform = "";
        });
    });
}
function launchWithBounce(appId, item) {
    item.classList.add("orchard-bounce");
    const t = setTimeout(() => { item.classList.remove("orchard-bounce"); }, 800);
    bounceTimers.push(t);
    if (window.FULCWM) {
        const currentOpen = window.FULCWM.getOpen();
        const win = currentOpen.find((w) => w.id === appId);
        // A minimized window on another workspace is restored by open() (it jumps there).
        if (win?.state === "minimized" && !elsewhereWorkspace(appId)) {
            window.FULCWM.restore(appId);
            window.FULCWM.focus(appId);
        }
        else {
            window.FULCWM.open(appId);
        }
    }
}
function requestAttention(appId) {
    const el = document.querySelector(`.orchard-dock-item[data-app-id="${CSS.escape(appId)}"]`);
    if (!el)
        return;
    el.classList.remove("orchard-attention");
    // force reflow to restart animation
    void el.offsetWidth;
    el.classList.add("orchard-attention");
    const t = setTimeout(() => { el.classList.remove("orchard-attention"); }, 1400);
    bounceTimers.push(t);
}
function hideOriginalTaskbar() {
    originalTaskbar = document.getElementById("taskbar");
    if (originalTaskbar)
        originalTaskbar.style.display = "none";
}
function showOriginalTaskbar() {
    if (originalTaskbar)
        originalTaskbar.style.display = "";
    originalTaskbar = null;
}
function overrideDataTheme() {
    originalDataTheme = document.body.dataset.theme || null;
    // "orchard" matches no retro color block in style.css, so theme-manager tokens win
    document.body.dataset.theme = "orchard";
}
function restoreDataTheme() {
    // D#37 WS-TH1 fix round 1 (PR #163 review, blocking item 1b): only
    // restore if data-theme still holds OUR sentinel ("orchard"). The
    // `fulc-theme-change` listener this runs from fires AFTER
    // theme-manager.js has already applied the next experience's own
    // data-theme (or left it alone) -- so if data-theme no longer says
    // "orchard" by the time deactivate() runs, something newer already
    // moved it on, and writing the value we saved back over it would
    // reintroduce exactly the stale-accent leak the style.css keying fix
    // above closes.
    if (document.body.dataset.theme !== "orchard") {
        originalDataTheme = null;
        return;
    }
    if (originalDataTheme !== null) {
        document.body.dataset.theme = originalDataTheme;
    }
    else {
        delete document.body.dataset.theme;
    }
    originalDataTheme = null;
}
function interceptWMFocus() {
    if (!window.FULCWM)
        return;
    const wm = window.FULCWM;
    _origWMFocus = wm.focus;
    wm.focus = function (appId, ...args) {
        const result = _origWMFocus.call(wm, appId, ...args);
        const open = wm.getOpen ? wm.getOpen() : [];
        const win = open.find((w) => w.id === appId);
        const el = document.getElementById("orchard-appname");
        if (el && win)
            el.textContent = (win.app && win.app.title) || appId;
        return result;
    };
}
function restoreWMFocus() {
    if (_origWMFocus && window.FULCWM) {
        window.FULCWM.focus = _origWMFocus;
        _origWMFocus = null;
    }
}
function injectStyles() {
    styleEl = document.createElement("link");
    styleEl.rel = "stylesheet";
    styleEl.href = "apps/themes/heritage/orchard.css";
    styleEl.id = "orchard-stylesheet";
    document.head.appendChild(styleEl);
}
function removeStyles() {
    const el = document.getElementById("orchard-stylesheet");
    if (el)
        el.remove();
    styleEl = null;
}
/** React to runtime app registration so the dock reflects newly-available apps
 * without requiring a theme toggle. */
function onAppsChanged() {
    if (!layout)
        return;
    // Reconcile: add any newly-available visible apps not yet in any slot.
    // visible() applies the same registered+entitlement-hide filter as buildDock.
    const availableIds = window.FULCApps?.visible
        ? window.FULCApps.visible().map((a) => a.id).filter((id) => !!id)
        : (window.FULCApps?.ids ? window.FULCApps.ids() : []);
    let changed = false;
    for (const id of availableIds) {
        if (!isAppPinned(layout, id)) {
            layout.slots.push({ type: "app", id });
            changed = true;
        }
    }
    if (changed) {
        saveLayout(layout);
        renderDock();
    }
}
FULCHeritage.register("orchard", {
    activate() {
        injectStyles();
        overrideDataTheme();
        hideOriginalTaskbar();
        buildMenuBar();
        buildDock();
        interceptWMFocus();
        window.OrchardDock = {
            requestAttention,
            refresh: renderDock,
        };
        document.addEventListener("fulc-apps-changed", onAppsChanged);
        // Live re-render when entitlements change (mirror desktop.js:604)
        if (window.FULCEntitlements) {
            _entChangeHandle = window.FULCEntitlements.onChange(function () { renderDock(); });
        }
    },
    deactivate() {
        if (_entChangeHandle) {
            _entChangeHandle.unsubscribe();
            _entChangeHandle = null;
        }
        bounceTimers.forEach((t) => { clearTimeout(t); });
        bounceTimers = [];
        document.removeEventListener("fulc-apps-changed", onAppsChanged);
        document.removeEventListener("fulc-workspace-change", onWorkspaceChange);
        dockState?.stop();
        dockState = null;
        minimized?.stop();
        minimized = null;
        folders?.teardown();
        folders = null;
        layout = null;
        delete window.OrchardDock;
        if (menuBar) {
            if (menuBar._clockInterval)
                clearInterval(menuBar._clockInterval);
            menuBar.remove();
            menuBar = null;
        }
        if (dock) {
            dock.remove();
            dock = null;
        }
        showOriginalTaskbar();
        restoreDataTheme();
        restoreWMFocus();
        removeStyles();
    },
});
//# sourceMappingURL=orchard-adapter.js.map