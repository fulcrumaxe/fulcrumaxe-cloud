// ── fulcrumaxe-os Feature Flags ─────────────────────────────────────────────
// D#37 WS-B: single shared reader for the `features` object served by
// /api/mode (presence, liveEntitlements, crdt, messages, updates). Read
// once here and cached -- every consumer (core/presence.js,
// core/entitlements.js, core/taskbar.js, core/tray-update-indicator.js)
// awaits the same cached Promise instead of each issuing its own /api/mode
// request, so gating a feature off never costs the idle-network budget an
// extra request per consumer.
//
// A profile with `features.presence === false` (etc.) is a build-time
// declaration (see profiles/cloud.json) of what the SERVER is expected to
// return at runtime; this module trusts whatever /api/mode actually
// answers, not the profile file itself (the profile isn't shipped to the
// browser).

let cached = null;
let pending = null;

// Every consumer gates on `features.X === false`. A bare `{}` on failure
// means `features.X` is `undefined`, and `undefined === false` is `false`
// -- the gate never fires and the consumer falls through to its
// feature-ENABLED path (opens a socket, starts a poll). That is fail-OPEN,
// the opposite of what a read failure must do. failClosedFeatures() names
// every flag a consumer actually gates on (D#37 WS-B review, PR #100)
// explicitly `false`, so a failed /api/mode read reads as "everything
// gated is disabled" no matter which consumer asks.
function failClosedFeatures() {
  return { presence: false, liveEntitlements: false, messages: false, updates: false };
}

function fetchFeatures() {
  return fetch('/api/mode')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { return (d && d.features) ? d.features : failClosedFeatures(); })
    .catch(function () { return failClosedFeatures(); });
}

// Returns a Promise<object> resolving to the features map. Safe to call
// from multiple modules and multiple times -- only the first call issues a
// request.
export function getFeatures() {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = fetchFeatures().then(function (f) {
      cached = f;
      pending = null;
      return f;
    });
  }
  return pending;
}

export const FULCFeatures = { get: getFeatures };

// Exposed on window for MCP devtools / debug dumps, matching the
// window.FULC_MODE / window.FULC_PROFILE pattern in core/boot.js.
if (typeof window !== 'undefined') {
  window.FULCFeatures = FULCFeatures;
}
