// D#37 WS-D criterion 2: conditionally preloads /api/cloud/auth/me from as
// early in <head> as a classic, blocking <script> tag can run -- a
// signed-out visitor never gets this preload at all, which is what keeps
// WS-C criterion 15's "zero console errors" true for a fresh, anonymous
// visit (a preloaded request that 401s logs a console error regardless of
// what JS does with the response; there is no way to suppress that once
// the request is made). Same fx_has_session hint, same reasoning, as
// core/boot.js's own checkCloudSession()/hasSessionHint() -- applied one
// layer earlier here, because a static HTML <link> tag can't consult a
// cookie at all, so index.html can't just add a fourth unconditional
// <link rel="preload"> the way it does for mode/system-mode/branding
// (always-200, anonymous, static JSON -- see index.html's own comment).
//
// A classic (non-module) script, not deferred, so it runs synchronously as
// the parser reaches it -- before any of the stylesheet <link> tags after
// it in index.html, and well before boot.js (a deferred module script)
// ever starts. Uses createElement + property assignment (no innerHTML,
// no template string), consistent with every other DOM-builder in this
// fork under the enforced Trusted Types policy.
(function () {
  'use strict';
  try {
    if (document.cookie.indexOf('fx_has_session=1') === -1) return;
    var link = document.createElement('link');
    link.rel = 'preload';
    link.href = '/api/cloud/auth/me';
    link.as = 'fetch';
    link.crossOrigin = 'use-credentials';
    document.head.appendChild(link);
  } catch (e) {
    // No cookie access (unexpected) -- core/boot.js's own real
    // checkCloudSession() call still runs regardless of this hint.
  }
})();
