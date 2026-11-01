import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESERVATION_PAUSE_REASONS, mergeQueue } from "@fx/pipeline";

/**
 * D#519 MQ4-b: the web binding of the conflict round. The review load and the pull request lookup are the real ones' contract as the binding uses them
 * (fakes below); the prompt is the REAL `assembleConflictPrompt`, and the worker's start is a spy that records the request it is given.
 */
const h = vi.hoisted(() => ({
  facts: { halt_epoch: 4, u: "user-1", id: "6f1d6c34-7f0d-4a53-8d4c-0a5e8a6b9c11" } as { halt_epoch?: number; u?: string; id?: string },
  ctx: { ok: true, tier: "feature", debaterEnabled: false, repoId: "r", owner: "acme", name: "widgets", issue: 7, branch: "fx/issue-7", specVersion: 3, executionMode: "sandbox" } as Record<string, unknown>,
  pr: { ok: true, number: 41, headSha: "f".repeat(40), baseRef: "main", branch: "fx/issue-7", securityCodes: [] as string[] } as Record<string, unknown>,
}));

vi.mock("@fx/core/src/tenancy/withTenant.js", () => ({
  withTenant: async (_pool: unknown, _account: string, fn: (c: unknown) => unknown) =>
    fn({ query: async (sql: string) => ({ rows: sql.includes("halt_epoch") ? [{ halt_epoch: h.facts.halt_epoch }] : h.facts.u === undefined ? [] : [{ u: h.facts.u, id: h.facts.id }] }) }),
}));
vi.mock("./advanceReviewSteps", () => ({
  reviewLoadBody: async () => h.ctx,
  findPrBody: async () => h.pr,
  startReviewerBody: async () => ({ runId: null, reason: null }),
  reviewerOutcomeBody: async () => ({}),
}));

import { conflictPorts } from "./mergeQueueConflict";

const SHA = (c: string) => c.repeat(40);
const entry = { id: "e1", accountId: "acct", workItemId: "item", headSha: SHA("a"), prNumber: 41 } as mergeQueue.MergeQueueEntry;
const round = { id: "r1", round: 2, fromSha: SHA("a"), baseSha: SHA("b"), baseRef: "main", conflictFiles: ["src/a.ts", "docs/x.md"] } as unknown as mergeQueue.ConflictRound;

function build(start: (who: unknown, req: Record<string, unknown>) => unknown = async () => ({ ok: true, runId: "run-9" }), over: Record<string, unknown> = {}) {
  const advanceStartFix = vi.fn(start);
  const ports = conflictPorts({ pool: {} as never, worker: { advanceStartFix } as never, open: (async () => ({})) as never, github: {} as never, ...over });
  return { advanceStartFix, ports };
}

beforeEach(() => {
  h.facts = { halt_epoch: 4, u: "user-1", id: "6f1d6c34-7f0d-4a53-8d4c-0a5e8a6b9c11" };
  h.ctx = { ok: true, tier: "feature", debaterEnabled: false, repoId: "r", owner: "acme", name: "widgets", issue: 7, branch: "fx/issue-7", specVersion: 3, executionMode: "sandbox" };
  h.pr = { ok: true, number: 41, headSha: "f".repeat(40), baseRef: "main", branch: "fx/issue-7", securityCodes: [] };
});

describe("startConflictRound", () => {
  it("starts the worker's conflict fix round, as the approver, with the round's facts and no reviewer, failing run or person", async () => {
    const { ports, advanceStartFix } = build();
    expect(await ports.startConflictRound({ entry, round })).toEqual({ ok: true, runId: "run-9" });
    const [who, req] = advanceStartFix.mock.calls[0]!;
    expect(who).toEqual({ accountId: "acct", userId: "user-1", workItemId: "item", haltEpoch: 4 });
    expect(req).toMatchObject({ kind: "conflict", issue: 7, headSha: SHA("a"), round: 2, actionId: h.facts.id, expectedExecutionMode: "sandbox", pr: { number: 41, branch: "fx/issue-7" } });
    expect(req).not.toHaveProperty("reviewer");
    expect(req).not.toHaveProperty("failingRunId");
    expect(req).not.toHaveProperty("person");
    expect(req["prompt"]).toContain("git merge origin/main");
    expect(req["prompt"]).toContain("- src/a.ts");
    expect(req["prompt"]).toContain("round 2 of 2");
  });

  it.each(["refused_spend", ...RESERVATION_PAUSE_REASONS, "model_budget_exceeded"])("a spend refusal (%s) is refused_spend", async (reason) => {
    const { ports } = build(async () => ({ ok: false, reason }));
    expect(await ports.startConflictRound({ entry, round })).toEqual({ ok: false, reason: "refused_spend" });
  });

  it("a wait for capacity keeps its own code, and any other refusal keeps its code", async () => {
    expect(await build(async () => ({ ok: false, reason: "waiting_for_capacity" })).ports.startConflictRound({ entry, round })).toEqual({ ok: false, reason: "waiting_for_capacity" });
    expect(await build(async () => ({ ok: false, reason: "no_session" })).ports.startConflictRound({ entry, round })).toEqual({ ok: false, reason: "no_session" });
  });

  it("an item with no approver on record, or a worker that is not there, is a fixed reason and starts nothing", async () => {
    h.facts.u = undefined;
    const a = build();
    expect(await a.ports.startConflictRound({ entry, round })).toEqual({ ok: false, reason: "invalid_input" });
    expect(a.advanceStartFix).not.toHaveBeenCalled();
    h.facts.u = "user-1";
    const none = conflictPorts({ pool: {} as never, worker: null, open: (async () => ({})) as never, github: {} as never });
    expect(await none.startConflictRound({ entry, round })).toEqual({ ok: false, reason: "worker_unavailable" });
  });

  it("a path the prompt refuses is a closed refusal, not a throw, and starts nothing", async () => {
    const { ports, advanceStartFix } = build();
    expect(await ports.startConflictRound({ entry, round: { ...round, conflictFiles: ["../escape"] } })).toEqual({ ok: false, reason: "invalid_input" });
    expect(advanceStartFix).not.toHaveBeenCalled();
  });
});

describe("the platform commit proof (C10: push records or a verified app commit, never author fields)", () => {
  afterEach(() => mergeQueue.setPlatformCommitProofForTest(null));
  it("absent: reads as unread, so no conflict round can start", async () => {
    expect(await build().ports.platformCommits(entry, [])).toBeNull();
    expect(await build().ports.platformCommits(entry, [SHA("c")])).toBeNull();
  });
  it("present: the one module-level source, passed the entry and shas, its answer unchanged, and read at call time by every binding", async () => {
    const early = build().ports;
    const proof = { appLogin: "fulcrumaxe-app[bot]", pushes: [{ oldSha: null, newSha: SHA("c"), startSha: null, runId: "run-1" }] };
    const asked: unknown[] = [];
    mergeQueue.setPlatformCommitProofForTest(async (e, shas) => (asked.push([e.id, shas]), proof));
    expect(await build().ports.platformCommits(entry, [SHA("c")])).toEqual(proof);
    expect(await early.platformCommits(entry, [])).toEqual(proof);
    expect(asked).toEqual([["e1", [SHA("c")]], ["e1", []]]);
  });
  it("production code never sets the source: no file outside the tests names the test-only setter", () => {
    // Every source file under apps/ (routes, workflows, libs) and packages/, tests excluded.
    const roots = [new URL("../../", import.meta.url).pathname, new URL("../../../packages/", import.meta.url).pathname];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".next" || e.name === "dist" || e.name === "test") continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.(ts|tsx)$/.test(e.name) && readFileSync(p, "utf8").includes("setPlatformCommitProofForTest")) hits.push(p);
      }
    };
    roots.forEach(walk);
    expect(hits.map((p) => p.split("/").slice(-1)[0])).toEqual(["conflict.ts"]);
  });
});
