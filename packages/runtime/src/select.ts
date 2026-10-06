import { createFakeRuntime } from "./fake/index.js";
import { detectDeployedEnvironment, hasAnyVercelEnvVar } from "./env-detect.js";
import type { AgentRuntime } from "./types.js";

/**
 * Neither factory type below is a static import of the runtime it builds
 * (Spec H04 fix-round item 1 / CWE-489): this file must stay importable
 * without pulling in `./local/index.js` — and therefore
 * `@anthropic-ai/claude-agent-sdk` — even though it can still *select* the
 * local runner. A caller that actually wants runner (a) available imports
 * it itself (see `src/local/index.ts`) and passes it in as `createLocal`;
 * `test/bundle-isolation.test.ts` bundles this file with esbuild and fails
 * if the SDK or the local runner's marker ever show up in the output,
 * which is what catches a static import creeping back in.
 */
export type ProductionDepsFactory = (env: NodeJS.ProcessEnv) => AgentRuntime;
export type LocalRuntimeFactory = (env: NodeJS.ProcessEnv) => AgentRuntime;

function isUnderTest(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === "test" || env.FX_FORBID_MODEL_CALLS === "1";
}

/**
 * Table-driven runtime selection (Spec H04 pass/fail 3):
 *   - any VERCEL* var set (in `env` or `process.env`) → runner (b), production
 *   - FX_RUNTIME=local, no VERCEL* anywhere            → runner (a), local
 *   - otherwise, under test                             → the fake runner
 *   - otherwise                                         → throws
 *
 * Both `createProduction` and `createLocal` are caller-supplied factories:
 * production because selecting a runtime should never force a real
 * `@vercel/sandbox` or tenant DB lookup at import time, local because it
 * must never force the `@anthropic-ai/claude-agent-sdk` dependency (or the
 * marker that identifies runner (a)'s entry point) into this module's own
 * bundle. `fixtureDir` picks where the fake runner reads its fixtures from.
 */
export function selectRuntime(
  env: NodeJS.ProcessEnv,
  opts: {
    createProduction?: ProductionDepsFactory;
    createLocal?: LocalRuntimeFactory;
    fixtureDir?: string;
  } = {},
): AgentRuntime {
  if (hasAnyVercelEnvVar(env) || hasAnyVercelEnvVar(process.env)) {
    if (!opts.createProduction) {
      throw new Error(
        "selectRuntime: a VERCEL* var is set but no createProduction factory was supplied",
      );
    }
    return opts.createProduction(env);
  }

  if (env.FX_RUNTIME === "local") {
    if (!opts.createLocal) {
      throw new Error(
        "selectRuntime: FX_RUNTIME=local but no createLocal factory was supplied — " +
          'import createLocalRuntime from "@fx/runtime/local" (or ./local/index.js) and pass it in',
      );
    }
    // Independent refusal, not a delegation to the factory (fix-round 2
    // item 5): the real `createLocalRuntime` already refuses via
    // src/local/guard.ts, but `createLocal` here is caller-supplied — a
    // test double, or a future real implementation that forgot its own
    // check — so selectRuntime must not rely on it doing the right thing.
    // Refuses on the SAME signal the real guard uses, whatever factory it
    // was given.
    const deployed = detectDeployedEnvironment(env);
    if (deployed) {
      throw new Error(`selectRuntime: refusing to call createLocal — ${deployed.reason}`);
    }
    return opts.createLocal(env);
  }

  if (isUnderTest(env)) {
    return createFakeRuntime(opts.fixtureDir ?? "fixtures/agent-outputs");
  }

  throw new Error(
    "selectRuntime: no runtime resolved — set FX_RUNTIME=local for local dev, or run under test " +
      "(VITEST / NODE_ENV=test / FX_FORBID_MODEL_CALLS=1) to use the fake runtime",
  );
}
