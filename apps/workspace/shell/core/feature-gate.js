// ── fulcrumaxe-os Feature Gate ─────────────────────────────────────────────────────────
// DOM helpers for entitlement-based UI gating.
// Reads decisions from window.FULCEntitlements (must be initialised first).
(function () {
  'use strict';

  window.FULCFeatureGate = {

    // ── Public API ─────────────────────────────────────────────────────

    // Apply gating to an element. `mode` controls the treatment of denied access:
    //   'overlay'  (default) — dim + lock-icon overlay, click opens upgrade modal
    //   'disable'  — sets disabled + aria-disabled
    //   'hide'     — sets hidden
    gate(el, cap, { mode = 'overlay' } = {}) {
      const d = FULCEntitlements.decision(cap);
      if (d.type === 'Allow') return;

      el.setAttribute('data-entitlement-gated', cap);

      if (mode === 'hide') {
        el.hidden = true;
      } else if (mode === 'disable') {
        el.disabled = true;
        el.setAttribute('aria-disabled', 'true');
        el.title = this._tooltip(d);
      } else {
        this._applyOverlay(el, cap, d);
      }
    },

    // Attach hover-tooltip and data attribute without blocking interaction.
    decorate(el, cap) {
      el.setAttribute('data-entitlement-gated', cap);
      el.addEventListener('mouseenter', () => {
        const d = FULCEntitlements.decision(cap);
        if (d.type !== 'Allow') el.title = this._tooltip(d);
      });
    },

    // Returns a click handler that intercepts denied launches and opens the
    // upgrade modal instead of calling the original handler.
    wrapLauncher(handler, cap) {
      return (ev) => {
        const d = FULCEntitlements.decision(cap);
        if (d.type === 'Allow') return handler(ev);
        FULCUpgradeModal.open({ capability: cap, decision: d });
        ev.preventDefault?.();
      };
    },

    // ── Internal ───────────────────────────────────────────────────────

    _applyOverlay(el, cap, decision) {
      // Ensure the host element can position the overlay absolutely.
      const pos = getComputedStyle(el).position;
      if (pos === 'static') el.style.position = 'relative';

      const overlay = document.createElement('div');
      overlay.className = 'fulc-entitlement-overlay';
      overlay.setAttribute('role', 'button');
      overlay.setAttribute('tabindex', '0');
      overlay.setAttribute('aria-label', 'Feature requires upgrade — click to learn more');
      overlay.setAttribute('data-cap', cap);
      overlay.title = this._tooltip(decision);

      const icon = document.createElement('span');
      icon.className = 'fulc-lock-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '🔒';
      overlay.appendChild(icon);

      const open = (ev) => {
        FULCUpgradeModal.open({ capability: cap, decision });
        ev.stopPropagation();
      };
      overlay.addEventListener('click', open);
      overlay.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') open(ev);
      });

      el.appendChild(overlay);
    },

    _tooltip(decision) {
      if (decision.type === 'UpgradeRequired') {
        const suffix = decision.prompt ? ` ${decision.prompt}` : '';
        return `Requires ${decision.required_plan} plan.${suffix}`.trim();
      }
      if (decision.type === 'Deny') return decision.reason || 'Access denied';
      return '';
    },
  };
})();

export {};
