import { SK_ANT_OAT_PATTERN_SOURCE } from "./redact.js";

/**
 * The operator exception to "no subscription credential on a hosted sandbox".
 *
 * Our own Claude subscription may power runs started by our own account(s), and nobody
 * else's. The credential never enters a sandbox: the sandbox gets a fixed placeholder and
 * the firewall puts the real token on the wire (packages/runner/src/networkPolicy.ts).
 *
 * This module is the ONE place that decides whether an account gets that path. It reads
 * three settings, all of which must hold:
 *   - FX_OPERATOR_SUBSCRIPTION is exactly "on" (the kill switch);
 *   - FX_OPERATOR_ACCOUNT_IDS is a comma-separated list of account UUIDs and the account is on it;
 *   - FX_OPERATOR_CLAUDE_OAUTH_TOKEN is a subscription-token-shaped value.
 * Anything else (blank, malformed, a different spelling of "on") is off, and the caller
 * follows the ordinary rules. A malformed list turns the whole feature off rather than
 * guessing which entries were meant.
 *
 * Decisions carry reasons, never values. Only `operatorTokenFor` returns the token, and
 * only for accounts the decision admits.
 */

export const OPERATOR_TOKEN_ENV = "FX_OPERATOR_CLAUDE_OAUTH_TOKEN";
export const OPERATOR_ACCOUNT_IDS_ENV = "FX_OPERATOR_ACCOUNT_IDS";
export const OPERATOR_SWITCH_ENV = "FX_OPERATOR_SUBSCRIPTION";

/** The fixed, non-secret value the sandbox's CLI holds in operator mode. The firewall replaces it on the wire. */
export const OPERATOR_OAUTH_PLACEHOLDER = "brokered-at-firewall";

export type OperatorEnv = Readonly<Record<string, string | undefined>>;

export type OperatorRefusal = "switch_off" | "account_list_missing" | "account_list_invalid" | "token_missing" | "token_invalid" | "not_operator_account";

export type OperatorDecision = { active: true } | { active: false; reason: OperatorRefusal };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = new RegExp(`^${SK_ANT_OAT_PATTERN_SOURCE}$`);

// Direct property reads, one per setting, so the settings manifest's coverage scan sees each name.
// `Object.hasOwn` keeps an inherited property (a polluted prototype) from counting as a setting.
const asString = (value: string | undefined): string | undefined => (typeof value === "string" ? value : undefined);
const readSwitch = (env: OperatorEnv): string | undefined => (Object.hasOwn(env, OPERATOR_SWITCH_ENV) ? asString(env.FX_OPERATOR_SUBSCRIPTION) : undefined);
const readAccountIds = (env: OperatorEnv): string | undefined => (Object.hasOwn(env, OPERATOR_ACCOUNT_IDS_ENV) ? asString(env.FX_OPERATOR_ACCOUNT_IDS) : undefined);
const readToken = (env: OperatorEnv): string | undefined => (Object.hasOwn(env, OPERATOR_TOKEN_ENV) ? asString(env.FX_OPERATOR_CLAUDE_OAUTH_TOKEN) : undefined);

/** The listed account ids (lower case), or null when the value is blank or any entry is not a UUID. */
export function parseOperatorAccountIds(raw: string | undefined): ReadonlySet<string> | null {
  if (raw === undefined || raw.trim() === "") return null;
  const ids = raw.split(",").map((part) => part.trim());
  if (ids.some((id) => !UUID_RE.test(id))) return null;
  return new Set(ids.map((id) => id.toLowerCase()));
}

/** True when `value` has the shape the setup-token command prints. Shape only: whether it is live is for Anthropic to say. */
export function isOperatorTokenShape(value: string | undefined): boolean {
  return typeof value === "string" && TOKEN_RE.test(value);
}

/** Whether `accountId` gets the operator subscription path under `env`. Never returns or logs a value. */
export function operatorMode(env: OperatorEnv, accountId: string): OperatorDecision {
  if (readSwitch(env) !== "on") return { active: false, reason: "switch_off" };
  const rawList = readAccountIds(env);
  if (rawList === undefined || rawList.trim() === "") return { active: false, reason: "account_list_missing" };
  const ids = parseOperatorAccountIds(rawList);
  if (ids === null) return { active: false, reason: "account_list_invalid" };
  const token = readToken(env);
  if (token === undefined || token === "") return { active: false, reason: "token_missing" };
  if (!isOperatorTokenShape(token)) return { active: false, reason: "token_invalid" };
  if (typeof accountId !== "string" || !UUID_RE.test(accountId) || !ids.has(accountId.toLowerCase())) return { active: false, reason: "not_operator_account" };
  return { active: true };
}

/**
 * The operator token, only when EVERY named account is admitted (a run's own account and its
 * payer must both be operator accounts), else undefined. The one reader of the token.
 */
export function operatorTokenFor(env: OperatorEnv, ...accountIds: string[]): string | undefined {
  if (accountIds.length === 0) return undefined;
  for (const id of accountIds) if (!operatorMode(env, id).active) return undefined;
  return readToken(env);
}
