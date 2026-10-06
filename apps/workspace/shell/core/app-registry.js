// ── fulcrumaxe-os App Registry ────────────────────────────────────────────────
// Central registry for desktop apps. Each app module registers itself here.
// Apps implement: { id, title, icon, adminOnly, defaultSize, onOpen, onClose, onFocus, onResize, onHide, onShow }
// onOpen(contentEl, launchArg): launchArg is undefined unless another app opened this one with
//   FULCWM.open(id, arg); then it is a frozen plain JSON object of at most 1024 characters.
//   It is untrusted data: the receiving app validates each field it reads.
// onLaunch(launchArg): optional. The same call made while the app is ALREADY open: the shell goes to its window and hands
//   it the argument (same rules: frozen plain JSON, at most 1024 characters, untrusted). Without the hook it is ignored.
// onHide() / onShow(): optional. The shell calls them when it hides the window (minimized,
//   another workspace, the phone's one-window view) and when it shows it again.
// Entitlement fields: capability (default: 'app.<id>'), whenDenied ('show-locked' | 'hide')
(function () {
  'use strict';

  const apps = {};
  // D#37 WS-F9a: null means every registered app. Onboarding mode (core/onboarding-mode.js) narrows it to four
  // ids, and every reader below honours it, so no list and no FULCWM.open() can reach another app. One-way.
  let scope = null;
  const inScope = (id) => scope === null || scope.indexOf(id) !== -1;

  // kept on window for MCP devtools reads — see epic-26/08.md keep-list
  window.FULCApps = {
    register(id, app) {
      app.id = id;
      app.capability = app.capability || ('app.' + id);
      app.whenDenied = app.whenDenied || 'show-locked';
      apps[id] = app;
    },

    unregister(id) {
      delete apps[id];
    },

    restrictTo(ids) {
      if (!Array.isArray(ids)) return;
      scope = scope === null ? ids.slice() : scope.filter((id) => ids.indexOf(id) !== -1);
    },

    get(id) {
      return inScope(id) ? apps[id] || null : null;
    },

    all() {
      return Object.values(apps).filter((a) => inScope(a.id));
    },

    ids() {
      return Object.keys(apps).filter(inScope);
    },

    // Returns true when an app with the given id has called register().
    // Use this as the registered gate in catalog-rendering surfaces so
    // apps whose <script> was trimmed (never registered) are hidden entirely.
    isRegistered(id) {
      return inScope(id) && !!apps[id];
    },

    // Returns apps the current user can see (Allow + UpgradeRequired).
    // Falls back to all() if entitlements aren't loaded yet.
    visible() {
      const all = Object.values(apps).filter((a) => inScope(a.id));
      if (!window.FULCEntitlements || !window.FULCEntitlements._ready) return all;
      return all.filter(function (app) {
        const d = window.FULCEntitlements.decision(app.capability);
        if (d.type === 'Deny') return app.whenDenied !== 'hide';
        return true;
      });
    },

    // Returns only apps the user can actually launch (Allow only).
    // Falls back to all() if entitlements aren't loaded yet.
    launchable() {
      const all = Object.values(apps).filter((a) => inScope(a.id));
      if (!window.FULCEntitlements || !window.FULCEntitlements._ready) return all;
      return all.filter(function (app) {
        return window.FULCEntitlements.decision(app.capability).type === 'Allow';
      });
    },
  };
})();

export const FULCApps = window.FULCApps;
