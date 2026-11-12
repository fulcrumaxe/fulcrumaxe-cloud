import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFINED_READ_ROLES, type DoneCheck, type NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient, type Claimed } from "../../src/daemon/client.js";
import type { CheckOutcome } from "../../src/daemon/checkStep.js";
import { GitPathError } from "../../src/daemon/git.js";
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
import { roleToolsDigest } from "../../src/job/roleTools.js";
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

function rig(over: { updatedTo?: string; prepareThrows?: GitPathError; lockfile?: { outcome: LockSyncOutcome | "throws"; inputs: Array<{ base: string; registryHost: string | undefined }>; stubSeen?: boolean[]; stopFails?: boolean }; outcome?: CheckOutcome; shell?: boolean; wired?: boolean; onCheck?: () => void; pin?: string | null; skipHook?: boolean; steps?: string[]; hangUntilStopped?: { onStart: () => void; seen: { aborted?: boolean } }; heartbeatMs?: number; recordStop?: boolean; changed?: { files: string[] | null | "throws"; calls: Array<{ workspace: string; base: string }> }; derived?: { table: object; files: Record<string, string>; generated: Record<string, string>; ran: string[]; dirty?: string[]; head?: Record<string, string | null>; hidden?: boolean } } = {}) {
  const key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  const client = createRunnerClient({ origin: cloud.origin, key, now: () => new Date(), fetchFn: fetch });
  const order: string[] = [];
  let held = "";
  const starts: StartDetachedOptions[] = [];
  const spiedLedger = createPlaneBaseLedger();
  const recordedBases: string[] = [];
  const checkInputs: Array<{ base: string; baseDir: string; argv: readonly string[]; devShell: boolean | undefined }> = [];
  const port: SandboxPort = {
    async createSandbox(opts) { return { runId: "", sandboxName: opts.sandboxName }; },
    startDetached: (handle, opts) => {
      order.push("agent");
      starts.push(opts);
      // What the agent CLI leaves behind: an empty placeholder over a protected name, made during the run (it was not there at the baseline).
      if (over.lockfile?.stubSeen !== undefined) writeFileSync(path.join(held, ".npmrc"), "");
      // #751: the files the agent left behind (a route's generated output, as it committed it).
      for (const [rel, text] of Object.entries(over.derived?.files ?? {})) { mkdirSync(path.dirname(path.join(held, rel)), { recursive: true }); writeFileSync(path.join(held, rel), text); }
      const event: NormalizedEvent = { runId: opts.runId, role: "executor", seq: 1, type: "result", ts: "2026-10-08T12:00:00.000Z", sessionId: "s1", agentOutput: { verdict: "done" } };
      return { handle, hookFired: Promise.resolve(event) };
    },
    resume: () => { throw new Error("not used"); },
    async extendTimeout() {}, async stop() { if (over.lockfile !== undefined || over.recordStop === true) order.push("agent_stopped"); if (over.lockfile?.stopFails === true) throw new Error("group survived at /home/someone/x"); }, async deleteSandbox() { order.push("sandbox_deleted"); }, async measure() { return []; }, async readCounters() { return undefined; }, async writeFiles() {}, async runCommand(): Promise<never> { throw new Error("not used"); }, async sandboxExists() { return true; },
  };
  const run: Omit<RunJobDeps, "sandbox" | "ledger"> = { workspaces: createWorkspaceStore(path.join(root, "work")), credentials: { mode: "subscription" }, planSession: () => ({ kind: "fresh", branch: null }), defaultModel: "sonnet" };
  const git = fakeGitPath({ prepare: async (_job, _claimed, workspace) => { held = workspace; if (over.prepareThrows !== undefined) throw over.prepareThrows; return { base: BASE, ...(over.updatedTo === undefined ? {} : { updatedTo: over.updatedTo }) }; }, publish: async () => (order.push("publish"), { pushed: true, branch: BRANCH, sha: HEAD }) });
  git.mirrorDir = (job) => `/mirrors/${job.repo.id}.git`;
  // The pin is the merge-base with the default branch, never the commit the run started from (BASE).
  git.checkBase = async () => (over.pin === undefined ? PIN : over.pin);
  const deps: JobHandlerDeps = {
    client, keyring: KEYRING, clock, run, sandbox: port, ledger: createFileLedger(path.join(root, `jobs-${++rigs}.json`), ledgerOptions()), git, events: createEventRelay(),
    recordSession: (id, workspace) => recordSession(path.join(root, "sessions.json"), id, workspace), heartbeatMs: over.heartbeatMs ?? 1e9, flushMs: 1e9, runJobFn: runJob,
    ...(over.steps === undefined ? {} : { onStep: (line: string) => over.steps!.push(line) }),
    ...(over.shell === false ? {} : { nix: withShell }),
    ...(over.changed === undefined ? {} : { changedFiles: async (workspace: string, base: string) => {
      // #751: the listing against HEAD (what the working tree holds that the pushed commit does not).
      if (base === "HEAD") return over.derived?.dirty ?? [];
      order.push("changed_files");
      over.changed!.calls.push({ workspace, base });
      if (over.changed!.files === "throws") throw new Error("boom at /home/someone/secret");
      return over.changed!.files;
    } }),
    ...(over.derived === undefined ? {} : {
      // #751: HEAD's blob of a file (by default the bytes the agent left, as if committed) and whether the index hides changes.
      headBlob: async (_workspace: string, relative: string) => { const text = over.derived!.head !== undefined && relative in over.derived!.head ? over.derived!.head[relative] : over.derived!.files[relative]; return text === undefined || text === null ? null : Buffer.from(text); },
      indexHidesChanges: async () => over.derived!.hidden === true,
    }),
    ...(over.lockfile === undefined ? {} : { lockfileSync: { run: async (input: { base: string; registryHost?: string | undefined }) => {
      order.push("lockfile");
      over.lockfile!.stubSeen?.push(existsSync(path.join(held, ".npmrc")));
      over.lockfile!.inputs.push({ base: input.base, registryHost: input.registryHost });
      if (over.lockfile!.outcome === "throws") throw new Error("boom at /home/someone/secret");
      return over.lockfile!.outcome;
    } } }),
    ...(over.skipHook === true ? { runJobFn: (async (job: never, d: RunJobDeps) => { const done = await runJob(job, { ...d, afterAgent: undefined }); return done; }) as typeof runJob } : {}),
    // D#749 V2b: a browser job (the deploy verifier, one of the confined roles below) starts only when the daemon's own probe says Chrome is connected.
    browserReady: () => undefined,
    planePush: { baseLedger: { ...spiedLedger, record: (runId: string, b: string) => (recordedBases.push(b), spiedLedger.record(runId, b)) }, run: async () => (order.push("hook"), { kind: "pr_opened" as const, number: 9, seconds: 1 }) },
    ...(over.wired === false ? {} : {
      checkStep: async (input) => {
        // #751: a generator the table names, run through the check step: it rewrites its output from the "truth" the test gives (the real step runs it under the sandbox).
        const generated = over.derived?.generated[input.check.argv[0] ?? ""];
        if (generated !== undefined) {
          over.derived!.ran.push(input.check.argv[0]!);
          const target = input.check.argv[0] === "gen-openapi" ? "api/openapi.json" : "client/generated.ts";
          writeFileSync(path.join(input.workspace, target), generated);
          return { passed: true, body: PASSED };
        }
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
      baseFile: async (_dir: string, _base: string, relative: string) => (over.derived !== undefined && relative === ".fulcrumaxe/derived-files.json" ? Buffer.from(JSON.stringify(over.derived.table)) : null),
    }),
  };
  return {
    order, starts, checkInputs, recordedBases, deps, handle: createJobHandler(deps), client,
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
      [{ kind: "refused", reason: "workspace_unsafe", check: "git_dir_info_entry" }, "lockfile update ended (refused: workspace_unsafe, check: git_dir_info_entry)"],
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

// #751: a generated file beside a listed route is lifted out of the scope test only by a fresh generator run, and the files vouched for travel on `done` with the passing check.
describe("a job with a check whose Spec lists a route (#751)", () => {
  const ROUTE = "api/src/routes/runs.ts";
  const TABLE = { version: 1, rules: [{ id: "routes", kind: "generated", inputs: ["api/src/routes/**"], outputs: ["api/openapi.json", "client/generated.ts"], generators: [["gen-openapi"], ["gen-client"]] }] };
  const scoped = () => jobFor({ sandbox_allowances: { entries: ENTRIES, command_timeout_s: 600 }, check: CHECK, scope: [ROUTE] });
  const changed = () => ({ files: [ROUTE, "api/openapi.json", "client/generated.ts"] as string[] | null | "throws", calls: [] as Array<{ workspace: string; base: string }> });
  const FILES = { "api/openapi.json": "doc\n", "client/generated.ts": "client\n" };

  it("equal to a fresh run: the check runs, nothing is reported out of scope, and done names the files that were checked", async () => {
    const ran: string[] = [];
    const steps: string[] = [];
    const r = rig({ changed: changed(), steps, derived: { table: TABLE, files: FILES, generated: { "gen-openapi": "doc\n", "gen-client": "client\n" }, ran } });
    await r.handle(await r.claim(scoped()));
    expect(ran).toEqual(["gen-openapi", "gen-client"]);
    expect(r.order).toContain("check");
    expect(bodies("/done")[0]!.check).toEqual({ ...PASSED, derived_fresh: ["api/openapi.json", "client/generated.ts"] });
    expect(steps.some((l) => l.includes("out_of_scope"))).toBe(false);
    expect(steps.some((l) => l.includes("generated files checked against a fresh run (2 equal)"))).toBe(true);
  });

  it("a hand-edited file: the check is not run and the run ends out_of_scope with a count, as before", async () => {
    const ran: string[] = [];
    const steps: string[] = [];
    const r = rig({ changed: changed(), steps, derived: { table: TABLE, files: FILES, generated: { "gen-openapi": "doc\n", "gen-client": "other client\n" }, ran } });
    await r.handle(await r.claim(scoped()));
    expect(r.order).not.toContain("check");
    expect(bodies("/done")[0]!.check).toMatchObject({ reason: "out_of_scope", summary: "the check was not run: 1 changed file is outside the Spec's file list" });
    expect(bodies("/done")[0]!.check).not.toHaveProperty("derived_fresh");
  });

  it("no table on the default branch: nothing is generated and both files count as outside", async () => {
    const ran: string[] = [];
    const steps: string[] = [];
    const r = rig({ changed: changed(), steps });
    await r.handle(await r.claim(scoped()));
    expect(steps.some((l) => l.endsWith("generated files not lifted (rules 0, candidates 0, reason no_rules)"))).toBe(true);
    expect(ran).toEqual([]);
    expect(bodies("/done")[0]!.check).toMatchObject({ reason: "out_of_scope", summary: "the check was not run: 2 changed files are outside the Spec's file list" });
  });

  it("a file missing from the workspace is not vouched for", async () => {
    const ran: string[] = [];
    const r = rig({ changed: changed(), derived: { table: TABLE, files: { "api/openapi.json": "doc\n" }, generated: { "gen-openapi": "doc\n", "gen-client": "client\n" }, ran } });
    await r.handle(await r.claim(scoped()));
    expect(ran).toEqual([]);
    expect(bodies("/done")[0]!.check).toMatchObject({ reason: "out_of_scope" });
  });

  it("a working tree that differs from HEAD vouches for nothing: the runner pushes HEAD, not loose bytes", async () => {
    const ran: string[] = [];
    const steps: string[] = [];
    const r = rig({ changed: changed(), steps, derived: { table: TABLE, files: FILES, generated: { "gen-openapi": "doc\n", "gen-client": "client\n" }, ran, dirty: ["client/generated.ts"] } });
    await r.handle(await r.claim(scoped()));
    expect(steps.some((l) => l.endsWith("generated files not lifted (rules 1, candidates 2, reason tree_dirty)"))).toBe(true);
    expect(ran).toEqual([]);
    expect(bodies("/done")[0]!.check).toMatchObject({ reason: "out_of_scope" });
  });

  it("a committed file that is not what the working tree holds, or an index that hides changes, vouches for nothing", async () => {
    const ran: string[] = [];
    const generated = { "gen-openapi": "doc\n", "gen-client": "client\n" };
    const forged = rig({ changed: changed(), derived: { table: TABLE, files: FILES, generated, ran, head: { "client/generated.ts": "HAND WRITTEN\n" } } });
    await forged.handle(await forged.claim(scoped()));
    const hidden = rig({ changed: changed(), derived: { table: TABLE, files: FILES, generated, ran, hidden: true } });
    await hidden.handle(await hidden.claim(scoped()));
    expect(ran).toEqual([]);
    expect(bodies("/done").map((b) => (b.check as DoneCheck).reason)).toEqual(["out_of_scope", "out_of_scope"]);
  });

  it("a copy of the table in the workspace, different from the default branch's, is ignored", async () => {
    const ran: string[] = [];
    const evil = { version: 1, rules: [{ id: "evil", kind: "generated", inputs: ["api/src/routes/**"], outputs: ["secrets/out.json"], generators: [["gen-evil"]] }] };
    const c = { files: [ROUTE, "secrets/out.json"] as string[] | null | "throws", calls: [] as Array<{ workspace: string; base: string }> };
    const r = rig({ changed: c, derived: { table: TABLE, files: { ".fulcrumaxe/derived-files.json": JSON.stringify(evil), "secrets/out.json": "x" }, generated: { "gen-evil": "x" }, ran } });
    await r.handle(await r.claim(scoped()));
    expect(ran).toEqual([]);
    expect(bodies("/done")[0]!.check).toMatchObject({ reason: "out_of_scope", summary: "the check was not run: 1 changed file is outside the Spec's file list" });
  });

  it("a check that fails after the files were checked vouches for nothing", async () => {
    const ran: string[] = [];
    const r = rig({ changed: changed(), outcome: { passed: false, body: { exit_code: 1, duration_ms: 5, timed_out: false, skipped_tests: null, summary: "FAIL" } }, derived: { table: TABLE, files: FILES, generated: { "gen-openapi": "doc\n", "gen-client": "client\n" }, ran } });
    await r.handle(await r.claim(scoped()));
    expect(bodies("/done")[0]!.check).not.toHaveProperty("derived_fresh");
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

describe("a job with a check and the Spec's file scope (D#6 SCOPE-IN-JOB)", () => {
  const SCOPE = ["src/**", "package.json", "docs/*.md"];
  const scoped = (scope: string[] | null = SCOPE) => jobFor({ sandbox_allowances: { entries: ENTRIES, command_timeout_s: 600 }, check: CHECK, ...(scope === null ? {} : { scope }) });
  const changed = (files: string[] | null | "throws") => ({ files, calls: [] as Array<{ workspace: string; base: string }> });

  it("every changed file inside the list: the check runs as before, after the file listing that was read against the check's merge-base pin", async () => {
    const c = changed(["src/a/b.ts", "package.json", "docs/x.md"]);
    const steps: string[] = [];
    const r = rig({ changed: c, steps });
    await r.handle(await r.claim(scoped()));
    expect(r.order).toEqual(["agent", "changed_files", "check", "sandbox_deleted", "publish", "hook"]);
    expect(c.calls).toEqual([{ workspace: expect.any(String), base: PIN }]);
    expect(bodies("/done")[0]!.check).toEqual(PASSED);
    expect(runEnded()).toEqual([]);
    expect(steps.some((l) => l.includes("out_of_scope"))).toBe(false);
  });

  it("a changed file outside the list: the check is not run, the branch is still pushed, and done reports the reason out_of_scope with a count and no path", async () => {
    const c = changed(["src/a.ts", "infra/prod/secret-plan.tf", "docs/deep/x.md"]);
    const steps: string[] = [];
    const r = rig({ changed: c, steps });
    const result = await r.handle(await r.claim(scoped()));
    expect(result.status).toBe("completed");
    expect(r.order).not.toContain("check");
    expect(r.order).toContain("publish");
    // A check that did not pass leaves the public-push hook alone, as for any failed check.
    expect(r.order).not.toContain("hook");
    expect(bodies("/done")).toHaveLength(1);
    expect(bodies("/done")[0]!.check).toEqual({ exit_code: null, duration_ms: 0, timed_out: false, skipped_tests: null, summary: "the check was not run: 2 changed files are outside the Spec's file list", reason: "out_of_scope" });
    expect(runEnded().map((e) => e.reason)).toEqual(["check_failed"]);
    expect(steps.some((l) => l.includes("check not run (out_of_scope, 2 files)"))).toBe(true);
    // Nothing from the changed paths is written anywhere the cloud or the journal sees.
    expect(JSON.stringify(cloud.seen)).not.toContain("secret-plan");
    expect(steps.join("\n")).not.toContain("secret-plan");
  });

  it("one file outside the list reads in the singular", async () => {
    const r = rig({ changed: changed(["README.md"]) });
    await r.handle(await r.claim(scoped()));
    expect((bodies("/done")[0]!.check as DoneCheck).summary).toBe("the check was not run: 1 changed file is outside the Spec's file list");
  });

  it("uses the shared matcher: the root lockfile follows a manifest in the list, and is outside when no manifest is", async () => {
    const withManifest = rig({ changed: changed(["package.json", "pnpm-lock.yaml"]) });
    await withManifest.handle(await withManifest.claim(scoped(["package.json"])));
    expect(withManifest.order).toContain("check");
    const without = rig({ changed: changed(["src/a.ts", "pnpm-lock.yaml"]) });
    await without.handle(await without.claim(scoped(["src/**"])));
    expect(without.order).not.toContain("check");
    expect(bodies("/done").at(-1)!.check).toMatchObject({ reason: "out_of_scope" });
  });

  it("a job with no scope lists nothing and runs the check", async () => {
    const c = changed(["anywhere/at/all.ts"]);
    const r = rig({ changed: c });
    await r.handle(await r.claim(scoped(null)));
    expect(c.calls).toEqual([]);
    expect(r.order).toContain("check");
  });

  it("a list the shared parser does not read as known is no scope: the check runs and nothing is listed", async () => {
    const c = changed(["anywhere/at/all.ts"]);
    const r = rig({ changed: c });
    await r.handle(await r.claim(scoped(["**"])));
    expect(c.calls).toEqual([]);
    expect(r.order).toContain("check");
  });

  it("a listing that is cut, absent or throws is no answer: the check runs", async () => {
    for (const files of [null, "throws"] as const) {
      const r = rig({ changed: changed(files) });
      await r.handle(await r.claim(scoped()));
      expect(r.order, String(files)).toContain("check");
    }
    const unwired = rig();
    expect(unwired.deps.changedFiles).toBeUndefined();
    await unwired.handle(await unwired.claim(scoped()));
    expect(unwired.order).toContain("check");
  });

  it("no changed file at all runs the check", async () => {
    const r = rig({ changed: changed([]) });
    await r.handle(await r.claim(scoped()));
    expect(r.order).toContain("check");
  });

  it("a merge-base that cannot be found stays base_missing, before any listing", async () => {
    const c = changed(["infra/x.tf"]);
    const r = rig({ changed: c, pin: null });
    await r.handle(await r.claim(scoped()));
    expect(c.calls).toEqual([]);
    expect(bodies("/done")[0]!.check).toMatchObject({ reason: "base_missing" });
  });

  it("an agent that cannot be stopped is not listed either: agent_not_stopped stays the reason", async () => {
    const c = changed(["infra/x.tf"]);
    const r = rig({ changed: c, lockfile: { outcome: { kind: "none" } as LockSyncOutcome, inputs: [], stopFails: true } });
    await r.handle(await r.claim(scoped()));
    expect(c.calls).toEqual([]);
    expect(bodies("/done")[0]!.check).toMatchObject({ reason: "agent_not_stopped" });
  });
});

/** A confined read-only role cannot change a manifest, so the runner does not try to bring a lockfile up to date for it; its result still reaches the cloud. */
const CONFINED = ["proposal-verifier", "discovery-analyst", "deploy-verifier"] as const;
it("the roles below are exactly the confined read-only roles", () => expect([...CONFINED].sort()).toEqual([...CONFINED_READ_ROLES].sort()));
for (const ROLE of CONFINED) {
  describe(`a ${ROLE} job with a lockfile update wired`, () => {
    const verifierJob = () => jobFor({ role: ROLE, task: jobFor().task, role_tools_sha256: roleToolsDigest(ROLE), review: { head_sha: HEAD } });

    it("never runs the lockfile update, and its done carries the agent's envelope", async () => {
      const steps: string[] = [];
      const lockfile = { outcome: { kind: "refused", reason: "workspace_unsafe" } as unknown as LockSyncOutcome, inputs: [] as Array<{ base: string; registryHost: string | undefined }> };
      const r = rig({ lockfile, steps });
      const result = await r.handle(await r.claim(verifierJob()));
      expect(result.status).toBe("completed");
      expect(lockfile.inputs).toEqual([]);
      expect(r.order).not.toContain("lockfile");
      expect(steps.some((s) => s.includes("lockfile"))).toBe(false);
      expect(bodies("/done")).toHaveLength(1);
      expect(bodies("/done")[0]!.agentOutput).toEqual({ verdict: "done" });
    });
  });
}

it("an executor job still gets its lockfile update (the guard above names the confined read-only roles only)", async () => {
  const lockfile = { outcome: { kind: "none" } as LockSyncOutcome, inputs: [] as Array<{ base: string; registryHost: string | undefined }> };
  const r = rig({ lockfile });
  await r.handle(await r.claim(withCheck()));
  expect(r.order).toContain("lockfile");
});

describe("a branch the runner brought up to date with the default branch", () => {
  const MERGED_IN = "d".repeat(40);
  const stageEvents = () => bodies("/events").flatMap((b) => (b.events as Array<Record<string, unknown>>).filter((e) => e.type === "stage").map((e) => e.stage));

  it("is checked against the commit that was merged in, not the older merge-base: the check pin and the scope listing both use it", async () => {
    const changed = { files: ["a.txt"] as string[] | null, calls: [] as Array<{ workspace: string; base: string }> };
    const r = rig({ updatedTo: MERGED_IN, changed });
    const job = { ...withCheck(), scope: ["a.txt"] } as ReturnType<typeof withCheck>;
    await r.handle(await r.claim(job));
    expect(r.checkInputs.map((c) => c.base)).toEqual([MERGED_IN]);
    expect(changed.calls.map((c) => c.base)).toEqual([MERGED_IN]);
  });

  it("is recorded as a run event (stage base_updated) before the agent starts, with the commit on the step line", async () => {
    const steps: string[] = [];
    const r = rig({ updatedTo: MERGED_IN, steps });
    await r.handle(await r.claim(withCheck()));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stageEvents()).toContain("base_updated");
    expect(steps.some((l) => l.includes("branch brought up to date with the default branch") && l.includes(MERGED_IN))).toBe(true);
  });

  it("a branch that needed no update is checked against the merge-base as before and records no such event", async () => {
    const r = rig();
    await r.handle(await r.claim(withCheck()));
    expect(r.checkInputs.map((c) => c.base)).toEqual([PIN]);
    expect(stageEvents()).not.toContain("base_updated");
  });

  const CONT = { parent_run_id: "22222222-2222-4222-8222-222222222222", session_id: null, branch: "fx/issue-12", pr_number: 7 };
  const SIGNED = "e".repeat(40);
  const recordedFor = async (updatedTo: string | undefined, continues: Record<string, unknown>): Promise<string[]> => {
    const r = rig(updatedTo === undefined ? {} : { updatedTo });
    await r.handle(await r.claim(jobFor({ sandbox_allowances: { entries: ENTRIES, command_timeout_s: 600 }, check: CHECK, continues } as never)));
    return r.recordedBases;
  };

  it("the public diff of a round that republishes (signed base) starts from the commit that was merged in", async () => {
    expect(await recordedFor(MERGED_IN, { ...CONT, base_sha: SIGNED })).toEqual([MERGED_IN]);
    expect(await recordedFor(undefined, { ...CONT, base_sha: SIGNED })).toEqual([SIGNED]);
  });

  it("the public diff of a first publish (merge-base) starts from the commit that was merged in", async () => {
    expect(await recordedFor(MERGED_IN, CONT)).toEqual([MERGED_IN]);
  });

  it("a conflict ends the run before the agent starts: no agent, no check, run_ended runner_setup / base_conflict", async () => {
    const r = rig({ prepareThrows: new GitPathError("base_conflict") });
    const result = await r.handle(await r.claim(withCheck()));
    expect(result.status).toBe("failed");
    expect(r.order).not.toContain("agent");
    expect(r.order).not.toContain("check");
    expect(runEnded()).toEqual([expect.objectContaining({ reason: "runner_setup", detail: "base_conflict" })]);
  });
});
