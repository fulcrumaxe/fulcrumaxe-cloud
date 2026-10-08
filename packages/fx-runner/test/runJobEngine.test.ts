import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeEngine } from "../src/engines/claude/engine.js";
import { createMemoryLedger, runJob, type RunJobResult } from "../src/job/runJob.js";
import { createWorkspaceStore } from "../src/job/workspace.js";
import { createHostSandbox } from "../src/sandbox/hostSandbox.js";
import { RUN_ID, fixtureText, makeFake, makeRig, streamWith } from "./engines/claude/rig.js";
import { sampleJob } from "./helpers/sampleJob.js";

/**
 * The whole path with nothing stubbed between the parts: the real engine over a fake binary, inside the real host tier,
 * driven by the real job runner. What the engine settles with reaches the job's result.
 */
async function run(opts: { stream?: string; stateDirIsWorkspaceRoot?: boolean } = {}): Promise<{ out: RunJobResult; rig: ReturnType<typeof makeRig> }> {
  const fake = makeFake(opts.stream === undefined ? {} : { stream: opts.stream });
  const rig = makeRig({ fake });
  const stateDir = path.join(rig.root, "state");
  const host = createHostSandbox({
    credentials: { mode: "subscription" },
    makeRuntime: (sandbox, protectedList) => createClaudeEngine({ ...rig.config, sandboxSettings: sandbox, protectedPaths: protectedList }),
    home: rig.root,
    stateDir,
    binaryDir: path.dirname(fake.binary),
    tempRoot: path.join(rig.root, "tmp"),
    workspaceRoot: opts.stateDirIsWorkspaceRoot === true ? path.join(stateDir, "workspaces") : path.join(rig.root, "work"),
  });
  const workspaces = createWorkspaceStore(opts.stateDirIsWorkspaceRoot === true ? path.join(stateDir, "workspaces") : path.join(rig.root, "work"));
  const job = { ...sampleJob(), job_id: "22222222-2222-4222-8222-222222222222", run_id: RUN_ID, continues: null, model_hint: null };
  const out = await runJob(job, { sandbox: host, workspaces, ledger: createMemoryLedger(), credentials: { mode: "subscription" }, planSession: () => ({ kind: "fresh", branch: null }), defaultModel: "sonnet" });
  return { out, rig };
}

describe("runJob over the real engine and the host tier (fake binary)", () => {
  it("a clean run is done, with the session and the agent's result", async () => {
    const { out } = await run();
    expect(out).toMatchObject({ status: "done", sessionId: expect.any(String) });
  });

  it("a credential that does not match the mode ends the run as credential_mismatch", async () => {
    expect(await run({ stream: streamWith("ANTHROPIC_API_KEY") }).then((r) => r.out)).toMatchObject({ status: "failed", reason: "credential_mismatch" });
  });

  it("a stream that does not open with the init line ends the run as no_init_line", async () => {
    const withoutInit = fixtureText("stream.subscription.jsonl").split("\n").slice(1).join("\n");
    expect(await run({ stream: withoutInit }).then((r) => r.out)).toMatchObject({ status: "failed", reason: "no_init_line" });
  });

  it("a workspace under the runner's state directory is a coded refusal, and the agent never starts", async () => {
    const { out, rig } = await run({ stateDirIsWorkspaceRoot: true });
    expect(out).toMatchObject({ status: "failed", reason: "sandbox_grant_refused" });
    expect(existsSync(path.join(rig.fake.dir, "argv.txt"))).toBe(false);
  });
});
