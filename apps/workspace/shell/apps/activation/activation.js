// fulcrumaxe-os licence activation overlay (epic-15 task 02; visibility reworked for D#888).
//
// Checks /api/license/status at boot, publishes the state on
// `window.FULCLicense.state` and `body[data-fulc-license-state]`, and posts
// the form to /api/license/activate on submit.
//
// D#888 — WHEN THE CARD IS SHOWN. It used to be painted whenever the state was
// `missing`, i.e. on every fresh AGPL download, which is the one case where it
// is wrong: the server only licence-gates `api.cloud-deploy.*` and
// `api.cloud-manage.write` (crates/server/src/middleware/license_gate.rs), so
// an unlicensed box is a supported configuration with a fully working desktop,
// not an error state. Now:
//
//   missing  -> dismissible banner offering activation; no card, nothing locked
//   expired  -> card (they had a licence and it lapsed) + closable
//   grace    -> banner with "Refresh now", as before
//   valid    -> nothing
//
// A surface whose entire app set IS the paid cloud surface can opt back into
// the old prompt-at-the-door behaviour by putting `data-fulc-activation-auto`
// on its `<body>`; mobile.html does exactly that.

(function () {
  'use strict';

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else if (k === 'style') node.setAttribute('style', v);
        else if (k.startsWith('on') && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else {
          node.setAttribute(k, v);
        }
      }
    }
    if (children) {
      for (const c of children) {
        if (c == null) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  // D#915: the copy has to say what the licence actually gates (see the header
  // and activation-app-lock.js) — the desktop is free; a licence adds cloud
  // deployment and management, automatic updates and priority triage. An
  // expired licence pauses those, not the desktop.
  const COPY_MISSING =
    'fulcrumaxe-os is free to use on this machine — every app works without a license. ' +
    'A license adds cloud deployment and cloud management, automatic updates and ' +
    'priority triage. Paste your license key below, or open the pricing page to get one.';
  const COPY_EXPIRED =
    'Your license has expired. The desktop and every app keep working; cloud ' +
    'deployment and cloud management are paused until you renew, along with ' +
    'automatic updates and priority triage. Paste a new license key below, or ' +
    'open the pricing page to renew.';

  function renderOverlay() {
    const errorLine = el('div', { class: 'error-line', id: 'license-error' });
    const heading = el('h1', { id: 'license-heading' }, ['fulcrumaxe-os — Activate license']);
    const body = el('p', { id: 'license-body' }, [COPY_MISSING]);
    const input = el('input', {
      type: 'text',
      id: 'license-key-input',
      placeholder: 'jpl_…',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    const submit = el('button', { id: 'license-submit', type: 'button' }, ['Activate']);
    const subscribe = el('button', { id: 'license-subscribe', type: 'button' }, [
      'Buy a license',
    ]);
    // D#888: the card is no longer a wall, so it needs a way out. Closing it
    // leaves the desktop exactly as it was — nothing was locked behind it.
    const close = el('button', { id: 'license-close', type: 'button' }, ['Close']);
    close.addEventListener('click', () => closeActivation());
    const meta = el('div', { class: 'meta', id: 'license-meta' }, []);

    submit.addEventListener('click', async () => {
      const key = (input.value || '').trim();
      errorLine.textContent = '';
      if (!key) {
        errorLine.textContent = 'License key is required.';
        return;
      }
      submit.disabled = true;
      try {
        const hostname =
          (window.FULCConfig && window.FULCConfig.hostname) ||
          (typeof navigator !== 'undefined' && navigator.platform) ||
          null;
        const resp = await fetch('/api/license/activate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ license_key: key, hostname }),
        });
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          errorLine.textContent =
            (body && (body.error || body.message)) || `gateway responded ${resp.status}`;
          submit.disabled = false;
          return;
        }
        // Success — publish the new state FIRST, then re-derive visibility from
        // it. Order matters: applyVisibility() reads the state it is handed and
        // clears `cardIntent` only when that state is unlocked, so calling
        // closeActivation() here instead re-derived against the stale
        // `missing` and put the "running unlicensed" banner straight back up
        // on a box that had just been activated.
        document.body.dataset.fulcLicenseState = 'valid';
        if (window.FULCLicense) window.FULCLicense.state = 'valid';
        applyCopy('valid');
        applyVisibility('valid');
        document.dispatchEvent(
          new CustomEvent('fulc:license-state-changed', { detail: { state: 'valid' } }),
        );
        document.dispatchEvent(
          new CustomEvent('fulc:license-ready', { detail: body }),
        );
      } catch (e) {
        errorLine.textContent = `network error: ${(e && e.message) || e}`;
      } finally {
        submit.disabled = false;
      }
    });

    subscribe.addEventListener('click', () => {
      // Stripe Checkout link comes from the gateway when ready (task 01).
      // For now: open a placeholder pricing page in the system browser.
      // Documented in docs/licensing-distribution-design.md.
      try {
        window.open('https://fulcrumaxe.dev/pricing', '_blank');
      } catch {
        /* noop */
      }
    });

    return el('div', { id: 'license-overlay' }, [
      el('div', { class: 'panel' }, [
        heading,
        body,
        el('div', { class: 'field-label' }, ['License key']),
        input,
        el('div', null, [submit, subscribe, close]),
        errorLine,
        meta,
      ]),
    ]);
  }

  function applyCopy(state) {
    const heading = document.getElementById('license-heading');
    const body = document.getElementById('license-body');
    const submit = document.getElementById('license-submit');
    if (!heading || !body || !submit) return;
    if (state === 'expired') {
      heading.textContent = 'fulcrumaxe-os — Renew your license';
      body.textContent = COPY_EXPIRED;
      submit.textContent = 'Renew';
    } else {
      heading.textContent = 'fulcrumaxe-os — Activate license';
      body.textContent = COPY_MISSING;
      submit.textContent = 'Activate';
    }
  }

  // D#888: one slim strip serves both the grace case (refresh) and the
  // unlicensed case (activate). Kept as one element because they are the same
  // affordance — a non-blocking note with one action — and two strips could
  // never be shown at once anyway.
  function renderNoticeBanner() {
    return el('div', { id: 'license-grace-banner' }, [
      el('span', { id: 'license-grace-text' }, [
        'License is in a grace period — refresh when this machine is online.',
      ]),
      el(
        'button',
        {
          type: 'button',
          id: 'license-notice-action',
          onclick: async () => {
            if (noticeMode === 'missing') {
              openActivation();
              return;
            }
            try {
              await fetch('/api/license/refresh', { method: 'POST' });
              await applyStatus();
            } catch {
              /* leave banner up; the next status poll will retry */
            }
          },
        },
        ['Refresh now'],
      ),
      el(
        'button',
        {
          type: 'button',
          id: 'license-notice-dismiss',
          title: 'Dismiss',
          onclick: () => {
            noticeDismissed = true;
            // D#37 WS-C2 fix round item 3 (W2, CWE-359): namespaced under
            // storage-ns.js's fx:<ns>: prefix -- see the dynamic import
            // below. `_nsSetItem` is null until that resolves and a
            // namespace exists; the dismissal still applies for this
            // page view (noticeDismissed above), it just isn't persisted
            // until storage-ns is ready, same as the try/catch this
            // replaces was already best-effort.
            if (_nsSetItem) _nsSetItem(NOTICE_DISMISSED_KEY, '1');
            applyVisibility(lastState);
          },
        },
        ['\u00d7'],
      ),
    ]);
  }

  // ── Visibility ────────────────────────────────────────────────────────────
  //
  // The card and the banner are driven by body attributes rather than by
  // `data-fulc-license-state` directly, so that "the licence is missing" and
  // "the visitor is looking at the activation card" stay separate facts. See
  // activation.css.

  const NOTICE_DISMISSED_KEY = 'fulc.license.notice-dismissed';
  let noticeDismissed = false;
  let _nsSetItem = null;
  // D#37 WS-C2 fix round item 3 (W2, CWE-359): this dismissal flag moves
  // under storage-ns.js's fx:<ns>: namespace, like the other four
  // un-namespaced writers this fix round closes. This file is
  // deliberately a CLASSIC (non-module, non-deferred) script -- see
  // index.html's own comment -- so it can read storage synchronously
  // while the document is still parsing, before any deferred module
  // (including core/storage-ns.js) has executed. That head start never
  // actually reached a namespace anyway: the account's storage_ns is
  // fetched asynchronously by boot.js and isn't known this early
  // regardless of storage mechanism. So `noticeDismissed` starts `false`
  // (the notice shows) and is corrected -- then re-applied via
  // applyVisibility -- once storage-ns.js resolves a namespace. A
  // dynamic import(), not a static one, is what lets this classic
  // script reach an ES module at all.
  import('../../core/storage-ns.js')
    .then(({ getItem, setItem, onNamespaceReady }) => {
      _nsSetItem = setItem;
      onNamespaceReady(() => {
        noticeDismissed = getItem(NOTICE_DISMISSED_KEY) === '1';
        applyVisibility(lastState);
      });
    })
    .catch(() => {
      /* storage-ns.js failed to load -- notice stays shown; dismissal stays session-only (_nsSetItem stays null) */
    });
  let noticeMode = null;
  let lastState = null;
  // null = no explicit choice yet, so the state decides. 'open'/'closed' are a
  // deliberate act by the visitor and outrank the state until it clears.
  let cardIntent = null;

  function autoPromptSurface() {
    return document.body.hasAttribute('data-fulc-activation-auto');
  }

  function openActivation() {
    cardIntent = 'open';
    // Re-derive rather than just setting the attribute, so the banner drops
    // away instead of asking for the same thing twice behind the card.
    applyVisibility(lastState);
    const input = document.getElementById('license-key-input');
    if (input) {
      try {
        input.focus();
      } catch {
        /* not focusable yet */
      }
    }
  }

  function closeActivation() {
    cardIntent = 'closed';
    applyVisibility(lastState);
  }

  function applyVisibility(state) {
    lastState = state;
    const locked = state === 'missing' || state === 'expired';
    if (!locked) cardIntent = null;

    // Card: only when the visitor is being asked to act. `missing` on an
    // ordinary desktop is NOT such a case — that is the free build working.
    let wantCard;
    if (cardIntent === 'open') wantCard = true;
    else if (cardIntent === 'closed') wantCard = false;
    else wantCard = (autoPromptSurface() && locked) || state === 'expired';

    if (wantCard) {
      document.body.dataset.fulcActivationOpen = '1';
    } else {
      delete document.body.dataset.fulcActivationOpen;
    }

    // Banner: grace always, missing unless dismissed. Suppressed when the card
    // is up so the visitor is not asked the same thing twice.
    const wantNotice =
      (state === 'grace' || (state === 'missing' && !noticeDismissed)) &&
      document.body.dataset.fulcActivationOpen !== '1';
    noticeMode = wantNotice ? state : null;
    if (wantNotice) {
      document.body.dataset.fulcLicenseNotice = '1';
    } else {
      delete document.body.dataset.fulcLicenseNotice;
    }

    const action = document.getElementById('license-notice-action');
    if (action) {
      action.textContent = state === 'missing' ? 'Activate license' : 'Refresh now';
    }
    const dismiss = document.getElementById('license-notice-dismiss');
    // Grace is transient and self-clearing; only the unlicensed note is
    // something a visitor should be able to put away for good.
    if (dismiss) dismiss.hidden = state !== 'missing';
  }

  function describeExpired(reason) {
    switch (reason) {
      case 'grace_window_elapsed':
        return 'License grace window has elapsed; please reactivate.';
      case 'subscription_canceled':
        return 'Subscription canceled — renew to restore cloud deployment and management.';
      case 'signature_invalid':
        return 'License token signature is invalid — please reactivate.';
      case 'machine_mismatch':
        return 'License token is bound to a different machine — reactivate to bind it to this one.';
      default:
        return 'License has expired — please reactivate.';
    }
  }

  function describeGrace(reason) {
    switch (reason) {
      case 'past_exp':
        return 'License token is past its expiry — refreshing soon.';
      case 'subscription_past_due':
        return 'Subscription payment is past due — please update billing.';
      default:
        return 'License is in a grace period.';
    }
  }

  async function fetchStatus() {
    try {
      const resp = await fetch('/api/license/status');
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    }
  }

  async function applyStatus() {
    const status = await fetchStatus();
    const previous = (window.FULCLicense && window.FULCLicense.state) || null;
    if (!status) {
      // No status response — assume Missing rather than blocking boot
      // forever. The user can still hit `/api/license/status` later.
      document.body.dataset.fulcLicenseState = 'missing';
      if (window.FULCLicense) window.FULCLicense.state = 'missing';
      applyCopy('missing');
      applyVisibility('missing');
      if (previous !== 'missing') {
        document.dispatchEvent(
          new CustomEvent('fulc:license-state-changed', { detail: { state: 'missing' } }),
        );
      }
      return null;
    }
    document.body.dataset.fulcLicenseState = status.state;
    if (window.FULCLicense) window.FULCLicense.state = status.state;
    applyCopy(status.state);
    applyVisibility(status.state);
    if (previous !== status.state) {
      document.dispatchEvent(
        new CustomEvent('fulc:license-state-changed', { detail: { state: status.state } }),
      );
    }

    const meta = document.getElementById('license-meta');
    if (meta) {
      const parts = [];
      if (status.machine_id) {
        parts.push(`Machine ID: ${status.machine_id.slice(0, 16)}…`);
      }
      if (status.license_path) {
        parts.push(`License path: ${status.license_path}`);
      }
      meta.textContent = parts.join(' · ');
    }

    const error = document.getElementById('license-error');
    if (error) {
      if (status.state === 'expired') {
        error.textContent = describeExpired(status.expired_reason);
      } else {
        error.textContent = '';
      }
    }

    const graceText = document.getElementById('license-grace-text');
    if (graceText && status.state === 'grace') {
      graceText.textContent = describeGrace(status.grace_reason);
    } else if (graceText && status.state === 'missing') {
      graceText.textContent =
        'fulcrumaxe-os is free — every app works without a license. Activate one to add ' +
        'cloud deployment and management, automatic updates and priority triage.';
    }
    return status;
  }

  function mount() {
    if (document.getElementById('license-overlay')) return;
    document.body.appendChild(renderOverlay());
    document.body.appendChild(renderNoticeBanner());
  }

  // D#37 WS-C2 fix round 3 (criterion 15, console-error elimination):
  // GET /api/license/status is one of the shell-session routes and
  // requires a session (criterion 4) -- calling it before boot.js has
  // confirmed one can only ever 401. `onNamespaceReady()` (this file
  // already uses it above for the dismissal-flag read) fires once
  // boot.js calls setNamespace() after a real signed-in session is
  // confirmed, and fires synchronously/immediately if one already is by
  // the time this resolves -- so a returning visitor with a live
  // session still sees the license state applied as soon as it's known,
  // just never before it's known. `mount()` still runs unconditionally
  // and immediately: it only builds hidden DOM structure (default
  // `display: none` -- see activation.css), so there is nothing to defer
  // there.
  function initLicenseStatusWhenAuthenticated() {
    import('../../core/storage-ns.js')
      .then(({ onNamespaceReady }) => {
        onNamespaceReady(() => { applyStatus(); });
      })
      .catch(() => {
        /* storage-ns.js failed to load -- license state stays unknown; card/banner stay hidden (safe default) */
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      mount();
      initLicenseStatusWhenAuthenticated();
    });
  } else {
    mount();
    initLicenseStatusWhenAuthenticated();
  }

  // Keep card copy in sync if the license state shifts mid-session
  // (e.g. activation succeeds, refresh detects expiry, or a test
  // dispatches the event manually).
  document.addEventListener('fulc:license-state-changed', (ev) => {
    const next = ev && ev.detail && ev.detail.state;
    if (next) applyCopy(next);
  });

  // Expose the bare minimum on window so MCP devtools and tests can
  // poke at the overlay without scraping the DOM. `state` mirrors the
  // last /api/license/status state and is read by activation-app-lock.js
  // to decide whether to deny `app.*` capabilities.
  window.FULCLicense = {
    state: null,
    refresh: applyStatus,
    // D#888: the card is opt-in on an unlicensed desktop, so callers (the
    // banner button, a future tray item, tests) need a way to raise it.
    openActivation: openActivation,
    closeActivation: closeActivation,
    deactivate: async () => {
      const r = await fetch('/api/license/deactivate', { method: 'POST' });
      await applyStatus();
      return r.json().catch(() => ({}));
    },
  };
})();
