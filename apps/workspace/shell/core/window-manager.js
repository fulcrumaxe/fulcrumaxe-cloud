// ── fulcrumaxe-os Window Manager ──────────────────────────────────────────────
// Manages windowed apps: create, drag, resize, minimize, maximize, close, z-order
// Phase 1: edge resize, snap zones, snap layouts, drag-from-maximized,
//          animations, context menus, always-on-top, keyboard snap shortcuts
// Exposes: window.FULCWM
import { FULCApps } from "./app-registry.js";
import { FULCLayout } from "./theme-layout.js";
import { FULCMonitors } from "./monitor-manager.js";
import { FULCContextMenu } from "./context-menu.js";
import { FULCPhoneMode } from "./phone-mode.js";
// Side-effect only: window-switcher.js is reached through window.FULCWindowSwitcher
// (like window.FULCTaskbar / window.FULCUpgradeModal elsewhere in this file), not
// through a named import -- this import exists only so the build's static
// import-graph walk (build/build.mjs's walkImportGraph) includes it in dist/
// without needing its own <script> tag in index.html.
import "./window-switcher.js";
// D#37 WS-C2 criterion 11: persisted under storage-ns.js's fx:<ns>:
// namespace, not a raw localStorage key.
import { getItem, setItem, removeItem } from "./storage-ns.js";

(function () {
  'use strict';

  const container = document.getElementById('windows-container');
  if (!container) return;

  const windows = {};  // id -> windowState
  let topZ = 100;
  // Focuses that did not come from a restore finishing; restore() compares it
  // to decide whether its deferred focus is still wanted.
  let externalFocusCount = 0;
  let inRestoreFocus = false;
  let cascadeOffset = 0;
  const CASCADE_STEP = 30;
  const CASCADE_MAX = 210;

  const PERSIST_KEY = 'window-layout';
  let saveTimer = null;

  const SNAP_THRESHOLD = 12;

  // D#37 WS-E criterion 1: phones keep at most this many live windows. Older
  // ones are detached (DOM + live state removed, geometry kept in the
  // existing window-layout store) rather than closed, so reopening restores
  // them the same way open() already restores any saved-but-closed window.
  const PHONE_MAX_LIVE_WINDOWS = 4;

  // ── Exposé state ──────────────────────────────────────────────────
  let exposeActive = false;
  let exposeOverlay = null;
  let savedExposeStates = []; // { id, origLeft, origTop, origW, origH, origZ, origTransform }

  // ── Show Desktop state ────────────────────────────────────────────
  let showDesktopActive = false;
  let showDesktopSavedStates = []; // { id, wasMinimized }

  // ── Workspace state ────────────────────────────────────────────────
  let activeWorkspace = 1;
  const WORKSPACE_COUNT = 4;
  // Each window gets a `workspace` property (default: activeWorkspace)

  // D#37 C27 decision 2: the current workspace is persisted (a bare integer
  // 1..4) through storage-ns.js, next to window-layout. Membership and the
  // current workspace are shell state; a theme switch never writes either.
  const ACTIVE_WS_KEY = 'active-workspace';
  // True only while restoreLayout() reopens windows at boot: saved membership
  // applies then, and never to a later relaunch (C27 decision 5).
  let restoringLayout = false;

  function _isPhone() {
    return !!(FULCPhoneMode && FULCPhoneMode.isPhone());
  }

  // C27 decision 7: on a phone every window counts as being on the current
  // workspace for display, the dock, Alt+Tab and getActive(), so all of them
  // are reachable; the real membership is kept untouched (and saved
  // untouched) so a desktop reopening the layout sees the same workspaces.
  // Every reader uses `.workspace`, so that property is the phone-aware view
  // and `membership` is the truth.
  //
  // WARNING: `.workspace` is a getter, so a copy or spread of a window record
  // ({...ws}, Object.assign) snapshots the DISPLAY value (the current workspace
  // on a phone), not the membership. Anything written to storage must read
  // `ws.membership`, or a phone would overwrite a desktop layout's workspaces.
  function _defineWorkspace(ws, membership) {
    ws.membership = membership;
    Object.defineProperty(ws, 'workspace', {
      enumerable: true,
      configurable: true,
      get: function () {
        return (_isPhone() && ws.membership !== 0) ? activeWorkspace : ws.membership;
      },
      set: function (n) { ws.membership = n; }
    });
  }

  // The maximize button names the action it will take ("Restore" while the window is maximized).
  // `state` is an accessor so every write, from toggleMaximize, a titlebar drag, a snap or the
  // fullscreen exit, keeps that label right; a path added later cannot forget to sync it.
  // A copy or spread of a window record snapshots the plain string.
  function _defineState(ws, initial) {
    var current = initial;
    function sync() {
      var btn = ws.el && ws.el.querySelector('.window-maximize');
      if (!btn) return;
      var label = current === 'maximized' ? 'Restore' : 'Maximize';
      btn.title = label;
      btn.setAttribute('aria-label', label);
    }
    Object.defineProperty(ws, 'state', {
      enumerable: true,
      configurable: true,
      get: function () { return current; },
      set: function (v) { current = v; sync(); }
    });
    sync();
  }

  function _loadActiveWorkspace() {
    var n = 1;
    try {
      var raw = getItem(ACTIVE_WS_KEY);
      if (raw !== null && /^[1-9][0-9]*$/.test(raw)) {
        var v = parseInt(raw, 10);
        if (v >= 1 && v <= WORKSPACE_COUNT) n = v;
      }
    } catch (e) {}
    activeWorkspace = n;
  }

  function _emitWorkspaceChange(detail) {
    try {
      document.dispatchEvent(new CustomEvent('fulc-workspace-change', { detail: detail }));
    } catch (e) {}
  }

  // ── Workspace Overview state ──────────────────────────────────────
  let workspaceOverviewActive = false;
  let workspaceOverviewEl = null;

  // ── Alt+Tab state ──────────────────────────────────────────────────
  let altTabActive = false;
  let altTabOverlay = null;
  let altTabWindows = [];  // sorted by lastFocusTime (most recent first)
  let altTabIndex = 0;

  // Snap guide element (reused)
  const snapGuide = document.createElement('div');
  snapGuide.className = 'wm-snap-guide';
  container.appendChild(snapGuide);

  // ── Snap Layouts ────────────────────────────────────────────────────

  const SNAP_LAYOUTS = [
    { name: 'Full', zones: [{ x: 0, y: 0, w: 1, h: 1 }] },
    { name: '50/50 Vertical', zones: [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }] },
    { name: '66/34', zones: [{ x: 0, y: 0, w: 0.66, h: 1 }, { x: 0.66, y: 0, w: 0.34, h: 1 }] },
    { name: '34/66', zones: [{ x: 0, y: 0, w: 0.34, h: 1 }, { x: 0.34, y: 0, w: 0.66, h: 1 }] },
    { name: '50/50 Horizontal', zones: [{ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 1, h: 0.5 }] },
    { name: 'Thirds', zones: [{ x: 0, y: 0, w: 0.33, h: 1 }, { x: 0.33, y: 0, w: 0.34, h: 1 }, { x: 0.67, y: 0, w: 0.33, h: 1 }] }
  ];

  // ── Helpers ─────────────────────────────────────────────────────────

  function getTaskbarH() {
    return document.getElementById('taskbar')?.offsetHeight || 36;
  }

  // Windows are positioned inside #windows-container, not the viewport. The
  // container's CSS already accounts for taskbar position and heritage-theme
  // insets (e.g. cupertino/orchard menubar + dock padding), so maximize /
  // fullscreen / snap must size relative to this container, not innerWidth.
  function _getContainerArea() {
    var c = document.getElementById('windows-container');
    if (!c) {
      return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    }
    return { left: 0, top: 0, width: c.clientWidth, height: c.clientHeight };
  }

  // Apply a target rect to a window, compensating for its box-sizing model.
  // fulc-window uses content-box with 1px borders, so naively setting
  // width = container.clientWidth overflows by the border width.
  function _applyGeometry(el, area) {
    el.style.left = area.left + 'px';
    el.style.top  = area.top  + 'px';
    var cs = getComputedStyle(el);
    if (cs.boxSizing === 'border-box') {
      el.style.width  = area.width  + 'px';
      el.style.height = area.height + 'px';
    } else {
      var bw = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth)  || 0);
      var bh = (parseFloat(cs.borderTopWidth)  || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      var pw = (parseFloat(cs.paddingLeft)     || 0) + (parseFloat(cs.paddingRight)      || 0);
      var ph = (parseFloat(cs.paddingTop)      || 0) + (parseFloat(cs.paddingBottom)     || 0);
      el.style.width  = Math.max(0, area.width  - bw - pw) + 'px';
      el.style.height = Math.max(0, area.height - bh - ph) + 'px';
    }
  }

  // Returns the usable screen rectangle accounting for taskbar position.
  // For multi-monitor: pass the monitor's origin + dimensions; insets are screen-relative.
  function _getMonitorWorkArea(mX, mY, mW, mH) {
    // Single-monitor default: trust the container's CSS-driven bounds so
    // heritage theme insets (orchard menubar, crystal bezel, etc.) are honored.
    if (mX === 0 && mY === 0 && mW === window.innerWidth && mH === window.innerHeight) {
      return _getContainerArea();
    }
    var wa;
    if (window.FULCLayout && typeof window.FULCLayout.getWorkArea === 'function') {
      wa = window.FULCLayout.getWorkArea();
    } else {
      var tbH = getTaskbarH();
      wa = { top: 0, left: 0, right: 0, bottom: tbH };
    }
    return {
      left:   mX + wa.left,
      top:    mY + wa.top,
      width:  mW - wa.left - wa.right,
      height: mH - wa.top  - wa.bottom
    };
  }

  function getAvailH() {
    return _getContainerArea().height;
  }

  function reduceMotion() {
    return !!(window.userPreferences && window.userPreferences.reduce_motion);
  }

  // ── Persistence ─────────────────────────────────────────────────────

  function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        var layout = {};
        Object.keys(windows).forEach(function (id) {
          var ws = windows[id];
          if (ws.state === 'fullscreen') return;
          layout[id] = {
            x: ws.position.x,
            y: ws.position.y,
            w: ws.size.w,
            h: ws.size.h,
            workspace: ws.membership,
            state: ws.state === 'minimized' ? 'normal' : ws.state,
            alwaysOnTop: ws.alwaysOnTop,
            // D#37 WS-C2 criterion 11: a window's custom title is
            // exactly the kind of content this store must NOT persist
            // ("no window title... is persisted") — geometry and app
            // identity only.
            monitorId: FULCMonitors ? FULCMonitors.getActiveMonitorId() : 0
          };
        });
        setItem(PERSIST_KEY, JSON.stringify(layout));
      } catch (e) {}
    }, 500);
  }

  function loadSavedLayout() {
    try {
      var raw = getItem(PERSIST_KEY);
      if (!raw) return {};
      return JSON.parse(raw) || {};
    } catch (e) {
      return {};
    }
  }

  function resetLayout() {
    removeItem(PERSIST_KEY);
  }

  function restoreLayout() {
    try {
      // The current workspace comes back first, so windows restored with a
      // membership of 2..4 are hidden or shown against the right one.
      _loadActiveWorkspace();
      if (window.FULCTaskbar) window.FULCTaskbar.update();
      var raw = getItem(PERSIST_KEY);
      if (!raw) return;
      var layout = JSON.parse(raw);
      restoringLayout = true;
      try {
        Object.keys(layout).forEach(function (appId) {
          if (window.FULCApps && window.FULCApps.get(appId)) {
            open(appId);
          }
        });
      } finally {
        restoringLayout = false;
      }
    } catch (e) {}
  }

  // ── Titlebar Context Menu ──────────────────────────────────────────

  function showTitlebarContextMenu(e, appId, ws) {
    if (!FULCContextMenu) return;
    FULCContextMenu.show(e, [
      { label: 'Minimize', action: function () { minimize(appId); } },
      { label: ws.state === 'maximized' ? 'Restore' : 'Maximize',
        action: function () { toggleMaximize(appId); } },
      { label: ws.fullscreen ? 'Exit Fullscreen' : 'Fullscreen', shortcut: 'Ctrl+Alt+Enter',
        action: function () { toggleFullscreen(appId); } },
      { divider: true },
      { label: 'Snap Left', shortcut: 'Super+Alt+\u2190', action: function () { snapTo(appId, 'left'); } },
      { label: 'Snap Right', shortcut: 'Super+Alt+\u2192', action: function () { snapTo(appId, 'right'); } },
      { label: 'Snap Quarter', submenu: [
        { label: 'Top-Left', shortcut: 'Ctrl+Alt+1', action: function () { snapTo(appId, 'top-left'); } },
        { label: 'Top-Right', shortcut: 'Ctrl+Alt+2', action: function () { snapTo(appId, 'top-right'); } },
        { label: 'Bottom-Left', shortcut: 'Ctrl+Alt+3', action: function () { snapTo(appId, 'bottom-left'); } },
        { label: 'Bottom-Right', shortcut: 'Ctrl+Alt+4', action: function () { snapTo(appId, 'bottom-right'); } }
      ]},
      { divider: true },
      { label: (ws.alwaysOnTop ? '\u2713 ' : '') + 'Always on Top',
        action: function () { toggleAlwaysOnTop(appId); } },
      { label: 'Move to Workspace', submenu: (function () {
        var items = [];
        for (var i = 1; i <= WORKSPACE_COUNT; i++) {
          (function (n) {
            items.push({
              label: (n === ws.workspace ? '\u2713 ' : '') + 'Workspace ' + n,
              action: function () { moveToWorkspace(appId, n); }
            });
          })(i);
        }
        return items;
      })() },
      { divider: true },
      { label: 'Close', shortcut: 'Ctrl+Alt+W', action: function () { close(appId); }, danger: true }
    ]);
  }

  // ── Editable Window Title ─────────────────────────────────────────

  function startTitleEdit(ws) {
    const titleEl = ws.el.querySelector('.window-title');
    if (!titleEl || titleEl.contentEditable === 'true') return;

    titleEl.contentEditable = 'true';
    titleEl.classList.add('editing');

    // Select all text
    const range = document.createRange();
    range.selectNodeContents(titleEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    titleEl.focus();

    function finishEdit() {
      titleEl.contentEditable = 'false';
      titleEl.classList.remove('editing');
      titleEl.removeEventListener('blur', finishEdit);
      titleEl.removeEventListener('keydown', onKey);

      const newTitle = titleEl.textContent.trim();
      if (newTitle) {
        ws.customTitle = newTitle;
      } else {
        // Reverted to empty — restore original
        ws.customTitle = null;
        titleEl.textContent = ws.app.title || ws.id.toUpperCase();
      }
    }

    function onKey(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        titleEl.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        // Cancel: restore previous title
        titleEl.textContent = ws.customTitle || ws.app.title || ws.id.toUpperCase();
        titleEl.blur();
      }
    }

    titleEl.addEventListener('blur', finishEdit);
    titleEl.addEventListener('keydown', onKey);
  }

  // ── Window creation ────────────────────────────────────────────────

  // A launch argument is a small plain JSON object one app hands to another
  // through open(appId, arg). It is copied through JSON (so the receiver never
  // holds the caller's object, functions and getters are dropped) and refused
  // if it is not a plain object or serialises past LAUNCH_ARG_MAX characters.
  // It is data only: nothing here evaluates it, and no URL or query string
  // feeds it. The receiving app still validates every field it reads.
  const LAUNCH_ARG_MAX = 1024;
  function _cleanLaunchArg(arg) {
    // Everything that can touch the caller's object (a Proxy trap can throw) is inside the try.
    try {
      if (arg === undefined || arg === null || typeof arg !== 'object' || Array.isArray(arg)) return undefined;
      const proto = Object.getPrototypeOf(arg);
      if (proto !== Object.prototype && proto !== null) return undefined;
      const text = JSON.stringify(arg);
      if (typeof text !== 'string' || text.length > LAUNCH_ARG_MAX) return undefined;
      return Object.freeze(JSON.parse(text));
    } catch (e) {
      return undefined;
    }
  }

  // Tells the app when the shell hides or shows its window (minimize/restore,
  // another workspace, the phone's one-window view). Only real changes call
  // the optional onHide/onShow hooks; a throwing hook never breaks the shell.
  function _setHidden(ws, hidden) {
    if (!ws || ws.hidden === hidden) return;
    ws.hidden = hidden;
    const hook = hidden ? ws.app.onHide : ws.app.onShow;
    if (!hook) return;
    try { hook(); } catch (e) { console.error('window hook threw:', e); }
  }

  // A launch argument handed to an app that is ALREADY open (open() only goes to its window). The app's optional
  // onLaunch(arg) hook receives the same cleaned, frozen object onOpen would have; an app without the hook ignores
  // it, as it always did. A throwing hook never breaks the shell.
  function _launchRunning(appId, launchArg) {
    const arg = _cleanLaunchArg(launchArg);
    if (arg === undefined) return;
    const app = window.FULCApps && window.FULCApps.get(appId);
    if (!app || typeof app.onLaunch !== 'function') return;
    try { app.onLaunch(arg); } catch (e) { console.error('window hook threw:', e); }
  }

  function open(appId, launchArg) {
    if (windows[appId]) {
      // C27 decision 4: launching a running app goes to it, wherever it is.
      // Phones have no workspaces, so there it is the plain restore + focus.
      if (_isPhone()) {
        if (windows[appId].state === 'minimized') restore(appId);
        focus(appId);
      } else {
        jumpTo(appId);
      }
      _launchRunning(appId, launchArg);
      return;
    }

    const app = window.FULCApps && window.FULCApps.get(appId);
    if (!app) return;

    // Central entitlement gate. Every launch path (desktop, taskbar, hot-corners,
    // theme adapters, terminal `open`, MCP, devtools console) flows through here,
    // so the gate cannot be bypassed by any single call site.
    // Mirrors desktop.js getIconEntitlementDecision: skip while entitlements are
    // still loading, allow otherwise only on Allow.
    if (window.FULCEntitlements && window.FULCEntitlements._ready) {
      const cap = app.capability || ('app.' + appId);
      const decision = window.FULCEntitlements.decision(cap);
      if (decision.type !== 'Allow') {
        if (window.FULCUpgradeModal) {
          window.FULCUpgradeModal.open({ capability: cap, decision: decision });
        }
        return;
      }
    }

    if (showDesktopActive) {
      showDesktopActive = false;
      showDesktopSavedStates = [];
    }

    const savedWin = loadSavedLayout()[appId];
    const defaultSize = app.defaultSize || { w: 600, h: 400 };
    let size, x, y;
    if (savedWin) {
      const vw = window.innerWidth;
      const availH = getAvailH();
      x = Math.max(0, Math.min(savedWin.x, vw - 100));
      y = Math.max(0, Math.min(savedWin.y, availH - 20));
      size = {
        w: Math.max(200, Math.min(savedWin.w, vw)),
        h: Math.max(100, Math.min(savedWin.h, availH))
      };
    } else {
      size = { w: defaultSize.w, h: defaultSize.h };
      x = 60 + cascadeOffset;
      y = 40 + cascadeOffset;
      cascadeOffset = (cascadeOffset + CASCADE_STEP) % CASCADE_MAX;
    }

    // Build window DOM
    const win = document.createElement('div');
    win.className = 'fulc-window';
    win.dataset.appId = appId;
    win.style.left = x + 'px';
    win.style.top = y + 'px';
    win.style.width = size.w + 'px';
    win.style.height = size.h + 'px';

    const titlebarIcon = document.createElement('span');
    titlebarIcon.className = 'window-titlebar-icon';
    titlebarIcon.textContent = app.icon || appId.substring(0, 2).toUpperCase();

    const titleSpan = document.createElement('span');
    titleSpan.className = 'window-title';
    titleSpan.textContent = app.title || appId.toUpperCase();

    const minimizeBtn = document.createElement('button');
    minimizeBtn.className = 'window-btn window-minimize';
    minimizeBtn.title = 'Minimize';
    minimizeBtn.setAttribute('aria-label', 'Minimize');
    minimizeBtn.textContent = '_';

    const maximizeBtn = document.createElement('button');
    maximizeBtn.className = 'window-btn window-maximize';
    maximizeBtn.title = 'Maximize';
    maximizeBtn.setAttribute('aria-label', 'Maximize');
    maximizeBtn.textContent = '□';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'window-btn window-close';
    closeBtn.title = 'Close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '✕';

    const controlsDiv = document.createElement('div');
    controlsDiv.className = 'window-controls';
    controlsDiv.append(minimizeBtn, maximizeBtn, closeBtn);

    const titlebarDiv = document.createElement('div');
    titlebarDiv.className = 'window-titlebar';
    titlebarDiv.append(titlebarIcon, titleSpan, controlsDiv);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'window-content';

    // Edge resize hit zones
    const edgeSpecs = [
      ['wm-edge wm-edge-n', 'n'],
      ['wm-edge wm-edge-s', 's'],
      ['wm-edge wm-edge-w', 'w'],
      ['wm-edge wm-edge-e', 'e'],
      ['wm-corner wm-corner-nw', 'nw'],
      ['wm-corner wm-corner-ne', 'ne'],
      ['wm-corner wm-corner-sw', 'sw'],
      ['wm-corner wm-corner-se', 'se']
    ];
    const edgeEls = edgeSpecs.map(function (spec) {
      const edgeEl = document.createElement('div');
      edgeEl.className = spec[0];
      edgeEl.dataset.edge = spec[1];
      return edgeEl;
    });

    win.replaceChildren(titlebarDiv, contentDiv, ...edgeEls);

    container.appendChild(win);

    const contentEl = win.querySelector('.window-content');

    const windowState = {
      id: appId,
      el: win,
      contentEl: contentEl,
      position: { x: x, y: y },
      size: { w: size.w, h: size.h },
      savedGeometry: null,
      alwaysOnTop: savedWin ? !!savedWin.alwaysOnTop : false,
      fullscreen: false,
      lastFocusTime: Date.now(),
      customTitle: savedWin ? (savedWin.customTitle || null) : null,
      hidden: false,
      app: app
    };
    _defineState(windowState, 'normal');

    // C27 decision 5: saved membership applies only while the layout is being
    // restored at boot; a relaunch of a closed app opens on the current
    // workspace (its saved geometry still applies).
    _defineWorkspace(windowState, (restoringLayout && savedWin && savedWin.workspace >= 0 &&
      savedWin.workspace <= WORKSPACE_COUNT && savedWin.workspace % 1 === 0)
      ? (savedWin.workspace || activeWorkspace) : activeWorkspace);

    windows[appId] = windowState;

    // Apply saved custom title
    if (windowState.customTitle) {
      win.querySelector('.window-title').textContent = windowState.customTitle;
    }

    // Restore maximized state -- or, on phones, force it (D#37 WS-E
    // criterion 1: "every window opens maximized").
    if ((FULCPhoneMode && FULCPhoneMode.isPhone()) || (savedWin && savedWin.state === 'maximized')) {
      windowState.savedGeometry = { x: x, y: y, w: size.w, h: size.h };
      windowState.state = 'maximized';
      win.classList.add('maximized');
      _applyGeometry(win, _getContainerArea());
    }

    // Hide if restored to a non-active workspace
    if (windowState.workspace !== activeWorkspace && windowState.workspace !== 0) {
      win.style.display = 'none';
      windowState.hidden = true; // onOpen has not run yet: no hook for the initial state
    }

    // Wire titlebar buttons
    win.querySelector('.window-minimize').addEventListener('click', function (e) {
      e.stopPropagation();
      minimize(appId);
    });
    win.querySelector('.window-maximize').addEventListener('click', function (e) {
      e.stopPropagation();
      toggleMaximize(appId);
    });
    win.querySelector('.window-close').addEventListener('click', function (e) {
      e.stopPropagation();
      close(appId);
    });

    // Double-click titlebar to toggle maximize
    win.querySelector('.window-titlebar').addEventListener('dblclick', function () {
      toggleMaximize(appId);
    });

    // Middle-click titlebar to minimize
    win.querySelector('.window-titlebar').addEventListener('mousedown', function (e) {
      if (e.button === 1) { // middle click
        e.preventDefault();
        minimize(appId);
      }
    });

    // Titlebar context menu (right-click)
    win.querySelector('.window-titlebar').addEventListener('contextmenu', function (e) {
      showTitlebarContextMenu(e, appId, windowState);
    });

    // Titlebar icon click → same context menu
    win.querySelector('.window-titlebar-icon').addEventListener('click', function (e) {
      e.stopPropagation();
      const iconRect = e.target.getBoundingClientRect();
      const fakeEvent = {
        clientX: iconRect.left,
        clientY: iconRect.bottom + 2,
        preventDefault: function () {},
        stopPropagation: function () {}
      };
      showTitlebarContextMenu(fakeEvent, appId, windowState);
    });

    // Double-click title text → editable title
    win.querySelector('.window-title').addEventListener('dblclick', function (e) {
      e.stopPropagation(); // Prevent titlebar dblclick (maximize)
      startTitleEdit(windowState);
    });

    // Snap layout picker on maximize button hover
    setupSnapLayoutPicker(windowState);

    // Click window to focus
    win.addEventListener('mousedown', function () {
      focus(appId);
    });

    // Setup drag and resize
    setupDrag(windowState);
    setupResize(windowState);

    // Focus the new window
    focus(appId);

    // Open animation
    if (!reduceMotion()) {
      win.classList.add('opening');
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          win.classList.remove('opening');
        });
      });
    }

    // Let the app populate its content
    if (app.onOpen) app.onOpen(contentEl, _cleanLaunchArg(launchArg));

    if (FULCPhoneMode && FULCPhoneMode.isPhone()) {
      _enforcePhoneLiveCap(appId);
    }

    saveState();

    // Notify taskbar
    if (window.FULCTaskbar) window.FULCTaskbar.update();
  }

  // ── Phone mode: live-window cap ──────────────────────────────────────
  // D#37 WS-E criterion 1: detach (not close) the least-recently-focused
  // window once more than PHONE_MAX_LIVE_WINDOWS are live. onClose is
  // deliberately not called -- the app is not being closed, just parked --
  // and its last geometry is written into the same window-layout store
  // open() already reads, so a later open() on the same id restores it
  // exactly like reopening any other previously-closed, saved window.
  function detachWindow(appId) {
    const ws = windows[appId];
    if (!ws) return;
    try {
      const layout = loadSavedLayout();
      layout[appId] = {
        x: ws.position.x, y: ws.position.y, w: ws.size.w, h: ws.size.h,
        workspace: ws.membership,
        state: ws.state === 'minimized' ? 'normal' : ws.state,
        alwaysOnTop: ws.alwaysOnTop,
        monitorId: FULCMonitors ? FULCMonitors.getActiveMonitorId() : 0
      };
      setItem(PERSIST_KEY, JSON.stringify(layout));
    } catch (e) {}
    ws.el.remove();
    delete windows[appId];
  }

  function _enforcePhoneLiveCap(justOpenedId) {
    const others = Object.keys(windows).filter(function (id) { return id !== justOpenedId; });
    if (others.length + 1 <= PHONE_MAX_LIVE_WINDOWS) return;
    others.sort(function (a, b) { return windows[a].lastFocusTime - windows[b].lastFocusTime; });
    while (others.length + 1 > PHONE_MAX_LIVE_WINDOWS && others.length) {
      detachWindow(others.shift());
    }
    if (window.FULCTaskbar) window.FULCTaskbar.update();
  }

  // D#37 WS-E criterion 1: "at most one is visible" on phones. Applied at the
  // single choke point every user-facing path already flows through --
  // focus() -- rather than duplicated at each call site (dock tap, switcher
  // pick, open()'s own trailing focus() call).
  function _phoneShowOnly(appId) {
    Object.keys(windows).forEach(function (id) {
      windows[id].el.style.display = (id === appId) ? '' : 'none';
      _setHidden(windows[id], id !== appId);
    });
  }

  // ── Close ──────────────────────────────────────────────────────────

  function close(appId) {
    const ws = windows[appId];
    if (!ws) return;

    if (ws.app.onClose) ws.app.onClose();

    // A minimize still in flight must not land on a window that is going away.
    clearTimeout(ws.minimizeTimer);
    ws.minimizeTimer = null;

    // The window is closed from this point on, so an open() of the same app
    // inside the fade-out creates a new window instead of "jumping to" this one.
    // The timer below only removes this element; it must never touch `windows`,
    // because a relaunch may already have put a new entry under the same id.
    delete windows[appId];
    saveState();

    if (!reduceMotion()) {
      // The fading element must not pass for a live window. data-app-id stays:
      // theme CSS keys on it, and dropping it would restyle the window mid-fade.
      ws.el.classList.add('closing');
      ws.el.setAttribute('aria-hidden', 'true');
      ws.el.setAttribute('inert', '');
      setTimeout(function () {
        ws.el.remove();
      }, 150);
    } else {
      ws.el.remove();
    }

    if (window.FULCTaskbar) window.FULCTaskbar.update();
  }

  // ── Minimize ───────────────────────────────────────────────────────

  function minimize(appId) {
    const ws = windows[appId];
    if (!ws) return;

    _setHidden(ws, true);
    if (!reduceMotion()) {
      ws.el.style.transform = 'scale(0.15)';
      ws.el.style.transformOrigin = 'bottom left';
      ws.el.style.opacity = '0';
      // Kept so restore() can cancel it: a restore inside these 200 ms must not
      // be undone by this callback landing afterwards (it re-added .minimized
      // and left the window hidden after the user had restored it).
      clearTimeout(ws.minimizeTimer);
      ws.minimizeTimer = setTimeout(function () {
        ws.minimizeTimer = null;
        ws.state = 'minimized';
        ws.el.classList.add('minimized');
        ws.el.style.transform = '';
        ws.el.style.transformOrigin = '';
        ws.el.style.opacity = '';
        if (window.FULCTaskbar) window.FULCTaskbar.update();
      }, 200);
    } else {
      ws.state = 'minimized';
      ws.el.classList.add('minimized');
      if (window.FULCTaskbar) window.FULCTaskbar.update();
    }
    saveState();
  }

  function restore(appId) {
    const ws = windows[appId];
    if (!ws) return;

    // Switch to the window's workspace if needed
    if (ws.workspace !== activeWorkspace && ws.workspace !== 0) {
      switchWorkspace(ws.workspace);
    }

    clearTimeout(ws.minimizeTimer);
    ws.minimizeTimer = null;
    _setHidden(ws, false);
    ws.el.classList.remove('minimized');
    // A window that was minimized while its workspace was hidden kept
    // display:none through the switch (switchWorkspace skips minimized
    // windows), so make it visible again here.
    if (ws.workspace === activeWorkspace || ws.workspace === 0) ws.el.style.display = '';

    if (!reduceMotion()) {
      ws.el.style.transform = 'scale(0.15)';
      ws.el.style.opacity = '0';
      // If something other than a restore focused a window while this
      // animation was in flight, the user has since focused (or opened)
      // another window; the deferred focus must not steal it back -- on a
      // phone that would hide the window they just opened. Other restores'
      // deferred focuses do not count (see _restoreFocus): a batch restore
      // such as show-desktop still ends with its last window on top.
      const externalAtRestore = externalFocusCount;
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          ws.el.style.transform = '';
          ws.el.style.opacity = '';
          ws.state = 'normal';
          if (externalFocusCount === externalAtRestore) _restoreFocus(appId);
          if (window.FULCTaskbar) window.FULCTaskbar.update();
        });
      });
    } else {
      ws.state = 'normal';
      _restoreFocus(appId);
      if (window.FULCTaskbar) window.FULCTaskbar.update();
    }
    saveState();
  }

  // The focus a restore ends with. It is not "external": see focus().
  function _restoreFocus(appId) {
    inRestoreFocus = true;
    try { focus(appId); } finally { inRestoreFocus = false; }
  }

  // ── Maximize ───────────────────────────────────────────────────────

  function toggleMaximize(appId) {
    const ws = windows[appId];
    if (!ws) return;
    // D#37 WS-E criterion 1: windows stay maximized on phones -- there is no
    // "restore" size to toggle back to.
    if (FULCPhoneMode && FULCPhoneMode.isPhone()) return;

    if (ws.state === 'maximized') {
      // Restore
      ws.state = 'normal';
      ws.el.classList.remove('maximized');
      if (ws.savedGeometry) {
        ws.el.style.left = ws.savedGeometry.x + 'px';
        ws.el.style.top = ws.savedGeometry.y + 'px';
        ws.el.style.width = ws.savedGeometry.w + 'px';
        ws.el.style.height = ws.savedGeometry.h + 'px';
        ws.position = { x: ws.savedGeometry.x, y: ws.savedGeometry.y };
        ws.size = { w: ws.savedGeometry.w, h: ws.savedGeometry.h };
      }
    } else {
      // Save current geometry before maximizing/snapping
      if (ws.state === 'normal') {
        ws.savedGeometry = {
          x: ws.position.x, y: ws.position.y,
          w: ws.size.w, h: ws.size.h
        };
      }
      ws.state = 'maximized';
      ws.el.classList.add('maximized');
      ws.el.classList.remove('snapped');
      _applyGeometry(ws.el, _getMonitorWorkArea(0, 0, window.innerWidth, window.innerHeight));
    }

    saveState();
    if (ws.app.onResize) ws.app.onResize();
    if (window.FULCTaskbar) window.FULCTaskbar.update();
  }

  // ── Snap To ────────────────────────────────────────────────────────

  function snapTo(appId, zone) {
    const ws = windows[appId];
    if (!ws) return;

    // Save geometry if coming from normal state
    if (ws.state === 'normal') {
      ws.savedGeometry = {
        x: ws.position.x, y: ws.position.y,
        w: ws.size.w, h: ws.size.h
      };
    }

    const monArea = FULCMonitors ? FULCMonitors.getMonitorViewportArea(ws.position.x, ws.position.y) : null;
    const mX = monArea ? monArea.originX : 0;
    const mY = monArea ? monArea.originY : 0;
    const mW = monArea ? monArea.width : window.innerWidth;
    const mH = monArea ? monArea.height : window.innerHeight;
    const _sw = _getMonitorWorkArea(mX, mY, mW, mH);
    const { left: wLeft, top: wTop, width: wW, height: wH } = _sw;
    let left, top, width, height;

    switch (zone) {
      case 'left':
        left = wLeft; top = wTop; width = wW * 0.5; height = wH; break;
      case 'right':
        left = wLeft + wW * 0.5; top = wTop; width = wW * 0.5; height = wH; break;
      case 'maximize':
        toggleMaximize(appId); return;
      case 'top-left':
        left = wLeft; top = wTop; width = wW * 0.5; height = wH * 0.5; break;
      case 'top-right':
        left = wLeft + wW * 0.5; top = wTop; width = wW * 0.5; height = wH * 0.5; break;
      case 'bottom-left':
        left = wLeft; top = wTop + wH * 0.5; width = wW * 0.5; height = wH * 0.5; break;
      case 'bottom-right':
        left = wLeft + wW * 0.5; top = wTop + wH * 0.5; width = wW * 0.5; height = wH * 0.5; break;
      default:
        return;
    }

    ws.state = 'snapped';
    ws.el.classList.remove('maximized');
    ws.el.classList.add('snapped');
    ws.el.style.left = left + 'px';
    ws.el.style.top = top + 'px';
    ws.el.style.width = width + 'px';
    ws.el.style.height = height + 'px';
    ws.position = { x: left, y: top };
    ws.size = { w: width, h: height };

    saveState();
    if (ws.app.onResize) ws.app.onResize();
    if (window.FULCTaskbar) window.FULCTaskbar.update();
  }

  function snapToLayout(appId, layout, zoneIndex) {
    const ws = windows[appId];
    if (!ws) return;

    if (ws.state === 'normal') {
      ws.savedGeometry = {
        x: ws.position.x, y: ws.position.y,
        w: ws.size.w, h: ws.size.h
      };
    }

    const monArea = FULCMonitors ? FULCMonitors.getMonitorViewportArea(ws.position.x, ws.position.y) : null;
    const mX = monArea ? monArea.originX : 0;
    const mY = monArea ? monArea.originY : 0;
    const mW = monArea ? monArea.width : window.innerWidth;
    const mH = monArea ? monArea.height : window.innerHeight;
    const _stlWa = _getMonitorWorkArea(mX, mY, mW, mH);
    const zone = layout.zones[zoneIndex];

    const left = _stlWa.left + zone.x * _stlWa.width;
    const top  = _stlWa.top  + zone.y * _stlWa.height;
    const width  = zone.w * _stlWa.width;
    const height = zone.h * _stlWa.height;

    ws.state = 'snapped';
    ws.el.classList.remove('maximized');
    ws.el.classList.add('snapped');
    ws.el.style.left = left + 'px';
    ws.el.style.top = top + 'px';
    ws.el.style.width = width + 'px';
    ws.el.style.height = height + 'px';
    ws.position = { x: left, y: top };
    ws.size = { w: width, h: height };

    if (ws.app.onResize) ws.app.onResize();
    if (window.FULCTaskbar) window.FULCTaskbar.update();

    // If layout has more zones, show window picker for next zone
    if (layout.zones.length > 1 && zoneIndex === 0) {
      showWindowPicker(appId, layout, zoneIndex + 1);
    }
  }

  // ── Window Picker (after snap layout) ──────────────────────────────

  function showWindowPicker(excludeAppId, layout, zoneIndex) {
    const otherWindows = Object.values(windows).filter(function (w) {
      return w.id !== excludeAppId && w.state !== 'minimized';
    });
    if (otherWindows.length === 0) return;

    const picker = document.createElement('div');
    picker.className = 'wm-window-picker';

    const zone = layout.zones[zoneIndex];
    const vw = window.innerWidth;
    const availH = getAvailH();

    // Position picker in center of the target zone
    picker.style.left = (zone.x * vw + zone.w * vw / 2 - 90) + 'px';
    picker.style.top = (zone.y * availH + zone.h * availH / 2 - otherWindows.length * 15) + 'px';

    otherWindows.forEach(function (w) {
      const item = document.createElement('div');
      item.className = 'wm-window-pick-item';
      item.textContent = w.app.title || w.id.toUpperCase();
      item.addEventListener('click', function () {
        picker.remove();
        snapToLayout(w.id, layout, zoneIndex);
      });
      picker.appendChild(item);
    });

    document.body.appendChild(picker);

    // Close picker on click outside
    setTimeout(function () {
      document.addEventListener('click', function closePickerHandler(e) {
        if (!picker.contains(e.target)) {
          picker.remove();
          document.removeEventListener('click', closePickerHandler);
        }
      });
    }, 0);
  }

  // ── Always on Top ──────────────────────────────────────────────────

  function toggleAlwaysOnTop(appId) {
    const ws = windows[appId];
    if (!ws) return;

    ws.alwaysOnTop = !ws.alwaysOnTop;

    if (ws.alwaysOnTop) {
      ws.el.style.zIndex = 50000;
      // Add pin indicator
      if (!ws.el.querySelector('.wm-pin-indicator')) {
        const pin = document.createElement('span');
        pin.className = 'wm-pin-indicator';
        pin.textContent = '[PIN]';
        ws.el.querySelector('.window-title').after(pin);
      }
    } else {
      ws.el.style.zIndex = topZ;
      const pin = ws.el.querySelector('.wm-pin-indicator');
      if (pin) pin.remove();
    }
  }

  // ── Focus / Z-order ────────────────────────────────────────────────

  function focus(appId) {
    if (!inRestoreFocus) externalFocusCount++;
    const ws = windows[appId];
    if (!ws) return;

    // Skip windows not on the active workspace (workspace 0 = sticky)
    if (ws.workspace !== activeWorkspace && ws.workspace !== 0) return;

    if (showDesktopActive) {
      showDesktopActive = false;
      showDesktopSavedStates = [];
    }

    Object.values(windows).forEach(function (w) {
      w.el.classList.remove('active');
    });

    topZ++;
    if (!ws.alwaysOnTop) {
      ws.el.style.zIndex = topZ;
    }
    ws.el.classList.add('active');
    ws.lastFocusTime = Date.now();

    if (FULCPhoneMode && FULCPhoneMode.isPhone()) _phoneShowOnly(appId);

    if (ws.app.onFocus) ws.app.onFocus();
    if (window.FULCTaskbar) window.FULCTaskbar.update();
  }

  // ── Drag ───────────────────────────────────────────────────────────

  // Shared by the mouse drag path and the tablet pointer-event drag path
  // (D#37 WS-E criterion 4) so the two never drift: multi-monitor aware,
  // returns a snap zone name or null.
  function _detectSnapZone(clientX, clientY) {
    const snapAreas = (FULCMonitors && FULCMonitors.monitors.length > 1)
      ? FULCMonitors.getAllMonitorViewportAreas()
      : [{ originX: 0, originY: 0, width: window.innerWidth, height: window.innerHeight }];
    const wa = (window.FULCLayout && typeof window.FULCLayout.getWorkArea === 'function')
      ? window.FULCLayout.getWorkArea()
      : { top: 0, left: 0, right: 0, bottom: getTaskbarH() };

    for (let ai = 0; ai < snapAreas.length; ai++) {
      const sa = snapAreas[ai];
      const saLeft   = sa.originX + wa.left;
      const saTop    = sa.originY + wa.top;
      const saRight  = sa.originX + sa.width  - wa.right;
      const saBottom = sa.originY + sa.height - wa.bottom;
      if (clientY <= saTop + SNAP_THRESHOLD && clientX >= saLeft && clientX < saRight) {
        if (clientX <= saLeft + SNAP_THRESHOLD * 4) return 'top-left';
        if (clientX >= saRight - SNAP_THRESHOLD * 4) return 'top-right';
        return 'maximize';
      } else if (clientY >= saBottom - SNAP_THRESHOLD && clientX >= saLeft && clientX < saRight) {
        if (clientX <= saLeft + SNAP_THRESHOLD * 4) return 'bottom-left';
        if (clientX >= saRight - SNAP_THRESHOLD * 4) return 'bottom-right';
        return null;
      } else if (clientX <= saLeft + SNAP_THRESHOLD && clientY > saTop && clientY < saBottom) {
        return 'left';
      } else if (clientX >= saRight - SNAP_THRESHOLD && clientY > saTop && clientY < saBottom) {
        return 'right';
      }
    }
    return null;
  }

  // D#37 WS-E criterion 4: tablet drag. Pointer events (mouse, touch and pen
  // alike -- "tablets keep windowing with pointer events", owner decision
  // 3), transform-only movement batched in requestAnimationFrame, and
  // left/top written exactly once, on pointerup. Snap-zone detection reuses
  // _detectSnapZone and runs off the raw pointer coordinates, so it needs no
  // committed left/top to work during the move.
  function setupTabletDrag(ws, titlebar) {
    let dragging = false;
    let startX, startY, origX, origY, dx = 0, dy = 0;
    let rafScheduled = false;
    let currentSnapZone = null;

    function applyTransform() {
      rafScheduled = false;
      if (!dragging) return;
      ws.el.style.transform = 'translate3d(' + dx + 'px,' + dy + 'px,0)';
    }

    function onPointerMove(e) {
      if (!dragging) return;
      dx = e.clientX - startX;
      dy = e.clientY - startY;
      const zone = _detectSnapZone(e.clientX, e.clientY);
      if (zone !== currentSnapZone) {
        currentSnapZone = zone;
        updateSnapGuide(zone, e.clientX, e.clientY);
      }
      if (!rafScheduled) {
        rafScheduled = true;
        requestAnimationFrame(applyTransform);
      }
    }

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      titlebar.removeEventListener('pointermove', onPointerMove);
      titlebar.removeEventListener('pointerup', endDrag);
      titlebar.removeEventListener('pointercancel', endDrag);
      if (titlebar.releasePointerCapture && e && e.pointerId != null) {
        try { titlebar.releasePointerCapture(e.pointerId); } catch (err) {}
      }
      ws.el.classList.remove('dragging');
      ws.el.style.transform = '';

      const newX = Math.max(0, origX + dx);
      const newY = Math.max(0, origY + dy);
      ws.position.x = newX;
      ws.position.y = newY;
      // Committed exactly once, here -- never during onPointerMove above.
      ws.el.style.left = newX + 'px';
      ws.el.style.top = newY + 'px';

      if (currentSnapZone) {
        const zone = currentSnapZone;
        currentSnapZone = null;
        hideSnapGuide();
        snapTo(ws.id, zone);
      } else {
        saveState();
      }
    }

    titlebar.addEventListener('pointerdown', function (e) {
      if (e.button > 0) return;
      if (e.target.closest('.window-controls')) return;
      if (ws.state === 'maximized' || ws.state === 'snapped') return; // out of criterion scope
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      origX = ws.position.x;
      origY = ws.position.y;
      dx = 0; dy = 0;
      currentSnapZone = null;
      ws.el.classList.add('dragging');
      if (titlebar.setPointerCapture) {
        try { titlebar.setPointerCapture(e.pointerId); } catch (err) {}
      }
      titlebar.addEventListener('pointermove', onPointerMove);
      titlebar.addEventListener('pointerup', endDrag);
      titlebar.addEventListener('pointercancel', endDrag);
      e.preventDefault();
    });
  }

  function setupDrag(ws) {
    const titlebar = ws.el.querySelector('.window-titlebar');

    // D#37 WS-E criterion 1: no free drag on phones -- every window is
    // maximized and stays that way, so there is nothing to drag.
    if (FULCPhoneMode && FULCPhoneMode.isPhone()) return;

    // D#37 WS-E criterion 4: tablets drag with pointer events, transform
    // only during the move (batched in rAF), and commit left/top exactly
    // once, on pointerup. This is a separate code path rather than a branch
    // inside the mouse path below so the existing mouse behavior (used by
    // every non-tablet device) is provably unchanged.
    if (FULCPhoneMode && FULCPhoneMode.isTablet()) {
      setupTabletDrag(ws, titlebar);
      return;
    }

    let dragging = false;
    let startX, startY, origX, origY;
    let currentSnapZone = null;

    titlebar.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (e.target.closest('.window-controls')) return;

      // Drag from maximized/snapped: restore size and continue dragging
      if (ws.state === 'maximized' || ws.state === 'snapped') {
        const cursorRatio = (e.clientX - ws.el.getBoundingClientRect().left) / ws.el.offsetWidth;
        const restoreW = ws.savedGeometry ? ws.savedGeometry.w : (ws.app.defaultSize?.w || 600);
        const restoreH = ws.savedGeometry ? ws.savedGeometry.h : (ws.app.defaultSize?.h || 400);

        ws.state = 'normal';
        ws.el.classList.remove('maximized', 'snapped');
        ws.el.classList.add('dragging'); // disable transitions during restore
        ws.el.style.width = restoreW + 'px';
        ws.el.style.height = restoreH + 'px';
        ws.size = { w: restoreW, h: restoreH };

        const newX = e.clientX - (cursorRatio * restoreW);
        const newY = e.clientY - 15;
        ws.position = { x: newX, y: newY };
        ws.el.style.left = newX + 'px';
        ws.el.style.top = newY + 'px';

        origX = newX;
        origY = newY;
        startX = e.clientX;
        startY = e.clientY;
        dragging = true;

        if (ws.app.onResize) ws.app.onResize();
        e.preventDefault();

        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('mouseup', onDragUp);
        return;
      }

      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      origX = ws.position.x;
      origY = ws.position.y;
      ws.el.classList.add('dragging');
      e.preventDefault();

      document.addEventListener('mousemove', onDragMove);
      document.addEventListener('mouseup', onDragUp);
    });

    function onDragMove(e) {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const newX = Math.max(0, origX + dx);
      const newY = Math.max(0, origY + dy);
      ws.position.x = newX;
      ws.position.y = newY;
      ws.el.style.left = newX + 'px';
      ws.el.style.top = newY + 'px';

      // Snap zone detection (multi-monitor aware) -- shared with the tablet
      // pointer-event drag path via _detectSnapZone.
      const zone = _detectSnapZone(e.clientX, e.clientY);
      if (zone !== currentSnapZone) {
        currentSnapZone = zone;
        updateSnapGuide(zone, e.clientX, e.clientY);
      }
    }

    function onDragUp() {
      document.removeEventListener('mousemove', onDragMove);
      document.removeEventListener('mouseup', onDragUp);
      if (!dragging) return;
      dragging = false;
      ws.el.classList.remove('dragging');

      if (currentSnapZone) {
        snapTo(ws.id, currentSnapZone);
        currentSnapZone = null;
        hideSnapGuide();
      } else {
        saveState();
      }
    }
  }

  // ── Snap Guide ─────────────────────────────────────────────────────

  function updateSnapGuide(zone, cursorX, cursorY) {
    if (!zone) {
      hideSnapGuide();
      return;
    }

    const monArea = (FULCMonitors && cursorX !== undefined)
      ? FULCMonitors.getMonitorViewportArea(cursorX, cursorY)
      : null;
    const mX = monArea ? monArea.originX : 0;
    const mY = monArea ? monArea.originY : 0;
    const mW = monArea ? monArea.width : window.innerWidth;
    const mH = monArea ? monArea.height : window.innerHeight;
    const _sgWa = _getMonitorWorkArea(mX, mY, mW, mH);
    const { left: gLeft, top: gTop, width: gW, height: gH } = _sgWa;
    let left, top, width, height;

    switch (zone) {
      case 'left':
        left = gLeft; top = gTop; width = gW * 0.5; height = gH; break;
      case 'right':
        left = gLeft + gW * 0.5; top = gTop; width = gW * 0.5; height = gH; break;
      case 'maximize':
        left = gLeft; top = gTop; width = gW; height = gH; break;
      case 'top-left':
        left = gLeft; top = gTop; width = gW * 0.5; height = gH * 0.5; break;
      case 'top-right':
        left = gLeft + gW * 0.5; top = gTop; width = gW * 0.5; height = gH * 0.5; break;
      case 'bottom-left':
        left = gLeft; top = gTop + gH * 0.5; width = gW * 0.5; height = gH * 0.5; break;
      case 'bottom-right':
        left = gLeft + gW * 0.5; top = gTop + gH * 0.5; width = gW * 0.5; height = gH * 0.5; break;
      default:
        hideSnapGuide(); return;
    }

    snapGuide.style.left = left + 'px';
    snapGuide.style.top = top + 'px';
    snapGuide.style.width = width + 'px';
    snapGuide.style.height = height + 'px';
    snapGuide.classList.add('visible');
  }

  function hideSnapGuide() {
    snapGuide.classList.remove('visible');
  }

  // ── Resize (all edges and corners) ─────────────────────────────────

  function setupResize(ws) {
    const edges = ws.el.querySelectorAll('.wm-edge, .wm-corner');

    edges.forEach(function (handle) {
      handle.addEventListener('mousedown', function (e) {
        if (ws.state === 'maximized') return;
        e.preventDefault();
        e.stopPropagation();

        const edge = handle.dataset.edge;
        const startX = e.clientX;
        const startY = e.clientY;
        const origLeft = ws.position.x;
        const origTop = ws.position.y;
        const origW = ws.size.w;
        const origH = ws.size.h;
        const minW = ws.app.minSize?.w || 300;
        const minH = ws.app.minSize?.h || 200;

        // If snapped, transition to normal for free resize
        if (ws.state === 'snapped') {
          ws.state = 'normal';
          ws.el.classList.remove('snapped');
        }

        ws.el.classList.add('resizing');

        function onMove(ev) {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;

          let newLeft = origLeft;
          let newTop = origTop;
          let newW = origW;
          let newH = origH;

          // North edge
          if (edge.includes('n')) {
            newH = Math.max(minH, origH - dy);
            newTop = origTop + (origH - newH);
            if (newTop < 0) { newTop = 0; newH = origTop + origH; }
          }
          // South edge
          if (edge.includes('s')) {
            newH = Math.max(minH, origH + dy);
          }
          // West edge
          if (edge.includes('w')) {
            newW = Math.max(minW, origW - dx);
            newLeft = origLeft + (origW - newW);
            if (newLeft < 0) { newLeft = 0; newW = origLeft + origW; }
          }
          // East edge
          if (edge === 'e' || edge === 'ne' || edge === 'se') {
            newW = Math.max(minW, origW + dx);
          }

          ws.position.x = newLeft;
          ws.position.y = newTop;
          ws.size.w = newW;
          ws.size.h = newH;

          ws.el.style.left = newLeft + 'px';
          ws.el.style.top = newTop + 'px';
          ws.el.style.width = newW + 'px';
          ws.el.style.height = newH + 'px';
        }

        function onUp() {
          ws.el.classList.remove('resizing');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          saveState();
          if (ws.app.onResize) ws.app.onResize();
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }

  // ── Snap Layout Picker (hover on maximize button) ──────────────────

  function setupSnapLayoutPicker(ws) {
    const maxBtn = ws.el.querySelector('.window-maximize');
    let hoverTimer = null;
    let picker = null;

    function showPicker() {
      hidePicker();

      picker = document.createElement('div');
      picker.className = 'wm-snap-picker';

      SNAP_LAYOUTS.forEach(function (layout, layoutIdx) {
        const opt = document.createElement('div');
        opt.className = 'wm-layout-option';
        opt.title = layout.name;

        // Detect horizontal-only layout (all zones have w=1)
        const isHorizontal = layout.zones.every(function (z) { return z.w === 1; }) && layout.zones.length > 1;
        if (isHorizontal) opt.classList.add('horizontal');

        layout.zones.forEach(function (zone) {
          const z = document.createElement('div');
          z.className = 'wm-layout-zone';
          if (isHorizontal) {
            z.style.height = (zone.h * 100) + '%';
          } else {
            z.style.width = (zone.w * 100) + '%';
          }
          opt.appendChild(z);
        });

        opt.addEventListener('click', function (e) {
          e.stopPropagation();
          hidePicker();
          snapToLayout(ws.id, layout, 0);
        });

        picker.appendChild(opt);
      });

      // Position below maximize button
      const btnRect = maxBtn.getBoundingClientRect();
      picker.style.left = (btnRect.left - 60) + 'px';
      picker.style.top = (btnRect.bottom + 4) + 'px';
      document.body.appendChild(picker);

      picker.addEventListener('mouseleave', function () {
        setTimeout(function () {
          if (picker && !picker.matches(':hover') && !maxBtn.matches(':hover')) {
            hidePicker();
          }
        }, 200);
      });
    }

    function hidePicker() {
      if (picker) {
        picker.remove();
        picker = null;
      }
      clearTimeout(hoverTimer);
    }

    maxBtn.addEventListener('mouseenter', function () {
      hoverTimer = setTimeout(showPicker, 400);
    });

    maxBtn.addEventListener('mouseleave', function () {
      setTimeout(function () {
        if (picker && !picker.matches(':hover')) {
          hidePicker();
        } else if (!picker) {
          clearTimeout(hoverTimer);
        }
      }, 200);
    });
  }

  // ── Queries ────────────────────────────────────────────────────────

  function isOpen(appId) {
    return !!windows[appId];
  }

  function getOpen(workspaceFilter) {
    return Object.values(windows).filter(function (w) {
      if (workspaceFilter !== undefined) {
        return w.workspace === workspaceFilter || w.workspace === 0;
      }
      return true;
    });
  }

  function getActive() {
    return Object.values(windows).find(function (w) {
      return w.el.classList.contains('active') && (w.workspace === activeWorkspace || w.workspace === 0);
    }) || null;
  }

  // ── Cycle windows (Alt+Tab style) ──────────────────────────────────

  function cycleNext() {
    const open = Object.values(windows).filter(function (w) { return w.state !== 'minimized'; });
    if (open.length < 2) return;
    const active = getActive();
    const sorted = open.sort(function (a, b) {
      return parseInt(a.el.style.zIndex || 0) - parseInt(b.el.style.zIndex || 0);
    });
    if (active) {
      const idx = sorted.indexOf(active);
      const next = sorted[(idx + 1) % sorted.length];
      focus(next.id);
    }
  }

  // ── Exposé / Mission Control ──────────────────────────────────────

  function enterExpose() {
    // D#37 WS-E criterion 2: phones replace Exposé's live-window tiling with
    // the window switcher (icons + titles only, no window DOM, no
    // transform). Redirecting here (rather than only at each trigger's call
    // site) means every existing entry point -- the hot-corner action, a
    // future keyboard shortcut -- gets the phone behavior for free.
    if (FULCPhoneMode && FULCPhoneMode.isPhone()) {
      if (window.FULCWindowSwitcher) window.FULCWindowSwitcher.open();
      return;
    }
    if (exposeActive) return;

    const openWins = Object.values(windows).filter(function (w) {
      return w.state !== 'minimized' && (w.workspace === activeWorkspace || w.workspace === 0);
    });
    if (openWins.length === 0) return;

    exposeActive = true;
    savedExposeStates = [];

    // Create dimming overlay behind the tiled windows
    exposeOverlay = document.createElement('div');
    exposeOverlay.className = 'wm-expose-overlay';
    container.appendChild(exposeOverlay);

    // Calculate grid layout for the windows
    const _expWa = _getMonitorWorkArea(0, 0, window.innerWidth, window.innerHeight);
    const availW = _expWa.width;
    const availH = _expWa.height;
    const _expOriginX = _expWa.left;
    const _expOriginY = _expWa.top;
    const padding = 40;
    const gap = 20;

    const count = openWins.length;
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);

    const cellW = (availW - padding * 2 - gap * (cols - 1)) / cols;
    const cellH = (availH - padding * 2 - gap * (rows - 1)) / rows;

    openWins.forEach(function (ws, i) {
      const col = i % cols;
      const row = Math.floor(i / cols);

      // Save original state
      savedExposeStates.push({
        id: ws.id,
        origLeft: ws.el.style.left,
        origTop: ws.el.style.top,
        origW: ws.el.style.width,
        origH: ws.el.style.height,
        origZ: ws.el.style.zIndex,
        origTransform: ws.el.style.transform || '',
        wasMaximized: ws.el.classList.contains('maximized'),
        wasSnapped: ws.el.classList.contains('snapped')
      });

      // Calculate target position in the grid (offset by work area origin)
      const targetX = _expOriginX + padding + col * (cellW + gap);
      const targetY = _expOriginY + padding + row * (cellH + gap);

      // Scale window to fit in cell while maintaining aspect ratio
      const winW = ws.el.offsetWidth || ws.size.w;
      const winH = ws.el.offsetHeight || ws.size.h;
      const scaleX = cellW / winW;
      const scaleY = cellH / winH;
      const scale = Math.min(scaleX, scaleY, 1); // never scale up

      const scaledW = winW * scale;
      const scaledH = winH * scale;
      // Center within cell
      const offsetX = (cellW - scaledW) / 2;
      const offsetY = (cellH - scaledH) / 2;

      // Remove maximized/snapped classes temporarily so width/height can be set
      ws.el.classList.add('expose-tile');
      ws.el.style.left = (targetX + offsetX) + 'px';
      ws.el.style.top = (targetY + offsetY) + 'px';
      ws.el.style.width = winW + 'px';
      ws.el.style.height = winH + 'px';
      ws.el.style.transform = 'scale(' + scale.toFixed(4) + ')';
      ws.el.style.transformOrigin = 'top left';
      ws.el.style.zIndex = 60000;

      // Add title overlay
      const label = document.createElement('div');
      label.className = 'wm-expose-label';
      label.textContent = ws.customTitle || ws.app.title || ws.id.toUpperCase();
      ws.el.appendChild(label);

      // Click to select this window
      ws.el._exposeClickHandler = function (e) {
        e.stopPropagation();
        exitExpose(ws.id);
      };
      ws.el.addEventListener('click', ws.el._exposeClickHandler, true);
    });

    // Click overlay or press Escape to cancel
    exposeOverlay.addEventListener('click', function () {
      exitExpose(null);
    });

    document.addEventListener('keydown', exposeEscHandler);
  }

  function exposeEscHandler(e) {
    if (e.key === 'Escape' && exposeActive) {
      e.preventDefault();
      exitExpose(null);
    }
  }

  function exitExpose(focusAppId) {
    if (!exposeActive) return;
    exposeActive = false;

    document.removeEventListener('keydown', exposeEscHandler);

    // Restore all windows to original positions
    savedExposeStates.forEach(function (saved) {
      const ws = windows[saved.id];
      if (!ws) return;

      ws.el.classList.remove('expose-tile');
      ws.el.style.left = saved.origLeft;
      ws.el.style.top = saved.origTop;
      ws.el.style.width = saved.origW;
      ws.el.style.height = saved.origH;
      ws.el.style.zIndex = saved.origZ;
      ws.el.style.transform = saved.origTransform;
      ws.el.style.transformOrigin = '';

      // Remove the expose label
      const label = ws.el.querySelector('.wm-expose-label');
      if (label) label.remove();

      // Remove click handler
      if (ws.el._exposeClickHandler) {
        ws.el.removeEventListener('click', ws.el._exposeClickHandler, true);
        delete ws.el._exposeClickHandler;
      }
    });

    savedExposeStates = [];

    // Remove overlay
    if (exposeOverlay) {
      exposeOverlay.remove();
      exposeOverlay = null;
    }

    // Focus the selected window
    if (focusAppId) {
      focus(focusAppId);
    }
  }

  // ── Fullscreen ──────────────────────────────────────────────────────

  function toggleFullscreen(appId) {
    const ws = windows[appId];
    if (!ws) return;

    if (ws.fullscreen) {
      // Exit fullscreen
      ws.fullscreen = false;
      ws.el.classList.remove('fullscreen');
      document.getElementById('taskbar').style.display = '';
      delete document.body.dataset.fullscreen;

      // Restore previous state
      if (ws._preFullscreenState === 'maximized') {
        ws.state = 'maximized';
        ws.el.classList.add('maximized');
      } else if (ws._preFullscreenState === 'snapped') {
        ws.state = 'snapped';
        ws.el.classList.add('snapped');
      } else {
        ws.state = 'normal';
      }

      // Restore position flow (fullscreen used position:fixed to escape the
      // #windows-container inset for true viewport coverage).
      ws.el.style.position = '';
      if (ws._preFullscreenGeometry) {
        ws.el.style.left = ws._preFullscreenGeometry.left;
        ws.el.style.top = ws._preFullscreenGeometry.top;
        ws.el.style.width = ws._preFullscreenGeometry.width;
        ws.el.style.height = ws._preFullscreenGeometry.height;
      }

      delete ws._preFullscreenState;
      delete ws._preFullscreenGeometry;
    } else {
      // Enter fullscreen
      ws._preFullscreenState = ws.state;
      ws._preFullscreenGeometry = {
        left: ws.el.style.left,
        top: ws.el.style.top,
        width: ws.el.style.width,
        height: ws.el.style.height
      };

      ws.fullscreen = true;
      ws.state = 'fullscreen';
      ws.el.classList.remove('maximized', 'snapped');
      ws.el.classList.add('fullscreen');
      // Use position:fixed so fullscreen truly covers the viewport, bypassing
      // any parent inset (heritage-theme menubar padding, container bottom,
      // etc.). The .fullscreen class can also set this via CSS, but inline
      // wins and makes the intent obvious.
      ws.el.style.position = 'fixed';
      ws.el.style.left = '0px';
      ws.el.style.top = '0px';
      ws.el.style.width = '100vw';
      ws.el.style.height = '100vh';
      document.getElementById('taskbar').style.display = 'none';
      // Signal fullscreen to heritage adapters and CSS so their !important
      // menubar / dock / titlebar styles can bow out (see window-manager.css).
      document.body.dataset.fullscreen = 'true';
    }

    if (ws.app.onResize) ws.app.onResize();
    if (window.FULCTaskbar) window.FULCTaskbar.update();
  }

  // ── Preview clones ────────────────────────────────────────────────

  // The dock hover preview (taskbar.js) and the alt-tab strip below both clone
  // a window's DOM. An app marks a one-time secret with [data-secret-node] and
  // may opt a subtree, or its whole window element, out of previews with
  // [data-no-preview]. In the clone a marked node is swapped for an empty
  // placeholder: no text, and no attribute copied from the original.
  function sanitizePreviewClone(clone) {
    function placeholder(kind) {
      const el = document.createElement('div');
      el.className = 'wm-preview-mask';
      el.setAttribute(kind === 'secret' ? 'data-preview-mask' : 'data-preview-placeholder', '');
      el.setAttribute('aria-hidden', 'true');
      return el;
    }
    // The clone must not pass for a live window: a locator or a script that
    // looks for `.fulc-window[data-app-id=X]` would otherwise find two. It
    // keeps the look through `.fulc-window-clone` (aliased in the window CSS)
    // and the app id under data-preview-of, and it is hidden from assistive
    // tech and inert so it cannot take focus or be activated.
    function markAsClone(el) {
      const appId = el.getAttribute('data-app-id');
      el.classList.remove('fulc-window');
      el.classList.add('fulc-window-clone');
      el.removeAttribute('data-app-id');
      if (appId) el.setAttribute('data-preview-of', appId);
      el.setAttribute('aria-hidden', 'true');
      el.setAttribute('inert', '');
    }
    markAsClone(clone);
    // A window nested inside the clone (none today) must not pass for live.
    clone.querySelectorAll('.fulc-window').forEach(markAsClone);
    if (clone.hasAttribute('data-no-preview')) {
      clone.replaceChildren(placeholder('hidden'));
      return clone;
    }
    // No-preview subtrees first, so a secret inside one is dropped with it.
    clone.querySelectorAll('[data-no-preview]').forEach(function (n) {
      if (clone.contains(n)) n.replaceWith(placeholder('hidden'));
    });
    clone.querySelectorAll('[data-secret-node]').forEach(function (n) {
      n.replaceWith(placeholder('secret'));
    });
    return clone;
  }

  // ── Alt+Tab Switcher ──────────────────────────────────────────────

  function openAltTab() {
    const allOpen = Object.values(windows).filter(function (w) {
      return w.state !== 'minimized' && (w.workspace === activeWorkspace || w.workspace === 0);
    });
    if (allOpen.length < 2) return;

    // Sort by lastFocusTime descending (most recent first)
    altTabWindows = allOpen.sort(function (a, b) {
      return (b.lastFocusTime || 0) - (a.lastFocusTime || 0);
    });
    altTabIndex = 1; // start on the second (previous) window
    altTabActive = true;

    // Build overlay
    altTabOverlay = document.createElement('div');
    altTabOverlay.className = 'wm-alttab-overlay';

    const strip = document.createElement('div');
    strip.className = 'wm-alttab-strip';

    altTabWindows.forEach(function (ws, i) {
      const item = document.createElement('div');
      item.className = 'wm-alttab-item';
      if (i === altTabIndex) item.classList.add('selected');
      item.dataset.index = i;

      // Thumbnail: clone the window content scaled down
      const thumb = document.createElement('div');
      thumb.className = 'wm-alttab-thumb';
      const clone = sanitizePreviewClone(ws.el.cloneNode(true));
      clone.classList.remove('active', 'minimized', 'dragging', 'resizing', 'opening', 'closing', 'expose-tile');
      clone.style.position = 'relative';
      clone.style.left = '0';
      clone.style.top = '0';
      clone.style.width = ws.el.offsetWidth + 'px';
      clone.style.height = ws.el.offsetHeight + 'px';
      clone.style.pointerEvents = 'none';
      clone.style.zIndex = 'auto';

      const thumbW = 160;
      const scale = thumbW / (ws.el.offsetWidth || 600);
      clone.style.transform = 'scale(' + scale.toFixed(4) + ')';
      clone.style.transformOrigin = 'top left';

      // Remove resize handles from clone
      clone.querySelectorAll('.wm-edge, .wm-corner').forEach(function (el) { el.remove(); });

      thumb.style.width = thumbW + 'px';
      thumb.style.height = Math.round((ws.el.offsetHeight || 400) * scale) + 'px';
      thumb.appendChild(clone);
      item.appendChild(thumb);

      // Label
      const label = document.createElement('div');
      label.className = 'wm-alttab-label';
      label.textContent = ws.customTitle || ws.app.title || ws.id.toUpperCase();
      item.appendChild(label);

      // Click to select
      item.addEventListener('click', function () {
        altTabIndex = i;
        confirmAltTab();
      });

      strip.appendChild(item);
    });

    altTabOverlay.appendChild(strip);
    document.body.appendChild(altTabOverlay);
  }

  function highlightAltTab() {
    if (!altTabOverlay) return;
    const items = altTabOverlay.querySelectorAll('.wm-alttab-item');
    items.forEach(function (item, i) {
      if (i === altTabIndex) {
        item.classList.add('selected');
      } else {
        item.classList.remove('selected');
      }
    });
  }

  function confirmAltTab() {
    if (!altTabActive) return;
    const selected = altTabWindows[altTabIndex];
    altTabActive = false;
    altTabWindows = [];

    if (altTabOverlay) {
      altTabOverlay.remove();
      altTabOverlay = null;
    }

    if (selected) {
      focus(selected.id);
    }
  }

  // ── Show Desktop ──────────────────────────────────────────────────

  function toggleShowDesktop() {
    if (showDesktopActive) {
      // Restore all windows that were visible before
      showDesktopSavedStates.forEach(function (saved) {
        if (!saved.wasMinimized) {
          const ws = windows[saved.id];
          if (ws && ws.state === 'minimized') {
            restore(saved.id);
          }
        }
      });
      showDesktopSavedStates = [];
      showDesktopActive = false;
    } else {
      // Save state and minimize all non-minimized windows on active workspace
      showDesktopSavedStates = [];
      Object.values(windows).forEach(function (ws) {
        if (ws.workspace !== activeWorkspace && ws.workspace !== 0) return;
        showDesktopSavedStates.push({
          id: ws.id,
          wasMinimized: ws.state === 'minimized'
        });
        if (ws.state !== 'minimized') {
          minimize(ws.id);
        }
      });
      showDesktopActive = true;
    }
  }

  // ── Switch Workspace ───────────────────────────────────────────────

  function switchWorkspace(num) {
    // D#37 WS-E criterion 1: workspaces are a no-op on phones.
    if (FULCPhoneMode && FULCPhoneMode.isPhone()) return;
    if (num < 1 || num > WORKSPACE_COUNT) return;
    if (num === activeWorkspace) return;

    // If expose or alt-tab is active, close them first
    if (exposeActive) exitExpose(null);
    if (altTabActive) confirmAltTab();

    var previousWorkspace = activeWorkspace;
    activeWorkspace = num;
    try { setItem(ACTIVE_WS_KEY, String(num)); } catch (e) {}

    // Show/hide windows based on workspace assignment
    Object.values(windows).forEach(function (ws) {
      if (ws.workspace === num || ws.workspace === 0) {
        if (ws.state !== 'minimized') {
          ws.el.style.display = '';
          _setHidden(ws, false);
        }
      } else {
        ws.el.style.display = 'none';
        _setHidden(ws, true);
      }
    });

    // Focus the most recently used window on the new workspace
    const onWorkspace = Object.values(windows).filter(function (w) {
      return (w.workspace === num || w.workspace === 0) && w.state !== 'minimized';
    });
    if (onWorkspace.length > 0) {
      onWorkspace.sort(function (a, b) {
        return (b.lastFocusTime || 0) - (a.lastFocusTime || 0);
      });
      focus(onWorkspace[0].id);
    } else {
      Object.values(windows).forEach(function (w) {
        w.el.classList.remove('active');
      });
    }

    if (window.FULCTaskbar) window.FULCTaskbar.update();
    _emitWorkspaceChange({ active: num, previous: previousWorkspace });
  }

  // ── Jump to / bring a window (C27 decision 3) ─────────────────────

  // Go to the window's workspace, restore it if minimized, focus it.
  function jumpTo(appId) {
    if (_isPhone()) return;
    const ws = windows[appId];
    if (!ws) return;
    if (ws.workspace !== 0 && ws.workspace !== activeWorkspace) {
      switchWorkspace(ws.workspace);
    }
    if (ws.state === 'minimized') restore(appId);
    focus(appId);
  }

  // Move the window to the current workspace, restore it if minimized, focus
  // it, without switching.
  function bringHere(appId) {
    if (_isPhone()) return;
    const ws = windows[appId];
    if (!ws) return;
    if (ws.workspace !== 0 && ws.workspace !== activeWorkspace) {
      moveToWorkspace(appId, activeWorkspace);
    }
    if (ws.state === 'minimized') restore(appId);
    focus(appId);
  }

  // ── Move Window to Workspace ──────────────────────────────────────

  function moveToWorkspace(appId, targetWorkspace) {
    // D#37 WS-E criterion 1: workspaces are a no-op on phones.
    if (FULCPhoneMode && FULCPhoneMode.isPhone()) return;
    const ws = windows[appId];
    if (!ws) return;
    if (targetWorkspace < 1 || targetWorkspace > WORKSPACE_COUNT) return;
    if (ws.workspace === targetWorkspace) return;

    ws.workspace = targetWorkspace;
    saveState();

    if (targetWorkspace !== activeWorkspace) {
      ws.el.style.display = 'none';
      _setHidden(ws, true);
      ws.el.classList.remove('active');

      showWorkspaceToast('Moved to Workspace ' + targetWorkspace);

      // Focus next available window on current workspace
      const remaining = Object.values(windows).filter(function (w) {
        return (w.workspace === activeWorkspace || w.workspace === 0) && w.state !== 'minimized';
      });
      if (remaining.length > 0) {
        remaining.sort(function (a, b) {
          return (b.lastFocusTime || 0) - (a.lastFocusTime || 0);
        });
        focus(remaining[0].id);
      }
    } else {
      // Moving to the current workspace — ensure it's visible
      if (ws.state !== 'minimized') {
        ws.el.style.display = '';
        _setHidden(ws, false);
      }
    }

    if (window.FULCTaskbar) window.FULCTaskbar.update();
    _emitWorkspaceChange({ active: activeWorkspace, moved: appId });
  }

  function showWorkspaceToast(message) {
    const existing = document.querySelector('.wm-workspace-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'wm-workspace-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(function () {
      toast.classList.add('fade-out');
      setTimeout(function () { toast.remove(); }, 300);
    }, 1500);
  }

  // ── Workspace Overview ────────────────────────────────────────────

  function openWorkspaceOverview() {
    // D#37 WS-E criterion 1: workspaces are a no-op on phones.
    if (FULCPhoneMode && FULCPhoneMode.isPhone()) return;
    if (workspaceOverviewActive) return;
    if (exposeActive) exitExpose(null);
    if (altTabActive) confirmAltTab();

    workspaceOverviewActive = true;

    workspaceOverviewEl = document.createElement('div');
    workspaceOverviewEl.className = 'wm-workspace-overview';

    const grid = document.createElement('div');
    grid.className = 'wm-workspace-grid';

    for (var wsNum = 1; wsNum <= WORKSPACE_COUNT; wsNum++) {
      (function (num) {
        const cell = document.createElement('div');
        cell.className = 'wm-workspace-cell';
        if (num === activeWorkspace) cell.classList.add('active');

        const label = document.createElement('div');
        label.className = 'wm-workspace-cell-label';
        label.textContent = 'WORKSPACE ' + num;
        cell.appendChild(label);

        const preview = document.createElement('div');
        preview.className = 'wm-workspace-cell-preview';

        const wsWindows = Object.values(windows).filter(function (w) {
          return (w.workspace === num || w.workspace === 0) && w.state !== 'minimized';
        });

        wsWindows.forEach(function (w) {
          const mini = document.createElement('div');
          mini.className = 'wm-workspace-mini-window';
          mini.textContent = w.app.title || w.id.toUpperCase();

          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const previewW = 300;
          const previewH = 180;
          const scaleX = previewW / vw;
          const scaleY = previewH / vh;

          mini.style.left = (w.position.x * scaleX) + 'px';
          mini.style.top = (w.position.y * scaleY) + 'px';
          mini.style.width = Math.max(40, w.size.w * scaleX) + 'px';
          mini.style.height = Math.max(20, w.size.h * scaleY) + 'px';

          preview.appendChild(mini);
        });

        cell.appendChild(preview);

        const count = document.createElement('div');
        count.className = 'wm-workspace-cell-count';
        count.textContent = wsWindows.length + (wsWindows.length === 1 ? ' window' : ' windows');
        cell.appendChild(count);

        cell.addEventListener('click', function () {
          closeWorkspaceOverview();
          switchWorkspace(num);
        });

        grid.appendChild(cell);
      })(wsNum);
    }

    workspaceOverviewEl.appendChild(grid);
    document.body.appendChild(workspaceOverviewEl);

    document.addEventListener('keydown', workspaceOverviewEscHandler);
  }

  function workspaceOverviewEscHandler(e) {
    if (e.key === 'Escape' && workspaceOverviewActive) {
      e.preventDefault();
      closeWorkspaceOverview();
    }
  }

  function closeWorkspaceOverview() {
    if (!workspaceOverviewActive) return;
    workspaceOverviewActive = false;
    document.removeEventListener('keydown', workspaceOverviewEscHandler);
    if (workspaceOverviewEl) {
      workspaceOverviewEl.remove();
      workspaceOverviewEl = null;
    }
  }

  // ── Workspace keyboard shortcuts ──────────────────────────────────

  document.addEventListener('keydown', function (e) {
    // Ctrl+Alt+F1-F4 → Switch workspace
    if (e.ctrlKey && e.altKey && !e.shiftKey) {
      const fKey = e.key.match(/^F([1-4])$/);
      if (fKey) {
        e.preventDefault();
        switchWorkspace(parseInt(fKey[1]));
        return;
      }
    }

    // Ctrl+Alt+Shift+F1-F4 → Move active window to workspace
    if (e.ctrlKey && e.altKey && e.shiftKey) {
      const fKey = e.key.match(/^F([1-4])$/);
      if (fKey) {
        e.preventDefault();
        const act = getActive();
        if (act) moveToWorkspace(act.id, parseInt(fKey[1]));
        return;
      }
    }

    // Ctrl+Alt+PageDown → Next workspace
    if (e.key === 'PageDown' && e.ctrlKey && e.altKey) {
      e.preventDefault();
      const next = activeWorkspace < WORKSPACE_COUNT ? activeWorkspace + 1 : 1;
      switchWorkspace(next);
      return;
    }

    // Ctrl+Alt+PageUp → Previous workspace
    if (e.key === 'PageUp' && e.ctrlKey && e.altKey) {
      e.preventDefault();
      const prev = activeWorkspace > 1 ? activeWorkspace - 1 : WORKSPACE_COUNT;
      switchWorkspace(prev);
      return;
    }
  });

  // ── Keyboard shortcuts for snapping ────────────────────────────────

  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey) || !e.altKey) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    // Skip if inside xterm (except for Meta+Alt combos which xterm doesn't use)
    if (e.target.closest && e.target.closest('.xterm') && !e.metaKey) return;

    // Ctrl+Alt+Space → Exposé
    if (e.key === ' ' && e.ctrlKey && e.altKey) {
      e.preventDefault();
      if (exposeActive) {
        exitExpose(null);
      } else {
        enterExpose();
      }
      return;
    }

    // Ctrl+Alt+O → Workspace Overview
    if (e.key === 'o' && e.ctrlKey && e.altKey) {
      e.preventDefault();
      if (workspaceOverviewActive) {
        closeWorkspaceOverview();
      } else {
        openWorkspaceOverview();
      }
      return;
    }

    // Ctrl+Alt+D → Show Desktop
    if (e.key === 'd' && e.ctrlKey && e.altKey) {
      e.preventDefault();
      toggleShowDesktop();
      return;
    }

    // Disable other shortcuts while Exposé is active
    if (exposeActive) return;

    // Ctrl+Alt+Enter → Toggle fullscreen
    if (e.key === 'Enter' && e.ctrlKey && e.altKey) {
      e.preventDefault();
      const act = getActive();
      if (act) toggleFullscreen(act.id);
      return;
    }

    // Ctrl+Alt+W → Close active window
    if (e.key === 'w' && e.ctrlKey && e.altKey) {
      e.preventDefault();
      const act = getActive();
      if (act) close(act.id);
      return;
    }

    // Ctrl+Alt+M → Minimize active window
    if (e.key === 'm' && e.ctrlKey && e.altKey) {
      e.preventDefault();
      const act = getActive();
      if (act) minimize(act.id);
      return;
    }

    const active = getActive();
    if (!active) return;

    if (e.key === 'ArrowLeft' && e.altKey && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      snapTo(active.id, 'left');
    } else if (e.key === 'ArrowRight' && e.altKey && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      snapTo(active.id, 'right');
    } else if (e.key === 'ArrowUp' && e.altKey && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (active.state !== 'maximized') toggleMaximize(active.id);
    } else if (e.key === 'ArrowDown' && e.altKey && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (active.state === 'maximized' || active.state === 'snapped') {
        if (active.state === 'maximized') toggleMaximize(active.id);
        else {
          // Restore from snap
          active.state = 'normal';
          active.el.classList.remove('snapped');
          if (active.savedGeometry) {
            active.el.style.left = active.savedGeometry.x + 'px';
            active.el.style.top = active.savedGeometry.y + 'px';
            active.el.style.width = active.savedGeometry.w + 'px';
            active.el.style.height = active.savedGeometry.h + 'px';
            active.position = { x: active.savedGeometry.x, y: active.savedGeometry.y };
            active.size = { w: active.savedGeometry.w, h: active.savedGeometry.h };
          }
        }
      } else {
        minimize(active.id);
      }
    }
    // Ctrl+Alt+1 → Snap to top-left quarter
    else if (e.key === '1' && e.ctrlKey && e.altKey) {
      e.preventDefault();
      snapTo(active.id, 'top-left');
    }
    // Ctrl+Alt+2 → Snap to top-right quarter
    else if (e.key === '2' && e.ctrlKey && e.altKey) {
      e.preventDefault();
      snapTo(active.id, 'top-right');
    }
    // Ctrl+Alt+3 → Snap to bottom-left quarter
    else if (e.key === '3' && e.ctrlKey && e.altKey) {
      e.preventDefault();
      snapTo(active.id, 'bottom-left');
    }
    // Ctrl+Alt+4 → Snap to bottom-right quarter
    else if (e.key === '4' && e.ctrlKey && e.altKey) {
      e.preventDefault();
      snapTo(active.id, 'bottom-right');
    }
    // Ctrl+Alt+T → Open Themes app
    else if (e.key === 't' && e.ctrlKey && e.altKey) {
      e.preventDefault();
      open('themes');
      return;
    }
    // Ctrl+Alt+N → New fulcrumaxe-os window (Chrome debug: drag to another monitor)
    else if (e.key === 'n' && e.ctrlKey && e.altKey) {
      e.preventDefault();
      window.open(location.origin, '_blank',
        'width=' + (screen.width || 1280) + ',height=' + (screen.height || 800));
    }
  });

  // ── Fullscreen Escape listener ──────────────────────────────────────

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      const act = getActive();
      if (act && act.fullscreen) {
        e.preventDefault();
        toggleFullscreen(act.id);
      }
    }
  });

  // ── Alt+Tab listener ──────────────────────────────────────────────

  document.addEventListener('keydown', function (e) {
    // Alt+Tab → Open switcher or cycle forward
    if (e.key === 'Tab' && e.altKey && !e.ctrlKey) {
      e.preventDefault();

      if (!altTabActive) {
        openAltTab();
      }

      if (altTabActive) {
        // Shift+Tab = reverse
        if (e.shiftKey) {
          altTabIndex = (altTabIndex - 1 + altTabWindows.length) % altTabWindows.length;
        } else {
          altTabIndex = (altTabIndex + 1) % altTabWindows.length;
        }
        highlightAltTab();
      }
    }
  });

  // Release Alt → confirm selection
  document.addEventListener('keyup', function (e) {
    if (e.key === 'Alt' && altTabActive) {
      confirmAltTab();
    }
  });

  // ── Layout change: re-fit maximized windows to new work area ────────

  function _refitMaximized() {
    Object.keys(windows).forEach(function (id) {
      var ws = windows[id];
      if (ws.state === 'maximized') {
        _applyGeometry(ws.el, _getContainerArea());
        if (ws.app.onResize) ws.app.onResize();
      }
    });
  }

  // Fires when taskbar position/chrome changes.
  document.addEventListener('fulc-layout-change', _refitMaximized);

  // Heritage adapters (orchard, crystal) apply their CSS after fulc-theme-change.
  // A ResizeObserver on #windows-container catches every size change from
  // theme swaps, responsive CSS, and viewport resize — no RAF timing guesswork.
  if (typeof ResizeObserver !== 'undefined') {
    var _containerObserver = new ResizeObserver(_refitMaximized);
    var _containerEl = document.getElementById('windows-container');
    if (_containerEl) _containerObserver.observe(_containerEl);
  } else {
    // Fallback for environments without ResizeObserver.
    document.addEventListener('fulc-theme-change', function () {
      requestAnimationFrame(_refitMaximized);
    });
    window.addEventListener('resize', _refitMaximized);
  }

  // ── Public API ─────────────────────────────────────────────────────

  // kept on window for MCP devtools reads — see epic-26/08.md keep-list
  window.FULCWM = {
    open: open,
    sanitizePreviewClone: sanitizePreviewClone,
    close: close,
    minimize: minimize,
    restore: restore,
    toggleMaximize: toggleMaximize,
    focus: focus,
    isOpen: isOpen,
    getOpen: getOpen,
    getActive: getActive,
    cycleNext: cycleNext,
    snapTo: snapTo,
    toggleAlwaysOnTop: toggleAlwaysOnTop,
    enterExpose: enterExpose,
    exitExpose: exitExpose,
    toggleShowDesktop: toggleShowDesktop,
    toggleFullscreen: toggleFullscreen,
    switchWorkspace: switchWorkspace,
    moveToWorkspace: moveToWorkspace,
    jumpTo: jumpTo,
    bringHere: bringHere,
    getActiveWorkspace: function () { return activeWorkspace; },
    getWorkspaceCount: function () { return WORKSPACE_COUNT; },
    openWorkspaceOverview: openWorkspaceOverview,
    closeWorkspaceOverview: closeWorkspaceOverview,
    resetLayout: resetLayout,
    restoreLayout: restoreLayout,
    renameWindow: function (appId, title) {
      var ws = windows[appId];
      if (!ws) return;
      ws.customTitle = title;
      var titleEl = ws.el.querySelector('.window-title');
      if (titleEl) titleEl.textContent = title;
      if (window.FULCTaskbar) window.FULCTaskbar.update();
    }
  };
})();

export const FULCWM = window.FULCWM;
