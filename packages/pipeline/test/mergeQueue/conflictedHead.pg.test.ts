import type { PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { endRound, finishWork, recordRoundHead, runQueueTick, startConflictWork, type QueueTickDeps } from "../../src/mergeQueue/index.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { shaOf, startQueueRepo, type QueueItem, type QueueRepo } from "./helpers/queueRepo.js";

/**
 * D#483: a head that a conflict round produced and that conflicted again was never reviewed. If the entry waits on it and the conflict then clears, the tick must not refresh it
 * or number it from there (a refresh row would carry across the unread head); it goes back to review unless a reviewer already passed that very head. Real Postgres, strict
 * GitHub fake over TLS.
 */
const DIR = "packages/db/migrations";
const mig = (...keys: number[]) => keys.map((k) => `${DIR}/${String(k).padStart(4, "0")}_m.sql`);
const added = (...paths: string[]) => paths.map((filename) => ({ filename, status: "added" }));
const ROUND_FROM = "a".repeat(40);

let repos: QueueRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.map((r) => r.close()));
  repos = [];
});

describe("D#483 an entry waiting on a head that conflicted again [pg]", () => {
  const db = pgHarness();
  const tenant = <T>(r: QueueRepo, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, r.accountId, fn);
  let deltaStarts = 0;
  let renumbers = 0;
  const start = async () => {
    deltaStarts = 0;
    renumbers = 0;
    const r = await startQueueRepo(db, { onDeltaReview: async () => (deltaStarts++, { started: false as const, reason: "worker_unavailable" as const }) });
    repos.push(r);
    return r;
  };
  /** The entry's stored head is the result of a round 1 that ended `conflicted_again`; `passed` keeps the reviewer passes the test world records on the head. */
  const conflictedAgain = async (r: QueueRepo, a: QueueItem, passed = false) => {
    if (!passed) await db.admin.query("DELETE FROM agent_runs WHERE account_id = $1 AND work_item_id = $2", [r.accountId, a.workItemId]);
    await tenant(r, async (c) => {
      const s = await startConflictWork(c, { accountId: r.accountId, entryId: a.entryId, fromSha: ROUND_FROM, baseSha: shaOf(a.pr, "tip"), baseRef: "main", conflictFiles: ["src/a.ts"] });
      if (!s.ok) throw new Error(s.reason);
      await recordRoundHead(c, { accountId: r.accountId, roundId: s.round.id, toSha: a.head });
      await endRound(c, { accountId: r.accountId, roundId: s.round.id, outcome: "conflicted_again" });
      await finishWork(c, { accountId: r.accountId, entryId: a.entryId, headSha: a.head });
    });
  };
  const rounds = async (r: QueueRepo) => Number((await db.admin.query("SELECT count(*)::int AS n FROM merge_conflict_rounds WHERE account_id = $1", [r.accountId])).rows[0].n);
  const withRenumber = (r: QueueRepo, over: Partial<QueueTickDeps> = {}) => r.deps({ ordered: true, onRenumber: async () => (renumbers++, true), ...over });

  it("behind the default branch with overlapping files: back to review, no refresh, no delta review, no merge", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: { behindBy: 1, files: [{ filename: "src/a.ts" }], mainFiles: [{ filename: "src/a.ts" }] } });
    await conflictedAgain(r, a);
    const out = await runQueueTick(r.deps(), r);
    expect(out.steps[0]).toMatchObject({ step: "released", why: "head_unreviewed" });
    expect(await r.entry(7)).toMatchObject({ state: "in_review", slotHolder: null, headSha: a.head });
    expect(a.g.world.updates).toEqual([]);
    expect(a.g.world.merges).toEqual([]);
    expect(deltaStarts).toBe(0);
    expect(await db.admin.query("SELECT 1 FROM head_refreshes WHERE account_id = $1", [r.accountId]).then((q) => q.rowCount)).toBe(0);
  });

  it("disjoint files and an ordered-resource failure: back to review, no renumber round", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: { behindBy: 1, pullFiles: added(...mig(710)) } });
    r.setTip(7, shaOf(7, "tip"), mig(709, 711, 712));
    // The refresh is a clean merge of the head and the tip: its tree is the tip's.
    a.g.world.trees[a.fresh] = a.g.world.trees[shaOf(7, "tip")]!;
    await conflictedAgain(r, a);
    const before = await rounds(r);
    const out = await runQueueTick(withRenumber(r), r);
    expect(out.steps[0]).toMatchObject({ step: "released", why: "head_unreviewed" });
    expect(await r.entry(7)).toMatchObject({ state: "in_review" });
    expect([renumbers, await rounds(r) - before, a.g.world.updates.length, a.g.world.merges.length]).toEqual([0, 0, 0, 0]);
  });

  it("a head that a full review later passed is legitimately queued with that same round row: it proceeds as before", async () => {
    const r = await start();
    const a = await r.addItem(7);
    await conflictedAgain(r, a, true);
    expect((await runQueueTick(r.deps(), r)).steps.map((s) => s.step)).toEqual(["merged", "idle"]);
    expect(a.g.world.merges).toEqual([{ sha: a.head, method: "squash" }]);
    // The same with an ordered-resource failure: the pass lets the normal path (here a renumber round) take it.
    const r2 = await start();
    const b = await r2.addItem(7, { world: { pullFiles: added(...mig(710)) } });
    r2.setTip(7, shaOf(7, "tip"), mig(709, 711, 712));
    await conflictedAgain(r2, b, true);
    expect((await runQueueTick(withRenumber(r2), r2)).steps[0]).toMatchObject({ why: "ordered_resource_renumbering" });
    expect(renumbers).toBe(1);
  });

  it("the evidence read fails: back to review, nothing is refreshed", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: { behindBy: 1, files: [{ filename: "src/a.ts" }], mainFiles: [{ filename: "src/a.ts" }] } });
    await conflictedAgain(r, a, true);
    const base = r.deps();
    const failing: QueueTickDeps = {
      ...base,
      inTenant: (id, fn) =>
        base.inTenant(id, (c) =>
          fn(
            new Proxy(c, {
              get: (t, p) => (p === "query" ? (sql: unknown, ...rest: unknown[]) => (/FROM agent_runs/.test(String(sql)) ? Promise.reject(new Error("evidence read failed")) : (t.query as (...a: unknown[]) => unknown)(sql, ...rest)) : Reflect.get(t, p)),
            }),
          ),
        ),
    };
    const out = await runQueueTick(failing, r);
    expect(out.steps[0]).toMatchObject({ step: "released", why: "head_unreviewed" });
    expect(await r.entry(7)).toMatchObject({ state: "in_review" });
    expect([a.g.world.updates.length, a.g.world.merges.length, deltaStarts]).toEqual([0, 0, 0]);
  });
});
