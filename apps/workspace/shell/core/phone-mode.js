// ── fulcrumaxe-os Phone / Tablet Mode ──────────────────────────────────────
// D#37 WS-E: single source of truth for "is this a phone" / "is this a
// tablet" so window-manager, desktop, taskbar, hot-corners, rain.js and
// theme-effects.js all branch on the same signal instead of each re-deriving
// it from matchMedia.
//
// Phone  (owner decision 3): (pointer: coarse) and (max-width: 600px).
// Tablet (owner decision 3): (pointer: coarse) and (min-width: 601px) --
//   tablets keep windowing with pointer events; only phones get the
//   one-maximized-window-plus-switcher model.
//
// Also toggles `html.fulc-phone-mode` / `html.fulc-tablet-mode` so CSS can
// react without every stylesheet re-deriving the same media query.
export const FULCPhoneMode = {};
(function () {
  'use strict';

  // Falls back to an always-false stub where matchMedia doesn't exist --
  // this file loads (transitively, via window-manager.js/taskbar.js/etc.)
  // in a couple of non-browser unit-test harnesses that stub out just
  // enough DOM surface to run those specific modules, not the full
  // platform. "Never phone/tablet there" is the correct fallback: those
  // tests exercise desktop-only behavior.
  function _mq(query) {
    if (typeof window.matchMedia === 'function') return window.matchMedia(query);
    return { matches: false, addEventListener: function () {}, addListener: function () {} };
  }

  var phoneMq = _mq('(pointer: coarse) and (max-width: 600px)');
  var tabletMq = _mq('(pointer: coarse) and (min-width: 601px)');
  var listeners = [];

  function applyClasses() {
    var root = document.documentElement;
    if (!root || !root.classList) return;
    root.classList.toggle('fulc-phone-mode', phoneMq.matches);
    root.classList.toggle('fulc-tablet-mode', tabletMq.matches);
  }

  function notify() {
    applyClasses();
    var state = { phone: phoneMq.matches, tablet: tabletMq.matches };
    listeners.forEach(function (cb) {
      try { cb(state); } catch (e) { /* one bad listener must not break the rest */ }
    });
  }

  // Safari < 14 exposes only the legacy addListener on MediaQueryList.
  // Both branches are reachable in this codebase's supported targets
  // (current Chromium via Playwright, current WebKit), so both are kept.
  function bindChange(mq) {
    if (mq.addEventListener) mq.addEventListener('change', notify);
    else if (mq.addListener) mq.addListener(notify);
  }
  bindChange(phoneMq);
  bindChange(tabletMq);

  applyClasses();

  Object.assign(FULCPhoneMode, {
    isPhone: function () { return phoneMq.matches; },
    isTablet: function () { return tabletMq.matches; },
    isCoarse: function () { return phoneMq.matches || tabletMq.matches; },
    // Registers cb(state) to run on every phone/tablet transition. Does not
    // fire immediately -- callers that need the current value call isPhone()
    // / isTablet() directly first.
    onChange: function (cb) { listeners.push(cb); }
  });
})();

window.FULCPhoneMode = FULCPhoneMode;
