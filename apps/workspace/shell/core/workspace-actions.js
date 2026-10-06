// ── Workspace actions shared by the three shells ─────────────────────────────
// D#37 WS-W3 (C27). The CRT dock (taskbar.js), Orchard and Crystal all offer
// the same workspace menu items and the same Shift+F10 / ContextMenu opening,
// so both live here once. Nothing in this module clones a window (WS-W3
// criterion 9); it only reads the model through window.FULCWM.
import { FULCPhoneMode } from "./phone-mode.js";

function isPhone() {
  return !!(FULCPhoneMode && FULCPhoneMode.isPhone());
}

/**
 * The workspace a window sits on when that is NOT the current one, else 0.
 * Always 0 on a phone (every window counts as being here) and for a sticky
 * window (workspace 0).
 */
export function elsewhereWorkspace(appId) {
  const wm = window.FULCWM;
  if (!wm || !wm.getOpen || isPhone()) return 0;
  const win = wm.getOpen().find(function (w) { return w.id === appId; });
  if (!win || win.workspace === 0) return 0;
  return win.workspace !== wm.getActiveWorkspace() ? win.workspace : 0;
}

/**
 * Mark (or unmark) a launcher entry for a window on another workspace: class,
 * a numbered badge, and an accessible name that says where the window is.
 * Idempotent, so a fulc-workspace-change listener can re-run it on every entry.
 */
export function syncElsewhereMarker(el, appId, cls, baseLabel) {
  const n = elsewhereWorkspace(appId);
  const badge = el.querySelector(":scope > .ws-elsewhere-badge");
  el.classList.toggle(cls, n !== 0);
  if (n === 0) {
    if (badge) badge.remove();
    el.setAttribute("aria-label", baseLabel);
    return;
  }
  const b = badge || document.createElement("span");
  b.className = "ws-elsewhere-badge";
  b.setAttribute("aria-hidden", "true");
  b.textContent = String(n);
  if (!badge) el.appendChild(b);
  el.setAttribute("aria-label", baseLabel + ", on Workspace " + n);
}

function workspaceChoices(pick, checked) {
  const wm = window.FULCWM;
  const items = [];
  for (let n = 1; n <= wm.getWorkspaceCount(); n++) {
    items.push({
      label: (n === checked ? "✓ " : "") + "Workspace " + n,
      action: function () { pick(n); },
    });
  }
  return items;
}

/** "Switch Workspace" submenu for a launcher's background menu; [] on a phone. */
export function switchWorkspaceItems() {
  const wm = window.FULCWM;
  if (!wm || !wm.getWorkspaceCount || isPhone()) return [];
  return [{
    label: "Switch Workspace",
    submenu: workspaceChoices(function (n) { wm.switchWorkspace(n); }, wm.getActiveWorkspace()),
  }];
}

/**
 * The items every theme's item menu appends for a running window. [] on a
 * phone or for a sticky window. Otherwise: "Go to Workspace N" and "Move to
 * This Workspace" when the window is elsewhere, then "Move to Workspace"
 * with a check on the window's own workspace.
 */
export function workspaceMenuItems(appId) {
  const wm = window.FULCWM;
  if (!wm || !wm.getOpen || isPhone()) return [];
  const win = wm.getOpen().find(function (w) { return w.id === appId; });
  if (!win || win.workspace === 0) return [];
  const items = [];
  const elsewhere = elsewhereWorkspace(appId);
  if (elsewhere) {
    items.push({ label: "Go to Workspace " + elsewhere, action: function () { wm.jumpTo(appId); } });
    items.push({ label: "Move to This Workspace", action: function () { wm.bringHere(appId); } });
  }
  items.push({
    label: "Move to Workspace",
    submenu: workspaceChoices(function (n) { wm.moveToWorkspace(appId, n); }, win.workspace),
  });
  return items;
}

/**
 * Open an item's menu from the keyboard (Shift+F10 or the ContextMenu key).
 * The shell handles the key itself and prevents the default, so the result
 * does not depend on the browser also firing a native contextmenu. The menu
 * is anchored to the item's bottom-left corner.
 */
export function bindMenuKeys(el, openMenu) {
  el.addEventListener("keydown", function (ev) {
    if (!(ev.key === "ContextMenu" || (ev.key === "F10" && ev.shiftKey))) return;
    ev.preventDefault();
    ev.stopPropagation();
    const r = el.getBoundingClientRect();
    openMenu({
      type: "contextmenu",
      target: el,
      clientX: r.left,
      clientY: r.bottom,
      preventDefault: function () {},
      stopPropagation: function () {},
    });
  });
}
