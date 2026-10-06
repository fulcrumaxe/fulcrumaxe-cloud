// ── fulcrumaxe-os Upgrade Modal ────────────────────────────────────────────────────────
// Reusable dialog shown when a user attempts to access a gated feature.
// Copy is tenant-configurable (task 07 will wire CRDT-backed branding);
// for now it falls back to generic text.
//
// D#893: the `Learn More` CTA pointed at `/upgrade`, which no router served
// — the tenant-plan path dead-ended on a 404 exactly like the server's own
// `upgrade_url` did. It now points at `/api/upgrade`, the page mounted by
// `crates/server/src/routes/upgrade.rs`, which is the same path the 402
// bodies carry. Keep these two in step: `UPGRADE_PATH` in that module is
// the source of truth, and `crates/server/tests/upgrade_url_resolves.rs`
// asserts the server half resolves.
(function () {
  'use strict';

  let _el = null;

  function ensureModal() {
    if (_el) return _el;

    _el = document.createElement('div');
    _el.id = 'fulc-upgrade-modal';
    _el.className = 'fulc-upgrade-modal hidden';
    _el.setAttribute('role', 'dialog');
    _el.setAttribute('aria-modal', 'true');
    _el.setAttribute('aria-labelledby', 'fulc-upgrade-modal-title');

    const backdrop = document.createElement('div');
    backdrop.className = 'fulc-upgrade-modal-backdrop';

    const title = document.createElement('h2');
    title.id = 'fulc-upgrade-modal-title';
    title.className = 'fulc-upgrade-modal-title';
    title.textContent = 'Upgrade Required';

    const body = document.createElement('p');
    body.className = 'fulc-upgrade-modal-body';

    const cta = document.createElement('a');
    cta.className = 'fulc-upgrade-modal-cta';
    cta.href = '/api/upgrade';
    cta.target = '_blank';
    cta.rel = 'noopener';
    cta.textContent = 'Learn More';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'fulc-upgrade-modal-close';
    closeBtn.textContent = 'Close';

    const actions = document.createElement('div');
    actions.className = 'fulc-upgrade-modal-actions';
    actions.append(cta, closeBtn);

    const content = document.createElement('div');
    content.className = 'fulc-upgrade-modal-content';
    content.append(title, body, actions);

    _el.replaceChildren(backdrop, content);

    _el.querySelector('.fulc-upgrade-modal-backdrop')
       .addEventListener('click', () => FULCUpgradeModal.close());
    _el.querySelector('.fulc-upgrade-modal-close')
       .addEventListener('click', () => FULCUpgradeModal.close());

    document.body.appendChild(_el);
    return _el;
  }

  window.FULCUpgradeModal = {
    open({ capability, decision } = {}) {
      const el = ensureModal();
      const body = el.querySelector('.fulc-upgrade-modal-body');
      const cta  = el.querySelector('.fulc-upgrade-modal-cta');

      // D#37 WS-L1: the licence-activation module is not part of cloud
      // (owner ruling) -- this modal's only CTA is the tenant-plan
      // "Learn More" link now. Reset on every open in case a future
      // decision kind ever needs to rewrite it again.
      cta.textContent = 'Learn More';
      cta.setAttribute('href', '/upgrade');
      cta.setAttribute('target', '_blank');
      cta.setAttribute('rel', 'noopener');
      cta.removeAttribute('role');
      cta.onclick = null;

      if (decision?.type === 'UpgradeRequired') {
        body.textContent = decision.prompt ||
          `This feature requires the ${decision.required_plan} plan. Contact your administrator to upgrade.`;
        cta.style.display = '';
      } else {
        body.textContent = 'This feature requires an upgraded plan. Contact your administrator.';
        cta.style.display = 'none';
      }

      el.classList.remove('hidden');
      el.querySelector('.fulc-upgrade-modal-close').focus();
    },

    close() {
      if (_el) _el.classList.add('hidden');
    },
  };

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && _el && !_el.classList.contains('hidden')) {
      FULCUpgradeModal.close();
    }
  });
})();

export {};
