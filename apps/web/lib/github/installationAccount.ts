import { loadAppCredentials, readInstallationAccount, type InstallationAccount } from "@fx/github";

/**
 * D#845 ON-7b: the live read behind the repo picker's owners. For one team installation it asks GitHub (`GET /app/installations/{id}`, with the team App's JWT, through
 * `readInstallationAccount`) which account the installation sits on. Asked on every call; the caller keeps an answer for at most 60 s in memory. Nothing is stored here. A missing
 * App configuration throws, which the picker reports as "owners unknown".
 */
export function createInstallationAccountReader(deps: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch } = {}) {
  return async (ghInstallationId: number, signal: AbortSignal): Promise<InstallationAccount | null> => {
    const creds = loadAppCredentials(deps.env ?? process.env)("team");
    return readInstallationAccount({ appId: creds.appId, privateKeyPem: creds.privateKeyPem, ghInstallationId, fetchImpl: deps.fetchImpl, signal });
  };
}
