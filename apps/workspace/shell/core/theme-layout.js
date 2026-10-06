// ── fulcrumaxe-os Layout System ───────────────────────────────────────────────────
// Handles shell layout layer: taskbar position/style and window chrome.
// Called by FULCTheme._applyLayout(layoutConfig).
// Exposes: window.FULCLayout
//
// D#37 WS-C2 criterion 11: persisted under storage-ns.js's fx:<ns>:
// namespace, not a raw localStorage key. The restore below used to run
// synchronously at parse time, before a session (and therefore a
// namespace) can possibly exist — onNamespaceReady() defers it instead
// of reading (and finding nothing under) an unnamespaced key.
import { getItem, setItem, onNamespaceReady } from "./storage-ns.js";

(function () {
  'use strict';

  var PERSIST_KEY = 'layout-config';

  var _current = {
    'taskbar-position': 'bottom',
    'taskbar-style':    'bar',
    'window-chrome':    'classic'
  };

  function apply(cfg) {
    if (!cfg) return;
    _current = {
      'taskbar-position': cfg['taskbar-position'] || 'bottom',
      'taskbar-style':    cfg['taskbar-style']    || 'bar',
      'window-chrome':    cfg['window-chrome']    || 'classic'
    };

    var b = document.body;
    b.dataset.taskbarPosition = _current['taskbar-position'];
    b.dataset.taskbarStyle    = _current['taskbar-style'];
    b.dataset.windowChrome    = _current['window-chrome'];

    setItem(PERSIST_KEY, JSON.stringify(_current));

    document.dispatchEvent(new CustomEvent('fulc-layout-change', { detail: _current }));
  }

  function current() {
    return Object.assign({}, _current);
  }

  function getWorkArea() {
    var tb = document.getElementById('taskbar');
    var pos   = document.body.dataset.taskbarPosition || 'bottom';
    var style = document.body.dataset.taskbarStyle    || 'bar';
    var hidden = style === 'hidden';
    var size = 0;
    if (!hidden && tb) {
      size = (pos === 'left' || pos === 'right') ? tb.offsetWidth : tb.offsetHeight;
    }
    return {
      top:    pos === 'top'    ? size : 0,
      left:   pos === 'left'  ? size : 0,
      right:  pos === 'right' ? size : 0,
      bottom: pos === 'bottom' ? size : 0
    };
  }

  // Restore persisted layout as soon as a storage namespace exists —
  // before sign-in there is nothing to restore under (no namespace), so
  // this can't run any earlier than boot.js's setNamespace() call.
  onNamespaceReady(function _restore() {
    try {
      var raw = getItem(PERSIST_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      var b = document.body;
      if (saved['taskbar-position']) b.dataset.taskbarPosition = saved['taskbar-position'];
      if (saved['taskbar-style'])    b.dataset.taskbarStyle    = saved['taskbar-style'];
      if (saved['window-chrome'])    b.dataset.windowChrome    = saved['window-chrome'];
      _current = Object.assign(_current, saved);
    } catch (e) {}
  });

  function applyAppToolbarPlacement(appEl, placement) {
    if (!appEl) return;
    var p = placement || 'top';
    appEl.dataset.toolbarPlacement = p;
    if (p === 'floating' || p === 'collapsed') {
      _ensureToolbarToggle(appEl);
    } else {
      // Remove toggle button if switching away from floating/collapsed
      var existing = appEl.querySelector('[data-toolbar-toggle]');
      if (existing) existing.remove();
    }
  }

  function _ensureToolbarToggle(appEl) {
    if (appEl.querySelector('[data-toolbar-toggle]')) return;
    var tb = appEl.querySelector('[data-zone="toolbar"]');
    var contentZone = appEl.querySelector('[data-zone="content"]');
    if (!contentZone) return;
    var btn = document.createElement('button');
    btn.dataset.toolbarToggle = '';
    btn.className = 'toolbar-toggle-btn';
    btn.textContent = '≡';
    btn.addEventListener('click', function () {
      if (tb) tb.classList.toggle('revealed');
    });
    contentZone.prepend(btn);
  }

  // kept on window for MCP devtools reads — see epic-26/08.md keep-list
  window.FULCLayout = {
    apply:                    apply,
    current:                  current,
    getWorkArea:              getWorkArea,
    applyAppToolbarPlacement: applyAppToolbarPlacement
  };
})();

export const FULCLayout = window.FULCLayout;
