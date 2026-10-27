import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DoneCheck, NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient, type Claimed } from "../../src/daemon/client.js";
import type { CheckOutcome } from "../../src/daemon/checkStep.js";
import { createJobHandler, type JobHandlerDeps } from "../../src/daemon/jobHandler.js";
import type { LockSyncOutcome } from "../../src/daemon/lockfileSync.js";
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

function rig(over: { lockfile?: { outcome: LockSyncOutcome | "throws"; inputs: Array<{ base: string; registryHost: string | undefined }>; stubSeen?: boolean[]; stopFails?: boolean }; outcome?: CheckOutcome; shell?: boolean; wired?: boolean; onCheck?: () => void; pin?: string | null; skipHook?: boolean; steps?: string[]; hangUntilStopped?: { onStart: () => void; seen: { aborted?: boolean } }; heartbeatMs?: number; recordStop?: boolean } = {}) {
  const key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  const client = createRunnerClient({ origin: cloud.origin, key, now: () => new Date(), fetchFn: fetch });
  const order: string[] = [];
  let held = "";
  const starts: StartDetachedOptions[] = [];
  const checkInputs: Array<{ base: string; baseDir: string; argv: readonly string[]; devShell: boolean | undefined }> = [];
  const port: SandboxPort = {
    async createSandbox(opts) { return { runId: "", sandboxName: opts.sandboxName }; },
    startDetached: (handle, opts) => {
      order.push("agent");
      starts.push(opts);
      // What the agent CLI leaves behind: an empty placeholder over a protected name, made during the run (it was not there at the baseline).
      if (over.lockfile?.stubSeen !== undefined) writeFileSync(path.join(held, ".npmrc"), "");
      const event: NormalizedEvent = { runId: opts.runId, role: "executor", seq: 1, type: "result", ts: "2026-10-08T12:00:00.000Z", sessionId: "s1", agentOutput: { verdict: "done" } };
      return { handle, hookFired: Promise.resolve(event) };
    },
    resume: () => { throw new Error("not used"); },
    async extendTimeout() {}, async stop() { if (over.lockfile !== undefined || over.recordStop === true) order.push("agent_stopped"); if (over.lockfile?.stopFails === true) throw new Error("group survived at /home/someone/x"); }, async deleteSandbox() { order.push("sandbox_deleted"); }, async measure() { return []; }, async readCounters() { return undefined; }, async writeFiles() {}, async runCommand(): Promise<never> { throw new Error("not used"); }, async sandboxExists() { return true; },
  };
  const run: Omit<RunJobDeps, "sandbox" | "ledger"> = { workspaces: createWorkspaceStore(path.join(root, "work")), credentials: { mode: "subscription" }, planSession: () => ({ kind: "fresh", branch: null }), defaultModel: "sonnet" };
  const git = fakeGitPath({ prepare: async (_job, _claimed, workspace) => { held = workspace; return { base: BASE }; }, publish: async () => (order.push("publish"), { pushed: true, branch: BRANCH, sha: HEAD }) });
  git.mirrorDir = (job) => `/mirrors/${job.repo.id}.git`;
  // The pin is the merge-base with the default branch, never the commit the run started from (BASE).
  git.checkBase = async () => (over.pin === undefined ? PIN : over.pin);
  const deps: JobHandlerDeps = {
    client, keyring: KEYRING, clock, run, sandbox: port, ledger: createFileLedger(path.join(root, `jobs-${++rigs}.json`), ledgerOptions()), git, events: createEventRelay(),
    recordSession: (id, workspace) => recordSession(path.join(root, "sessions.json"), id, workspace), heartbeatMs: over.heartbeatMs ?? 1e9, flushMs: 1e9, runJobFn: runJob,
    ...(over.steps === undefined ? {} : { onStep: (line: string) => over.steps!.push(line) }),
    ...(over.shell === false ? {} : { nix: withShell }),
    ...(over.lockfile === undefined ? {} : { lockfileSync: { run: async (input: { base: string; registryHost?: string | undefined }) => {
      order.push("lockfile");
      over.lockfile!.stubSeen?.push(existsSync(path.join(held, ".npmrc")));
      over.lockfile!.inputs.push({ base: input.base, registryHost: input.registryHost });
      if (over.lockfile!.outcome === "throws") throw new Error("boom at /home/someone/secret");
      return over.lockfile!.outcome;
    } } }),
    ...(over.skipHook === true ? { runJobFn: (async (job: never, d: RunJobDeps) => { const done = await runJob(job, { ...d, afterAgent: undefined }); return done; }) as typeof runJob } : {}),
    planePush: { baseLedger: createPlaneBaseLedger(), run: async () => (order.push("hook"), { kind: "pr_opened" as const, number: 9, seconds: 1 }) },
    ...(over.wired === false ? {} : {
      checkStep: async (input) => {
        order.push("check");
        // The sandbox still exists while the check runs: it is deleted after.
        checkInputs.push({ base: input.base, baseDir: input.baseDir, argv: input.check.argv, devShell: input.check.dev_shell });
        input.launch(input.check.argv, input.check.dev_shell);
        over.onCheck?.();
        if (over.hangUntilStopped !== undefined) {
          // A check that waits on something that never comes (as the live one waited on the network): it ends only when the run is stopped, as the real step ends its process group.
          over.hangUntilStopped.onStart();
          await new Promise<void>((resolve) => (input.signal?.aborted === true ? resolve() : input.signal?.addEventListener("abort", () => resolve(), { once: true })));
          over.hangUntilStopped.seen.aborted = true;
          return { passed: false, body: { exit_code: null, duration_ms: 7, timed_out: false, skipped_tests: null, summary: "" } };
        }
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

  it("brings the lockfile up to date after the agent and before the check, from the start commit and the job's registry host, and says so on a step line", async () => {
    const lockfile = { outcome: { kind: "updated" } as LockSyncOutcome, inputs: [] as Array<{ base: string; registryHost: string | undefined }> };
    const steps: string[] = [];
    const r = rig({ lockfile, steps });
    await r.handle(await r.claim(withCheck()));
    // The agent's process tree is stopped before the runner touches the workspace, and the sandbox is still there for the check.
    expect(r.order.slice(0, 4)).toEqual(["agent", "agent_stopped", "lockfile", "check"]);
    expect(r.order.indexOf("sandbox_deleted")).toBeGreaterThan(r.order.indexOf("check"));
    expect(lockfile.inputs).toEqual([{ base: BASE, registryHost: "registry.npmjs.org" }]);
    expect(steps.some((s) => s.includes("lockfile update ended (updated)"))).toBe(true);
  });

  it("an agent that cannot be stopped is never followed by a host-side lockfile update or a check: the check ends as not run (agent_not_stopped), the run still ends", async () => {
    const lockfile = { outcome: { kind: "updated" } as LockSyncOutcome, inputs: [] as Array<{ base: string; registryHost: string | undefined }>, stopFails: true };
    const steps: string[] = [];
    const r = rig({ lockfile, steps });
    await r.handle(await r.claim(withCheck()));
    expect(lockfile.inputs).toEqual([]);
    expect(r.order).not.toContain("lockfile");
    expect(r.order).not.toContain("check");
    expect(r.order).not.toContain("hook");
    expect(steps.some((l) => l.includes("lockfile update ended (not run: the agent could not be stopped)"))).toBe(true);
    expect(steps.some((l) => l.includes("check not run (agent_not_stopped)"))).toBe(true);
    expect(bodies("/done")[0]!.check).toMatchObject({ exit_code: null, timed_out: false, duration_ms: 0, reason: "agent_not_stopped" });
    expect(steps.join("\n")).not.toContain("someone");
  });

  it("the agent is stopped before the check's host reads even when no lockfile update is wired", async () => {
    const r = rig({ recordStop: true });
    expect(r.deps.lockfileSync).toBeUndefined();
    await r.handle(await r.claim(withCheck()));
    expect(r.order.slice(0, 3)).toEqual(["agent", "agent_stopped", "check"]);
  });

  it("runs after the agent's placeholders are cleared, so the update never sees them", async () => {
    const lockfile = { outcome: { kind: "none" } as LockSyncOutcome, inputs: [], stubSeen: [] as boolean[] };
    const r = rig({ lockfile });
    await r.handle(await r.claim(withCheck()));
    expect(lockfile.stubSeen).toEqual([false]);
  });

  it("a lockfile update that fails, is refused or throws never stops the run: the check still runs, and only the closed code is on the step line", async () => {
    for (const [outcome, line] of [
      [{ kind: "failed", why: "needs_network" }, "lockfile update ended (failed: needs_network)"],
      [{ kind: "refused", reason: "other_host_tarball" }, "lockfile update ended (refused: other_host_tarball)"],
      ["throws", "lockfile update ended (lockfile_sync_failed)"],
    ] as const) {
      const steps: string[] = [];
      const r = rig({ lockfile: { outcome: outcome as LockSyncOutcome | "throws", inputs: [] }, steps });
      await r.handle(await r.claim(withCheck()));
      expect(r.order).toContain("check");
      expect(steps.some((s) => s.includes(line))).toBe(true);
      expect(steps.join("\n")).not.toContain("someone");
    }
  });

  it("a lockfile update that found nothing to do says nothing", async () => {
    const steps: string[] = [];
    const r = rig({ lockfile: { outcome: { kind: "none" }, inputs: [] }, steps });
    await r.handle(await r.claim(withCheck()));
    expect(steps.some((s) => s.includes("lockfile update"))).toBe(false);
  });

  it("tells the agent, in one fixed line built from the signed vector, that the check runs after it", async () => {
    const r = rig();
    await r.handle(await r.claim(withCheck()));
    expect(checkNote(CHECK)).toContain("`bash scripts/check.sh`");
    expect(checkNote(CHECK)).not.toContain("nix develop");
    expect(r.starts[0]!.prompt).toContain(checkNote(CHECK, "executor"));
  });

  it("hands the signed vector to the agent's start, so the engine denies it to the agent's shell (the runner runs it, the agent does not)", async () => {
    const r = rig();
    await r.handle(await r.claim(withCheck()));
    expect(r.starts[0]!.checkArgv).toEqual(CHECK.argv);
    expect(r.starts[0]!.prompt).toContain("Do not run that command yourself");
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
    expect(bodies("/done")[0]!.check).toMatchObject({ exit_code: null, timed_out: false, duration_ms: 0, reason: "not_set_up" });
  });

  it("pins to the merge-base with the default branch; with none, or no mirror, the check fails and is not run", async () => {
    const none = rig({ pin: null });
    await none.handle(await none.claim(withCheck()));
    expect(none.order).not.toContain("check");
    expect(none.order).not.toContain("hook");
    expect(runEnded().map((e) => e.reason)).toEqual(["check_failed"]);
    expect(bodies("/done")[0]!.check).toMatchObject({ exit_code: null, timed_out: false, reason: "base_missing" });
  });

  it("a job with a check whose hook never recorded an outcome is a failure, not a pass", async () => {
    const r = rig({ skipHook: true });
    await r.handle(await r.claim(withCheck()));
    expect(r.order).not.toContain("hook");
    expect(runEnded().map((e) => e.reason)).toEqual(["check_failed"]);
    // The fallback is the closed reason `other`, not a missing reason: the cloud words it as a check that could not run safely.
    expect(bodies("/done")[0]!.check).toMatchObject({ exit_code: null, reason: "other" });
  });

  it("a job without a check is as it was: no check call, no note, done carries none", async () => {
    const r = rig();
    await r.handle(await r.claim(jobFor()));
    expect(r.order).toEqual(["agent", "sandbox_deleted", "publish", "hook"]);
    expect(bodies("/done")[0]).not.toHaveProperty("check");
    expect(r.starts[0]!.prompt).not.toContain("the runner runs this repository's approved check");
    expect(r.starts[0]!.prompt).not.toContain("Do not run that command yourself");
    expect(r.starts[0]!).not.toHaveProperty("checkArgv");
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
      snapshot: () => ({ capacity: { light: 1, heavy: 1 }, free: { light: 1, heavy: 1 }, limitedBy: null, limits: { light: null, heavy: null } }),
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

describe("a check that is blocked, and a run the cloud has stopped", () => {
  it("the next heartbeat's stop reaches the check through the run's signal, the check ends, and the run ends stopped with no done and no push", async () => {
    const seen: { aborted?: boolean } = {};
    const steps: string[] = [];
    let runId = "";
    const r = rig({ steps, heartbeatMs: 20, hangUntilStopped: { seen, onStart: () => cloud.stopRun(runId, "run_terminal") } });
    const job = withCheck();
    runId = job.run_id;
    const result = await r.handle(await r.claim(job));
    expect(seen.aborted).toBe(true);
    expect(result).toEqual({ status: "stopped", reason: "run_terminal" });
    expect(r.order).toEqual(["agent", "check", "sandbox_deleted"]);
    expect(bodies("/done")).toEqual([]);
    expect(steps.some((line) => line.includes("heartbeat answered stop (run_terminal, http 409)"))).toBe(true);
    expect(steps.some((line) => /check ended \(exit none, 7 ms, timed_out false, stopped\)/.test(line))).toBe(true);
  });
});

describe("the journal line per step", () => {
  it("a run with a check says: agent turn started and ended, check started and ended with exit code, duration and timed_out, and done posted with the status", async () => {
    const steps: string[] = [];
    const r = rig({ steps, outcome: { passed: true, body: { ...PASSED, duration_ms: 1234 } } });
    const job = withCheck();
    await r.handle(await r.claim(job));
    const p = `fx-runner: run ${job.run_id}: `;
    expect(steps).toEqual([
      `${p}agent turn started`,
      `${p}agent turn ended (result)`,
      `${p}check started (time limit 5400 s)`,
      `${p}check ended (exit 0, 1234 ms, timed_out false)`,
      `${p}done posted (http 200)`,
    ]);
  });

  it("a timed-out check says timed_out true, and the run_ended of the failure says what the cloud answered", async () => {
    const timedOut: DoneCheck = { exit_code: null, duration_ms: 5_400_000, timed_out: true, skipped_tests: null, summary: "" };
    const steps: string[] = [];
    const r = rig({ steps, outcome: { passed: false, body: timedOut } });
    const job = withCheck();
    await r.handle(await r.claim(job));
    const p = `fx-runner: run ${job.run_id}: `;
    expect(steps).toContain(`${p}check ended (exit none, 5400000 ms, timed_out true)`);
    expect(steps).toContain(`${p}run_ended check_failed posted (http 200)`);
    expect(steps).toContain(`${p}done posted (http 200)`);
  });

  it("a check that was not run says why, in a closed word", async () => {
    const steps: string[] = [];
    const r = rig({ steps, shell: false });
    const job = withCheck();
    await r.handle(await r.claim(job));
    expect(steps).toContain(`fx-runner: run ${job.run_id}: check not run (check_no_dev_shell)`);
    expect(steps.some((line) => line.includes("check started"))).toBe(false);
  });

  it("no line holds the check's output or its arguments: only the run id, fixed words, numbers and closed codes", async () => {
    const steps: string[] = [];
    const r = rig({ steps, outcome: { passed: false, body: { ...FAILED, summary: "PRIVATE-OUTPUT-MARKER" } } });
    await r.handle(await r.claim(withCheck()));
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.join("\n")).not.toMatch(/PRIVATE-OUTPUT-MARKER|scripts\/check\.sh/);
  });

  it("without onStep nothing is written and the run is as before", async () => {
    const r = rig();
    const result = await r.handle(await r.claim(withCheck()));
    expect(result.status).toBe("completed");
  });
});
