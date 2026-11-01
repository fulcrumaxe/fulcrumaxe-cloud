import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { SandboxPortError, createFakeSandbox } from "@fx/runner";
import { seedAccount as seedFullAccount } from "@fx/db/test/helpers/seed.js";
import { pgHarness } from "./helpers/pgHarness.js";
import {
  CAPACITY_SETTINGS_DEFAULTED,
  claimWithinHeadroom,
  classifyCreateFailure,
  crossesAlertDepth,
  enqueueForCapacity,
  markStarted,
  readCapacitySettings,
  readCapacityState,
} from "../src/advance/capacityQueue.js";

/**
 * [pg] D#483 S5-k3b-1 (migration 0941): the capacity queue's store and helper, on a real Postgres as the real roles (the run-writer login for claim, tenant
 * sessions for enqueue and cancel, `SET ROLE` for the refusals). Nothing here starts a run: that wiring is S5-k3b-2. Covers S5k3b-1/2/3/4/5/6/9-store/10/12/13/14's
 * store half. Not faked faithfully: the provider's own timing (the fake throws at once); the Team Lead checks that live on staging.
 */
const h = pgHarness();
const OWNER_ROLE = "ops_owner";

interface Acct { accountId: string; repoId: string; items: string[] }
async function account(items = 1): Promise<Acct> {
  const accountId = randomUUID();
  const refs = await seedFullAccount(h.admin, accountId);
  // The seeded run is a live local run; this suite counts sandbox slots only, and it is settled so no test counts it by accident.
  await h.admin.query(`UPDATE agent_runs SET status = 'succeeded' WHERE account_id = $1`, [accountId]);
  const ids = [refs.workItemId];
  for (let i = 1; i < items; i++) {
    const id = randomUUID();
    await h.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`, [id, accountId, refs.repoId]);
    ids.push(id);
  }
  return { accountId, repoId: refs.repoId, items: ids };
}
/** Since 0943 an entry counts only while its item is asking: the item's latest waiting fact says waiting_for_capacity and is fresh. */
async function asks(a: Acct, item: string, code = "waiting_for_capacity"): Promise<void> {
  await h.admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, stage, dedupe_key) VALUES ($1, $2, 'stage_waiting', $3, 'build', $4)`, [a.accountId, item, code, randomUUID()]);
}
const enqueue = async (a: Acct, item: string, refusal?: { status: number; code?: string }) => {
  await asks(a, item);
  return enqueueForCapacity(h.runWriterPool, a.accountId, { repoId: a.repoId, workItemId: item, runKind: "build", refusal });
};
const rows = async (where = "true") => (await h.admin.query(`SELECT * FROM capacity_queue WHERE ${where} ORDER BY enqueued_at, id`)).rows;
/** A slot total that leaves exactly `room` free right now (other suites' live runs are counted, not assumed away). */
async function totalWithRoom(room: number): Promise<() => number> {
  const { slotsInUse } = await readCapacityState(h.runWriterPool, () => 0);
  return () => slotsInUse + room;
}
async function liveRun(a: Acct, item: string): Promise<string> {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode) VALUES ($1, $2, $3, 'executor', 'production', 'running', 'sandbox')`, [id, a.accountId, item]);
  return id;
}
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
  await h.admin.query(`DELETE FROM capacity_queue_settings`);
});

describe("migration 0941: the queue never drops work [pg]", () => {
  it("S5k3b-1: 50 entries over 5 accounts, slots freed one at a time: every entry starts exactly once, none is ended, waiting equals the count without a run", async () => {
    const accts = await Promise.all([10, 10, 10, 10, 10].map(() => account(10)));
    for (const a of accts) for (const i of a.items) await enqueue(a, i);
    expect(await rows()).toHaveLength(50);
    const started = new Set<string>();
    for (let step = 1; step <= 50; step++) {
      const { claimed } = await claimWithinHeadroom(h.runWriterPool, await totalWithRoom(1));
      expect(claimed).toHaveLength(1);
      const e = claimed[0]!;
      const a = accts.find((x) => x.accountId === e.accountId)!;
      expect(await markStarted(h.runWriterPool, e, await liveRun(a, e.workItemId))).toBe(true);
      started.add(e.id);
      // the slot this run holds stays full for the next step, so the counter is rebuilt each time from the live runs
      await h.admin.query(`UPDATE agent_runs SET status = 'succeeded' WHERE work_item_id = $1`, [e.workItemId]);
      const all = await rows();
      expect(all.filter((r) => r.started_run_id === null && r.ended_at === null)).toHaveLength(50 - step);
      expect(all.every((r) => r.ended_at === null)).toBe(true);
    }
    expect(started.size).toBe(50);
    expect((await claimWithinHeadroom(h.runWriterPool, await totalWithRoom(5))).claimed).toHaveLength(0);
  });

  it("S5k3b-3: with every slot full for three days the entry is still waiting, untouched, and nothing is claimed", async () => {
    const a = await account();
    // enqueued three days ago (an insert may set the clock; no update may move enqueued_at)
    await asks(a, a.items[0]!);
    await h.admin.query(`INSERT INTO capacity_queue (account_id, repo_id, work_item_id, run_kind, class, enqueued_at, created_at) VALUES ($1, $2, $3, 'build', 'hosted_sandbox', now() - interval '3 days', now() - interval '3 days')`, [a.accountId, a.repoId, a.items[0]]);
    const full = await totalWithRoom(0);
    for (let i = 0; i < 3; i++) expect((await claimWithinHeadroom(h.runWriterPool, full)).claimed).toHaveLength(0);
    const [row] = await rows();
    expect(row).toMatchObject({ claimed_at: null, started_run_id: null, ended_at: null, ended_reason: null, attempt: 1 });
  });

  it("S5k3b-2: a claimer that dies between claim and start: the lease expires, the entry is claimed again with the same key, one run, a replay records nothing", async () => {
    const a = await account();
    await enqueue(a, a.items[0]!);
    const total = await totalWithRoom(5);
    const first = (await claimWithinHeadroom(h.runWriterPool, total)).claimed[0]!;
    expect((await claimWithinHeadroom(h.runWriterPool, total)).claimed, "a live lease is not claimable").toHaveLength(0);
    await h.admin.query(`UPDATE capacity_queue SET claim_expires_at = now() - interval '1 second' WHERE id = $1`, [first.id]); // fault injection: the lease ran out
    const second = (await claimWithinHeadroom(h.runWriterPool, total)).claimed[0]!;
    expect(second).toMatchObject({ id: first.id, attempt: 1});
    const run = await liveRun(a, a.items[0]!);
    expect(await markStarted(h.runWriterPool, second, run)).toBe(true);
    expect(await markStarted(h.runWriterPool, second, await liveRun(a, a.items[0]!)), "a replay of the same attempt").toBe(false);
    expect((await rows())[0].started_run_id).toBe(run);
    await h.admin.query(`UPDATE capacity_queue SET claim_expires_at = now() - interval '1 second' WHERE id = $1`, [first.id]);
    expect((await claimWithinHeadroom(h.runWriterPool, total)).claimed, "a started entry is never claimed again").toHaveLength(0);
  });

  it("a run that is not the item's own is refused by mark-started, and a stale attempt cannot record", async () => {
    const [a, b] = [await account(), await account()];
    await enqueue(a, a.items[0]!);
    const e = (await claimWithinHeadroom(h.runWriterPool, await totalWithRoom(5))).claimed[0]!;
    expect(await markStarted(h.runWriterPool, e, await liveRun(b, b.items[0]!))).toBe(false);
    expect(await markStarted(h.runWriterPool, { id: e.id, attempt: 2 }, await liveRun(a, a.items[0]!))).toBe(false);
  });
});

describe("migration 0941: fair order [pg]", () => {
  it("S5k3b-6: 50 entries over 5 accounts enqueued account by account: every five claims reach five accounts, and each account's own order holds", async () => {
    const accts = await Promise.all([10, 10, 10, 10, 10].map(() => account(10)));
    for (const a of accts) for (const i of a.items) await enqueue(a, i); // account A's ten first: global first-in-first-out would drain A before B
    const { claimed } = await claimWithinHeadroom(h.runWriterPool, await totalWithRoom(50), { limit: 50 });
    expect(claimed).toHaveLength(50);
    for (let w = 0; w < 50; w += 5) expect(new Set(claimed.slice(w, w + 5).map((c) => c.accountId)).size, `window at ${w}`).toBe(5);
    for (const a of accts) expect(claimed.filter((c) => c.accountId === a.accountId).map((c) => c.workItemId)).toEqual(a.items);
  });

  it("S5k3b-6: a hundred waiting in A and one in B: B's first start comes within two claims; with equal holdings the older head goes first", async () => {
    const [a, b] = [await account(100), await account(1)];
    for (const i of a.items) await enqueue(a, i);
    await enqueue(b, b.items[0]!);
    const two = (await claimWithinHeadroom(h.runWriterPool, await totalWithRoom(2))).claimed;
    expect(two.map((c) => c.accountId).sort()).toEqual([a.accountId, b.accountId].sort());
    await h.admin.query(`DELETE FROM capacity_queue`);
    const [c, d] = [await account(), await account()];
    await enqueue(c, c.items[0]!);
    await enqueue(d, d.items[0]!);
    expect((await claimWithinHeadroom(h.runWriterPool, await totalWithRoom(1))).claimed[0]!.accountId, "the older head").toBe(c.accountId);
  });

  it("an account already running sandboxes goes after an account running none", async () => {
    const [busy, idle] = [await account(2), await account()];
    await liveRun(busy, busy.items[1]!);
    await enqueue(busy, busy.items[0]!); // enqueued first, so only the holdings can put idle ahead
    await enqueue(idle, idle.items[0]!);
    expect((await claimWithinHeadroom(h.runWriterPool, await totalWithRoom(1))).claimed[0]!.accountId).toBe(idle.accountId);
  });

  it("S5k3b-5: inside one account strict first in, first out, and an entry that comes back keeps its place and bumps its attempt", async () => {
    const a = await account(3);
    for (const i of a.items) await enqueue(a, i);
    const total = await totalWithRoom(10);
    const first = (await claimWithinHeadroom(h.runWriterPool, total, { limit: 1 })).claimed[0]!;
    expect(first.workItemId).toBe(a.items[0]);
    const again = await enqueue(a, a.items[0]!, { status: 429, code: "rate_limited" }); // a refused start puts the same entry back
    expect(again.entry).toMatchObject({ id: first.id, attempt: 2, created: false });
    expect((await rows(`id = '${first.id}'`))[0]).toMatchObject({ claimed_at: null, refused_status: 429, refused_code: "rate_limited" });
    const next = (await claimWithinHeadroom(h.runWriterPool, total)).claimed;
    expect(next.map((c) => c.workItemId)).toEqual([a.items[0], a.items[1], a.items[2]]);
    expect(next[0]).toMatchObject({ id: first.id, attempt: 2});
  });

  it("a second enqueue of a waiting item is no new place", async () => {
    const a = await account();
    const one = await enqueue(a, a.items[0]!);
    const two = await enqueue(a, a.items[0]!);
    expect(two.entry).toMatchObject({ id: one.entry.id, attempt: 1, created: false });
    expect(two.entry.enqueuedAt).toEqual(one.entry.enqueuedAt);
    expect(await rows()).toHaveLength(1);
  });

  it("two claimers at once never take the same entry (FOR UPDATE SKIP LOCKED)", async () => {
    const accts = await Promise.all([1, 1, 1, 1, 1].map(() => account()));
    for (const a of accts) await enqueue(a, a.items[0]!);
    const results = await Promise.all(Array.from({ length: 8 }, () => h.runWriterPool.query(`SELECT o_id FROM capacity_claim_next('hosted_sandbox', 120)`)));
    const ids = results.flatMap((r) => r.rows.map((x) => x.o_id));
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it("a row another session holds locked is skipped, and the claim does not wait for it", async () => {
    const [a, b] = [await account(), await account()];
    await enqueue(a, a.items[0]!);
    await enqueue(b, b.items[0]!);
    const holder = await h.adminPool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM capacity_queue WHERE account_id = $1 FOR UPDATE`, [a.accountId]);
      const claim = h.runWriterPool.query(`SELECT o_account_id FROM capacity_claim_next('hosted_sandbox', 120)`);
      const guard = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("the claim blocked on a locked row")), 4000));
      const got = await Promise.race([claim, guard]);
      expect(got.rows.map((r) => r.o_account_id)).toEqual([b.accountId]);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });
});

describe("migration 0941: skipped, never dropped [pg]", () => {
  it("a repository that lost its installation, or an account that is not active, is skipped and starts again when it is back", async () => {
    const [a, b, c] = [await account(), await account(), await account()];
    for (const x of [a, b, c]) await enqueue(x, x.items[0]!);
    const total = await totalWithRoom(10);
    await h.admin.query(`UPDATE repos SET installation_id = NULL WHERE id = $1`, [a.repoId]);
    await h.admin.query(`UPDATE accounts SET deleted_at = now() WHERE id = $1`, [b.accountId]);
    expect((await claimWithinHeadroom(h.runWriterPool, total)).claimed.map((e) => e.accountId)).toEqual([c.accountId]);
    expect(await rows(`account_id IN ('${a.accountId}', '${b.accountId}')`)).toHaveLength(2);
    await h.admin.query(`UPDATE accounts SET deleted_at = NULL WHERE id = $1`, [b.accountId]);
    expect((await claimWithinHeadroom(h.runWriterPool, total)).claimed.map((e) => e.accountId)).toEqual([b.accountId]);
  });

  it("an account whose status is not active is skipped", async () => {
    const a = await account();
    await enqueue(a, a.items[0]!);
    await h.admin.query(`UPDATE accounts SET stripe_customer_id = NULL, status = 'unsubscribed' WHERE id = $1`, [a.accountId]);
    expect((await claimWithinHeadroom(h.runWriterPool, await totalWithRoom(5))).claimed).toHaveLength(0);
  });

  it("the helper claims no more than there is headroom for, and a plan-data reader that throws stops it before anything is claimed", async () => {
    const a = await account(3);
    for (const i of a.items) await enqueue(a, i);
    expect((await claimWithinHeadroom(h.runWriterPool, await totalWithRoom(2))).claimed).toHaveLength(2);
    expect((await claimWithinHeadroom(h.runWriterPool, await totalWithRoom(0))).claimed).toHaveLength(0);
    await expect(claimWithinHeadroom(h.runWriterPool, () => { throw new Error("no figure"); })).rejects.toThrow("no figure");
    expect((await rows("claimed_at IS NOT NULL"))).toHaveLength(2);
  });
});

describe("migration 0941: the cancel stamp [pg]", () => {
  it("S5k3b-13: closing a waiting item stamps cancelled_by_person, the entry is never claimed, and the places behind it move up", async () => {
    const a = await account(3);
    for (const i of a.items) await enqueue(a, i);
    const n = await h.pureAppUserPool.connect().then(async (c) => {
      try {
        await c.query("BEGIN");
        await c.query(`SELECT set_config('app.account_id', $1, true)`, [a.accountId]);
        const r = await c.query(`SELECT capacity_end_cancelled($1) AS n`, [a.items[0]]);
        await c.query("COMMIT");
        return r.rows[0].n;
      } finally {
        c.release();
      }
    });
    expect(n).toBe(1);
    expect((await rows(`work_item_id = '${a.items[0]}'`))[0]).toMatchObject({ ended_reason: "cancelled_by_person" });
    expect((await rows(`work_item_id = '${a.items[0]}'`))[0].ended_at).toBeInstanceOf(Date);
    const claimed = (await claimWithinHeadroom(h.runWriterPool, await totalWithRoom(10))).claimed;
    expect(claimed.map((c) => c.workItemId)).toEqual([a.items[1], a.items[2]]);
    // the same item can queue again (the old entry is ended, not open) and starts a fresh entry
    expect((await enqueue(a, a.items[0]!)).entry.created).toBe(true);
  });

  it("another account's session ends nothing, a session with no account is refused, and a started entry is not ended", async () => {
    const [a, b] = [await account(2), await account()];
    for (const i of a.items) await enqueue(a, i);
    const cancel = (acct: string | null, item: string) => asRole("app_user", (q) => q(`SELECT capacity_end_cancelled($1) AS n`, [item]), acct ? { "app.account_id": acct } : {});
    expect((await cancel(b.accountId, a.items[0]!)).rows[0].n).toBe(0);
    expect(await refused(cancel(null, a.items[0]!))).toMatch(/no app.account_id/);
    const e = (await claimWithinHeadroom(h.runWriterPool, await totalWithRoom(1))).claimed[0]!;
    await markStarted(h.runWriterPool, e, await liveRun(a, e.workItemId));
    expect((await cancel(a.accountId, e.workItemId)).rows[0].n).toBe(0);
    expect(await rows("ended_at IS NOT NULL")).toHaveLength(0);
  });

  it("only capacity_end_cancelled writes ended_at or ended_reason", async () => {
    const { rows: fns } = await h.admin.query(`SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc ~ '(ended_at|ended_reason)\\s*=' AND proname LIKE 'capacity%'`);
    expect(fns.map((f) => f.proname)).toEqual(["capacity_end_cancelled"]);
    const { rows: g } = await h.admin.query(
      `SELECT r.rolname FROM pg_roles r WHERE NOT r.rolsuper AND r.rolname NOT LIKE 'pg\\_%' AND r.rolname NOT IN (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = 'capacity_queue')
         AND has_column_privilege(r.rolname, 'public.capacity_queue', 'ended_at', 'UPDATE')`,
    );
    expect(g.map((r) => r.rolname)).toEqual(["capacity_queue_definer"]);
  });
});

describe("migration 0941: grants and CHECKs [pg]", () => {
  it("S5k3b-4: no role can DELETE, and no role but the owner can update enqueued_at; app_user reads its own account's rows only", async () => {
    const { rows: roles } = await h.admin.query(`SELECT rolname FROM pg_roles WHERE NOT rolsuper AND rolname NOT LIKE 'pg\\_%' AND rolname <> (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = 'capacity_queue')`);
    expect(roles.length).toBeGreaterThan(5);
    for (const { rolname } of roles) {
      const { rows } = await h.admin.query(
        `SELECT has_table_privilege($1, 'public.capacity_queue', 'DELETE') AS d, has_table_privilege($1, 'public.capacity_queue', 'TRUNCATE') AS t,
                has_column_privilege($1, 'public.capacity_queue', 'enqueued_at', 'UPDATE') AS u`,
        [rolname],
      );
      expect(rows[0], rolname).toEqual({ d: false, t: false, u: false });
    }
    const a = await account();
    await enqueue(a, a.items[0]!);
    for (const role of ["app_user", "platform_ops", "capacity_queue_definer", "ops_owner"]) {
      expect(await refused(asRole(role, (q) => q(`DELETE FROM capacity_queue`))), role).toMatch(/permission denied/);
      expect(await refused(asRole(role, (q) => q(`UPDATE capacity_queue SET enqueued_at = now()`))), role).toMatch(/permission denied/);
    }
    expect(await refused(h.runWriterPool.query(`DELETE FROM capacity_queue`))).toMatch(/permission denied/);
    expect(await refused(h.runWriterPool.query(`INSERT INTO capacity_queue (account_id, repo_id, work_item_id, run_kind, class) VALUES ($1, $2, $3, 'build', 'hosted_sandbox')`, [a.accountId, a.repoId, a.items[0]]))).toMatch(/permission denied/);
    const own = await asRole("app_user", (q) => q(`SELECT id FROM capacity_queue`), { "app.account_id": a.accountId });
    const other = await asRole("app_user", (q) => q(`SELECT id FROM capacity_queue`), { "app.account_id": (await account()).accountId });
    expect([own.rows.length, other.rows.length]).toEqual([1, 0]);
  });

  it("the identity of an entry never changes, even for the owner", async () => {
    const a = await account();
    await enqueue(a, a.items[0]!);
    expect(await refused(h.admin.query(`UPDATE capacity_queue SET enqueued_at = enqueued_at + interval '1 day'`))).toMatch(/never change/);
    expect(await refused(h.admin.query(`UPDATE capacity_queue SET work_item_id = gen_random_uuid()`))).toMatch(/never change/);
  });

  it("who may execute what: the driver functions, the state read and the re-queue go to agent_run_writer, the cancel and the place read to app_user, the asking rule to nobody, nothing to PUBLIC", async () => {
    const { rows } = await h.admin.query(
      `SELECT p.proname, array_agg(DISTINCT pg_get_userbyid(a.grantee) ORDER BY pg_get_userbyid(a.grantee)) FILTER (WHERE a.grantee <> p.proowner) AS grantees, pg_get_userbyid(p.proowner) AS owner
         FROM pg_proc p, aclexplode(p.proacl) a WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'capacity\\_%' AND p.proname NOT LIKE '%guard' GROUP BY p.proname, p.proowner ORDER BY 1`,
    );
    expect(rows).toEqual([
      { proname: "capacity_claim_next", grantees: "{agent_run_writer}", owner: "capacity_queue_definer" },
      { proname: "capacity_end_cancelled", grantees: "{app_user}", owner: "capacity_queue_definer" },
      { proname: "capacity_enqueue", grantees: "{agent_run_writer}", owner: "capacity_queue_definer" },
      { proname: "capacity_entry_asking", grantees: null, owner: "capacity_queue_definer" },
      { proname: "capacity_mark_started", grantees: "{agent_run_writer}", owner: "capacity_queue_definer" },
      { proname: "capacity_queue_place", grantees: "{app_user}", owner: "capacity_queue_definer" },
      { proname: "capacity_queue_state", grantees: "{agent_run_writer}", owner: "capacity_queue_definer" },
      { proname: "capacity_requeue_refused", grantees: "{agent_run_writer}", owner: "capacity_queue_definer" },
      { proname: "capacity_settings_write", grantees: "{ops_console}", owner: OWNER_ROLE },
    ]);
  });

  it("enqueue takes the account from the session: no session, another account's repo, and the runner class are all refused", async () => {
    const [a, b] = [await account(), await account()];
    const call = (settings: Record<string, string>, repo: string, item: string, cls = "hosted_sandbox") =>
      refused(asRole("app_user", (q) => q(`SELECT capacity_enqueue($1, $2, 'build', $3)`, [repo, item, cls]), settings)).then((m) => m);
    // app_user holds no EXECUTE: it is the run-writer login that does, so the refusal below is by privilege, and the checks that follow use the real pool
    expect(await call({ "app.account_id": a.accountId }, a.repoId, a.items[0]!)).toMatch(/permission denied/);
    const viaPool = (acct: string | null, repo: string, item: string, cls = "hosted_sandbox") =>
      refused(
        h.runWriterPool.connect().then(async (c) => {
          try {
            await c.query("BEGIN");
            if (acct) await c.query(`SELECT set_config('app.account_id', $1, true)`, [acct]);
            await c.query(`SELECT capacity_enqueue($1, $2, 'build', $3)`, [repo, item, cls]);
          } finally {
            await c.query("ROLLBACK");
            c.release();
          }
        }),
      );
    expect(await viaPool(null, a.repoId, a.items[0]!)).toMatch(/no app.account_id/);
    expect(await viaPool(a.accountId, b.repoId, a.items[0]!)).toMatch(/no such repository/);
    expect(await viaPool(a.accountId, a.repoId, a.items[0]!, "runner")).toMatch(/only hosted_sandbox/);
    expect(await viaPool(a.accountId, a.repoId, b.items[0]!)).toMatch(/foreign key/);
    expect(await rows()).toHaveLength(0);
  });

  it("the CHECKs hold: the pairs, a started entry is not ended, the provider fields, the class and the kind", async () => {
    const a = await account(8);
    const base = (i: number, extra: string) => `INSERT INTO capacity_queue (account_id, repo_id, work_item_id, run_kind, class${extra.split("|")[0]}) VALUES ('${a.accountId}', '${a.repoId}', '${a.items[i]}', ${extra.split("|")[1] ?? "'build', 'hosted_sandbox'"}${extra.split("|")[2] ?? ""})`;
    const cases: Array<[string, string, RegExp]> = [
      ["ended_at without a reason", base(0, ", ended_at|'build', 'hosted_sandbox'|, now()"), /capacity_queue_ended_pair_check/],
      ["a reason without ended_at", base(1, ", ended_reason|'build', 'hosted_sandbox'|, 'cancelled_by_person'"), /capacity_queue_ended_pair_check/],
      ["an unknown reason", base(2, ", ended_at, ended_reason|'build', 'hosted_sandbox'|, now(), 'failed'"), /capacity_queue_ended_reason_check/],
      ["claimed_at without expiry", base(3, ", claimed_at|'build', 'hosted_sandbox'|, now()"), /capacity_queue_lease_pair_check/],
      ["started and ended", base(4, ", started_run_id, ended_at, ended_reason|'build', 'hosted_sandbox'|, gen_random_uuid(), now(), 'cancelled_by_person'"), /capacity_queue_started_not_ended_check/],
      ["a status outside 100 to 599", base(5, ", refused_status|'build', 'hosted_sandbox'|, 99"), /capacity_queue_refused_status_check/],
      ["a code with text in it", base(6, ", refused_code|'build', 'hosted_sandbox'|, 'a long sentence here'"), /capacity_queue_refused_code_check/],
      ["an unknown class", base(7, "|'build', 'gpu'"), /capacity_queue_class_check/],
      ["a kind with a capital", base(0, "|'Build', 'hosted_sandbox'"), /capacity_queue_run_kind_check/],
    ];
    for (const [label, sql, re] of cases) expect(await refused(h.admin.query(sql)), label).toMatch(re);
    expect(await rows()).toHaveLength(0);
  });
});

describe("migration 0941: the settings store [pg]", () => {
  const write = (role: string, staff: string | null, key: string, value: number) =>
    asRole(role, (q) => q(`SELECT capacity_settings_write($1, $2) AS v`, [key, value]), staff ? { "app.staff_id": staff } : {});
  async function staffMember(active = true): Promise<string> {
    const id = randomUUID();
    await h.admin.query(`INSERT INTO platform_staff (id, email, display_name, active) VALUES ($1, $2, 'Test', $3)`, [id, `${id}@example.test`, active]);
    return id;
  }
  const committed = async (staff: string, key: string, value: number) => {
    const c = await h.adminPool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL ROLE ops_console`);
      await c.query(`SELECT set_config('app.staff_id', $1, true)`, [staff]);
      const r = await c.query(`SELECT capacity_settings_write($1, $2) AS v`, [key, value]);
      await c.query("COMMIT");
      return r.rows[0].v as number;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  };

  it("no row means the provisional values and the health line; a written value replaces one default only", async () => {
    expect(await readCapacitySettings(h.runWriterPool)).toEqual({
      alertDepth: 20, leaseSeconds: 120, defaulted: ["capacity_queue.alert_depth", "capacity_queue.lease_seconds"], health: CAPACITY_SETTINGS_DEFAULTED,
    });
    await committed(await staffMember(), "capacity_queue.alert_depth", 30);
    expect(await readCapacitySettings(h.runWriterPool)).toMatchObject({ alertDepth: 30, leaseSeconds: 120, defaulted: ["capacity_queue.lease_seconds"], health: CAPACITY_SETTINGS_DEFAULTED });
    await committed(await staffMember(), "capacity_queue.lease_seconds", 300);
    expect(await readCapacitySettings(h.runWriterPool)).toMatchObject({ alertDepth: 30, leaseSeconds: 300, defaulted: [], health: null });
  });

  it("each write is a new version with its actor, the old value stays as the previous row, and the newest is current", async () => {
    const [s1, s2] = [await staffMember(), await staffMember()];
    expect(await committed(s1, "capacity_queue.alert_depth", 25)).toBe(1);
    expect(await committed(s2, "capacity_queue.alert_depth", 40)).toBe(2);
    expect(await committed(s1, "capacity_queue.lease_seconds", 90)).toBe(1);
    const { rows } = await h.admin.query(`SELECT key, value, version, actor FROM capacity_queue_settings ORDER BY key, version`);
    expect(rows).toEqual([
      { key: "capacity_queue.alert_depth", value: 25, version: 1, actor: s1 },
      { key: "capacity_queue.alert_depth", value: 40, version: 2, actor: s2 },
      { key: "capacity_queue.lease_seconds", value: 90, version: 1, actor: s1 },
    ]);
    expect((await readCapacitySettings(h.runWriterPool)).alertDepth).toBe(40);
  });

  it("a non-owner is refused: every other role, a console session with no staff, an inactive staff member, and a bad key or value", async () => {
    const staff = await staffMember();
    for (const role of ["app_user", "platform_ops", "agent_run_writer", "capacity_queue_definer"]) {
      expect(await refused(write(role, staff, "capacity_queue.alert_depth", 25)), role).toMatch(/permission denied/);
    }
    expect(await refused(write("ops_console", null, "capacity_queue.alert_depth", 25))).toMatch(/no app.staff_id/);
    expect(await refused(write("ops_console", await staffMember(false), "capacity_queue.alert_depth", 25))).toMatch(/no active staff/);
    expect(await refused(write("ops_console", staff, "capacity_queue.alert_depth", 0))).toMatch(/capacity_queue_settings_value_check/);
    expect(await refused(write("ops_console", staff, "capacity_queue.lease_seconds", 5))).toMatch(/capacity_queue_settings_value_check/);
    expect(await refused(write("ops_console", staff, "capacity_queue.other", 25))).toMatch(/capacity_queue_settings_value_check/);
    expect((await h.admin.query(`SELECT 1 FROM capacity_queue_settings`)).rowCount).toBe(0);
  });

  it("the store is append-only for every role, and app_user cannot read the actor", async () => {
    await committed(await staffMember(), "capacity_queue.alert_depth", 25);
    for (const role of ["app_user", "ops_owner", "ops_console", "capacity_queue_definer"]) {
      expect(await refused(asRole(role, (q) => q(`UPDATE capacity_queue_settings SET value = 1`))), role).toMatch(/permission denied/);
      expect(await refused(asRole(role, (q) => q(`DELETE FROM capacity_queue_settings`))), role).toMatch(/permission denied/);
    }
    expect(await refused(asRole("app_user", (q) => q(`SELECT actor FROM capacity_queue_settings`)))).toMatch(/permission denied/);
    expect((await asRole("app_user", (q) => q(`SELECT value FROM capacity_queue_settings`))).rows).toEqual([{ value: 25 }]);
  });
});

describe("the helper [pg]", () => {
  it("S5k3b-12: with the depth at 20 the 21st waiting entry raises one alert, not one per entry, and every entry is queued as normal", async () => {
    const a = await account(23);
    const alerts: boolean[] = [];
    for (const i of a.items) alerts.push((await enqueue(a, i)).alert);
    expect(alerts.filter(Boolean)).toHaveLength(1);
    expect(alerts.indexOf(true)).toBe(20); // the 21st
    expect(await rows()).toHaveLength(23);
    expect((await enqueue(a, a.items[3]!)).alert, "a second call for a waiting item raises nothing").toBe(false);
  });

  it("the alert rule is exactly the crossing", () => {
    expect([19, 20, 21, 22].map((d) => crossesAlertDepth(true, d, 20))).toEqual([false, false, true, false]);
    expect(crossesAlertDepth(false, 21, 20)).toBe(false);
  });

  it("the state counts live sandbox runs and unexpired claims across every account, and headroom is never negative", async () => {
    const [a, b] = [await account(2), await account()];
    const before = await readCapacityState(h.runWriterPool, () => 1000);
    await liveRun(a, a.items[0]!);
    await h.admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, execution_mode) VALUES ($1, $2, 'executor', 'runner', 'running', 'runner_local')`, [b.accountId, b.items[0]]);
    await enqueue(a, a.items[1]!);
    await enqueue(b, b.items[0]!);
    const mid = await readCapacityState(h.runWriterPool, () => 1000);
    expect([mid.slotsInUse - before.slotsInUse, mid.waiting - before.waiting]).toEqual([1, 2]);
    await claimWithinHeadroom(h.runWriterPool, () => 1000, { limit: 1 });
    expect((await readCapacityState(h.runWriterPool, () => 1000)).slotsInUse - before.slotsInUse, "a claim holds a slot").toBe(2);
    expect((await readCapacityState(h.runWriterPool, () => 0)).headroom).toBe(0);
  });
});

describe("S5k3b-10: the provider's refusal is capacity-full [pg-free]", () => {
  it("a 429 from createSandbox is capacity-full with or without a code, and records the code only when it is a short identifier", async () => {
    const fake = createFakeSandbox({} as never);
    const create = () => fake.port.createSandbox({ sandboxName: `ex-${randomUUID().slice(0, 8)}`, retention: { persistent: false } } as never);
    fake.failCreate(429);
    const bare = await create().catch((e) => e);
    fake.failCreate(429, "rate_limited");
    const coded = await create().catch((e) => e);
    fake.failCreate(429, "a sentence, not a code");
    const dirty = await create().catch((e) => e);
    expect([bare, coded, dirty].every((e) => e instanceof SandboxPortError && e.operation === "createSandbox" && e.status === 429)).toBe(true);
    expect([bare.code, coded.code, dirty.code]).toEqual([undefined, "rate_limited", undefined]);
    expect(classifyCreateFailure(bare)).toEqual({ kind: "capacity_full", status: 429, code: null });
    expect(classifyCreateFailure(coded)).toEqual({ kind: "capacity_full", status: 429, code: "rate_limited" });
    expect(classifyCreateFailure(dirty)).toEqual({ kind: "capacity_full", status: 429, code: null });
  });

  it("any other status, another operation or a plain error keeps today's failure path; a scripted failure fires its count and heals", async () => {
    const fake = createFakeSandbox({} as never);
    const create = () => fake.port.createSandbox({ sandboxName: `ex-${randomUUID().slice(0, 8)}`, retention: { persistent: false } } as never);
    fake.failCreate(500, "internal", 2);
    const errs = [await create().catch((e) => e), await create().catch((e) => e)];
    expect(errs.map((e) => classifyCreateFailure(e).kind)).toEqual(["other", "other"]);
    await expect(create()).resolves.toMatchObject({ sandboxName: expect.stringMatching(/^ex-/) });
    fake.failCreate(429, undefined, Infinity);
    fake.healCreate();
    await expect(create()).resolves.toBeTruthy();
    expect(classifyCreateFailure(new SandboxPortError("deleteSandbox", 429)).kind).toBe("other");
    expect(classifyCreateFailure(new Error("429")).kind).toBe("other");
  });
});
