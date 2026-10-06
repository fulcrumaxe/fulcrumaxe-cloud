import { FULCScreenSaver } from "./screen-saver.js";
// D#37 WS-C2 criterion 11: persisted under storage-ns.js's fx:<ns>:
// namespace, not a raw localStorage key.
import { getItem, setItem, onNamespaceReady } from "./storage-ns.js";
import { FULCPhoneMode } from "./phone-mode.js";

export const FULCHotCorners = {};
(function () {
  'use strict';

  const CORNER_SIZE = 6;
  const DWELL_MS = 400;
  const STORAGE_KEY = 'hot-corners';

  const DEFAULT_CORNERS = {
    'top-left':     'expose',
    'top-right':    'show-desktop',
    'bottom-left':  'disabled',
    'bottom-right': 'disabled'
  };

  let cornerConfig = {};
  let dwellTimer = null;
  let activeCorner = null;
  let triggered = false;

  function loadConfig() {
    try {
      var stored = getItem(STORAGE_KEY);
      if (stored) {
        cornerConfig = JSON.parse(stored);
      } else {
        cornerConfig = Object.assign({}, DEFAULT_CORNERS);
      }
    } catch (e) {
      cornerConfig = Object.assign({}, DEFAULT_CORNERS);
    }
  }

  function saveConfig() {
    setItem(STORAGE_KEY, JSON.stringify(cornerConfig));
  }

  function getCorner(x, y) {
    var vw = window.innerWidth;
    var vh = window.innerHeight;

    if (x < CORNER_SIZE && y < CORNER_SIZE) return 'top-left';
    if (x >= vw - CORNER_SIZE && y < CORNER_SIZE) return 'top-right';
    if (x < CORNER_SIZE && y >= vh - CORNER_SIZE) return 'bottom-left';
    if (x >= vw - CORNER_SIZE && y >= vh - CORNER_SIZE) return 'bottom-right';
    return null;
  }

  function executeAction(action) {
    if (!action || action === 'disabled') return;
    // D#37 WS-E criterion 1: hot corners are a no-op on phones. Real phones
    // never fire mousemove for a corner dwell, but Playwright emulation can
    // dispatch one directly, so this is an explicit guard rather than a
    // reliance on the absence of a mouse.
    if (FULCPhoneMode && FULCPhoneMode.isPhone()) return;

    if (action === 'expose') {
      if (!window.FULCWM) return;
      window.FULCWM.enterExpose();
    } else if (action === 'show-desktop') {
      if (!window.FULCWM) return;
      window.FULCWM.toggleShowDesktop();
    } else if (action === 'workspace-overview') {
      if (!window.FULCWM) return;
      window.FULCWM.openWorkspaceOverview();
    } else if (action === 'screen-saver') {
      if (FULCScreenSaver) FULCScreenSaver.start();
    } else if (action.indexOf('open:') === 0) {
      var appId = action.substring(5);
      if (window.FULCWM) window.FULCWM.open(appId);
    }
  }

  document.addEventListener('mousemove', function (e) {
    var corner = getCorner(e.clientX, e.clientY);

    if (corner !== activeCorner) {
      // Cursor moved to a different zone (or left all corners)
      clearTimeout(dwellTimer);
      dwellTimer = null;
      activeCorner = corner;
      triggered = false;

      if (corner && cornerConfig[corner] && cornerConfig[corner] !== 'disabled') {
        dwellTimer = setTimeout(function () {
          if (!triggered) {
            triggered = true;
            executeAction(cornerConfig[corner]);
          }
        }, DWELL_MS);
      }
    }
  });

  // ── Visual debug indicators (development only, hidden in production) ──

  var debugCorners = null;

  function showDebugCorners() {
    if (debugCorners) return;
    debugCorners = {};
    var positions = {
      'top-left':     { top: '0', left: '0' },
      'top-right':    { top: '0', right: '0' },
      'bottom-left':  { bottom: '0', left: '0' },
      'bottom-right': { bottom: '0', right: '0' }
    };

    Object.keys(positions).forEach(function (key) {
      var el = document.createElement('div');
      el.className = 'hot-corner-debug';
      el.style.position = 'fixed';
      el.style.width = CORNER_SIZE + 'px';
      el.style.height = CORNER_SIZE + 'px';
      el.style.zIndex = '99999';
      el.style.pointerEvents = 'none';
      el.style.background = cornerConfig[key] && cornerConfig[key] !== 'disabled'
        ? 'rgba(var(--theme-rgb), 0.4)' : 'transparent';
      Object.assign(el.style, positions[key]);
      document.body.appendChild(el);
      debugCorners[key] = el;
    });
  }

  function hideDebugCorners() {
    if (!debugCorners) return;
    Object.values(debugCorners).forEach(function (el) { el.remove(); });
    debugCorners = null;
  }

  // ── Settings Dialog ───────────────────────────────────────────────────

  function showHotCornersDialog() {
    // Remove existing dialog if open
    var existing = document.querySelector('.hc-dialog-overlay');
    if (existing) { existing.remove(); return; }

    var overlay = document.createElement('div');
    overlay.className = 'hc-dialog-overlay';

    var dialog = document.createElement('div');
    dialog.className = 'hc-dialog';
    // Reachable already — every control in here is native and Escape closes it.
    // What was missing is the naming: `role=dialog` so the overlay is announced
    // as one, and a real accessible name on the close button, whose only text
    // was the glyph U+2715.
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Hot corners settings');
    dialog.tabIndex = -1;

    // Title bar
    var titlebar = document.createElement('div');
    titlebar.className = 'hc-dialog-titlebar';
    var titlebarLabel = document.createElement('span');
    titlebarLabel.textContent = 'HOT CORNERS';
    var titlebarCloseBtn = document.createElement('button');
    titlebarCloseBtn.type = 'button';
    titlebarCloseBtn.className = 'hc-dialog-close';
    titlebarCloseBtn.setAttribute('aria-label', 'Close hot corners settings');
    titlebarCloseBtn.textContent = '\u2715';
    titlebar.append(titlebarLabel, titlebarCloseBtn);
    dialog.appendChild(titlebar);

    // Visual corner diagram
    var diagram = document.createElement('div');
    diagram.className = 'hc-diagram';

    var corners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

    var actions = [
      { value: 'disabled', label: '\u2014 Disabled \u2014' },
      { value: 'expose', label: 'Expose (All Windows)' },
      { value: 'show-desktop', label: 'Show Desktop' },
      { value: 'workspace-overview', label: 'Workspace Overview' },
      { value: 'screen-saver', label: 'Screen Saver' },
      { value: 'open:terminal', label: 'Open Terminal' }
    ];

    // Build a 3x3 grid: corners at the 4 corners, monitor icon in center
    function diagramCorner(corner) {
      var el = document.createElement('div');
      el.className = 'hc-diagram-corner';
      el.dataset.corner = corner;
      return el;
    }
    function diagramEdge() {
      var el = document.createElement('div');
      el.className = 'hc-diagram-edge';
      return el;
    }
    var monitorIcon = document.createElement('div');
    monitorIcon.className = 'hc-monitor-icon';
    monitorIcon.textContent = '[ fulcrumaxe-os ]';
    var monitor = document.createElement('div');
    monitor.className = 'hc-diagram-monitor';
    monitor.appendChild(monitorIcon);

    var grid = document.createElement('div');
    grid.className = 'hc-diagram-grid';
    grid.append(
      diagramCorner('top-left'), diagramEdge(), diagramCorner('top-right'),
      diagramEdge(), monitor, diagramEdge(),
      diagramCorner('bottom-left'), diagramEdge(), diagramCorner('bottom-right')
    );
    diagram.replaceChildren(grid);

    corners.forEach(function (corner) {
      var cell = diagram.querySelector('[data-corner="' + corner + '"]');
      var label = document.createElement('div');
      label.className = 'hc-corner-name';
      label.textContent = corner.replace(/-/g, ' ').toUpperCase();
      cell.appendChild(label);

      var select = document.createElement('select');
      select.className = 'hc-select';
      actions.forEach(function (a) {
        var opt = document.createElement('option');
        opt.value = a.value;
        opt.textContent = a.label;
        if (cornerConfig[corner] === a.value) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener('change', function () {
        cornerConfig[corner] = select.value;
        saveConfig();
      });
      cell.appendChild(select);
    });

    dialog.appendChild(diagram);

    // Screen saver timeout setting
    var ssSection = document.createElement('div');
    ssSection.className = 'hc-screensaver-section';
    var ssLabel = document.createElement('div');
    ssLabel.className = 'hc-ss-label';
    ssLabel.textContent = 'SCREEN SAVER IDLE TIMEOUT';
    var ssSelectEl = document.createElement('select');
    ssSelectEl.className = 'hc-select hc-ss-select';
    [
      ['0', 'Disabled'], ['5', '5 minutes'], ['10', '10 minutes'],
      ['15', '15 minutes'], ['30', '30 minutes']
    ].forEach(function (pair) {
      var o = document.createElement('option');
      o.value = pair[0];
      o.textContent = pair[1];
      ssSelectEl.appendChild(o);
    });
    ssSection.append(ssLabel, ssSelectEl);

    var ssSelect = ssSection.querySelector('.hc-ss-select');
    var currentTimeout = FULCScreenSaver ? FULCScreenSaver.getIdleTimeout() : 0;
    ssSelect.value = String(currentTimeout);
    ssSelect.addEventListener('change', function () {
      if (FULCScreenSaver) {
        FULCScreenSaver.setIdleTimeout(parseInt(ssSelect.value, 10));
      }
    });
    dialog.appendChild(ssSection);

    // Reset button
    var resetBtn = document.createElement('button');
    resetBtn.className = 'hc-reset-btn';
    resetBtn.textContent = 'RESET TO DEFAULTS';
    resetBtn.addEventListener('click', function () {
      FULCHotCorners.reset();
      // Reload dialog
      overlay.remove();
      showHotCornersDialog();
    });
    dialog.appendChild(resetBtn);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    // Focus into the dialog, or a keyboard user has to tab the whole desktop to
    // reach a modal that is already covering it.
    dialog.focus({ preventScroll: true });

    // Close handlers
    titlebar.querySelector('.hc-dialog-close').addEventListener('click', function () {
      overlay.remove();
    });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });
    document.addEventListener('keydown', function escHandler(e) {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', escHandler);
      }
    });
  }

  // ── Public API ────────────────────────────────────────────────────────

  // Seeds the default config immediately (no namespace exists yet, so
  // this reads nothing persisted), then re-runs once a namespace is set
  // so a returning user's saved corners actually take effect.
  loadConfig();
  onNamespaceReady(loadConfig);

  Object.assign(FULCHotCorners, {
    getConfig: function () { return Object.assign({}, cornerConfig); },
    setCorner: function (corner, action) {
      cornerConfig[corner] = action;
      saveConfig();
    },
    reset: function () {
      cornerConfig = Object.assign({}, DEFAULT_CORNERS);
      saveConfig();
    },
    buildSettingsPanel: function () { return null; },
    showSettings: showHotCornersDialog,
    showDebug: showDebugCorners,
    hideDebug: hideDebugCorners
  });
})();
