// ── fulcrumaxe-os Theme Manager ────────────────────────────────────────────────
// Loads experience JSON definitions, applies all layers to the live DOM,
// and broadcasts change events. Hub for all epic-25 theming.
import { FULCEffects } from "./theme-effects.js";
import { FULCLayout } from "./theme-layout.js";
import { readStoredPreferences, storePreference } from "./preferences-store.js";
import { getNamespace } from "./storage-ns.js";

export const FULCTheme = {};
(function () {
  'use strict';

  var _experiences = {};
  var _current = null;
  var _initPromise = null;
  var _loadedFonts = new Set();

  var TYPOGRAPHY_PACKS = {
    'terminal': {
      fontLoader: null
    },
    'modern-sans': {
      fontLoader: 'inter'
    },
    'share-tech': {
      fontLoader: 'share-tech-mono'
    },
    'jetbrains': {
      fontLoader: 'jetbrains-mono'
    },
    'compact': {
      fontLoader: null
    }
  };

  var FONT_MAP = {
    'inter': [
      { family: 'Inter', weight: '400', file: 'fonts/Inter-Regular.woff2' },
      { family: 'Inter', weight: '500', file: 'fonts/Inter-Medium.woff2' }
    ],
    'share-tech-mono': [
      { family: 'Share Tech Mono', weight: '400', file: 'fonts/ShareTechMono-Regular.woff2' }
    ],
    'jetbrains-mono': [
      { family: 'JetBrains Mono', weight: '400', file: 'fonts/JetBrainsMono-Regular.woff2' }
    ]
  };

  function _loadFont(packId) {
    if (!packId) return Promise.resolve();
    if (_loadedFonts.has(packId)) return Promise.resolve();
    var fonts = FONT_MAP[packId];
    if (!fonts) return Promise.resolve();
    return Promise.all(fonts.map(function(f) {
      var face = new FontFace(f.family, 'url(' + f.file + ')', { weight: f.weight });
      return face.load().then(function(loaded) { document.fonts.add(loaded); });
    })).then(function() { _loadedFonts.add(packId); });
  }

  // Legacy data-theme → experience-id map for backwards compat
  var LEGACY_THEME_MAP = {
    'green':  'classic-crt',
    'amber':  'retro-amber',
    'blue':   'nord',
    'white':  'corporate',
    'red':    'cyberpunk'
  };

  // Token overrides for legacy themes that don't map 1:1 to a built-in experience
  var LEGACY_OVERRIDES = {
    'white': {
      'accent': '#E0E0E0', 'accent-bright': '#FFFFFF', 'accent-rgb': '224, 224, 224',
      'text-primary': '#E0E0E0', 'text-secondary': 'rgba(224,224,224,0.7)',
      'text-muted': 'rgba(224,224,224,0.4)', 'border': 'rgba(224,224,224,0.3)',
      'border-bright': 'rgba(224,224,224,0.8)',
      'glow-accent': '0 0 8px rgba(224,224,224,0.4)', 'glow-bright': '0 0 12px rgba(224,224,224,0.6)'
    },
    'red': {
      'accent': '#FF4141', 'accent-bright': '#FF6B6B', 'accent-rgb': '255, 65, 65',
      'text-primary': '#FF4141', 'text-secondary': 'rgba(255,65,65,0.7)',
      'text-muted': 'rgba(255,65,65,0.4)', 'border': 'rgba(255,65,65,0.3)',
      'border-bright': 'rgba(255,65,65,0.8)',
      'glow-accent': '0 0 8px rgba(255,65,65,0.6)', 'glow-bright': '0 0 16px rgba(255,65,65,0.9)'
    }
  };

  // D#37 WS-TH1 fix round 1 (owner ruling 2026-09-25): Aero+ (windows-aero)
  // and Yaru+ (ubuntu-gnome) are not fully worked and do not ship. Their
  // JSON stays in core/themes/ (jpos parity, never fetched or shipped --
  // see build.mjs's profile.excluded_themes filter) so nothing here ever
  // tries to load them; a stored preference naming either one simply finds
  // no match in `_experiences` below and falls back to the default start
  // id, with no error.
  //
  // D#37 WS-D criterion 8 (OPEN OWNER DECISION 2): "macos-sonoma" and
  // "windows-fluent" (formerly Cupertino+/Fluent+) are renamed to
  // "orchard"/"crystal" -- the same ids WS-TH1's heritage adapters already
  // use for these two themes (each theme JSON's own "heritage-adapter"
  // field), so the theme id and the heritage experience it activates now
  // read the same. This is the "one constant" a rename only has to touch.
  var THEME_IDS = [
    'classic-crt', 'cyberpunk', 'modern-flat', 'nord', 'retro-amber', 'corporate',
    'orchard', 'crystal'
  ];

  // D#37 WS-D criterion 7 (OPEN OWNER DECISION 1): the literal value below
  // is replaced at build time by build.mjs's injectDefaultTheme step, from
  // the active profile's `default_theme` field (profiles/cloud.json) --
  // "An override changes only the theme id in
  // apps/workspace/profiles/cloud.json" holds because this is the ONLY
  // place that literal is read from once built; changing the JSON field is
  // the whole override. Never edit this literal directly -- a source-tree
  // build (not going through build.mjs) simply keeps this default.
  var DEFAULT_THEME_ID = "classic-crt"; // build.mjs:injectDefaultTheme substitutes this literal

  function _applyTokens(tokens) {
    var root = document.documentElement;
    for (var key in tokens) {
      if (Object.prototype.hasOwnProperty.call(tokens, key)) {
        root.style.setProperty('--' + key, tokens[key]);
      }
    }
    // Legacy aliases for code still using --theme-primary / --theme-bright / --theme-rgb
    root.style.setProperty('--theme-primary', tokens['accent'] || '');
    root.style.setProperty('--theme-bright',  tokens['accent-bright'] || '');
    root.style.setProperty('--theme-rgb',     tokens['accent-rgb'] || '');
  }

  function _applyEffects(tokens) {
    if (FULCEffects && typeof FULCEffects.apply === 'function') {
      FULCEffects.apply(tokens);
    }
  }

  function _applyLayout(layoutConfig) {
    if (FULCLayout && typeof FULCLayout.apply === 'function') {
      FULCLayout.apply(layoutConfig);
    }
  }

  function _applyData(dataConfig) {
    // Set density as a body data attribute for CSS consumption
    document.body.dataset.density = dataConfig.density || 'comfortable';
    document.dispatchEvent(new CustomEvent('fulc-data-config', { detail: dataConfig }));
  }

  function _syncRain() {
    if (window.updateRainColor) {
      var color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      window.updateRainColor(color);
    }
  }

  async function _doInit() {
    var loaded = await Promise.allSettled(
      THEME_IDS.map(function (tid) {
        return fetch('core/themes/' + tid + '.json').then(function (r) { return r.json(); });
      })
    );

    loaded.forEach(function (result, i) {
      if (result.status === 'fulfilled') {
        var exp = result.value;
        _experiences[exp.id || THEME_IDS[i]] = exp;
      } else {
        console.warn('FULCTheme: failed to load', THEME_IDS[i], result.reason);
      }
    });

    // Determine starting experience from preferences.
    //
    // D#37 WS-C2 fix round 3 (criterion 15, console-error elimination):
    // this runs at script load, long before boot.js's own session check
    // resolves (that's the whole point -- "themes will be ready before
    // fetchPreferences fires", below) -- so `getNamespace()` is always
    // null here regardless of whether the visitor actually has a valid
    // session, and GET /api/preferences unauthenticated can only ever
    // 401 (shell-session routes require a session -- criterion 4). Skip
    // it; the locally-stored choice below already wins over the server
    // response when both exist, and preferences.js's own fetchPreferences()
    // (called from showDesktop(), properly gated on a confirmed signed-in
    // session) is the real post-auth sync path this would otherwise
    // duplicate for no benefit.
    var startId = DEFAULT_THEME_ID;
    if (getNamespace()) {
      try {
        var res = await fetch('/api/preferences');
        if (res.ok) {
          var prefs = await res.json();
          if (prefs.experience && _experiences[prefs.experience]) {
            startId = prefs.experience;
          } else if (prefs.theme && LEGACY_THEME_MAP[prefs.theme]) {
            startId = LEGACY_THEME_MAP[prefs.theme];
          }
        }
      } catch (e) { /* use default */ }
    }

    // The locally-stored choice wins. GET /api/preferences can only return the
    // hardcoded defaults (its POST is stub_success and keeps nothing), so
    // without this the user's theme silently reverted to classic-crt on every
    // reload while the picker reported the change had been saved.
    var stored = readStoredPreferences();
    if (stored.experience && _experiences[stored.experience]) {
      startId = stored.experience;
    } else if (stored.theme && LEGACY_THEME_MAP[stored.theme]) {
      startId = LEGACY_THEME_MAP[stored.theme];
    }

    await _applyExperience(startId);
  }

  async function _applyExperience(id) {
    var exp = _experiences[id];
    if (!exp) {
      console.warn('FULCTheme: unknown experience', id);
      return;
    }

    var previous = _current;
    _current = exp;

    var pack = TYPOGRAPHY_PACKS[exp.typography || 'terminal'];
    await _loadFont(pack ? pack.fontLoader : null);

    _applyTokens(exp.tokens);
    _applyEffects(exp.tokens);
    document.body.dataset.experience = id;
    // D#37 WS-TH1 fix round 1 (PR #163 review, blocking item 1, follow-on
    // fix): this used to also set body[data-theme] to the experience's
    // legacy-mapped name (e.g. "white" for corporate) so style.css's four
    // legacy accent blocks stayed in sync. That backfired two ways, both
    // confirmed live:
    //   (a) three of those four blocks' hardcoded colors do NOT match
    //       their own experience's theme JSON (nord's JSON accent is
    //       #88c0d0 vs the "blue" block's #00D4FF; cyberpunk's is #FF006E
    //       vs "red"'s #FF4141; corporate's is #3b82f6 vs "white"'s
    //       #E0E0E0) -- style.css's body-level rule always wins over the
    //       accent this function just applied to <html> via _applyTokens,
    //       for the SAME experience, not just a stale one. Cyberpunk ->
    //       Cupertino+ -> Corporate showed #E0E0E0, never #3b82f6, no
    //       matter how the CSS block below is keyed.
    //   (b) even where the colors DO match (retro-amber), leaving
    //       data-theme set here is what let a HERITAGE adapter's
    //       restoreDataTheme() (orchard-adapter.js/crystal-adapter.js)
    //       write a stale value back after a later switch -- the original
    //       leak this fix round exists to close.
    // grep confirms body[data-theme=...] is read ONLY by style.css's four
    // legacy blocks and the two heritage adapters' own save/restore
    // bookkeeping -- nothing else in the shell depends on it being set
    // here. applyLegacy() below (the actual backward-compat entry point
    // for an old bare "amber"/"blue"/"white"/"red" stored preference)
    // still sets body[data-theme] itself, explicitly, in both its
    // branches -- this file's normal, modern apply()/gallery path no
    // longer needs to duplicate that.

    _applyLayout(exp.layout || {});
    _applyData(exp.data || {});
    _syncRain();

    document.dispatchEvent(new CustomEvent('fulc-theme-change', {
      detail: { previous: previous, current: exp, layer: 'all' }
    }));

    // Persist. localStorage is the store of record — the POST below is
    // best-effort and becomes authoritative only once a real preferences
    // backend replaces stub_success.
    // Act on the result, the same way preferences.js does. Ignoring it here
    // while honouring it there is the asymmetry that let the original defect
    // hide: one path knew the write had failed and the other assumed success.
    if (!storePreference('experience', id)) {
      console.warn('FULCTheme: could not persist experience "' + id + '" — ' +
                   'it will revert on reload (browser storage unavailable).');
    }
    // D#37 WS-C2 fix round 3 (criterion 15, console-error elimination):
    // same reasoning as the GET above -- without a confirmed session,
    // POST /api/preferences can only 401 (and nothing server-side would
    // keep it either way; localStorage above is already the store of
    // record). `_applyExperience` runs both at boot (pre-auth, where
    // this guard now skips the request) and from a later, explicit,
    // always-post-auth theme change (Themes app, only reachable once
    // signed in) -- `getNamespace()` is non-null in that second case,
    // so the POST still fires exactly as before for every real change.
    //
    // The response body is read (and discarded) rather than left
    // unconsumed: confirmed by direct reproduction against a real
    // apps/web server that when the body is never drained, Chromium can
    // report the request as `net::ERR_ABORTED` at the network layer
    // (visible to Playwright's `requestfailed`/`response` listeners)
    // even though this `fetch()` call itself already resolved
    // successfully -- the request had genuinely succeeded; only the
    // unread body made the browser's own network-layer bookkeeping
    // disagree with what the page saw.
    if (getNamespace()) {
      try {
        const persistRes = await fetch('/api/preferences', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ experience: id })
        });
        await persistRes.text();
      } catch (e) {
        console.warn('FULCTheme: failed to persist experience', e);
      }
    }
  }

  // Public: init — idempotent, returns same promise on repeated calls
  function init() {
    if (!_initPromise) _initPromise = _doInit();
    return _initPromise;
  }

  // Public: apply — waits for init if themes not yet loaded
  async function apply(id) {
    if (!_initPromise) init();
    await _initPromise;
    await _applyExperience(id);
  }

  // Public: apply a legacy data-theme name
  async function applyLegacy(themeId) {
    if (!_initPromise) init();
    await _initPromise;

    var expId = LEGACY_THEME_MAP[themeId] || 'classic-crt';
    var override = LEGACY_OVERRIDES[themeId];

    if (override && _experiences[expId]) {
      var tokens = Object.assign({}, _experiences[expId].tokens, override);
      var exp = Object.assign({}, _experiences[expId], { tokens: tokens });
      var previous = _current;
      _current = exp;
      _applyTokens(tokens);
      _applyEffects(tokens);
      document.body.dataset.experience = expId;
      document.body.setAttribute('data-theme', themeId);
      _applyLayout(exp.layout || {});
      _applyData(exp.data || {});
      _syncRain();
      document.dispatchEvent(new CustomEvent('fulc-theme-change', {
        detail: { previous: previous, current: exp, layer: 'all' }
      }));
    } else {
      await _applyExperience(expId);
      document.body.setAttribute('data-theme', themeId);
    }
  }

  function current() {
    return _current;
  }

  function list() {
    return Object.values(_experiences);
  }

  function onChange(callback) {
    document.addEventListener('fulc-theme-change', function (e) {
      callback(e.detail);
    });
  }

  function register(exp) {
    if (!exp || !exp.id) { console.warn('FULCTheme.register: experience must have an id'); return; }
    _experiences[exp.id] = exp;
  }

  Object.assign(FULCTheme, {
    init: init,
    apply: apply,
    applyLegacy: applyLegacy,
    current: current,
    list: list,
    onChange: onChange,
    register: register,
    _applyTokens: _applyTokens,
    _applyLayout: _applyLayout,
    _applyData: _applyData,
    _applyEffects: _applyEffects
  });

  // Auto-initialize at script load — themes will be ready before fetchPreferences fires
  init();
})();
