import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contextLedgerToWire } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient, type RunnerClient } from "../src/daemon/client.js";
import { createClaudeEngine } from "../src/engines/claude/engine.js";
import { generateRunnerKey } from "../src/keys.js";
import { createMemoryLedger, runJob, type RunJobResult } from "../src/job/runJob.js";
import { createWorkspaceStore } from "../src/job/workspace.js";
import { createHostSandbox } from "../src/sandbox/hostSandbox.js";
import { RUN_ID, fixtureText, makeFake, makeRig } from "./engines/claude/rig.js";
import { sampleJob } from "./helpers/sampleJob.js";
import { signedJob } from "./helpers/signedJob.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "./helpers/strictRunnerCloud.js";

/**
 * D#600 CX-1b, acceptance 2 and the compatibility rule: the ledger the real engine measures from a stream reaches the cloud's `done` as
 * integers and enums only, and an older cloud that refuses the field costs the runner nothing but the ledger.
 */
// Built at run time so the source holds no token-shaped literal (the public-boundary scan reads this file).
const SECRET = ["sk", "ant", "api03", "PLANTED", "SECRET", "VALUE"].join("-");
const PATH_NEEDLE = "/home/victim/PLANTED-private/notes.txt";

/** The recorded subscription stream with a planted tool call (a private path, a secret in its output) before the result line. */
function plantedStream(): string {
  const lines = fixtureText("stream.subscription.jsonl").split("\n").filter((l) => l !== "");
  const at = lines.findIndex((l) => {
    try {
      return (JSON.parse(l) as { type?: unknown }).type === "result";
    } catch {
      return false;
    }
  });
  expect(at).toBeGreaterThan(0);
  const planted = [
    { type: "assistant", message: { id: "msg_planted", role: "assistant", content: [{ type: "tool_use", id: "toolu_planted", name: "Read", input: { file_path: PATH_NEEDLE } }, { type: "text", text: SECRET }], usage: { input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 20000, output_tokens: 4 } } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_planted", content: `${SECRET} ${PATH_NEEDLE}` }] } },
  ].map((l) => JSON.stringify(l));
  return [...lines.slice(0, at), ...planted, ...lines.slice(at)].join("\n") + "\n";
}

async function run(stream: string): Promise<RunJobResult> {
  const fake = makeFake({ stream });
  const rig = makeRig({ fake });
  const stateDir = path.join(rig.root, "state");
  const host = createHostSandbox({
    credentials: { mode: "subscription" },
    makeRuntime: (sandbox, protectedList) => createClaudeEngine({ ...rig.config, sandboxSettings: sandbox, protectedPaths: protectedList }),
    home: rig.root,
    stateDir,
    binaryDir: path.dirname(fake.binary),
    tempRoot: path.join(rig.root, "tmp"),
    workspaceRoot: path.join(rig.root, "work"),
  });
  const workspaces = createWorkspaceStore(path.join(rig.root, "work"));
  const job = { ...sampleJob(), job_id: "22222222-2222-4222-8222-222222222222", run_id: RUN_ID, continues: null, model_hint: null };
  return runJob(job, { sandbox: host, workspaces, ledger: createMemoryLedger(), credentials: { mode: "subscription" }, planSession: () => ({ kind: "fresh", branch: null }), defaultModel: "sonnet" });
}

let cloud: StrictRunnerCloud;
let client: RunnerClient;
beforeEach(async () => {
  cloud = await startStrictRunnerCloud();
  const key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  client = createRunnerClient({ origin: cloud.origin, key, now: () => new Date(), fetchFn: fetch });
});
afterEach(() => cloud.close());

async function claimOne() {
  cloud.enqueue(signedJob());
  const claimed = await client.claim();
  if (claimed.kind !== "claimed") throw new Error("expected a claim");
  return claimed;
}

describe("the runner's context ledger (D#600 CX-1b)", () => {
  it("the engine measures the stream, and the done body carries integers and enums only: no planted secret or path anywhere in any request body", async () => {
    const out = await run(plantedStream());
    if (out.status !== "done") throw new Error(`run ended ${out.status}`);
    expect(out.contextLedger).toMatchObject({ basis: "measured", tool_output_bytes: { Read: Buffer.byteLength(`${SECRET} ${PATH_NEEDLE}`) } });
    expect(out.contextLedger!.peak_context_tokens).toBe(3 + 10 + 20000);

    const { runId, leaseGeneration } = await claimOne();
    const reply = await client.done({ runId, leaseGeneration, sessionId: undefined, agentOutput: out.agentOutput, contextLedger: contextLedgerToWire(out.contextLedger!) });
    expect(reply.kind).toBe("done");
    const bodies = JSON.stringify(cloud.seen.map((s) => s.body));
    for (const needle of [SECRET, "PLANTED", "/home/victim", "notes.txt"]) expect(bodies).not.toContain(needle);
    const done = cloud.seen.at(-1)!.body as { context_ledger?: { basis: string; peak_context: number } };
    expect(done.context_ledger).toMatchObject({ basis: "measured", peak_context: 20013 });
  });

  it("a cloud from before CX-1b refuses the field as an invalid message: the same done goes again without it, once, and later runs do not send it", async () => {
    const wire = contextLedgerToWire({ basis: "measured", first_turn_input_tokens: 5, peak_context_tokens: 9, cache_read_tokens: 1, cache_write_tokens: 2, tool_output_bytes: {}, compactions: 0 });
    const first = await claimOne();
    cloud.force.done.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    const before = cloud.seen.length;
    expect(await client.done({ runId: first.runId, leaseGeneration: first.leaseGeneration, contextLedger: wire })).toMatchObject({ kind: "done", outcome: "succeeded" });
    const sent = cloud.seen.slice(before).map((s) => s.body as Record<string, unknown>);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toHaveProperty("context_ledger");
    expect(sent[1]).not.toHaveProperty("context_ledger");

    const second = await claimOne();
    const mark = cloud.seen.length;
    expect(await client.done({ runId: second.runId, leaseGeneration: second.leaseGeneration, contextLedger: wire })).toMatchObject({ kind: "done" });
    expect(cloud.seen.slice(mark)).toHaveLength(1);
    expect(cloud.seen.at(-1)!.body).not.toHaveProperty("context_ledger");
  });

  it("an invalid_message refusal of a done that carried no ledger is not retried: it stays an error", async () => {
    const { runId, leaseGeneration } = await claimOne();
    cloud.force.done.push({ status: 400, body: { error: { code: "invalid_message", message: "invalid_message" } } });
    expect(await client.done({ runId, leaseGeneration })).toEqual({ kind: "error", status: 400, code: "invalid_message" });
  });
});
