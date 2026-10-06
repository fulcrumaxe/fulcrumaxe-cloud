// ── fulcrumaxe-os Taskbar (Dock Hybrid) ───────────────────────────────────────
// macOS-style dock merged with Windows 11 taskbar.
// Three sections: pinned apps (left), open windows (center), system tray (right).
// Exposes: window.FULCTaskbar
import { FULCApps } from "./app-registry.js";
import { FULCContextMenu } from "./context-menu.js";
// D#37 WS-B (fork edit, read flags only): gates the unread-messages poll
// below on features.messages -- see updateBadge().
import { getFeatures } from "./features.js";
// D#37 WS-C2 criterion 11: persisted under storage-ns.js's fx:<ns>:
// namespace, not a raw localStorage key.
import { getItem, setItem } from "./storage-ns.js";
// D#37 WS-C2 criterion 12: the dock/user menu's sign-out entry point.
import { signOut } from "./cloud-signout.js";
import { FULCPhoneMode } from "./phone-mode.js";
// D#37 WS-W3: the workspace menu items, the elsewhere marker and the
// Shift+F10 binding, shared with Orchard and Crystal.
import { workspaceMenuItems, syncElsewhereMarker, bindMenuKeys } from "./workspace-actions.js";

(function () {
  'use strict';

  // D#37 WS-E criterion 6: the active profile's `dock_order`
  // (profiles/cloud.json), substituted at build time by
  // build/profile.mjs's substituteDockOrder() -- the same technique WS-D
  // criterion 7 uses for theme-manager.js's DEFAULT_THEME_ID. Outside a
  // profile build (dev, unit tests) this stays empty and defaultPins()
  // falls back to DEFAULT_PINS below, unchanged.
  var DOCK_ORDER = [];

  const taskbar = document.getElementById('taskbar');
  const pinnedArea = document.getElementById('dock-pinned');
  const openArea = document.getElementById('dock-open');
  const clockEl = document.getElementById('taskbar-clock');
  const userEl = document.getElementById('taskbar-user');
  const badgeEl = document.getElementById('taskbar-badge');
  const workspaceIndicator = document.getElementById('workspace-indicator');

  if (!taskbar) return;

  const DEFAULT_PINS = ['terminal', 'file-manager', 'messages'];
  const STORAGE_KEY = 'dock-pins';

  // ── Pin persistence ─────────────────────────────────────────────────

  // Compute the default pin list for the current session.
  // Under the default profile DEFAULT_PINS all register → unchanged.
  // Under a curated profile (e.g. skeleton) none of DEFAULT_PINS register,
  // so we fall back to registered + entitlement-visible apps (up to 6)
  // so the dock is never empty.
  function defaultPins() {
    // D#37 WS-E criterion 6: dock order comes from the profile's
    // dock_order first, filtered to apps that are actually registered
    // (most of the named apps -- Pipeline, Runs, Repos, ... -- are later
    // WS-F tasks and simply aren't registered yet; they take their place
    // automatically once they are).
    if (DOCK_ORDER.length > 0) {
      var ordered = DOCK_ORDER.filter(function (id) {
        return window.FULCApps && window.FULCApps.isRegistered && window.FULCApps.isRegistered(id);
      });
      if (ordered.length > 0) return ordered;
    }
    // Intersection of DEFAULT_PINS with actually-registered apps.
    var reg = DEFAULT_PINS.filter(function (id) {
      return window.FULCApps && window.FULCApps.isRegistered && window.FULCApps.isRegistered(id);
    });
    if (reg.length > 0) return reg;
    // Fallback: seed from entitlement-visible registered apps (capped at 6).
    var vis = (window.FULCApps && window.FULCApps.visible)
      ? window.FULCApps.visible().map(function (a) { return a.id; })
      : [];
    return vis.slice(0, 6);
  }

  function getPins() {
    try {
      const stored = getItem(STORAGE_KEY);
      if (stored) return JSON.parse(stored);
    } catch (e) {}
    return defaultPins();
  }

  function savePins(pins) {
    setItem(STORAGE_KEY, JSON.stringify(pins));
  }

  function addPin(appId) {
    const pins = getPins();
    if (pins.indexOf(appId) === -1) {
      pins.push(appId);
      savePins(pins);
    }
  }

  function removePin(appId) {
    const pins = getPins().filter(function (id) { return id !== appId; });
    savePins(pins);
  }

  // ── Window state helper ─────────────────────────────────────────────

  function getWindowState(appId) {
    if (!window.FULCWM) return null;
    const openWindows = window.FULCWM.getOpen();
    return openWindows.find(function (w) { return w.id === appId; }) || null;
  }

  // ── Tooltip ─────────────────────────────────────────────────────────

  const tooltip = document.createElement('div');
  tooltip.className = 'dock-tooltip';
  tooltip.style.display = 'none';
  taskbar.appendChild(tooltip);

  // ── Hover preview ───────────────────────────────────────────────────

  const previewEl = document.createElement('div');
  previewEl.className = 'dock-preview';
  previewEl.style.display = 'none';
  document.body.appendChild(previewEl);
  let previewTimer = null;
  let peekTimer = null;
  let peekActive = false;

  function startPeek(appId) {
    if (!window.FULCWM) return;
    const openWins = window.FULCWM.getOpen();

    openWins.forEach(function (ws) {
      if (ws.id !== appId && ws.state !== 'minimized') {
        ws.el.classList.add('peek-dimmed');
      }
    });
    peekActive = true;
  }

  function stopPeek() {
    if (!peekActive) return;
    if (!window.FULCWM) return;
    const openWins = window.FULCWM.getOpen();

    openWins.forEach(function (ws) {
      ws.el.classList.remove('peek-dimmed');
    });
    peekActive = false;
  }

  function showPreview(icon, appId) {
    const ws = getWindowState(appId);
    if (!ws || ws.state === 'minimized') return;

    const clone = window.FULCWM.sanitizePreviewClone(ws.el.cloneNode(true));
    clone.classList.remove('active', 'dragging', 'resizing', 'opening', 'closing');
    clone.style.position = 'relative';
    clone.style.left = '0';
    clone.style.top = '0';
    clone.style.width = ws.el.offsetWidth + 'px';
    clone.style.height = ws.el.offsetHeight + 'px';
    clone.style.pointerEvents = 'none';
    clone.style.zIndex = 'auto';
    clone.style.transform = 'none';

    clone.querySelectorAll('.wm-edge, .wm-corner').forEach(function (e) { e.remove(); });

    previewEl.replaceChildren();
    previewEl.appendChild(clone);
    previewEl.style.display = 'block';

    const PREVIEW_W = 200;
    const scale = PREVIEW_W / ws.el.offsetWidth;
    const previewH = ws.el.offsetHeight * scale;
    previewEl.style.width = PREVIEW_W + 'px';
    previewEl.style.height = previewH + 'px';

    clone.style.transform = 'scale(' + scale.toFixed(4) + ')';
    clone.style.transformOrigin = 'top left';

    const iconRect = icon.getBoundingClientRect();
    let left = iconRect.left + iconRect.width / 2 - PREVIEW_W / 2;
    if (left < 4) left = 4;
    if (left + PREVIEW_W > window.innerWidth - 4) left = window.innerWidth - PREVIEW_W - 4;

    previewEl.style.left = left + 'px';
    previewEl.style.bottom = (window.innerHeight - iconRect.top + 6) + 'px';
    previewEl.style.top = 'auto';
  }

  function hidePreview() {
    clearTimeout(previewTimer);
    previewEl.style.display = 'none';
    previewEl.replaceChildren();
  }

  // ── Entitlement helpers ─────────────────────────────────────────────

  function getAppEntitlementDecision(appId) {
    const app = window.FULCApps && window.FULCApps.get(appId);
    const cap = (app && app.capability) || ('app.' + appId);
    if (!window.FULCEntitlements || !window.FULCEntitlements._ready) return { type: 'Allow' };
    return window.FULCEntitlements.decision(cap);
  }

  function isAppHiddenByPolicy(appId) {
    const app = window.FULCApps && window.FULCApps.get(appId);
    const whenDenied = (app && app.whenDenied) || 'show-locked';
    const d = getAppEntitlementDecision(appId);
    return d.type === 'Deny' && whenDenied === 'hide';
  }

  // ── Icon rendering ──────────────────────────────────────────────────

  function renderIcon(appId, isPinned, openWindows, active) {
    const app = window.FULCApps && window.FULCApps.get(appId);
    if (!app) return null;

    // A native <button>, not a div (D#649). Before this, the dock was wired
    // with a click listener on a bare div with no role and no tabindex: Tab
    // skipped every icon, Enter and Space did nothing, and a keyboard-only user
    // could not launch an app at all. A native button brings the focusability,
    // the Enter/Space activation and the announced role with it, so none of
    // those have to be reimplemented — and taskbar-keyboard.js only has to
    // decide WHICH icon holds the tab stop.
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'dock-icon' + (isPinned ? ' pinned' : '');
    el.dataset.appId = appId;
    // The visible label is a 2-letter glyph, so the accessible name has to come
    // from the registry — a screen reader announcing "TE" is no better than
    // announcing "div".
    el.setAttribute('aria-label', (app && (app.title || app.name)) || appId);

    const iconText = document.createElement('span');
    iconText.className = 'dock-icon-text';
    iconText.textContent = app.icon || appId.substring(0, 2).toUpperCase();
    el.appendChild(iconText);

    const dot = document.createElement('span');
    dot.className = 'dock-dot';
    el.appendChild(dot);

    // App badge (e.g., running agent count)
    var badge = appBadges[appId];
    if (badge) {
      var badgeSpan = document.createElement('span');
      badgeSpan.className = 'dock-app-badge';
      badgeSpan.textContent = badge;
      el.appendChild(badgeSpan);
    }

    const ws = openWindows.find(function (w) { return w.id === appId; }) || null;

    // D#37 WS-W3: a window on another workspace is marked with its number.
    // The label written above is the base name; the marker appends where it is.
    const baseLabel = el.getAttribute('aria-label');
    if (ws) syncElsewhereMarker(el, appId, 'dock-icon-elsewhere', baseLabel);
    const elsewhere = el.classList.contains('dock-icon-elsewhere');

    if (ws) {
      el.classList.add('running');
      if (ws.state === 'minimized') el.classList.add('minimized-dot');
      if (active && active.id === appId) el.classList.add('active');
      // Only a RUNNING icon is a toggle. On a closed app the button launches,
      // which is not a pressed/unpressed state, and claiming otherwise would
      // announce "not pressed" for every app on the dock.
      el.setAttribute('aria-pressed', active && active.id === appId ? 'true' : 'false');
    }

    // Click: focus/toggle-minimize if open, launch if not (gated by entitlements)
    el.addEventListener('click', function () {
      if (ws) {
        if (elsewhere) {
          // The jump: go where the window is (restores it if minimized).
          window.FULCWM.jumpTo(appId);
        } else if (ws.state === 'minimized') {
          window.FULCWM.restore(appId);
        } else if (active && active.id === appId) {
          window.FULCWM.minimize(appId);
        } else {
          window.FULCWM.focus(appId);
        }
      } else {
        const d = getAppEntitlementDecision(appId);
        if (d.type !== 'Allow') {
          const cap = (app && app.capability) || ('app.' + appId);
          if (window.FULCUpgradeModal) window.FULCUpgradeModal.open({ capability: cap, decision: d });
          return;
        }
        window.FULCWM.open(appId);
      }
    });

    // Entitlement lock overlay for gated apps not currently running
    if (!ws) {
      const d = getAppEntitlementDecision(appId);
      if (d.type !== 'Allow') {
        el.classList.add('fulc-entitlement-locked');
        if (window.FULCFeatureGate) {
          const cap = (app && app.capability) || ('app.' + appId);
          window.FULCFeatureGate._applyOverlay(el, cap, d);
        }
      }
    }

    // Tooltip (mouseenter/mouseleave)
    el.addEventListener('mouseenter', function () {
      const label = app.title || appId.toUpperCase();
      tooltip.textContent = label;
      tooltip.style.display = 'block';

      const iconRect = el.getBoundingClientRect();
      const tipRect = tooltip.getBoundingClientRect();
      tooltip.style.left = (iconRect.left + iconRect.width / 2 - tipRect.width / 2) + 'px';
      tooltip.style.top = (iconRect.top - tipRect.height - 6) + 'px';

      // Hover preview (only for running apps)
      if (ws) {
        previewTimer = setTimeout(function () {
          showPreview(el, appId);
        }, 400);

        // Window Peek
        if (ws.state !== 'minimized') {
          peekTimer = setTimeout(function () {
            startPeek(appId);
          }, 300);
        }
      }
    });

    el.addEventListener('mouseleave', function () {
      tooltip.style.display = 'none';
      hidePreview();
      stopPeek();
      clearTimeout(peekTimer);
    });

    // Context menu (right-click)
    function openItemMenu(e) {
      if (!FULCContextMenu) return;
      const pins = getPins();
      const currentlyPinned = pins.indexOf(appId) !== -1;
      const isRunning = !!ws;

      const items = [];

      if (isRunning) {
        items.push({ label: 'Show', action: function () { window.FULCWM.focus(appId); } });
        items.push({ label: 'Minimize', action: function () { window.FULCWM.minimize(appId); } });
        items.push({ divider: true });
      }

      if (currentlyPinned) {
        items.push({ label: 'Unpin from Dock', action: function () { removePin(appId); update(); } });
      } else {
        items.push({ label: 'Pin to Dock', action: function () { addPin(appId); update(); } });
      }

      // Workspace actions (Go to / Move to This / Move to Workspace), shared
      // with Orchard and Crystal. Empty on a phone and for a sticky window.
      const wsItems = isRunning ? workspaceMenuItems(appId) : [];
      if (wsItems.length) {
        items.push({ divider: true });
        wsItems.forEach(function (it) { items.push(it); });
      }

      if (isRunning) {
        items.push({ divider: true });
        items.push({ label: 'Close', action: function () { window.FULCWM.close(appId); }, danger: true });
      }

      FULCContextMenu.show(e, items);
    }
    el.addEventListener('contextmenu', openItemMenu);
    bindMenuKeys(el, openItemMenu);

    return el;
  }

  // ── Workspace Indicator ─────────────────────────────────────────────

  function updateWorkspaceIndicator() {
    if (!workspaceIndicator || !window.FULCWM) return;
    workspaceIndicator.replaceChildren();

    const active = window.FULCWM.getActiveWorkspace ? window.FULCWM.getActiveWorkspace() : 1;
    const count = window.FULCWM.getWorkspaceCount ? window.FULCWM.getWorkspaceCount() : 4;

    for (var i = 1; i <= count; i++) {
      (function (num) {
        // Native <button> for the same reason as the dock icons (D#649): the
        // span carried a click listener, a title and nothing else, so Tab
        // skipped it and there was no way to switch workspace from the
        // keyboard by this control at all.
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'workspace-dot' + (num === active ? ' active' : '');
        dot.title = 'Workspace ' + num;
        dot.setAttribute('aria-label', 'Workspace ' + num);
        if (num === active) dot.setAttribute('aria-current', 'true');
        dot.addEventListener('click', function () {
          if (window.FULCWM.switchWorkspace) {
            window.FULCWM.switchWorkspace(num);
          }
        });
        workspaceIndicator.appendChild(dot);
      })(i);
    }
  }

  // ── Update ──────────────────────────────────────────────────────────

  function update() {
    if (!pinnedArea || !openArea || !window.FULCWM) return;

    const pins = getPins();
    const openWindows = window.FULCWM.getOpen();
    const active = window.FULCWM.getActive();

    // D#37 WS-W3: every open window is listed. One on another workspace
    // carries a marker (renderIcon) and a click on it jumps there.
    const visibleWindows = openWindows;

    pinnedArea.replaceChildren();
    openArea.replaceChildren();

    // Render pinned icons — skip if policy says hide and app is not running
    pins.forEach(function (appId) {
      const isRunning = visibleWindows.some(function (w) { return w.id === appId; });
      if (!isRunning && isAppHiddenByPolicy(appId)) return;
      const el = renderIcon(appId, true, visibleWindows, active);
      if (el) pinnedArea.appendChild(el);
    });

    // Render open (non-pinned) icons from visible windows only
    visibleWindows.forEach(function (ws) {
      if (pins.indexOf(ws.id) !== -1) return;
      const el = renderIcon(ws.id, false, visibleWindows, active);
      if (el) openArea.appendChild(el);
    });

    // Hide dock-open divider if nothing is in it
    const openDivider = openArea.previousElementSibling;
    if (openDivider && openDivider.classList.contains('dock-divider')) {
      openDivider.style.display = openArea.children.length > 0 ? '' : 'none';
    }

    updateWorkspaceIndicator();

    // The phone dock scrolls sideways when the icons outgrow it
    // (core/taskbar.css); keep the active app's icon in view. Focus already
    // scrolls natively.
    const activeIcon = taskbar.querySelector('.dock-icon.active');
    if (activeIcon && activeIcon.scrollIntoView) {
      activeIcon.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    // Keyboard: one tab stop for the whole dock, roving arrows within it.
    // Behaviour lives in core/taskbar-keyboard.js — this is registration only.
    if (window.FULCTaskbarKeyboard) {
      window.FULCTaskbarKeyboard.attach(pinnedArea, { group: 'dock', label: 'Pinned apps', itemSelector: '.dock-icon' });
      window.FULCTaskbarKeyboard.attach(openArea, { group: 'dock', label: 'Open windows', itemSelector: '.dock-icon' });
      window.FULCTaskbarKeyboard.attach(workspaceIndicator, { group: 'workspaces', label: 'Workspaces', itemSelector: '.workspace-dot' });
    }
  }

  // ── Magnification ───────────────────────────────────────────────────

  function setupMagnification() {
    const MAG_RANGE = 80;
    const MAG_SCALE = 1.35;

    taskbar.addEventListener('mousemove', function (e) {
      const icons = taskbar.querySelectorAll('.dock-icon');
      icons.forEach(function (icon) {
        const rect = icon.getBoundingClientRect();
        const iconCenterX = rect.left + rect.width / 2;
        const dist = Math.abs(e.clientX - iconCenterX);

        if (dist < MAG_RANGE) {
          const scale = MAG_SCALE - ((MAG_SCALE - 1) * (dist / MAG_RANGE));
          icon.style.transform = 'scale(' + scale.toFixed(3) + ')';
          icon.style.transformOrigin = 'bottom center';
        } else {
          icon.style.transform = '';
        }
      });
    });

    taskbar.addEventListener('mouseleave', function () {
      const icons = taskbar.querySelectorAll('.dock-icon');
      icons.forEach(function (icon) {
        icon.style.transform = '';
      });
    });
  }

  // ── Taskbar empty-space context menu ────────────────────────────────

  taskbar.addEventListener('contextmenu', function (e) {
    if (e.target.closest('.dock-icon') || e.target.closest('#taskbar-tray')) return;
    if (!FULCContextMenu) return;

    var workspaceItems = [];
    if (window.FULCWM && window.FULCWM.getWorkspaceCount) {
      var count = window.FULCWM.getWorkspaceCount();
      var active = window.FULCWM.getActiveWorkspace();
      for (var w = 1; w <= count; w++) {
        (function (n) {
          workspaceItems.push({
            label: (n === active ? '\u2713 ' : '') + 'Workspace ' + n,
            action: function () { window.FULCWM.switchWorkspace(n); }
          });
        })(w);
      }
    }

    FULCContextMenu.show(e, [
      { label: 'Switch Workspace', submenu: workspaceItems },
      { divider: true },
      { label: 'Reset Pinned Apps', action: function () {
        savePins(defaultPins());
        update();
      }},
      { divider: true },
      { label: 'Open Terminal', action: function () { window.FULCWM.open('terminal'); } }
    ]);
  });

  // ── Clock ───────────────────────────────────────────────────────────

  function updateClock() {
    if (!clockEl) return;
    const tz = (window.userPreferences && window.userPreferences.timezone) || 'UTC';
    try {
      const now = new Date();
      clockEl.textContent = now.toLocaleTimeString('en-US', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
    } catch (e) {
      clockEl.textContent = new Date().toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: false
      });
    }
  }

  setInterval(updateClock, 1000);
  updateClock();

  // ── User display ──────────────────────────────────────────────────

  function setUser(name) {
    if (userEl) userEl.textContent = name.toUpperCase();
  }

  // ── Unread badge ──────────────────────────────────────────────────

  async function updateBadge() {
    if (!badgeEl) return;
    // D#37 WS-B: cloud profile disables messages entirely -- no poll. This
    // guards both the init() call and every setInterval tick below, and
    // resolves from core/features.js's shared cache (no extra request).
    const features = await getFeatures();
    if (features && features.messages === false) return;
    try {
      const res = await fetch('/api/messages/unread');
      const data = await res.json();
      if (data.count > 0) {
        badgeEl.textContent = data.count;
        badgeEl.classList.remove('hidden');
      } else {
        badgeEl.classList.add('hidden');
      }
    } catch (e) { /* ignore */ }
  }

  setInterval(updateBadge, 30000);

  // ── User menu ────────────────────────────────────────────────────
  // D#37 WS-C2 criterion 12: "Sign out" reachable from the dock/user
  // menu. userEl (the account name in the tray) is that entry point --
  // clicking or activating it with the keyboard opens a one-item popup.

  var userMenuOpen = false;

  function closeUserMenu() {
    if (!userMenuOpen) return;
    userMenuOpen = false;
    var popup = document.getElementById('taskbar-user-menu');
    if (popup) popup.remove();
    document.removeEventListener('mousedown', onDocMouseDownCloseUserMenu, true);
  }

  function onDocMouseDownCloseUserMenu(e) {
    var popup = document.getElementById('taskbar-user-menu');
    // closest(), not `e.target !== userEl`: a press on any descendant of the
    // trigger (icon, badge) is a press on the trigger, whose click handler
    // toggles the menu. Treating it as "outside" would close then reopen it.
    if (popup && !popup.contains(e.target) &&
        !(e.target instanceof Element && e.target.closest('#taskbar-user'))) closeUserMenu();
  }

  function openUserMenu() {
    if (userMenuOpen) { closeUserMenu(); return; }
    userMenuOpen = true;
    var rect = userEl.getBoundingClientRect();
    var popup = document.createElement('div');
    popup.id = 'taskbar-user-menu';
    popup.setAttribute('role', 'menu');
    popup.style.cssText =
      'position:fixed;min-width:160px;background:#000;color:inherit;' +
      'border:1px solid currentColor;font-family:monospace;font-size:12px;z-index:9500;' +
      'bottom:' + (window.innerHeight - rect.top) + 'px;right:' + (window.innerWidth - rect.right) + 'px;';
    var signOutBtn = document.createElement('button');
    signOutBtn.type = 'button';
    signOutBtn.setAttribute('role', 'menuitem');
    signOutBtn.id = 'taskbar-signout';
    signOutBtn.style.cssText =
      'display:block;width:100%;padding:8px 14px;background:none;border:none;' +
      'color:inherit;font:inherit;text-align:left;cursor:pointer;';
    signOutBtn.textContent = 'Sign out';
    popup.appendChild(signOutBtn);
    document.body.appendChild(popup);
    signOutBtn.addEventListener('click', function () {
      closeUserMenu();
      signOut();
    });
    setTimeout(function () {
      document.addEventListener('mousedown', onDocMouseDownCloseUserMenu, true);
    }, 0);
  }

  function setupUserMenu() {
    if (!userEl) return;
    userEl.setAttribute('role', 'button');
    userEl.setAttribute('tabindex', '0');
    userEl.setAttribute('aria-haspopup', 'true');
    userEl.style.cursor = 'pointer';
    userEl.addEventListener('click', openUserMenu);
    userEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openUserMenu(); }
    });
  }

  // ── Phone mode: dock as bottom bar + switcher trigger ────────────────
  // D#37 WS-E criterion 3: the dock is a bottom bar on phones, regardless
  // of the active theme's own taskbar-position preference (core/theme-
  // layout.js). data-taskbar-position="bottom" is an existing, styled
  // value in core/taskbar.css -- this only forces it while on a phone.

  var switcherBtn = null;

  function ensureSwitcherButton() {
    if (switcherBtn) return switcherBtn;
    switcherBtn = document.createElement('button');
    switcherBtn.type = 'button';
    switcherBtn.id = 'taskbar-switcher-btn';
    switcherBtn.className = 'dock-icon';
    switcherBtn.setAttribute('aria-label', 'Open window switcher');
    var glyph = document.createElement('span');
    glyph.className = 'dock-icon-text';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '▤';
    switcherBtn.appendChild(glyph);
    switcherBtn.addEventListener('click', function () {
      if (window.FULCWindowSwitcher) window.FULCWindowSwitcher.open();
    });
    taskbar.appendChild(switcherBtn);
    return switcherBtn;
  }

  function applyPhoneMode() {
    if (FULCPhoneMode && FULCPhoneMode.isPhone()) {
      document.body.dataset.taskbarPosition = 'bottom';
      ensureSwitcherButton();
    }
  }

  // ── Init ──────────────────────────────────────────────────────────

  function init() {
    setupMagnification();
    setupUserMenu();
    update();
    updateBadge();
    applyPhoneMode();
    if (FULCPhoneMode) FULCPhoneMode.onChange(applyPhoneMode);
    // Re-render dock when entitlements change (live toggle from admin panel)
    if (window.FULCEntitlements) {
      window.FULCEntitlements.onChange(function () { update(); });
    }
  }

  // ── App badges ───────────────────────────────────────────────────
  // Per-app badge text (e.g., running agent count on the AI icon)

  var appBadges = {};

  function setAppBadge(appId, text) {
    if (text) {
      appBadges[appId] = text;
    } else {
      delete appBadges[appId];
    }
    update();
  }

  function getAppBadge(appId) {
    return appBadges[appId] || null;
  }

  // kept on window for MCP devtools reads — see epic-26/08.md keep-list
  window.FULCTaskbar = { update, setUser, updateBadge, init, addPin, removePin, getPins, setAppBadge, getAppBadge };
})();

export const FULCTaskbar = window.FULCTaskbar;
