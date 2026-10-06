import { reportError } from "@fx/telemetry";
import type { AppKind } from "./appCredentials.js";

/**
 * D#2 H17a: confirms an install callback's `installation_id` against the
 * signed-in user's OWN GitHub access, because the query parameter can be
 * forged (GitHub, "About the setup URL"). The one-time `code` is exchanged
 * for a user token with that kind's App client id and secret, the user's
 * installations are listed, and the id must be among them AND belong to
 * this kind's App. H17e: the same token then reads `GET /user`, and the numeric
 * GitHub user id is returned so the caller can compare it with the recorded
 * installer. The token lives in this function only: never returned, stored or
 * logged. Every failure is `null`, with no message.
 */

/** Per-kind OAuth client credentials of each GitHub App. Owner deploy action. */
export const OAUTH_ENV_NAMES: Record<AppKind, { clientId: string; clientSecret: string }> = {
  team: { clientId: "GITHUB_APP_TEAM_CLIENT_ID", clientSecret: "GITHUB_APP_TEAM_CLIENT_SECRET" },
  team_readonly: {
    clientId: "GITHUB_APP_TEAM_READONLY_CLIENT_ID",
    clientSecret: "GITHUB_APP_TEAM_READONLY_CLIENT_SECRET",
  },
  sitekit: { clientId: "GITHUB_APP_SITEKIT_CLIENT_ID", clientSecret: "GITHUB_APP_SITEKIT_CLIENT_SECRET" },
};

const MAX_PAGES = 10;
const PER_PAGE = 100;
const TIMEOUT_MS = 10_000;

export interface VerifyUserInstallationInput {
  kind: AppKind;
  code: string;
  ghInstallationId: number;
  /** The App id of `kind` (from appCredentials). */
  appId: string;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

async function getJson(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<unknown | null> {
  const res = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return null;
  return res.json();
}

export async function verifyUserInstallation(input: VerifyUserInstallationInput): Promise<number | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const names = OAUTH_ENV_NAMES[input.kind];
  const clientId = input.env[names.clientId];
  const clientSecret = input.env[names.clientSecret];
  if (!clientId || !clientSecret) return null;
  try {
    const exchanged = (await getJson(fetchImpl, "https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code: input.code }),
    })) as { access_token?: unknown } | null;
    const token = exchanged?.access_token;
    if (typeof token !== "string" || token === "") return null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = (await getJson(fetchImpl, `https://api.github.com/user/installations?per_page=${PER_PAGE}&page=${page}`, {
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
      })) as { installations?: Array<{ id?: unknown; app_id?: unknown }> } | null;
      const list = body?.installations;
      if (!Array.isArray(list)) return null;
      const hit = list.find((i) => i.id === input.ghInstallationId);
      if (hit) {
        if (String(hit.app_id) !== input.appId) return null;
        const user = (await getJson(fetchImpl, "https://api.github.com/user", {
          headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
        })) as { id?: unknown } | null;
        return typeof user?.id === "number" && Number.isSafeInteger(user.id) && user.id > 0 ? user.id : null;
      }
      if (list.length < PER_PAGE) return null;
    }
    return null;
  } catch (err) {
    reportError(err, { stage: "github.user_installations" });
    return null;
  }
}
