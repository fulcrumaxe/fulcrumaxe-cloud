// Cloud-mode sign-in UI (D#37 WS-C2 criterion 9).
//
// Rendered by boot.js once /api/mode has resolved to "cloud" (never
// before — a fail-closed /api/mode result shows core/boot.js's own
// error screen instead, never this one) and /api/cloud/auth/me returns
// 401. Renders exactly one "Sign in with GitHub" control that navigates
// to /api/auth/github (H06's OAuth entry point) — no email field, no
// password field, no username/password terminal flow, and none of the
// legacy local-auth endpoints or the magic-link email flow it replaces.
// checks.mjs --ship's forbidden-signin rules (rules.mjs) fail the build
// if any of that legacy surface survives in the shipped fork.
//
// D#37 WS-C2b: built with createElement/textContent/append instead of
// innerHTML, so checks.mjs's Trusted Types sink guard (rules.mjs's
// checkTrustedTypesSink) never trips on this file.

(() => {
  const STYLE_ID = 'cloud-login-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
      .cloud-login-screen { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; background:#000; color:#0f0; font-family:monospace; z-index:10000; }
      .cloud-login-card { width:min(420px, 90vw); padding:32px 28px; border:1px solid #0f0; box-shadow:0 0 24px rgba(0,255,0,0.3); text-align:center; }
      .cloud-login-card h1 { font-size:18px; letter-spacing:2px; margin:0 0 6px; }
      .cloud-login-card p  { font-size:12px; opacity:0.75; margin:0 0 24px; line-height:1.5; }
      .cloud-login-github { display:inline-flex; align-items:center; gap:10px; padding:10px 22px; background:#000; border:1px solid #0f0; color:#0f0; font-family:monospace; font-size:13px; letter-spacing:1px; cursor:pointer; text-decoration:none; }
      .cloud-login-github:hover, .cloud-login-github:focus { background:#0f0; color:#000; outline:none; }
    `;
    const tag = document.createElement('style');
    tag.id = STYLE_ID;
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  window.FULCCloudLogin = {
    render() {
      ensureStyle();
      // Hide every other screen so we own the viewport.
      ['boot-screen', 'terminal-shell', 'desktop-screen', 'fail-closed-screen'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
      });
      // Idempotent — if we've already rendered, just refocus.
      let screen = document.getElementById('cloud-login-screen');
      if (screen) {
        const existing = screen.querySelector('a');
        if (existing) existing.focus();
        return;
      }
      screen = document.createElement('div');
      screen.id = 'cloud-login-screen';
      screen.className = 'cloud-login-screen';

      const card = document.createElement('div');
      card.className = 'cloud-login-card';

      const h1 = document.createElement('h1');
      h1.textContent = 'fulcrumaxe workspace';
      card.appendChild(h1);

      const p = document.createElement('p');
      p.textContent = 'Sign in with your GitHub account to continue.';
      card.appendChild(p);

      const link = document.createElement('a');
      link.className = 'cloud-login-github';
      link.id = 'cloud-login-github';
      link.href = '/api/auth/github';
      link.textContent = 'Sign in with GitHub';
      card.appendChild(link);

      screen.appendChild(card);
      document.body.appendChild(screen);
      setTimeout(() => link.focus(), 0);
    },
  };
})();
