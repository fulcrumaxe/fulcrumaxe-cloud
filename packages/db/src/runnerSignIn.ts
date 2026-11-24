/**
 * D#845 ON-10b1 (Ruling 88, 88.0a): how Claude is signed in on a machine, as one derived fact. There is no stored column: both inputs are on `runners` and
 * readable by the web login and the runner login under tenant isolation.
 *
 *   not revoked, model_auth_present = true, credential_mode = 'subscription'  ->  subscription
 *   not revoked, model_auth_present = true, credential_mode = 'api_key'       ->  api_key
 *   anything else (auth false, auth NULL, revoked, no row)                    ->  unknown
 *
 * `credential_mode` is set at registration from the code or token a member minted and never changes; `model_auth_present` is the latest hello's answer
 * about a login of that mode. The helper reads those two columns and `revoked_at`, nothing else (no file, no credential). Each consumer applies its own
 * policy to the value: the survey seat treats `unknown` as an API key, the usage card shows no line for it.
 */
export type RunnerSignInKind = "subscription" | "api_key" | "unknown";

/** The three columns the fact is made of. A missing row is `null`/`undefined`. */
export interface RunnerSignInRow {
  credential_mode: string | null;
  model_auth_present: boolean | null;
  revoked_at: Date | string | null;
}

export function runnerSignInKind(row: RunnerSignInRow | null | undefined): RunnerSignInKind {
  if (row === null || row === undefined) return "unknown";
  const { credential_mode, model_auth_present, revoked_at } = row;
  if (revoked_at !== null && revoked_at !== undefined) return "unknown";
  if (model_auth_present !== true) return "unknown";
  return credential_mode === "subscription" ? "subscription" : credential_mode === "api_key" ? "api_key" : "unknown";
}

/** A plain SQL identifier, so the alias can never carry anything else into a query. */
const ALIAS = /^[a-z_][a-z0-9_]{0,30}$/;

/** The same rule as an SQL expression over a `runners` row aliased `alias`. It reads `credential_mode`, `model_auth_present` and `revoked_at` only. */
export function RUNNER_SIGN_IN_KIND_SQL(alias: string): string {
  if (!ALIAS.test(alias)) throw new TypeError("RUNNER_SIGN_IN_KIND_SQL: the alias is not a plain identifier");
  return `(CASE WHEN ${alias}.revoked_at IS NULL AND ${alias}.model_auth_present IS TRUE THEN (CASE ${alias}.credential_mode WHEN 'subscription' THEN 'subscription' WHEN 'api_key' THEN 'api_key' ELSE 'unknown' END) ELSE 'unknown' END)`;
}
