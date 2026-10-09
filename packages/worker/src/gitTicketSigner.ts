import { createPrivateKey } from "node:crypto";
import { reportError } from "@fx/telemetry";
import type { RunnerGitTicketSigner } from "@fx/github";

/**
 * D#6 R5a-2b (C27 section 1.6): the git-ticket signing key, read from the process environment HERE and nowhere else (the worker's
 * composition root calls this once). The web tier holds the private key; the GitHub proxy holds only the public half, so the
 * internet-facing proxy can check a ticket but never make one.
 *
 *  - `FX_GIT_TICKET_SIGNING_KEY_PEM`: the Ed25519 private key, PKCS#8 PEM. A `\n` written as two characters is accepted.
 *  - `FX_GIT_TICKET_KEY_ID`: the `kid` the proxy finds the matching public key by.
 *
 * Unlike the job signer, a missing or bad setting never stops the worker: sandbox runs do not need it. The ticket route answers 503
 * `not_configured` instead, and a half-set or invalid pair is reported (the variable's name, never its value) when the worker is built.
 */
export const GIT_TICKET_SIGNING_KEY_ENV = "FX_GIT_TICKET_SIGNING_KEY_PEM";
export const GIT_TICKET_KEY_ID_ENV = "FX_GIT_TICKET_KEY_ID";

const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;

export class GitTicketSignerConfigError extends Error {
  constructor(
    readonly variable: string,
    readonly problem: "missing" | "invalid",
  ) {
    super(`git ticket signer: ${variable} is ${problem}`);
    this.name = "GitTicketSignerConfigError";
  }
}

export function loadGitTicketSigner(env: Readonly<Record<string, string | undefined>>): RunnerGitTicketSigner | null {
  const pem = env[GIT_TICKET_SIGNING_KEY_ENV]?.trim();
  const keyId = env[GIT_TICKET_KEY_ID_ENV]?.trim();
  if (!pem && !keyId) return null;
  const problem = !pem
    ? new GitTicketSignerConfigError(GIT_TICKET_SIGNING_KEY_ENV, "missing")
    : !keyId
      ? new GitTicketSignerConfigError(GIT_TICKET_KEY_ID_ENV, "missing")
      : !KEY_ID.test(keyId)
        ? new GitTicketSignerConfigError(GIT_TICKET_KEY_ID_ENV, "invalid")
        : null;
  if (problem) {
    reportError(problem, { stage: "runner.git_ticket_config" });
    return null;
  }
  try {
    const privateKey = createPrivateKey(pem!.replace(/\\n/g, "\n"));
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("not ed25519");
    return { keyId: keyId!, privateKey };
  } catch {
    reportError(new GitTicketSignerConfigError(GIT_TICKET_SIGNING_KEY_ENV, "invalid"), { stage: "runner.git_ticket_config" });
    return null;
  }
}
