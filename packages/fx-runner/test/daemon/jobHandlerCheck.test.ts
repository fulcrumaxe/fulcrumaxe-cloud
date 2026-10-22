import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DoneCheck, NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient, type Claimed } from "../../src/daemon/client.js";
import type { CheckOutcome } from "../../src/daemon/checkStep.js";
import { createJobHandler, type JobHandlerDeps } from "../../src/daemon/jobHandler.js";
import { createEventRelay, type Clock } from "../../src/daemon/lease.js";
import { createFileLedger } from "../../src/daemon/ledger.js";
import type { NixShellStep } from "../../src/daemon/nixShell.js";
import { createPlaneBaseLedger } from "../../src/daemon/planePush.js";
import { pollLoop } from "../../src/daemon/pollLoop.js";
import { recordSession } from "../../src/engines/claude/session.js";
import { generateRunnerKey } from "../../src/keys.js";
import { checkNote } from "../../src/job/prompt.js";
import { runJob, type RunJobDeps } from "../../src/job/runJob.js";
import { createWorkspaceStore } from "../../src/job/workspace.js";
import type { SandboxPort, StartDetachedOptions } from "../../src/sandbox/port.js";
import { fakeGitPath } from "../helpers/fakeGitPath.js";
import { ledgerOptions } from "../helpers/ledgerOptions.js";
import { jobFor, KEYRING, signRaw } from "../helpers/signedJob.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";

/**
 * D#6 R-CHK-2 in the job handler: where the check sits in a run, and what was and was not called on each path. The check step itself is proved on real processes
 * in checkStep.test.ts and the sandbox launch on real bubblewrap in hostSandboxCheck.bwrap.test.ts; here it is a recording stand-in.
 */
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const PIN = "c".repeat(40);
const BRANCH = "fx/33333333-3333-4333-8333-333333333333-g1";
const ENTRIES = [{ kind: "domain" as const, value: "registry.npmjs.org", access: "connect" as const, reason: "install" }];
const CHECK = { argv: ["bash", "scripts/check.sh"], dev_shell: true, timeout_s: 5400 };
const PASSED: DoneCheck = { exit_code: 0, duration_ms: 12, timed_out: false, skipped_tests: 4, summary: "all good" };
const FAILED: DoneCheck = { exit_code: 1, duration_ms: 12, timed_out: false, skipped_tests: null, summary: "1 failed" };
const NO_SHELL: DoneCheck = { exit_code: null, duration_ms: 0, timed_out: false, skipped_tests: null, summary: "" };

let cloud: StrictRunnerCloud;
let root: string;
let rigs = 0;
beforeEach(async () => {
  cloud = await startStrictRunnerCloud();
  root = mkdtempSync(path.join(tmpdir(), "fxr-checkhandler-"));
});
afterEach(async () => {
  await cloud.close();
  rmSync(root, { recursive: true, force: true });
});

const clock: Clock = { now: () => new Date(), sleep: (ms, signal) => new Promise<void>((resolve) => { if (signal.aborted) return resolve(); const t = setTimeout(resolve, Math.min(ms, 1)); signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); }) };
const withShell: NixShellStep = { prepare: async () => ({ ok: true, env: { PATH: "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-node/bin" } }) } as unknown as NixShellStep;

function rig(over: { outcome?: CheckOutcome; shell?: boolean; wired?: boolean; onCheck?: () => void; pin?: string | null; skipHook?: boolean } = {}) {
  const key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  const client = createRunnerClient({ origin: cloud.origin, key, now: () => new Date(), fetchFn: fetch });
  const order: string[] = [];
  const starts: StartDetachedOptions[] = [];
  const checkInputs: Array<{ base: string; baseDir: string; argv: readonly string[]; devShell: boolean | undefined }> = [];
  const port: SandboxPort = {
    async createSandbox(opts) { return { runId: "", sandboxName: opts.sandboxName }; },
    startDetached: (handle, opts) => {
      order.push("agent");
      starts.push(opts);
      const event: NormalizedEvent = { runId: opts.runId, role: "executor", seq: 1, type: "result", ts: "2026-10-08T12:00:00.000Z", sessionId: "s1", agentOutput: { verdict: "done" } };
      return { handle, hookFired: Promise.resolve(event) };
    },
    resume: () => { throw new Error("not used"); },
    async extendTimeout() {}, async stop() {}, async deleteSandbox() { order.push("sandbox_deleted"); }, async measure() { return []; }, async readCounters() { return undefined; }, async writeFiles() {}, async runCommand(): Promise<never> { throw new Error("not used"); }, async sandboxExists() { return true; },
  };
  const run: Omit<RunJobDeps, "sandbox" | "ledger"> = { workspaces: createWorkspaceStore(path.join(root, "work")), credentials: { mode: "subscription" }, planSession: () => ({ kind: "fresh", branch: null }), defaultModel: "sonnet" };
  const git = fakeGitPath({ prepare: async () => ({ base: BASE }), publish: async () => (order.push("publish"), { pushed: true, branch: BRANCH, sha: HEAD }) });
  git.mirrorDir = (job) => `/mirrors/${job.repo.id}.git`;
  // The pin is the merge-base with the default branch, never the commit the run started from (BASE).
  git.checkBase = async () => (over.pin === undefined ? PIN : over.pin);
  const deps: JobHandlerDeps = {
    client, keyring: KEYRING, clock, run, sandbox: port, ledger: createFileLedger(path.join(root, `jobs-${++rigs}.json`), ledgerOptions()), git, events: createEventRelay(),
    recordSession: (id, workspace) => recordSession(path.join(root, "sessions.json"), id, workspace), heartbeatMs: 1e9, flushMs: 1e9, runJobFn: runJob,
    ...(over.shell === false ? {} : { nix: withShell }),
    ...(over.skipHook === true ? { runJobFn: (async (job: never, d: RunJobDeps) => { const done = await runJob(job, { ...d, afterAgent: undefined }); return done; }) as typeof runJob } : {}),
    planePush: { baseLedger: createPlaneBaseLedger(), run: async () => (order.push("hook"), { kind: "pr_opened" as const, number: 9, seconds: 1 }) },
    ...(over.wired === false ? {} : {
      checkStep: async (input) => {
        order.push("check");
        // The sandbox still exists while the check runs: it is deleted after.
        checkInputs.push({ base: input.base, baseDir: input.baseDir, argv: input.check.argv, devShell: input.check.dev_shell });
        input.launch(input.check.argv, input.check.dev_shell);
        over.onCheck?.();
        return over.outcome ?? { passed: true, body: PASSED };
      },
      checkLaunch: () => ({ tool: "x", args: [], env: {} }),
      baseFile: async () => null,
    }),
  };
  return {
    order, starts, checkInputs, deps, handle: createJobHandler(deps), client,
    async claim(job: ReturnType<typeof jobFor>): Promise<Claimed> {
      cloud.enqueue(signRaw(job) as never);
      const claimed = await client.claim();
      if (claimed.kind !== "claimed") throw new Error("expected a claim");
      return claimed;
    },
  };
}

const withCheck = (check: typeof CHECK | undefined = CHECK) => jobFor({ sandbox_allowances: { entries: ENTRIES, command_timeout_s: 600 }, ...(check === undefined ? {} : { check }) });
const bodies = (suffix: string): Array<Record<string, unknown>> => cloud.seen.filter((s) => s.path.endsWith(suffix)).map((s) => s.body as Record<string, unknown>);
const runEnded = () => bodies("/events").flatMap((b) => (b.events as Array<Record<string, unknown>>).filter((e) => e.type === "run_ended"));

describe("a job with a check", () => {
  it("runs it after the agent and before the branch is pushed, while the sandbox still exists, then done carries the result", async () => {
    const r = rig();
    const job = withCheck();
    const result = await r.handle(await r.claim(job));
    expect(result.status).toBe("completed");
    expect(r.order).toEqual(["agent", "check", "sandbox_deleted", "publish", "hook"]);
    expect(r.checkInputs).toEqual([{ base: PIN, baseDir: expect.stringMatching(/^\/mirrors\/.*\.git$/), argv: CHECK.argv, devShell: true }]);
    expect(bodies("/done")).toHaveLength(1);
    expect(bodies("/done")[0]!.check).toEqual(PASSED);
    expect(runEnded()).toEqual([]);
  });

  it("tells the agent, in one fixed line built from the signed vector, that the check runs after it", async () => {
    const r = rig();
    await r.handle(await r.claim(withCheck()));
    expect(checkNote(CHECK)).toContain("`bash scripts/check.sh`");
    expect(checkNote(CHECK)).not.toContain("nix develop");
    expect(r.starts[0]!.prompt).toContain(checkNote(CHECK));
  });

  it("a failing check still pushes the run branch, never enters the public-push hook, and ends the run check_failed; done carries the result", async () => {
    const r = rig({ outcome: { passed: false, body: FAILED } });
    const result = await r.handle(await r.claim(withCheck()));
    expect(r.order).toEqual(["agent", "check", "sandbox_deleted", "publish"]);
    expect(runEnded()).toEqual([expect.objectContaining({ reason: "check_failed" })]);
    expect(runEnded()[0]).not.toHaveProperty("detail");
    expect(bodies("/done")[0]!.check).toEqual(FAILED);
    expect(["completed", "stopped"]).toContain(result.status);
  });

  it("a timed-out check is a failure in the same way", async () => {
    const timedOut: DoneCheck = { exit_code: null, duration_ms: 5_400_000, timed_out: true, skipped_tests: null, summary: "" };
    const r = rig({ outcome: { passed: false, body: timedOut } });
    await r.handle(await r.claim(withCheck()));
    expect(r.order).not.toContain("hook");
    expect(runEnded().map((e) => e.reason)).toEqual(["check_failed"]);
    expect(bodies("/done")[0]!.check).toEqual(timedOut);
  });

  it("a check that needs the dev shell when none was built is not run, never passes, and says check_no_dev_shell", async () => {
    const r = rig({ shell: false });
    await r.handle(await r.claim(withCheck()));
    expect(r.order).toEqual(["agent", "sandbox_deleted", "publish"]);
    expect(runEnded()).toEqual([expect.objectContaining({ reason: "check_failed", detail: "check_no_dev_shell" })]);
    expect(bodies("/done")[0]!.check).toEqual(NO_SHELL);
  });

  it("a check without the dev shell runs where there is none", async () => {
    const r = rig({ shell: false });
    await r.handle(await r.claim(jobFor({ check: { ...CHECK, dev_shell: false } })));
    expect(r.order).toEqual(["agent", "check", "sandbox_deleted", "publish", "hook"]);
    expect(bodies("/done")[0]!.check).toEqual(PASSED);
  });

  it("a handler with no check step wired fails the check, it does not pass by default", async () => {
    const r = rig({ wired: false });
    await r.handle(await r.claim(withCheck()));
    expect(r.order).not.toContain("hook");
    expect(runEnded().map((e) => e.reason)).toEqual(["check_failed"]);
    expect(bodies("/done")[0]!.check).toMatchObject({ exit_code: null, timed_out: false, duration_ms: 0 });
  });

  it("pins to the merge-base with the default branch; with none, or no mirror, the check fails and is not run", async () => {
    const none = rig({ pin: null });
    await none.handle(await none.claim(withCheck()));
    expect(none.order).not.toContain("check");
    expect(none.order).not.toContain("hook");
    expect(runEnded().map((e) => e.reason)).toEqual(["check_failed"]);
    expect(bodies("/done")[0]!.check).toMatchObject({ exit_code: null, timed_out: false });
  });

  it("a job with a check whose hook never recorded an outcome is a failure, not a pass", async () => {
    const r = rig({ skipHook: true });
    await r.handle(await r.claim(withCheck()));
    expect(r.order).not.toContain("hook");
    expect(runEnded().map((e) => e.reason)).toEqual(["check_failed"]);
  });

  it("a job without a check is as it was: no check call, no note, done carries none", async () => {
    const r = rig();
    await r.handle(await r.claim(jobFor()));
    expect(r.order).toEqual(["agent", "sandbox_deleted", "publish", "hook"]);
    expect(bodies("/done")[0]).not.toHaveProperty("check");
    expect(r.starts[0]!.prompt).not.toContain("the runner runs this repository's check");
  });

  it("holds the job's one admission slot for the whole check, and takes no second", async () => {
    let inHand = 0;
    let peak = 0;
    let duringCheck = -1;
    const r = rig({ onCheck: () => { duringCheck = inHand; } });
    const claimed = await r.claim(withCheck());
    const stop = new AbortController();
    let served = false;
    const admission = {
      snapshot: () => ({ capacity: { light: 1, heavy: 1 }, free: { light: 1, heavy: 1 }, limitedBy: null }),
      classOf: () => "heavy" as const,
      begin: () => (inHand += 1, (peak = Math.max(peak, inHand)), () => { inHand -= 1; }),
      sample: () => undefined,
    };
    const client = { async claim() { if (served) { stop.abort(); return { kind: "idle" as const, retryAfter: 1 }; } served = true; return claimed; } };
    await pollLoop({ client: client as never, clock, gate: { check: async () => ({ open: true }) } as never, signal: stop.signal, onClaimed: r.handle as never, admission: admission as never });
    expect(duringCheck).toBe(1);
    expect(peak).toBe(1);
    expect(inHand).toBe(0);
  });
});
