import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loadReviewContext: vi.fn(), attestQueueEntry: vi.fn() }));
vi.mock("@fx/pipeline", async (original) => ({ ...(await original<typeof import("@fx/pipeline")>()), loadReviewContext: mocks.loadReviewContext, attestQueueEntry: mocks.attestQueueEntry }));

import { GATE1_QUEUE_DOCUMENTS } from "@fx/runner-cloud";
import { MERGE_QUEUE_ENTRY_DOCUMENT } from "@fx/github";
import { readQueueEntryWake, wakeGate1QueueEntry } from "../lib/gate1QueueEntry";

/** D#6 CLOUD-POSTS-FX-GATE1 PR 1d: the check_suite wake for a merge-queue entry commit, and how it finds the item and opens the attester's client. */
/** GitHub's branch for PR 12's entry is `gh-readonly-queue/main/pr-12-<BASE>`: the trailing sha is the commit the entry is built on (main's tip, or the
 * entry ahead), not the pull request's head (as this repository's own merge_group runs show). */
const BASE = "2b".repeat(20);
const PR_HEAD = "c3".repeat(20);
const ENTRY = "a2".repeat(20);
const ACCOUNT = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
const ITEM = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const payload = (over: Record<string, unknown> = {}, suite: Record<string, unknown> = {}) => ({
  action: "completed",
  repository: { full_name: "acme/widgets-public" },
  check_suite: { head_sha: ENTRY, head_branch: `gh-readonly-queue/main/pr-12-${BASE}`, conclusion: "failure", app: { id: 15368 }, pull_requests: [], ...suite },
  ...over,
});

describe("readQueueEntryWake", () => {
  it("a completed GitHub Actions suite on a queue branch, whatever its conclusion: base branch, number, the entry's BASE sha (from the name) and the entry commit", () => {
    for (const conclusion of ["success", "failure", "cancelled", null]) {
      expect(readQueueEntryWake("check_suite", payload({}, { conclusion }))).toEqual({ repoFullName: "acme/widgets-public", base: "main", prNumber: 12, baseSha: BASE, entrySha: ENTRY });
    }
    expect(readQueueEntryWake("check_suite", payload({}, { head_branch: `gh-readonly-queue/release-2.x/pr-7-${BASE}` }))).toMatchObject({ base: "release-2.x", prNumber: 7, baseSha: BASE });
    // The wake never names a pull request head: the attester takes it from the queue's own entry.
    expect(readQueueEntryWake("check_suite", payload())).not.toHaveProperty("prHead");
  });

  it("anything else wakes nothing", () => {
    const branches = [`gh-readonly-queue/main/pr-12-${BASE.slice(1)}`, `gh-readonly-queue/main/pr-012-${BASE}`, `gh-readonly-queue/main/pr-12-${BASE.toUpperCase()}`, `gh-readonly-queue/main/pr-12-${BASE}/x`, `x/gh-readonly-queue/main/pr-12-${BASE}`, `gh-readonly-queue/../pr-12-${BASE}`, `gh-readonly-queue/a..b/pr-12-${BASE}`, `fx/issue-12`, "main"];
    for (const head_branch of branches) expect(readQueueEntryWake("check_suite", payload({}, { head_branch })), head_branch).toBeNull();
    for (const app of [{ id: 1 }, { id: "15368" }, null]) expect(readQueueEntryWake("check_suite", payload({}, { app }))).toBeNull();
    for (const head_sha of ["main", ENTRY.slice(2), null]) expect(readQueueEntryWake("check_suite", payload({}, { head_sha }))).toBeNull();
    for (const action of ["requested", "rerequested", undefined]) expect(readQueueEntryWake("check_suite", payload({ action }))).toBeNull();
    expect(readQueueEntryWake("check_run", payload())).toBeNull();
    expect(readQueueEntryWake("check_suite", payload({ repository: { full_name: "not a repo" } }))).toBeNull();
  });
});

function pool(rows: Array<{ work_item_id: string; managed: boolean }>) {
  const statements: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const client = { query: async (sql: string, params?: unknown[]) => (statements.push({ sql, params }), { rows: /FROM plane_pushes/.test(sql) ? rows : [], rowCount: 0 }), release: () => undefined };
  return { pool: { connect: async () => client } as never, statements };
}
const event = (p: unknown = payload()) => ({ accountId: ACCOUNT, eventName: "check_suite", payload: p });
const LISTED = new Set(["acme/widgets-public"]);

describe("wakeGate1QueueEntry", () => {
  beforeEach(() => {
    mocks.loadReviewContext.mockReset().mockResolvedValue({ ok: true, ctx: { repoId: "r1", owner: "acme", name: "widgets", executionMode: "runner_local" } });
    mocks.attestQueueEntry.mockReset().mockResolvedValue({ kind: "wait", reason: "check_running" });
  });

  it("finds the item by OUR push record and asks the attester through the attester's fenced client (A18 goes, the squash call does not)", async () => {
    const p = pool([{ work_item_id: ITEM, managed: false }]);
    const seen: string[] = [];
    const inner = { request: vi.fn(async (r: { method: string; path: string }) => (seen.push(`${r.method} ${r.path}`), { status: 200, body: {} })) };
    const open = vi.fn(async () => inner as never);
    mocks.attestQueueEntry.mockImplementation(async (http: { graphql: (op: string, v: unknown) => Promise<unknown>; request: (r: unknown) => Promise<unknown> }, input: { ourLogin: () => Promise<string> }) => {
      await http.graphql("Gate1QueueEntries", { owner: "acme", name: "widgets-public", branch: "main" });
      await expect(http.request({ method: "PUT", path: "/repos/acme/widgets-public/pulls/12/merge", body: { sha: PR_HEAD, merge_method: "squash" } })).rejects.toThrow(/refused/);
      expect(await input.ourLogin()).toBe("bot-for-r1");
      return { kind: "posted", state: "success" };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      expect(await wakeGate1QueueEntry(p.pool, event(), { open, repos: LISTED, ourLogin: async (id) => `bot-for-${id}` })).toEqual({ kind: "posted", state: "success" });
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
    const q = p.statements.find((s) => /FROM plane_pushes/.test(s.sql))!;
    expect(q.params).toEqual([ACCOUNT, "acme/widgets-public", 12]);
    // Counted before any filter: the person-managed flag is read, never filtered out in SQL.
    expect(q.sql).toMatch(/managed_by_person_at IS NOT NULL\) AS managed/);
    expect(q.sql).not.toMatch(/WHERE[^]*managed_by_person_at IS NULL/);
    expect(open).toHaveBeenCalledWith("merge_gate", expect.objectContaining({ repoId: "r1", owner: "acme", name: "widgets-public", allowGraphql: true }));
    expect(seen).toEqual(["POST /graphql"]);
    expect((inner.request.mock.calls[0]![0] as unknown as { body: { query: string } }).body.query).toBe(GATE1_QUEUE_DOCUMENTS.Gate1QueueEntries);
    expect(mocks.attestQueueEntry.mock.calls[0]![1]).toMatchObject({ repos: LISTED, owner: "acme", name: "widgets-public", base: "main", prNumber: 12, baseSha: BASE, entrySha: ENTRY });
    expect(mocks.attestQueueEntry.mock.calls[0]![1]).not.toHaveProperty("prHead");
    // A runner_local item is never handed the entry document: its fenced client reads A18.
    expect(mocks.attestQueueEntry.mock.calls[0]![1]).not.toHaveProperty("entryDocument");
  });

  it("PR 1e: a hosted (sandbox) item asks the attester through the plain merge_gate client, with the pinned entry document and no allowGraphql", async () => {
    mocks.loadReviewContext.mockResolvedValue({ ok: true, ctx: { repoId: "r1", owner: "acme", name: "widgets", executionMode: "sandbox" } });
    const inner = { request: vi.fn(async () => ({ status: 200, body: [] })) };
    const open = vi.fn(async () => inner as never);
    mocks.attestQueueEntry.mockImplementation(async (http: unknown, input: { ourLogin: () => Promise<string> }) => {
      // The plain installation client as opened: no fence in front of it (so no fixed documents of the fence).
      expect(http).toBe(inner);
      expect(await input.ourLogin()).toBe("bot-for-r1");
      return { kind: "wait", reason: "entry_not_queued" };
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      expect(await wakeGate1QueueEntry(pool([{ work_item_id: ITEM, managed: false }]).pool, event(), { open, repos: LISTED, ourLogin: async (id) => `bot-for-${id}` })).toEqual({ kind: "wait", reason: "entry_not_queued" });
    } finally {
      info.mockRestore();
    }
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("merge_gate", { repoId: "r1", owner: "acme", name: "widgets-public" });
    expect(mocks.attestQueueEntry.mock.calls[0]![1]).toMatchObject({ repos: LISTED, owner: "acme", name: "widgets-public", base: "main", prNumber: 12, baseSha: BASE, entrySha: ENTRY, entryDocument: MERGE_QUEUE_ENTRY_DOCUMENT });
    // The same person-managed rule as runner_local: any person-managed match stops a hosted item too, before anything is loaded or opened.
    mocks.loadReviewContext.mockClear();
    const open2 = vi.fn();
    expect(await wakeGate1QueueEntry(pool([{ work_item_id: ITEM, managed: false }, { work_item_id: ITEM, managed: true }]).pool, event(), { open: open2, repos: LISTED })).toBeNull();
    expect(mocks.loadReviewContext).not.toHaveBeenCalled();
    expect(open2).not.toHaveBeenCalled();
  });

  it("an unlisted repository (or the setting unset) reads nothing of ours; no item, two items or an unloadable one asks nothing", async () => {
    const saved = process.env.FX_GATE1_ATTEST_REPOS;
    delete process.env.FX_GATE1_ATTEST_REPOS;
    try {
      for (const repos of [new Set(["acme/other"]), new Set<string>(), undefined]) {
        const p = pool([{ work_item_id: ITEM, managed: false }]);
        expect(await wakeGate1QueueEntry(p.pool, event(), { open: vi.fn(), ...(repos ? { repos } : {}) })).toBeNull();
        expect(p.statements).toEqual([]);
      }
    } finally {
      if (saved !== undefined) process.env.FX_GATE1_ATTEST_REPOS = saved;
    }
    // No item; two items; and ANY person-managed match (alone, beside one of ours, or the same item's other record): nothing is loaded or asked.
    const managedCases = [
      [],
      [{ work_item_id: ITEM, managed: false }, { work_item_id: "other", managed: false }],
      [{ work_item_id: ITEM, managed: true }],
      [{ work_item_id: ITEM, managed: false }, { work_item_id: "other", managed: true }],
      [{ work_item_id: "other", managed: true }, { work_item_id: ITEM, managed: false }],
      [{ work_item_id: ITEM, managed: false }, { work_item_id: ITEM, managed: true }],
    ];
    for (const rows of managedCases) {
      mocks.loadReviewContext.mockClear();
      const open = vi.fn();
      expect(await wakeGate1QueueEntry(pool(rows).pool, event(), { open, repos: LISTED }), JSON.stringify(rows)).toBeNull();
      expect(mocks.loadReviewContext).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    }
    for (const loaded of [{ ok: false, reason: "not_found" }]) {
      mocks.loadReviewContext.mockResolvedValueOnce(loaded);
      const open = vi.fn();
      expect(await wakeGate1QueueEntry(pool([{ work_item_id: ITEM, managed: false }]).pool, event(), { open, repos: LISTED })).toBeNull();
      expect(open).not.toHaveBeenCalled();
    }
    expect(mocks.attestQueueEntry).not.toHaveBeenCalled();
    expect(await wakeGate1QueueEntry(pool([]).pool, event(payload({}, { head_branch: "main" })), { open: vi.fn(), repos: LISTED })).toBeNull();
  });
});
