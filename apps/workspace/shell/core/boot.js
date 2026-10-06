// ── fulcrumaxe workspace Boot ──────────────────────────────────────────────
// Boot sequence for the cloud profile: fetch branding, fetch /api/mode
// with a 5s fail-closed budget, then either show the sign-in screen
// (core/cloud-login.js) or the desktop.
//
// D#37 WS-C2. This fork ships ONLY the cloud profile — the upstream
// jpos boot.js also handled a local terminal login/signup flow, a
// container-redirect mode and an unauthenticated "server" fallback that
// dropped straight into a username/password terminal. None of that
// applies here: /api/mode always answers "cloud" (WS-C1 criterion 2),
// and this file fails closed on anything else rather than falling back
// to a credential prompt of any kind (criterion 10). The legacy
// LOGIN/SIGNUP terminal commands, and every endpoint they called, are
// removed entirely — criterion 9 requires none of that legacy
// local-auth surface survives in the shipped fork, and checks.mjs
// --ship's forbidden-signin rules (rules.mjs) fail the build if any of
// it does.
//
// D#37 WS-D: the boot ANIMATION (this file's own #boot-log typing
// effect) and the real work (mode/system-mode/branding/auth-me) are two
// independent things that both start immediately and run concurrently --
// neither one is "awaited" by the other (criterion 1/2). The animation is
// a fixed, bounded, cosmetic sequence (skippable by any key or tap,
// auto-skipped on a repeat load in this tab session or under
// prefers-reduced-motion); the real work decides what screen to show
// once it resolves. Whichever finishes later is what the user actually
// waits on -- in the common case (fast network) that's the ~1.1s
// animation; the old implementation instead ran them one after another
// (fetch branding, THEN play the whole animation, THEN fetch mode, THEN
// check the session), which is the sequential delay WS-D's ≤1.5s/≤2.0s
// budgets could not fit inside.
import { setNamespace } from "./storage-ns.js";
// markDesktopReady() itself lives in script.js's showDesktop() -- this
// file only marks the sign-in path, which it renders directly.
import { markSigninVisible } from "./boot-metrics.js";

(function () {
  'use strict';

  // D#37 WS-C2 criteria 9/10: the fork ships no credential prompt of any
  // kind before sign-in — including the fail-closed error screen. A
  // one-time sweep isn't enough: apps/activation/activation.js (a
  // shipped cloud-profile app, unrelated to sign-in) mounts its own
  // license-key <input> on DOMContentLoaded, which fires AFTER this
  // module already ran once — a plain querySelectorAll here would miss
  // it. This MutationObserver removes any <input> added anywhere in the
  // document, for as long as it stays connected; disconnectPreAuthInputGuard()
  // below is called the moment a signed-in session is confirmed, so it
  // never touches legitimate post-sign-in UI (e.g. the command
  // palette's own filter field).
  document.querySelectorAll('input').forEach((el) => el.remove());
  const preAuthInputGuard = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        if (node.matches && node.matches('input')) node.remove();
        node.querySelectorAll && node.querySelectorAll('input').forEach((el) => el.remove());
      });
    }
  });
  preAuthInputGuard.observe(document.documentElement, { childList: true, subtree: true });
  function disconnectPreAuthInputGuard() {
    preAuthInputGuard.disconnect();
  }

  // FULCBootTime is kept on window for MCP devtools and debug dumps — see epic-26/08.md keep-list
  window.FULCBootTime = Date.now();
  console.log("[boot] script-ready", Date.now() - performance.timing.navigationStart);

  const bootScreen = document.getElementById('boot-screen');
  const bootLog = document.getElementById('boot-log');
  const datetimeDisplay = document.getElementById('datetime');
  const systemTagDisplay = document.getElementById('dynamic-system-tag');

  const MODE_FETCH_TIMEOUT_MS = 5000;
  const FAIL_CLOSED_MESSAGE = "fulcrumaxe workspace can't reach the server";

  // D#37 WS-D criterion 1: sessionStorage flag for "this tab session has
  // already shown the boot animation once" -- a fresh tab (or a fresh
  // sessionStorage, e.g. after closing the tab) sees it again.
  const BOOT_SHOWN_KEY = 'fx-boot-shown';
  const BOOT_LINE_DELAY_MS = 140; // 8 lines * 140ms = 1120ms, under the 1.2s budget

  // ── Clock ────────────────────────────────────────────────────────────

  function updateTime() {
    if (!datetimeDisplay) return;
    const now = new Date();
    try {
      const tz = window.userPreferences ? window.userPreferences.timezone : 'UTC';
      datetimeDisplay.innerText = now.toLocaleString(undefined, { timeZone: tz });
    } catch (e) {
      datetimeDisplay.innerText = now.toLocaleString();
    }
  }
  setInterval(updateTime, 1000);

  // ── Branding ─────────────────────────────────────────────────────────

  async function fetchBranding() {
    try {
      const res = await fetch('/api/branding');
      const data = await res.json();
      window.brandingData = { ...window.brandingData, ...data };
      if (systemTagDisplay) systemTagDisplay.innerText = window.brandingData.system_tag;
      document.title = window.brandingData.page_title || 'fulcrumaxe';
      // Apply gateway-stored color palette + logo (epic-7 task 11b).
      // FULCBrandingApplier is loaded by core/branding-applier.js (before boot.js).
      if (window.FULCBrandingApplier) {
        window.FULCBrandingApplier.applyBranding(window.brandingData);
      }
    } catch (e) { console.error('Error fetching branding', e); }
  }

  // D#37 WS-D criterion 2: fired purely so the "mode, system/mode,
  // branding and auth/me start in parallel" request log shows all four --
  // nothing downstream reads its response yet (system/mode exists for a
  // future consumer and for the LIVE-NEEDS production check). A failure
  // here is silently ignored; it never affects mode/session handling.
  async function fetchSystemModeOrNull() {
    try {
      const res = await fetch('/api/system/mode');
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  // ── Fail-closed ──────────────────────────────────────────────────────
  // D#37 WS-C2 criterion 10: any /api/mode error, timeout (5s) or a
  // response whose mode isn't exactly "cloud" shows this screen and a
  // Retry button — never a credential prompt, never the desktop.

  function showFailClosed() {
    ['boot-screen', 'terminal-shell', 'desktop-screen', 'cloud-login-screen'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });
    let screen = document.getElementById('fail-closed-screen');
    if (screen) {
      const btn = screen.querySelector('button');
      if (btn) btn.focus();
      return;
    }
    screen = document.createElement('div');
    screen.id = 'fail-closed-screen';
    screen.style.cssText =
      'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
      'background:#000;color:#f55;font-family:monospace;z-index:10001;text-align:center;padding:24px;';
    const wrap = document.createElement('div');
    wrap.style.maxWidth = '420px';
    const message = document.createElement('p');
    message.id = 'fail-closed-message';
    message.setAttribute('role', 'alert');
    message.style.cssText = 'font-size:14px;line-height:1.6;margin:0 0 20px;';
    wrap.appendChild(message);
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.id = 'fail-closed-retry';
    retryBtn.style.cssText =
      'padding:10px 24px;background:#000;border:1px solid #f55;color:#f55;' +
      'font-family:monospace;font-size:13px;letter-spacing:2px;cursor:pointer;';
    retryBtn.textContent = 'RETRY';
    wrap.appendChild(retryBtn);
    screen.appendChild(wrap);
    document.body.appendChild(screen);
    message.textContent = FAIL_CLOSED_MESSAGE;
    retryBtn.addEventListener('click', () => { window.location.reload(); });
    setTimeout(() => retryBtn.focus(), 0);
  }

  // ── Mode check ─────────────────────────────────────────────────────
  // Resolves to a mode payload ONLY when the fetch succeeds, parses as
  // JSON and completes within the timeout — every other outcome
  // (network error, non-OK status, invalid JSON, timeout) resolves to
  // `null`, which runBoot() below treats as fail-closed.

  async function fetchModeOrNull() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODE_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch('/api/mode', { signal: controller.signal });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || typeof data !== 'object') return null;
      return data;
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // D#37 WS-C2 fix round 3 (criterion 15, console-error elimination):
  // `fx_has_session` is a plain, non-HttpOnly, client-readable cookie set
  // (apps/web/app/api/auth/_lib/sessionCookie.ts's withSessionCookie)
  // alongside the real `__Host-fx_session` cookie at sign-in, and cleared
  // (clearSessionCookie) at sign-out. It carries no session data and has
  // no authority of its own -- `/api/cloud/auth/me` still runs its full
  // check below exactly as before whenever this hint says "maybe". Its
  // only job is deciding whether to ATTEMPT that fetch at all: on a
  // fresh visit or right after sign-out there is provably no session,
  // and Chromium logs "Failed to load resource: the server responded
  // with a status of 401" to the console for ANY fetch() response >= 400
  // regardless of how the caller's JS handles it -- there is no
  // JS-level way to suppress that once the request is made. Skipping
  // the fetch in the predictable-failure case is the only way to keep
  // the real, unweakened 401-with-empty-body check (criterion 3) for
  // every case this hint can't predict, without ever showing it.
  //
  // D#37 WS-D criterion 2: this same hint is why index.html's own
  // auth/me <link rel="preload"> is injected conditionally (a tiny
  // inline script, see index.html's header comment) rather than being an
  // unconditional static tag like the other three preloads -- a static
  // HTML tag can't consult a cookie, and preloading auth/me unconditionally
  // would reintroduce exactly the console error this hint exists to avoid,
  // for every signed-out visitor, on every load.
  function hasSessionHint() {
    try {
      return document.cookie.split('; ').indexOf('fx_has_session=1') !== -1;
    } catch (e) {
      // Cookie read itself failed (unexpected) -- fail open to the real
      // check rather than assuming no session, which is the original,
      // always-safe behavior this hint only ever short-circuits.
      return true;
    }
  }

  async function checkCloudSession() {
    if (!hasSessionHint()) return null;
    try {
      const r = await fetch('/api/cloud/auth/me', { credentials: 'include' });
      if (!r.ok) return null;
      const data = await r.json();
      return data && (data.username || data.email) ? data : null;
    } catch (_) {
      return null;
    }
  }

  // ── Boot animation ───────────────────────────────────────────────────
  // D#37 WS-D criterion 1. Purely cosmetic -- see this file's own header
  // comment for why it runs concurrently with, not before, the real work.

  function shouldSkipAnimation() {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
    } catch (e) { /* matchMedia unavailable -- don't skip on that basis */ }
    try {
      if (sessionStorage.getItem(BOOT_SHOWN_KEY) === '1') return true;
    } catch (e) { /* sessionStorage unavailable (private mode etc.) -- don't skip on that basis */ }
    return false;
  }

  function markBootShown() {
    try { sessionStorage.setItem(BOOT_SHOWN_KEY, '1'); } catch (e) { /* best-effort */ }
  }

  function hideBootScreen() {
    if (bootScreen) bootScreen.classList.add('hidden');
  }

  // Resolves the moment any key or tap fires -- "any key or tap skips it".
  // A promise that simply never resolves (no addEventListener available,
  // e.g. a hand-rolled test harness importing this module in isolation)
  // is the correct degraded behavior here: it just means skip-via-input
  // never fires, not a crash.
  function waitForSkip() {
    return new Promise((resolve) => {
      try {
        window.addEventListener('keydown', resolve, { once: true });
        window.addEventListener('pointerdown', resolve, { once: true });
      } catch (e) { /* no addEventListener in this environment -- never resolves */ }
    });
  }

  // Types `lines` into #boot-log at BOOT_LINE_DELAY_MS per line, then
  // hides the boot screen -- unless `skipPromise` resolves first, which
  // hides it immediately and stops typing further lines.
  function playBootAnimation(lines, skipPromise) {
    return new Promise((resolve) => {
      let index = 0;
      let done = false;
      function finish() {
        if (done) return;
        done = true;
        hideBootScreen();
        resolve();
      }
      skipPromise.then(finish);
      function nextLine() {
        if (done) return;
        if (index >= lines.length) { finish(); return; }
        bootLog.innerText += lines[index] + "\n";
        bootScreen.scrollTop = bootScreen.scrollHeight;
        index += 1;
        setTimeout(nextLine, BOOT_LINE_DELAY_MS);
      }
      nextLine();
    });
  }

  // ── Boot Sequence ────────────────────────────────────────────────────

  async function runBoot() {
    markBootShown();

    // D#37 WS-D criterion 2: all four start here, immediately, in
    // parallel -- none of them awaits another. index.html's own
    // <link rel="preload" as="fetch" crossorigin> tags additionally warm
    // three of these four requests from the HTML parser itself, before
    // any module script has even started executing.
    const modePromise = fetchModeOrNull();
    const systemModePromise = fetchSystemModeOrNull();
    const sessionPromise = checkCloudSession();
    fetchBranding(); // updates window.brandingData/title/system-tag opportunistically; never gates the reveal below

    // D#37 Correction C19d, task WS-B1 criterion 4: exactly these eight
    // lines, in this order. window.brandingData already carries the
    // ruled defaults synchronously (script.js sets them before this file
    // ever runs) -- reading it here, rather than awaiting fetchBranding()
    // first, is what makes the animation "never awaited" by the network.
    // The jpos lines this replaces ("- SERVER 03 -", "LOADING SYSTEM
    // DRIVERS...", "DETECTING STORAGE DEVICES... FOUND 512GB ...-DRIVE",
    // "INITIALIZING NET_PROTOCOL_V4...", "CONNECTING TO THE CONSTRUCT...",
    // "SYSTEM READY.") are gone, not just renamed -- rules.mjs's
    // ship-forbidden-branding gate (WS-B1 criterion 5) fails the build if
    // any of their distinguishing text reappears anywhere in dist/.
    // script.js (loaded earlier in index.html's tag order) always sets
    // window.brandingData synchronously before this module runs -- the
    // fallback below only matters for a test harness that imports this
    // file in isolation.
    const bd = window.brandingData || {};
    const bootSequence = [
      bd.os_name,
      bd.copyright,
      "------------------------------------------------",
      "CONNECTING...",
      "READY.",
      "------------------------------------------------",
      bd.welcome_message,
      "------------------------------------------------"
    ];

    const animationPromise = shouldSkipAnimation()
      ? Promise.resolve(hideBootScreen())
      : playBootAnimation(bootSequence, waitForSkip());

    // D#37 WS-D criterion 1: "never awaited" means neither sign-in nor the
    // desktop waits for the cosmetic animation to run its full course
    // beyond however long the REAL work (mode + session) already takes --
    // this resolves at whichever of the two finishes LATER, never their
    // sum (the old implementation's bug: play the whole animation, THEN
    // start fetching).
    const [, modeInfo, , cloudSession] = await Promise.all([
      animationPromise,
      modePromise,
      systemModePromise,
      sessionPromise,
    ]);
    hideBootScreen();

    if (!modeInfo || modeInfo.mode !== 'cloud') {
      showFailClosed();
      return;
    }
    window.FULC_MODE = modeInfo.mode;
    window.FULC_PROFILE = modeInfo.profile || 'cloud';
    window.FulcCloudMode = { enabled: true };

    if (cloudSession) {
      setNamespace(cloudSession.storage_ns);
      disconnectPreAuthInputGuard();

      // D#37 WS-L1 (correction C19c criterion 6): the account's
      // subscription state, not a licence, gates the desktop now. This
      // is the only branch boot.js adds for the gate -- all of the
      // gate's own logic (copy, admin/member distinction, sign-out)
      // lives in core/subscription-gate.js.
      // D#37 WS-F9a: core/onboarding-mode.js decides gate vs. onboarding mode; anything it cannot confirm is the gate.
      if (cloudSession.workspace_access !== 'open') {
        const mode = window.FULCOnboardingMode;
        let access = 'gate';
        if (mode) access = await mode.resolveAccess(cloudSession);
        if (access === 'onboarding' && mode.enterOnboardingMode()) {
          window.showDesktop(cloudSession.username || cloudSession.email, !!cloudSession.is_admin);
          mode.openOnboardingWhenReady();
          return;
        }
        if (window.FULCSubscriptionGate && typeof window.FULCSubscriptionGate.render === 'function') {
          window.FULCSubscriptionGate.render(cloudSession);
        }
        return;
      }

      if (window.FULCEntitlements) await window.FULCEntitlements.init();
      // markDesktopReady() fires from INSIDE script.js's showDesktop() --
      // that call below only schedules showDesktop's own (now-immediate)
      // async work and returns right away, well before the desktop is
      // actually rendered.
      window.showDesktop(cloudSession.username || cloudSession.email, !!cloudSession.is_admin);
      return;
    }

    if (window.FULCCloudLogin && typeof window.FULCCloudLogin.render === 'function') {
      window.FULCCloudLogin.render();
      markSigninVisible();
    } else {
      showFailClosed();
    }
  }

  // ── Start ────────────────────────────────────────────────────────────
  runBoot();
})();

export {};
