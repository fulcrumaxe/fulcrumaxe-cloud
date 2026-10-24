import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient, type Claimed } from "../../src/daemon/client.js";
import { createJobHandler, type JobHandlerDeps } from "../../src/daemon/jobHandler.js";
import { createEventRelay, type Clock } from "../../src/daemon/lease.js";
import { createFileLedger } from "../../src/daemon/ledger.js";
import { createPlaneBaseLedger, type PlanePushOutcome, type PlanePushRunEnd } from "../../src/daemon/planePush.js";
import { recordSession } from "../../src/engines/claude/session.js";
import { generateRunnerKey } from "../../src/keys.js";
import { runJob, type RunJobDeps } from "../../src/job/runJob.js";
import { createWorkspaceStore } from "../../src/job/workspace.js";
import type { SandboxPort } from "../../src/sandbox/port.js";
import { fakeGitPath } from "../helpers/fakeGitPath.js";
import { ledgerOptions } from "../helpers/ledgerOptions.js";
import { roleToolsDigest } from "../../src/job/roleTools.js";
import { jobFor, KEYRING, signRaw } from "../helpers/signedJob.js";
import { startStrictRunnerCloud, stopBody, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";

/**
 * D#598 P1f-3 in the job handler: which runs enter the public-push hook, where in the run it is called, what it is given, and that it can neither
 * fail a run nor outlive one. The hook itself is tested on real git in planePush.test.ts; here it is a recording stand-in.
 */
const BASE = "a".repeat(40);
const MOVED = "d".repeat(40);
const HEAD = "b".repeat(40);
const BRANCH = "fx/33333333-3333-4333-8333-333333333333-g1";

let cloud: StrictRunnerCloud;
let root: string;
let rigs = 0;
beforeEach(async () => {
  cloud = await startStrictRunnerCloud();
  root = mkdtempSync(path.join(tmpdir(), "fxr-planehandler-"));
});
afterEach(async () => {
  await cloud.close();
  rmSync(root, { recursive: true, force: true });
});

const clock: Clock = { now: () => new Date(), sleep: (ms, signal) => new Promise<void>((resolve) => { if (signal.aborted) return resolve(); const t = setTimeout(resolve, Math.min(ms, 1)); signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); }) };

interface RigOptions {
  /** What the agent run ends with. Default: a result. */
  end?: (runId: string) => NormalizedEvent | undefined;
  published?: { pushed: false } | { pushed: true; branch: string; sha: string };
  mirror?: boolean;
  outcome?: PlanePushOutcome | "throw";
  /** Called when the agent starts, with the run's id: a test moves "the checkout" here. */
  onStart?: (runId: string) => void;
  withHook?: boolean;
  shutdown?: AbortSignal;
}

function rig(over: RigOptions = {}) {
  const key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  const client = createRunnerClient({ origin: cloud.origin, key, now: () => new Date(), fetchFn: fetch });
  const order: string[] = [];
  const baseLedger = createPlaneBaseLedger();
  const asked: PlanePushRunEnd[] = [];
  const seenBase: Array<string | undefined> = [];
  const port: SandboxPort = {
    async createSandbox(opts) { return { runId: "", sandboxName: opts.sandboxName }; },
    startDetached: (handle, opts) => {
      order.push("agent");
      over.onStart?.(opts.runId);
      seenBase.push(baseLedger.read(opts.runId));
      const event = over.end ? over.end(opts.runId) : ({ runId: opts.runId, role: opts.role, seq: 1, type: "result", ts: "2026-10-08T12:00:00.000Z", sessionId: "s1", agentOutput: { verdict: "done" } } as NormalizedEvent);
      return { handle, hookFired: Promise.resolve(event) };
    },
    resume: () => { throw new Error("not used"); },
    async extendTimeout() {}, async stop() {}, async deleteSandbox() {}, async measure() { return []; }, async readCounters() { return undefined; }, async writeFiles() {}, async runCommand(): Promise<never> { throw new Error("not used"); }, async sandboxExists() { return true; },
  };
  const run: Omit<RunJobDeps, "sandbox" | "ledger"> = { workspaces: createWorkspaceStore(path.join(root, "work")), credentials: { mode: "subscription" }, planSession: () => ({ kind: "fresh", branch: null }), defaultModel: "sonnet" };
  // The agent's checkout, as the fake path sees it: it starts at BASE and a test may move it. The handler must not ask it.
  const checkout = { head: BASE };
  const git = fakeGitPath({
    prepare: async () => ({ base: checkout.head }),
    publish: async () => {
      order.push("publish");
      return over.published ?? { pushed: true, branch: BRANCH, sha: HEAD };
    },
  });
  if (over.mirror !== false) git.mirrorDir = (job) => `/mirrors/${job.repo.id}.git`;
  const deps: JobHandlerDeps = {
    client, keyring: KEYRING, clock, run, sandbox: port, ledger: createFileLedger(path.join(root, `jobs-${++rigs}.json`), ledgerOptions()), git, events: createEventRelay(),
    recordSession: (id, workspace) => recordSession(path.join(root, "sessions.json"), id, workspace), heartbeatMs: 1e9, flushMs: 1e9, runJobFn: runJob,
    ...(over.shutdown === undefined ? {} : { shutdown: over.shutdown }),
    ...(over.withHook === false ? {} : {
      planePush: {
        baseLedger,
        run: async (input) => {
          order.push("hook");
          asked.push(input);
          // The hook reads the daemon's record of the start commit, not anything on disk.
          seenBase.push(baseLedger.read(input.runId));
          if (over.outcome === "throw") throw new Error("boom with a path /secret/place");
          return over.outcome ?? { kind: "pr_opened", number: 9, seconds: 1 };
        },
      },
    }),
  };
  return {
    order, asked, seenBase, checkout, baseLedger, handle: createJobHandler(deps),
    async claim(job: ReturnType<typeof jobFor>): Promise<Claimed> {
      cloud.enqueue(signRaw(job) as never);
      const claimed = await client.claim();
      if (claimed.kind !== "claimed") throw new Error("expected a claim");
      return claimed;
    },
  };
}

const donePaths = (): number => cloud.seen.filter((s) => s.path.endsWith("/done")).length;

describe("which runs enter the hook", () => {
  it("a fresh executor run does, once, after the private push and before done, with the commit it pushed and the mirror it pushed from", async () => {
    const r = rig();
    const job = jobFor();
    const claimed = await r.claim(job);
    const result = await r.handle(claimed);
    expect(result.status).toBe("completed");
    expect(r.order).toEqual(["agent", "publish", "hook"]);
    expect(r.asked).toEqual([{ runId: claimed.runId, leaseGeneration: claimed.leaseGeneration, repo: { owner: "acme", name: "widgets" }, mirrorDir: `/mirrors/${job.repo.id}.git`, privateHead: HEAD, signal: expect.any(AbortSignal) }]);
    // `done` went out after the hook (the hook ran inside the lease).
    expect(donePaths()).toBe(1);
  });

  it("a run that pushed nothing still asks the hook, with no head: it reports no_change itself", async () => {
    const r = rig({ published: { pushed: false } });
    await r.handle(await r.claim(jobFor()));
    expect(r.asked.map((a) => a.privateHead)).toEqual([undefined]);
  });

  it("no other run does: not a fix round, a reviewer, a docs writer or a review of a commit", async () => {
    const fixRound = { continues: { parent_run_id: "22222222-2222-4222-8222-222222222222", session_id: "s1", branch: "fx/22222222-2222-4222-8222-222222222222-g1" } };
    const reviewer = { role: "code-reviewer" as const, role_tools_sha256: roleToolsDigest("code-reviewer"), review: { head_sha: HEAD } };
    const docs = { role: "docs-writer" as const, role_tools_sha256: roleToolsDigest("docs-writer") };
    for (const over of [fixRound, reviewer, docs]) {
      const r = rig();
      await r.handle(await r.claim(jobFor(over)));
      expect(r.asked, JSON.stringify(over)).toEqual([]);
      expect(r.seenBase, JSON.stringify(over)).toEqual([undefined]);
    }
  });

  it("a git path with no mirror, and a handler built without the hook, enter nothing", async () => {
    const noMirror = rig({ mirror: false });
    await noMirror.handle(await noMirror.claim(jobFor()));
    expect(noMirror.asked).toEqual([]);
    const noHook = rig({ withHook: false });
    expect((await noHook.handle(await noHook.claim(jobFor()))).status).toBe("completed");
    expect(noHook.order).toEqual(["agent", "publish"]);
  });

  it("a run that failed never reaches the hook: no token is asked for", async () => {
    const failed = rig({ end: () => undefined });
    expect((await failed.handle(await failed.claim(jobFor()))).status).toBe("failed");
    expect(failed.asked).toEqual([]);
    expect(failed.order).not.toContain("hook");
  });

  it("a daemon that is shutting down when the agent ends goes no further than its shutdown report", async () => {
    const stop = new AbortController();
    const r = rig({ onStart: () => stop.abort(), shutdown: stop.signal });
    expect((await r.handle(await r.claim(jobFor()))).status).toBe("aborted");
    expect(r.asked).toEqual([]);
  });
});

describe("the start commit is the daemon's record (P1f-3-d)", () => {
  it("is recorded before the agent starts and is what the hook reads, though the checkout moved during the run", async () => {
    const r = rig({ onStart: () => { r.checkout.head = MOVED; } });
    await r.handle(await r.claim(jobFor()));
    // The agent started with the record already there; the hook, after the checkout moved, reads the same value.
    expect(r.seenBase).toEqual([BASE, BASE]);
    expect(r.checkout.head).toBe(MOVED);
  });

  it("a fix round on the item's branch records the base the cloud signed, not the commit its checkout starts at, before the agent starts (FIXROUND-BASE-SYNC R2-b)", async () => {
    const CHOSEN = "c".repeat(40);
    const item = { continues: { parent_run_id: "22222222-2222-4222-8222-222222222222", session_id: null, branch: "fx/issue-12", pr_number: 7, base_sha: CHOSEN } };
    const r = rig({ onStart: () => { r.checkout.head = MOVED; } });
    const claimed = await r.claim(jobFor(item));
    await r.handle(claimed);
    // The checkout began at BASE; the daemon's record is the signed value. The round does not enter the public-push hook yet (that is a later step), so the hook is not asked.
    expect(r.seenBase).toEqual([CHOSEN]);
    expect(r.asked).toEqual([]);
    expect(r.baseLedger.read(claimed.runId)).toBeUndefined();
  });

  it("a fix round on a run branch records the signed base the same way, with a session or without one (FIXROUND-REPUBLISH R2-c0)", async () => {
    const CHOSEN = "c".repeat(40);
    for (const session_id of ["sess-1", null]) {
      const run = { continues: { parent_run_id: "22222222-2222-4222-8222-222222222222", session_id, branch: "fx/33333333-3333-4333-8333-333333333333-g1", base_sha: CHOSEN } };
      const r = rig({ onStart: () => { r.checkout.head = MOVED; } });
      const claimed = await r.claim(jobFor(run));
      await r.handle(claimed);
      expect(r.seenBase).toEqual([CHOSEN]);
      expect(r.baseLedger.read(claimed.runId)).toBeUndefined();
    }
  });

  it("a fix round with no signed base records nothing", async () => {
    const plain = { continues: { parent_run_id: "22222222-2222-4222-8222-222222222222", session_id: null, branch: "fx/issue-12", pr_number: 7 } };
    const r = rig();
    await r.handle(await r.claim(jobFor(plain)));
    expect(r.seenBase).toEqual([undefined]);
  });

  it("is forgotten when the run ends, whichever way", async () => {
    const r = rig();
    const claimed = await r.claim(jobFor());
    await r.handle(claimed);
    expect(r.baseLedger.read(claimed.runId)).toBeUndefined();
    const failed = rig({ end: () => undefined });
    const claimedFailed = await failed.claim(jobFor());
    await failed.handle(claimedFailed);
    expect(failed.baseLedger.read(claimedFailed.runId)).toBeUndefined();
  });
});

describe("the hook can neither fail a run nor outlive one", () => {
  it("a hook that throws is the closed outcome failed: the run still reports done, and nothing of the error reaches the cloud", async () => {
    const r = rig({ outcome: "throw" });
    const result = await r.handle(await r.claim(jobFor()));
    expect(result.status).toBe("completed");
    expect(JSON.stringify(cloud.seen)).not.toContain("/secret/place");
    expect(donePaths()).toBe(1);
  });

  it("a hook that learns the cloud ended the run stops it: done is not sent", async () => {
    const r = rig({ outcome: { kind: "stopped", reason: "stale_generation" } });
    const result = await r.handle(await r.claim(jobFor()));
    expect(result).toEqual({ status: "stopped", reason: "stale_generation" });
    expect(donePaths()).toBe(0);
  });

  it("every other outcome goes on to done", async () => {
    for (const outcome of [{ kind: "not_entered", why: "unpaired" }, { kind: "no_change" }, { kind: "refused", code: "scan_refused", seconds: 1 }, { kind: "pr_not_opened", seconds: 1 }, { kind: "failed" }] as PlanePushOutcome[]) {
      const r = rig({ outcome });
      expect((await r.handle(await r.claim(jobFor()))).status, JSON.stringify(outcome)).toBe("completed");
    }
  });
});
