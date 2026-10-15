"use client";

import { useState } from "react";
import { startRegistration, type PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";

const JSON_HEADERS = { "content-type": "application/json" };

export function EnrollForm({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "working" | "done" | "refused" | "unavailable">("idle");

  async function enroll() {
    setState("working");
    try {
      const opts = await fetch("/api/auth/enroll/options", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token }) });
      if (!opts.ok) return setState(opts.status === 503 ? "unavailable" : "refused");
      const { options } = (await opts.json()) as { options: PublicKeyCredentialCreationOptionsJSON };
      const response = await startRegistration({ optionsJSON: options });
      const verify = await fetch("/api/auth/enroll/verify", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token, response }) });
      setState(verify.ok ? "done" : verify.status === 503 ? "unavailable" : "refused");
    } catch {
      // fx-swallow-ok: a cancelled or failed browser prompt is shown as a refused enrollment below
      setState("refused");
    }
  }

  if (state === "done") {
    return (
      <p>
        Passkey saved. <a href="/login">Sign in</a>.
      </p>
    );
  }
  return (
    <div>
      <button type="button" onClick={enroll} disabled={state === "working"}>
        {state === "working" ? "Waiting for your passkey..." : "Create passkey"}
      </button>
      {state === "refused" && <p role="alert">Enrollment was refused. The link may be used or expired; ask for a new one.</p>}
      {state === "unavailable" && <p role="alert">The console is not available right now.</p>}
    </div>
  );
}
