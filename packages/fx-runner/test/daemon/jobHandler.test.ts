import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LocalOnlyEvent, NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { readyOrCode } from "../../src/commands/run.js";
import type { CommandContext } from "../../src/context.js";
import { API_KEY_FILE, CREDENTIALS_DIR, clearApiKey, perJobApiKey, writeApiKey } from "../../src/credentials.js";
import { createRunnerClient, type Claimed } from "../../src/daemon/client.js";
import { createJobHandler, MAX_DONE_ATTEMPTS, type JobHandlerDeps } from "../../src/daemon/jobHandler.js";
import type { JobWatch } from "../../src/daemon/watch.js";
import { createEventRelay, realClock, type Clock } from "../../src/daemon/lease.js";
import { createFileLedger } from "../../src/daemon/ledger.js";
import { GitPathError } from "../../src/daemon/git.js";
import { fakeGitPath } from "../helpers/fakeGitPath.js";
import { ledgerOptions } from "../helpers/ledgerOptions.js";
import { pollLoop } from "../../src/daemon/pollLoop.js";
import { runJob, type RunJobDeps } from "../../src/job/runJob.js";
import { createWorkspaceStore } from "../../src/job/workspace.js";
import type { SandboxHandle, SandboxPort, StartDetachedOptions, StartDetachedResult } from "../../src/sandbox/port.js";
import { recordSession } from "../../src/engines/claude/session.js";
import { generateRunnerKey } from "../../src/keys.js";
import { roleToolsDigest } from "../../src/job/roleTools.js";
import { KEYRING, jobFor, signRaw, signedJob } from "../helpers/signedJob.js";
import { until } from "../helpers/manualClock.js";
import { OPEN_GATE } from "../helpers/openGate.js";
import { retryBody, startStrictRunnerCloud, stopBody, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";

/** Retry waits of seconds are shortened to a millisecond; everything else (a heartbeat interval) really waits, until aborted. */
function testClock(): Clock & { slept: number[] } {
  const slept: number[] = [];
  return {
    slept,
    now: () => new Date(),
    sleep(ms, signal) {
      slept.push(ms);
      return new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const finish = (): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, ms >= 1000 && ms <= 60_000 ? 1 : ms);
        signal.addEventListener("abort", finish, { once: true });
      });
    },
  };
}

const resultEvent = (runId: string, over: Partial<NormalizedEvent> = {}): NormalizedEvent => ({ runId, role: "executor", seq: 1, type: "result", ts: "2026-10-08T12:00:00.000Z", sessionId: "sess-1", agentOutput: { verdict: "done" }, ...over });
const localEvent = (seq: number): LocalOnlyEvent => ({ seq, ts: "2026-10-08T12:00:00.000Z", type: "tool_use", tool_name: "Read" });

let cloud: StrictRunnerCloud;
let root: string;
beforeEach(async () => {
  cloud = await startStrictRunnerCloud();
  root = mkdtempSync(path.join(tmpdir(), "fxr-handler-"));
});
afterEach(async () => {
  await cloud.close();
  rmSync(root, { recursive: true, force: true });
});

/** A sandbox port that counts every call. `hold` makes the agent run until the sandbox is stopped; otherwise it ends at once with `end`. */
function recordingPort(over: { hold?: boolean; end?: (runId: string) => NormalizedEvent | undefined; emit?: (n: number) => void } = {}) {
  const calls: string[] = [];
  const starts: StartDetachedOptions[] = [];
  const handle: SandboxHandle = { runId: "", sandboxName: "rn" };
  let release: (() => void) | undefined;
  const launch = (opts: StartDetachedOptions): StartDetachedResult => {
    calls.push("start");
    starts.push(opts);
    over.emit?.(0);
    const hookFired = over.hold
      ? new Promise<NormalizedEvent | undefined>((resolve) => {
          release = () => resolve(undefined);
        })
      : Promise.resolve(over.end ? over.end(opts.runId) : resultEvent(opts.runId));
    return { handle, hookFired };
  };
  const port: SandboxPort = {
    async createSandbox(opts) {
      calls.push("create");
      return { ...handle, sandboxName: opts.sandboxName };
    },
    startDetached: (_h, opts) => launch(opts),
    resume: (_h, _s, _p, opts) => launch(opts),
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
  return { port, calls, starts };
}

function makeRig(over: { portOver?: Parameters<typeof recordingPort>[0]; handler?: Partial<JobHandlerDeps>; fetchFn?: typeof fetch } = {}) {
  const key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  const client = createRunnerClient({ origin: cloud.origin, key, now: () => new Date(), fetchFn: over.fetchFn ?? fetch });
  const port = recordingPort(over.portOver);
  const relay = createEventRelay();
  const clock = testClock();
  const workspaces = path.join(root, "work");
  const sessionsFile = path.join(root, "sessions.json");
  let calls = 0;
  const run: Omit<RunJobDeps, "sandbox" | "ledger"> = {
    workspaces: createWorkspaceStore(workspaces),
    credentials: { mode: "subscription" },
    planSession: () => ({ kind: "fresh", branch: null }),
    defaultModel: "sonnet",
  };
  const ledger = createFileLedger(path.join(root, "jobs.json"), ledgerOptions());
  const deps: JobHandlerDeps = {
    client, keyring: KEYRING, clock, run, sandbox: port.port, ledger, git: fakeGitPath(), events: relay, recordSession: (id, workspace) => recordSession(sessionsFile, id, workspace),
    heartbeatMs: 1e9, flushMs: 1e9, activityFlushMs: 1e9, runJobFn: (job, d) => (calls++, runJob(job, d)), ...over.handler,
  };
  const handler = createJobHandler(deps);
  return {
    handle: handler, runJobCalls: () => calls, port, relay, clock, sessionsFile, workspaces, client, deps, ledger,
    async claim(signed: ReturnType<typeof signedJob> = signedJob()): Promise<Claimed> {
      cloud.enqueue(signed);
      const claimed = await client.claim();
      if (claimed.kind !== "claimed") throw new Error("expected a claim");
      return claimed;
    },
  };
}

const sentToCloud = (): string[] => cloud.seen.map((s) => s.path.replace(/[0-9a-f-]{36}/, ":id"));

describe("a verified job runs and is reported done", () => {
  it("runs once, sends the engine's events then done with the session id and envelope, and records the session", async () => {
    const rig = makeRig({ portOver: { emit: () => undefined } });
    const claimed = await rig.claim();
    rig.port.port.startDetached = ((_h: SandboxHandle, opts: StartDetachedOptions) => {
      rig.relay.emit(opts.runId, localEvent(0));
      rig.relay.emit(opts.runId, localEvent(1));
      return { handle: { runId: "", sandboxName: "rn" }, hookFired: Promise.resolve(resultEvent(opts.runId)) };
    }) as SandboxPort["startDetached"];
    const result = await rig.handle(claimed);
    expect(result).toEqual({ status: "completed", outcome: "succeeded", failureReason: null, prNumber: 7 });
    expect(rig.runJobCalls()).toBe(1);
    expect(rig.port.calls).toEqual(["create", "stop", "delete"]);
    expect(sentToCloud()).toEqual(["/api/runner/claim", "/api/runner/runs/:id/events", "/api/runner/runs/:id/done"]);
    // The two stage marks the handler makes (workspace_ready, cloned) come first; the engine's two events follow on the same seq line.
    expect(cloud.runs.get(claimed.runId)?.events.map((e) => `${e.type}:${e.seq}`)).toEqual(["stage:0", "stage:1", "tool_use:2", "tool_use:3"]);
    expect(cloud.seen.at(-1)?.body).toEqual({ run_id: claimed.runId, lease_generation: 1, session_id: "sess-1", agentOutput: { verdict: "done" } });
    const index = JSON.parse(readFileSync(rig.sessionsFile, "utf8")) as Record<string, { workspace: string }>;
    expect(Object.keys(index)).toEqual(["sess-1"]);
    expect(path.dirname(index["sess-1"]!.workspace)).toBe(rig.workspaces);
  });

  it("a run with no session id sends done without one and writes no index", async () => {
    const rig = makeRig({ portOver: { end: (runId) => resultEvent(runId, { sessionId: undefined as unknown as string, agentOutput: undefined as unknown as Record<string, unknown> }) } });
    const claimed = await rig.claim();
    expect((await rig.handle(claimed)).status).toBe("completed");
    expect(cloud.seen.at(-1)?.body).toEqual({ run_id: claimed.runId, lease_generation: 1 });
    expect(existsSync(rig.sessionsFile)).toBe(false);
  });

  it("the cloud's own verdict is reported, not assumed", async () => {
    const rig = makeRig();
    const claimed = await rig.claim();
    cloud.force.done.push({ status: 200, body: { continue: false, outcome: "failed", failure_reason: "no_commit", pr_number: null } });
    expect(await rig.handle(claimed)).toEqual({ status: "completed", outcome: "failed", failureReason: "no_commit", prNumber: null });
  });
});

describe("a job that fails verification never reaches runJob", () => {
  const base = jobFor();
  const cases: Array<[string, () => Claimed]> = [
    ["tampered", () => { const s = signedJob(); return { kind: "claimed", signedJob: { ...s, job: { ...s.job, model_hint: "opus" } }, runId: s.job.run_id, leaseGeneration: 1 }; }],
    ["unsigned", () => { const s = signedJob(); return { kind: "claimed", signedJob: { job: s.job } as never, runId: s.job.run_id, leaseGeneration: 1 }; }],
    ["expired", () => { const s = signedJob({ expires_at: "2020-01-01T00:00:00.000Z" }); return { kind: "claimed", signedJob: s, runId: s.job.run_id, leaseGeneration: 1 }; }],
    ["task hash", () => { const s = signRaw({ ...base, task: { ...base.task, prompt: "other\n" } }); return { kind: "claimed", signedJob: s as never, runId: base.run_id, leaseGeneration: 1 }; }],
    ["role card hash", () => { const s = signRaw({ ...base, role_card: { ...base.role_card, text: "other\n" } }); return { kind: "claimed", signedJob: s as never, runId: base.run_id, leaseGeneration: 1 }; }],
    ["role tools hash", () => { const s = signRaw({ ...base, role_tools_sha256: "0".repeat(64) }); return { kind: "claimed", signedJob: s as never, runId: base.run_id, leaseGeneration: 1 }; }],
    ["repo not private", () => { const s = signRaw({ ...base, repo: { ...base.repo, private: false } }); return { kind: "claimed", signedJob: s as never, runId: base.run_id, leaseGeneration: 1 }; }],
    ["run id differs from the reply's", () => { const s = signedJob(); return { kind: "claimed", signedJob: s, runId: "11111111-1111-4111-8111-111111111111", leaseGeneration: 1 }; }],
  ];
  // What each refusal says to the cloud (C24 section 1): the refusal code as the closed detail, and a public repository as its own reason.
  const ENDS: Array<{ reason: string; detail?: string }> = [
    { reason: "job_refused", detail: "job_signature_invalid" },
    { reason: "job_refused", detail: "job_signature_invalid" },
    { reason: "job_refused", detail: "job_signature_invalid" },
    { reason: "job_refused", detail: "task_prompt_hash_mismatch" },
    { reason: "job_refused", detail: "role_card_hash_mismatch" },
    { reason: "job_refused", detail: "role_tools_mismatch" },
    { reason: "repo_not_private" },
    { reason: "job_refused", detail: "run_id_mismatch" },
  ];
  cases.forEach(([name, make], index) => {
    it(`${name}: refused, zero runJob calls, no sandbox, no workspace, and exactly one events call holding one run_ended`, async () => {
      const rig = makeRig();
      const claimed = make();
      const result = await rig.handle(claimed);
      expect(result.status, name).toBe("refused");
      expect(rig.runJobCalls()).toBe(0);
      expect(rig.port.calls).toEqual([]);
      expect(existsSync(rig.workspaces)).toBe(false);
      // The cloud does not know this hand-made claim, so it answers a stop: one call, and no second try.
      expect(cloud.seen).toHaveLength(1);
      expect(cloud.seen[0]!.path).toBe(`/api/runner/runs/${claimed.runId}/events`);
      expect(cloud.seen[0]!.body).toMatchObject({ run_id: claimed.runId, lease_generation: 1, events: [{ seq: 0, type: "run_ended", ...ENDS[index]! }] });
      expect((cloud.seen[0]!.body as { events: unknown[] }).events).toHaveLength(1);
      expect(existsSync(path.join(root, "jobs.json"))).toBe(false);
    });
  });

  it("through a real claim, the cloud takes the refusal: the run is ended by it, and no heartbeat, second events call or done follows", async () => {
    const rig = makeRig();
    const signed = signedJob();
    const claimed = await rig.claim({ ...signed, job: { ...signed.job, model_hint: "opus" } });
    expect((await rig.handle(claimed)).status).toBe("refused");
    expect(sentToCloud()).toEqual(["/api/runner/claim", "/api/runner/runs/:id/events"]);
    expect(cloud.runs.get(claimed.runId)?.endedBy).toMatchObject({ type: "run_ended", reason: "job_refused", detail: "job_signature_invalid" });
    expect(cloud.runs.get(claimed.runId)?.events).toHaveLength(1);
  });

  it("each refusal names its own reason", async () => {
    const reasons: string[] = [];
    for (const [, make] of cases) {
      const rig = makeRig();
      const result = await rig.handle(make());
      rig.ledger.close();
      reasons.push(result.status === "refused" ? result.reason : result.status);
    }
    expect(reasons).toEqual(["job_signature_invalid", "job_signature_invalid", "job_signature_invalid", "task_prompt_hash_mismatch", "role_card_hash_mismatch", "role_tools_mismatch", "repo_not_private", "run_id_mismatch"]);
  });

  it("an unknown role is refused on its own detail (the hash check names it)", async () => {
    const rig = makeRig({ handler: { runJobFn: async () => ({ status: "refused" as const, reasons: ["unknown_role" as const] }) } });
    const claimed = await rig.claim();
    expect(await rig.handle(claimed)).toEqual({ status: "refused", reason: "unknown_role" });
    expect(cloud.runs.get(claimed.runId)?.endedBy).toMatchObject({ type: "run_ended", reason: "job_refused", detail: "unknown_role" });
  });

  describe("the report is tried up to three times while the lease holds, and stops at the first answer that settles it", () => {
    const eventsCalls = (): number => cloud.seen.filter((s) => s.path.endsWith("/events")).length;
    const fail500 = { status: 500, body: { error: { code: "internal", message: "x" } } };
    const bad = (): Claimed => {
      const s = signedJob();
      return { kind: "claimed", signedJob: { ...s, job: { ...s.job, model_hint: "opus" } }, runId: s.job.run_id, leaseGeneration: 1 };
    };

    it("a call that fails is tried again, and the third try is the last", async () => {
      const rig = makeRig();
      cloud.force.events.push(fail500, fail500, fail500, fail500, fail500);
      expect((await rig.handle(bad())).status).toBe("refused");
      expect(eventsCalls()).toBe(3);
    });

    it("a try that gets through ends the report: two failures then an answer is three calls", async () => {
      const rig = makeRig();
      const claimed = await rig.claim((() => { const s = signedJob(); return { ...s, job: { ...s.job, model_hint: "opus" } }; })());
      cloud.force.events.push(fail500, fail500);
      await rig.handle(claimed);
      expect(eventsCalls()).toBe(3);
      expect(cloud.runs.get(claimed.runId)?.endedBy).toMatchObject({ type: "run_ended" });
    });

    it("a stop reply ends it at once, with no second try", async () => {
      const rig = makeRig();
      cloud.force.events.push(stopBody("run_terminal"));
      await rig.handle(bad());
      expect(eventsCalls()).toBe(1);
    });

    it("a 401 ends it at once", async () => {
      const rig = makeRig();
      cloud.force.events.push({ status: 401, body: { error: { code: "unauthorized", message: "x" } } });
      await rig.handle(bad());
      expect(eventsCalls()).toBe(1);
    });

    it("no try is made once a whole lease (90 seconds) has gone by since the claim", async () => {
      let t = Date.parse("2026-10-08T12:00:00.000Z");
      const rig = makeRig({ handler: { clock: { now: () => new Date(t), sleep: async () => void (t += 60_000) } } });
      cloud.force.events.push(fail500, fail500, fail500, fail500);
      await rig.handle(bad());
      // The first try at 0 s, the second after a 2 s wait that the clock turns into 60 s, the third would be at 120 s: not made.
      expect(eventsCalls()).toBe(2);
    });
  });

  it("a job the cloud signed and delivered through a real claim runs (the control for the table above)", async () => {
    const rig = makeRig();
    expect((await rig.handle(await rig.claim())).status).toBe("completed");
    expect(rig.runJobCalls()).toBe(1);
  });
});

describe("a redelivered job id is acknowledged, not run twice", () => {
  it("the second delivery of one signed job starts nothing and says so once: run_ended job_refused / duplicate_job", async () => {
    const rig = makeRig();
    const signed = signedJob();
    expect((await rig.handle(await rig.claim(signed))).status).toBe("completed");
    const again = await rig.claim(signed);
    expect(again.leaseGeneration).toBe(2);
    expect(await rig.handle(again)).toEqual({ status: "duplicate" });
    expect(rig.port.calls.filter((c) => c === "create")).toHaveLength(1);
    expect(rig.port.calls.filter((c) => c === "start")).toHaveLength(1);
    expect(readdirSync(rig.workspaces)).toHaveLength(1);
    expect(cloud.seen.filter((s) => s.path.endsWith("/done"))).toHaveLength(1);
    expect(cloud.seen.filter((s) => s.path.includes("/heartbeat"))).toEqual([]);
    // The first run was done, so the replayed claim's run is terminal and the cloud answers a harmless 409; the daemon sends it once.
    const reported = cloud.seen.filter((s) => s.path.endsWith("/events") && (s.body as { lease_generation: number }).lease_generation === 2);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.body).toMatchObject({ lease_generation: 2, events: [{ seq: 0, type: "run_ended", reason: "job_refused", detail: "duplicate_job" }] });
  });

  it("a duplicate that the cloud still holds as live is ended by the report", async () => {
    const rig = makeRig({ portOver: { hold: true } });
    const signed = signedJob();
    // The job id is already in the ledger, so the delivery is a repeat; the run it names is live in the cloud.
    rig.ledger.claim(signed.job.job_id, signed.job.expires_at);
    const claimed = await rig.claim(signed);
    expect(await rig.handle(claimed)).toEqual({ status: "duplicate" });
    expect(cloud.runs.get(claimed.runId)?.endedBy).toMatchObject({ type: "run_ended", reason: "job_refused", detail: "duplicate_job" });
    expect(rig.port.calls).toEqual([]);
  });

  it("a ledger that could not record the id (damaged file) is not a repeat: nothing runs and nothing is sent", async () => {
    writeFileSync(path.join(root, "jobs.json"), "garbage");
    const rig = makeRig();
    expect(rig.ledger.closed).toBe(true);
    const claimed = await rig.claim();
    expect(await rig.handle(claimed)).toEqual({ status: "unrecorded" });
    expect(rig.port.calls).toEqual([]);
    expect(sentToCloud()).toEqual(["/api/runner/claim"]);
  });

  it("holds after a restart: a new handler with a new ledger on the same file runs nothing", async () => {
    const signed = signedJob();
    const first = makeRig();
    await first.handle(await first.claim(signed));
    first.ledger.close();
    const second = makeRig();
    expect(await second.handle(await second.claim(signed))).toEqual({ status: "duplicate" });
    expect(second.port.calls).toEqual([]);
  });

  it("two deliveries at once start one", async () => {
    const rig = makeRig({ portOver: { hold: true } });
    const signed = signedJob();
    const a = await rig.claim(signed);
    const b = await rig.claim(signed);
    const first = rig.handle(a);
    const second = rig.handle(b);
    expect(await second).toEqual({ status: "duplicate" });
    await until(() => rig.port.calls.includes("create"));
    await rig.port.port.stop({ runId: "", sandboxName: "rn" });
    await first;
    expect(rig.port.calls.filter((c) => c === "create")).toHaveLength(1);
  });
});

describe("done is retried, boundedly", () => {
  it("503 {retry_after} waits as asked and tries again until GitHub answers", async () => {
    const rig = makeRig();
    const claimed = await rig.claim();
    cloud.githubDown = 2;
    expect((await rig.handle(claimed)).status).toBe("completed");
    expect(cloud.seen.filter((s) => s.path.endsWith("/done"))).toHaveLength(3);
    expect(rig.clock.slept.filter((ms) => ms === 15_000)).toHaveLength(2);
  });

  it("gives up after MAX_DONE_ATTEMPTS and says the outcome is unconfirmed; one wait is never longer than a minute", async () => {
    const rig = makeRig();
    const claimed = await rig.claim();
    for (let i = 0; i < 10; i++) cloud.force.done.push(retryBody(3600));
    expect(await rig.handle(claimed)).toEqual({ status: "unconfirmed" });
    // The literal, not the constant: changing the constant must fail this test.
    expect(MAX_DONE_ATTEMPTS).toBe(5);
    expect(cloud.seen.filter((s) => s.path.endsWith("/done"))).toHaveLength(5);
    expect(rig.clock.slept.filter((ms) => ms === 60_000)).toHaveLength(4);
    // An unconfirmed done sends no run_ended: the lease path covers it.
    expect(cloud.runs.get(claimed.runId)?.events.some((e) => e.type === "run_ended")).toBe(false);
    expect(rig.clock.slept.every((ms) => ms <= 60_000 || ms === 1e9)).toBe(true);
  });

  it("a done that did not get through (network) is retried after the default wait, and the repeat is safe", async () => {
    let failures = 1;
    const flaky = ((url: string, init: RequestInit) => (String(url).endsWith("/done") && failures-- > 0 ? Promise.reject(new TypeError("fetch failed")) : fetch(url, init))) as typeof fetch;
    const rig = makeRig({ fetchFn: flaky });
    const claimed = await rig.claim();
    expect((await rig.handle(claimed)).status).toBe("completed");
    expect(rig.clock.slept).toContain(15_000);
  });

  it("a stop on done ends it: no more attempts, and the session is not recorded", async () => {
    const rig = makeRig();
    const claimed = await rig.claim();
    cloud.force.done.push(stopBody("lease_expired"));
    expect(await rig.handle(claimed)).toEqual({ status: "stopped", reason: "lease_expired" });
    expect(cloud.seen.filter((s) => s.path.endsWith("/done"))).toHaveLength(1);
    expect(existsSync(rig.sessionsFile)).toBe(false);
  });

  it("401 on done (the runner was revoked) is a lost hold, not a retry", async () => {
    const rig = makeRig();
    const claimed = await rig.claim();
    cloud.force.done.push({ status: 401, body: { error: { code: "unauthorized", message: "x" } } });
    expect(await rig.handle(claimed)).toEqual({ status: "stopped", reason: "lease_lost" });
  });
});

describe("a run that does not finish is not reported done", () => {
  it("an agent error sends no done: it says run_ended agent_failed instead, and no session is recorded", async () => {
    const rig = makeRig({ portOver: { end: (runId) => resultEvent(runId, { type: "error" }) } });
    const claimed = await rig.claim();
    expect(await rig.handle(claimed)).toEqual({ status: "failed", reason: "agent_error" });
    // The stage marks are flushed first, then run_ended goes alone.
    expect(sentToCloud()).toEqual(["/api/runner/claim", "/api/runner/runs/:id/events", "/api/runner/runs/:id/events"]);
    expect(cloud.runs.get(claimed.runId)?.endedBy).toMatchObject({ type: "run_ended", reason: "agent_failed" });
    expect(existsSync(rig.sessionsFile)).toBe(false);
  });

  it("the cloud's stop on a heartbeat aborts the run cleanly: the sandbox is stopped and deleted, and no done goes out", async () => {
    const rig = makeRig({ portOver: { hold: true }, handler: { heartbeatMs: 20 } });
    const claimed = await rig.claim();
    const running = rig.handle(claimed);
    await until(() => rig.port.calls.includes("create"));
    cloud.stopRun(claimed.runId, "wall_clock_limit");
    const started = Date.now();
    expect(await running).toEqual({ status: "stopped", reason: "wall_clock_limit" });
    expect(Date.now() - started).toBeLessThan(2000);
    // stopped once by the abort and once by runJob's own cleanup, then deleted
    expect(rig.port.calls).toEqual(["create", "start", "stop", "stop", "delete"]);
    expect(cloud.seen.some((s) => s.path.endsWith("/done"))).toBe(false);
    // A stop is the cloud's own word that it has ended or fenced the run: nothing is sent in reply, no run_ended included.
    expect(cloud.seen.some((s) => s.path.endsWith("/events"))).toBe(false);
  });

  it("the cloud's stop on an events batch does the same", async () => {
    const rig = makeRig({ portOver: { hold: true }, handler: { flushMs: 20 } });
    const claimed = await rig.claim();
    const running = rig.handle(claimed);
    await until(() => rig.port.calls.includes("create"));
    rig.relay.emit(claimed.runId, localEvent(0));
    cloud.stopRun(claimed.runId, "stale_generation");
    expect(await running).toEqual({ status: "stopped", reason: "stale_generation" });
    expect(cloud.seen.some((s) => s.path.endsWith("/done"))).toBe(false);
    // The one events call was the batch the stop answered; no run_ended followed it.
    expect(cloud.seen.filter((s) => s.path.endsWith("/events"))).toHaveLength(1);
    expect(cloud.runs.get(claimed.runId)?.events.some((e) => e.type === "run_ended")).toBe(false);
  });

  it("a hold lost to a 401 on a heartbeat sends nothing either", async () => {
    const rig = makeRig({ portOver: { hold: true }, handler: { heartbeatMs: 20 } });
    const claimed = await rig.claim();
    cloud.force.heartbeat.push({ status: 401, body: { error: { code: "unauthorized", message: "x" } } });
    expect(await rig.handle(claimed)).toEqual({ status: "stopped", reason: "lease_lost" });
    expect(cloud.seen.some((s) => s.path.endsWith("/events") || s.path.endsWith("/done"))).toBe(false);
  });

  it("heartbeats carry the claimed generation while the run goes", async () => {
    const rig = makeRig({ portOver: { hold: true }, handler: { heartbeatMs: 15 } });
    const claimed = await rig.claim();
    const running = rig.handle(claimed);
    await until(() => cloud.seen.filter((s) => s.path.endsWith("/heartbeat")).length >= 2);
    await rig.port.port.stop({ runId: "", sandboxName: "rn" });
    await running;
    for (const s of cloud.seen.filter((x) => x.path.endsWith("/heartbeat"))) expect(s.body).toEqual({ run_id: claimed.runId, lease_generation: 1 });
  });

  it("a stop asked of the daemon (SIGTERM) aborts the run, sends no done, and reports it aborted", async () => {
    const shutdown = new AbortController();
    const rig = makeRig({ portOver: { hold: true }, handler: { shutdown: shutdown.signal, clock: realClock } });
    const claimed = await rig.claim();
    const running = rig.handle(claimed);
    await until(() => rig.port.calls.includes("create"));
    shutdown.abort();
    expect(await running).toEqual({ status: "aborted" });
    // stopped once by the abort and once by runJob's own cleanup, then deleted
    expect(rig.port.calls).toEqual(["create", "start", "stop", "stop", "delete"]);
    expect(cloud.seen.some((s) => s.path.endsWith("/done"))).toBe(false);
    // One run_ended runner_shutdown, as the only call after the claim.
    expect(sentToCloud()).toEqual(["/api/runner/claim", "/api/runner/runs/:id/events"]);
    expect(cloud.runs.get(claimed.runId)?.endedBy).toMatchObject({ type: "run_ended", reason: "runner_shutdown" });
    expect(cloud.runs.get(claimed.runId)?.endedBy?.detail).toBeUndefined();
  });
});

describe("what the cloud is told when a run does not finish (D#6 R4a-2, C24 section 1)", () => {
  const eventsOf = (runId: string) => cloud.runs.get(runId)?.events ?? [];
  const eventsCalls = () => cloud.seen.filter((s) => s.path.endsWith("/events"));
  const failWith = (reason: string) => ({ runJobFn: async () => ({ status: "failed" as const, reason }) });
  const fail500 = { status: 500, body: { error: { code: "internal", message: "x" } } };

  describe("a run that failed", () => {
    it("flushes what the run queued first, then sends run_ended last, with a seq above every event the run sent", async () => {
      const rig = makeRig();
      const claimed = await rig.claim();
      rig.port.port.startDetached =((_h: SandboxHandle, opts: StartDetachedOptions) => {
        rig.relay.emit(opts.runId, localEvent(0));
        rig.relay.emit(opts.runId, localEvent(7));
        return { handle: { runId: "", sandboxName: "rn" }, hookFired: Promise.resolve(resultEvent(opts.runId, { type: "error" })) };
      }) as SandboxPort["startDetached"];
      expect(await rig.handle(claimed)).toEqual({ status: "failed", reason: "agent_error" });
      const calls = eventsCalls().map((s) => (s.body as { events: Array<{ seq: number; type: string }> }).events.map((e) => `${e.type}:${e.seq}`));
      expect(calls).toEqual([["stage:0", "stage:1", "tool_use:2", "tool_use:3"], ["run_ended:4"]]);
      expect(eventsOf(claimed.runId).at(-1)).toMatchObject({ type: "run_ended", seq: 4, reason: "agent_failed" });
    });

    const CODES: Array<[code: string, reason: string, detail?: string]> = [
      ["agent_error", "agent_failed"],
      ["no_result", "agent_failed"],
      ["agent_exit", "agent_failed"],
      ["wall_clock", "wall_clock"],
      ["sandbox_unavailable", "runner_setup", "sandbox_unavailable"],
      ["claude_binary_missing", "runner_setup", "claude_binary_missing"],
      ["claude_version_unsupported", "runner_setup", "claude_version_unsupported"],
      ["claude_flags_unsupported", "runner_setup", "claude_flags_unsupported"],
      ["auth_missing", "runner_setup", "auth_missing"],
      ["bad_start_options", "runner_setup", "bad_start_options"],
      ["no_init_line", "runner_setup", "no_init_line"],
      ["permission_mode_forced", "runner_setup", "permission_mode_forced"],
      ["model_unsupported", "runner_setup", "model_unsupported"],
      // D#6 R4d-2 (C32 section 3): the path's own codes each have a closed detail; they used to be `other`.
      ["push_ref_refused", "runner_setup", "push_ref_refused"],
      ["snapshot_refused", "runner_setup", "snapshot_refused"],
      ["push_failed", "runner_setup", "push_failed"],
      ["mirror_failed", "runner_setup", "mirror_failed"],
      ["mirror_dir_insecure", "runner_setup", "mirror_dir_insecure"],
      ["git_version_unsupported", "runner_setup", "git_version_unsupported"],
      ["workspace_failed", "runner_setup", "workspace_failed"],
      ["workspace_git_refused", "runner_setup", "workspace_git_refused"],
      ["head_not_from_base", "runner_setup", "head_not_from_base"],
      ["sandbox_stub_committed", "runner_setup", "sandbox_stub_committed"],
      // The set of codes runJob returns is open. Anything else is a setup failure of an unknown kind, and the code itself is never sent.
      ["sandbox_grant_refused", "runner_setup", "other"],
      ["some_new_code", "runner_setup", "other"],
      ["other", "runner_setup", "other"],
      ["unknown_role", "runner_setup", "other"],
    ];
    for (const [code, reason, detail] of CODES) {
      it(`${code} is sent as ${reason}${detail === undefined ? "" : ` / ${detail}`}`, async () => {
        const rig = makeRig({ handler: failWith(code) });
        const claimed = await rig.claim();
        expect(await rig.handle(claimed)).toEqual({ status: "failed", reason: code });
        const ended = cloud.runs.get(claimed.runId)?.endedBy;
        expect(ended).toMatchObject({ type: "run_ended", reason });
        expect(ended?.detail).toBe(detail);
        // Closed codes only: the event holds nothing but the fields of the protocol's closed set.
        expect(Object.keys(ended ?? {}).sort()).toEqual(["detail", "reason", "seq", "ts", "type"].filter((k) => k !== "detail" || detail !== undefined));
      });
    }

    it("a credential mismatch sends no run_ended", async () => {
      const rig = makeRig({ handler: failWith("credential_mismatch") });
      const claimed = await rig.claim();
      expect(await rig.handle(claimed)).toEqual({ status: "failed", reason: "credential_mismatch" });
      expect(eventsCalls()).toHaveLength(0);
    });

    it("nor when the engine has already sent its own credential_mismatch event and the run then fails some other way", async () => {
      const rig = makeRig({ handler: { runJobFn: async (job) => (rig.relay.emit(job.run_id, { seq: 0, ts: "2026-10-08T12:00:00.000Z", type: "credential_mismatch" }), { status: "failed" as const, reason: "agent_error" }) } });
      const claimed = await rig.claim();
      await rig.handle(claimed);
      const sent = eventsOf(claimed.runId).map((e) => e.type);
      expect(sent).toEqual(["credential_mismatch"]);
      expect(cloud.runs.get(claimed.runId)?.endedBy?.type).toBe("credential_mismatch");
      // Not even attempted: the one events call is the engine's own event.
      expect(eventsCalls()).toHaveLength(1);
    });

    it("an ending event the engine already sent wins: run_ended is sent after it, and the cloud's answer to that is a stop", async () => {
      const rig = makeRig({ handler: { runJobFn: async (job) => (rig.relay.emit(job.run_id, { seq: 0, ts: "2026-10-08T12:00:00.000Z", type: "usage_limit_reached" }), { status: "failed" as const, reason: "agent_error" }) } });
      const claimed = await rig.claim();
      expect((await rig.handle(claimed)).status).toBe("failed");
      expect(cloud.runs.get(claimed.runId)?.endedBy?.type).toBe("usage_limit_reached");
      expect(eventsOf(claimed.runId).map((e) => e.type)).toEqual(["usage_limit_reached"]);
      expect(eventsCalls()).toHaveLength(2);
    });

    it("a stop on the flush that comes first ends it: run_ended is not sent", async () => {
      const rig = makeRig({ handler: { runJobFn: async (job) => (rig.relay.emit(job.run_id, localEvent(0)), { status: "failed" as const, reason: "agent_error" }) } });
      const claimed = await rig.claim();
      cloud.force.events.push(stopBody("run_terminal"));
      expect(await rig.handle(claimed)).toEqual({ status: "stopped", reason: "run_terminal" });
      expect(eventsCalls()).toHaveLength(1);
    });

    it("is tried up to three times while the lease holds, then left to the lease path", async () => {
      const rig = makeRig({ handler: failWith("agent_error") });
      const claimed = await rig.claim();
      cloud.force.events.push(fail500, fail500, fail500, fail500, fail500);
      expect(await rig.handle(claimed)).toEqual({ status: "failed", reason: "agent_error" });
      expect(eventsCalls()).toHaveLength(3);
      expect(eventsOf(claimed.runId)).toEqual([]);
    });

    it("two failed tries then an answer: three calls, and the run is ended", async () => {
      const rig = makeRig({ handler: failWith("agent_error") });
      const claimed = await rig.claim();
      cloud.force.events.push(fail500, fail500);
      await rig.handle(claimed);
      expect(eventsCalls()).toHaveLength(3);
      expect(cloud.runs.get(claimed.runId)?.endedBy).toMatchObject({ reason: "agent_failed" });
    });

    it("seq_not_increasing drops what the cloud already has and sends the rest: run_ended, above that number, still goes", async () => {
      const rig = makeRig({ handler: { runJobFn: async (job) => (rig.relay.emit(job.run_id, localEvent(0)), rig.relay.emit(job.run_id, localEvent(1)), { status: "failed" as const, reason: "agent_error" }) } });
      const claimed = await rig.claim();
      // The first batch is accepted. The cloud then says it already holds up to 1 (a lost reply): run_ended, at 2, is kept and resent.
      cloud.force.events.push({ status: 200, body: { continue: true, accepted: 2, duplicates: 0, lease_expires_at: "2026-10-08T12:01:30.000Z" } });
      cloud.force.events.push({ status: 409, body: { continue: true, error: "seq_not_increasing", last_accepted_seq: 1 } });
      await rig.handle(claimed);
      expect(eventsCalls()).toHaveLength(3);
      expect(cloud.runs.get(claimed.runId)?.endedBy).toMatchObject({ type: "run_ended", seq: 2 });
    });
  });

  describe("a job the engine refused after verification", () => {
    it("runJob's own hash refusal is reported like the daemon's: job_refused with its code", async () => {
      const rig = makeRig({ handler: { runJobFn: async () => ({ status: "refused" as const, reasons: ["role_tools_mismatch" as const] }) } });
      const claimed = await rig.claim();
      expect(await rig.handle(claimed)).toEqual({ status: "refused", reason: "role_tools_mismatch" });
      expect(cloud.runs.get(claimed.runId)?.endedBy).toMatchObject({ type: "run_ended", reason: "job_refused", detail: "role_tools_mismatch" });
    });
  });

  describe("the daemon is shutting down", () => {
    it("makes one attempt, and a failed attempt is not repeated", async () => {
      const shutdown = new AbortController();
      const rig = makeRig({ portOver: { hold: true }, handler: { shutdown: shutdown.signal, clock: realClock } });
      const claimed = await rig.claim();
      const running = rig.handle(claimed);
      await until(() => rig.port.calls.includes("create"));
      cloud.force.events.push(fail500, fail500, fail500);
      shutdown.abort();
      expect(await running).toEqual({ status: "aborted" });
      expect(eventsCalls()).toHaveLength(1);
      expect(eventsOf(claimed.runId)).toEqual([]);
    });

    it("sends the queued events first, then run_ended runner_shutdown after them", async () => {
      const shutdown = new AbortController();
      const rig = makeRig({ portOver: { hold: true }, handler: { shutdown: shutdown.signal, clock: realClock } });
      const claimed = await rig.claim();
      const running = rig.handle(claimed);
      await until(() => rig.port.calls.includes("create"));
      rig.relay.emit(claimed.runId, localEvent(0));
      rig.relay.emit(claimed.runId, localEvent(1));
      shutdown.abort();
      await running;
      expect(eventsOf(claimed.runId).map((e) => `${e.type}:${e.seq}`)).toEqual(["stage:0", "stage:1", "tool_use:2", "tool_use:3", "run_ended:4"]);
    });

    it("does not wait longer than five seconds for a call that does not answer, and returns", async () => {
      const shutdown = new AbortController();
      let hang = false;
      let unblock: (() => void) | undefined;
      const hanging = ((url: string, init: RequestInit) =>
        hang && String(url).endsWith("/events") ? new Promise<Response>((resolve) => void (unblock = () => resolve(new Response("{}", { status: 500 })))) : fetch(url, init)) as typeof fetch;
      const rig = makeRig({ portOver: { hold: true }, fetchFn: hanging, handler: { shutdown: shutdown.signal } });
      const running = rig.handle(await rig.claim());
      await until(() => rig.port.calls.includes("create"));
      hang = true;
      shutdown.abort();
      expect(await running).toEqual({ status: "aborted" });
      expect(rig.clock.slept).toContain(5_000);
      unblock?.();
    });

    it("a run that had finished but whose done was not yet confirmed also says so when the daemon is stopped", async () => {
      const shutdown = new AbortController();
      // The wait between two done attempts (15 s) is where the daemon is asked to stop; any other wait lasts until its signal aborts.
      const clock: Clock = { now: () => new Date(), sleep: (ms, signal) => (ms === 15_000 ? (shutdown.abort(), Promise.resolve()) : new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))) };
      const rig = makeRig({ handler: { shutdown: shutdown.signal, clock } });
      const claimed = await rig.claim();
      cloud.githubDown = 5;
      expect(await rig.handle(claimed)).toEqual({ status: "aborted" });
      expect(cloud.runs.get(claimed.runId)?.endedBy).toMatchObject({ type: "run_ended", reason: "runner_shutdown" });
    });
  });
});

describe("the pieces together: poll, verify, run, done, then idle", () => {
  it("claims a queued job, runs it, reports it done, then waits as the idle reply says and stops on abort", async () => {
    const rig = makeRig();
    cloud.enqueue(signedJob());
    const controller = new AbortController();
    const handled: unknown[] = [];
    const end = await pollLoop({
      client: rig.client,
      clock: { ...rig.clock, sleep: async (ms) => void (rig.clock.slept.push(ms), controller.abort()) },
      gate: OPEN_GATE,
      signal: controller.signal,
      onClaimed: async (claimed) => void handled.push(await rig.handle(claimed)),
    });
    expect(end).toBe("stopped");
    expect(handled).toEqual([{ status: "completed", outcome: "succeeded", failureReason: null, prNumber: 7 }]);
    expect(rig.clock.slept).toContain(60_000);
    expect(sentToCloud()).toEqual(["/api/runner/claim", "/api/runner/runs/:id/events", "/api/runner/runs/:id/done", "/api/runner/claim"]);
  });
});

describe("git path B around the run (D#6 R4a-3)", () => {
  const ended = (runId: string) => cloud.runs.get(runId)?.endedBy;
  const throwing = (code: ConstructorParameters<typeof GitPathError>[0]) => async (): Promise<never> => {
    throw new GitPathError(code);
  };

  it("checks the job, fills the new workspace, runs, pushes the run's commit, and only then sends done", async () => {
    const seenAtPublish: string[][] = [];
    const filled: string[] = [];
    const git = fakeGitPath({
      async prepare(_job, _lease, workspace) {
        filled.push(workspace);
        return { base: "b".repeat(40) };
      },
      async publish(_job, _lease, workspace, base) {
        seenAtPublish.push(cloud.seen.map((s) => s.path.replace(/[0-9a-f-]{36}/, ":id")));
        expect({ workspace, base }).toEqual({ workspace: filled[0], base: "b".repeat(40) });
        return { pushed: true, branch: "fx/x", sha: "c".repeat(40) };
      },
    });
    const rig = makeRig({ handler: { git } });
    const claimed = await rig.claim();
    expect((await rig.handle(claimed)).status).toBe("completed");
    expect(git.calls.map((c) => c.split(" ")[0])).toEqual(["check", "prepare", "publish"]);
    expect(git.calls[0]).toBe(`check ${claimed.runId} g${claimed.leaseGeneration} fx/`);
    expect(path.dirname(filled[0]!)).toBe(rig.workspaces);
    // Nothing but the claim had gone to the cloud when the push ran; done followed it.
    expect(seenAtPublish).toEqual([["/api/runner/claim"]]);
    expect(sentToCloud().at(-1)).toBe("/api/runner/runs/:id/done");
  });

  it("a push that fails sends no done: run_ended runner_setup / push_failed, and the failure code is returned", async () => {
    const rig = makeRig({ handler: { git: fakeGitPath({ publish: throwing("push_failed") }) } });
    const claimed = await rig.claim();
    expect(await rig.handle(claimed)).toEqual({ status: "failed", reason: "push_failed" });
    expect(sentToCloud().some((p) => p.endsWith("/done"))).toBe(false);
    expect(ended(claimed.runId)).toMatchObject({ type: "run_ended", reason: "runner_setup", detail: "push_failed" });
  });

  it("a workspace that cannot be filled is removed, no sandbox is made, and the run ends runner_setup / workspace_failed", async () => {
    const rig = makeRig({ handler: { git: fakeGitPath({ prepare: throwing("workspace_failed") }) } });
    const claimed = await rig.claim();
    expect(await rig.handle(claimed)).toEqual({ status: "failed", reason: "workspace_failed" });
    expect(readdirSync(rig.workspaces)).toEqual([]);
    expect(rig.port.calls).toEqual([]);
    expect(ended(claimed.runId)).toMatchObject({ reason: "runner_setup", detail: "workspace_failed" });
  });

  it("the sandbox is started with the git path's read grants for this job, and with none when the path names none", async () => {
    const grant = "/cache/fx-runner/mirrors/00000000-0000-4000-8000-000000000000.git/objects";
    const rig = makeRig({ handler: { git: fakeGitPath({ readGrants: () => [grant] }) } });
    expect((await rig.handle(await rig.claim())).status).toBe("completed");
    expect(rig.port.starts.map((s) => s.extraReadPaths)).toEqual([[grant]]);
    rig.ledger.close();
    const plain = makeRig();
    expect((await plain.handle(await plain.claim())).status).toBe("completed");
    expect(plain.port.starts.map((s) => s.extraReadPaths)).toEqual([[]]);
  });

  it("a continuation on a role that is not the executor is refused as continues_wrong_role: one run_ended, nothing made", async () => {
    const base = jobFor({ role: "code-reviewer", role_tools_sha256: roleToolsDigest("code-reviewer"), continues: { parent_run_id: "22222222-2222-4222-8222-222222222222", session_id: "s1", branch: "fx/22222222-2222-4222-8222-222222222222-g1" } });
    const rig = makeRig();
    const claimed = await rig.claim(signRaw(base) as never);
    expect(await rig.handle(claimed)).toEqual({ status: "refused", reason: "continues_wrong_role" });
    expect(rig.runJobCalls()).toBe(0);
    expect(rig.port.calls).toEqual([]);
    expect(cloud.runs.get(claimed.runId)?.endedBy).toMatchObject({ type: "run_ended", reason: "job_refused", detail: "continues_wrong_role" });
  });

  it("R7b: a validly signed job whose allowances cross the floor is refused as sandbox_allowance_forbidden: one run_ended, no workspace, no sandbox", async () => {
    const entries = [{ kind: "path", value: "/home/jane/.ssh", access: "read", reason: "keys" }];
    const rig = makeRig();
    const claimed = await rig.claim(signRaw(jobFor({ sandbox_allowances: { entries, command_timeout_s: 600 } as never })) as never);
    expect(await rig.handle(claimed)).toEqual({ status: "refused", reason: "sandbox_allowance_forbidden" });
    expect(rig.runJobCalls()).toBe(0);
    expect(existsSync(rig.workspaces)).toBe(false);
    expect(rig.port.calls).toEqual([]);
    expect(cloud.runs.get(claimed.runId)?.endedBy).toMatchObject({ type: "run_ended", reason: "job_refused", detail: "sandbox_allowance_forbidden" });
  });

  it("R7b: two jobs on one runner: the repo with allowances starts with them, the repo without starts with none", async () => {
    const entries = [{ kind: "domain", value: "registry.npmjs.org", access: "connect", reason: "install" }];
    const rig = makeRig();
    const withSet = await rig.claim(signRaw(jobFor({ repo: { id: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets", private: true }, sandbox_allowances: { entries, command_timeout_s: 900 } as never })) as never);
    expect((await rig.handle(withSet)).status).toBe("completed");
    const without = await rig.claim(signRaw(jobFor({ repo: { id: "22222222-2222-4222-8222-222222222222", owner: "acme", name: "gadgets", private: true } })) as never);
    expect((await rig.handle(without)).status).toBe("completed");
    expect(rig.port.starts.map((s) => s.allowances)).toEqual([{ entries, commandTimeoutS: 900, storeKey: "11111111-1111-4111-8111-111111111111" }, undefined]);
  });

  it("a job the path will not push is refused before runJob: no workspace, no sandbox", async () => {
    const rig = makeRig({ handler: { git: fakeGitPath({ check: () => { throw new GitPathError("push_ref_refused"); } }) } });
    const claimed = await rig.claim();
    expect(await rig.handle(claimed)).toEqual({ status: "failed", reason: "push_ref_refused" });
    expect(rig.runJobCalls()).toBe(0);
    expect(existsSync(rig.workspaces)).toBe(false);
    expect(rig.port.calls).toEqual([]);
    expect(ended(claimed.runId)).toMatchObject({ reason: "runner_setup", detail: "push_ref_refused" });
  });

  it("a run that failed pushes nothing", async () => {
    const git = fakeGitPath();
    const rig = makeRig({ portOver: { end: (runId) => resultEvent(runId, { type: "error" }) }, handler: { git } });
    const claimed = await rig.claim();
    expect((await rig.handle(claimed)).status).toBe("failed");
    expect(git.calls.map((c) => c.split(" ")[0])).toEqual(["check", "prepare"]);
  });

  const RUN_BRANCH = "fx/22222222-2222-4222-8222-222222222222-g1";
  const continuing = (branch: string = RUN_BRANCH, over: Partial<ReturnType<typeof jobFor>> = {}) => jobFor({ continues: { parent_run_id: "33333333-3333-4333-8333-333333333333", session_id: "s1", branch }, ...over });

  it("a fix round whose branch is not a run branch is refused as job_refused before anything is made, whatever it is", async () => {
    // The claim client parses the job schema first, so a name with ".." never reaches the handler; verifyJob.test.ts covers the whole list.
    const bad = ["main", "fx/issue-12", "fx/22222222-2222-4222-8222-222222222222-g0", "refs/heads/x", "fx/22222222-2222-4222-8222-222222222222-g1000000000", "fx/22222222-2222-4222-8222-222222222222-g01", "FX/22222222-2222-4222-8222-222222222222-g1"];
    for (const branch of bad) {
      const git = fakeGitPath();
      const rig = makeRig({ handler: { git } });
      const claimed = await rig.claim(signRaw(continuing(branch)) as never);
      expect(await rig.handle(claimed), branch).toEqual({ status: "refused", reason: "continues_branch_invalid" });
      expect(rig.runJobCalls(), branch).toBe(0);
      expect(git.calls, branch).toEqual([]);
      expect(rig.port.calls, branch).toEqual([]);
      expect(existsSync(rig.workspaces), branch).toBe(false);
      const end = cloud.runs.get(claimed.runId)?.endedBy;
      expect(end, branch).toMatchObject({ type: "run_ended", reason: "job_refused" });
      expect(end?.detail, branch).toBeUndefined();
      rig.ledger.close();
    }
  });

  it("a fix round on a run branch is accepted: the branch need not belong to the parent run", async () => {
    const git = fakeGitPath({ prepare: async () => ({ base: "a".repeat(40) }) });
    const rig = makeRig({ handler: { git } });
    const claimed = await rig.claim(signRaw(continuing()) as never);
    expect((await rig.handle(claimed)).status).toBe("completed");
    expect(git.calls.map((c) => c.split(" ")[0])).toEqual(["check", "prepare", "publish"]);
  });

  it("a branch that is gone at prepare ends the run runner_setup / continuation_branch_missing and starts nothing", async () => {
    const rig = makeRig({ handler: { git: fakeGitPath({ prepare: throwing("continuation_branch_missing") }) } });
    const claimed = await rig.claim(signRaw(continuing()) as never);
    expect(await rig.handle(claimed)).toEqual({ status: "failed", reason: "continuation_branch_missing" });
    expect(rig.port.calls).toEqual([]);
    expect(readdirSync(rig.workspaces)).toEqual([]);
    expect(ended(claimed.runId)).toMatchObject({ reason: "runner_setup", detail: "continuation_branch_missing" });
  });

  it("a branch that is gone before the push sends no done and reports continuation_branch_missing", async () => {
    const rig = makeRig({ handler: { git: fakeGitPath({ publish: throwing("continuation_branch_missing") }) } });
    const claimed = await rig.claim(signRaw(continuing()) as never);
    expect(await rig.handle(claimed)).toEqual({ status: "failed", reason: "continuation_branch_missing" });
    expect(sentToCloud().some((p) => p.endsWith("/done"))).toBe(false);
    expect(ended(claimed.runId)).toMatchObject({ reason: "runner_setup", detail: "continuation_branch_missing" });
  });

  it("a rejected push sends no done and reports push_rejected, with no detail", async () => {
    const rig = makeRig({ handler: { git: fakeGitPath({ publish: throwing("push_rejected") }) } });
    const claimed = await rig.claim(signRaw(continuing()) as never);
    expect(await rig.handle(claimed)).toEqual({ status: "failed", reason: "push_rejected" });
    expect(sentToCloud().some((p) => p.endsWith("/done"))).toBe(false);
    const end = ended(claimed.runId);
    expect(end).toMatchObject({ type: "run_ended", reason: "push_rejected" });
    expect(end?.detail).toBeUndefined();
  });

  it("a stop reply seen by the time of the push is passed to the push, and a stop that arrives during it sends no done", async () => {
    let stopped: (() => boolean) | undefined;
    const holder: { rig?: ReturnType<typeof makeRig> } = {};
    const git = fakeGitPath({
      async publish(_job, _lease, _workspace, _base, askStopped) {
        stopped = askStopped;
        expect(askStopped?.()).toBe(false);
        cloud.force.events.push(stopBody("run_terminal"));
        holder.rig!.relay.emit(claimed.runId, localEvent(0));
        return { pushed: false };
      },
    });
    const rig = makeRig({ handler: { git } });
    holder.rig = rig;
    const claimed = await rig.claim();
    expect(await rig.handle(claimed)).toEqual({ status: "stopped", reason: "run_terminal" });
    expect(stopped?.()).toBe(true);
    expect(sentToCloud().some((p) => p.endsWith("/done"))).toBe(false);
  });

  it("a kept session whose workspace is not at the branch's tip is not resumed: a fresh workspace is made and filled", async () => {
    const kept = path.join(root, "work", "kept");
    mkdirSync(kept, { recursive: true });
    const decided: string[] = [];
    const git = fakeGitPath({ resume: async () => null, prepare: async () => ({ base: "d".repeat(40) }) });
    const rig = makeRig({ handler: { git } });
    rig.deps.run.planSession = (continues) => (decided.push("asked"), continues === null ? { kind: "fresh", branch: null } : { kind: "resume", sessionId: "s1", workspace: kept });
    const claimed = await rig.claim(signRaw(continuing()) as never);
    expect((await rig.handle(claimed)).status).toBe("completed");
    expect(git.calls.map((c) => c.split(" ")[0])).toEqual(["check", "resume", "prepare", "publish"]);
    expect(rig.port.starts.map((s) => s.workdir)).not.toContain(kept);
  });

  it("a kept session whose workspace is at the tip is resumed in place, and the tip is the base the push is checked against", async () => {
    const kept = path.join(root, "work", "kept");
    mkdirSync(kept, { recursive: true });
    let publishedBase: string | undefined;
    const git = fakeGitPath({ resume: async () => ({ base: "e".repeat(40) }), publish: async (_j, _l, _w, base) => ((publishedBase = base), { pushed: false }) });
    const rig = makeRig({ handler: { git } });
    rig.deps.run.planSession = () => ({ kind: "resume", sessionId: "s1", workspace: kept });
    const claimed = await rig.claim(signRaw(continuing()) as never);
    expect((await rig.handle(claimed)).status).toBe("completed");
    expect(git.calls.map((c) => c.split(" ")[0])).toEqual(["check", "resume", "publish"]);
    expect(rig.port.starts.map((s) => s.workdir)).toEqual([kept]);
    expect(publishedBase).toBe("e".repeat(40));
  });

  it("a fix round whose model hint is not in the price table ends model_unsupported before any git call, sandbox or run", async () => {
    const kept = path.join(root, "work", "kept");
    mkdirSync(kept, { recursive: true });
    const git = fakeGitPath({ resume: async () => ({ base: "e".repeat(40) }), prepare: async () => ({ base: "d".repeat(40) }) });
    const rig = makeRig({ handler: { git } });
    rig.deps.run.planSession = () => ({ kind: "resume", sessionId: "s1", workspace: kept });
    const claimed = await rig.claim(signRaw(continuing(RUN_BRANCH, { model_hint: "opus-9" })) as never);
    expect(await rig.handle(claimed)).toEqual({ status: "failed", reason: "model_unsupported" });
    // Not check, resume or prepare: the refusal comes before the first of them.
    expect(git.calls).toEqual([]);
    expect(rig.port.calls).toEqual([]);
    expect(rig.runJobCalls()).toBe(0);
    expect(sentToCloud().some((p) => p.endsWith("/done"))).toBe(false);
    expect(cloud.runs.get(claimed.runId)?.endedBy).toMatchObject({ type: "run_ended", reason: "runner_setup", detail: "model_unsupported" });
  });

  it("an error that is not the git path's own is not swallowed", async () => {
    const rig = makeRig({ handler: { git: fakeGitPath({ publish: async () => { throw new RangeError("boom"); } }) } });
    const claimed = await rig.claim();
    await expect(rig.handle(claimed)).rejects.toThrow("boom");
  });
});

describe("a take-over of a run (D#6 R4a-7)", () => {
  /** A watch whose take-over request the test raises by hand; it records what the handler does with it. */
  function fakeWatch() {
    const log: string[] = [];
    let raise: (() => void) | undefined;
    const watch: JobWatch = {
      async begin(job) {
        log.push(`begin ${job.role} ${job.repo}`);
        return {
          onTakeOver: (callback) => {
            raise = callback;
          },
          handOver: async () => {
            log.push("handOver");
            return true;
          },
          finish: async () => {
            log.push("finish");
          },
        };
      },
    };
    return { watch, log, ask: () => raise?.() };
  }

  /** Runs a job whose agent holds until it is interrupted, and takes it over. `obeys`: whether SIGINT ends the agent. */
  async function takeOver(obeys: boolean) {
    const w = fakeWatch();
    const git = fakeGitPath();
    const interrupts: string[] = [];
    const rig: ReturnType<typeof makeRig> = makeRig({
      portOver: { hold: true },
      handler: {
        git,
        watch: w.watch,
        interrupt: async (handle) => {
          interrupts.push(handle.sandboxName);
          if (obeys) await rig.port.port.stop(handle);
        },
      },
    });
    const claimed = await rig.claim();
    cloud.force.done.push({ status: 200, body: { continue: false, outcome: "failed", failure_reason: "taken_over", pr_number: null } });
    const running = rig.handle(claimed);
    await until(() => rig.port.calls.includes("start"));
    w.ask();
    return { result: await running, claimed, git, interrupts, log: w.log, rig };
  }

  it("sends the agent SIGINT, records one taken_over event and a done with no result, pushes nothing, then hands the pane over", async () => {
    const t = await takeOver(true);
    expect(t.result).toEqual({ status: "completed", outcome: "failed", failureReason: "taken_over", prNumber: null });
    expect(t.interrupts).toHaveLength(1);
    const events = cloud.runs.get(t.claimed.runId)!.events;
    expect(events.filter((e) => e.type === "taken_over")).toEqual([{ seq: expect.any(Number), ts: expect.any(String), type: "taken_over" }]);
    // The take-over is the last thing the run says before done, and done holds neither an envelope nor a verdict.
    expect(events.at(-1)?.type).toBe("taken_over");
    expect(sentToCloud().at(-1)).toBe("/api/runner/runs/:id/done");
    expect(cloud.seen.at(-1)?.body).toEqual({ run_id: t.claimed.runId, lease_generation: 1 });
    expect(t.git.calls.map((c) => c.split(" ")[0])).toEqual(["check", "prepare"]);
    const job = signedJob().job;
    expect(t.log).toEqual([`begin executor ${job.repo.owner}/${job.repo.name}`, "handOver", "finish"]);
  });

  it("an agent that ignores SIGINT is stopped with its sandbox after the grace, and the take-over is recorded all the same", async () => {
    const t = await takeOver(false);
    expect(t.interrupts).toHaveLength(1);
    expect(t.rig.port.calls).toContain("stop");
    expect(t.result.status).toBe("completed");
    expect(cloud.runs.get(t.claimed.runId)!.events.at(-1)?.type).toBe("taken_over");
  });

  it("a take-over asked for before the sandbox exists waits for it, then interrupts the agent", async () => {
    const w = fakeWatch();
    const interrupts: string[] = [];
    const rig: ReturnType<typeof makeRig> = makeRig({
      portOver: { hold: true },
      handler: {
        watch: w.watch,
        interrupt: async (handle) => {
          interrupts.push(handle.sandboxName);
          await rig.port.port.stop(handle);
        },
      },
    });
    const claimed = await rig.claim();
    cloud.force.done.push({ status: 200, body: { continue: false, outcome: "failed", failure_reason: "taken_over", pr_number: null } });
    const running = rig.handle(claimed);
    await until(() => w.log.length > 0);
    w.ask();
    expect(await running).toMatchObject({ status: "completed", failureReason: "taken_over" });
    expect(interrupts).toHaveLength(1);
    expect(cloud.runs.get(claimed.runId)!.events.at(-1)?.type).toBe("taken_over");
  });

  it("a take-over asked for after the run has ended is ignored: the run is reported as it ended", async () => {
    const w = fakeWatch();
    const interrupts: string[] = [];
    const rig = makeRig({
      handler: {
        watch: w.watch,
        interrupt: async (handle) => {
          interrupts.push(handle.sandboxName);
        },
      },
    });
    const claimed = await rig.claim();
    const result = await rig.handle(claimed);
    w.ask();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(interrupts).toEqual([]);
    expect(result).toEqual({ status: "completed", outcome: "succeeded", failureReason: null, prNumber: 7 });
    expect(cloud.runs.get(claimed.runId)!.events.some((e) => e.type === "taken_over")).toBe(false);
    expect(w.log).toEqual([expect.stringMatching(/^begin /), "finish"]);
  });

  it("a run with no watch (no tmux) runs as before", async () => {
    const rig = makeRig();
    const claimed = await rig.claim();
    expect((await rig.handle(claimed)).status).toBe("completed");
  });
});

describe("an api_key runner reads its key file at the start of each job (D#6 R5b-3)", () => {
  const KEY = ["sk-ant-", "api03-", "FIRSTKEY0123456789abcdef"].join("");
  const NEXT = ["sk-ant-", "api03-", "NEXTKEY9876543210zyxwvu"].join("");
  const uid = process.getuid!();
  const wired = () => {
    const rig = makeRig();
    const state = path.join(root, "state");
    writeApiKey(state, uid, KEY);
    const live = perJobApiKey(state, uid);
    rig.deps.run.credentials = live.credentials;
    rig.deps.credentialsReady = () => readyOrCode(() => live.refresh(), { out: () => undefined } as unknown as CommandContext);
    return { rig, state };
  };

  it("a key replaced between two jobs is the one the second job starts with, and neither key is anywhere in what is sent to the cloud", async () => {
    const { rig, state } = wired();
    expect((await rig.handle(await rig.claim())).status).toBe("completed");
    writeApiKey(state, uid, NEXT);
    expect((await rig.handle(await rig.claim())).status).toBe("completed");
    expect(rig.port.starts.map((start) => start.env.ANTHROPIC_API_KEY)).toEqual([KEY, NEXT]);
    expect(JSON.stringify(cloud.seen)).not.toMatch(/FIRSTKEY|NEXTKEY/);
  });

  it("a deleted file ends the job runner_setup / api_key_not_configured before any sandbox, mirror or process is made", async () => {
    const { rig, state } = wired();
    clearApiKey(state, uid);
    const claimed = await rig.claim();
    expect(await rig.handle(claimed)).toEqual({ status: "failed", reason: "api_key_not_configured" });
    expect(rig.port.calls).toEqual([]);
    expect(rig.port.starts).toHaveLength(0);
    expect(rig.runJobCalls()).toBe(0);
    expect(cloud.runs.get(claimed.runId)?.endedBy).toMatchObject({ type: "run_ended", reason: "runner_setup", detail: "api_key_not_configured" });
    // Putting the key back brings the next job back.
    writeApiKey(state, uid, NEXT);
    expect((await rig.handle(await rig.claim())).status).toBe("completed");
    expect(rig.port.starts[0]!.env.ANTHROPIC_API_KEY).toBe(NEXT);
  });

  it("a key file that is unsafe ends the job the same way", async () => {
    const { rig, state } = wired();
    chmodSync(path.join(state, CREDENTIALS_DIR, API_KEY_FILE), 0o644);
    const claimed = await rig.claim();
    expect(await rig.handle(claimed)).toEqual({ status: "failed", reason: "api_key_not_configured" });
    expect(rig.port.calls).toEqual([]);
  });
});

describe("the stage marks (D#6 C42-2)", () => {
  const throwing = (code: ConstructorParameters<typeof GitPathError>[0]) => async (): Promise<never> => {
    throw new GitPathError(code);
  };
  const continuing = () => jobFor({ continues: { parent_run_id: "33333333-3333-4333-8333-333333333333", session_id: "s1", branch: "fx/22222222-2222-4222-8222-222222222222-g1" } });
  const stagesOf = (runId: string): string[] => (cloud.runs.get(runId)?.events ?? []).filter((e) => e.type === "stage").map((e) => String(e.stage));

  it("a normal run sends workspace_ready then cloned, once each, before the engine's events, on one strictly rising seq line", async () => {
    const rig = makeRig();
    const claimed = await rig.claim();
    rig.port.port.startDetached = ((_h: SandboxHandle, opts: StartDetachedOptions) => {
      rig.relay.emit(opts.runId, localEvent(0));
      rig.relay.emit(opts.runId, localEvent(0));
      return { handle: { runId: "", sandboxName: "rn" }, hookFired: Promise.resolve(resultEvent(opts.runId)) };
    }) as SandboxPort["startDetached"];
    expect((await rig.handle(claimed)).status).toBe("completed");
    const events = cloud.runs.get(claimed.runId)?.events ?? [];
    expect(stagesOf(claimed.runId)).toEqual(["workspace_ready", "cloned"]);
    expect(events.map((e) => e.type)).toEqual(["stage", "stage", "tool_use", "tool_use"]);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it("a job refused before the workspace (the path will not push it) sends no workspace_ready and no cloned", async () => {
    const rig = makeRig({ handler: { git: fakeGitPath({ check: () => { throw new GitPathError("push_ref_refused"); } }) } });
    const claimed = await rig.claim();
    await rig.handle(claimed);
    expect(stagesOf(claimed.runId)).toEqual([]);
  });

  it("a duplicate job id sends no stage", async () => {
    const rig = makeRig();
    const signed = signedJob();
    await rig.handle(await rig.claim(signed));
    const again = await rig.claim(signed);
    expect(await rig.handle(again)).toEqual({ status: "duplicate" });
    expect(cloud.runs.get(again.runId)?.events.filter((e) => e.type === "stage")).toHaveLength(2);
  });

  it("a workspace that could not be filled sends workspace_ready but never cloned", async () => {
    const rig = makeRig({ handler: { git: fakeGitPath({ prepare: throwing("workspace_failed") }) } });
    const claimed = await rig.claim();
    await rig.handle(claimed);
    expect(stagesOf(claimed.runId)).toEqual(["workspace_ready"]);
  });

  it("a kept session resumed in place sends both marks once the resume succeeds", async () => {
    const kept = path.join(root, "work", "kept");
    mkdirSync(kept, { recursive: true });
    const rig = makeRig({ handler: { git: fakeGitPath({ resume: async () => ({ base: "e".repeat(40) }) }) } });
    rig.deps.run.planSession = () => ({ kind: "resume", sessionId: "s1", workspace: kept });
    const claimed = await rig.claim(signRaw(continuing()) as never);
    expect((await rig.handle(claimed)).status).toBe("completed");
    expect(stagesOf(claimed.runId)).toEqual(["workspace_ready", "cloned"]);
  });
});
