/**
 * "Does this look like a deployed environment?" — one definition, shared by
 * the local runner's guard and `selectRuntime`, so there is exactly one
 * place that knows what Vercel sets (Spec H04 fix-round 1 item 3;
 * previously duplicated as two copies of the same four-name list, which is
 * also what let `VERCEL_DEPLOYMENT_ID` / `VERCEL_TARGET_ENV` alone slip
 * through both).
 *
 * This heuristic is a deny-list, and fix-round 2 item 4 is the reason it
 * cannot be the ONLY gate: Vercel's System Environment Variables — `VERCEL`
 * included — are an opt-in project setting ("Enable access to System
 * Environment Variables", vercel.com/docs/environment-variables/
 * system-environment-variables). A deployment with that setting off exposes
 * NONE of these vars, so `detectDeployedEnvironment` alone would wrongly
 * say "not deployed" for a process that genuinely is. `src/local/guard.ts`
 * closes that gap with an independent ALLOW-list requirement
 * (`FX_RUNTIME=local` must be explicitly set) that this deny-list heuristic
 * complements rather than replaces.
 */

/**
 * Vercel CLI auth/link config vars — present on an ordinary dev machine
 * that has ever run `vercel link` or exported a personal token for CI.
 * `VERCEL_ORG_ID` and `VERCEL_TOKEN` are CLI-only. `VERCEL_PROJECT_ID` is
 * NOT CLI-only — Vercel's own docs list it as a genuine system environment
 * variable, "Available at: Both build and runtime" — so its presence is
 * simply not a reliable signal either way: `vercel link` sets it locally,
 * and (when System Environment Variables are enabled) a real deployment
 * sets it too. Excluding all three from the prefix match is not "these are
 * safe names"; it is "this particular heuristic can't tell, so don't let it
 * cast a false positive on top of a false negative it already has no way to
 * detect" — the actual authority for "is the local runner allowed to run
 * here" is the opt-in check in `src/local/guard.ts`, below.
 *
 * This is not a hypothetical: this package's own dev shell has all three
 * set, which is exactly what surfaced the original problem — a blanket
 * `VERCEL*` prefix match refused to construct the local runner on the
 * owner's own machine, defeating H04's entire purpose (owner constraint A:
 * a local runner that works without spending API tokens).
 *
 * Vercel's own runtime-only signals — `VERCEL_ENV`, `VERCEL_URL`,
 * `VERCEL_REGION`, `VERCEL_DEPLOYMENT_ID`, `VERCEL_TARGET_ENV`,
 * `VERCEL_GIT_*`, and others Vercel has added over time — are, when exposed
 * at all, populated by the platform automatically inside a
 * Function/Sandbox/Workflow/Build. `vercel link` and a CLI login populate
 * only the three below, so excluding exactly them keeps the broadened
 * prefix match (fix-round 1 item 3) from tripping on an ordinary dev
 * machine while still catching any current or future Vercel-exposed
 * variable name — when that exposure is turned on at all.
 */
const VERCEL_CLI_ONLY_KEYS: ReadonlySet<string> = new Set([
  "VERCEL_ORG_ID",
  "VERCEL_PROJECT_ID",
  "VERCEL_TOKEN",
]);

function isVercelKey(key: string): boolean {
  return key.startsWith("VERCEL") && !VERCEL_CLI_ONLY_KEYS.has(key);
}

function isNonEmpty(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

/** Returns the first Vercel-shaped env var name present with a non-empty
 * value, or undefined. Exposed (not just a boolean) so refusal messages can
 * say which variable triggered them. */
export function findVercelEnvKey(env: NodeJS.ProcessEnv): string | undefined {
  return Object.keys(env).find((key) => isVercelKey(key) && isNonEmpty(env[key]));
}

export function hasAnyVercelEnvVar(env: NodeJS.ProcessEnv): boolean {
  return findVercelEnvKey(env) !== undefined;
}

/** True if NODE_ENV resolves to "production", tolerant of case and
 * surrounding whitespace ("Production", " production " both count). */
export function isProductionNodeEnv(env: NodeJS.ProcessEnv): boolean {
  const value = env.NODE_ENV;
  return typeof value === "string" && value.trim().toLowerCase() === "production";
}

/** True if FX_RUNTIME=local is explicitly set, in either the passed env or
 * the real process.env — the opt-in half of local-runner gating (fix-round
 * 2 item 4). Deployed-environment detection above is a deny-list that can
 * miss a real deployment (System Environment Variables are opt-in on
 * Vercel's side); this is the allow-list that a production process would
 * never have set, regardless of what Vercel does or doesn't expose. */
export function isLocalRuntimeOptedIn(env: NodeJS.ProcessEnv): boolean {
  return env.FX_RUNTIME === "local" || process.env.FX_RUNTIME === "local";
}

export interface DeployedEnvironmentReason {
  reason: string;
}

/**
 * Checks BOTH the env explicitly passed in AND the real `process.env`, so a
 * caller cannot bypass detection by constructing a runtime with an
 * empty/curated env object while the process itself is actually running on
 * Vercel (Spec H04 fix-round 1 item 3 — `createLocalRuntime({})` used to
 * skip every check because the guard only ever looked at its argument).
 */
export function detectDeployedEnvironment(
  env: NodeJS.ProcessEnv,
): DeployedEnvironmentReason | undefined {
  const vercelKey = findVercelEnvKey(env) ?? findVercelEnvKey(process.env);
  if (vercelKey) return { reason: `${vercelKey} is set` };
  if (isProductionNodeEnv(env) || isProductionNodeEnv(process.env)) {
    return { reason: "NODE_ENV is production" };
  }
  return undefined;
}
