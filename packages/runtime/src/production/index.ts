import { SubscriptionCredentialsRefused } from "../types.js";
import type { AgentHandle, AgentRuntime, ModelConnectionStatus, SandboxSpec, StartOptions } from "../types.js";
import { assertNoSubscriptionCredentials, assertSandboxSpecAllowed } from "./guard.js";

/**
 * Runner (b) delegates the actual sandbox lifecycle to caller-supplied
 * dependencies. H04 owns the construction/start-time refusal rules (Spec
 * pass/fail 2); H09 owns wiring these to a real `@vercel/sandbox` — see the
 * Spec's "Sandbox wiring is completed in H09" note. Keeping the boundary
 * here means this package has zero dependency on H09/H02 and every test
 * below runs against a fake sandbox, at zero model tokens.
 */
export interface ProductionDeps {
  getConnectionStatus(tenantId: string): Promise<ModelConnectionStatus>;
  launchSandbox(opts: StartOptions & { sandboxSpec: SandboxSpec }): Promise<{ handle: AgentHandle }>;
  stopSandbox(handle: AgentHandle): Promise<void>;
  resumeSandbox(handle: AgentHandle, sessionId: string, prompt: string): Promise<{ handle: AgentHandle }>;
}

/** `AgentRuntime.resume` doesn't take a `sandboxSpec` — only `start` does —
 * so `start` stashes the spec it validated onto the handle it returns, and
 * `resume` reads it back off (Spec H04 fix-round item 5: `resume` used to
 * skip `assertSandboxSpecAllowed` and the connection-status check
 * entirely, calling `deps.resumeSandbox` directly). */
interface ProductionHandle extends AgentHandle {
  _sandboxSpec?: SandboxSpec;
}

export function createProductionRuntime(env: NodeJS.ProcessEnv, deps: ProductionDeps): AgentRuntime {
  assertNoSubscriptionCredentials(env);
  // Also check the REAL process.env, not just the passed-in one (fix-round
  // 2 item 1) — mirrors env-detect.ts's `detectDeployedEnvironment`, which
  // does the same for the local runner: a caller constructing this runtime
  // with a curated/empty `env` object cannot use that to hide a
  // subscription credential that is actually sitting in the process.
  if (env !== process.env) {
    assertNoSubscriptionCredentials(process.env);
  }

  async function assertCanRun(spec: SandboxSpec): Promise<void> {
    assertSandboxSpecAllowed(spec);
    const status = await deps.getConnectionStatus(spec.tenantId);
    if (status !== "ok") {
      throw new SubscriptionCredentialsRefused(
        `production runner refused: model connection status is "${status}", not "ok"`,
      );
    }
  }

  return {
    async start(opts) {
      if (!opts.sandboxSpec) {
        throw new SubscriptionCredentialsRefused("production runner refused: no sandboxSpec provided");
      }
      await assertCanRun(opts.sandboxSpec);

      const { handle } = await deps.launchSandbox({ ...opts, sandboxSpec: opts.sandboxSpec });
      const stamped: ProductionHandle = { ...handle, _sandboxSpec: opts.sandboxSpec };
      return { handle: stamped };
    },
    stop(handle) {
      return deps.stopSandbox(handle);
    },
    async resume(handle, sessionId, prompt) {
      const spec = (handle as ProductionHandle)._sandboxSpec;
      if (!spec) {
        throw new SubscriptionCredentialsRefused(
          "production runner refused: cannot resume a handle with no recorded sandboxSpec — re-checking the sandbox env and model connection needs one",
        );
      }
      await assertCanRun(spec);
      const { handle: resumedHandle } = await deps.resumeSandbox(handle, sessionId, prompt);
      const stamped: ProductionHandle = { ...resumedHandle, _sandboxSpec: spec };
      return { handle: stamped };
    },
  };
}
