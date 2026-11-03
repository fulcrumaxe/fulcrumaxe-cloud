import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { runMergeGate, type MergeGateDeps, type MergeGateInput } from "../../src/build/mergeGate.js";
import { acquireMergeLease, hasLiveMergeLease, lockRepoMerge, releaseMergeLease } from "../../src/mergeQueue/mergeLease.js";
import { MERGE_QUEUE_LEASE_SECONDS } from "../../src/mergeQueue/policy.js";
import { enqueueEntry, takeSlot } from "../../src/mergeQueue/store.js";
import type { PrFacts } from "../../src/mergeQueue/types.js";
import { FakeGitHub, greenCi, type FakePullRequest } from "./helpers/fakeGitHub.js";
import { seedAccount, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#483 S5-j2a1 (C34 D6, D11, D13): the per-repository merge lease against real Postgres and the real `pg_advisory_xact_lock`, through a plain `app_user` pool (row security in force).
 * A direct merge and a queue slot exclude each other on one repository, atomically; a lapsed lease is overwritten; every exit of the gate frees it.
 */
vi.mock("@fx/core/src/pendingWork.js", () => ({ markWorkPending: vi.fn(async () => undefined) }));

const HEAD = "a".repeat(40);
const T0 = new Date("2026-11-03T10:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const open: PrFacts = { open: true, draft: false };

describe("D#483 S5-j2a1 merge lease [pg]", () => {
  const db = pgHarness();
  const tenant = <T>(accountId: string, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, accountId, fn);

  async function world() {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    return { accountId, repoId };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** A queued entry for a fresh work item of the repository. */
  async function queued(w: World, prNumber: number) {
    const workItemId = randomUUID();
    await seedWorkItem(db.admin, w.accountId, workItemId, w.repoId, { ghNumber: prNumber });
    const { entry } = await tenant(w.accountId, (c) => enqueueEntry(c, { accountId: w.accountId, repoId: w.repoId, workItemId, prNumber, headSha: HEAD, dependsOnPrNumber: null, approvedAt: T0 }));
    return entry;
  }
  const take = (w: World, entryId: string, now?: Date) =>
    tenant(w.accountId, (c) => takeSlot(c, { accountId: w.accountId, repoId: w.repoId, holder: `tick:${randomUUID()}`, facts: new Map([[entryId, open]]), ...(now ? { now } : {}) }));
  const leaseRows = async (w: World) => (await db.admin.query<{ holder: string; kind: string }>(`SELECT holder, kind FROM repo_merge_leases WHERE account_id = $1 AND repo_id = $2`, [w.accountId, w.repoId])).rows;

  it("two takers racing for one repository: exactly one wins, the others are told it is busy", async () => {
    const w = await world();
    const takes = await Promise.all(Array.from({ length: 8 }, () => acquireMergeLease(db.pureAppUserPool, w)));
    expect(takes.filter((t) => t.taken)).toHaveLength(1);
    expect(await leaseRows(w)).toHaveLength(1);
  });

  it("the lease is per repository: another repository of the same account takes its own", async () => {
    const w = await world();
    const other = randomUUID();
    await seedRepo(db.admin, w.accountId, other);
    expect((await acquireMergeLease(db.pureAppUserPool, w)).taken).toBe(true);
    expect((await acquireMergeLease(db.pureAppUserPool, { accountId: w.accountId, repoId: other })).taken).toBe(true);
  });

  it("a gate and an in-flight queue entry exclude each other, both ways", async () => {
    // The tick does not take a slot under a live lease; once the lease is freed it does.
    const a = await world();
    const entryA = await queued(a, 11);
    const lease = await acquireMergeLease(db.pureAppUserPool, a);
    expect(lease.taken).toBe(true);
    expect(await take(a, entryA.id)).toMatchObject({ taken: null, skipped: "slot_busy" });
    if (lease.taken) await lease.release();
    expect((await take(a, entryA.id)).taken?.id).toBe(entryA.id);

    // The gate does not take a lease under an in-flight entry; once the entry's slot lapses it does.
    const b = await world();
    const entryB = await queued(b, 12);
    expect((await take(b, entryB.id, T0)).taken?.id).toBe(entryB.id);
    expect(await acquireMergeLease(db.pureAppUserPool, { ...b, now: at(30) })).toEqual({ taken: false });
    expect(await leaseRows(b)).toEqual([]);
    // A tick that died leaves an entry whose slot lease has lapsed. It is no holder: the gate reclaims it by the queue's own rule (the entry goes back to queued) and takes the lease.
    const lapsed = at(MERGE_QUEUE_LEASE_SECONDS + 1);
    expect((await acquireMergeLease(db.pureAppUserPool, { ...b, now: lapsed })).taken).toBe(true);
    expect((await db.admin.query(`SELECT state FROM merge_queue_entries WHERE id = $1`, [entryB.id])).rows).toEqual([{ state: "queued" }]);
  });

  it("the lock is real: while another transaction holds the repository's advisory lock, takeSlot and acquireMergeLease wait for it, and both go on when it commits", async () => {
    const w = await world();
    const entry = await queued(w, 51);
    const other = await world();
    const holder = await db.pureAppUserPool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT set_config('app.account_id', $1, true)", [w.accountId]);
      await lockRepoMerge(holder, w.accountId, w.repoId);
      const waiting = async () => Number((await db.admin.query(`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)).rows[0].n);
      const before = await waiting();
      let done = 0;
      const slot = take(w, entry.id).then((r) => (done++, r));
      const lease = acquireMergeLease(db.pureAppUserPool, w).then((r) => (done++, r));
      // A repository that is not locked is not held up by it.
      expect((await acquireMergeLease(db.pureAppUserPool, other)).taken).toBe(true);
      await expect.poll(waiting).toBe(before + 2);
      expect(done).toBe(0);
      await holder.query("COMMIT");
      const [s, l] = await Promise.all([slot, lease]);
      expect(done).toBe(2);
      expect([s.taken !== null, l.taken]).not.toEqual([true, true]);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  });

  it("freeing a lease wakes the merge-queue sweep when an entry is queued behind it, and only then", async () => {
    const mark = vi.mocked(markWorkPending);
    const idle = await world();
    const a = await acquireMergeLease(db.pureAppUserPool, idle);
    mark.mockClear();
    if (a.taken) await a.release();
    expect(mark).not.toHaveBeenCalled();

    const busy = await world();
    await queued(busy, 61);
    const b = await acquireMergeLease(db.pureAppUserPool, busy);
    mark.mockClear();
    if (b.taken) await b.release();
    expect(mark).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledWith("merge-queue-sweep");
    // A release that frees nothing (the lease was already overwritten) wakes nothing.
    mark.mockClear();
    await releaseMergeLease(db.pureAppUserPool, { ...busy, holder: "not-the-holder" });
    expect(mark).not.toHaveBeenCalled();
  });

  it("a lapsed lease is dead: the next taker overwrites it, and the old holder's release leaves the new lease alone", async () => {
    const w = await world();
    const first = await acquireMergeLease(db.pureAppUserPool, { ...w, now: T0, leaseSeconds: 60 });
    expect(first.taken).toBe(true);
    expect(await acquireMergeLease(db.pureAppUserPool, { ...w, now: at(30) })).toEqual({ taken: false });
    const second = await acquireMergeLease(db.pureAppUserPool, { ...w, now: at(61), kind: "order" });
    expect(second.taken).toBe(true);
    expect(await leaseRows(w)).toEqual([{ holder: second.taken ? second.holder : "", kind: "order" }]);
    if (first.taken) await first.release();
    expect(await leaseRows(w)).toHaveLength(1);
    // The tick also reads a lapsed lease as dead.
    expect(await tenant(w.accountId, (c) => hasLiveMergeLease(c, { ...w, now: at(61) }))).toBe(true);
    expect(await tenant(w.accountId, (c) => hasLiveMergeLease(c, { ...w, now: at(61 + 601) }))).toBe(false);
  });

  it("a gate and a tick racing for a fresh repository: exactly one of them gets it, every time", async () => {
    for (let i = 0; i < 20; i++) {
      const w = await world();
      const entry = await queued(w, 20 + i);
      const [lease, slot] = await Promise.all([acquireMergeLease(db.pureAppUserPool, w), take(w, entry.id)]);
      expect([lease.taken, slot.taken !== null]).not.toEqual([true, true]);
      expect([lease.taken, slot.taken !== null]).not.toEqual([false, false]);
    }
  });

  it("only the named holder frees a lease; a release for a lease that is gone changes nothing", async () => {
    const w = await world();
    const lease = await acquireMergeLease(db.pureAppUserPool, w);
    await releaseMergeLease(db.pureAppUserPool, { ...w, holder: "someone-else" });
    expect(await leaseRows(w)).toHaveLength(1);
    if (lease.taken) await lease.release();
    expect(await leaseRows(w)).toEqual([]);
    await releaseMergeLease(db.pureAppUserPool, { ...w, holder: "gone" });
  });

  it("a tenant reads and writes only its own leases (row-level security)", async () => {
    const a = await world();
    const b = await world();
    expect((await acquireMergeLease(db.pureAppUserPool, a)).taken).toBe(true);
    expect(await tenant(b.accountId, async (c) => (await c.query(`SELECT 1 FROM repo_merge_leases`)).rowCount)).toBe(0);
    await expect(tenant(b.accountId, (c) => c.query(`INSERT INTO repo_merge_leases (account_id, repo_id, holder, kind, lease_until) VALUES ($1, $2, 'x', 'direct', now())`, [a.accountId, a.repoId]))).rejects.toMatchObject({ code: "42501" });
    expect(await tenant(b.accountId, async (c) => (await c.query(`DELETE FROM repo_merge_leases WHERE account_id = $1`, [a.accountId])).rowCount)).toBe(0);
    expect(await tenant(b.accountId, async (c) => (await c.query(`UPDATE repo_merge_leases SET lease_until = now() WHERE account_id = $1`, [a.accountId])).rowCount)).toBe(0);
    expect(await leaseRows(a)).toHaveLength(1);
  });

  describe("through the gate", () => {
    const prOf = (over: Partial<FakePullRequest> = {}): FakePullRequest => ({ headSha: HEAD, state: "open", merged: false, draft: false, body: "", labels: [], comments: [], ...over });

    async function gateWorld() {
      const w = await world();
      const workItemId = randomUUID();
      await db.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance, gh_number) VALUES ($1, $2, $3, 'feature', 'running', 'internal', 7)`, [workItemId, w.accountId, w.repoId]);
      for (const role of ["code-reviewer", "acceptance-tester"]) {
        await db.admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, $3, 'production', 'succeeded', '{"verdict":"pass"}'::jsonb, $4)`, [w.accountId, workItemId, role, HEAD]);
      }
      return { ...w, workItemId };
    }
    const gateDeps = (w: World, github: FakeGitHub, over: Partial<MergeGateDeps> = {}): MergeGateDeps => ({
      pool: db.runWriterPool,
      github,
      isAutoMergeAllowed: async () => true,
      requestReviews: async () => undefined,
      acquireMergeLease: async () => {
        const lease = await acquireMergeLease(db.pureAppUserPool, w);
        return lease.taken ? lease : null;
      },
      ...over,
    });
    const inputOf = (w: World & { workItemId: string }, over: Partial<MergeGateInput> = {}): MergeGateInput => ({
      accountId: w.accountId,
      workItemId: w.workItemId,
      pr: { repoId: w.repoId, prNumber: 7 },
      tier: "small",
      securityDiffTriggerFired: false,
      debaterEnabled: false,
      ...over,
    });
    const fake = (pr: FakePullRequest = prOf(), over: Partial<ConstructorParameters<typeof FakeGitHub>[0]> = {}) => new FakeGitHub({ pr, ciBySha: { [HEAD]: greenCi(HEAD) }, ...over });

    it("a second gate on the repository while one runs answers merge_repo_busy, reads nothing and merges nothing; it goes through once the first is done", async () => {
      const w = await gateWorld();
      let release!: () => void;
      const hold = new Promise<void>((resolve) => (release = resolve));
      const first = fake();
      const read = first.getPullRequest.bind(first);
      first.getPullRequest = async (ref) => (await hold, read(ref));
      const running = runMergeGate(gateDeps(w, first), inputOf(w));
      // The first has the lease before it reads (it is parked on its first read).
      await expect.poll(async () => (await leaseRows(w)).length).toBe(1);

      const second = fake();
      expect(await runMergeGate(gateDeps(w, second), inputOf(w))).toEqual({ outcome: "ready_human_merges", headSha: "", reasons: ["merge_repo_busy"] });
      expect(second.mergeCalls).toEqual([]);
      expect(second.humanMarks).toEqual([]);
      expect(second.ciQueries).toEqual([]);

      release();
      expect(await running).toEqual({ outcome: "merged", headSha: HEAD });
      expect(await leaseRows(w)).toEqual([]);
      expect(await runMergeGate(gateDeps(w, fake()), inputOf(w))).toMatchObject({ outcome: "merged" });
    });

    it("an in-flight queue entry makes the gate wait: no read, no merge", async () => {
      const w = await gateWorld();
      const entry = await queued(w, 31);
      expect((await take(w, entry.id)).taken?.id).toBe(entry.id);
      const github = fake();
      expect(await runMergeGate(gateDeps(w, github), inputOf(w))).toMatchObject({ outcome: "ready_human_merges", reasons: ["merge_repo_busy"] });
      expect(github.mergeCalls).toEqual([]);
    });

    it.each([
      ["merged", () => fake(), {}, "merged"],
      ["stopped (a draft)", () => fake(prOf({ draft: true })), {}, "ready_human_merges"],
      ["head moved (the caller's head is not the pull request's)", () => fake(), { expectedHeadSha: "b".repeat(40) }, "head_moved"],
      ["the pull request is closed", () => fake(prOf({ state: "closed" })), {}, "pr_not_open"],
      ["enqueued in GitHub's queue", () => fake(prOf(), { queueMode: "queue" as const }), {}, "merge_enqueued"],
      [
        "delegated to a runner",
        () => {
          const g = fake();
          g.mergePullRequest = async () => ({ merged: false, delegated: true });
          return g;
        },
        {},
        "merge_delegated",
      ],
    ] as const)("the lease is free again after the gate exits: %s", async (_name, make, over, outcome) => {
      const w = await gateWorld();
      const github = make();
      expect((await runMergeGate(gateDeps(w, github), inputOf(w, over as Partial<MergeGateInput>))).outcome).toBe(outcome);
      expect(await leaseRows(w)).toEqual([]);
    });

    it("the lease is free again when the gate throws", async () => {
      const w = await gateWorld();
      const github = fake();
      github.getCiSnapshot = async () => {
        throw new Error("ci read failed");
      };
      await expect(runMergeGate(gateDeps(w, github), inputOf(w))).rejects.toThrow("ci read failed");
      expect(await leaseRows(w)).toEqual([]);
    });

    it("a gate that dies holding the lease blocks the repository no longer than the lease", async () => {
      const w = await world();
      expect((await acquireMergeLease(db.pureAppUserPool, { ...w, now: T0, leaseSeconds: 600 })).taken).toBe(true);
      // Nothing frees it (the holder is gone). No job runs; the next taker after lease_until overwrites it.
      expect((await acquireMergeLease(db.pureAppUserPool, { ...w, now: at(599) })).taken).toBe(false);
      expect((await acquireMergeLease(db.pureAppUserPool, { ...w, now: at(601) })).taken).toBe(true);
    });

    it("a plan write-back merge under the queue slot and a direct item on the same repository exclude each other", async () => {
      // The write-back merge runs under the queue's slot (an in-flight entry); a direct gate cannot take the repository while it holds it.
      const w = await world();
      const entry = await queued(w, 41);
      expect((await take(w, entry.id)).taken).not.toBeNull();
      expect(await acquireMergeLease(db.pureAppUserPool, w)).toEqual({ taken: false });
    });
  });
});
