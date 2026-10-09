import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadReviewContext: vi.fn(),
  runMergeGateForItem: vi.fn(),
}));
vi.mock("@fx/pipeline", async (original) => ({
  ...(await original<typeof import("@fx/pipeline")>()),
  loadReviewContext: mocks.loadReviewContext,
  runMergeGateForItem: mocks.runMergeGateForItem,
}));

import { createReviewDeps } from "../lib/advanceReview";

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

  it("the port answers off when the setting is not there", async () => {
    const deps = createReviewDeps(async () => ({}) as never);
    const { pool } = fakePool(false);
    await deps.mergeGate(pool, { accountId: ACCOUNT, workItemId: ITEM, prNumber: 7 });
    const gateDeps = mocks.runMergeGateForItem.mock.calls[0]![0] as { localReviewOptIn: { enabled(input: { accountId: string; repoId: string }): Promise<boolean> } };
    expect(await gateDeps.localReviewOptIn.enabled({ accountId: ACCOUNT, repoId: REPO })).toBe(false);
  });
});
