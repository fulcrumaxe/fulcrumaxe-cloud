import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index.js";
import * as entry from "../src/index.js";
import { forgetWorkerForTests } from "../src/compositionRoot.js";
import { resetPlanDataCache } from "@fx/plan-data";
import { listSourceFiles } from "../../test-guard/src/sourceFiles.js";

const SKIPPED_DIRS = new Set(["node_modules", ".next", "dist", "test", "tests"]);

const poolA = { tag: "runner-pool", query: async () => ({ rows: [] }), connect: async () => ({}) } as unknown as Pool;
const poolB = { tag: "ops-pool", query: async () => ({ rows: [] }), connect: async () => ({}) } as unknown as Pool;
const poolC = { tag: "receipt-pool", query: async () => ({ rows: [] }), connect: async () => ({}) } as unknown as Pool;

const mocks = vi.hoisted(() => ({ createWorkerPools: vi.fn() }));
vi.mock("../src/pools.js", async (original) => ({
  ...(await original<typeof import("../src/pools.js")>()),
  createWorkerPools: mocks.createWorkerPools,
}));

beforeEach(() => {
  forgetWorkerForTests();
  mocks.createWorkerPools.mockReset();
  mocks.createWorkerPools.mockImplementation(async () => ({ runnerPool: poolA, platformOpsPool: poolB, receiptPool: poolC, close: async () => {} }));
});

const OPTIONS = {
  env: { FX_GH_FORWARD_SUFFIX: "fixture.test", FX_GH_FORWARD_HOST: "gh-proxy.fixture.test" },
  vercel: { teamId: "t", projectId: "p", getToken: async () => "tok" },
  ports: {
    decryptTenantKey: async () => "k",
    modelConnection: { get: async () => { throw new Error("unused"); } },
    connectionStatus: { markBroken: async () => {}, markCreditsExhausted: async () => {} },
    hooks: { resume: async () => {} },
  },
};

/** Every object reachable from `root` through own enumerable properties and prototypes' own methods. */
function reachable(root: unknown): unknown[] {
  const seen = new Set<unknown>();
  const stack = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if ((typeof value !== "object" && typeof value !== "function") || value === null || seen.has(value)) continue;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (d && "value" in d) stack.push(d.value);
    }
    const proto = Object.getPrototypeOf(value);
    if (proto && proto !== Object.prototype && proto !== Function.prototype) stack.push(proto);
  }
  return [...seen];
}

describe("C70 / CARRY-8: what createWorker hands a web route", () => {
  it("is the registry, the run-action facade and close(), and no pool, client, login, port or target deps", async () => {
    const worker = await createWorker(OPTIONS);
    expect(Object.keys(worker).sort()).toEqual([
      "advanceBuild",
      "advanceBuildFailed",
      "advanceCancel",
      "advanceCancelStepRuns",
      "advanceDecision",
      "advanceLightSpec",
      "advanceLoadItem",
      "advanceLoadReview",
      "advanceLoadSpecText",
      "advanceMergeGate",
      "advanceMergeOrder",
      "advancePanel",
      "advancePrFound",
      "advanceRecordEvent",
      "advanceRecordMergeOnly",
      "advanceRecordRound",
      "advanceRespec",
      "advanceReviewRuns",
      "advanceRunOutcome",
      "advanceSpec",
      "advanceStartCheckFix",
      "advanceStartFix",
      "advanceStartRun",
      "advanceTriage",
      "advanceVerifiedReviewGate",
      "answerDecisionAsk",
      "approveSubItem",
      "beginRunnerDone",
      "cancelRun",
      "claimRunAction",
      "claimRunnerRun",
      "close",
      "completeHandoffOnDone",
      "completeRunHandoff",
      "failRunnerLeases",
      "finishRunnerDone",
      "gitTicketContext",
      "heartbeatRunnerRun",
      "ingestRunnerEvents",
      "listDueRunActions",
      "openPublicPullRequest",
      "performAdvanceWorkItem",
      "performAmendSpec",
      "performCancelRun",
      "performCancelWorkItem",
      "performRespecWorkItem",
      "performResumeDecision",
      "performRetryRun",
      "performStartPreview",
      "planeMerge",
      "planePushGrant",
      "planePushPairing",
      "planePushRecordReport",
      "planePushReportContext",
      "planePushSettleGrant",
      "previewReady",
      "publishPairedChange",
      "purgeRunActions",
      "reconcilePrHolder",
      "registry",
      "resolveRunSeat",
      "retryPublish",
      "sandboxInventory",
      "settlePairedBuild",
      "settleRunAction",
      "signGitTicket",
      "sweepBranchCleanups",
      "sweepComputeSettle",
      "sweepInvariants",
      "sweepParkedStages",
      "sweepPrSlotHolders",
      "sweepProposalVerification",
      "sweepRunHandoffs",
      "sweepRunnerLeases",
      "sweepRunnerNotices",
      "sweepRunnerQueue",
      "sweepSandboxReap",
      "sweepSetupRequestChecks",
      "withRunnerPool",
    ]);
    // With no follower and no prompt builder given, a request is refused up front.
    expect(worker.previewReady()).toBe(false);
    // With no verifier pieces given, the verifier sweep starts nothing and says so (D#483 S4-b2b).
    expect(await worker.sweepProposalVerification()).toMatchObject({ idle: "not_configured", listed: 0, started: 0 });
    const everything = reachable(worker);
    expect(everything).not.toContain(poolA);
    expect(everything).not.toContain(poolB);
    expect(everything).not.toContain(poolC);
    const keys = everything.flatMap((v) => (typeof v === "object" && v !== null ? Object.keys(v) : []));
    for (const forbidden of ["pool", "pools", "runnerPool", "platformOpsPool", "receiptPool", "targetDeps", "sandboxPort", "deps", "client", "connect", "query", "end", "connectionString", "options"]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
    await worker.close();
  });

  it("H14c-3-3a: with a follower and a prompt builder wired the Worker has the same methods, a preview is ready, and the starter is not reachable", async () => {
    const plain = Object.keys(await createWorker(OPTIONS)).sort();
    forgetWorkerForTests();
    const follow = async (): Promise<void> => undefined;
    const worker = await createWorker({ ...OPTIONS, ports: { ...OPTIONS.ports, follow }, previewPrompt: (r) => `${r.owner}/${r.name}` });
    expect(Object.keys(worker).sort()).toEqual(plain);
    expect(worker.previewReady()).toBe(true);
    const everything = reachable(worker);
    expect(everything).not.toContain(poolA);
    expect(everything).not.toContain(poolB);
    expect(everything).not.toContain(poolC);
    expect(everything).not.toContain(follow);
    const keys = everything.flatMap((v) => (typeof v === "object" && v !== null ? Object.keys(v) : []));
    for (const forbidden of ["start", "starter", "follow", "inCreateTransaction", "hookToken", "token"]) expect(keys, forbidden).not.toContain(forbidden);
    await worker.close();
  });

  it("D#483 S4-b2b: verifier pieces without a follower (so no run starter) still answer not_configured and start nothing; with the follower the sweep is wired and reads its settings", async () => {
    const verify = { github: () => { throw new Error("unused"); }, prompt: () => "p", record: async () => { throw new Error("unused"); } };
    const saved = process.env.FX_PLAN_DATA;
    delete process.env.FX_PLAN_DATA;
    resetPlanDataCache();
    try {
      const noStarter = await createWorker({ ...OPTIONS, verify });
      expect(await noStarter.sweepProposalVerification()).toMatchObject({ idle: "not_configured", listed: 0, started: 0 });
      await noStarter.close();
      forgetWorkerForTests();
      // The same pieces with a follower: the real sweep runs, and without plan data it is idle for that reason, not "not_configured".
      const wired = await createWorker({ ...OPTIONS, verify, ports: { ...OPTIONS.ports, follow: async (): Promise<void> => undefined } });
      expect(await wired.sweepProposalVerification()).toMatchObject({ idle: "discovery_unconfigured", listed: 0, started: 0 });
      await wired.close();
    } finally {
      if (saved !== undefined) process.env.FX_PLAN_DATA = saved;
      resetPlanDataCache();
    }
  });

  it("no system or internal cancel is reachable, and a forged system principal is refused", async () => {
    const worker = await createWorker(OPTIONS);
    const keys = reachable(worker).flatMap((v) => (typeof v === "object" && v !== null ? Reflect.ownKeys(v).map(String) : []));
    for (const k of keys) expect(k, k).not.toMatch(/system|internal/i);
    expect(Object.keys(entry).join()).not.toMatch(/system|internal/i);
    await expect(worker.cancelRun({ accountId: "a", userId: "u", kind: "system" } as never, "r")).rejects.toMatchObject({
      name: "RunActionForbiddenError",
    });
    await worker.close();
  });

  it("the package entry exports no way to get at the pools or the internal builder", () => {
    expect(Object.keys(entry).sort()).toEqual(["CONTINUE_PROMPT", "PUBLIC_UNAVAILABLE_NOTE", "RunActionForbiddenError", "RunActionInputError", "RunActionRefusedError", "RunActionUnavailableError", "SEAT_CONTINUE_PROMPT", "StartupGuardError", "VercelCredentialsUnavailableError", "assertWorkdirAllowed", "continuationStartInput", "createGithubRepoVisibility", "createHandoffCloudTarget", "createPublishSettler", "createVercelKeepAlive", "createWorker", "followStatusBody", "followTimeoutBody", "mayRetryPublish", "operatorMode", "productionVercelCredentials", "runnerJobsConfigured", "runnerLimitsFor"]);
  });

  it("is safe to call from many routes: one build, one set of pools, one run of the guards", async () => {
    const [a, b, c] = await Promise.all([createWorker(OPTIONS), createWorker(OPTIONS), createWorker(OPTIONS)]);
    const later = await createWorker(OPTIONS);
    expect(mocks.createWorkerPools).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(later).toBe(a);
  });

  it("a failed build is not kept: the next call builds again; close() forgets the instance too", async () => {
    mocks.createWorkerPools.mockRejectedValueOnce(new Error("db down"));
    await expect(createWorker(OPTIONS)).rejects.toThrow("db down");
    const worker = await createWorker(OPTIONS);
    expect(mocks.createWorkerPools).toHaveBeenCalledTimes(2);
    await worker.close();
    await createWorker(OPTIONS);
    expect(mocks.createWorkerPools).toHaveBeenCalledTimes(3);
  });

  it("a stale close() after a rebuild neither clears the newer worker nor leaves pools open, and closes once", async () => {
    const closes: string[] = [];
    let n = 0;
    mocks.createWorkerPools.mockImplementation(async () => {
      const id = `w${++n}`;
      return { runnerPool: poolA, platformOpsPool: poolB, receiptPool: poolC, close: async () => void closes.push(id) };
    });
    const first = await createWorker(OPTIONS);
    await first.close();
    const second = await createWorker(OPTIONS);
    expect(second).not.toBe(first);
    await first.close();
    await first.close();
    expect(closes).toEqual(["w1"]);
    expect(await createWorker(OPTIONS)).toBe(second);
    expect(mocks.createWorkerPools).toHaveBeenCalledTimes(2);
    await second.close();
    expect(closes).toEqual(["w1", "w2"]);
  });

  it("a rejected close() is not remembered: the next close() tries again, and a success is then final", async () => {
    let attempts = 0;
    mocks.createWorkerPools.mockImplementation(async () => ({
      runnerPool: poolA,
      platformOpsPool: poolB,
      close: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("end failed");
      },
    }));
    const worker = await createWorker(OPTIONS);
    await expect(worker.close()).rejects.toThrow("end failed");
    expect(attempts).toBe(1);
    await expect(worker.close()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    await worker.close();
    expect(attempts).toBe(2);
  });
});

describe("H14c-3-3a-3: who may call followTimeoutBody (it writes timed_out and stops a sandbox)", () => {
  it("exactly three non-test sources mention it: the runner's definition and workflow, this package's re-export, and the follower workflow", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const root = path.join(__dirname, "..", "..", "..");
    // Git's file list, not a directory walk: a web build leaves an ignored workflow bundle under apps/web/app that inlines this name.
    const hits = listSourceFiles(root, ["apps", "packages"], SKIPPED_DIRS).filter(
      (f) => /\.(ts|tsx|mjs|js)$/.test(f) && !/\.test\./.test(path.basename(f)) && readFileSync(path.join(root, f), "utf8").includes("followTimeoutBody"),
    );
    expect(hits.sort()).toEqual(["apps/web/workflows/agentRunFollow.ts", "packages/runner/src/workflows/agentRun.ts", "packages/worker/src/index.ts"]);
  });
});
