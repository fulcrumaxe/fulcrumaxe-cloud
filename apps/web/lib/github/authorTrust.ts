import { INSTALLATION_APP_KINDS } from "@fx/core/src/repos/appKinds.js";
import { AppCredentialsError, loadAppCredentials, readAppBotLogin } from "@fx/github";
import type { AuthorTrustInputs } from "@fx/pipeline";
import { createPinnedAppFetch } from "./installationHttp";
import { intakeAllowlist } from "./intakeTrust";

/**
 * D#598 P1d-1 (R-P1d-3 (a) and (b)): the two inputs of the merge gate's author rule that only this app can supply. The three web callers of the gate (the review
 * stage, the merge queue's tick through it, the runner's merge order) all pass this one object, so they cannot disagree about who the platform trusts.
 *
 * The bot logins are the `<slug>[bot]` accounts of every App kind that is configured here. A kind with no credentials is skipped (no such App can have opened
 * a pull request); a kind that is configured and cannot be asked about throws, which the author rule reads as "could not check", never as trusted.
 */
export async function platformBotLogins(env: Record<string, string | undefined> = process.env): Promise<string[]> {
  const credentialsFor = loadAppCredentials(env);
  const logins: string[] = [];
  for (const kind of INSTALLATION_APP_KINDS) {
    let credentials;
    try {
      credentials = credentialsFor(kind);
    } catch (error) {
      if (error instanceof AppCredentialsError && error.message.includes("not_configured (")) continue;
      throw error;
    }
    logins.push(await readAppBotLogin({ appId: credentials.appId, privateKeyPem: credentials.privateKeyPem, fetchImpl: createPinnedAppFetch() }));
  }
  return logins;
}

export const mergeGateAuthorTrust: AuthorTrustInputs = { botLogins: () => platformBotLogins(), allowlist: () => intakeAllowlist() };
