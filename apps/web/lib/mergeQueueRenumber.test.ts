import { beforeEach, describe, expect, it, vi } from "vitest";
import { RESERVATION_PAUSE_REASONS, mergeQueue } from "@fx/pipeline";

/**
 * D#519 MQ5-b1: the web binding of the renumber round's start. The review load and the pull request lookup are the real ones' contract as the binding uses them
 * (fakes below); the prompt is the REAL `assembleRenumberPrompt`, and the worker's start is a spy that records the request it is given.
 */
const h = vi.hoisted(() => ({
  facts: { halt_epoch: 4, u: "user-1", id: "6f1d6c34-7f0d-4a53-8d4c-0a5e8a6b9c11" } as { halt_epoch?: number; u?: string; id?: string },
  ctx: { ok: true, tier: "feature", debaterEnabled: false, repoId: "r", owner: "acme", name: "widgets", issue: 7, branch: "fx/issue-7", specVersion: 3, executionMode: "sandbox" } as Record<string, unknown>,
  /** The driver events the binding wrote (the real writer is replaced by this recorder: its SQL is the core's, covered there). */
  events: [] as Array<{ accountId: string; input: Record<string, unknown> }>,
  pr: { ok: true, number: 41, headSha: "f".repeat(40), baseRef: "main", branch: "fx/issue-7", securityCodes: [] as string[] } as Record<string, unknown>,
}));

vi.mock("@fx/core/src/tenancy/withTenant.js", () => ({
  withTenant: async (_pool: unknown, _account: string, fn: (c: unknown) => unknown) =>
    fn({ query: async (sql: string) => ({ rows: sql.includes("halt_epoch") ? [{ halt_epoch: h.facts.halt_epoch }] : h.facts.u === undefined ? [] : [{ u: h.facts.u, id: h.facts.id }] }) }),
}));
vi.mock("@fx/core/src/work-items/driverEvents.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  recordDriverEvent: async (_c: unknown, accountId: string, input: Record<string, unknown>) => void h.events.push({ accountId, input }),
}));
vi.mock("./advanceReviewSteps", () => ({
  reviewLoadBody: async () => h.ctx,
  findPrBody: async () => h.pr,
  startReviewerBody: async () => ({ runId: null, reason: null }),
  reviewerOutcomeBody: async () => ({}),
}));

import { bindOnRenumber, entrylessRenumberPorts, renumberPorts } from "./mergeQueueRenumber";

const SHA = (c: string) => c.repeat(40);
const entry = { id: "e1", accountId: "acct", workItemId: "item", headSha: SHA("a"), prNumber: 41 } as mergeQueue.MergeQueueEntry;
const round = { id: "r1", round: 2, fromSha: SHA("a"), baseSha: SHA("b"), baseRef: "main", conflictFiles: ["src/a.ts", "docs/x.md"] } as unknown as mergeQueue.ConflictRound;

beforeEach(() => {
  h.events = [];
  h.facts = { halt_epoch: 4, u: "user-1", id: "6f1d6c34-7f0d-4a53-8d4c-0a5e8a6b9c11" };
  h.ctx = { ok: true, tier: "feature", debaterEnabled: false, repoId: "r", owner: "acme", name: "widgets", issue: 7, branch: "fx/issue-7", specVersion: 3, executionMode: "sandbox" };
  h.pr = { ok: true, number: 41, headSha: "f".repeat(40), baseRef: "main", branch: "fx/issue-7", securityCodes: [] };
});

describe("MQ5-b1: the renumber round's start ports", () => {
  const buildRenumber = (start: (who: unknown, req: Record<string, unknown>) => unknown = async () => ({ ok: true, runId: "run-9" })) => {
    const advanceStartFix = vi.fn(start);
    const ports = renumberPorts({ pool: {} as never, worker: { advanceStartFix } as never, open: (async () => ({})) as never, github: {} as never });
    return { advanceStartFix, ports };
  };
  const files = ["packages/db/migrations/0710_x.sql"];

  it("starts the worker's renumber round with the round's facts, no reviewer, failing run or person, and the renumber prompt (no merge)", async () => {
    const { ports, advanceStartFix } = buildRenumber();
    expect(await ports.startRenumberRound({ entry, round: { ...round, conflictFiles: files }, resource: "migrations", highest: "0712" })).toEqual({ ok: true, runId: "run-9" });
    const [who, req] = advanceStartFix.mock.calls[0]!;
    expect(who).toEqual({ accountId: "acct", userId: "user-1", workItemId: "item", haltEpoch: 4 });
    expect(req).toMatchObject({ kind: "renumber", baseSha: SHA("b"), issue: 7, headSha: SHA("a"), round: 2, actionId: h.facts.id, pr: { number: 41, branch: "fx/issue-7" } });
    for (const k of ["reviewer", "failingRunId", "person"]) expect(req).not.toHaveProperty(k);
    expect(req["prompt"]).toContain("- packages/db/migrations/0710_x.sql");
    expect(req["prompt"]).toContain("latest key on main: 0712");
    expect(req["prompt"]).toContain("Make no merge commit");
    expect(req["prompt"]).not.toContain("git merge origin");
  });

  it.each(["refused_spend", ...RESERVATION_PAUSE_REASONS, "model_budget_exceeded"])("a spend refusal (%s) is refused_spend", async (reason) => {
    expect(await buildRenumber(async () => ({ ok: false, reason })).ports.startRenumberRound({ entry, round, resource: "migrations", highest: "0712" })).toEqual({ ok: false, reason: "refused_spend" });
  });

  it("a wait for capacity and any other refusal keep their codes; a value the prompt refuses starts nothing", async () => {
    expect(await buildRenumber(async () => ({ ok: false, reason: "waiting_for_capacity" })).ports.startRenumberRound({ entry, round, resource: "migrations", highest: "0712" })).toEqual({ ok: false, reason: "waiting_for_capacity" });
    const bad = buildRenumber();
    expect(await bad.ports.startRenumberRound({ entry, round, resource: "bad\nname", highest: "0712" })).toEqual({ ok: false, reason: "invalid_input" });
    expect(bad.advanceStartFix).not.toHaveBeenCalled();
  });

  it("the tick's binding is on (the constant since MQ5-b2); a start passed false reads nothing and starts nothing; with the proof unread the decision answers no without a GitHub read", async () => {
    const advanceStartFix = vi.fn(async () => ({ ok: true, runId: "run-9" }));
    const deps = { pool: {} as never, worker: { advanceStartFix } as never, open: (async () => ({})) as never, github: {} as never };
    const ask = { autoRenumber: true, resource: "migrations", files, highest: "0712" };
    expect(mergeQueue.RENUMBER_START_ENABLED).toBe(true);
    expect(await bindOnRenumber(deps, false)(entry, "holder", ask, SHA("a"))).toBe(false);
    expect(advanceStartFix).not.toHaveBeenCalled();
    // Enabled (the default is the constant), the decision runs and needs the push-record proof; with none readable it answers no without a GitHub read (the stub github has no methods).
    mergeQueue.setPlatformCommitProofForTest(async () => null);
    try {
      for (const enabled of [undefined, true]) expect(await bindOnRenumber(deps, enabled)(entry, "holder", ask, SHA("a"))).toBe(false);
    } finally {
      mergeQueue.setPlatformCommitProofForTest(null);
    }
    expect(advanceStartFix).not.toHaveBeenCalled();
  });
});

describe("D#483 S5-j2e: the same start for an item with no queue entry", () => {
  const subject: mergeQueue.ConflictSubject = { id: "item", accountId: "acct", repoId: "r", workItemId: "item", prNumber: 41, headSha: SHA("a"), entryId: null, roundsUsed: 1 };
  const files = ["packages/db/migrations/0710_x.sql"];

  it("starts the worker's renumber round for the subject, with the renumber prompt, and reads the ordered files from the client the gate used", async () => {
    const advanceStartFix = vi.fn(async () => ({ ok: true, runId: "run-9" }));
    const github = { listPullRequestAdds: async () => ({ complete: true, paths: files }) };
    const ports = entrylessRenumberPorts({ pool: {} as never, worker: { advanceStartFix } as never, open: (async () => ({})) as never, github: github as never });
    expect(ports.github).toBe(github);
    expect(await ports.startRenumberRound({ entry: subject, round: { ...round, conflictFiles: files }, resource: "migrations", highest: "0712" })).toEqual({ ok: true, runId: "run-9" });
    const [who, req] = advanceStartFix.mock.calls[0]! as unknown as [unknown, Record<string, unknown>];
    expect(who).toEqual({ accountId: "acct", userId: "user-1", workItemId: "item", haltEpoch: 4 });
    expect(req).toMatchObject({ kind: "renumber", headSha: SHA("a"), pr: { number: 41, branch: "fx/issue-7" } });
    expect(req["prompt"]).toContain("latest key on main: 0712");
  });

  it("a spend refusal stays refused_spend and a capacity wait stays a wait", async () => {
    for (const [reason, want] of [["refused_spend", "refused_spend"], ["waiting_for_capacity", "waiting_for_capacity"]] as const) {
      const ports = entrylessRenumberPorts({ pool: {} as never, worker: { advanceStartFix: async () => ({ ok: false, reason }) } as never, open: (async () => ({})) as never, github: {} as never });
      expect(await ports.startRenumberRound({ entry: subject, round, resource: "migrations", highest: "0712" })).toEqual({ ok: false, reason: want });
    }
  });
});
