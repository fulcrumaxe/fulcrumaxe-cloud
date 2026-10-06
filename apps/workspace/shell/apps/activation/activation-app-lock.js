// fulcrumaxe-os licence capability lock (epic-15 task 04; rewritten for D#888).
//
// WHAT THIS DOES NOW
//
// While the local licence state is `missing` or `expired`, the capabilities in
// LICENCE_GATED_CAPABILITIES resolve to `UpgradeRequired` regardless of what
// the entitlement chain says. Everything else — every `app.*` in the catalog —
// resolves normally, so an unlicensed box boots to a working desktop.
//
// WHY THE LIST SHRANK (D#888)
//
// This file used to lock **every `app.*` capability** and additionally patch
// `FULCWM.open` / `FULCWM.restoreLayout` so no window could open at all. That
// predates server-side licence enforcement. It meant a fresh AGPL download —
// no `license.json`, `/api/license/status` = `missing` — booted into an
// activation card with a dead desktop behind it. The free build was broken on
// first contact.
//
// The server is the authority and it is deliberately narrow. The list below is
// a **mirror of `LICENSED_CAPABILITIES`** in
// `crates/server/src/middleware/license_gate.rs`, whose own doc comment
// explains the rule: gate the capabilities that spend real money, and nothing
// else, because "an enforcement layer that locks out paying users is worse
// than the hole it closes". `api.cloud-manage.read` is intentionally absent
// there and is intentionally absent here.
//
// KEEP THE TWO LISTS IN SYNC. `scripts/tests/test-licence-lock-scope.sh` pins
// them against each other and fails if either side drifts — including if this
// file grows back an `app.` prefix match.
//
// This remains a **presentation** concern, not a security control. The
// enforcement is the 402 the server returns; this exists so the UI prompts at
// the point of use instead of letting the click fail with a raw error.

(function () {
  'use strict';

  // Mirror of crates/server/src/middleware/license_gate.rs LICENSED_CAPABILITIES.
  // Trailing `*` is a prefix match anchored at the segment boundary, matching
  // `CapabilityPattern::matches` in crates/entitlements/src/capability.rs.
  const LICENCE_GATED_CAPABILITIES = [
    'api.cloud-deploy.*',
    'api.cloud-manage.write',
  ];

  function matchesPattern(pattern, cap) {
    if (pattern.endsWith('*')) return cap.startsWith(pattern.slice(0, -1));
    return cap === pattern;
  }

  function requiresLicence(cap) {
    return LICENCE_GATED_CAPABILITIES.some((p) => matchesPattern(p, cap));
  }

  function isLockedState() {
    const s = window.FULCLicense && window.FULCLicense.state;
    return s === 'missing' || s === 'expired';
  }

  function lockedDecision() {
    const s = (window.FULCLicense && window.FULCLicense.state) || 'missing';
    return {
      type: 'UpgradeRequired',
      required_plan: 'licensed',
      prompt:
        s === 'expired'
          ? 'Your fulcrumaxe-os licence has expired. Renew it to deploy and manage cloud infrastructure.'
          : 'Cloud deployment and management need a fulcrumaxe-os licence. The rest of fulcrumaxe-os is free.',
    };
  }

  function patch() {
    if (!window.FULCEntitlements) {
      // entitlements.js loads after this script — wait one tick.
      setTimeout(patch, 0);
      return;
    }
    if (window.FULCEntitlements._licenseLockPatched) return;

    const original = window.FULCEntitlements.decision.bind(window.FULCEntitlements);
    window.FULCEntitlements.decision = function (cap) {
      if (typeof cap === 'string' && requiresLicence(cap) && isLockedState()) {
        return lockedDecision();
      }
      return original(cap);
    };
    window.FULCEntitlements._licenseLockPatched = true;

    // When the licence state flips, fan out to entitlement listeners so any
    // surface showing a cloud action re-renders without a reload. Nothing is
    // closed and nothing is prevented from opening — see the header.
    document.addEventListener('fulc:license-state-changed', function () {
      const e = window.FULCEntitlements;
      if (!e || !Array.isArray(e._listeners)) return;
      for (const cb of e._listeners) {
        try {
          cb(e._decisions);
        } catch (err) {
          console.error('[license-lock] entitlement listener threw:', err);
        }
      }
    });
  }

  window.FULCLicenseLock = {
    isLocked: isLockedState,
    requiresLicence: requiresLicence,
    gatedCapabilities: LICENCE_GATED_CAPABILITIES.slice(),
  };

  patch();
})();
