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
