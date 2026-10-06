import { LocalRunnerRefused } from "../types.js";
import { detectDeployedEnvironment, isLocalRuntimeOptedIn } from "../env-detect.js";

/**
 * Two independent gates, both of which must pass (Spec H04 pass/fail 1;
 * fix-round 1 item 3; fix-round 2 item 4):
 *
 *   1. Deny-list: refuse if `detectDeployedEnvironment` sees Vercel-shaped
 *      env vars or a production NODE_ENV, in either the passed-in env or
 *      the real `process.env` — so `createLocalRuntime({})` can't be used
 *      to dodge the check while the process itself is deployed.
 *   2. Allow-list: refuse UNLESS `FX_RUNTIME=local` is explicitly set. This
 *      exists because the deny-list above cannot be trusted alone — Vercel
 *      exposes its System Environment Variables only when a project opts
 *      in (see env-detect.ts's module doc comment), so a real deployment
 *      with that setting off would show none of the signals gate 1 looks
 *      for. Gate 2 doesn't depend on Vercel exposing anything: a
 *      production process never has FX_RUNTIME=local set, regardless of
 *      what Vercel does or doesn't expose to it.
 */
export function assertLocalRunnerAllowed(env: NodeJS.ProcessEnv): void {
  const deployed = detectDeployedEnvironment(env);
  if (deployed) {
    throw new LocalRunnerRefused(
      `local runner refused: ${deployed.reason} (this is not the owner's machine)`,
    );
  }
  if (!isLocalRuntimeOptedIn(env)) {
    throw new LocalRunnerRefused(
      "local runner refused: FX_RUNTIME=local was not set (opt-in required, in either the passed env or process.env)",
    );
  }
}
