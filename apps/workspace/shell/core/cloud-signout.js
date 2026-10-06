// ── fulcrumaxe workspace Cloud Sign-out ────────────────────────────────────
// D#37 WS-C2 criterion 12. Reachable from the dock/user menu
// (core/taskbar.js) and the command palette (core/command-registry.js).
//
// Calls POST /api/auth/signout, which revokes the session server-side
// and answers with Clear-Site-Data: "cache" (apps/web/app/api/auth/
// signout/handler.ts); then wipes every client-side trace this fork is
// allowed to have written (storage-ns.js's clearAllClientState: every
// fx:<ns>: key for every namespace, every legacy unprefixed fulc* key,
// and sessionStorage in full) and reloads into a clean boot, which
// lands on the sign-in screen because the session cookie is gone.
//
// D#37 WS-C2 fix round item 2 (W1, CWE-754, correction C15b): a
// non-2xx response, a network error, or a timeout/abort all take the
// SAME path now -- wipe nothing, do not reload, tell the user to retry.
// Before this fix, ANY outcome (including the server refusing the
// request, or the request never completing) wiped local state and
// reloaded unconditionally, which could leave the browser showing the
// sign-in screen while the server-side session was still fully live --
// the opposite of what "sign out" is supposed to guarantee, and a
// silent failure the user had no way to notice or retry.

import { clearAllClientState } from "./storage-ns.js";
import { FULCNotify } from "./notifications.js";

const SIGNOUT_FAILED_MESSAGE = 'Sign-out failed. Try again.';

// D#37 WS-F7a (correction C24 section 3): signOut({ everywhere: true })
// sends {"everywhere": true}, which the server answers by ending every
// session for this user (WS-C1 criterion 8), this one included. It is the
// SAME function, so the failure handling above and the client cleanup below
// are shared, not duplicated. A plain signOut() still sends {} (correction
// C15: a plain sign-out never signs out other devices). Only the Developer
// app's "Sign out everywhere" button passes the option; the user menu does
// not.
//
// D#37 WS-LV1 (correction C28 D4): signOut({ serverEnded: true }) is the same
// client cleanup without the POST, for a session the server has already ended
// (core/cloud-live.js confirmed it with a 401 from /api/cloud/auth/me). No
// second cleanup path.
export async function signOut(options) {
  const everywhere = !!(options && options.everywhere === true);
  if (options && options.serverEnded === true) {
    clearAllClientState();
    window.location.reload();
    return;
  }
  let res;
  try {
    res = await fetch('/api/auth/signout', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(everywhere ? { everywhere: true } : {}),
    });
  } catch (e) {
    // Network error, or an aborted/timed-out request: the server may or
    // may not have received it, so treat this as "sign-out did not
    // happen" rather than guessing -- no local wipe, no reload.
    console.error('FULCCloudSignout: /api/auth/signout failed', e);
    FULCNotify.notify(SIGNOUT_FAILED_MESSAGE, 'error');
    return;
  }
  if (!res.ok) {
    console.error('FULCCloudSignout: /api/auth/signout returned', res.status);
    FULCNotify.notify(SIGNOUT_FAILED_MESSAGE, 'error');
    return;
  }
  clearAllClientState();
  window.location.reload();
}
