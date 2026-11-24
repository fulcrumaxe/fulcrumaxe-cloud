import { reportError } from "@fx/telemetry";
import { mintAppJwt } from "./installationToken.js";

/**
 * D#2 H17e (C57 R4): the live "is it still active" check, run immediately
 * before an installation is bound. It asks GitHub, with this kind's App JWT,
 * for the installation itself and passes only on a 200 whose `app_id` is this
 * kind's App and whose `suspended_at` is null. A 404 (removed), another App's
 * id, a suspension, a network error or a bad key all read as `false`. The JWT
 * lives in this function only; nothing is logged.
 */
export interface RecheckInput {
  appId: string;
  privateKeyPem: string;
  ghInstallationId: number;
  fetchImpl?: typeof fetch;
  /** Replaces the default 10 s deadline of the one request. */
  signal?: AbortSignal;
}

export type InstallationRecheck = (input: RecheckInput) => Promise<boolean>;

class InstallationStatusError extends Error {}

/** `GET /app/installations/{id}` with this kind's App JWT: the body on a 200, or `null` on a 404. Any other answer, or a failure to ask, throws. */
async function readInstallationBody(input: RecheckInput): Promise<Record<string, unknown> | null> {
  const jwt = await mintAppJwt(input.appId, input.privateKeyPem);
  const res = await (input.fetchImpl ?? fetch)(`https://api.github.com/app/installations/${input.ghInstallationId}`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${jwt}`, "x-github-api-version": "2022-11-28" },
    redirect: "error",
    signal: input.signal ?? AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new InstallationStatusError(`installation read answered ${res.status}`);
  return (await res.json()) as Record<string, unknown> | null;
}

export const recheckInstallationActive: InstallationRecheck = async (input) => {
  try {
    const body = await readInstallationBody(input);
    return body?.id === input.ghInstallationId && String(body.app_id) === input.appId && body.suspended_at === null;
  } catch (err) {
    if (err instanceof InstallationStatusError) return false; // an answer other than 200 or 404 was never reported here
    reportError(err, { stage: "github.recheck_installation" });
    return false;
  }
};

/** The GitHub account an installation sits on: what `create-intent` calls an owner. */
export interface InstallationAccount {
  gh_id: number;
  login: string;
}

/**
 * D#845 ON-7b: the account (user or organisation) this installation is on, read live. `null` when the installation is gone (404), suspended, another App's, or names no usable
 * account: it is then not an owner a repo can be created under. Throws when GitHub cannot be asked or does not answer cleanly, so the caller can tell "none" from "could not check".
 * Nothing is stored here.
 */
export async function readInstallationAccount(input: RecheckInput): Promise<InstallationAccount | null> {
  const body = await readInstallationBody(input);
  if (!body || body.id !== input.ghInstallationId || String(body.app_id) !== input.appId || body.suspended_at !== null) return null;
  const account = body.account as { id?: unknown; login?: unknown } | null | undefined;
  if (!account || typeof account.id !== "number" || !Number.isSafeInteger(account.id) || account.id <= 0) return null;
  if (typeof account.login !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(account.login)) return null;
  return { gh_id: account.id, login: account.login };
}
