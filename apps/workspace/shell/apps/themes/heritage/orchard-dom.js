// Pure DOM builders for the Orchard heritage adapter. These factor out the
// createElement-heavy fragments from the adapter so they can be unit-tested
// without pulling in core/heritage-shell.js (which vitest can't resolve
// from source because the runtime file lives under assets/core/ after tsc).
//
// D#37 WS-TH1 (C19b criterion 2): buildOrchardMenuBarEl() and
// buildOrchardDockEl() used to build their fragments with one `.innerHTML`
// template-literal assignment each -- both Trusted Types sinks under the
// enforced `require-trusted-types-for 'script'` policy. Rebuilt with
// createElement/createElementNS so nothing here parses a string as markup.
//
// D#37 Correction C20 (discussioncomment-18616362), task WS-B2 criterion 2:
// the menubar app-name used to hardcode "fulcrumaxe-os". It now reads the
// same branding the boot sequence uses (window.brandingData.product_name,
// falling back to os_name), so it tracks WS-B1's owner-ruled /api/branding
// values instead of a literal string. `typeof window` is guarded because
// this module is imported directly by unit tests (branding-defaults.test.mjs)
// under vitest's node environment, where no global `window` exists unless a
// test stubs one -- the WS-B1 ruled default ("fulcrumaxe cloud") covers both
// that case and a real page where branding hasn't loaded yet.
import { buildOrchardIcon } from "./orchard-icons.js";
const SVG_NS = "http://www.w3.org/2000/svg";
const WS_B1_DEFAULT_PRODUCT_NAME = "fulcrumaxe cloud";
function currentProductName() {
    if (typeof window === "undefined" || !window.brandingData) return WS_B1_DEFAULT_PRODUCT_NAME;
    return window.brandingData.product_name || window.brandingData.os_name || WS_B1_DEFAULT_PRODUCT_NAME;
}
function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) el.setAttribute(key, attrs[key]);
    }
    return el;
}
/** The apple-glyph logo, built live so its fill="currentColor" tracks the surrounding CSS color. */
function buildLogoGlyph() {
    const svg = svgEl("svg", { width: "14", height: "14", viewBox: "0 0 14 14", fill: "none" });
    svg.appendChild(svgEl("path", {
        d: "M7 1C4.8 1 3 2.8 3 5c0 2.8 4 8 4 8s4-5.2 4-8c0-2.2-1.8-4-4-4zm0 5.5A1.5 1.5 0 1 1 7 3a1.5 1.5 0 0 1 0 3.5z",
        fill: "currentColor",
        opacity: "0.9",
    }));
    return svg;
}
/**
 * D#37 WS-W2: the workspace switcher -- getWorkspaceCount() native buttons,
 * the heritage counterpart of the CRT workspace dots. Only the active one carries
 * aria-current. The adapter owns the click handler (one delegated listener).
 */
export function buildWorkspaceSwitcher(id, btnClass) {
    // Read the live model; the fallbacks cover unit tests with no window.FULCWM.
    const wm = typeof window === "undefined" ? null : window.FULCWM;
    const count = wm && wm.getWorkspaceCount ? wm.getWorkspaceCount() : 4;
    const active = wm && wm.getActiveWorkspace ? wm.getActiveWorkspace() : 1;
    const group = document.createElement("div");
    group.id = id;
    for (let n = 1; n <= count; n++) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = btnClass;
        btn.setAttribute("data-workspace", String(n));
        btn.textContent = String(n);
        btn.title = "Workspace " + n;
        btn.setAttribute("aria-label", "Workspace " + n);
        if (n === active) btn.setAttribute("aria-current", "true");
        group.appendChild(btn);
    }
    return group;
}
/** Move aria-current to workspace `active`, touching only the buttons whose state changes. */
export function syncWorkspaceSwitcher(group, active) {
    if (!group) return;
    group.querySelectorAll("button").forEach((btn) => {
        const on = btn.dataset.workspace === String(active);
        if (on === btn.hasAttribute("aria-current")) return;
        if (on) btn.setAttribute("aria-current", "true");
        else btn.removeAttribute("aria-current");
    });
}
/** Build the macOS-style menu-bar DOM fragment (unmounted). */
export function buildOrchardMenuBarEl() {
    const bar = document.createElement("div");
    bar.id = "orchard-menubar";
    const left = document.createElement("div");
    left.className = "orchard-mb-left";
    const logo = document.createElement("span");
    logo.className = "orchard-mb-logo";
    logo.appendChild(buildLogoGlyph());
    const appname = document.createElement("span");
    appname.className = "orchard-mb-appname";
    appname.id = "orchard-appname";
    appname.textContent = currentProductName();
    left.appendChild(logo);
    left.appendChild(appname);
    const right = document.createElement("div");
    right.className = "orchard-mb-right";
    const timeEl = document.createElement("span");
    timeEl.className = "orchard-mb-item";
    timeEl.id = "orchard-time";
    right.appendChild(buildWorkspaceSwitcher("orchard-workspaces", "orchard-ws-btn"));
    right.appendChild(timeEl);
    bar.appendChild(left);
    bar.appendChild(right);
    return bar;
}
/** Build the empty dock container (unmounted). */
export function buildOrchardDockEl() {
    const dock = document.createElement("div");
    dock.id = "orchard-dock";
    const inner = document.createElement("div");
    inner.className = "orchard-dock-inner";
    inner.id = "orchard-dock-inner";
    dock.appendChild(inner);
    return dock;
}
/** Build a single dock item for one app. Caller attaches click handler. */
export function buildOrchardDockItem(app) {
    // D#37 WS-W3 criterion 7: a native button, so the dock is reachable by keyboard.
    const item = document.createElement("button");
    item.type = "button";
    item.className = "orchard-dock-item";
    item.setAttribute("aria-label", app.title || app.id || "");
    if (app.id)
        item.dataset.appId = app.id;
    const icon = document.createElement("div");
    icon.className = "orchard-dock-icon";
    if (app.id)
        icon.dataset.appIcon = app.id;
    const iconSvg = app.id ? buildOrchardIcon(app.id) : null;
    if (iconSvg) {
        icon.appendChild(iconSvg);
        icon.style.color = "rgba(255,255,255,0.82)";
    }
    else {
        icon.textContent = app.icon || "◈";
    }
    const label = document.createElement("span");
    label.className = "orchard-dock-label";
    label.textContent = app.title || app.id || "";
    const dot = document.createElement("span");
    dot.className = "orchard-dock-dot";
    if (app.id)
        dot.id = `orchard-dot-${app.id}`;
    item.appendChild(icon);
    item.appendChild(label);
    item.appendChild(dot);
    return item;
}
/**
 * D#37 WS-W3 criterion 7: rebuild a div dock item (the folder item, which
 * orchard-dock-folders.js builds) as a native button with the same class,
 * data attributes and children. Its listeners do not carry over; the caller
 * wires click again.
 */
export function orchardItemToButton(divItem, label) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = divItem.className;
    btn.setAttribute("aria-label", label);
    for (const key in divItem.dataset)
        btn.dataset[key] = divItem.dataset[key];
    while (divItem.firstChild)
        btn.appendChild(divItem.firstChild);
    return btn;
}
/**
 * Compute the per-item scale given the cursor position and the item's screen
 * rectangle. Mirrors the magnification curve in the adapter's mousemove
 * handler; exposed separately so it's testable.
 */
export function orchardDockScale(cursorX, rectLeft, rectWidth, maxDist = 120) {
    const centerX = rectLeft + rectWidth / 2;
    const dist = Math.abs(cursorX - centerX);
    if (dist >= maxDist)
        return 1;
    return 1 + 0.7 * Math.pow(1 - dist / maxDist, 2);
}
/** Format a Date as the two-digit HH:MM string the Orchard clock displays. */
export function formatOrchardClock(now) {
    return now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
//# sourceMappingURL=orchard-dom.js.map