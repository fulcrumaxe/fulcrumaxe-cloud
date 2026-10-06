// Pure DOM builders for the Crystal heritage adapter. Extracted so they can
// be tested without pulling in core/heritage-shell.js — see orchard-dom.ts
// for the rationale.
//
// D#37 WS-TH1 (C19b criterion 2): buildCrystalTaskbarEl() used to build its
// whole fragment as one `.innerHTML` template-literal assignment -- a
// Trusted Types sink under the enforced `require-trusted-types-for
// 'script'` policy. Rebuilt with createElement/createElementNS so nothing
// here parses a string as markup.
import { buildCrystalIcon } from "./crystal-icons.js";
const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) el.setAttribute(key, attrs[key]);
    }
    return el;
}
/**
 * The menu glyph: a single circle, built live so its fill="currentColor" tracks the button's CSS color. (Owner
 * 2026-10-04: the earlier four-square grid read too much like another vendor's logo.)
 */
function buildStartGlyph() {
    const svg = svgEl("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none" });
    svg.appendChild(svgEl("circle", { cx: "8", cy: "8", r: "6.5", fill: "currentColor" }));
    return svg;
}
/**
 * D#37 WS-W2: the workspace switcher -- getWorkspaceCount() native buttons,
 * same builder as orchard-dom.js (each shell stays self-contained). The adapter owns the click handler.
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
/** Build the full Crystal taskbar fragment (unmounted). */
export function buildCrystalTaskbarEl() {
    const tb = document.createElement("div");
    tb.id = "crystal-taskbar";
    const left = document.createElement("div");
    left.className = "crystal-tb-left";
    const center = document.createElement("div");
    center.className = "crystal-tb-center";
    center.id = "crystal-tb-center";
    const startBtn = document.createElement("button");
    startBtn.className = "crystal-start-btn";
    startBtn.id = "crystal-start-btn";
    startBtn.title = "fulcrumaxe-os Menu";
    startBtn.appendChild(buildStartGlyph());
    const tbApps = document.createElement("div");
    tbApps.className = "crystal-tb-apps";
    tbApps.id = "crystal-tb-apps";
    center.appendChild(startBtn);
    center.appendChild(tbApps);
    const right = document.createElement("div");
    right.className = "crystal-tb-right";
    const tray = document.createElement("div");
    tray.className = "crystal-tray";
    tray.id = "crystal-tray";
    const timeEl = document.createElement("span");
    timeEl.className = "crystal-tray-item";
    timeEl.id = "crystal-time";
    tray.appendChild(timeEl);
    right.appendChild(buildWorkspaceSwitcher("crystal-workspaces", "crystal-ws-btn"));
    right.appendChild(tray);
    tb.appendChild(left);
    tb.appendChild(center);
    tb.appendChild(right);
    return tb;
}
/** Build one app-button for the Crystal taskbar. Caller attaches click. */
export function buildCrystalTaskbarAppBtn(app) {
    const btn = document.createElement("button");
    btn.className = "crystal-tb-appbtn";
    if (app.id)
        btn.dataset.appId = app.id;
    btn.title = app.title || app.id || "";
    const iconEl = app.id ? buildCrystalIcon(app.id) : null;
    if (iconEl) {
        btn.appendChild(iconEl);
        btn.style.color = "rgba(255,255,255,0.82)";
    }
    else {
        btn.textContent = app.icon || "■";
    }
    return btn;
}
/** Build the start-panel root with search + grid (unmounted). */
export function buildCrystalStartPanel() {
    const panel = document.createElement("div");
    panel.id = "crystal-start-panel";
    const header = document.createElement("div");
    header.className = "crystal-sp-header";
    const search = document.createElement("input");
    search.className = "crystal-sp-search";
    search.placeholder = "Search apps...";
    search.type = "text";
    header.appendChild(search);
    const grid = document.createElement("div");
    grid.className = "crystal-sp-apps";
    grid.id = "crystal-sp-apps";
    panel.appendChild(header);
    panel.appendChild(grid);
    return panel;
}
/** Build one start-panel item. Caller attaches click. */
export function buildCrystalStartPanelItem(app) {
    const item = document.createElement("div");
    item.className = "crystal-sp-item";
    const iconEl = document.createElement("span");
    iconEl.className = "crystal-sp-icon";
    const iconSvg = app.id ? buildCrystalIcon(app.id) : null;
    if (iconSvg) {
        iconEl.appendChild(iconSvg);
        iconEl.style.color = "rgba(255,255,255,0.82)";
    }
    else {
        iconEl.textContent = app.icon || "■";
    }
    const nameEl = document.createElement("span");
    nameEl.className = "crystal-sp-name";
    nameEl.textContent = app.title || app.id || "";
    item.appendChild(iconEl);
    item.appendChild(nameEl);
    return item;
}
/**
 * Test whether a start-panel item's name contains the (already-lowercased)
 * query. Split out so the input handler reduces to a single call.
 */
export function crystalStartMatches(name, query) {
    return (name || "").toLowerCase().includes(query);
}
/** Format the Crystal tray clock's time and date as plain strings (no markup). */
export function formatCrystalClock(now) {
    const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const date = now.toLocaleDateString([], { month: "short", day: "numeric" });
    return { time, date };
}
/**
 * Build the Crystal tray clock's DOM nodes (time text node, <br>, <small>
 * date</small>) -- replaces the old `el.innerHTML = \`${time}<br><small>...\`\`
 * sink (D#37 WS-TH1, C19b criterion 2).
 */
export function buildCrystalClockNodes(now) {
    const { time, date } = formatCrystalClock(now);
    const small = document.createElement("small");
    small.textContent = date;
    return [document.createTextNode(time), document.createElement("br"), small];
}
//# sourceMappingURL=crystal-dom.js.map