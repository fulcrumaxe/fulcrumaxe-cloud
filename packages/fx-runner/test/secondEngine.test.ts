import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRuntime, NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { createMemoryLedger, runJob } from "../src/job/runJob.js";
import { createWorkspaceStore } from "../src/job/workspace.js";
import { createHostSandbox } from "../src/sandbox/hostSandbox.js";
import { sampleJob } from "./helpers/sampleJob.js";

const RUN = "44444444-4444-4444-8444-444444444444";

/** An engine that is not Claude: no binary, no stream-json, its own session ids. It is handed the tier's sandbox block and ignores it. */
function otherEngine(seen: { prompts: string[]; blocks: unknown[] }): (sandbox: Record<string, unknown>) => AgentRuntime {
  return (sandbox) => {
    seen.blocks.push(sandbox);
    return {
      async start(opts) {
        seen.prompts.push(opts.prompt);
        const event: NormalizedEvent = { runId: opts.runId, role: opts.role, seq: 0, type: "result", ts: "2026-10-08T00:00:00.000Z", sessionId: "other-engine-session-1", agentOutput: { verdict: "done" } };
        await opts.onEvent(event);
        return { handle: { runId: opts.runId, done: Promise.resolve() } };
      },
      async stop() {},
      async resume(handle) {
        return { handle };
      },
    };
  };
}

describe("a second engine runs through the same runJob and the same host tier, with no change to either", () => {
  it("done, with the other engine's own session id, under the tier's enabled sandbox block", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "r4b13_second-"));
    const seen = { prompts: [] as string[], blocks: [] as unknown[] };
    const sandbox = createHostSandbox({
      credentials: { mode: "subscription" },
      makeRuntime: otherEngine(seen),
      home: "/home/jane",
      stateDir: "/home/jane/.fx-runner",
      binaryDir: "/opt/other-engine/bin",
      tempRoot: path.join(root, "tmp"),
    });
    const events: NormalizedEvent[] = [];
    const out = await runJob(
      { ...sampleJob(), job_id: "55555555-5555-4555-8555-555555555555", run_id: RUN, continues: null, model_hint: null },
      {
        sandbox,
        workspaces: createWorkspaceStore(path.join(root, "workspaces")),
        ledger: createMemoryLedger(),
        credentials: { mode: "subscription" },
        planSession: () => ({ kind: "fresh", branch: null }),
        defaultModel: "any-model",
        onEvent: (event) => void events.push(event),
      },
    );
    expect(out).toMatchObject({ status: "done", sessionId: "other-engine-session-1", agentOutput: { verdict: "done" } });
    expect(events).toHaveLength(1);
    expect(seen.prompts[0]).toContain("Implement the change.");
    expect(seen.blocks[0]).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    expect(await sandbox.sandboxExists({ runId: "", sandboxName: `rn-${RUN}` })).toBe(false);
  });
});
