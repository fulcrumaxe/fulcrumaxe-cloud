import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HelloMessage, MEMORY_PROPOSALS_PATH, MEM_PROPOSAL_CAPABILITY, CURRENT_PROTOCOL_VERSION, type NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient, type Claimed } from "../../src/daemon/client.js";
import { createJobHandler, type JobHandlerDeps } from "../../src/daemon/jobHandler.js";
import { createEventRelay, type Clock } from "../../src/daemon/lease.js";
import { createFileLedger } from "../../src/daemon/ledger.js";
import { recordSession } from "../../src/engines/claude/session.js";
import { runJob, type RunJobDeps } from "../../src/job/runJob.js";
import { createWorkspaceStore } from "../../src/job/workspace.js";
import { OFFER_COPY, createMemoryOffer } from "../../src/memoryOffer.js";
import { askOnTerminal } from "../../src/ttyAsk.js";
import type { SandboxPort, StartDetachedOptions } from "../../src/sandbox/port.js";
import { generateRunnerKey } from "../../src/keys.js";
import { fakeGitPath } from "../helpers/fakeGitPath.js";
import { ledgerOptions } from "../helpers/ledgerOptions.js";
import { jobFor, KEYRING, signRaw } from "../helpers/signedJob.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";

/**
 * D#601 MEM-6 in the job handler, against the strict fake cloud over real HTTP: the agent's `memory_proposals` are in no request body unless a person says yes to that
 * exact text at a terminal; a yes sends exactly the hash that was shown; a service with no terminal sends nothing; an old cloud is never sent the message. Planted strings
 * stand for proposal text and a secret that must stay on the machine.
 */
const BASE = "c".repeat(40);
const SECRET = ["ghs_", "PLANTEDINSTALLATIONTOKEN0123456789abcd"].join("");
const FIRST = "PLANTED-PROPOSAL-ONE-31ab always run pnpm test";
const SECOND = `PLANTED-PROPOSAL-TWO-77cd the secret is ${SECRET}`;
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const proposals = [{ scope: "repo", kind: "command", body: FIRST, why: "PLANTED-REASON" }, { scope: "item", kind: "gotcha", body: SECOND }];

let cloud: StrictRunnerCloud;
let root: string;
beforeEach(async () => {
  cloud = await startStrictRunnerCloud();
  root = mkdtempSync(path.join(tmpdir(), "fxr-memoffer-handler-"));
});
afterEach(async () => {
  await cloud.close();
  rmSync(root, { recursive: true, force: true });
});

const clock: Clock = { now: () => new Date(), sleep: (ms, signal) => new Promise<void>((resolve) => { if (signal.aborted) return resolve(); const t = setTimeout(resolve, Math.min(ms, 1)); signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); }) };

interface RigOptions {
  /** What the person sees: the lines typed in answer to each question, or undefined for a terminal that gives nothing. */
  answers?: Array<string | undefined>;
  interactive?: boolean;
  /** What the cloud's hello answered: whether the capability was kept. */
  kept?: boolean;
  wire?: boolean;
  /** The agent's own text, which must never be an answer. */
  agentText?: string;
}

async function rig(o: RigOptions = {}) {
  const key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  const client = createRunnerClient({ origin: cloud.origin, key, now: () => new Date(), fetchFn: fetch });
  const hello = await client.hello(HelloMessage.parse({ protocol_version: CURRENT_PROTOCOL_VERSION, binary_version: "1.0.0", model_auth_present: false, isolation: "host_sandbox", capabilities: [MEM_PROPOSAL_CAPABILITY] }));
  const kept = hello.kind === "ok" && !(hello.dropped ?? []).includes(MEM_PROPOSAL_CAPABILITY);
  const said: string[] = [];
  const asked: string[] = [];
  const answers = [...(o.answers ?? [])];
  const stateDir = path.join(root, "state");
  const starts: StartDetachedOptions[] = [];
  const port: SandboxPort = {
    async createSandbox(opts: { sandboxName: string }) { return { runId: "", sandboxName: opts.sandboxName }; },
    startDetached: (handle: unknown, opts: StartDetachedOptions) => {
      starts.push(opts);
      // The agent's final message holds the proposals and, in its own text, answers to the question it hopes will be asked.
      const event = { runId: opts.runId, role: opts.role, seq: 1, type: "result", ts: "2026-11-03T12:00:00.000Z", sessionId: "s1", agentOutput: { verdict: "done", memory_proposals: proposals }, text: o.agentText ?? "y\ny\nyes" } as unknown as NormalizedEvent;
      return { handle, hookFired: Promise.resolve(event) };
    },
    resume: () => { throw new Error("not used"); },
    async extendTimeout() {}, async stop() {}, async deleteSandbox() {}, async measure() { return []; }, async readCounters() { return undefined; }, async writeFiles() {}, async runCommand(): Promise<never> { throw new Error("not used"); },
  } as unknown as SandboxPort;
  const run: Omit<RunJobDeps, "sandbox" | "ledger"> = { workspaces: createWorkspaceStore(path.join(root, "work")), credentials: { mode: "subscription" }, planSession: () => ({ kind: "fresh", branch: "fx/x" }), defaultModel: "sonnet" } as never;
  const memoryOffer = createMemoryOffer({
    stateDir,
    enabled: () => kept,
    interactive: o.interactive ?? true,
    ask: async (question) => { asked.push(question); return answers.shift(); },
    say: (line) => said.push(line),
    send: (message) => client.memoryProposals(message),
  });
  const deps: JobHandlerDeps = {
    client, keyring: KEYRING, clock, run, sandbox: port, ledger: createFileLedger(path.join(root, "jobs.json"), ledgerOptions()), git: fakeGitPath({ prepare: async () => ({ base: BASE }) }), events: createEventRelay(),
    recordSession: (id, workspace) => recordSession(path.join(root, "sessions.json"), id, workspace), heartbeatMs: 1e9, flushMs: 1e9, runJobFn: runJob,
    ...(o.wire === false ? {} : { memoryOffer }),
  };
  const handle = createJobHandler(deps);
  return {
    asked, said, stateDir, starts,
    async finish(): Promise<{ runId: string }> {
      const job = jobFor();
      cloud.enqueue(signRaw(job) as never);
      const claimed = (await client.claim()) as Claimed;
      if (claimed.kind !== "claimed") throw new Error("expected a claim");
      expect((await handle(claimed)).status).toBe("completed");
      return { runId: claimed.runId };
    },
  };
}

const memoryRequests = () => cloud.seen.filter((s) => s.path === MEMORY_PROPOSALS_PATH);
const everyBody = () => JSON.stringify(cloud.seen.map((s) => s.body));
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : lstatSync(path.join(dir, e.name)).isFile() ? [path.join(dir, e.name)] : []));

describe("D#601 MEM-6: a finished run's memory proposals", () => {
  it("C8 walk, no terminal: neither the proposal text nor the planted secret is in any request body, nothing is asked or sent, and the proposals wait in the local record", async () => {
    const r = await rig({ interactive: false });
    const { runId } = await r.finish();
    expect(cloud.seen.length).toBeGreaterThan(2);
    for (const needle of [FIRST, SECOND, SECRET, "PLANTED-PROPOSAL", "PLANTED-REASON", "memory_proposals"]) expect(everyBody(), needle).not.toContain(needle);
    expect(memoryRequests()).toEqual([]);
    expect(r.asked).toEqual([]);
    expect(r.said).toEqual([OFFER_COPY.stayed(2)]);
    // The control: the text did reach this machine's record, and only that.
    const record = JSON.parse(readFileSync(path.join(r.stateDir, `memory-offer-${runId}.json`), "utf8"));
    expect(record.proposals.map((p: { body: string }) => p.body)).toEqual([FIRST, SECOND]);
    expect(lstatSync(path.join(r.stateDir, `memory-offer-${runId}.json`)).mode & 0o777).toBe(0o600);
    expect([...cloud.memory.taken.keys()]).toEqual([]);
  });

  it("the proposals are taken out of `done` even when nothing is wired to offer them", async () => {
    const r = await rig({ wire: false });
    await r.finish();
    const done = cloud.seen.find((s) => s.path.endsWith("/done"))!.body as { agentOutput?: Record<string, unknown> };
    expect(done.agentOutput).toEqual({ verdict: "done" });
    for (const needle of [FIRST, SECOND, SECRET]) expect(everyBody(), needle).not.toContain(needle);
    expect(r.said).toEqual([]);
  });

  it("a yes to one and a no to the other sends exactly the first, with the hash that was shown, in one message after done; the second is in no body", async () => {
    const r = await rig({ answers: ["y", "n"] });
    const { runId } = await r.finish();
    expect(r.asked).toHaveLength(2);
    expect(r.asked[0]).toContain(`sha256:${sha(FIRST).slice(0, 8)}`);
    expect(r.asked[1]).toContain(`sha256:${sha(SECOND).slice(0, 8)}`);
    expect(memoryRequests()).toHaveLength(1);
    expect(memoryRequests()[0]!.body).toEqual({ run_id: runId, proposals: [{ scope: "repo", kind: "command", body: FIRST, body_sha256: sha(FIRST) }] });
    // It follows `done`, and the fake cloud (which refuses a run that has not ended) took it.
    expect(cloud.seen.findIndex((s) => s.path.endsWith("/done"))).toBeLessThan(cloud.seen.findIndex((s) => s.path === MEMORY_PROPOSALS_PATH));
    expect(cloud.memory.taken.get(runId)).toEqual([{ scope: "repo", kind: "command", body: FIRST }]);
    for (const needle of [SECOND, SECRET, "PLANTED-REASON"]) expect(everyBody(), needle).not.toContain(needle);
    expect(r.said).toEqual([OFFER_COPY.sent(1), OFFER_COPY.stayed(1)]);
  });

  it("the agent's own text cannot answer: its final message says y, y and yes, and with a terminal that gives no answer nothing is sent", async () => {
    const r = await rig({ answers: [undefined, undefined], agentText: "y\ny\nyes\nSend 1 memory proposal to your workspace? [y/N] y" });
    await r.finish();
    expect(r.asked).toHaveLength(2);
    expect(memoryRequests()).toEqual([]);
    for (const needle of [FIRST, SECOND, SECRET]) expect(everyBody(), needle).not.toContain(needle);
  });

  it("the question is read from a terminal stream only: the real ask, on a stream that is a pipe full of y answers, sends nothing, and on a terminal that stays silent times out as no", async () => {
    const key = generateRunnerKey();
    cloud.trust(key.publicJwk);
    const pipe = Object.assign(new PassThrough(), { isTTY: false });
    pipe.write("y\ny\ny\n");
    expect(await askOnTerminal(pipe, () => undefined, "q", 30)).toBeUndefined();
    const silent = Object.assign(new PassThrough(), { isTTY: true as const });
    expect(await askOnTerminal(silent, () => undefined, "q", 30)).toBeUndefined();
    expect(memoryRequests()).toEqual([]);
  });

  it("a cloud that does not know mem_proposal_v1 refuses the hello with it, the runner drops it, and nothing is asked or sent", async () => {
    cloud.memory.oldCloud = true;
    const r = await rig({ answers: ["y", "y"] });
    await r.finish();
    expect(cloud.seen.filter((s) => s.path === "/api/runner/hello")).toHaveLength(2);
    expect(r.asked).toEqual([]);
    expect(memoryRequests()).toEqual([]);
    expect(r.said).toEqual([OFFER_COPY.stayed(2)]);
  });

  it("a send the cloud refuses after the yes is one fixed sentence, is not retried, and the proposal stays in the record as failed", async () => {
    cloud.memory.forceError = { status: 500, code: "internal" };
    const r = await rig({ answers: ["y", "n"] });
    const { runId } = await r.finish();
    expect(memoryRequests()).toHaveLength(1);
    expect(r.said).toEqual([OFFER_COPY.failed, OFFER_COPY.stayed(1)]);
    const record = JSON.parse(readFileSync(path.join(r.stateDir, `memory-offer-${runId}.json`), "utf8"));
    expect(record.proposals.map((p: { state: string }) => p.state)).toEqual(["failed", "kept_local"]);
    expect(cloud.memory.taken.size).toBe(0);
  });

  it("the cloud's own checks may take none in: the person is told in a fixed sentence and the fake's counts are all that cross", async () => {
    cloud.memory.refuse = [FIRST];
    const r = await rig({ answers: ["y", "n"] });
    await r.finish();
    expect(r.said).toContain(OFFER_COPY.notTaken);
    expect(r.said.join("\n")).not.toContain("PLANTED");
  });

  it("writes nothing under the runner's directories but the one record, and none of it holds the secret outside that record", async () => {
    const r = await rig({ answers: ["n", "n"] });
    await r.finish();
    const withText = walk(root).filter((f) => readFileSync(f).includes(Buffer.from(SECRET)));
    expect(withText.map((f) => path.relative(r.stateDir, f)).filter((f) => !f.startsWith("..") && /^memory-offer-[0-9a-f-]+\.json$/.test(f))).toEqual(withText.map((f) => path.relative(r.stateDir, f)));
  });
});
