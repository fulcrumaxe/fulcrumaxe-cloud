import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadReviewContext: vi.fn(),
  runMergeGateForItem: vi.fn(),
  readPublicPullRequest: vi.fn(),
  readItemRecordedPullRequest: vi.fn(),
  createReviewGitHubPort: vi.fn(),
}));
vi.mock("@fx/pipeline", async (original) => ({
  ...(await original<typeof import("@fx/pipeline")>()),
  loadReviewContext: mocks.loadReviewContext,
  runMergeGateForItem: mocks.runMergeGateForItem,
  readPublicPullRequest: () => mocks.readPublicPullRequest,
  readItemRecordedPullRequest: mocks.readItemRecordedPullRequest,
  createReviewGitHubPort: mocks.createReviewGitHubPort,
}));

import { DEQUEUE_PULL_REQUEST_DOCUMENT, ENABLE_AUTO_MERGE_DOCUMENT, ENQUEUE_PULL_REQUEST_DOCUMENT, MERGE_QUEUE_ENTRY_DOCUMENT, MERGE_QUEUE_READ_DOCUMENT } from "@fx/github";
import { createPlaneMergeOps } from "../lib/planeMerge";

/**
 * D#6 PUBLIC-MERGE PR2b: the cloud's half of a merge order, with the gate and the GitHub port replaced (their own suites are in packages/pipeline) and a pool that
 * records every statement. What is pinned here is what this file decides: which clients it opens (the code repository's has no merge call), what the gate is
 * given, how the gate's outcome becomes the route's answer, and the three steps after a verified merge (the fact, the reconcile, the private copy).
 */
const ACCOUNT = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
const REPO = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const ITEM = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const PUSH = "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f";
const PUB = "c".repeat(40);
const SRC = "a".repeat(40);
const order = { id: "4d5e6f7a-8b9c-4d1e-9f2a-3b4c5d6e7f80", workItemId: ITEM, planePushId: PUSH, repoId: REPO, codeRepo: "acme/widgets-public", prNumber: 12, expectedPublicHead: PUB, reviewedHead: SRC, pairingDigest: "d".repeat(64), state: "authorized", leaseGeneration: 1, writeTokenIssuedAt: new Date(), outcomeCode: null };
const ctx = { repoId: REPO, owner: "acme", name: "widgets", executionMode: "runner_local" };
const attestation = { reviewedHead: SRC, publicHead: PUB, same: true, incomplete: false, paths: ["src/a.ts"] };

function fakePool(branch: string | null = `fx/p-${PUSH}`) {
  const statements: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params });
      return { rows: /FROM plane_pushes/.test(sql) ? (branch === null ? [] : [{ branch }]) : [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return { pool: { connect: async () => client } as never, statements };
}

function ops(over: { open?: ReturnType<typeof vi.fn>; reconcile?: ReturnType<typeof vi.fn>; closePrivate?: ReturnType<typeof vi.fn> | null } = {}) {
  const f = fakePool();
  const plain = { request: vi.fn(async () => ({ status: 200, body: [] })) };
  const open = over.open ?? vi.fn(async () => plain as never);
  const closePrivate = over.closePrivate === null ? undefined : (over.closePrivate ?? vi.fn(async () => undefined));
  const reconcile = over.reconcile ?? vi.fn(async () => "merged");
  const o = createPlaneMergeOps({ open: open as never, withPool: (fn) => fn(f.pool), reconcile: reconcile as never, ...(closePrivate ? { closePrivate } : {}) });
  return { o, f, open, closePrivate, reconcile, plain };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.loadReviewContext.mockResolvedValue({ ok: true, ctx });
  mocks.readPublicPullRequest.mockResolvedValue({ paired: true, pr: { owner: "acme", name: "widgets-public", number: 12, branch: `fx/p-${PUSH}` } });
  mocks.readItemRecordedPullRequest.mockResolvedValue({ number: 7, branch: "fx/run-g1" });
  mocks.runMergeGateForItem.mockResolvedValue({ outcome: "merge_delegated", headSha: PUB, reasons: [], status: "skipped" });
});

describe("goPhase", () => {
  it("runs the whole gate with the attestation, the item's own pull request and the code repository's merge-less client; a go is the delegate having been called", async () => {
    const t = ops();
    mocks.runMergeGateForItem.mockImplementation(async (deps: { mergeDelegate: (a: object, c: { mergeMode: "queue" | "direct" }) => Promise<unknown>; publicPlane: { open: (c: unknown) => Promise<{ request(r: unknown): Promise<unknown> }> } }) => {
      expect(await deps.mergeDelegate({}, { mergeMode: "direct" })).toEqual({ delegated: true });
      // The public client is the fenced one without the merge call: a merge PUT is refused before any request.
      const pub = await deps.publicPlane.open({ repoId: REPO, owner: "acme", name: "widgets-public", executionMode: "runner_local" });
      await expect(pub.request({ method: "PUT", path: "/repos/acme/widgets-public/pulls/12/merge", body: { sha: PUB, merge_method: "squash" } })).rejects.toThrow(/local-only github: refused/);
      expect(t.plain.request).not.toHaveBeenCalled();
      return { outcome: "merge_delegated", headSha: PUB, reasons: [], status: "skipped" };
    });
    const delegate = vi.fn(async () => ({ delegated: true as const }));
    expect(await t.o.goPhase({ accountId: ACCOUNT, order, attestation, delegate })).toEqual({ kind: "go", mergeMode: "direct" });
    expect(delegate).toHaveBeenCalledTimes(1);
    const [, input] = mocks.runMergeGateForItem.mock.calls[0]!;
    expect(input).toEqual({ accountId: ACCOUNT, workItemId: ITEM, prNumber: 7, goPhase: { attestation } });
  });

  it("a delegate that refuses becomes the gate's reason, and the gate's stops come back as they are", async () => {
    const t = ops();
    mocks.runMergeGateForItem.mockImplementation(async (deps: { mergeDelegate: (a: object, c: { mergeMode: "queue" | "direct" }) => Promise<unknown> }) => {
      const r = await deps.mergeDelegate({}, { mergeMode: "direct" });
      return { outcome: "ready_human_merges", headSha: PUB, reasons: [(r as { reason: string }).reason], status: "skipped" };
    });
    expect(await t.o.goPhase({ accountId: ACCOUNT, order, attestation, delegate: async () => ({ delegated: false, reason: "runner_merge_failed" }) })).toEqual({ kind: "blocked", reasons: ["runner_merge_failed"] });
    for (const [out, want] of [
      [{ outcome: "head_moved" }, { kind: "head_moved" }],
      [{ outcome: "pr_not_open" }, { kind: "pr_not_open" }],
      [{ outcome: "refused", reason: "go_not_applicable" }, { kind: "refused", reason: "go_not_applicable" }],
      [{ outcome: "merged" }, { kind: "refused", reason: "unexpected_merged" }],
    ] as const) {
      mocks.runMergeGateForItem.mockResolvedValue(out);
      expect(await t.o.goPhase({ accountId: ACCOUNT, order, attestation, delegate: async () => ({ delegated: true }) })).toEqual(want);
    }
  });

  it("an order for any pull request but the item's CURRENT public one is a moved head, and the gate is not run", async () => {
    const t = ops();
    for (const pr of [null, { owner: "acme", name: "widgets-public", number: 13 }, { owner: "acme", name: "other", number: 12 }, { owner: "evil", name: "widgets-public", number: 12 }]) {
      mocks.readPublicPullRequest.mockResolvedValue(pr === null ? { paired: true, pr: null } : { paired: true, pr });
      expect(await t.o.goPhase({ accountId: ACCOUNT, order, attestation, delegate: async () => ({ delegated: true }) })).toEqual({ kind: "head_moved" });
    }
    expect(mocks.runMergeGateForItem).not.toHaveBeenCalled();
  });

  it("an item that cannot be loaded, or has no recorded pull request, is refused with a fixed reason", async () => {
    const t = ops();
    mocks.loadReviewContext.mockResolvedValue({ ok: false, reason: "no_spec" });
    expect(await t.o.goPhase({ accountId: ACCOUNT, order, attestation, delegate: async () => ({ delegated: true }) })).toEqual({ kind: "refused", reason: "no_spec" });
    mocks.loadReviewContext.mockResolvedValue({ ok: true, ctx });
    mocks.readItemRecordedPullRequest.mockResolvedValue(null);
    expect(await t.o.goPhase({ accountId: ACCOUNT, order, attestation, delegate: async () => ({ delegated: true }) })).toEqual({ kind: "refused", reason: "no_pull_request" });
    expect(mocks.runMergeGateForItem).not.toHaveBeenCalled();
  });
});

// D#694 B7-1: the gate reads the CODE repository's mode and hands the delegate what it read; the go carries it, and a queue repository's order goes only to a runner that can enqueue.
describe("goPhase and the merge queue", () => {
  const gateAnswers = (mode: "queue" | "direct") =>
    mocks.runMergeGateForItem.mockImplementation(async (deps: { mergeDelegate: (a: object, c: { mergeMode: "queue" | "direct" }) => Promise<{ delegated: boolean; reason?: string }> }) => {
      const r = await deps.mergeDelegate({}, { mergeMode: mode });
      return r.delegated ? { outcome: "merge_delegated", headSha: PUB, reasons: [], status: "skipped" } : { outcome: "ready_human_merges", headSha: PUB, reasons: [r.reason], status: "skipped" };
    });

  it("a queue repository and a runner that can enqueue: the delegate runs and the go says queue; a direct one says direct", async () => {
    const t = ops();
    for (const mode of ["queue", "direct"] as const) {
      gateAnswers(mode);
      const delegate = vi.fn(async () => ({ delegated: true as const }));
      expect(await t.o.goPhase({ accountId: ACCOUNT, order, attestation, queueCapable: true, delegate })).toEqual({ kind: "go", mergeMode: mode });
      expect(delegate).toHaveBeenCalledTimes(1);
    }
  });

  it("a queue repository and a runner that cannot: the delegate (the write credential's mint) is NOT called and the stop is runner_update_required; a direct repository does not need the capability", async () => {
    const t = ops();
    gateAnswers("queue");
    const delegate = vi.fn(async () => ({ delegated: true as const }));
    for (const queueCapable of [false, undefined]) {
      expect(await t.o.goPhase({ accountId: ACCOUNT, order, attestation, ...(queueCapable === undefined ? {} : { queueCapable }), delegate })).toEqual({ kind: "blocked", reasons: ["runner_update_required"] });
    }
    expect(delegate).not.toHaveBeenCalled();
    gateAnswers("direct");
    expect(await t.o.goPhase({ accountId: ACCOUNT, order, attestation, queueCapable: false, delegate })).toEqual({ kind: "go", mergeMode: "direct" });
  });

  it("the gate is given the queue documents, byte for byte the pinned ones, and the cloud's go never carries the enqueue", async () => {
    const t = ops();
    await t.o.goPhase({ accountId: ACCOUNT, order, attestation, delegate: async () => ({ delegated: true }) });
    const [deps] = mocks.runMergeGateForItem.mock.calls[0]!;
    expect(deps.queueDocuments).toEqual({ read: MERGE_QUEUE_READ_DOCUMENT, enqueue: ENQUEUE_PULL_REQUEST_DOCUMENT, autoMerge: ENABLE_AUTO_MERGE_DOCUMENT, dequeue: DEQUEUE_PULL_REQUEST_DOCUMENT, entry: MERGE_QUEUE_ENTRY_DOCUMENT });
  });
});

describe("readPublicQueue and recordEnqueued", () => {
  it("reads the pull request and its queue entry through the code repository's client with the paired queue reads on; an entry gives its id, none gives null", async () => {
    const t = ops();
    const getQueueEntry = vi.fn(async () => ({ state: "open", merged: false, headSha: PUB, entry: { id: "MQE_kwDOAAAAAQ", state: "queued", position: 1 } }));
    mocks.createReviewGitHubPort.mockReturnValue({ getQueueEntry });
    expect(await t.o.readPublicQueue({ accountId: ACCOUNT, order })).toEqual({ open: true, merged: false, headSha: PUB, entryId: "MQE_kwDOAAAAAQ" });
    expect(t.open).toHaveBeenCalledWith("merge_gate", { repoId: REPO, owner: "acme", name: "widgets-public", allowGraphql: true });
    const [deps, portCtx] = mocks.createReviewGitHubPort.mock.calls[0]!;
    expect(deps).toMatchObject({ pairedQueueReads: true, queueDocuments: { read: MERGE_QUEUE_READ_DOCUMENT, entry: MERGE_QUEUE_ENTRY_DOCUMENT } });
    expect(portCtx).toMatchObject({ owner: "acme", name: "widgets-public" });
    expect(getQueueEntry).toHaveBeenCalledWith({ repoId: REPO, prNumber: 12 });
    getQueueEntry.mockResolvedValue({ state: "closed", merged: true, headSha: PUB, entry: null } as never);
    expect(await t.o.readPublicQueue({ accountId: ACCOUNT, order })).toEqual({ open: false, merged: true, headSha: PUB, entryId: null });
  });

  it("records merge_enqueued with the PUBLIC number and head, the entry id and the key the webhook writes for the same entry; it records no merge", async () => {
    const t = ops();
    await t.o.recordEnqueued({ accountId: ACCOUNT, order, entryId: "MQE_kwDOAAAAAQ" });
    const event = t.f.statements.find((s) => /INSERT INTO work_item_driver_events/.test(s.sql));
    expect(event?.params).toEqual([ACCOUNT, ITEM, "merge_enqueued", "queue", [], PUB, 12, null, null, `enqueued:${PUB}`, null, null, "MQE_kwDOAAAAAQ"]);
    expect(t.f.statements.some((s) => s.params?.includes("merged_by_gate"))).toBe(false);
    expect(t.reconcile).not.toHaveBeenCalled();
  });
});

describe("readPublicPull", () => {
  it("reads the order's pull request by the branch OUR push record names, through the code repository's client, and answers its state", async () => {
    const t = ops();
    const getPullRequest = vi.fn(async () => ({ state: "closed", merged: true, headSha: PUB }));
    mocks.createReviewGitHubPort.mockReturnValue({ getPullRequest });
    expect(await t.o.readPublicPull({ accountId: ACCOUNT, order })).toEqual({ open: false, merged: true, headSha: PUB });
    expect(t.open).toHaveBeenCalledWith("merge_gate", { repoId: REPO, owner: "acme", name: "widgets-public", allowGraphql: true });
    const [, portCtx, ids] = mocks.createReviewGitHubPort.mock.calls[0]!;
    expect(portCtx).toMatchObject({ owner: "acme", name: "widgets-public" });
    expect(ids).toMatchObject({ prNumber: 12, recordedBranch: `fx/p-${PUSH}` });
    expect(getPullRequest).toHaveBeenCalledWith({ repoId: REPO, prNumber: 12 });
  });

  it("an open pull request is open; a push record that is gone, or an item that cannot be read, is a throw (GitHub was not asked), never a state", async () => {
    const t = ops();
    mocks.createReviewGitHubPort.mockReturnValue({ getPullRequest: async () => ({ state: "open", merged: false, headSha: PUB }) });
    expect(await t.o.readPublicPull({ accountId: ACCOUNT, order })).toEqual({ open: true, merged: false, headSha: PUB });
    const gone = createPlaneMergeOps({ open: (async () => ({ request: vi.fn() })) as never, withPool: (fn) => fn(fakePool(null).pool) });
    await expect(gone.readPublicPull({ accountId: ACCOUNT, order })).rejects.toThrow(/push record/);
    mocks.loadReviewContext.mockResolvedValue({ ok: false, reason: "x" });
    await expect(t.o.readPublicPull({ accountId: ACCOUNT, order })).rejects.toThrow();
  });
});

describe("recordMerged: the fact, the reconcile and the private copy", () => {
  const privateOpen = (over: Partial<{ state: string; merged: boolean; headSha: string }> = {}) => mocks.createReviewGitHubPort.mockReturnValue({ getPullRequest: vi.fn(async () => ({ state: "open", merged: false, headSha: SRC, ...over })) });

  it("records merged_by_gate for the cleared head, reconciles the item, and closes the private copy that is the run's recorded one, open, at the reviewed head", async () => {
    const t = ops();
    privateOpen();
    expect(await t.o.recordMerged({ accountId: ACCOUNT, order })).toEqual({ privateCopy: "closed" });
    const event = t.f.statements.find((s) => /work_item_driver_events/.test(s.sql));
    expect(event?.params).toEqual(expect.arrayContaining([ITEM, "merged_by_gate", SRC, 7, `merged:${PUB}`]));
    expect(t.reconcile).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACCOUNT, workItemId: ITEM }));
    expect(t.closePrivate).toHaveBeenCalledWith({ id: REPO, owner: "acme", name: "widgets" }, 7);
  });

  it.each([
    ["already closed", { state: "closed" }],
    ["merged", { state: "closed", merged: true }],
    ["moved to another head", { headSha: "e".repeat(40) }],
  ])("a private copy that is %s is left alone", async (_label, over) => {
    const t = ops();
    privateOpen(over);
    expect(await t.o.recordMerged({ accountId: ACCOUNT, order })).toEqual({ privateCopy: "left" });
    expect(t.closePrivate).not.toHaveBeenCalled();
  });

  it("no recorded pull request, or no close port: the copy is left, and the fact is still recorded", async () => {
    const none = ops();
    mocks.readItemRecordedPullRequest.mockResolvedValue(null);
    expect(await none.o.recordMerged({ accountId: ACCOUNT, order })).toEqual({ privateCopy: "left" });
    expect(none.f.statements.some((s) => /work_item_driver_events/.test(s.sql))).toBe(true);
    mocks.readItemRecordedPullRequest.mockResolvedValue({ number: 7, branch: "b" });
    privateOpen();
    expect(await ops({ closePrivate: null }).o.recordMerged({ accountId: ACCOUNT, order })).toEqual({ privateCopy: "left" });
  });

  it("a close that fails is 'failed' with a fixed log line (no error text), and a reconcile that fails changes nothing else", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = ops({ closePrivate: vi.fn(async () => Promise.reject(new Error("secret ghs_token in message"))), reconcile: vi.fn(async () => Promise.reject(new Error("also secret"))) });
    privateOpen();
    expect(await t.o.recordMerged({ accountId: ACCOUNT, order })).toEqual({ privateCopy: "failed" });
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.length).toBe(2);
    expect(lines.join(" ")).not.toMatch(/secret|ghs_/);
    expect(lines.map((l) => JSON.parse(l).event).sort()).toEqual(["plane_merge.private_copy_close_failed", "plane_merge.reconcile_failed"]);
    warn.mockRestore();
  });
});
