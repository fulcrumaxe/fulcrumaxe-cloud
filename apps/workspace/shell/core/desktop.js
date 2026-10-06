// ── fulcrumaxe-os Desktop ─────────────────────────────────────────────────────
// Desktop surface with snap-to-grid icons, drag rearrange, selection
// rectangle, arrange options, and wallpaper system.
import { FULCApps } from "./app-registry.js";
import { FULCContextMenu } from "./context-menu.js";
import { FULCHotCorners } from "./hot-corners.js";
// D#37 WS-C2 criterion 11: persisted under storage-ns.js's fx:<ns>:
// namespace, not a raw localStorage key.
import { getItem, setItem } from "./storage-ns.js";

export const FULCDesktop = {};
(function () {
  'use strict';

  const surface = document.getElementById('desktop-surface');
  if (!surface) return;

  // ── Grid configuration ──────────────────────────────────────────────
  const GRID_CELL_W = 100;
  const GRID_CELL_H = 100;
  const GRID_GAP = 8;
  const GRID_PADDING = 24;

  // ── Icon definitions ────────────────────────────────────────────────
  // Cloud app entries are gated to cloud/skeleton modes so they stay off
  // the desktop in default server mode but appear for curated profiles.
  const ICONS = [
    { id: 'terminal',      label: 'TERMINAL',   icon: '>_',  adminOnly: false },
    { id: 'fulc-shell',    label: 'fulcrumaxe-os SHELL', icon: '>',   adminOnly: false },
    { id: 'file-manager',  label: 'FILES',      icon: '[]',  adminOnly: false },
    { id: 'messages',      label: 'MESSAGES',   icon: '@',   adminOnly: false },
    { id: 'profile',       label: 'PROFILE',    icon: '::',  adminOnly: false },
    { id: 'command-builder', label: 'CMD BUILDER', icon: '{}', adminOnly: false },
    { id: 'resource-monitor', label: 'RESOURCES', icon: '%', adminOnly: false },
    { id: 'storage-manager', label: 'STORAGE', icon: 'HD', adminOnly: false, modes: ['container'] },
    { id: 'shortcut-trainer', label: 'KEY TRAINER', icon: '?/', adminOnly: false },
    { id: 'tutorial',         label: 'TUTORIAL',    icon: '?!', adminOnly: false },
    { id: 'package-manager', label: 'PACKAGES', icon: 'PM', adminOnly: false, modes: ['container', 'local', 'standalone'] },
    { id: 'kanban',        label: 'KANBAN',     icon: '||',  adminOnly: false },
    { id: 'agents',        label: 'AGENTS',     icon: 'AI',  adminOnly: false },
    { id: 'kpi-dashboard', label: 'KPI',        icon: '%%',  adminOnly: false },
    { id: 'themes',        label: 'THEMES',     icon: '◑',   adminOnly: false },
    { id: 'web-browser',   label: 'BROWSER',    icon: 'WEB', adminOnly: false },
    // Native GUI apps streamed through Xpra — only meaningful where fulcrumaxe-os runs
    // on the user's own machine (docs/native-desktop-mode-design.md).
    { id: 'native-launcher', label: 'NATIVE APPS', icon: 'X>', adminOnly: false, modes: ['local', 'standalone'] },
    { id: 'admin',         label: 'ADMIN',      icon: '!!',  adminOnly: true },
    // Cloud management — only on desktop in cloud/skeleton modes.
    // The modes gate keeps these off the default server desktop;
    // the registered gate (isIconVisible) hides them when their scripts
    // aren't loaded (e.g. non-cloud profiles).
    { id: 'cloud-deploy',  label: 'DEPLOY',     icon: 'CD',  adminOnly: false, modes: ['cloud', 'skeleton'] },
    { id: 'cloud-manage',  label: 'MANAGE',     icon: 'CM',  adminOnly: false, modes: ['cloud', 'skeleton'] },
  ];

  // D#37 WS-E criterion 6: desktop icons are read from the app registry
  // (FULCApps.visible()), not iterated from ICONS directly. ICONS is
  // deliberately NOT seeded into the registry here: isIconVisible()'s own
  // "registered gate" (below) already means an ICONS entry whose real app
  // script never shipped/never calls FULCApps.register() itself is
  // invisible today, in both the old ICONS-iteration code and this one --
  // seeding would silently turn every placeholder ICONS entry into a
  // clickable icon with no real app behind it. The fix this criterion is
  // actually for is the reverse case: a real registered app that has NO
  // ICONS entry at all (every future WS-F product app) previously could
  // never appear on the desktop no matter what it registered, because
  // rendering iterated ICONS and stopped there. FULCApps.visible() as the
  // iteration source fixes that without changing what's visible today.
  function _appDefs() {
    return (window.FULCApps && window.FULCApps.visible) ? window.FULCApps.visible() : ICONS;
  }

  // A registered app's display metadata may come in as `label` (this
  // file's own ICONS convention) or `title` (window-manager.js's and
  // taskbar.js's convention for a real app module) -- a future WS-F app
  // that registers with only `title` must still render on the desktop.
  function _displayLabel(def) {
    return def.label || def.title || def.id;
  }

  // ── Wallpaper definitions ───────────────────────────────────────────
  const WALLPAPERS = [
    { id: 'matrix',  label: 'Matrix Rain',  type: 'canvas' },
    { id: 'solid',   label: 'Solid Dark',   type: 'css', style: 'background: #0a0a0a;' },
    { id: 'grid',    label: 'Dot Grid',     type: 'css', style: 'background-image: radial-gradient(rgba(var(--theme-rgb), 0.15) 1px, transparent 1px); background-size: 20px 20px; background-color: #0a0a0a;' },
    { id: 'circuit', label: 'Circuit',      type: 'css', style: 'background-image: linear-gradient(rgba(var(--theme-rgb), 0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(var(--theme-rgb), 0.05) 1px, transparent 1px); background-size: 40px 40px; background-color: #0a0a0a;' }
  ];

  const WALLPAPER_STORAGE_KEY = 'wallpaper';

  // ── Grid position persistence ───────────────────────────────────────
  const STORAGE_KEY = 'desktop-icon-positions';

  function getPositions() {
    try {
      const stored = getItem(STORAGE_KEY);
      if (stored) return JSON.parse(stored);
    } catch (e) {}
    return {};
  }

  function savePositions(positions) {
    setItem(STORAGE_KEY, JSON.stringify(positions));
  }

  // ── Dock pin helper (from Phase 2) ──────────────────────────────────
  function isPinnedToDock(appId) {
    return window.FULCTaskbar && window.FULCTaskbar.getPins &&
           window.FULCTaskbar.getPins().indexOf(appId) !== -1;
  }

  // ── Entitlement helpers — delegate to FULCEntitlements shared API ──
  function _iconDef(iconDef) {
    // Resolve to the registered app def so capability/whenDenied fields are canonical.
    return (window.FULCApps && window.FULCApps.get(iconDef.id)) || iconDef;
  }

  function getIconCapability(iconDef) {
    if (window.FULCEntitlements) return window.FULCEntitlements.appCapability(_iconDef(iconDef));
    const app = window.FULCApps && window.FULCApps.get(iconDef.id);
    return (app && app.capability) || ('app.' + iconDef.id);
  }

  function getIconWhenDenied(iconDef) {
    if (window.FULCEntitlements) return window.FULCEntitlements.appWhenDenied(_iconDef(iconDef));
    const app = window.FULCApps && window.FULCApps.get(iconDef.id);
    return (app && app.whenDenied) || 'show-locked';
  }

  function getIconEntitlementDecision(iconDef) {
    if (window.FULCEntitlements) return window.FULCEntitlements.appDecision(_iconDef(iconDef));
    return { type: 'Allow' };
  }

  function isIconHidden(iconDef) {
    if (window.FULCEntitlements) return window.FULCEntitlements.isAppHidden(_iconDef(iconDef));
    return false;
  }

  // ── Unified visibility predicate ─────────────────────────────────────
  // Two-stage filter used at BOTH render sites so logic is never duplicated:
  //   1. Registered gate: app script must have loaded and called FULCApps.register().
  //      Apps trimmed by profile_surface never register → hidden entirely (no padlock).
  //   2. Existing checks: adminOnly, modes, entitlement-hide.
  // The registered gate is defense-in-depth, not the security boundary.
  // Under the default profile every app registers, so this is a no-op.
  function isIconVisible(iconDef, currentMode, currentProfile) {
    // 1. Registered gate — must have called FULCApps.register(id, ...)
    if (window.FULCApps && !window.FULCApps.isRegistered(iconDef.id)) return false;
    // 2. Admin gate
    if (iconDef.adminOnly && !window.currentIsAdmin) return false;
    // 3. Mode/profile gate (undefined modes = visible everywhere).
    //
    //    A value in `modes` can legitimately arrive from EITHER of two switches,
    //    and that is why this reads both. `FULC_MODE` is the cloud mode and
    //    `FULC_PROFILE` is the deployment profile (`FULC_DEPLOYMENT_PROFILE`);
    //    `deployment_profile.rs:3` calls them "orthogonal" — they are genuinely
    //    independent — but they share value names, `skeleton` being both a
    //    `cloud_mode::Mode` variant and a deployment profile. They are NOT merged
    //    here: each is read from its own field of `/api/mode` (`{mode, profile}`,
    //    both put on `window` by boot.js), and an icon is shown when either one
    //    names it.
    //
    //    Matching the mode alone was D#631: the skeleton *profile* serves the
    //    cloud-deploy and cloud-manage modules and grants their capabilities, yet
    //    reported mode `local`, so both icons were filtered and the profile shipped
    //    a desktop with no way to reach the only two apps it exists to expose.
    //    Deliberately not fixed by adding 'local' to those icons' `modes` list —
    //    that would put cloud icons on every ordinary local desktop, which is the
    //    opposite of what this gate is for.
    if (iconDef.modes
      && !iconDef.modes.includes(currentMode)
      && !iconDef.modes.includes(currentProfile)) return false;
    // 4. Entitlement hide (Deny + whenDenied==='hide')
    if (isIconHidden(iconDef)) return false;
    return true;
  }

  // ── Selection helpers ───────────────────────────────────────────────
  let selectedIcon = null;

  function selectIcon(el) {
    deselectAll();
    el.classList.add('selected');
    selectedIcon = el;
    setRovingTarget(el);
  }

  // ── Keyboard reachability (D#649 PR 2) ──────────────────────────────
  // The icons are a 2-D grid, so they are ONE tab stop with a roving
  // tabindex, not 17 of them: tabbing through the whole desktop before
  // reaching the taskbar is the reason grids use this pattern. The element
  // itself is a native <button>, so Enter/Space focus and activation come
  // from the platform rather than from a role attribute bolted onto a div —
  // and the harness's CONTROL_SELECTOR recognises it by tag, independently
  // of which icon currently holds tabindex="0".

  function allIcons() {
    return Array.prototype.slice.call(surface.querySelectorAll('.desktop-icon'));
  }

  // Exactly one icon is in the tab order at any moment.
  function setRovingTarget(el) {
    allIcons().forEach(function (i) { i.tabIndex = (i === el) ? 0 : -1; });
  }

  function focusIcon(el) {
    if (!el) return;
    selectIcon(el);
    el.focus();
  }

  // Arrow keys move by GRID coordinate, not by DOM order — the icons are
  // absolutely positioned and their DOM order is the ICONS array, which is
  // not the order they appear on screen once anything has been dragged.
  function moveFocus(fromEl, dCol, dRow) {
    const fc = parseInt(fromEl.dataset.gridCol, 10);
    const fr = parseInt(fromEl.dataset.gridRow, 10);
    if (isNaN(fc) || isNaN(fr)) return;
    let best = null;
    let bestScore = Infinity;
    allIcons().forEach(function (i) {
      if (i === fromEl) return;
      const c = parseInt(i.dataset.gridCol, 10);
      const r = parseInt(i.dataset.gridRow, 10);
      if (isNaN(c) || isNaN(r)) return;
      const dc = c - fc;
      const dr = r - fr;
      // Must lie strictly in the requested direction on the primary axis.
      if (dCol !== 0 && Math.sign(dc) !== dCol) return;
      if (dRow !== 0 && Math.sign(dr) !== dRow) return;
      const primary = dCol !== 0 ? Math.abs(dc) : Math.abs(dr);
      const secondary = dCol !== 0 ? Math.abs(dr) : Math.abs(dc);
      const score = primary * 1000 + secondary;
      if (score < bestScore) { bestScore = score; best = i; }
    });
    focusIcon(best);
  }

  function focusEdgeIcon(first) {
    const ordered = allIcons().sort(function (a, b) {
      const ra = parseInt(a.dataset.gridRow, 10);
      const rb = parseInt(b.dataset.gridRow, 10);
      if (ra !== rb) return ra - rb;
      return parseInt(a.dataset.gridCol, 10) - parseInt(b.dataset.gridCol, 10);
    });
    focusIcon(first ? ordered[0] : ordered[ordered.length - 1]);
  }

  // Open an icon: resolve its def, consult the entitlement decision, and either
  // open the window or surface the upgrade modal.
  //
  // THIS IS NOT THE ENFORCEMENT POINT and must not be read as one. The gate that
  // actually holds is central, inside FULCWM.open() itself
  // (core/window-manager.js:297-306), whose own comment reads "Every launch path
  // (desktop, taskbar, hot-corners, theme adapters, terminal `open`, MCP,
  // devtools console) flows through here, so the gate cannot be bypassed by any
  // single call site." Verified live during review: a denied capability opens
  // nothing whether or not it passes through this function. So what this gives
  // is defence in depth and a consistent local refusal, not a boundary — do not
  // build a security argument on a call site reaching it.
  //
  // Returns true iff a window was opened, so a caller with follow-up work (the
  // context menu's "Open in New Workspace") can skip that work on a refusal.
  function openIconById(appId) {
    if (!window.FULCWM) return false;
    // D#37 WS-E criterion 6: "a registered app appears ... in open" -- the
    // registry is checked first; ICONS is only a fallback for the (never
    // expected) case FULCApps itself failed to load.
    let iconDef = (window.FULCApps && window.FULCApps.get(appId)) || null;
    if (!iconDef) {
      ICONS.forEach(function (d) { if (d.id === appId) iconDef = d; });
    }
    if (!iconDef) return false;
    // Refuse explicitly rather than by throwing. Failing closed was already
    // correct; failing closed by exception was not, because this runs inside a
    // forEach over a multi-icon selection and a throw would silently skip every
    // remaining icon.
    let decision = null;
    try {
      decision = getIconEntitlementDecision(iconDef);
    } catch (e) {
      decision = null;
    }
    if (!decision || decision.type !== 'Allow') {
      if (window.FULCUpgradeModal) {
        window.FULCUpgradeModal.open({ capability: getIconCapability(iconDef), decision: decision });
      }
      return false;
    }
    window.FULCWM.open(iconDef.id);
    return true;
  }

  // Open whatever Enter should act on. A multi-icon ctrl+click selection opens
  // ALL of it — that is what the document-level handler did before the icons
  // became focusable, and losing it was a real regression, not a tidy-up: with
  // focus now always on an icon after a click, the per-icon handler swallowed
  // the event and only the last-clicked icon opened.
  function openSelectionOrFocused(focusedEl, focusedAppId) {
    const selected = surface.querySelectorAll('.desktop-icon.selected');
    if (selected.length > 1) {
      selected.forEach(function (icon) { openIconById(icon.dataset.appId); });
      return;
    }
    // One or zero selected: act on the icon the user is actually on. This is
    // the path that makes a tabbed-to icon openable at all.
    selectIcon(focusedEl);
    openIconById(focusedAppId);
  }

  function deselectAll() {
    surface.querySelectorAll('.desktop-icon.selected').forEach(function (i) { i.classList.remove('selected'); });
    selectedIcon = null;
  }

  // ── Drop indicator ─────────────────────────────────────────────────
  let dropIndicator = null;

  function showDropIndicator(clientX, clientY) {
    if (!dropIndicator) {
      dropIndicator = document.createElement('div');
      dropIndicator.className = 'desktop-drop-indicator';
      surface.appendChild(dropIndicator);
    }

    let col = Math.round((clientX - GRID_PADDING - GRID_CELL_W / 2) / (GRID_CELL_W + GRID_GAP));
    let row = Math.round((clientY - GRID_PADDING - GRID_CELL_H / 2) / (GRID_CELL_H + GRID_GAP));

    const surfaceRect = surface.getBoundingClientRect();
    const taskbarH = document.getElementById('taskbar')?.offsetHeight || 48;
    const availH = window.innerHeight - taskbarH;
    const cols = Math.floor((surfaceRect.width - GRID_PADDING * 2 + GRID_GAP) / (GRID_CELL_W + GRID_GAP));
    const rows = Math.floor((availH - GRID_PADDING * 2 + GRID_GAP) / (GRID_CELL_H + GRID_GAP));

    col = Math.max(0, Math.min(col, cols - 1));
    row = Math.max(0, Math.min(row, rows - 1));

    dropIndicator.style.left = (GRID_PADDING + col * (GRID_CELL_W + GRID_GAP)) + 'px';
    dropIndicator.style.top = (GRID_PADDING + row * (GRID_CELL_H + GRID_GAP)) + 'px';
    dropIndicator.style.display = 'block';
  }

  function hideDropIndicator() {
    if (dropIndicator) {
      dropIndicator.style.display = 'none';
    }
  }

  // ── Icon drag to rearrange ──────────────────────────────────────────
  function setupIconDrag(el, iconDef) {
    let startX, startY, origLeft, origTop, isDragging = false;

    el.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();

      startX = e.clientX;
      startY = e.clientY;
      origLeft = parseInt(el.style.left, 10);
      origTop = parseInt(el.style.top, 10);
      isDragging = false;

      function onMove(e2) {
        const dx = e2.clientX - startX;
        const dy = e2.clientY - startY;

        if (!isDragging && Math.abs(dx) + Math.abs(dy) < 5) return;
        isDragging = true;

        el.classList.add('dragging');
        el.style.transition = 'none';
        el.style.zIndex = '100';
        el.style.left = (origLeft + dx) + 'px';
        el.style.top = (origTop + dy) + 'px';

        showDropIndicator(e2.clientX, e2.clientY);
      }

      function onUp(e2) {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);

        el.classList.remove('dragging');
        el.style.zIndex = '';
        el.style.transition = '';

        if (!isDragging) return;

        let dropCol = Math.round((e2.clientX - GRID_PADDING - GRID_CELL_W / 2) / (GRID_CELL_W + GRID_GAP));
        let dropRow = Math.round((e2.clientY - GRID_PADDING - GRID_CELL_H / 2) / (GRID_CELL_H + GRID_GAP));

        const surfaceRect = surface.getBoundingClientRect();
        const taskbarH = document.getElementById('taskbar')?.offsetHeight || 48;
        const availH = window.innerHeight - taskbarH;
        const cols = Math.floor((surfaceRect.width - GRID_PADDING * 2 + GRID_GAP) / (GRID_CELL_W + GRID_GAP));
        const rows = Math.floor((availH - GRID_PADDING * 2 + GRID_GAP) / (GRID_CELL_H + GRID_GAP));

        dropCol = Math.max(0, Math.min(dropCol, cols - 1));
        dropRow = Math.max(0, Math.min(dropRow, rows - 1));

        const positions = getPositions();
        let existingApp = null;

        Object.keys(positions).forEach(function (appId) {
          if (appId !== iconDef.id && positions[appId].col === dropCol && positions[appId].row === dropRow) {
            existingApp = appId;
          }
        });

        if (existingApp) {
          const myOldPos = positions[iconDef.id];
          positions[existingApp] = { col: myOldPos.col, row: myOldPos.row };
        }

        positions[iconDef.id] = { col: dropCol, row: dropRow };
        savePositions(positions);

        hideDropIndicator();
        render();
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ── Icon element creation ───────────────────────────────────────────
  function createIconElement(iconDef, pos) {
    // A native <button>, not a div with role="button": Enter/Space activation,
    // focusability and the accessible name come from the platform. The UA
    // form-control style block it drags in is reset in desktop.css.
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'desktop-icon';
    el.dataset.appId = iconDef.id;
    // Grid coordinates travel on the element so arrow navigation reads the
    // rendered layout rather than re-deriving it from positions storage.
    el.dataset.gridCol = String(pos.col);
    el.dataset.gridRow = String(pos.row);
    // Roving tabindex — render() promotes exactly one icon to 0 afterwards.
    el.tabIndex = -1;
    el.setAttribute('aria-label', _displayLabel(iconDef));

    el.style.position = 'absolute';
    el.style.left = (GRID_PADDING + pos.col * (GRID_CELL_W + GRID_GAP)) + 'px';
    el.style.top = (GRID_PADDING + pos.row * (GRID_CELL_H + GRID_GAP)) + 'px';
    el.style.width = GRID_CELL_W + 'px';
    el.style.height = GRID_CELL_H + 'px';

    // <span>, not <div>: a button's content model is phrasing content. The
    // graphic is an ASCII glyph, so it is decorative once aria-label carries
    // the name — announcing ">_" before "TERMINAL" is noise.
    const graphic = document.createElement('span');
    graphic.className = 'desktop-icon-graphic';
    graphic.setAttribute('aria-hidden', 'true');
    graphic.textContent = iconDef.icon;
    const iconLabel = document.createElement('span');
    iconLabel.className = 'desktop-icon-label';
    iconLabel.textContent = _displayLabel(iconDef);
    el.append(graphic, iconLabel);

    // Single click to select
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      if (e.ctrlKey) {
        el.classList.toggle('selected');
        setRovingTarget(el);
      } else {
        selectIcon(el);
      }
      // setupIconDrag preventDefaults mousedown to stop text selection, which
      // also suppresses the UA's focus-on-mousedown. Focus explicitly so the
      // clicked icon is where Tab resumes from.
      el.focus();
    });

    // Double click to open — routes through upgrade modal if gated
    el.addEventListener('dblclick', function (e) {
      e.stopPropagation();
      openIconById(iconDef.id);
    });

    // The keyboard equivalent of dblclick, plus grid navigation. Without this
    // the icon would be focusable and still not openable: the open path is
    // dblclick-only, which no key produces.
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        // preventDefault suppresses the click a native button synthesises from
        // Enter/Space; stopPropagation keeps the document-level Enter handler
        // below from opening the same icon a second time. Because that handler
        // is now unreachable whenever an icon has focus — which, after any
        // click, is always — the multi-select behaviour it owned has to live
        // here too.
        e.preventDefault();
        e.stopPropagation();
        openSelectionOrFocused(el, iconDef.id);
        return;
      }
      let handled = true;
      switch (e.key) {
        case 'ArrowRight': moveFocus(el, 1, 0); break;
        case 'ArrowLeft':  moveFocus(el, -1, 0); break;
        case 'ArrowDown':  moveFocus(el, 0, 1); break;
        case 'ArrowUp':    moveFocus(el, 0, -1); break;
        case 'Home':       focusEdgeIcon(true); break;
        case 'End':        focusEdgeIcon(false); break;
        default: handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    });

    // Right-click context menu
    el.addEventListener('contextmenu', function (e) {
      e.stopPropagation();
      if (!FULCContextMenu) return;

      const isPinned = isPinnedToDock(iconDef.id);
      const isRunning = window.FULCWM && window.FULCWM.isOpen(iconDef.id);
      const items = [];

      items.push({ label: 'Open', action: function () { openIconById(iconDef.id); } });

      // Open in New Workspace: find first empty workspace (or default to 2)
      items.push({ label: 'Open in New Workspace', action: function () {
        if (!window.FULCWM) return;
        var targetWs = 2;
        if (window.FULCWM.getWorkspaceCount) {
          var count = window.FULCWM.getWorkspaceCount();
          var activeWs = window.FULCWM.getActiveWorkspace();
          for (var w = 1; w <= count; w++) {
            if (w !== activeWs) {
              var wsWindows = window.FULCWM.getOpen(w);
              if (wsWindows.length === 0) { targetWs = w; break; }
            }
          }
        }
        // Skip the move/switch if the open was refused — otherwise a denied
        // icon still drags the user to an empty workspace.
        if (!openIconById(iconDef.id)) return;
        window.FULCWM.moveToWorkspace(iconDef.id, targetWs);
        window.FULCWM.switchWorkspace(targetWs);
      }});

      items.push({ divider: true });

      items.push({
        label: isPinned ? 'Unpin from Dock' : 'Pin to Dock',
        action: function () {
          if (isPinned) {
            window.FULCTaskbar.removePin(iconDef.id);
          } else {
            window.FULCTaskbar.addPin(iconDef.id);
          }
          window.FULCTaskbar.update();
        }
      });

      // Move to Workspace submenu (only if the app is running)
      if (isRunning && window.FULCWM.getWorkspaceCount) {
        items.push({ divider: true });
        var workspaceItems = [];
        var count = window.FULCWM.getWorkspaceCount();
        for (var w = 1; w <= count; w++) {
          (function (n) {
            workspaceItems.push({
              label: 'Workspace ' + n,
              action: function () { window.FULCWM.moveToWorkspace(iconDef.id, n); }
            });
          })(w);
        }
        items.push({ label: 'Move to Workspace', submenu: workspaceItems });
      }

      FULCContextMenu.show(e, items);
    });

    // Entitlement lock overlay — delegate to shared FULCEntitlements.applyGate
    if (window.FULCEntitlements) {
      window.FULCEntitlements.applyGate(el, _iconDef(iconDef));
    } else {
      const entDecision = getIconEntitlementDecision(iconDef);
      if (entDecision.type !== 'Allow') {
        el.classList.add('fulc-entitlement-locked');
        if (window.FULCFeatureGate) {
          window.FULCFeatureGate._applyOverlay(el, getIconCapability(iconDef), entDecision);
        }
      }
    }

    // Drag to rearrange
    setupIconDrag(el, iconDef);

    return el;
  }

  // ── Grid render ─────────────────────────────────────────────────────
  function render() {
    surface.replaceChildren();

    const surfaceRect = surface.getBoundingClientRect();
    const taskbarH = document.getElementById('taskbar')?.offsetHeight || 48;
    const availH = window.innerHeight - taskbarH;
    const availW = surfaceRect.width || window.innerWidth;

    const cols = Math.floor((availW - GRID_PADDING * 2 + GRID_GAP) / (GRID_CELL_W + GRID_GAP));
    const rows = Math.floor((availH - GRID_PADDING * 2 + GRID_GAP) / (GRID_CELL_H + GRID_GAP));

    let positions = getPositions();
    const occupied = {};

    const currentMode = window.FULC_MODE || 'server';
    const currentProfile = window.FULC_PROFILE || 'default';

    // Filter visible icons: registered gate + admin + mode/profile + entitlement checks.
    // isIconVisible is defined above and shared with arrangeIcons. _appDefs()
    // is the registry (D#37 WS-E criterion 6), not ICONS directly.
    const visibleIcons = _appDefs().filter(function (iconDef) {
      return isIconVisible(iconDef, currentMode, currentProfile);
    });

    // First pass: place icons that have saved positions
    visibleIcons.forEach(function (iconDef) {
      const pos = positions[iconDef.id];
      if (pos && pos.col < cols && pos.row < rows) {
        occupied[pos.col + ',' + pos.row] = true;
      }
    });

    // Second pass: assign positions to icons without saved positions
    visibleIcons.forEach(function (iconDef) {
      if (!positions[iconDef.id]) {
        let placed = false;
        for (let c = 0; c < cols && !placed; c++) {
          for (let r = 0; r < rows && !placed; r++) {
            if (!occupied[c + ',' + r]) {
              positions[iconDef.id] = { col: c, row: r };
              occupied[c + ',' + r] = true;
              placed = true;
            }
          }
        }
        if (!placed) {
          positions[iconDef.id] = { col: 0, row: 0 };
        }
      }
    });

    savePositions(positions);

    // Render each icon at its grid position
    visibleIcons.forEach(function (iconDef) {
      const pos = positions[iconDef.id];
      const el = createIconElement(iconDef, pos);
      surface.appendChild(el);
    });

    // Seed the roving tabindex. createIconElement leaves every icon at -1, and
    // a grid where NO element is in the tab order is exactly as unreachable as
    // one built from divs — which is the defect this whole change is about.
    const firstIcon = surface.querySelector('.desktop-icon');
    if (firstIcon) setRovingTarget(firstIcon);
  }

  // ── Selection rectangle ─────────────────────────────────────────────
  let selRect = null;
  let selStartX, selStartY;

  surface.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    if (e.target.closest('.desktop-icon')) return;

    selStartX = e.clientX;
    selStartY = e.clientY;

    if (!e.ctrlKey && !e.shiftKey) {
      deselectAll();
    }

    if (!selRect) {
      selRect = document.createElement('div');
      selRect.className = 'desktop-selection-rect';
      surface.appendChild(selRect);
    }

    selRect.style.display = 'block';
    selRect.style.left = selStartX + 'px';
    selRect.style.top = selStartY + 'px';
    selRect.style.width = '0';
    selRect.style.height = '0';

    function onMove(e2) {
      const x = Math.min(e2.clientX, selStartX);
      const y = Math.min(e2.clientY, selStartY);
      const w = Math.abs(e2.clientX - selStartX);
      const h = Math.abs(e2.clientY - selStartY);

      selRect.style.left = x + 'px';
      selRect.style.top = y + 'px';
      selRect.style.width = w + 'px';
      selRect.style.height = h + 'px';

      const rectBounds = { left: x, top: y, right: x + w, bottom: y + h };
      surface.querySelectorAll('.desktop-icon').forEach(function (icon) {
        const iconRect = icon.getBoundingClientRect();
        const overlaps = !(iconRect.right < rectBounds.left ||
                           iconRect.left > rectBounds.right ||
                           iconRect.bottom < rectBounds.top ||
                           iconRect.top > rectBounds.bottom);

        if (overlaps) {
          icon.classList.add('selected');
        } else if (!e2.ctrlKey) {
          icon.classList.remove('selected');
        }
      });
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);

      if (selRect) selRect.style.display = 'none';
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // ── Keyboard actions ────────────────────────────────────────────────
  // Open all selected icons on Enter
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.target.closest('input, textarea')) {
      const selectedIcons = surface.querySelectorAll('.desktop-icon.selected');
      selectedIcons.forEach(function (icon) {
        openIconById(icon.dataset.appId);
      });
    }
  });

  // Ctrl+A to select all desktop icons
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.key === 'a' && !e.target.closest('input, textarea')) {
      const activeWin = window.FULCWM && window.FULCWM.getActive();
      if (!activeWin) {
        e.preventDefault();
        surface.querySelectorAll('.desktop-icon').forEach(function (icon) {
          icon.classList.add('selected');
        });
      }
    }
  });

  // ── Arrange icons ───────────────────────────────────────────────────
  function arrangeIcons(mode) {
    const currentMode = window.FULC_MODE || 'server';
    const currentProfile = window.FULC_PROFILE || 'default';
    const visibleIcons = _appDefs().filter(function (iconDef) {
      return isIconVisible(iconDef, currentMode, currentProfile);
    });

    if (mode === 'name') {
      visibleIcons.sort(function (a, b) { return _displayLabel(a).localeCompare(_displayLabel(b)); });
    } else if (mode === 'type') {
      const typeOrder = {
        'terminal': 0, 'profile': 0, 'admin': 0,
        'file-manager': 1, 'resource-monitor': 1, 'storage-manager': 1, 'package-manager': 1,
        'messages': 2, 'command-builder': 2, 'shortcut-trainer': 2
      };
      visibleIcons.sort(function (a, b) {
        const ta = typeOrder[a.id] || 2;
        const tb = typeOrder[b.id] || 2;
        return ta !== tb ? ta - tb : _displayLabel(a).localeCompare(_displayLabel(b));
      });
    }

    const positions = {};
    const surfaceRect = surface.getBoundingClientRect();
    const taskbarH = document.getElementById('taskbar')?.offsetHeight || 48;
    const availH = window.innerHeight - taskbarH;
    const rows = Math.floor((availH - GRID_PADDING * 2 + GRID_GAP) / (GRID_CELL_H + GRID_GAP));

    visibleIcons.forEach(function (iconDef, index) {
      const col = Math.floor(index / rows);
      const row = index % rows;
      positions[iconDef.id] = { col: col, row: row };
    });

    savePositions(positions);
    render();
  }

  // ── Desktop context menu ────────────────────────────────────────────
  surface.addEventListener('contextmenu', function (e) {
    if (e.target.closest('.desktop-icon')) return;
    if (!FULCContextMenu) return;

    FULCContextMenu.show(e, [
      { label: 'Open Terminal', action: function () { if (window.FULCWM) window.FULCWM.open('terminal'); } },
      { divider: true },
      { label: 'Arrange Icons', submenu: [
        { label: 'By Name', action: function () { arrangeIcons('name'); } },
        { label: 'By Type', action: function () { arrangeIcons('type'); } },
        { label: 'Auto Arrange', action: function () { arrangeIcons('auto'); } }
      ]},
      { divider: true },
      { label: 'Wallpaper', submenu: [
        { label: 'Matrix Rain', action: function () { setWallpaper('matrix'); } },
        { label: 'Solid Dark', action: function () { setWallpaper('solid'); } },
        { label: 'Dot Grid', action: function () { setWallpaper('grid'); } },
        { label: 'Circuit', action: function () { setWallpaper('circuit'); } }
      ]},
      { divider: true },
      { label: 'Refresh Desktop', action: function () { render(); } },
      { label: 'Reset Window Layout', action: function () {
        if (window.FULCWM) window.FULCWM.resetLayout();
      }},
      { label: 'Hot Corners...', action: function () {
        if (FULCHotCorners) FULCHotCorners.showSettings();
      }},
      // 'Display Settings' opened the profile app, withheld from this release (D#877).
      // Re-add this entry alongside the profile script tag in index.html:
      // { label: 'Display Settings', action: function () { if (window.FULCWM) window.FULCWM.open('profile'); } }
    ]);
  });

  // ── Wallpaper system ────────────────────────────────────────────────
  function getWallpaper() {
    return getItem(WALLPAPER_STORAGE_KEY) || 'matrix';
  }

  function setWallpaper(wallpaperId) {
    setItem(WALLPAPER_STORAGE_KEY, wallpaperId);
    applyWallpaper(wallpaperId);
  }

  function applyWallpaper(wallpaperId) {
    const wp = WALLPAPERS.find(function (w) { return w.id === wallpaperId; }) || WALLPAPERS[0];

    const rainCanvas = document.getElementById('rain-bg');

    if (wp.type === 'canvas') {
      if (rainCanvas) rainCanvas.style.display = '';
      surface.style.background = '';
      surface.style.backgroundImage = '';
      surface.style.backgroundSize = '';
      surface.style.backgroundColor = '';
      surface.classList.remove('wallpaper-active');
    } else {
      if (rainCanvas) rainCanvas.style.display = 'none';
      surface.setAttribute('style', surface.getAttribute('style') || '');
      surface.style.cssText += wp.style;
      surface.classList.add('wallpaper-active');
    }
  }

  // ── Window resize reflow ────────────────────────────────────────────
  window.addEventListener('resize', function () {
    clearTimeout(window._desktopResizeTimer);
    window._desktopResizeTimer = setTimeout(function () {
      render();
    }, 200);
  });

  // ── Init ────────────────────────────────────────────────────────────
  function init() {
    render();
    applyWallpaper(getWallpaper());
    // Re-render icons when entitlements change (live toggle from admin panel)
    if (window.FULCEntitlements) {
      window.FULCEntitlements.onChange(function () { render(); });
    }
  }

  Object.assign(FULCDesktop, { init: init, render: render });
})();
