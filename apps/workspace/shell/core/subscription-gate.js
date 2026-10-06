// ── fulcrumaxe workspace Subscription Gate ─────────────────────────────────
// D#37 WS-L1 (correction C19c criterion 6): shown INSTEAD of the desktop
// when a signed-in account's `workspace_access` (from `/api/cloud/auth/me`,
// D#69's derived `accounts.status`) is not `open`. No desktop, desktop
// icons, dock, taskbar, tray or app window is ever created on this path --
// boot.js calls this module's `render()` and returns, it never calls
// `window.showDesktop()` or `FULCEntitlements.init()` for a gated session,
// so nothing on this screen ever issues an `/api/entitlements/me` or
// `/api/v1/*` request (criterion 6's own assertion).
//
// D#37 WS-F6 (C19e, ruling G2) amends that narrowly: the screen makes
// EXACTLY two calls and nothing else -- the plan read (GET /api/plans, a
// session route, not /api/v1) and, for the account's owner only and only on
// a click, the checkout-session POST (POST /api/v1/billing/checkout-session).
// e2e/subscription-gate.spec.ts lists both and still asserts nothing else.
//
// This is a UI gate only (criterion 7): every `/v1` handler and `reserve()`
// (D#69) already re-check the account server-side regardless of what this
// screen shows. A client that forces `workspace_access: "open"` locally
// gets an EMPTY desktop whose own server calls are still decided
// server-side -- nothing behind this screen is unlocked by skipping it.
//
// Classic (non-module) script, like core/cloud-login.js: boot.js is
// `type="module"` and deferred, so `window.FULCSubscriptionGate` must be
// on `window` before it runs, which only a synchronously-executed classic
// script guarantees.
//
// D#37 WS-C2b: built with createElement/textContent/append, never
// innerHTML, so this file never needs to join TRUSTED_TYPES_SINK_GUARDED_FILES.

(() => {
  'use strict';

  const COPY = {
    no_subscription: {
      heading: 'Choose a plan to open your workspace',
      admin: "Your account doesn't have a subscription yet. A subscription unlocks your fulcrumaxe cloud workspace.",
      member: "Your account doesn't have a subscription yet. Ask an owner or admin of this account to choose a plan.",
    },
    subscription_ended: {
      heading: 'Your subscription has ended',
      admin: 'Choose a plan to reopen your workspace.',
      member: 'Ask an owner or admin of this account to choose a plan.',
    },
  };

  function contactLine() {
    // D#37 WS-L1 criterion 6 / C10 (in-product Help entry, not yet
    // merged): the support email must come from the same public-config
    // source C10's Help entry reads (`FX_SUPPORT_EMAIL`), never a
    // retyped literal. C10 hasn't landed yet, so there is no shipped
    // field carrying it today -- this reads it defensively off
    // `window.brandingData` (populated by boot.js's fetchBranding()
    // before this ever renders) so the sentence appears automatically
    // once a later PR adds the field, and degrades gracefully (the
    // sentence is simply omitted, matching C10 criterion 2's own "unset
    // -> hidden" rule) until then. See this PR's description for the
    // full account of this gap.
    const email = window.brandingData && window.brandingData.support_email;
    if (!email) return null;
    const line = document.createElement('p');
    line.className = 'subscription-gate-support';
    const text = document.createTextNode('To subscribe, contact ');
    const link = document.createElement('a');
    link.href = `mailto:${email}`;
    link.textContent = email;
    line.append(text, link);
    return line;
  }

  // ── plans (WS-F6, C19e) ────────────────────────────────────────────────
  // The two calls this screen may make (see the header). Nothing here reads
  // /api/entitlements/me or any other /api/v1 route.
  const PLANS_URL = '/api/plans';
  const CHECKOUT_URL = '/api/v1/billing/checkout-session';
  let plansToken = 0;

  const money = (n) => '$' + Number(n).toLocaleString('en-US');

  function limitsLine(p) {
    // A limit the server did not send (neither a number nor null) is left out, never printed as "undefined".
    const parts = [];
    if (p.repo_limit === null) parts.push('Unlimited repos');
    else if (Number.isInteger(p.repo_limit)) parts.push(`Up to ${p.repo_limit} repo${p.repo_limit === 1 ? '' : 's'}`);
    if (p.always_on_security_reviewer) parts.push('always-on security reviewer');
    if (p.priority_queue) parts.push('priority queue');
    return parts.join(', ');
  }

  // A capped call (429) says how long to wait in Retry-After (whole seconds). Without a usable value the wait is 10 s.
  function waitFrom(res) {
    const raw = res.headers && typeof res.headers.get === 'function' ? res.headers.get('Retry-After') : null;
    return typeof raw === 'string' && /^\d{1,7}$/.test(raw.trim()) && Number(raw.trim()) >= 1 ? Number(raw.trim()) : 10;
  }

  function waitWords(n) {
    if (n >= 120) return `Try again in ${Math.ceil(n / 60)} minutes.`;
    return `Try again in ${n} ${n === 1 ? 'second' : 'seconds'}.`;
  }

  // Counts the wait down in the error line and keeps the button off until it ends. The line is announced once;
  // the per-second repaints are not (the alert role is dropped after the first, and given back at the end).
  function countDown(seconds, btn, errEl) {
    const deadline = Date.now() + seconds * 1000;
    btn.disabled = true;
    let first = true;
    (function tick() {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      if (left <= 0) {
        errEl.setAttribute('role', 'alert');
        errEl.textContent = '';
        btn.disabled = false;
        btn.focus();
        return;
      }
      if (first) first = false;
      else errEl.removeAttribute('role');
      errEl.textContent = `Too many tries. ${waitWords(left)}`;
      setTimeout(tick, 1000);
    })();
  }

  function subscribe(planId, btn, errEl) {
    btn.disabled = true;
    errEl.textContent = '';
    fetch(CHECKOUT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      // Fixed relative paths: the server accepts only plain absolute paths on this app.
      body: JSON.stringify({ plan: planId, success_path: '/', cancel_path: '/' }),
    })
      .then((res) => {
        if (res.status === 429) return Promise.reject(Object.assign(new Error('rate_limited'), { waitSeconds: waitFrom(res) }));
        return res.ok ? res.json() : Promise.reject(new Error('checkout'));
      })
      .then((body) => {
        if (!body || typeof body.url !== 'string' || !body.url.startsWith('https://')) throw new Error('checkout');
        window.location.assign(body.url);
      })
      .catch((err) => {
        if (err && err.waitSeconds) return countDown(err.waitSeconds, btn, errEl);
        btn.disabled = false;
        // Disabling the focused button dropped focus to the page; give it back so the retry is one keypress.
        btn.focus();
        errEl.textContent = "Checkout couldn't be opened. Try again.";
      });
  }

  function renderPlans(slot, data) {
    slot.replaceChildren();
    const viewer = (data && data.viewer) || {};
    // A partner bills this account: nothing is sold here, so neither
    // Subscribe nor "Ask an owner" (and no price list that would mislead).
    if (!data || !Array.isArray(data.plans) || viewer.partner_billed === true) return;
    const errEl = document.createElement('p');
    errEl.className = 'subscription-gate-error';
    errEl.setAttribute('role', 'alert');
    const list = document.createElement('ul');
    list.className = 'subscription-gate-plans';
    list.setAttribute('aria-label', 'Plans');
    for (const p of data.plans) {
      // A plan with no name or no price cannot be shown without printing "undefined" or "NaN".
      if (!p || typeof p.id !== 'string' || !p.id || !Number.isFinite(p.price_usd_month)) continue;
      const li = document.createElement('li');
      li.className = 'subscription-gate-plan';
      li.dataset.plan = p.id;
      const name = document.createElement('strong');
      name.textContent = p.id.charAt(0).toUpperCase() + p.id.slice(1);
      const price = document.createElement('span');
      price.textContent = `${money(p.price_usd_month)} / month`;
      const limits = document.createElement('span');
      limits.className = 'subscription-gate-plan-limits';
      limits.textContent = limitsLine(p);
      li.append(name, price, limits);
      if (viewer.is_owner === true) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'subscription-gate-subscribe';
        btn.textContent = 'Subscribe';
        btn.setAttribute('aria-label', `Subscribe to ${name.textContent}`);
        btn.addEventListener('click', () => subscribe(p.id, btn, errEl));
        li.appendChild(btn);
      } else {
        const ask = document.createElement('span');
        ask.className = 'subscription-gate-ask';
        ask.textContent = 'Ask an owner';
        li.appendChild(ask);
      }
      list.appendChild(li);
    }
    slot.append(list, errEl);
  }

  const UNAVAILABLE = { unavailable: true };

  function renderUnavailable(slot) {
    slot.replaceChildren();
    const note = document.createElement('p');
    note.className = 'subscription-gate-plans-unavailable';
    note.setAttribute('role', 'status');
    note.textContent = 'Plans are unavailable right now.';
    slot.appendChild(note);
  }

  function loadPlans(slot) {
    const mine = ++plansToken;
    fetch(PLANS_URL, { headers: { Accept: 'application/json' } })
      .then((res) => {
        if (res.ok) return res.json();
        // The server's plan data is missing: say so in plain words instead of showing nothing (D#536).
        if (res.status === 503) {
          return res
            .json()
            .then((body) => (body && body.error && body.error.code === 'plan_data_unavailable' ? UNAVAILABLE : null))
            .catch(() => null);
        }
        return null;
      })
      .then((data) => {
        if (mine !== plansToken) return;
        if (data === UNAVAILABLE) renderUnavailable(slot);
        else renderPlans(slot, data);
      })
      .catch(() => {});
  }

  function ensureScreen() {
    let screen = document.getElementById('subscription-gate-screen');
    if (screen) return screen;

    screen = document.createElement('div');
    screen.id = 'subscription-gate-screen';
    screen.className = 'subscription-gate-screen';
    screen.setAttribute('role', 'dialog');
    screen.setAttribute('aria-modal', 'true');
    screen.setAttribute('aria-labelledby', 'subscription-gate-heading');

    const card = document.createElement('div');
    card.className = 'subscription-gate-card';

    const heading = document.createElement('h1');
    heading.id = 'subscription-gate-heading';
    // Keyboard: focus starts on the heading (criterion 6).
    heading.tabIndex = -1;
    card.appendChild(heading);

    const body = document.createElement('p');
    body.id = 'subscription-gate-body';
    card.appendChild(body);

    const supportSlot = document.createElement('div');
    supportSlot.id = 'subscription-gate-support-slot';
    card.appendChild(supportSlot);

    const plansSlot = document.createElement('div');
    plansSlot.id = 'subscription-gate-plans-slot';
    card.appendChild(plansSlot);

    const actions = document.createElement('div');
    actions.className = 'subscription-gate-actions';
    const signOutBtn = document.createElement('button');
    signOutBtn.type = 'button';
    signOutBtn.id = 'subscription-gate-signout';
    signOutBtn.className = 'subscription-gate-signout';
    signOutBtn.textContent = 'Sign out';
    signOutBtn.addEventListener('click', () => {
      // D#37 WS-C2 criterion 12 / this task's criterion 6: the SAME
      // server-side-revoking sign-out every other sign-out entry point
      // uses. Dynamic import from a classic script, same pattern
      // apps/activation/activation.js already used for storage-ns.js.
      signOutBtn.disabled = true;
      import('./cloud-signout.js')
        .then(({ signOut }) => signOut())
        .catch(() => {
          signOutBtn.disabled = false;
        });
    });
    actions.appendChild(signOutBtn);
    card.appendChild(actions);

    screen.appendChild(card);
    document.body.appendChild(screen);
    return screen;
  }

  window.FULCSubscriptionGate = {
    /** D#37 WS-F9a: the same plan picker (copy, plan read, owner-only checkout, partner rule) inside another surface. */
    mountPlans(slot, isAdmin) {
      const text = document.createElement('p');
      text.textContent = isAdmin ? COPY.no_subscription.admin : COPY.no_subscription.member;
      const plans = document.createElement('div');
      slot.replaceChildren(text, plans);
      loadPlans(plans);
    },

    /**
     * @param {{ workspace_access: 'no_subscription' | 'subscription_ended', is_admin?: boolean }} session
     */
    render(session) {
      const kind = session && session.workspace_access;
      const copy = COPY[kind];
      if (!copy) {
        // Fail closed: an unrecognized value is treated as no_subscription
        // rather than silently rendering nothing (which would leave the
        // desktop reachable by default in a future caller mistake).
        return window.FULCSubscriptionGate.render({ ...session, workspace_access: 'no_subscription' });
      }

      // No desktop, dock, taskbar, tray or app window on this path --
      // hide every other screen so this one owns the viewport, the same
      // way core/boot.js's showFailClosed() and core/cloud-login.js's
      // render() already do.
      ['boot-screen', 'terminal-shell', 'desktop-screen', 'cloud-login-screen', 'fail-closed-screen'].forEach(
        (id) => {
          const el = document.getElementById(id);
          if (el) el.classList.add('hidden');
        },
      );

      const screen = ensureScreen();
      const heading = document.getElementById('subscription-gate-heading');
      const body = document.getElementById('subscription-gate-body');
      const supportSlot = document.getElementById('subscription-gate-support-slot');

      heading.textContent = copy.heading;
      const isAdmin = !!(session && session.is_admin);
      let text = isAdmin ? copy.admin : copy.member;
      body.textContent = text;

      supportSlot.replaceChildren();
      if (isAdmin) {
        const support = contactLine();
        if (support) supportSlot.appendChild(support);
      }

      screen.classList.remove('hidden');
      loadPlans(document.getElementById('subscription-gate-plans-slot'));
      setTimeout(() => heading.focus(), 0);
    },
  };
})();
