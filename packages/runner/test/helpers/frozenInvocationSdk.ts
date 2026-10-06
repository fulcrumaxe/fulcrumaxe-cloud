import {
  CLAUDE_CLI_VERSION,
  COUNTERS_SCRIPT,
  PROMPT_WRAPPER,
  type SdkCommand,
  type SdkCreateParams,
  type SdkSandbox,
  type VercelSandboxSdk,
} from "../../src/vercelSandboxPort.js";

/**
 * A stand-in for a serverless invocation and the Vercel Sandbox API it talks to.
 *
 * The provider answers after a real delay (`LATENCY_MS`), like a network call. The platform's rule is modelled as
 * `platform.frozen`: once the invocation has ended, nothing it still had pending runs again. A provider answer that
 * arrives while frozen is simply dropped, so the code that was waiting for it never continues. That is what happens to a
 * detached `await` chain when the instance is frozen, and it is why the same call is harmless in a long-lived process.
 *
 * What the real API does that the code under test touches: `get` answers 404 for a sandbox that was deleted, a stopped
 * sandbox reports status "stopped" and is not woken by a read, and the agent command is the only `sh -c <wrapper>`.
 */
export interface Platform {
  frozen: boolean;
}

export const LATENCY_MS = 30;

/** The agent prints its result this long after its command starts (a launch is a handful of provider calls; this is a model run). */
export const AGENT_OUTPUT_DELAY_MS = 250;

export const RESULT_LINE = JSON.stringify({ type: "result", is_error: false, result: "done", session_id: "s1" });

function httpError(status: number): Error {
  return Object.assign(new Error("fake provider error"), { response: { status } });
}

export function createFrozenInvocationSdk(platform: Platform) {
  const sandboxes = new Map<string, { status: string; deleted: boolean }>();
  const calls: string[] = [];
  let agentCommands = 0;

  /** The provider's answer arrives after `LATENCY_MS`, unless the invocation was frozen by then. */
  const answer = (ms: number = LATENCY_MS): Promise<void> =>
    new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!platform.frozen) resolve();
      }, ms);
    });

  function sandboxFor(name: string): SdkSandbox {
    const state = sandboxes.get(name)!;
    return {
      name,
      get status() {
        return state.status;
      },
      currentSession: () => ({ sessionId: "sess-1" }),
      async runCommand(params): Promise<SdkCommand> {
        await answer();
        const isAgent = params.args?.[1] === PROMPT_WRAPPER;
        const isCounters = params.args?.[1] === COUNTERS_SCRIPT;
        calls.push(isAgent ? "agentCommand" : isCounters ? "counters" : "command");
        if (isAgent) agentCommands++;
        const out = isCounters ? "12.5 3000 4096\n" : params.args?.[2] === "fx-pin" ? `${CLAUDE_CLI_VERSION}\n` : isAgent ? `${RESULT_LINE}\n` : "";
        return {
          async *logs() {
            if (isAgent) await answer(AGENT_OUTPUT_DELAY_MS); // the agent's output comes some time after the command starts
            if (out) yield { stream: "stdout", data: out };
          },
          wait: async () => ({ exitCode: 0 }),
          kill: async () => undefined,
        };
      },
      async writeFiles() {
        await answer();
        calls.push("writeFiles");
      },
      async updateNetworkPolicy() {
        await answer();
        calls.push("updateNetworkPolicy");
        return undefined;
      },
      extendTimeout: async () => undefined,
      async stop() {
        await answer();
        calls.push("stop");
        state.status = "stopped";
      },
      async delete() {
        await answer();
        calls.push("delete");
        state.deleted = true;
      },
      async listSessions() {
        await answer();
        calls.push("listSessions");
        return { sessions: [{ id: "sess-1", memory: 4096, region: "iad1", duration: 60_000, activeCpuDurationMs: 1_000, networkTransfer: { ingress: 1, egress: 1 } }], pagination: { next: null } };
      },
    };
  }

  const sdk: VercelSandboxSdk = {
    async create(params: SdkCreateParams) {
      await answer();
      calls.push("create");
      sandboxes.set(params.name, { status: "running", deleted: false });
      return sandboxFor(params.name);
    },
    async get(params) {
      await answer();
      calls.push("get");
      const state = sandboxes.get(params.name);
      if (!state || state.deleted) throw httpError(404);
      return sandboxFor(params.name);
    },
  };

  return {
    sdk,
    calls,
    /** How many agent commands the provider was asked to start. */
    agentCommandCount: () => agentCommands,
    /** Something outside the runner stops (or deletes) this sandbox. */
    stopFromOutside: (name: string, how: "stopped" | "deleted" = "stopped") => {
      const state = sandboxes.get(name);
      if (!state) throw new Error("no such sandbox");
      if (how === "deleted") state.deleted = true;
      else state.status = "stopped";
    },
  };
}
