// ── Crystal Heritage Adapter ───────────────────────────────────────────
// Builds a Windows-style bottom taskbar + start panel on `activate`, tears
// them down on `deactivate`. Registers with FULCHeritage under id "crystal".
import { FULCHeritage } from "../../../core/heritage-shell.js";
// crystal-icons.js exports CrystalIcons/buildCrystalIcon directly (the
// Trusted Types rewrite removed the old window global); the DOM builders
// import from it themselves, so this bare import only guarantees the
// module loads for build.mjs's reachability walk.
import "./crystal-icons.js";
// FULCContextMenu is a module export, not a window global (see orchard-dock-menu.js).
import { FULCContextMenu } from "../../../core/context-menu.js";
import { bindMenuKeys, syncElsewhereMarker, workspaceMenuItems, switchWorkspaceItems } from "../../../core/workspace-actions.js";
import { buildCrystalTaskbarEl, buildCrystalTaskbarAppBtn, buildCrystalStartPanel, buildCrystalStartPanelItem, crystalStartMatches, buildCrystalClockNodes, syncWorkspaceSwitcher, } from "./crystal-dom.js";
let taskbar = null;
let startPanel = null;
let originalTaskbar = null;
let originalDataTheme = null;
let styleEl = null;
let clockInterval = null;
let startOpen = false;
let _origWMOpen = null;
let _origWMClose = null;
let _entChangeHandle = null;
// D#37 WS-W2: keep the switcher in step with the workspace model through
// fulc-workspace-change (no polling). One listener per activation, removed in deactivate().
function onWorkspaceChange() {
    syncWorkspaceSwitcher(document.getElementById("crystal-workspaces"), window.FULCWM?.getActiveWorkspace?.() ?? 1);
    syncTaskbarMarkers();
}
/** D#37 WS-W3: mark the taskbar buttons whose window is on another workspace. */
function syncTaskbarMarkers() {
    document.querySelectorAll(".crystal-tb-appbtn[data-app-id]").forEach(function (btn) {
        syncElsewhereMarker(btn, btn.dataset.appId, "crystal-tb-elsewhere", btn.title || btn.dataset.appId);
    });
}
/** D#37 WS-W3 criterion 5: a taskbar button's menu (right-click or Shift+F10). */
function openAppBtnMenu(e, app) {
    const wm = window.FULCWM;
    if (!wm || !app.id)
        return;
    const win = wm.getOpen().find(function (w) { return w.id === app.id; });
    const items = [];
    if (!win) {
        items.push({ label: "Open", action: function () { wm.open(app.id); } });
    }
    else {
        // open() on a running app restores it and jumps to it wherever it is.
        if (win.state === "minimized")
            items.push({ label: "Show", action: function () { wm.open(app.id); } });
        else
            items.push({ label: "Minimize", action: function () { wm.minimize(app.id); } });
        const wsItems = workspaceMenuItems(app.id);
        if (wsItems.length) {
            items.push({ divider: true });
            wsItems.forEach(function (it) { items.push(it); });
        }
        items.push({ divider: true });
        items.push({ label: "Close", danger: true, action: function () { wm.close(app.id); } });
    }
    FULCContextMenu.show(e, items);
}
/** D#37 WS-W3 criterion 5: right-click on the empty taskbar. */
function onTaskbarContextMenu(e) {
    if (e.target instanceof Element && e.target.closest(".crystal-tb-appbtn, .crystal-tray, .crystal-start-btn, #crystal-workspaces"))
        return;
    const items = switchWorkspaceItems();
    if (!items.length)
        return;
    FULCContextMenu.show(e, items);
}
function onWorkspaceClick(e) {
    const btn = e.target instanceof Element ? e.target.closest("button[data-workspace]") : null;
    if (btn && window.FULCWM?.switchWorkspace) window.FULCWM.switchWorkspace(parseInt(btn.dataset.workspace, 10));
}
function mountWorkspaceSwitcher() {
    const group = document.getElementById("crystal-workspaces");
    if (!group) return;
    group.addEventListener("click", onWorkspaceClick);
    // Its own group name: the hidden CRT #workspace-indicator still registers as "workspaces".
    window.FULCTaskbarKeyboard?.attach(group, { group: "heritage-workspaces", label: "Workspaces", itemSelector: "button" });
    document.addEventListener("fulc-workspace-change", onWorkspaceChange);
}
function buildTaskbar() {
    taskbar = buildCrystalTaskbarEl();
    document.body.appendChild(taskbar);
    taskbar.addEventListener("contextmenu", onTaskbarContextMenu);
    mountWorkspaceSwitcher();
    populateTaskbarApps();
    wireStartButton();
    startClock();
    syncRunningState();
}
function populateTaskbarApps() {
    const container = document.getElementById("crystal-tb-apps");
    if (!container)
        return;
    container.replaceChildren();
    const ent = window.FULCEntitlements;
    // Use visible() so trimmed (unregistered) apps are absent from the taskbar,
    // while registered-but-denied apps with whenDenied==='show-locked' still appear.
    const apps = (window.FULCApps && window.FULCApps.visible) ? window.FULCApps.visible() : [];
    apps.forEach(function (app) {
        // Skip apps that should be fully hidden when denied
        if (ent && ent.isAppHidden(app))
            return;
        const btn = buildCrystalTaskbarAppBtn(app);
        btn.addEventListener("click", function () {
            if (app.id && window.FULCWM)
                window.FULCWM.open(app.id);
        });
        const openMenu = function (e) { openAppBtnMenu(e, app); };
        btn.addEventListener("contextmenu", openMenu);
        bindMenuKeys(btn, openMenu);
        // Apply lock overlay for denied-but-visible apps
        if (ent)
            ent.applyGate(btn, app);
        container.appendChild(btn);
    });
}
function buildStartPanel() {
    startPanel = buildCrystalStartPanel();
    const grid = startPanel.querySelector("#crystal-sp-apps");
    const ent = window.FULCEntitlements;
    // Use visible() — same rule as taskbar: unregistered apps are absent;
    // registered denied-show-locked apps remain clickable for the upgrade modal.
    const apps = (window.FULCApps && window.FULCApps.visible) ? window.FULCApps.visible() : [];
    apps.forEach(function (app) {
        // Skip apps that should be fully hidden when denied
        if (ent && ent.isAppHidden(app))
            return;
        const item = buildCrystalStartPanelItem(app);
        item.addEventListener("click", function () {
            if (app.id && window.FULCWM)
                window.FULCWM.open(app.id);
            closeStart();
        });
        // Apply lock overlay for denied-but-visible apps
        if (ent)
            ent.applyGate(item, app);
        grid.appendChild(item);
    });
    document.body.appendChild(startPanel);
    const search = startPanel.querySelector(".crystal-sp-search");
    search.addEventListener("input", function (e) {
        const q = e.target.value.toLowerCase();
        if (!startPanel)
            return;
        startPanel.querySelectorAll(".crystal-sp-item").forEach(function (item) {
            const nameEl = item.querySelector(".crystal-sp-name");
            const name = nameEl ? nameEl.textContent : "";
            item.style.display = crystalStartMatches(name, q) ? "" : "none";
        });
    });
    document.addEventListener("pointerdown", onOutsideClick);
}
function onOutsideClick(e) {
    if (startPanel && startOpen && !startPanel.contains(e.target) && !(e.target instanceof Element && e.target.closest("#crystal-start-btn"))) {
        closeStart();
    }
}
function wireStartButton() {
    const btn = document.getElementById("crystal-start-btn");
    if (!btn)
        return;
    btn.addEventListener("click", function () {
        if (startOpen)
            closeStart();
        else
            openStart();
    });
}
function openStart() {
    if (!startPanel)
        return;
    startPanel.classList.add("crystal-sp-open");
    startOpen = true;
    const search = startPanel.querySelector(".crystal-sp-search");
    if (search)
        search.focus();
}
function closeStart() {
    if (!startPanel)
        return;
    startPanel.classList.remove("crystal-sp-open");
    startOpen = false;
}
function startClock() {
    const el = document.getElementById("crystal-time");
    if (!el)
        return;
    // dom-insert-ok: buildCrystalClockNodes returns a fixed list of text and element nodes (crystal-dom.js)
    const tick = () => { el.replaceChildren(...buildCrystalClockNodes(new Date())); };
    tick();
    clockInterval = setInterval(tick, 10000);
}
function updateRunningState(appId, running) {
    const btn = document.querySelector(`#crystal-tb-apps .crystal-tb-appbtn[data-app-id="${appId}"]`);
    if (btn) {
        btn.classList.toggle("running", running);
        syncElsewhereMarker(btn, appId, "crystal-tb-elsewhere", btn.title || appId);
    }
}
function syncRunningState() {
    if (!window.FULCWM)
        return;
    const wm = window.FULCWM;
    const open = wm.getOpen ? wm.getOpen() : [];
    const openIds = new Set(open.map(function (w) { return (w.appId || w.id); }));
    document.querySelectorAll(".crystal-tb-appbtn").forEach(function (btn) {
        const id = btn.dataset.appId || "";
        btn.classList.toggle("running", openIds.has(id));
    });
    syncTaskbarMarkers();
}
function interceptWM() {
    if (!window.FULCWM)
        return;
    const wm = window.FULCWM;
    _origWMOpen = wm.open;
    wm.open = function (appId, ...args) {
        const result = _origWMOpen.call(wm, appId, ...args);
        setTimeout(function () { updateRunningState(appId, true); }, 60);
        return result;
    };
    _origWMClose = wm.close;
    wm.close = function (appId, ...args) {
        const result = _origWMClose.call(wm, appId, ...args);
        setTimeout(function () {
            const stillOpen = !!(wm.isOpen && wm.isOpen(appId));
            updateRunningState(appId, stillOpen);
        }, 60);
        return result;
    };
}
function restoreWM() {
    if (!window.FULCWM)
        return;
    const wm = window.FULCWM;
    if (_origWMOpen) {
        wm.open = _origWMOpen;
        _origWMOpen = null;
    }
    if (_origWMClose) {
        wm.close = _origWMClose;
        _origWMClose = null;
    }
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
    document.body.dataset.theme = "crystal";
}
function restoreDataTheme() {
    // D#37 WS-TH1 fix round 1 (PR #163 review, blocking item 1b): only
    // restore if data-theme still holds OUR sentinel ("crystal"). The
    // `fulc-theme-change` listener this runs from fires AFTER
    // theme-manager.js has already applied the next experience's own
    // data-theme (or left it alone) -- so if data-theme no longer says
    // "crystal" by the time deactivate() runs, something newer already
    // moved it on, and writing the value we saved back over it would
    // reintroduce exactly the stale-accent leak the style.css keying fix
    // closes (see orchard-adapter.js's identical fix and style.css's
    // legacy-block comment).
    if (document.body.dataset.theme !== "crystal") {
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
function injectStyles() {
    styleEl = document.createElement("link");
    styleEl.rel = "stylesheet";
    styleEl.href = "apps/themes/heritage/crystal.css";
    styleEl.id = "crystal-stylesheet";
    document.head.appendChild(styleEl);
}
function removeStyles() {
    const el = document.getElementById("crystal-stylesheet");
    if (el)
        el.remove();
    styleEl = null;
}
FULCHeritage.register("crystal", {
    activate() {
        injectStyles();
        overrideDataTheme();
        hideOriginalTaskbar();
        buildTaskbar();
        buildStartPanel();
        interceptWM();
        // Live re-render when entitlements change (e.g. admin toggles a capability)
        if (window.FULCEntitlements) {
            _entChangeHandle = window.FULCEntitlements.onChange(function () {
                populateTaskbarApps();
                if (startPanel) {
                    // Rebuild start panel contents in place
                    const grid = startPanel.querySelector("#crystal-sp-apps");
                    if (grid) {
                        grid.replaceChildren();
                        const ent = window.FULCEntitlements;
                        const apps = (window.FULCApps && window.FULCApps.visible) ? window.FULCApps.visible() : [];
                        apps.forEach(function (app) {
                            if (ent && ent.isAppHidden(app))
                                return;
                            const item = buildCrystalStartPanelItem(app);
                            item.addEventListener("click", function () {
                                if (app.id && window.FULCWM)
                                    window.FULCWM.open(app.id);
                                closeStart();
                            });
                            if (ent)
                                ent.applyGate(item, app);
                            grid.appendChild(item);
                        });
                    }
                }
            });
        }
    },
    deactivate() {
        if (_entChangeHandle) {
            _entChangeHandle.unsubscribe();
            _entChangeHandle = null;
        }
        if (clockInterval)
            clearInterval(clockInterval);
        clockInterval = null;
        document.removeEventListener("pointerdown", onOutsideClick);
        document.removeEventListener("fulc-workspace-change", onWorkspaceChange);
        if (taskbar) {
            taskbar.remove();
            taskbar = null;
        }
        if (startPanel) {
            startPanel.remove();
            startPanel = null;
        }
        showOriginalTaskbar();
        restoreDataTheme();
        restoreWM();
        removeStyles();
        startOpen = false;
    },
});
//# sourceMappingURL=crystal-adapter.js.map