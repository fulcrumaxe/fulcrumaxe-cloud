"use client";

import { useState } from "react";
import { startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";

const JSON_HEADERS = { "content-type": "application/json" };

export function LoginForm() {
  const [state, setState] = useState<"idle" | "working" | "refused" | "unavailable">("idle");

  async function signIn() {
    setState("working");
    try {
      const opts = await fetch("/api/auth/login/options", { method: "POST", headers: JSON_HEADERS, body: "{}" });
      if (!opts.ok) return setState(opts.status === 503 ? "unavailable" : "refused");
      const { options } = (await opts.json()) as { options: PublicKeyCredentialRequestOptionsJSON };
      const response = await startAuthentication({ optionsJSON: options });
      const verify = await fetch("/api/auth/login/verify", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ response }) });
      if (!verify.ok) return setState(verify.status === 503 ? "unavailable" : "refused");
      window.location.assign("/");
    } catch {
      // fx-swallow-ok: a cancelled or failed browser prompt is shown as a refused sign-in below
      setState("refused");
    }
  }

  return (
    <div>
      <button type="button" onClick={signIn} disabled={state === "working"}>
        {state === "working" ? "Waiting for your passkey..." : "Sign in with passkey"}
      </button>
      {state === "refused" && <p role="alert">Sign-in was refused. Try again, or ask for a new enrollment link.</p>}
      {state === "unavailable" && <p role="alert">The console is not available right now.</p>}
    </div>
  );
}
