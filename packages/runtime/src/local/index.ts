import { query } from "@anthropic-ai/claude-agent-sdk";
import { redactDeep, redactError } from "../redact.js";
import { normalizeMessage } from "../streamJson.js";
import type { AgentHandle, AgentRuntime, StartOptions } from "../types.js";
import { assertLocalRunnerAllowed } from "./guard.js";

/**
 * Grepped for by a test (and, later, by CI) to confirm this file is the
 * local-dev runner's entry point — Spec H04 pass/fail 4. Its presence here,
 * paired with the "no file under apps/web imports packages/runtime/src/local"
 * check, is what keeps the local runner out of the deployable bundle.
 *
 * Fix-round item 1: a bundler tree-shakes an unused named export even when
 * other exports from the same module are kept, so a bundle that pulls in
 * `createLocalRuntime` (because something still imports it) could drop this
 * constant entirely if nothing else referenced it — the marker would then
 * be absent from a bundle that DOES contain the local runner and the SDK,
 * which is exactly backwards. `markerLiveInBundle()` gives `createLocalRuntime`
 * itself a real (if trivial) runtime dependency on the constant, so the
 * marker string is guaranteed to survive in the compiled output of ANY
 * bundle that keeps `createLocalRuntime` — see
 * `test/bundle-isolation.test.ts`.
 */
export const FX_LOCAL_RUNNER_MARKER = "FX_LOCAL_RUNNER_MARKER";

// The mapper lives in the SDK-free streamJson.ts so the sandbox port
// normalizes with the same function; re-exported for existing importers.
export { normalizeMessage };

function markerLiveInBundle(): string {
  return FX_LOCAL_RUNNER_MARKER;
}

interface LocalHandle extends AgentHandle {
  _query?: { close?: () => void } & AsyncIterable<unknown>;
  _opts?: StartOptions;
}

/** Build the child process env: same shape as `agent_sdk_runner.py`'s
 * invariant in the engine today — API-key env vars neutralized to `""` so
 * the CLI falls back to the owner's already-logged-in subscription, rather
 * than to whatever key happens to be sitting in the orchestrator's own env. */
function buildChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) child[key] = value;
  }
  child.ANTHROPIC_API_KEY = "";
  child.ANTHROPIC_AUTH_TOKEN = "";
  return child;
}

/**
 * Runner (a): drives `@anthropic-ai/claude-agent-sdk` against the owner's
 * already-logged-in subscription. Owner's own repos only, dev/test only —
 * `assertLocalRunnerAllowed` refuses construction anywhere that looks like a
 * deployed environment.
 */
export function createLocalRuntime(env: NodeJS.ProcessEnv = process.env): AgentRuntime {
  assertLocalRunnerAllowed(env);
  // See markerLiveInBundle's doc comment: this keeps FX_LOCAL_RUNNER_MARKER
  // from tree-shaking out of a bundle that still contains this function.
  void markerLiveInBundle();

  // Captured once, at construction, so every event (and every error) this
  // runtime ever emits is checked against the real credential values in
  // *this* process env — never against a placeholder that could shadow the
  // actual secret.
  const secrets = [env.CLAUDE_CODE_OAUTH_TOKEN, env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN];

  async function runQuery(
    opts: StartOptions,
    resumeSessionId: string | undefined,
  ): Promise<{ handle: AgentHandle }> {
    const childEnv = buildChildEnv(env);
    const activeQuery = query({
      prompt: opts.prompt,
      options: {
        model: opts.model,
        cwd: opts.workdir,
        resume: resumeSessionId,
        env: childEnv,
        // D#102: a run's working tree is never a trusted source (C2). These
        // three literals — not spread from config, so nothing can override
        // them — close the settings-loading hole the SDK opens by default.
        // See the permanent fixture test in
        // test/local-setting-sources.test.ts for what this guards.
        settingSources: [],
        mcpServers: {},
        strictMcpConfig: true,
      },
    });

    let seq = 0;
    let sessionId = resumeSessionId;

    try {
      for await (const message of activeQuery as AsyncIterable<Record<string, unknown>>) {
        const normalized = normalizeMessage(opts, message, seq++);
        sessionId = normalized.sessionId ?? sessionId;
        await opts.onEvent(redactDeep(normalized, secrets));
      }
    } catch (error) {
      // The CLI subprocess can legitimately echo its own command line or
      // env in a startup-failure message — redact before it ever reaches a
      // caller, a log, or a test assertion (Spec H04 pass/fail 7,
      // fix-round item 4).
      throw redactError(error, secrets);
    }

    const handle: LocalHandle = {
      runId: opts.runId,
      sessionId,
      _query: activeQuery as LocalHandle["_query"],
      _opts: opts,
    };
    return { handle };
  }

  return {
    start(opts) {
      return runQuery(opts, undefined);
    },
    async stop(handle) {
      (handle as LocalHandle)._query?.close?.();
    },
    resume(handle, sessionId, prompt) {
      const priorOpts = (handle as LocalHandle)._opts;
      if (!priorOpts) {
        throw new Error("cannot resume: handle was not produced by the local runtime");
      }
      return runQuery({ ...priorOpts, prompt }, sessionId);
    },
  };
}
