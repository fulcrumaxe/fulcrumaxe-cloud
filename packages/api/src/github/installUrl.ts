import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { INSTALLATION_APP_KINDS, type InstallationAppKind } from "@fx/core/src/repos/appKinds.js";

/**
 * D#31 API-8c: the GitHub App install URL and its signed `state`.
 *
 * This file only MINTS the state. `verifyInstallState` is exported as a
 * pure function for the install callback (H13 / H17) to import later; the
 * callback itself is not part of this task.
 *
 * Nothing here logs, and every error is fixed text: no env value, slug or
 * secret ever reaches a message.
 */

export const INSTALL_STATE_TTL_SECONDS = 10 * 60;
const MIN_SECRET_BYTES = 32;
const SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Each kind has its own slug env. There is no fallback from one kind to another. */
const SLUG_ENV: Record<InstallationAppKind, string> = {
  team: "GITHUB_APP_TEAM_SLUG",
  team_readonly: "GITHUB_APP_TEAM_READONLY_SLUG",
  sitekit: "GITHUB_APP_SITEKIT_SLUG",
};

export function isInstallationAppKind(value: unknown): value is InstallationAppKind {
  return typeof value === "string" && (INSTALLATION_APP_KINDS as readonly string[]).includes(value);
}

/** The chosen kind's slug or the state secret is unset, malformed or too short. Fixed message: no env value is echoed. */
export class GithubAppNotConfiguredError extends Error {
  constructor() {
    super("the GitHub App install is not configured");
    this.name = "GithubAppNotConfiguredError";
  }
}

export interface InstallStateClaims {
  account_id: string;
  user_id: string;
  app_kind: InstallationAppKind;
  nonce: string;
  /** Unix seconds. */
  exp: number;
}

function sign(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function mintInstallState(
  input: { accountId: string; userId: string; appKind: InstallationAppKind },
  secret: string,
  now: Date = new Date(),
): string {
  const claims: InstallStateClaims = {
    account_id: input.accountId,
    user_id: input.userId,
    app_kind: input.appKind,
    nonce: randomBytes(16).toString("base64url"),
    exp: Math.floor(now.getTime() / 1000) + INSTALL_STATE_TTL_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${sign(payload, secret).toString("base64url")}`;
}

/**
 * Returns the claims when `state` was signed with `secret`, has not
 * expired, and was minted for `expectedAppKind`; otherwise null. The
 * signature is compared in constant time before the payload is parsed.
 */
export function verifyInstallState(
  state: string,
  secret: string,
  expectedAppKind: InstallationAppKind,
  now: Date = new Date(),
): InstallStateClaims | null {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [payload, mac] = parts as [string, string];
  if (!BASE64URL.test(payload) || !BASE64URL.test(mac)) return null;
  const given = Buffer.from(mac, "base64url");
  const expected = sign(payload, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    // fx-swallow-ok: a signed state whose payload is not JSON is refused like any other bad state (null); nothing failed
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const c = claims as Record<string, unknown>;
  if (
    typeof c.account_id !== "string" ||
    typeof c.user_id !== "string" ||
    typeof c.nonce !== "string" ||
    typeof c.exp !== "number" ||
    !isInstallationAppKind(c.app_kind)
  ) {
    return null;
  }
  if (c.app_kind !== expectedAppKind) return null;
  if (c.exp <= Math.floor(now.getTime() / 1000)) return null;
  return { account_id: c.account_id, user_id: c.user_id, app_kind: c.app_kind, nonce: c.nonce, exp: c.exp };
}

/** Throws GithubAppNotConfiguredError unless this kind's slug and the state secret are both valid. */
export function buildInstallUrl(
  input: { accountId: string; userId: string; appKind: InstallationAppKind },
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): string {
  const slug = env[SLUG_ENV[input.appKind]];
  const secret = env.GITHUB_INSTALL_STATE_SECRET;
  if (!slug || !SLUG_PATTERN.test(slug)) throw new GithubAppNotConfiguredError();
  if (!secret || Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) throw new GithubAppNotConfiguredError();
  const state = mintInstallState(input, secret, now);
  return `https://github.com/apps/${slug}/installations/new?state=${state}`;
}
