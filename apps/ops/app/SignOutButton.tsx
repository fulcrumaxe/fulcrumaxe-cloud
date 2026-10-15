"use client";

import { useState } from "react";

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function signOut() {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (res.ok) {
        window.location.assign("/login");
        return;
      }
    } catch {
      // fx-swallow-ok: a request that never arrived did not sign anyone out; the error line below tells the person, and the server reports its own failures
    }
    setFailed(true);
    setBusy(false);
  }
  return (
    <>
      <button type="button" onClick={signOut} disabled={busy}>
        {busy ? "Signing out..." : "Sign out"}
      </button>
      {failed ? <p role="alert">Could not sign out. You are still signed in. Try again.</p> : null}
    </>
  );
}
