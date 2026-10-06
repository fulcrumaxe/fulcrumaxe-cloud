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
}

export type InstallationRecheck = (input: RecheckInput) => Promise<boolean>;

export const recheckInstallationActive: InstallationRecheck = async (input) => {
  try {
    const jwt = await mintAppJwt(input.appId, input.privateKeyPem);
    const res = await (input.fetchImpl ?? fetch)(`https://api.github.com/app/installations/${input.ghInstallationId}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${jwt}`, "x-github-api-version": "2022-11-28" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 200) return false;
    const body = (await res.json()) as { id?: unknown; app_id?: unknown; suspended_at?: unknown } | null;
    return body?.id === input.ghInstallationId && String(body.app_id) === input.appId && body.suspended_at === null;
  } catch (err) {
    reportError(err, { stage: "github.recheck_installation" });
    return false;
  }
};
