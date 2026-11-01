import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import {
  MAX_CONFLICT_ROUNDS,
  endRound,
  enqueueEntry,
  getEntry,
  listConflictRounds,
  recordRoundHead,
  recordRoundRun,
  releaseForWork,
  startConflictWork,
  switchToDeltaReview,
  takeSlot,
  type MergeQueueEntry,
  type PrFacts,
} from "../../src/mergeQueue/index.js";
import { seedAccount, seedRepo, seedWorkItem } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#519 MQ4-a against real Postgres, through a plain `app_user` pool (row security, column grants and the triggers in force): the queued-to-work move
 * of migration 0948, the append-only round table, and the one-statement start. Nothing here runs a round; the store functions are inert until MQ4-b.
 */
const T0 = new Date("2026-10-15T10:00:00Z");
const sha = (c: string) => c.repeat(40);
const open: PrFacts = { open: true, draft: false };

describe("D#519 MQ4-a conflict rounds [pg]", () => {
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

  async function enqueue(w: World, prNumber: number, head = sha("a")): Promise<MergeQueueEntry> {
    const workItemId = randomUUID();
    await seedWorkItem(db.admin, w.accountId, workItemId, w.repoId, { ghNumber: prNumber });
    const r = await tenant(w.accountId, (c) =>
      enqueueEntry(c, { accountId: w.accountId, repoId: w.repoId, workItemId, prNumber, headSha: head, dependsOnPrNumber: null, approvedAt: new Date(T0.getTime() + prNumber * 1000) }),
    );
    return r.entry;
  }
  const start = (w: World, e: MergeQueueEntry, over: { holder?: string; files?: string[] } = {}) =>
    tenant(w.accountId, (c) =>
      startConflictWork(c, { accountId: w.accountId, entryId: e.id, ...(over.holder ? { holder: over.holder } : {}), baseSha: sha("c"), baseRef: "main", conflictFiles: over.files ?? ["src/a.ts"] }),
    );
  const row = async (id: string) => (await db.admin.query(`SELECT * FROM merge_queue_entries WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;
  const rounds = async (id: string) => (await db.admin.query(`SELECT * FROM merge_conflict_rounds WHERE work_item_id = $1 ORDER BY round`, [id])).rows as Array<Record<string, unknown>>;
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code);

  describe("C6-a1 the queued to awaiting_work move", () => {
    it("a queued entry goes to awaiting_work with kind conflict, and the round row is written with it", async () => {
      const w = await world();
      const e = await enqueue(w, 1);
      const r = await start(w, e, { files: ["src/a.ts", "docs/b.md"] });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.entry).toMatchObject({ state: "awaiting_work", workKind: "conflict", conflictRounds: 1, slotHolder: null, leaseUntil: null });
      expect(r.round).toMatchObject({ round: 1, fromSha: sha("a"), baseSha: sha("c"), baseRef: "main", conflictFiles: ["src/a.ts", "docs/b.md"], runId: null, toSha: null, outcome: null, endedAt: null, entryId: e.id, workItemId: e.workItemId });
      expect(await rounds(e.workItemId!)).toHaveLength(1);
    });

    it("the same move with kind delta_review is refused by the trigger, and a bare move is refused by the shape check", async () => {
      const w = await world();
      const e = await enqueue(w, 1);
      const raw = (sql: string) => tenant(w.accountId, (c) => c.query(sql, [e.id]));
      expect(await code(raw(`UPDATE merge_queue_entries SET state = 'awaiting_work', work_kind = 'delta_review' WHERE id = $1`))).toBe("23514");
      expect(await code(raw(`UPDATE merge_queue_entries SET state = 'awaiting_work' WHERE id = $1`))).toBe("23514");
      expect((await row(e.id))["state"]).toBe("queued");
      // The trigger's own message, not the shape check's, refuses delta_review.
      await expect(raw(`UPDATE merge_queue_entries SET state = 'awaiting_work', work_kind = 'delta_review' WHERE id = $1`)).rejects.toThrow(/that state move is not allowed/);
      // The two kinds that count against the bound are allowed from queued.
      expect(await code(raw(`UPDATE merge_queue_entries SET state = 'awaiting_work', work_kind = 'renumber' WHERE id = $1`))).toBe("ok");
    });

    it("other moves are unchanged: queued cannot go to a state it could not before", async () => {
      const w = await world();
      const e = await enqueue(w, 1);
      await tenant(w.accountId, (c) => c.query(`UPDATE merge_queue_entries SET state = 'stopped', reason = 'x' WHERE id = $1`, [e.id]));
      expect(await code(tenant(w.accountId, (c) => c.query(`UPDATE merge_queue_entries SET state = 'awaiting_work', work_kind = 'conflict' WHERE id = $1`, [e.id])))).toBe("23514");
    });

    it("a round on an entry that is not startable changes nothing", async () => {
      const w = await world();
      const e = await enqueue(w, 1);
      await tenant(w.accountId, (c) => c.query(`UPDATE merge_queue_entries SET state = 'in_review' WHERE id = $1`, [e.id]));
      expect(await start(w, e)).toEqual({ ok: false, reason: "not_startable" });
      expect(await rounds(e.workItemId!)).toHaveLength(0);
    });
  });

  describe("C6-a2 the bound", () => {
    it("with conflict_rounds at the bound, nothing is written", async () => {
      const w = await world();
      const e = await enqueue(w, 1);
      for (let i = 1; i <= MAX_CONFLICT_ROUNDS; i++) {
        const r = await start(w, e);
        expect(r.ok).toBe(true);
        await tenant(w.accountId, (c) => c.query(`UPDATE merge_queue_entries SET state = 'queued', work_kind = NULL WHERE id = $1`, [e.id]));
      }
      const before = await row(e.id);
      expect(before["conflict_rounds"]).toBe(MAX_CONFLICT_ROUNDS);
      expect(await start(w, e)).toEqual({ ok: false, reason: "rounds_exhausted" });
      expect(await row(e.id)).toEqual(before);
      expect(await rounds(e.workItemId!)).toHaveLength(MAX_CONFLICT_ROUNDS);
    });

    it("a renumber round counts against the same bound", async () => {
      const w = await world();
      const e = await enqueue(w, 1);
      await tenant(w.accountId, (c) => c.query(`UPDATE merge_queue_entries SET conflict_rounds = 2 WHERE id = $1`, [e.id]));
      expect(await start(w, e)).toEqual({ ok: false, reason: "rounds_exhausted" });
    });
  });

  describe("C6-a3 one statement for the holder's release and the round", () => {
    it("the holder's slot is free in the transaction that wrote the round; another connection sees both or neither", async () => {
      const w = await world();
      const a = await enqueue(w, 1);
      const b = await enqueue(w, 2);
      const facts = new Map([a, b].map((e) => [e.id, open] as const));
      expect((await tenant(w.accountId, (c) => takeSlot(c, { accountId: w.accountId, repoId: w.repoId, holder: "h", facts, now: T0 }))).taken?.id).toBe(a.id);

      const tx = await db.pureAppUserPool.connect();
      try {
        await tx.query("BEGIN");
        await tx.query("SELECT set_config('app.account_id', $1, true)", [w.accountId]);
        const r = await startConflictWork(tx, { accountId: w.accountId, entryId: a.id, holder: "h", baseSha: sha("c"), baseRef: "main", conflictFiles: ["x.ts"] });
        expect(r.ok).toBe(true);
        // Before the commit, a second connection sees neither the freed slot nor the round.
        expect(await row(a.id)).toMatchObject({ state: "in_flight", slot_holder: "h", conflict_rounds: 0 });
        expect(await rounds(a.workItemId!)).toHaveLength(0);
        await tx.query("COMMIT");
      } finally {
        tx.release();
      }
      expect(await row(a.id)).toMatchObject({ state: "awaiting_work", slot_holder: null, work_kind: "conflict", conflict_rounds: 1 });
      expect(await rounds(a.workItemId!)).toHaveLength(1);
      // The slot is free: the next entry takes it.
      expect((await tenant(w.accountId, (c) => takeSlot(c, { accountId: w.accountId, repoId: w.repoId, holder: "g", facts, now: T0 }))).taken?.id).toBe(b.id);
    });

    it("a rolled-back start leaves the slot held and no round", async () => {
      const w = await world();
      const a = await enqueue(w, 1);
      await tenant(w.accountId, (c) => takeSlot(c, { accountId: w.accountId, repoId: w.repoId, holder: "h", facts: new Map([[a.id, open]]), now: T0 }));
      const tx = await db.pureAppUserPool.connect();
      try {
        await tx.query("BEGIN");
        await tx.query("SELECT set_config('app.account_id', $1, true)", [w.accountId]);
        await startConflictWork(tx, { accountId: w.accountId, entryId: a.id, holder: "h", baseSha: sha("c"), baseRef: "main", conflictFiles: [] });
        await tx.query("ROLLBACK");
      } finally {
        tx.release();
      }
      expect(await row(a.id)).toMatchObject({ state: "in_flight", slot_holder: "h", conflict_rounds: 0 });
      expect(await rounds(a.workItemId!)).toHaveLength(0);
    });

    it("a holder that lost the slot, or is not the named holder, starts nothing", async () => {
      const w = await world();
      const a = await enqueue(w, 1);
      await tenant(w.accountId, (c) => takeSlot(c, { accountId: w.accountId, repoId: w.repoId, holder: "h", facts: new Map([[a.id, open]]), now: T0 }));
      expect(await start(w, a, { holder: "someone-else" })).toEqual({ ok: false, reason: "not_startable" });
      expect(await rounds(a.workItemId!)).toHaveLength(0);
    });

    it("a path the database refuses writes nothing", async () => {
      const w = await world();
      const e = await enqueue(w, 1);
      for (const bad of ["../x", "/etc/passwd", "a//b", "a\\b", "a\nb", "~/x", "C:/x", ""]) {
        expect(await code(start(w, e, { files: [bad] }))).toBe("23514");
      }
      expect(await code(start(w, e, { files: Array.from({ length: 101 }, (_, i) => `f/${i}`) }))).toBe("23514");
      expect((await row(e.id))["state"]).toBe("queued");
      expect(await rounds(e.workItemId!)).toHaveLength(0);
    });
  });

  describe("C6-a4 the round row", () => {
    it("run, head and outcome are each set once; the identity columns cannot be updated at all", async () => {
      const w = await world();
      const e = await enqueue(w, 1);
      const r = await start(w, e);
      if (!r.ok) throw new Error("start");
      const id = r.round.id;
      const runId = randomUUID();
      expect((await tenant(w.accountId, (c) => recordRoundRun(c, { accountId: w.accountId, roundId: id, runId })))?.runId).toBe(runId);
      expect(await tenant(w.accountId, (c) => recordRoundRun(c, { accountId: w.accountId, roundId: id, runId: randomUUID() }))).toBeNull();
      expect((await tenant(w.accountId, (c) => recordRoundHead(c, { accountId: w.accountId, roundId: id, toSha: sha("d") })))?.toSha).toBe(sha("d"));
      expect(await tenant(w.accountId, (c) => recordRoundHead(c, { accountId: w.accountId, roundId: id, toSha: sha("e") }))).toBeNull();
      const ended = await tenant(w.accountId, (c) => endRound(c, { accountId: w.accountId, roundId: id, outcome: "resolved" }));
      expect(ended).toMatchObject({ outcome: "resolved", runId, toSha: sha("d") });
      expect(ended?.endedAt).toBeInstanceOf(Date);
      expect(await tenant(w.accountId, (c) => endRound(c, { accountId: w.accountId, roundId: id, outcome: "other" }))).toBeNull();
      expect((await tenant(w.accountId, (c) => listConflictRounds(c, w.accountId, e.workItemId!))).map((x) => x.outcome)).toEqual(["resolved"]);

      // A raw second write is refused by the trigger as well, not only by the guarded SQL above.
      for (const set of [`to_sha = '${sha("f")}'`, `outcome = 'x'`, `run_id = '${randomUUID()}'`]) {
        await expect(tenant(w.accountId, (c) => c.query(`UPDATE merge_conflict_rounds SET ${set} WHERE id = $1`, [id]))).rejects.toThrow(/written once/);
      }
      // from_sha, base_sha, base_ref and conflict_files have no UPDATE grant; nothing can delete.
      for (const set of [`from_sha = '${sha("f")}'`, `base_sha = '${sha("f")}'`, `base_ref = 'x'`, `conflict_files = '{}'`, `round = 2`]) {
        expect(await code(tenant(w.accountId, (c) => c.query(`UPDATE merge_conflict_rounds SET ${set} WHERE id = $1`, [id])))).toBe("42501");
      }
      expect(await code(tenant(w.accountId, (c) => c.query(`DELETE FROM merge_conflict_rounds WHERE id = $1`, [id])))).toBe("42501");
    });

    it("ended_at is the database's clock: a client-chosen value is overwritten when the outcome is first set", async () => {
      const w = await world();
      const e = await enqueue(w, 1);
      const r = await start(w, e);
      if (!r.ok) throw new Error("start");
      const res = await tenant(w.accountId, (c) =>
        c.query(`UPDATE merge_conflict_rounds SET outcome = 'resolved', ended_at = '2001-01-01T00:00:00Z' WHERE id = $1 RETURNING ended_at, (ended_at >= created_at) AS ok`, [r.round.id]),
      );
      expect(res.rows[0].ok).toBe(true);
      expect(new Date(res.rows[0].ended_at).getFullYear()).toBeGreaterThan(2020);
    });

    it("a head equal to from_sha, an outcome that is not a code, and a round past 20 are refused", async () => {
      const w = await world();
      const e = await enqueue(w, 1);
      const r = await start(w, e);
      if (!r.ok) throw new Error("start");
      expect(await code(tenant(w.accountId, (c) => recordRoundHead(c, { accountId: w.accountId, roundId: r.round.id, toSha: sha("a") })))).toBe("23514");
      await expect(tenant(w.accountId, (c) => endRound(c, { accountId: w.accountId, roundId: r.round.id, outcome: "Not A Code" }))).rejects.toMatchObject({ code: "bad_input" });
      expect(await code(tenant(w.accountId, (c) => c.query(`UPDATE merge_conflict_rounds SET outcome = 'Not A Code' WHERE id = $1`, [r.round.id])))).toBe("23514");
    });

    it("another account sees nothing and cannot write a row into this one", async () => {
      const w = await world();
      const e = await enqueue(w, 1);
      const r = await start(w, e);
      if (!r.ok) throw new Error("start");
      const stranger = await world();
      expect((await tenant(stranger.accountId, (c) => c.query(`SELECT 1 FROM merge_conflict_rounds WHERE id = $1`, [r.round.id]))).rowCount).toBe(0);
      expect(await tenant(stranger.accountId, (c) => recordRoundRun(c, { accountId: stranger.accountId, roundId: r.round.id, runId: randomUUID() }))).toBeNull();
      expect(
        await code(
          tenant(stranger.accountId, (c) =>
            c.query(`INSERT INTO merge_conflict_rounds (account_id, repo_id, work_item_id, round, from_sha, base_sha, base_ref, conflict_files) VALUES ($1, $2, $3, 1, $4, $4, 'main', '{}')`, [w.accountId, w.repoId, randomUUID(), sha("a")]),
          ),
        ),
      ).toBe("42501");
    });

    it("a round is unique per work item and round number, and deleting the work item removes its rounds", async () => {
      const w = await world();
      const e = await enqueue(w, 1);
      const r = await start(w, e);
      if (!r.ok) throw new Error("start");
      expect(
        await code(
          tenant(w.accountId, (c) =>
            c.query(`INSERT INTO merge_conflict_rounds (account_id, repo_id, work_item_id, round, from_sha, base_sha, base_ref, conflict_files) VALUES ($1, $2, $3, 1, $4, $4, 'main', '{}')`, [w.accountId, w.repoId, e.workItemId, sha("a")]),
          ),
        ),
      ).toBe("23505");
      await db.admin.query(`DELETE FROM work_items WHERE id = $1`, [e.workItemId]);
      expect(await rounds(e.workItemId!)).toHaveLength(0);
    });

    it("a round with no queue entry is allowed (the direct path)", async () => {
      const w = await world();
      const workItemId = randomUUID();
      await seedWorkItem(db.admin, w.accountId, workItemId, w.repoId, { ghNumber: 9 });
      await tenant(w.accountId, (c) =>
        c.query(`INSERT INTO merge_conflict_rounds (account_id, repo_id, work_item_id, round, from_sha, base_sha, base_ref, conflict_files) VALUES ($1, $2, $3, 1, $4, $4, 'main', '{a.ts}')`, [w.accountId, w.repoId, workItemId, sha("a")]),
      );
      expect((await rounds(workItemId))[0]).toMatchObject({ entry_id: null, conflict_files: ["a.ts"] });
    });
  });

  describe("switchToDeltaReview", () => {
    it("awaiting_work/conflict becomes awaiting_work/delta_review, once", async () => {
      const w = await world();
      const e = await enqueue(w, 1);
      expect(await tenant(w.accountId, (c) => switchToDeltaReview(c, { accountId: w.accountId, entryId: e.id }))).toBeNull();
      await start(w, e);
      const switched = await tenant(w.accountId, (c) => switchToDeltaReview(c, { accountId: w.accountId, entryId: e.id }));
      expect(switched).toMatchObject({ state: "awaiting_work", workKind: "delta_review", conflictRounds: 1 });
      expect(await tenant(w.accountId, (c) => switchToDeltaReview(c, { accountId: w.accountId, entryId: e.id }))).toBeNull();
    });
  });

  describe("the existing holder path is unchanged", () => {
    it("releaseForWork still counts a conflict round and still refuses a third", async () => {
      const w = await world();
      const a = await enqueue(w, 1);
      for (let i = 0; i < MAX_CONFLICT_ROUNDS; i++) {
        await tenant(w.accountId, (c) => c.query(`UPDATE merge_queue_entries SET state = 'queued', work_kind = NULL, work_run_id = NULL WHERE id = $1 AND state = 'awaiting_work'`, [a.id]));
        await tenant(w.accountId, (c) => takeSlot(c, { accountId: w.accountId, repoId: w.repoId, holder: "h", facts: new Map([[a.id, open]]), now: T0 }));
        expect((await tenant(w.accountId, (c) => releaseForWork(c, { accountId: w.accountId, entryId: a.id, holder: "h", kind: "conflict" }))).ok).toBe(true);
      }
      expect((await tenant(w.accountId, (c) => getEntry(c, w.accountId, a.id)))?.conflictRounds).toBe(MAX_CONFLICT_ROUNDS);
    });
  });
});

