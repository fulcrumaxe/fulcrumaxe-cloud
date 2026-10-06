// ── fulcrumaxe-os Preferences ─────────────────────────────────────────────────
// User preferences, avatars, and applyPreferences (global).
// Exposes globals: userPreferences, AVATARS, applyPreferences, fetchPreferences, savePreference
import { FULCTheme } from "./theme-manager.js";
import { FULCEffects } from "./theme-effects.js";
import { readStoredPreferences, storePreference } from "./preferences-store.js";

(function () {
  'use strict';

  window.userPreferences = {
    theme: 'green',
    font_size: 'medium',
    crt_enabled: 'true',
    prompt: '> ',
    avatar: '0',
    timezone: 'UTC'
  };

  window.AVATARS = [
    [' ┌─────┐ ', ' │ > _ │ ', ' │     │ ', ' └─────┘ ', '  TERM   '],
    [' ┌─┤├─┐ ', ' │ O O │ ', ' │ ___ │ ', ' └┤   ├┘ ', '  ROBOT  '],
    ['  ┌───┐  ', '  │O O│  ', '  │ ▼ │  ', '  └┬┬┬┘  ', '  SKULL  '],
    ['  .--.   ', ' | OO|   ', ' |    |  ', ' /VVVV\\  ', '  GHOST  '],
    ['   ___   ', '  |_ _|  ', '  (o.o)  ', '  /| |\\  ', '  AGENT  '],
    ['  (^_^)  ', '  /| |\\  ', '   | |   ', '  / | \\  ', '  BUDDY  '],
    [' [=====] ', ' |~~~~~| ', ' |_____| ', '  |   |  ', ' HACKER  '],
    [' /\\_/\\   ', '( o.o )  ', ' > ^ <   ', '  |||    ', '   CAT   ']
  ];

  window.fetchPreferences = async function () {
    try {
      const res = await fetch('/api/preferences');
      if (!res.ok) return;
      const data = await res.json();
      // Locally-stored values win over the server's response: POST
      // /api/preferences is stub_success today, so the server can only ever
      // echo the hardcoded defaults back and would otherwise clobber every
      // choice the user has made. See core/preferences-store.js.
      window.userPreferences = { ...window.userPreferences, ...data, ...readStoredPreferences() };
      window.applyPreferences();
    } catch (e) {
      console.error('Error fetching preferences', e);
    }
  };

  window.savePreference = async function (key, value) {
    // Persist locally first — this is the store of record. The server's
    // /api/preferences POST is stub_success: it answers {"success":true} and
    // keeps nothing, so trusting its reply is what made every caller report a
    // save that had not happened.
    const persisted = storePreference(key, value);

    // Apply for this session either way. A browser that refuses storage should
    // still get the change it asked for — it just will not survive a reload,
    // which is what the return value below reports. Gating the apply on
    // `persisted` made a private-mode user click the theme and see nothing
    // happen at all, which is a worse answer than "changed, but not saved".
    window.userPreferences[key] = value;
    window.applyPreferences();

    // Still tell the server, best-effort. Harmless today; when a real
    // preferences backend lands this is already wired and becomes the
    // authoritative write.
    try {
      await fetch('/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value })
      });
    } catch (e) {
      console.error('Error syncing preference to server', e);
    }

    // Report what actually happened, not what the stub claimed.
    return persisted;
  };

  window.applyPreferences = function () {
    const prefs = window.userPreferences;

    // Theme — delegate to FULCTheme if available, keeping data-theme for legacy CSS
    if (FULCTheme) {
      if (prefs.experience) {
        FULCTheme.apply(prefs.experience);
      } else if (prefs.theme) {
        FULCTheme.applyLegacy(prefs.theme);
      }
    } else {
      document.body.setAttribute('data-theme', prefs.theme);
    }

    // Font size
    document.body.classList.remove('font-small', 'font-medium', 'font-large');
    document.body.classList.add('font-' + prefs.font_size);

    // CRT effect — delegate to FULCEffects; body.crt-disabled kept as deprecated fallback
    var crtEnabled = prefs.crt_enabled === true || prefs.crt_enabled === 'true';
    if (FULCEffects) {
      FULCEffects.setReducedMotion(!crtEnabled);
    }
    document.body.classList.toggle('crt-disabled', !crtEnabled);

    // Custom prompt — update all cmd-prompt elements
    document.querySelectorAll('.cmd-prompt').forEach(el => {
      el.textContent = prefs.prompt;
    });

    // Rain background color sync (FULCTheme handles this when active)
    if (!FULCTheme && window.updateRainColor) {
      const color = getComputedStyle(document.body).getPropertyValue('--theme-primary').trim();
      window.updateRainColor(color);
    }
  };
})();

export {};
