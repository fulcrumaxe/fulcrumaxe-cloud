import { createPrivateKey } from "node:crypto";
import { createJobSigner, type JobSigner } from "@fx/runner";

/**
 * D#6 R3b: the job-signing key, read from the process environment HERE and nowhere else (the worker's composition root
 * calls this once). The key goes straight into a `JobSigner` closure; no other module sees it, and `packages/runner/src`
 * reads no `process.env`.
 *
 *  - `FX_RUNNER_JOB_SIGNING_KEY_PEM`: the Ed25519 private key, PKCS#8 PEM. A `\n` written as two characters (how a single-line
 *    secret field often stores a PEM) is accepted.
 *  - `FX_RUNNER_JOB_SIGNER_ID`: the `key_id` a runner uses to find the matching public key.
 *
 * Neither set: `null`, and a run for a `runner_local` repo cannot be dispatched (the target's issuer throws, so the run
 * fails; nothing is queued). Exactly one set, or a key that is not an Ed25519 private key, or an id that does not fit the
 * job schema: a startup error that names the variable and never its value.
 */
export const JOB_SIGNING_KEY_ENV = "FX_RUNNER_JOB_SIGNING_KEY_PEM";
export const JOB_KEY_ID_ENV = "FX_RUNNER_JOB_SIGNER_ID";

const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;

export class JobSignerConfigError extends Error {
  constructor(readonly variable: string, readonly problem: "missing" | "invalid") {
    super(`runner job signer: ${variable} is ${problem}`);
    this.name = "JobSignerConfigError";
  }
}

export function loadJobSigner(env: Readonly<Record<string, string | undefined>>): JobSigner | null {
  const pem = env[JOB_SIGNING_KEY_ENV]?.trim();
  const keyId = env[JOB_KEY_ID_ENV]?.trim();
  if (!pem && !keyId) return null;
  if (!pem) throw new JobSignerConfigError(JOB_SIGNING_KEY_ENV, "missing");
  if (!keyId) throw new JobSignerConfigError(JOB_KEY_ID_ENV, "missing");
  if (!KEY_ID.test(keyId)) throw new JobSignerConfigError(JOB_KEY_ID_ENV, "invalid");
  try {
    return createJobSigner({ keyId, privateKey: createPrivateKey(pem.replace(/\\n/g, "\n")) });
  } catch {
    throw new JobSignerConfigError(JOB_SIGNING_KEY_ENV, "invalid");
  }
}
