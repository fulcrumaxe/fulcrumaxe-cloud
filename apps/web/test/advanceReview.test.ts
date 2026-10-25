import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadReviewContext: vi.fn(),
  runMergeGateForItem: vi.fn(),
  recordRound: vi.fn(),
  createCiGate: vi.fn(),
  recordMergeOnlyRecheck: vi.fn(),
  createReviewGitHubPort: vi.fn(),
  readItemRecordedPullRequest: vi.fn(),
}));
vi.mock("@fx/pipeline", async (original) => ({
  ...(await original<typeof import("@fx/pipeline")>()),
  loadReviewContext: mocks.loadReviewContext,
  runMergeGateForItem: mocks.runMergeGateForItem,
  recordRound: mocks.recordRound,
  createCiGate: mocks.createCiGate,
  recordMergeOnlyRecheck: mocks.recordMergeOnlyRecheck,
  createReviewGitHubPort: mocks.createReviewGitHubPort,
  readItemRecordedPullRequest: mocks.readItemRecordedPullRequest,
}));

import { createReviewDeps } from "../lib/advanceReview";
import { reviewLoadBody } from "../lib/advanceReviewSteps";

const ACCOUNT = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
const REPO = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const ITEM = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

/** A pool whose connections record every statement and answer the opt-in read with `on`. */
function fakePool(on: boolean) {
  const statements: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params });
      return { rows: /repo_local_review_optins/.test(sql) ? [{ on }] : [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return { pool: { connect: async () => client } as never, statements };
}

describe("the review stage's merge gate (D#6 R2b)", () => {
  beforeEach(() => {
    mocks.loadReviewContext.mockReset();
    mocks.runMergeGateForItem.mockReset();
    mocks.loadReviewContext.mockResolvedValue({ ok: true, ctx: { repoId: REPO, owner: "acme", name: "widgets" } });
    mocks.runMergeGateForItem.mockResolvedValue({ outcome: "ready_human_merges", headSha: "a".repeat(40), reasons: [], status: "skipped" });
  });

  it("hands the gate the real per-repo opt-in port, which reads the stored setting under the account's own tenant", async () => {
    const deps = createReviewDeps(async () => ({}) as never);
    const { pool, statements } = fakePool(true);
    await deps.mergeGate(pool, { accountId: ACCOUNT, workItemId: ITEM, prNumber: 7 });
    expect(mocks.runMergeGateForItem).toHaveBeenCalledTimes(1);
    const gateDeps = mocks.runMergeGateForItem.mock.calls[0]![0] as { localReviewOptIn?: { enabled(input: { accountId: string; repoId: string }): Promise<boolean> } };
    expect(typeof gateDeps.localReviewOptIn?.enabled).toBe("function");
    expect(await gateDeps.localReviewOptIn!.enabled({ accountId: ACCOUNT, repoId: REPO })).toBe(true);
    const read = statements.find((s) => /repo_local_review_optins/.test(s.sql));
    expect(read?.params).toEqual([ACCOUNT, REPO]);
    // The tenant is set (a statement carrying the account id) before the read, in the same connection.
    expect(statements.slice(0, statements.indexOf(read!)).some((s) => s.params?.includes(ACCOUNT))).toBe(true);
  });

  it("D#6 R3c: a runner_local repo's gate gets a client opened with GraphQL allowed and fenced; a sandbox repo's gets the plain one", async () => {
    const plain = { request: vi.fn(async () => ({ status: 200, body: {} })) };
    const open = vi.fn(async () => plain as never);
    const { pool } = fakePool(true);
    mocks.loadReviewContext.mockResolvedValue({ ok: true, ctx: { repoId: REPO, owner: "acme", name: "widgets", executionMode: "runner_local" } });
    await createReviewDeps(open).mergeGate(pool, { accountId: ACCOUNT, workItemId: ITEM, prNumber: 7 });
    expect(open).toHaveBeenLastCalledWith("merge_gate", { repoId: REPO, owner: "acme", name: "widgets", allowGraphql: true });
    const fenced = (mocks.runMergeGateForItem.mock.calls[0]![0] as { http: { request(r: unknown): Promise<unknown>; graphql: unknown } }).http;
    expect(typeof fenced.graphql).toBe("function");
    await expect(fenced.request({ method: "GET", path: "/repos/acme/widgets/pulls/7/files" })).rejects.toThrow(/local-only github: refused/);
    expect(plain.request).not.toHaveBeenCalled();

    mocks.loadReviewContext.mockResolvedValue({ ok: true, ctx: { repoId: REPO, owner: "acme", name: "widgets", executionMode: "sandbox" } });
    await createReviewDeps(open).mergeGate(pool, { accountId: ACCOUNT, workItemId: ITEM, prNumber: 7 });
    expect(open).toHaveBeenLastCalledWith("merge_gate", { repoId: REPO, owner: "acme", name: "widgets" });
    expect((mocks.runMergeGateForItem.mock.calls[1]![0] as { http: unknown }).http).toBe(plain);
  });

  describe("reconcileMergeOrder (an authorized order the runner never reported on)", () => {
    const HEAD_PUB = "c".repeat(40);
    const order = { id: "4d5e6f7a-8b9c-4d1e-9f2a-3b4c5d6e7f80", accountId: ACCOUNT, workItemId: ITEM, planePushId: "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f", repoId: REPO, codeRepo: "acme/widgets-public", prNumber: 12, expectedPublicHead: HEAD_PUB, reviewedHead: "a".repeat(40), pairingDigest: "d".repeat(64), state: "authorized", leaseGeneration: 1, writeTokenIssuedAt: new Date(), outcomeCode: null };
    const pool = { connect: async () => ({ query: async (sql: string) => ({ rows: /FROM plane_pushes/.test(sql) ? [{ branch: "fx/p-x" }] : [], rowCount: 0 }), release: () => undefined }) } as never;

    beforeEach(() => {
      mocks.createReviewGitHubPort.mockReset();
      mocks.readItemRecordedPullRequest.mockReset();
      mocks.loadReviewContext.mockResolvedValue({ ok: true, ctx: { repoId: REPO, owner: "acme", name: "widgets", executionMode: "runner_local" } });
      mocks.readItemRecordedPullRequest.mockResolvedValue(null);
    });

    it("a merge GitHub confirms ends the order merged and then reconciles the item's stage (the reconcile the worker passes in)", async () => {
      mocks.createReviewGitHubPort.mockReturnValue({ getPullRequest: async () => ({ state: "closed", merged: true, headSha: HEAD_PUB }) });
      const finish = vi.fn(async () => ({ kind: "finished", order }));
      const reconcile = vi.fn(async () => "merged");
      const plain = { request: vi.fn(async () => ({ status: 200, body: [] })) };
      await createReviewDeps(async () => plain as never).reconcileMergeOrder!(pool, { finish } as never, order as never, { reconcile });
      expect(finish).toHaveBeenCalledWith(expect.objectContaining({ orderId: order.id, to: "merged", actor: { by: "cloud" } }));
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACCOUNT, workItemId: ITEM }));
      expect(finish.mock.invocationCallOrder[0]!).toBeLessThan(reconcile.mock.invocationCallOrder[0]!);
    });

    it("no merge, no reconcile: an open pull request at the same head ends the order failed and reconciles nothing", async () => {
      mocks.createReviewGitHubPort.mockReturnValue({ getPullRequest: async () => ({ state: "open", merged: false, headSha: HEAD_PUB }) });
      const finish = vi.fn(async () => ({ kind: "finished", order }));
      const reconcile = vi.fn(async () => "open");
      await createReviewDeps(async () => ({ request: vi.fn() }) as never).reconcileMergeOrder!(pool, { finish } as never, order as never, { reconcile });
      expect(finish).toHaveBeenCalledWith(expect.objectContaining({ to: "failed", code: "runner_merge_failed" }));
      expect(reconcile).not.toHaveBeenCalled();
    });
  });

  describe("the code repository's client (D#6 PUBLIC-MERGE): the cloud never calls merge there", () => {
    const merge = { method: "PUT", path: "/repos/acme/widgets-public/pulls/12/merge", body: { sha: "c".repeat(40), merge_method: "squash" } } as const;
    const list = { method: "GET", path: "/repos/acme/widgets-public/pulls", query: { head: "acme:fx/p-1", state: "all", per_page: 100 } } as const;
    type Opener = (c: { repoId: string; owner: string; name: string; executionMode: string }) => Promise<{ request(r: unknown): Promise<unknown> }>;
    const code = { repoId: REPO, owner: "acme", name: "widgets-public", executionMode: "runner_local" };

    async function exercise(opener: Opener, plain: { request: ReturnType<typeof vi.fn> }) {
      const client = await opener(code);
      // A merge PUT is refused by the fence BEFORE any request is made; a list read (A3) is not.
      await expect(client.request(merge)).rejects.toThrow(/local-only github: refused/);
      expect(plain.request).not.toHaveBeenCalled();
      await client.request(list);
      expect(plain.request).toHaveBeenCalledTimes(1);
      expect(plain.request.mock.calls[0]![0]).toMatchObject({ method: "GET", path: list.path });
    }

    it("the merge gate's public client (publicPlane.open) refuses a merge PUT on the code repository and allows the pull request list", async () => {
      const plain = { request: vi.fn(async () => ({ status: 200, body: [] })) };
      const open = vi.fn(async () => plain as never);
      const { pool } = fakePool(true);
      mocks.loadReviewContext.mockResolvedValue({ ok: true, ctx: { repoId: REPO, owner: "acme", name: "widgets", executionMode: "runner_local" } });
      await createReviewDeps(open).mergeGate(pool, { accountId: ACCOUNT, workItemId: ITEM, prNumber: 7 });
      const gateDeps = mocks.runMergeGateForItem.mock.calls[0]![0] as { publicPlane: { open: Opener }; http: { request(r: unknown): Promise<unknown> } };
      plain.request.mockClear();
      await exercise(gateDeps.publicPlane.open, plain);
      // The same fence on the item's OWN repository does allow the merge call (A10): the single-plane runner_local path is unchanged.
      plain.request.mockClear();
      await gateDeps.http.request(merge);
      expect(plain.request).toHaveBeenCalledTimes(1);
    });

    it("the CI wait's public client (createCiGate openPublicHttp) is the same fenced client without the merge call", async () => {
      mocks.recordRound.mockResolvedValue({ decision: "ci_pending", round: 0, recorded: [] });
      mocks.createCiGate.mockImplementation((d: unknown) => ({ gate: true, d }));
      const plain = { request: vi.fn(async () => ({ status: 200, body: [] })) };
      const open = vi.fn(async () => plain as never);
      const { pool } = fakePool(false);
      await createReviewDeps(open).recordRound(pool, {} as never, { accountId: ACCOUNT, workItemId: ITEM, headSha: "a".repeat(40), prNumber: 7, requiredRoles: [], verdicts: [] } as never);
      const d = (mocks.recordRound.mock.calls.at(-1)![3] as { d: { openPublicHttp: Opener } }).d;
      await exercise(d.openPublicHttp, plain);
    });
  });

  it("the port answers off when the setting is not there", async () => {
    const deps = createReviewDeps(async () => ({}) as never);
    const { pool } = fakePool(false);
    await deps.mergeGate(pool, { accountId: ACCOUNT, workItemId: ITEM, prNumber: 7 });
    const gateDeps = mocks.runMergeGateForItem.mock.calls[0]![0] as { localReviewOptIn: { enabled(input: { accountId: string; repoId: string }): Promise<boolean> } };
    expect(await gateDeps.localReviewOptIn.enabled({ accountId: ACCOUNT, repoId: REPO })).toBe(false);
  });
});

describe("the review stage's context load", () => {
  beforeEach(() => {
    mocks.loadReviewContext.mockReset();
  });

  it("carries the fix rounds already started through the facade, so a restarted workflow reviews at round count + 1", async () => {
    mocks.loadReviewContext.mockResolvedValue({
      ok: true,
      ctx: { workItemId: ITEM, stage: "review", repoId: REPO, owner: "acme", name: "widgets", issue: 12, tier: "T2", specVersion: 3, fixRoundsStarted: 2, debaterMode: null },
    });
    const { pool } = fakePool(false);
    const loaded = await createReviewDeps(async () => ({}) as never).load(pool, ACCOUNT, ITEM);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.ctx.fixRoundsStarted).toBe(2);
    // The worker hands this object on as the step's context; the workflow's load step turns it into the round the prompt gets.
    const body = await reviewLoadBody({ advanceLoadReview: async () => ({ ok: true, ctx: loaded.ctx }) } as never, { accountId: ACCOUNT, workItemId: ITEM } as never, 3);
    expect(body.ok && body.fixRoundsStarted).toBe(2);
  });
});

describe("D#598 P7b: recording a round is behind the CI wait", () => {
  const input = { accountId: ACCOUNT, workItemId: ITEM, headSha: "a".repeat(40), prNumber: 7, requiredRoles: ["code-reviewer"], verdicts: [] };
  beforeEach(() => {
    mocks.recordRound.mockReset();
    mocks.createCiGate.mockReset();
    mocks.recordRound.mockResolvedValue({ decision: "ci_pending", round: 0, recorded: [] });
    mocks.createCiGate.mockImplementation((d: unknown) => ({ gate: true, d }));
  });

  it("never records without a gate: the pipeline's recordRound is always given one, built over the item's pool", async () => {
    const { pool } = fakePool(false);
    await createReviewDeps(async () => ({}) as never).recordRound(pool, {} as never, input);
    expect(mocks.recordRound).toHaveBeenCalledTimes(1);
    const gate = mocks.recordRound.mock.calls[0]![3] as { gate: boolean; d: { pool: unknown } };
    expect(gate.gate).toBe(true);
    expect(gate.d.pool).toBe(pool);
  });

  it("the gate reads CI with the merge gate's token purpose, plain for a sandbox repo and fenced (GraphQL allowed) for a runner_local one", async () => {
    const plain = { request: vi.fn(async () => ({ status: 200, body: {} })) };
    const open = vi.fn(async () => plain as never);
    const { pool } = fakePool(false);
    await createReviewDeps(open).recordRound(pool, {} as never, input);
    const d = (mocks.recordRound.mock.calls[0]![3] as { d: { openHttp: (c: { repoId: string; owner: string; name: string; executionMode: string }) => Promise<unknown> } }).d;
    await d.openHttp({ repoId: REPO, owner: "acme", name: "widgets", executionMode: "sandbox" });
    expect(open).toHaveBeenLastCalledWith("merge_gate", { repoId: REPO, owner: "acme", name: "widgets" });
    await d.openHttp({ repoId: REPO, owner: "acme", name: "widgets", executionMode: "runner_local" });
    expect(open).toHaveBeenLastCalledWith("merge_gate", { repoId: REPO, owner: "acme", name: "widgets", allowGraphql: true });
  });

  it("the pending answer reaches the workflow unchanged", async () => {
    const { pool } = fakePool(false);
    expect(await createReviewDeps(async () => ({}) as never).recordRound(pool, {} as never, input)).toMatchObject({ decision: "ci_pending", recorded: [] });
  });
});

describe("D#598 P7c: the merge-only re-check reads GitHub the way the CI wait does", () => {
  const input = { accountId: ACCOUNT, workItemId: ITEM, headSha: "a".repeat(40), prNumber: 7, baseRef: "main", requiredRoles: ["code-reviewer", "acceptance-tester"] };
  const ctx = { workItemId: ITEM, stage: "review_passed", repoId: REPO, owner: "acme", name: "widgets", issue: 7, tier: "feature", specVersion: 1, fixRoundsStarted: 0, debaterMode: null, executionMode: "sandbox" };
  beforeEach(() => {
    mocks.recordMergeOnlyRecheck.mockReset();
    mocks.createCiGate.mockReset();
    mocks.loadReviewContext.mockReset();
    mocks.createCiGate.mockImplementation((d: unknown) => ({ gate: true, d }));
    mocks.loadReviewContext.mockResolvedValue({ ok: true, ctx });
  });

  it("is given a CI gate (the wait is not skippable) and a client opened with the merge gate's purpose", async () => {
    mocks.recordMergeOnlyRecheck.mockResolvedValue({ decision: "ci_pending", ciReasons: ["check_running"] });
    const http = { request: vi.fn() };
    const open = vi.fn(async () => http as never);
    const { pool } = fakePool(false);
    expect(await createReviewDeps(open).recordMergeOnly!(pool, input)).toEqual({ decision: "ci_pending" });
    expect(open).toHaveBeenCalledWith("merge_gate", { repoId: REPO, owner: "acme", name: "widgets" });
    const [, passedInput, deps] = mocks.recordMergeOnlyRecheck.mock.calls[0]! as [unknown, { baseRef: string; requiredRoles: string[] }, { http: unknown; ci: { gate: boolean } }];
    expect(passedInput).toMatchObject({ baseRef: "main", requiredRoles: ["code-reviewer", "acceptance-tester"] });
    expect(deps.http).toBe(http);
    expect(deps.ci.gate).toBe(true);
  });

  it("a full-review answer carries its fixed reason; an item the review cannot load is a full review, not a throw", async () => {
    mocks.recordMergeOnlyRecheck.mockResolvedValue({ decision: "full_review", reason: "code_changed" });
    const { pool } = fakePool(false);
    expect(await createReviewDeps(async () => ({}) as never).recordMergeOnly!(pool, input)).toEqual({ decision: "full_review", reason: "code_changed" });
    mocks.loadReviewContext.mockResolvedValue({ ok: false, reason: "no_spec" });
    expect(await createReviewDeps(async () => ({}) as never).recordMergeOnly!(pool, input)).toEqual({ decision: "full_review", reason: "no_spec" });
  });
});
