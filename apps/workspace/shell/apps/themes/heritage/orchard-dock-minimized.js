// Minimized-window zone for the Orchard dock.
//
// Renders one slot per minimized window on the right side of the dock,
// separated by a vertical divider. Each slot shows a scaled DOM snapshot of
// the window (captured when we first saw it in a normal state); if no
// snapshot is available we fall back to a labeled icon chip.
//
// No method wrapping — this module is driven by the orchard-dock-state
// poller. Before every refresh cycle it caches a fresh DOM clone for every
// non-minimized open window, so when a window transitions to minimized we
// already have a usable thumbnail from the last-known good state.
import { buildOrchardIcon } from "./orchard-icons.js";
import { showMinimizedMenu } from "./orchard-dock-menu.js";
const captureCache = new Map();
function appTitle(appId) {
    const app = window.FULCApps?.get ? window.FULCApps.get(appId) : null;
    return (app && app.title) || appId;
}
function tryCapture(winEl) {
    try {
        const r = winEl.getBoundingClientRect();
        if (r.width < 20 || r.height < 20)
            return null;
        // The window manager masks one-time secrets ([data-secret-node]) and
        // opted-out subtrees ([data-no-preview]) in every preview clone. Fail
        // closed: with no sanitizer there is no thumbnail, only the icon chip.
        const wm = window.FULCWM;
        if (!wm || typeof wm.sanitizePreviewClone !== "function")
            return null;
        const clone = wm.sanitizePreviewClone(winEl.cloneNode(true));
        clone.removeAttribute("id");
        clone.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
        clone.querySelectorAll("input,button,textarea,select").forEach((n) => {
            n.disabled = true;
        });
        clone.style.pointerEvents = "none";
        clone.style.position = "absolute";
        clone.style.top = "0";
        clone.style.left = "0";
        clone.style.width = `${r.width}px`;
        clone.style.height = `${r.height}px`;
        clone.style.transformOrigin = "top left";
        clone.classList.add("orchard-dock-min-clone");
        return { clone, srcW: r.width, srcH: r.height };
    }
    catch {
        return null;
    }
}
function buildMinItem(appId, cap, deps) {
    const item = document.createElement("div");
    item.className = "orchard-dock-item orchard-dock-min-item";
    item.dataset.appId = appId;
    const frame = document.createElement("div");
    frame.className = "orchard-dock-min-frame";
    if (cap) {
        const TARGET_W = 60;
        const TARGET_H = 44;
        const scale = Math.min(TARGET_W / cap.srcW, TARGET_H / cap.srcH);
        frame.style.width = `${TARGET_W}px`;
        frame.style.height = `${TARGET_H}px`;
        const inner = cap.clone.cloneNode(true);
        inner.style.transform = `scale(${scale})`;
        frame.appendChild(inner);
    }
    else {
        frame.classList.add("orchard-dock-min-fallback");
        const iconSvg = buildOrchardIcon(appId);
        if (iconSvg)
            frame.appendChild(iconSvg);
        else {
            const a = window.FULCApps?.get ? window.FULCApps.get(appId) : null;
            frame.textContent = (a && a.icon) || "◈";
        }
    }
    const label = document.createElement("span");
    label.className = "orchard-dock-label";
    label.textContent = appTitle(appId);
    item.appendChild(frame);
    item.appendChild(label);
    item.addEventListener("click", () => {
        const wm = window.FULCWM;
        if (!wm)
            return;
        wm.restore(appId);
        wm.focus(appId);
    });
    item.addEventListener("contextmenu", (e) => {
        showMinimizedMenu(e, appId, appId, deps);
    });
    return item;
}
export function createMinimized(deps) {
    let zone = null;
    let divider = null;
    let captureId = null;
    function ensureZone() {
        const inner = document.getElementById("orchard-dock-inner");
        if (!inner)
            throw new Error("orchard-dock-inner missing");
        if (!divider || !divider.isConnected) {
            divider = document.createElement("div");
            divider.className = "orchard-dock-divider orchard-dock-divider-min";
            inner.appendChild(divider);
        }
        if (!zone || !zone.isConnected) {
            zone = document.createElement("div");
            zone.className = "orchard-dock-minimized-zone";
            inner.appendChild(zone);
        }
        return zone;
    }
    /** Cache a fresh DOM clone of every currently-visible window. Runs on a
     * slow interval so the thumbnails are recent when a window gets minimized. */
    function captureOpenWindows() {
        const wm = window.FULCWM;
        if (!wm || !wm.getOpen)
            return;
        const open = wm.getOpen();
        for (const win of open) {
            if (win.state === "minimized")
                continue;
            if (!win.el)
                continue;
            const cap = tryCapture(win.el);
            if (cap)
                captureCache.set(win.id, cap);
        }
        // Drop stale captures for apps that are no longer open
        const stillOpen = new Set(open.map((w) => w.id));
        for (const id of Array.from(captureCache.keys())) {
            if (!stillOpen.has(id))
                captureCache.delete(id);
        }
    }
    function refresh() {
        const wm = window.FULCWM;
        if (!wm || !wm.getOpen)
            return;
        const open = wm.getOpen();
        const minimized = open.filter((w) => w.state === "minimized");
        const z = ensureZone();
        z.replaceChildren();
        if (minimized.length === 0) {
            z.style.display = "none";
            if (divider)
                divider.style.display = "none";
            return;
        }
        z.style.display = "";
        if (divider)
            divider.style.display = "";
        minimized.forEach((win) => {
            const cap = captureCache.get(win.id) || null;
            z.appendChild(buildMinItem(win.id, cap, deps));
        });
    }
    function start() {
        ensureZone();
        captureOpenWindows();
        refresh();
        // Refresh thumbnail snapshots every 2s — cheap and keeps the minimized
        // thumbnail close to the window's current contents.
        captureId = setInterval(captureOpenWindows, 2000);
    }
    function stop() {
        if (captureId !== null) {
            clearInterval(captureId);
            captureId = null;
        }
        captureCache.clear();
        if (zone) {
            zone.remove();
            zone = null;
        }
        if (divider) {
            divider.remove();
            divider = null;
        }
    }
    return { ensureZone, refresh, captureOpenWindows, start, stop };
}
//# sourceMappingURL=orchard-dock-minimized.js.map