import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { seedAccount as seedFullAccount } from "@fx/db/test/helpers/seed.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { claimWithinHeadroom, enqueueForCapacity, markStarted, readCapacityState, requeueRefused } from "../src/advance/capacityQueue.js";
import { readCapacityPlace, readCapacityWait } from "../src/advance/capacityWait.js";
import {
  CAPACITY_RUN_LIST_LINE,
  CAPACITY_SKIP_SENTENCES,
  capacityEstimateMinutes,
  capacityWaitSentence,
} from "../src/advance/capacitySentences.js";
import { RESERVATION_PAUSE_WINDOW_SECONDS } from "../src/advance/reservationPauses.js";

/**
 * [pg] D#483 S5-k3b-2a (migration 0943): the still-asking rule, the place and median reads, the re-queue after a refused start, and the sentence table. On a real
 * Postgres as the real roles: tenant sessions (a plain app_user pool) for the place read, the run-writer login for claim and re-queue. Nothing here starts a run.
 * Not faked faithfully: the provider's own timing; the Team Lead checks that live on staging.
 */
const h = pgHarness();

interface Acct { accountId: string; repoId: string; items: string[] }
async function account(items = 1): Promise<Acct> {
  const accountId = randomUUID();
  const refs = await seedFullAccount(h.admin, accountId);
  await h.admin.query(`UPDATE agent_runs SET status = 'succeeded' WHERE account_id = $1`, [accountId]);
  const ids = [refs.workItemId];
  for (let i = 1; i < items; i++) {
    const id = randomUUID();
    await h.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`, [id, accountId, refs.repoId]);
    ids.push(id);
  }
  return { accountId, repoId: refs.repoId, items: ids };
}
async function asks(a: Acct, item: string, code = "waiting_for_capacity", kind = "stage_waiting"): Promise<void> {
  await h.admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, ${kind === "stage_waiting" ? "stage, " : ""}dedupe_key) VALUES ($1, $2, $3, $4, ${kind === "stage_waiting" ? "'build', " : ""}$5)`, [a.accountId, item, kind, code, randomUUID()]);
}
const enqueue = async (a: Acct, item: string) => {
  await asks(a, item);
  return enqueueForCapacity(h.runWriterPool, a.accountId, { repoId: a.repoId, workItemId: item, runKind: "build" });
};
const rows = async (where = "true") => (await h.admin.query(`SELECT * FROM capacity_queue WHERE ${where} ORDER BY enqueued_at, id`)).rows;
async function totalWithRoom(room: number): Promise<() => number> {
  const { slotsInUse } = await readCapacityState(h.runWriterPool, () => 0);
  return () => slotsInUse + room;
}
async function liveRun(a: Acct, item: string, status = "running"): Promise<string> {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode) VALUES ($1, $2, $3, 'executor', 'production', $4, 'sandbox')`, [id, a.accountId, item, status]);
  return id;
}
const place = (a: Acct, item: string) => readCapacityPlace(h.pureAppUserPool, a.accountId, item);
const state = async () => Number((await h.admin.query(`SELECT o_waiting FROM capacity_queue_state('hosted_sandbox')`)).rows[0].o_waiting);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function asRole<T>(role: string, fn: (q: (sql: string, p?: unknown[]) => Promise<{ rows: any[] }>) => Promise<T>, settings: Record<string, string> = {}): Promise<T> {
  const c = await h.adminPool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL ROLE ${role}`);
    for (const [k, v] of Object.entries(settings)) await c.query(`SELECT set_config($1, $2, true)`, [k, v]);
    return await fn((sql, p) => c.query(sql, p));
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}
const refused = async (p: Promise<unknown>) => p.then(() => "ok", (e: { message: string }) => e.message);

beforeEach(async () => {
  await h.admin.query(`DELETE FROM capacity_queue`);
});

describe("C23-1: an entry counts only while its item is asking [pg]", () => {
  const breakers: Array<[string, (a: Acct, item: string) => Promise<void>]> = [
    ["another code is the latest waiting fact", async (a, i) => asks(a, i, "account_budget_reached")],
    ["the latest waiting fact is older than the window", async (a, i) => void (await h.admin.query(`UPDATE work_item_driver_events SET created_at = now() - interval '46 minutes' WHERE account_id = $1 AND work_item_id = $2`, [a.accountId, i]))],
    ["the item is halted", async (_a, i) => void (await h.admin.query(`UPDATE work_items SET halted_at = now(), halt_action_id = $2 WHERE id = $1`, [i, randomUUID()]))],
    ["the item merged", async (_a, i) => void (await h.admin.query(`UPDATE work_items SET stage = 'merged' WHERE id = $1`, [i]))],
    ["the item closed without a cancel", async (_a, i) => void (await h.admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [i]))],
    ["the item closed unmerged", async (_a, i) => void (await h.admin.query(`UPDATE work_items SET stage = 'closed_unmerged' WHERE id = $1`, [i]))],
  ];
  it.each(breakers)("%s: not claimed, not counted in place or the waiting count, not ended; claimed again in its original order when it asks again", async (_name, breakIt) => {
    const a = await account(2);
    const [first, second] = a.items as [string, string];
    await enqueue(a, first);
    await enqueue(a, second);
    expect(await state()).toBe(2);
    await breakIt(a, first);
    expect(await state()).toBe(1);
    expect(await place(a, first)).toMatchObject({ o_place: null, o_skip: "not_waiting" });
    // it holds no place and does not hold the head of the line: the second goes first, and sees itself at place 1
    expect(await place(a, second)).toMatchObject({ o_place: 1, o_skip: null });
    const claimed = (await claimWithinHeadroom(h.runWriterPool, await totalWithRoom(5))).claimed;
    expect(claimed.map((c) => c.workItemId)).toEqual([second]);
    expect(await rows(`work_item_id = '${first}' AND ended_at IS NULL AND started_run_id IS NULL AND claimed_at IS NULL`)).toHaveLength(1);
    // back to asking (and back in the stage, unhalted): claimable with its original enqueued_at, ahead of a later entry
    await h.admin.query(`UPDATE work_items SET stage = 'triaged', halted_at = NULL, halt_action_id = NULL WHERE id = $1`, [first]);
    await asks(a, first);
    expect(await state()).toBe(2);
    expect((await claimWithinHeadroom(h.runWriterPool, await totalWithRoom(5))).claimed.map((c) => c.workItemId)).toEqual([first]);
  });

  it("a build_waiting fact (written before S5-k1b) counts the same way, and a later fact of another code wins over an earlier capacity one", async () => {
    const a = await account(2);
    await asks(a, a.items[0]!, "waiting_for_capacity", "build_waiting");
    await enqueueForCapacity(h.runWriterPool, a.accountId, { repoId: a.repoId, workItemId: a.items[0]!, runKind: "build" });
    expect(await state()).toBe(1);
    await asks(a, a.items[0]!, "slot_wait", "build_waiting");
    expect(await state()).toBe(0);
  });

  it("the window in the SQL is the pipeline's reservation pause window", async () => {
    expect(RESERVATION_PAUSE_WINDOW_SECONDS).toBe(2700);
    const { rows: r } = await h.admin.query(`SELECT pg_get_functiondef('capacity_entry_asking(uuid,uuid,uuid)'::regprocedure) AS def`);
    expect(r[0].def).toContain(`make_interval(secs => ${RESERVATION_PAUSE_WINDOW_SECONDS})`);
  });

  it("an account that is not active, or a repository that lost its installation, is not counted either", async () => {
    const [a, b] = [await account(), await account()];
    await enqueue(a, a.items[0]!);
    await enqueue(b, b.items[0]!);
    expect(await state()).toBe(2);
    await h.admin.query(`UPDATE repos SET installation_id = NULL WHERE id = $1`, [a.repoId]);
    await h.admin.query(`UPDATE accounts SET deleted_at = now() WHERE id = $1`, [b.accountId]);
    expect(await state()).toBe(0);
    expect(await rows()).toHaveLength(2);
  });
});

describe("capacity_queue_place: place in the claim's own order [pg]", () => {
  it("S5k3b-7: the place of every entry is the order the claim then takes them, across accounts and inside one", async () => {
    const [a, b, c] = [await account(3), await account(2), await account(1)];
    await liveRun(a, a.items[0]!); // A already holds one slot, so it goes after B and C
    // enqueued interleaved so that neither the account order nor the item order is the answer
    const order: Array<[Acct, string]> = [[a, a.items[0]!], [b, b.items[0]!], [a, a.items[1]!], [c, c.items[0]!], [b, b.items[1]!], [a, a.items[2]!]];
    for (const [acct, item] of order) await enqueue(acct, item);
    const owner = new Map(order.map(([acct, item]) => [item, acct]));
    const places = new Map<string, number>();
    for (const [acct, item] of order) places.set(item, Number((await place(acct, item))!.o_place));
    expect([...places.values()].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6]);
    const claimedOrder: string[] = [];
    for (let i = 0; i < 6; i++) {
      const got = (await claimWithinHeadroom(h.runWriterPool, await totalWithRoom(50), { limit: 1 })).claimed;
      expect(got).toHaveLength(1);
      claimedOrder.push(got[0]!.workItemId);
    }
    claimedOrder.forEach((item, i) => expect(places.get(item), `claim ${i + 1}`).toBe(i + 1));
    // inside an account the first in is first out
    for (const acct of [a, b]) {
      const mine = claimedOrder.filter((i) => owner.get(i) === acct);
      expect(mine).toEqual(order.filter(([x]) => x === acct).map(([, i]) => i).filter((i) => mine.includes(i)));
    }
  });

  it("an entry that holds an unexpired claim reads place 1; an entry whose lease ran out is back in the line", async () => {
    const a = await account(2);
    for (const i of a.items) await enqueue(a, i);
    const e = (await claimWithinHeadroom(h.runWriterPool, await totalWithRoom(1))).claimed[0]!;
    expect(await place(a, e.workItemId)).toMatchObject({ o_place: 1 });
    expect(await place(a, a.items[1]!)).toMatchObject({ o_place: 1 });
    await h.admin.query(`UPDATE capacity_queue SET claim_expires_at = now() - interval '1 second' WHERE id = $1`, [e.id]);
    expect(await place(a, e.workItemId)).toMatchObject({ o_place: 1 });
    expect(await place(a, a.items[1]!)).toMatchObject({ o_place: 2 });
  });

  it("closing a waiting item moves the places behind it up by one on the next read", async () => {
    const a = await account(3);
    for (const i of a.items) await enqueue(a, i);
    expect((await place(a, a.items[2]!))!.o_place).toBe(3);
    const c = await h.adminPool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.account_id', $1, true)`, [a.accountId]);
      await c.query(`SET LOCAL ROLE app_user`);
      await c.query(`SELECT capacity_end_cancelled($1)`, [a.items[0]]);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    expect(await place(a, a.items[0]!)).toBeNull();
    expect((await place(a, a.items[2]!))!.o_place).toBe(2);
  });

  it("tenant scoping: another account's item reads nothing, a session with no account is refused, a started or ended entry reads nothing", async () => {
    const [a, b] = [await account(), await account()];
    await enqueue(a, a.items[0]!);
    expect(await readCapacityPlace(h.pureAppUserPool, b.accountId, a.items[0]!)).toBeNull();
    expect(await place(a, a.items[0]!)).not.toBeNull();
    expect(await refused(asRole("app_user", (q) => q(`SELECT * FROM capacity_queue_place($1)`, [a.items[0]])))).toMatch(/no app.account_id/);
    // the row the other account reads is empty even from inside its own session by raw SQL
    const raw = await asRole("app_user", (q) => q(`SELECT * FROM capacity_queue_place($1)`, [a.items[0]]), { "app.account_id": b.accountId });
    expect(raw.rows).toHaveLength(0);
    const e = (await claimWithinHeadroom(h.runWriterPool, await totalWithRoom(1))).claimed[0]!;
    await markStarted(h.runWriterPool, e, await liveRun(a, e.workItemId));
    expect(await place(a, a.items[0]!)).toBeNull();
  });

  it("a repository that lost its installation reads the skip reason 'repo_not_connected', an account that is not active 'account_not_active'", async () => {
    const [a, b] = [await account(), await account()];
    await enqueue(a, a.items[0]!);
    await enqueue(b, b.items[0]!);
    const installation = (await h.admin.query(`SELECT installation_id FROM repos WHERE id = $1`, [a.repoId])).rows[0].installation_id;
    await h.admin.query(`UPDATE repos SET installation_id = NULL WHERE id = $1`, [a.repoId]);
    await h.admin.query(`UPDATE accounts SET stripe_customer_id = NULL, status = 'unsubscribed' WHERE id = $1`, [b.accountId]);
    expect(await place(a, a.items[0]!)).toMatchObject({ o_place: null, o_skip: "repo_not_connected" });
    expect(await place(b, b.items[0]!)).toMatchObject({ o_place: null, o_skip: "account_not_active" });
    expect((await readCapacityWait(h.pureAppUserPool, a.accountId, a.items[0]!))?.sentence).toBe("Waiting: this repo is no longer connected");
    expect(await readCapacityWait(h.pureAppUserPool, b.accountId, b.items[0]!)).toBeNull();
    // reconnected: it starts again, in place
    await h.admin.query(`UPDATE repos SET installation_id = $2 WHERE id = $1`, [a.repoId, installation]);
    expect((await readCapacityWait(h.pureAppUserPool, a.accountId, a.items[0]!))?.sentence).toMatch(/^Waiting for room on our servers\. You are number 1 in line\./);
  });
});

describe("capacity_queue_place: recent starts and the median wait [pg]", () => {
  /** n started entries of the class, wait i minutes each, claimed i minutes after a base that moves one hour per entry (so claim order is i order). */
  async function seedStarts(n: number, refusedSpend: number[] = []): Promise<void> {
    const a = await account();
    for (let i = 1; i <= n; i++) {
      const run = await liveRun(a, a.items[0]!, refusedSpend.includes(i) ? "refused_spend" : "succeeded");
      await h.admin.query(
        `INSERT INTO capacity_queue (account_id, repo_id, work_item_id, run_kind, class, enqueued_at, claimed_at, claim_expires_at, started_run_id)
         VALUES ($1, $2, $3, 'build', 'hosted_sandbox', now() - interval '100 hours' + make_interval(hours => $4), now() - interval '100 hours' + make_interval(hours => $4, mins => $4), now(), $5)`,
        [a.accountId, a.repoId, a.items[0], i, run],
      );
    }
  }
  const stats = async (a: Acct) => (await place(a, a.items[0]!))!;

  it("50-starts rule: with 55 starts only the newest 50 count, and the median is of those waits", async () => {
    await seedStarts(55);
    const w = await account();
    await enqueue(w, w.items[0]!);
    const r = await stats(w);
    expect(Number(r.o_recent_starts)).toBe(50);
    // waits 6..55 minutes: median 30.5 minutes; all 55 would give 28
    expect(r.o_median_wait_seconds).toBe(1830);
  });

  it("starts whose run was refused for spend are not counted, and the 50 are taken from those that remain", async () => {
    await seedStarts(55, [51, 52, 53, 54, 55]);
    const w = await account();
    await enqueue(w, w.items[0]!);
    const r = await stats(w);
    expect(Number(r.o_recent_starts)).toBe(50);
    expect(r.o_median_wait_seconds).toBe(1530); // waits 1..50 minutes
  });

  it("fewer than 10 starts: the count is given and the sentence has no estimate; 10 starts add it", async () => {
    await seedStarts(9);
    const w = await account();
    await enqueue(w, w.items[0]!);
    expect(Number((await stats(w)).o_recent_starts)).toBe(9);
    expect((await readCapacityWait(h.pureAppUserPool, w.accountId, w.items[0]!))?.sentence).toBe("Waiting for room on our servers. You are number 1 in line.");
    await h.admin.query(`DELETE FROM capacity_queue`);
    await seedStarts(10);
    const w2 = await account();
    await enqueue(w2, w2.items[0]!);
    // waits 1..10 minutes, median 5.5 minutes, rounded up to the next 5
    expect((await readCapacityWait(h.pureAppUserPool, w2.accountId, w2.items[0]!))?.sentence).toBe("Waiting for room on our servers. You are number 1 in line. Usually under 10 minutes.");
  });

  it("a start that never waited is not a queue start: no statistics from direct starts, and no row gives no sentence", async () => {
    const w = await account();
    await enqueue(w, w.items[0]!);
    const r = await stats(w);
    expect([Number(r.o_recent_starts), r.o_median_wait_seconds]).toEqual([0, null]);
    expect((await readCapacityWait(h.pureAppUserPool, w.accountId, w.items[0]!))?.sentence).not.toMatch(/Usually/);
    const none = await account();
    expect(await readCapacityWait(h.pureAppUserPool, none.accountId, none.items[0]!)).toBeNull();
  });
});

describe("C23-2: capacity_requeue_refused [pg]", () => {
  async function startedCancelled(): Promise<{ a: Acct; entryId: string; runId: string; enqueuedAt: Date }> {
    const a = await account();
    await enqueue(a, a.items[0]!);
    const e = (await claimWithinHeadroom(h.runWriterPool, await totalWithRoom(1))).claimed[0]!;
    const runId = await liveRun(a, a.items[0]!, "cancelled");
    expect(await markStarted(h.runWriterPool, e, runId)).toBe(true);
    return { a, entryId: e.id, runId, enqueuedAt: (await rows(`id = '${e.id}'`))[0].enqueued_at };
  }
  const requeue = (id: string, run: string, status = 429, code: string | null = "rate_limited") => h.runWriterPool.query(`SELECT capacity_requeue_refused($1, $2, $3, $4) AS ok`, [id, run, status, code]).then((r) => r.rows[0].ok as boolean);

  it("keeps the entry id and enqueued_at, bumps the attempt by one, clears the claim and records 429 and the code", async () => {
    const { a, entryId, runId, enqueuedAt } = await startedCancelled();
    expect(await requeueRefused(h.runWriterPool, entryId, runId, { status: 429, code: "rate_limited" })).toBe(true);
    const [row] = await rows(`id = '${entryId}'`);
    expect(row).toMatchObject({ attempt: 2, started_run_id: null, claimed_at: null, claim_expires_at: null, refused_status: 429, refused_code: "rate_limited", ended_at: null });
    expect(row.enqueued_at).toEqual(enqueuedAt);
    expect(await rows(`work_item_id = '${a.items[0]}'`)).toHaveLength(1);
    // it is a waiting entry again, claimable again (the item still asks)
    expect((await claimWithinHeadroom(h.runWriterPool, await totalWithRoom(1))).claimed.map((c) => [c.id, c.attempt])).toEqual([[entryId, 2]]);
  });

  it("a refusal without a code records none", async () => {
    const { entryId, runId } = await startedCancelled();
    expect(await requeueRefused(h.runWriterPool, entryId, runId, { status: 429 })).toBe(true);
    expect((await rows(`id = '${entryId}'`))[0]).toMatchObject({ refused_status: 429, refused_code: null });
  });

  it("refuses a run that is not the entry's, a run that is not cancelled, a status that is not 429, and an ended entry; nothing changes", async () => {
    const { a, entryId, runId } = await startedCancelled();
    const before = await rows(`id = '${entryId}'`);
    expect(await requeue(entryId, await liveRun(a, a.items[0]!, "cancelled"))).toBe(false);
    expect(await requeue(entryId, randomUUID())).toBe(false);
    expect(await requeue(entryId, runId, 500, null)).toBe(false);
    await h.admin.query(`UPDATE agent_runs SET status = 'failed' WHERE id = $1`, [runId]);
    expect(await requeue(entryId, runId)).toBe(false);
    expect(await rows(`id = '${entryId}'`)).toEqual(before);
    // an entry that was never started has no run to match
    const b = await account();
    await enqueue(b, b.items[0]!);
    expect(await requeue((await rows(`account_id = '${b.accountId}'`))[0].id, runId)).toBe(false);
  });

  it("when the item already holds another open entry nothing changes and the answer is false", async () => {
    const { a, entryId, runId } = await startedCancelled();
    await asks(a, a.items[0]!);
    await enqueueForCapacity(h.runWriterPool, a.accountId, { repoId: a.repoId, workItemId: a.items[0]!, runKind: "build" });
    const before = await rows(`id = '${entryId}'`);
    expect(await requeue(entryId, runId)).toBe(false);
    expect(await rows(`id = '${entryId}'`)).toEqual(before);
    expect(await rows(`work_item_id = '${a.items[0]}' AND started_run_id IS NULL AND ended_at IS NULL`)).toHaveLength(1);
  });

  it("a code that is not a short identifier is refused by the CHECK, and the entry stays as it was", async () => {
    const { entryId, runId } = await startedCancelled();
    expect(await refused(requeue(entryId, runId, 429, "not a code!"))).toMatch(/capacity_queue_refused_code_check/);
    expect((await rows(`id = '${entryId}'`))[0]).toMatchObject({ attempt: 1, started_run_id: runId });
  });

  it("only the run-writer login may call it: app_user, platform_ops and PUBLIC fail on privileges", async () => {
    const { entryId, runId } = await startedCancelled();
    for (const role of ["app_user", "platform_ops"]) {
      expect(await refused(asRole(role, (q) => q(`SELECT capacity_requeue_refused($1, $2, 429, NULL)`, [entryId, runId]))), role).toMatch(/permission denied/);
    }
  });
});

describe("the 0943 grants [pg]", () => {
  it("S5k3b-4 for the new functions: none of them deletes, the asking rule is reachable by no login, and the place read is for tenant sessions only", async () => {
    const { rows: fns } = await h.admin.query(`SELECT proname, prosrc FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('capacity_entry_asking', 'capacity_queue_place', 'capacity_requeue_refused', 'capacity_claim_next', 'capacity_queue_state')`);
    expect(fns).toHaveLength(5);
    for (const f of fns) expect(f.prosrc, f.proname).not.toMatch(/\b(DELETE|TRUNCATE)\b/i);
    for (const role of ["app_user", "agent_run_writer", "platform_ops", "ops_console"]) {
      expect(await refused(asRole(role, (q) => q(`SELECT capacity_entry_asking($1, $2, $3)`, [randomUUID(), randomUUID(), randomUUID()]))), role).toMatch(/permission denied/);
    }
    expect(await refused(asRole("agent_run_writer", (q) => q(`SELECT * FROM capacity_queue_place($1)`, [randomUUID()]), { "app.account_id": randomUUID() }))).toMatch(/permission denied/);
    const { rows: d } = await h.admin.query(`SELECT has_table_privilege('capacity_queue_definer', 'public.work_items', 'DELETE') AS a, has_table_privilege('capacity_queue_definer', 'public.work_item_driver_events', 'DELETE') AS b`);
    expect(d[0]).toEqual({ a: false, b: false });
  });

  it("the definer reads exactly the columns the rule needs on work_items and work_item_driver_events, and writes neither table", async () => {
    const { rows: cols } = await h.admin.query(
      `SELECT c.relname || '.' || t.attname || ' ' || a.privilege_type AS g
         FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a
        WHERE a.grantee = 'capacity_queue_definer'::regrole AND c.relname IN ('work_items', 'work_item_driver_events') ORDER BY 1`,
    );
    expect(cols.map((r) => r.g)).toEqual([
      "work_item_driver_events.account_id SELECT",
      "work_item_driver_events.code SELECT",
      "work_item_driver_events.created_at SELECT",
      "work_item_driver_events.kind SELECT",
      "work_item_driver_events.seq SELECT",
      "work_item_driver_events.work_item_id SELECT",
      "work_items.account_id SELECT",
      "work_items.halted_at SELECT",
      "work_items.id SELECT",
      "work_items.stage SELECT",
    ]);
    const { rows: t } = await h.admin.query(`SELECT count(*)::int AS n FROM pg_class c, aclexplode(c.relacl) a WHERE a.grantee = 'capacity_queue_definer'::regrole AND c.relname IN ('work_items', 'work_item_driver_events')`);
    expect(t[0].n).toBe(0);
  });

  it("the signatures and the owner of the two replaced functions are unchanged", async () => {
    const { rows: r } = await h.admin.query(
      `SELECT p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner, p.prosecdef FROM pg_proc p WHERE p.proname IN ('capacity_claim_next', 'capacity_queue_state') ORDER BY 1`,
    );
    expect(r).toEqual([
      { sig: "capacity_claim_next(text,integer)", owner: "capacity_queue_definer", prosecdef: true },
      { sig: "capacity_queue_state(text)", owner: "capacity_queue_definer", prosecdef: true },
    ]);
  });
});

describe("the sentence table", () => {
  it("S5k3b-7: the sentence has the place, and the estimate only with 10 or more recent starts", () => {
    expect(capacityWaitSentence({ place: 3, recentStarts: 9, medianWaitSeconds: 60 })).toBe("Waiting for room on our servers. You are number 3 in line.");
    expect(capacityWaitSentence({ place: 3, recentStarts: 10, medianWaitSeconds: 60 })).toBe("Waiting for room on our servers. You are number 3 in line. Usually under 5 minutes.");
  });
  it("the estimate is the median rounded up to the next 5 minutes and never below 5", () => {
    expect([0, 1, 299, 300, 301, 600, 601, 1830].map(capacityEstimateMinutes)).toEqual([5, 5, 5, 5, 10, 10, 15, 35]);
  });
  it("it never shows null, undefined or NaN: a bad place gives no sentence, a bad figure gives no estimate", () => {
    for (const bad of [null, undefined, Number.NaN, 0, -1, 1.5, "2", Infinity]) expect(capacityWaitSentence({ place: bad, recentStarts: 50, medianWaitSeconds: 60 })).toBeNull();
    for (const bad of [null, undefined, Number.NaN, -5, Infinity, "300"]) {
      const s = capacityWaitSentence({ place: 2, recentStarts: 50, medianWaitSeconds: bad });
      expect(s).toBe("Waiting for room on our servers. You are number 2 in line.");
    }
    expect(capacityWaitSentence({ place: 2, recentStarts: Number.NaN, medianWaitSeconds: 60 })).not.toMatch(/Usually/);
    for (const s of [capacityWaitSentence({ place: 2, recentStarts: 50, medianWaitSeconds: 600 }), CAPACITY_SKIP_SENTENCES.repo_not_connected, CAPACITY_RUN_LIST_LINE]) expect(s).not.toMatch(/null|undefined|NaN/);
  });
  it("the fixed lines are the approved wording", () => {
    expect(CAPACITY_SKIP_SENTENCES.repo_not_connected).toBe("Waiting: this repo is no longer connected");
    expect(CAPACITY_RUN_LIST_LINE).toBe("Ended before it started: our servers were full. The item is waiting for room.");
  });
});
