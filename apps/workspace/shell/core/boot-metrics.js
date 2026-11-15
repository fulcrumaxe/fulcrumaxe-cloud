// ── fulcrumaxe workspace Boot Metrics ───────────────────────────────────────
// D#37 WS-D criterion 5: performance.mark('boot:signin-visible') and
// performance.mark('boot:desktop-ready') are recorded and sent once per
// load to POST /api/rum -- JSON, same-origin, no PII: the mark itself, a
// coarse viewport class, and the connection's effectiveType. Nothing else.
//
// Only ONE of the two marks fires on a normal page load: reaching sign-in
// means the desktop was never shown (and vice versa) -- signing in itself
// leaves the page entirely (a real navigation to /api/auth/github and back
// from GitHub), so a single "load" never sees both. The `sent` guard below
// still exists as a straightforward safety net, not because that case is
// expected.
//
// The send is synchronous with the mark call -- no setTimeout/microtask
// defer. e2e/idle-network.spec.ts's "10 idle minutes = zero requests"
// check starts listening for requests only AFTER core/boot.js's own
// currentStep flips to "DESKTOP", which happens in the same synchronous
// call as markDesktopReady() -- deferring the fetch even by one tick risks
// it firing after that listener attaches under a virtualized
// (page.clock-driven) test clock, which does not advance real network I/O
// the way it advances setTimeout. Sending immediately means the request is
// already in flight well before any listener could attach.

let sent = false;

function viewportClass() {
  try {
    return window.matchMedia("(pointer: coarse) and (max-width: 600px)").matches ? "phone" : "desktop";
  } catch (e) {
    return "desktop";
  }
}

function connectionType() {
  try {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return (c && c.effectiveType) || "unknown";
  } catch (e) {
    return "unknown";
  }
}

function send(name) {
  try {
    fetch("/api/rum", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        marks: [{ name, startTime: performance.now() }],
        viewport: viewportClass(),
        connection: connectionType(),
      }),
    }).catch(() => {
      /* RUM is best-effort -- never surfaces a console error */
    });
  } catch (e) {
    /* best-effort */
  }
}

function markAndSend(name) {
  try {
    performance.mark(name);
  } catch (e) {
    /* performance.mark unavailable (very old browser) -- nothing to send */
    return;
  }
  if (sent) return;
  sent = true;
  send(name);
}

export function markSigninVisible() {
  markAndSend("boot:signin-visible");
}

export function markDesktopReady() {
  markAndSend("boot:desktop-ready");
}

// ── Client errors (kept in this file: the boot budget has no spare file) ────
// Browser JavaScript errors reach the same error table and digest as the
// server's. The shell listens for `error` and `unhandledrejection` and sends
// the CLASS of what happened to POST /api/rum as
// { kind: "client_error", code, window } -- the report shape
// apps/web/app/api/rum already takes (H1c). Nothing else is ever put in it:
// no message, no stack, no URL, no page text. The server stores a count per
// (code, window), so a message would have nowhere to go and could only carry
// a token or a name to a log line.
//
// Bounded on this side too, so a page stuck in a loop cannot flood the
// endpoint: one report per class per minute, and at most MAX_PER_MINUTE of
// any class in the same minute. Sending is best-effort and never throws.

export const MAX_PER_MINUTE = 5;
export const MINUTE_MS = 60000;
export const CODE_SCRIPT_ERROR = "client.script_error";
export const CODE_UNHANDLED_REJECTION = "client.unhandled_rejection";

// First-party and imported apps are served as /apps/<id>/<file>.js.
const APP_PATH = /\/apps\/([a-z][a-z0-9-]{0,39})\//;

/** The window a script belongs to, from the file the error came from; anything else is the shell. */
export function windowIdFor(filename) {
  try {
    const m = APP_PATH.exec(new URL(String(filename), "https://x.invalid/").pathname);
    return m ? m[1] : "shell";
  } catch (e) {
    return "shell";
  }
}

/** The stack's first frame, when an app file is named there (a rejection carries no filename of its own). */
function windowIdFromStack(reason) {
  try {
    const stack = reason && typeof reason === "object" ? String(reason.stack || "") : "";
    const m = /https?:\/\/[^\s)]+/.exec(stack);
    return m ? windowIdFor(m[0]) : "shell";
  } catch (e) {
    return "shell";
  }
}

/**
 * Starts listening on `win`. Returns the remove function. `deps` is for tests: { fetch, now }.
 */
export function installClientErrors(win, deps = {}) {
  const doFetch = deps.fetch || ((...a) => win.fetch(...a));
  const now = deps.now || (() => Date.now());
  const lastSent = new Map();
  let windowStart = 0;
  let inWindow = 0;

  function report(code, windowId) {
    try {
      const t = now();
      if (t - windowStart >= MINUTE_MS) {
        windowStart = t;
        inWindow = 0;
      }
      if (inWindow >= MAX_PER_MINUTE) return false;
      const key = code + "|" + windowId;
      const prev = lastSent.get(key);
      if (prev !== undefined && t - prev < MINUTE_MS) return false;
      lastSent.set(key, t);
      inWindow += 1;
      const pending = doFetch("/api/rum", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({ kind: "client_error", code, window: windowId }),
      });
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
      return true;
    } catch (e) {
      return false;
    }
  }

  // A listener must never throw into the page it is watching, whatever the event looks like.
  function onError(ev) {
    try {
      report(CODE_SCRIPT_ERROR, windowIdFor(ev && ev.filename));
    } catch (e) {
      /* best-effort */
    }
  }
  function onRejection(ev) {
    try {
      report(CODE_UNHANDLED_REJECTION, windowIdFromStack(ev && ev.reason));
    } catch (e) {
      /* best-effort */
    }
  }

  win.addEventListener("error", onError);
  win.addEventListener("unhandledrejection", onRejection);
  return function remove() {
    win.removeEventListener("error", onError);
    win.removeEventListener("unhandledrejection", onRejection);
  };
}
