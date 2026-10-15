import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HeartbeatReply, type NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient, type Claimed } from "../../src/daemon/client.js";
import { GitPathError } from "../../src/daemon/git.js";
import { CHECKPOINT_MAX_TURN_MS } from "../../src/daemon/checkpointTurn.js";
import { createJobHandler, type JobHandlerDeps } from "../../src/daemon/jobHandler.js";
import { createEventRelay, realClock } from "../../src/daemon/lease.js";
import { createFileLedger } from "../../src/daemon/ledger.js";
import { CHECKPOINT_PROMPT } from "../../src/job/checkpoint.js";
import { createWorkspaceStore } from "../../src/job/workspace.js";
import type { SandboxHandle, SandboxPort, StartDetachedOptions, StartDetachedResult } from "../../src/sandbox/port.js";
import { generateRunnerKey } from "../../src/keys.js";
import { fakeGitPath } from "../helpers/fakeGitPath.js";
import { ledgerOptions } from "../helpers/ledgerOptions.js";
import { signedJob } from "../helpers/signedJob.js";
import { until } from "../helpers/manualClock.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";

/** The hash the cloud's own checkpoint turn pins too (see job/checkpoint.test.ts). */
const PROMPT_SHA256 = "c4ef0ea4c53d5e916e1e9dae804a808c4ef58a0bd5fa532d1458be84a0b2b495";
const CANARY = "SECRET-CANARY-sk-ant-0123456789abcdef";
const SESSION = "sess-1";

let cloud: StrictRunnerCloud;
let root: string;
beforeEach(async () => {
  cloud = await startStrictRunnerCloud();
  root = mkdtempSync(path.join(tmpdir(), "fxr-handoff-"));
});
afterEach(async () => {
  await cloud.close();
  rmSync(root, { recursive: true, force: true });
});

const result = (runId: string, over: Partial<NormalizedEvent> = {}): NormalizedEvent => ({ runId, role: "executor", seq: 1, type: "result", ts: "2026-10-11T12:00:00.000Z", sessionId: SESSION, agentOutput: { verdict: "done" }, ...over });

/**
 * A fake engine behind the sandbox port: the first start holds until the sandbox is stopped (the agent is mid-turn); a resume ends at once with the
 * checkpoint answer. Every call is recorded in order, the resume's prompt and the model text that stays local too.
 */
function enginePort(over: { note?: Record<string, unknown> | null; holdResume?: boolean } = {}) {
  const calls: string[] = [];
  const resumes: { sessionId: string; prompt: string }[] = [];
  const checkpointTimeouts: number[] = [];
  let release: (() => void) | undefined;
  let n = 0;
  const port: SandboxPort = {
    async createSandbox(opts) {
      calls.push(`create ${opts.sandboxName.endsWith("-ck") ? "ck" : "run"}`);
      if (opts.sandboxName.endsWith("-ck")) checkpointTimeouts.push(opts.timeoutMs);
      return { runId: "", sandboxName: opts.sandboxName } satisfies SandboxHandle;
    },
    startDetached(handle, opts: StartDetachedOptions): StartDetachedResult {
      calls.push("start");
      void opts.onEvent(result(opts.runId, { type: "assistant", text: `model text ${CANARY}` } as Partial<NormalizedEvent>));
      return { handle, hookFired: new Promise<NormalizedEvent | undefined>((resolve) => { release = () => resolve(undefined); }) };
    },
    resume(handle, sessionId, prompt, opts) {
      calls.push("resume");
      resumes.push({ sessionId, prompt });
      n++;
      const agentOutput = over.note === null ? undefined : (over.note ?? { done: `finished the parser. ${CANARY}`, next: "wire the route", paths: ["src/a.ts", "/etc/passwd", "../x"] });
      if (over.holdResume === true) return { handle, hookFired: new Promise<NormalizedEvent | undefined>((resolve) => { release = () => resolve(undefined); }) };
      return { handle, hookFired: Promise.resolve(result(opts.runId, { sessionId, ...(agentOutput === undefined ? {} : { agentOutput }) })) };
    },
    async extendTimeout() {},
    async stop() {
      calls.push("stop");
      release?.();
    },
    async deleteSandbox() {
      calls.push("delete");
    },
    async measure() {
      return [];
    },
    async readCounters() {
      return undefined;
    },
    async sandboxExists() {
      return true;
    },
  };
  return { port, calls, resumes, checkpointTimeouts, resumeCount: () => n };
}

function rig(over: { handler?: Partial<JobHandlerDeps>; engine?: Parameters<typeof enginePort>[0]; seenSession?: string | null } = {}) {
  const key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  const client = createRunnerClient({ origin: cloud.origin, key, now: () => new Date(), fetchFn: fetch });
  const engine = enginePort(over.engine);
  const interrupts: string[] = [];
  const deps: JobHandlerDeps = {
    client,
    keyring: (await_keyring()),
    clock: realClock,
    run: { workspaces: createWorkspaceStore(path.join(root, "work")), credentials: { mode: "subscription" }, planSession: () => ({ kind: "fresh", branch: null }), defaultModel: "sonnet" },
    sandbox: engine.port,
    ledger: createFileLedger(path.join(root, "jobs.json"), ledgerOptions()),
    git: fakeGitPath(),
    events: createEventRelay(),
    recordSession: async () => undefined,
    heartbeatMs: 15,
    flushMs: 1e9,
    activityFlushMs: 1e9,
    doneAttempts: 1,
    interrupt: async (handle) => {
      engine.calls.push("interrupt");
      interrupts.push(handle.sandboxName);
      await engine.port.stop(handle);
    },
    sessionOfRun: () => (over.seenSession === null ? undefined : over.seenSession ?? SESSION),
    ...over.handler,
  };
  return {
    engine, interrupts, deps, handle: createJobHandler(deps),
    async claim(): Promise<Claimed> {
      cloud.enqueue(signedJob());
      const claimed = await client.claim();
      if (claimed.kind !== "claimed") throw new Error("expected a claim");
      return claimed;
    },
  };
}

// The helpers' keyring is a constant; imported lazily so this file reads top-down.
import { KEYRING } from "../helpers/signedJob.js";
function await_keyring() {
  return KEYRING;
}

const handoffReply = (deadline: Date) => ({ status: 200, body: HeartbeatReply.parse({ continue: true, lease_expires_at: new Date(Date.now() + 90_000).toISOString(), handoff: { requested: true, deadline: deadline.toISOString() } }) });
const inMinutes = (m: number): Date => new Date(Date.now() + m * 60_000);
const endedBy = (runId: string) => cloud.runs.get(runId)!.endedBy;

/** Starts a run, waits until its agent is mid-turn, then makes the next heartbeat carry the handoff. */
async function handoffRun(r: ReturnType<typeof rig>, deadline: Date) {
  const claimed = await r.claim();
  const running = r.handle(claimed);
  await until(() => r.engine.calls.includes("start"));
  cloud.force.heartbeat.push(handoffReply(deadline));
  return { claimed, outcome: await running };
}

describe("a handoff request on a heartbeat reply (HO-3)", () => {
  it("stops the agent, resumes its session exactly once with the constant prompt, pushes, and sends run_ended handed_off pushed", async () => {
    const git = fakeGitPath();
    const r = rig({ handler: { git } });
    const { claimed, outcome } = await handoffRun(r, inMinutes(5));

    expect(outcome).toMatchObject({ status: "handed_off", detail: "pushed" });
    // The agent is interrupted before anything is resumed, and the resume happens once, in a sandbox of its own.
    expect(r.engine.calls).toEqual(["create run", "start", "interrupt", "stop", "stop", "delete", "create ck", "resume", "stop", "delete"]);
    expect(r.interrupts).toHaveLength(1);
    expect(r.engine.resumeCount()).toBe(1);
    expect(r.engine.resumes[0]!.sessionId).toBe(SESSION);
    expect(r.engine.resumes[0]!.prompt).toBe(CHECKPOINT_PROMPT);
    expect(createHash("sha256").update(r.engine.resumes[0]!.prompt, "utf8").digest("hex")).toBe(PROMPT_SHA256);
    // The commit is pushed after the checkpoint turn, and `run_ended` is the last thing sent, with no `done`.
    expect(git.calls.map((c) => c.split(" ")[0])).toEqual(["check", "prepare", "publish"]);
    expect(endedBy(claimed.runId)).toMatchObject({ type: "run_ended", reason: "handed_off", detail: "pushed" });
    expect(Object.keys(endedBy(claimed.runId)!).sort()).toEqual(["detail", "reason", "seq", "ts", "type"]);
    expect(cloud.seen.some((s) => s.path.endsWith("/done"))).toBe(false);
  });

  it("keeps the note on this machine: capped and cleaned, and returned to the caller only", async () => {
    const r = rig();
    const { outcome } = await handoffRun(r, inMinutes(5));
    expect(outcome).toMatchObject({ status: "handed_off", note: { next: "wire the route", paths: ["src/a.ts"] } });
    expect((outcome as { note: { done: string } }).note.done).toContain(CANARY);
  });

  it("C8 walk: the planted secret (in the model's text and in the note) is in no request body, and neither is any note text", async () => {
    const r = rig({ handler: { activityFlushMs: 5, flushMs: 5 } });
    const { claimed } = await handoffRun(r, inMinutes(5));
    expect(cloud.seen.length).toBeGreaterThan(2);
    for (const request of cloud.seen) {
      const body = JSON.stringify(request.body);
      expect(body, request.path).not.toContain(CANARY);
      expect(body, request.path).not.toContain("finished the parser");
      expect(body, request.path).not.toContain("wire the route");
      expect(body, request.path).not.toContain("src/a.ts");
    }
    // Everything the run said to the cloud about the move is a reason and one fixed word.
    expect(endedBy(claimed.runId)).toMatchObject({ reason: "handed_off", detail: "pushed" });
  });

  it("a rejected push sends handed_off push_failed, and the lease is let go: no heartbeat follows", async () => {
    const git = fakeGitPath({ publish: async () => { throw new GitPathError("push_rejected"); } });
    const r = rig({ handler: { git } });
    const deadline = inMinutes(5);
    const { claimed, outcome } = await handoffRun(r, deadline);
    expect(outcome).toMatchObject({ status: "handed_off", detail: "push_failed" });
    expect(Date.now()).toBeLessThan(deadline.getTime());
    expect(endedBy(claimed.runId)).toMatchObject({ reason: "handed_off", detail: "push_failed" });
    const heartbeats = (): number => cloud.seen.filter((s) => s.path.endsWith("/heartbeat")).length;
    const after = heartbeats();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(heartbeats()).toBe(after);
  });

  it("a push that fails for any other closed reason is push_failed too", async () => {
    const git = fakeGitPath({ publish: async () => { throw new GitPathError("push_too_large", 7); } });
    const r = rig({ handler: { git } });
    const { claimed } = await handoffRun(r, inMinutes(5));
    expect(endedBy(claimed.runId)).toMatchObject({ reason: "handed_off", detail: "push_failed" });
  });

  it("with less time left than the push margin, no turn runs but the commit is still pushed", async () => {
    const vcs = fakeGitPath();
    const r = rig({ handler: { git: vcs } });
    const { claimed, outcome } = await handoffRun(r, new Date(Date.now() + 5_000));
    expect(outcome).toMatchObject({ status: "handed_off", detail: "pushed" });
    expect(r.engine.resumeCount()).toBe(0);
    expect(vcs.calls.some((c) => c.startsWith("publish"))).toBe(true);
    expect(endedBy(claimed.runId)).toMatchObject({ reason: "handed_off", detail: "pushed" });
  });

  it("with the deadline already past, no turn runs and nothing is pushed (the cloud has fenced this side): handed_off deadline", async () => {
    const vcs = fakeGitPath();
    const r = rig({ handler: { git: vcs } });
    const { claimed, outcome } = await handoffRun(r, new Date(Date.now() - 1_000));
    expect(outcome).toMatchObject({ status: "handed_off", detail: "deadline" });
    expect(r.engine.resumeCount()).toBe(0);
    expect(vcs.calls.some((c) => c.startsWith("publish"))).toBe(false);
    expect(endedBy(claimed.runId)).toMatchObject({ reason: "handed_off", detail: "deadline" });
  });

  it("a run with no session to resume skips the turn, still pushes what is committed, and carries no note", async () => {
    const git = fakeGitPath();
    const r = rig({ handler: { git }, seenSession: null });
    const { claimed, outcome } = await handoffRun(r, inMinutes(5));
    expect(r.engine.resumeCount()).toBe(0);
    expect(outcome).toEqual({ status: "handed_off", detail: "pushed" });
    expect(git.calls.some((c) => c.startsWith("publish"))).toBe(true);
    expect(endedBy(claimed.runId)).toMatchObject({ reason: "handed_off", detail: "pushed" });
  });

  it("an agent that writes no note still hands off", async () => {
    const r = rig({ engine: { note: null } });
    const { outcome } = await handoffRun(r, inMinutes(5));
    expect(outcome).toEqual({ status: "handed_off", detail: "pushed" });
  });

  it("a handoff that arrives during a long setup is still acted on once the sandbox exists (the wait is not capped at ten seconds)", async () => {
    let finishSetup: () => void = () => undefined;
    const setupDone = new Promise<void>((resolve) => { finishSetup = resolve; });
    const vcs = fakeGitPath({ prepare: async () => { await setupDone; return { base: "0".repeat(40) }; } });
    // The 250 ms polls of the wait run at 1 ms, so the old fixed wait (40 polls) would be over within a tenth of a second.
    const clock = { ...realClock, sleep: (ms: number, signal: AbortSignal) => realClock.sleep(ms === 250 ? 1 : ms, signal) };
    const r = rig({ handler: { git: vcs, clock } });
    const claimed = await r.claim();
    const running = r.handle(claimed);
    await until(() => vcs.calls.some((c) => c.startsWith("prepare")));
    cloud.force.heartbeat.push(handoffReply(inMinutes(5)));
    await until(() => cloud.force.heartbeat.length === 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(r.engine.calls).not.toContain("start");
    finishSetup();
    const outcome = await running;
    expect(outcome).toMatchObject({ status: "handed_off", detail: "pushed" });
    expect(r.interrupts).toHaveLength(1);
    expect(r.engine.resumeCount()).toBe(1);
    expect(endedBy(claimed.runId)).toMatchObject({ reason: "handed_off", detail: "pushed" });
  });

  it("a deadline far in the future still gives the checkpoint turn at most the local maximum: a bounded sandbox lifetime and a turn that is not cut off at once", async () => {
    const r = rig();
    const { outcome } = await handoffRun(r, new Date(Date.now() + 30 * 24 * 3_600_000));
    // 30 days is above 2^31-1 ms, which Node's timer would fire at once; the turn runs and its note comes back.
    expect(outcome).toMatchObject({ status: "handed_off", detail: "pushed", note: { next: "wire the route" } });
    expect(r.engine.resumeCount()).toBe(1);
    expect(r.engine.checkpointTimeouts).toEqual([CHECKPOINT_MAX_TURN_MS + 60_000]);
  });

  it("asks only once, however many replies carry the request", async () => {
    const r = rig();
    const claimed = await r.claim();
    const running = r.handle(claimed);
    await until(() => r.engine.calls.includes("start"));
    cloud.force.heartbeat.push(handoffReply(inMinutes(5)), handoffReply(inMinutes(5)), handoffReply(inMinutes(5)));
    await running;
    expect(r.interrupts).toHaveLength(1);
    expect(r.engine.resumeCount()).toBe(1);
  });

  it("the cloud's stop during the checkpoint turn ends the run quietly: the turn's sandbox is stopped, nothing is pushed, no run_ended is sent", async () => {
    const vcs = fakeGitPath();
    const r = rig({ handler: { git: vcs }, engine: { holdResume: true } });
    const claimed = await r.claim();
    const running = r.handle(claimed);
    await until(() => r.engine.calls.includes("start"));
    cloud.force.heartbeat.push(handoffReply(inMinutes(5)));
    await until(() => r.engine.calls.includes("resume"));
    cloud.stopRun(claimed.runId, "stale_generation");
    expect(await running).toEqual({ status: "stopped", reason: "stale_generation" });
    expect(r.engine.calls.slice(-2)).toEqual(["stop", "delete"]);
    expect(vcs.calls.some((c) => c.startsWith("publish"))).toBe(false);
    expect(endedBy(claimed.runId)).toBeUndefined();
  });

  it("the cloud's stop after the agent's sandbox is gone does not stop that sandbox a second time", async () => {
    const r = rig({ handler: { git: fakeGitPath() }, engine: { holdResume: true } });
    const claimed = await r.claim();
    const running = r.handle(claimed);
    await until(() => r.engine.calls.includes("start"));
    cloud.force.heartbeat.push(handoffReply(inMinutes(5)));
    await until(() => r.engine.calls.includes("resume"));
    cloud.stopRun(claimed.runId, "stale_generation");
    expect(await running).toEqual({ status: "stopped", reason: "stale_generation" });
    // The agent's own sandbox was stopped by the interrupt and by the run, then deleted: the late stop only reaches the checkpoint turn's sandbox.
    expect(r.engine.calls).toEqual(["create run", "start", "interrupt", "stop", "stop", "delete", "create ck", "resume", "stop", "delete"]);
  });

  it("a run that finishes by itself before any request is reported done as before, with no resume", async () => {
    const r = rig({ handler: { heartbeatMs: 1e9 } });
    // The engine's first start ends at once for this run.
    r.engine.port.startDetached = (handle, opts) => ({ handle, hookFired: Promise.resolve(result(opts.runId)) });
    const claimed = await r.claim();
    expect(await r.handle(claimed)).toMatchObject({ status: "completed", outcome: "succeeded" });
    expect(r.engine.resumeCount()).toBe(0);
  });
});

describe("the heartbeat call (HO-3)", () => {
  async function claimedClient() {
    const key = generateRunnerKey();
    cloud.trust(key.publicJwk);
    const client = createRunnerClient({ origin: cloud.origin, key, now: () => new Date(), fetchFn: fetch });
    cloud.enqueue(signedJob());
    const claimed = await client.claim();
    if (claimed.kind !== "claimed") throw new Error("expected a claim");
    return { client, claimed };
  }

  it("hands the request's deadline to the caller when the reply carries one", async () => {
    const { client, claimed } = await claimedClient();
    const deadline = inMinutes(5);
    cloud.force.heartbeat.push(handoffReply(deadline));
    expect(await client.heartbeat(claimed.runId, claimed.leaseGeneration)).toMatchObject({ kind: "ok", handoff: { deadline: deadline.toISOString() } });
  });

  it("reads a plain reply (an older cloud, or no request) as no handoff at all", async () => {
    const { client, claimed } = await claimedClient();
    const reply = await client.heartbeat(claimed.runId, claimed.leaseGeneration);
    expect(reply.kind).toBe("ok");
    expect("handoff" in reply).toBe(false);
  });

  it("refuses a reply whose handoff has an extra key or a request that is not literally true (the parse stays strict)", async () => {
    const { client, claimed } = await claimedClient();
    const lease = new Date(Date.now() + 90_000).toISOString();
    cloud.force.heartbeat.push({ status: 200, body: { continue: true, lease_expires_at: lease, handoff: { requested: true, deadline: inMinutes(5).toISOString(), extra: 1 } } });
    expect(await client.heartbeat(claimed.runId, claimed.leaseGeneration)).toMatchObject({ kind: "error", code: "invalid_reply" });
    cloud.force.heartbeat.push({ status: 200, body: { continue: true, lease_expires_at: lease, handoff: { requested: false, deadline: inMinutes(5).toISOString() } } });
    expect(await client.heartbeat(claimed.runId, claimed.leaseGeneration)).toMatchObject({ kind: "error", code: "invalid_reply" });
  });
});
