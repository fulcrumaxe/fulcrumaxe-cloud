// ── fulcrumaxe-os Window Switcher (phone Exposé replacement) ──────────────
// D#37 WS-E criterion 2: on phones, Exposé's live-window tiling is replaced
// by a static list of icons and titles. This module never touches a real
// `.fulc-window` element and never applies a `transform` to one -- it reads
// only FULCWM's public, already-exposed state (getOpen()) and calls back
// into FULCWM.focus() when a row is picked. That keeps "no live window DOM,
// no transform scaling" true by construction rather than by convention.
export const FULCWindowSwitcher = {};
(function () {
  'use strict';

  var overlay = null;

  function isOpenNow() {
    return !!overlay;
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  function close() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.removeEventListener('keydown', onKeyDown, true);
  }

  function pick(appId) {
    close();
    if (window.FULCWM) window.FULCWM.focus(appId);
  }

  function open() {
    if (overlay || !window.FULCWM) return;
    var wins = window.FULCWM.getOpen().filter(function (w) { return w.state !== 'minimized'; });
    if (wins.length === 0) return;

    overlay = document.createElement('div');
    overlay.className = 'wm-switcher-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Open windows');

    var list = document.createElement('div');
    list.className = 'wm-switcher-list';

    wins.forEach(function (w) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'wm-switcher-row';
      row.dataset.appId = w.id;

      var icon = document.createElement('span');
      icon.className = 'wm-switcher-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = (w.app && w.app.icon) || w.id.substring(0, 2).toUpperCase();

      var title = document.createElement('span');
      title.className = 'wm-switcher-title';
      title.textContent = w.customTitle || (w.app && (w.app.title || w.app.label)) || w.id.toUpperCase();

      row.append(icon, title);
      row.addEventListener('click', function () { pick(w.id); });
      list.appendChild(row);
    });

    overlay.appendChild(list);
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) close();
    });
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeyDown, true);

    var first = list.querySelector('.wm-switcher-row');
    if (first) first.focus();
  }

  Object.assign(FULCWindowSwitcher, {
    open: open,
    close: close,
    isOpen: isOpenNow,
    pick: pick
  });
})();

window.FULCWindowSwitcher = FULCWindowSwitcher;
