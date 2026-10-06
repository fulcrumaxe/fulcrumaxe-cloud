// ── fulcrumaxe-os Main ────────────────────────────────────────────────────────
// Slim shell: global state, profile fetch, showDesktop.
// Heavy logic moved to core/boot.js, core/overlays.js, core/preferences.js

import { FULCDesktop } from './core/desktop.js';
import { FULCTaskbar } from './core/taskbar.js';
import { FULCWM } from './core/window-manager.js';
// D#37 WS-C2 fix round item 6 (should-fix): window-manager.js persists
// the saved layout under storage-ns.js's fx:<ns>:window-layout key (see
// its own PERSIST_KEY), not the pre-namespacing 'fulc-window-layout'
// this file used to check -- that stale check always read null, so a
// saved layout was never restored (FULCWM.restoreLayout() below never
// ran) since namespacing landed.
import { getItem } from './core/storage-ns.js';
import { markDesktopReady } from './core/boot-metrics.js';

// ── Global State ───────────────────────────────────────────────────

window.currentStep = 'COMMAND';
window.profileData = {};
window.currentSessionUserId = null;
window.currentIsAdmin = false;
window.inputIsEditing = false;

// D#37 Correction C19d, task WS-B1 criterion 2: the owner-ruled values
// (OWNER DECISION, 2026-09-25), not the jpos defaults -- fetchBranding()
// in core/boot.js merges the real /api/branding response over this
// object, but on a failed fetch (network error, bad JSON) the catch
// block leaves this object untouched, so these six values are what the
// boot screen and tab title show. They must equal /api/branding's body
// exactly (apps/web/app/api/branding/route.ts) -- pinned by
// test/branding-defaults.test.mjs -- so a failed fetch is invisible: the
// boot screen never flashes jpos text ("JP OP V.0.1", "Formal Hosting
// LLC", "Jungle We Like Fun And Games", "CONNECTING TO THE CONSTRUCT")
// under any network condition.
window.brandingData = {
  page_title: 'fulcrumaxe',
  product_name: 'fulcrumaxe cloud',
  os_name: 'fulcrumaxe cloud',
  system_tag: 'fulcrumaxe cloud',
  copyright: '© fulcrumaxe',
  welcome_message: 'Welcome to fulcrumaxe cloud.'
};

// ── Profile Fetch ──────────────────────────────────────────────────
// D#37 WS-D criterion 4: "/api/profile is fetched once per page load (not
// per showDesktop)". `profileFetchPromise` makes the actual network call a
// singleton for the lifetime of this page load -- every caller (just
// showDesktop() below today) gets the same in-flight/resolved promise
// instead of triggering a new request. A failed fetch clears the promise
// so a later call can retry, rather than permanently caching a rejection.

let profileFetchPromise = null;

window.fetchProfile = function () {
  if (!profileFetchPromise) {
    profileFetchPromise = (async () => {
      try {
        const res = await fetch('/api/profile');
        const data = await res.json();
        window.profileData = data;
        window.currentSessionUserId = data.id;
        return data;
      } catch (e) {
        console.error('Error fetching profile', e);
        profileFetchPromise = null;
        throw e;
      }
    })();
  }
  return profileFetchPromise;
};

// ── Show Desktop (called after login/signup) ───────────────────────
// D#37 WS-D criterion 6 (the ≤2.0s/≤3.5s returning-signed-in-desktop
// budget): the old fixed 1500ms setTimeout before any of this work even
// started was pure artificial delay -- boot.js's runBoot() has already
// resolved mode + session by the time this is called, so there is nothing
// left to wait on. The 200ms delay before the layout-restore-vs-default-app
// decision is unrelated to that budget (a small, deliberately visible
// "windows appearing" beat) and is left as-is.

window.showDesktop = function (user, isAdmin) {
  window.currentIsAdmin = isAdmin;
  (async () => {
    const terminalShell = document.getElementById('terminal-shell');
    const desktopScreen = document.getElementById('desktop-screen');
    terminalShell.classList.add('hidden');
    desktopScreen.classList.remove('hidden');

    await window.fetchProfile().catch(() => {});
    await window.fetchPreferences();

    window.currentStep = 'DESKTOP';

    if (FULCDesktop) FULCDesktop.init();
    if (FULCTaskbar) {
      FULCTaskbar.setUser(user);
      FULCTaskbar.init();
    }

    // D#37 WS-D criterion 5: the desktop's chrome (taskbar, dock) is up
    // and currentStep is DESKTOP -- this is "desktop-ready" for RUM
    // purposes, independent of whether a window ends up restored or
    // freshly opened below.
    markDesktopReady();

    setTimeout(function () {
      if (!FULCWM) return;
      var hasSaved = !!getItem('window-layout');
      if (hasSaved) {
        FULCWM.restoreLayout();
      } else {
        FULCWM.open('terminal');
      }
    }, 200);
  })();
};

export {};
