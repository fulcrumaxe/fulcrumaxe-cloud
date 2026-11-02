import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { FOLLOW_UP_CHILD_START_SUPPORTED } from "@fx/pipeline";
import { createAutoStartSweep } from "../src/autoStartSweep.js";
import { createAdvanceModule, type AdvanceTriageInput } from "../src/advance.js";
import { createRunActionFacade } from "../src/runActions.js";
import { withTenant } from "@fx/db/src/withTenant.js";

/**
 * [pg] D#483 S5-b2d-2a: the follow-up child producer in the auto-start sweep, as the real receipt login against the real 0961 definer and lister (C28-2a-1, -2, -5),
 * and the advance table's refusal for a follow-up child (C28-2a-5). Follow-up rows and approvals are fixtures written by the table owner.
 */
const LOGIN = "fx_follow_up_sweep_test";

describe("follow-up children: the producer and the advance fact [pg]", { timeout: 90_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let appPool: Pool;
  let writerPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${LOGIN}`);
    const u = new URL(process.env.WORKER_DATABASE_URL_APP_USER!);
    u.username = LOGIN;
    u.password = "";
    receiptPool = createPool(u.toString());
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), receiptPool.end(), appPool.end(), writerPool.end()]);
  });

  const sweepWith = (supported: boolean | undefined) =>
    createAutoStartSweep({ receiptPool, firstRunUsd: async () => 1, ...(supported === undefined ? {} : { followUp: { childStartSupported: supported } }), warn: () => {} });

  interface Parent { parent: string; followUp: string }
  async function setup(a: SeedRefs, o: { approved?: boolean; disposition?: "child" | "note"; closed?: boolean; provenance?: string } = {}): Promise<Parent> {
    const parent = (await admin.query<{ id: string }>(
      `INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'feature', $3, 'parent') RETURNING id`, [a.accountId, a.repoId, o.provenance ?? "internal"])).rows[0]!.id;
    if (o.approved !== false) await admin.query(`INSERT INTO work_item_approvals (account_id, work_item_id, approved_by, source) VALUES ($1, $2, $3, 'work_item_approve')`, [a.accountId, parent, a.userId]);
    if (o.closed === true) await admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [parent]);
    const followUp = (await admin.query<{ id: string }>(
      `INSERT INTO work_item_follow_ups (account_id, work_item_id, source_role, title, why, title_key, disposition) VALUES ($1, $2, 'code-reviewer', 'Add a retry', 'why', $3, $4) RETURNING id`,
      [a.accountId, parent, randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""), o.disposition ?? "child"])).rows[0]!.id;
    return { parent, followUp };
  }
  const kids = async (parent: string) => (await admin.query<{ id: string; kind: string; follow_up_id: string; provenance: string; stage: string }>(`SELECT id, kind, follow_up_id, provenance, stage FROM work_items WHERE parent_id = $1`, [parent])).rows;

  it("C28-2a-1: with the flag injected true, one pass makes one small child of an approved parent's child follow-up; a replayed pass makes no second", async () => {
    const a = await seedAccount(admin, randomUUID());
    const p = await setup(a, { provenance: "external" });
    const first = await sweepWith(true).sweepAutoStart();
    expect(first.follow_ups?.made).toBeGreaterThanOrEqual(1);
    const made = await kids(p.parent);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ kind: "small", follow_up_id: p.followUp, provenance: "external", stage: "triaged" });
    expect((await admin.query(`SELECT child_id FROM work_item_follow_ups WHERE id = $1`, [p.followUp])).rows[0].child_id).toBe(made[0]!.id);
    await sweepWith(true).sweepAutoStart();
    expect(await kids(p.parent)).toHaveLength(1);
    // Two passes at once are the same: the definer's lock and the unique index.
    const q = await setup(a);
    await Promise.all([sweepWith(true).sweepAutoStart(), sweepWith(true).sweepAutoStart(), sweepWith(true).makeFollowUpChild(a.accountId, q.followUp)]);
    expect(await kids(q.parent)).toHaveLength(1);
  });

  it("C28-2a-2: the producer leaves a note, a closed parent's follow-up and an unapproved parent's follow-up alone; the rows stay", async () => {
    const a = await seedAccount(admin, randomUUID());
    const note = await setup(a, { disposition: "note" });
    const closed = await setup(a, { closed: true });
    const unapproved = await setup(a, { approved: false });
    await sweepWith(true).sweepAutoStart();
    for (const m of [note, closed, unapproved]) {
      expect(await kids(m.parent)).toEqual([]);
      expect((await admin.query(`SELECT child_id FROM work_item_follow_ups WHERE id = $1`, [m.followUp])).rows[0].child_id).toBeNull();
    }
    // Approved late, it is made on the next pass: nothing was decided against it.
    await admin.query(`INSERT INTO work_item_approvals (account_id, work_item_id, approved_by, source) VALUES ($1, $2, $3, 'work_item_approve')`, [a.accountId, unapproved.parent, a.userId]);
    await sweepWith(true).sweepAutoStart();
    expect(await kids(unapproved.parent)).toHaveLength(1);
    // A call that slips past the list is refused at the data, with the pass counting it as not ready.
    expect(await sweepWith(true).makeFollowUpChild(a.accountId, note.followUp)).toBe("not_ready");
  });

  it("C28-2a-5: with the flag false or absent the producer lists nothing and creates nothing, and the shipped constant is false", async () => {
    expect(FOLLOW_UP_CHILD_START_SUPPORTED).toBe(false);
    const a = await seedAccount(admin, randomUUID());
    const p = await setup(a);
    for (const flag of [false, undefined]) {
      const counts = await sweepWith(flag).sweepAutoStart();
      expect(counts.follow_ups).toBeUndefined();
      expect(await kids(p.parent)).toEqual([]);
    }
  });

  it("C28-2a-5: a follow-up child at triaged is not advanceable and triage is never called for it; an ordinary triaged item still is", async () => {
    const a = await seedAccount(admin, randomUUID());
    const p = await setup(a);
    await sweepWith(true).sweepAutoStart();
    const child = (await kids(p.parent))[0]!.id;
    // The child carries a key of its own (0962) and so can never hold an issue number (0922's CHECK); the triage input names one anyway: the stage table alone must stop it.
    const number = 880000 + Math.floor(Math.random() * 9000);
    // The root has its issue (the child builds on it), so the identity resolves and only the advance table's follow-up rule can stop it.
    await admin.query("UPDATE work_items SET gh_number = $2 WHERE id = $1", [p.parent, number + 500]);
    const triaged: AdvanceTriageInput[] = [];
    const started: unknown[] = [];
    const mod = createAdvanceModule(writerPool, {
      starter: null,
      resolveRunSeat: vi.fn(async () => ({ ok: false }) as never),
      startAdvance: async (args) => void started.push(args),
      triage: async (_pool, _account, input) => (triaged.push(input), { status: "triaged", category: input.category, stage: "discussing" }),
    });
    const input: AdvanceTriageInput = { workItemId: child, title: "t", body: "b", category: "small", sourceEventId: "s", repoId: a.repoId, login: "o", number };
    // advanceTriage with this child's input is unreachable now: its identity is the key, never an issue number, so the input's number cannot match (item_changed). The advance action is the path.
    expect(await mod.advanceTriage(a.accountId, input)).toEqual({ status: "refused", reason: "item_changed" });
    expect(triaged).toEqual([]);
    expect((await mod.advanceLoadItem(a.accountId, child))?.followUp).toBe(true);
    const row = await withTenant(appPool, a.accountId, a.userId, undefined, async (c) => (await c.query("SELECT * FROM run_action_request('advance_work_item', $1, $3, $2)", [child, "h".repeat(64), null])).rows[0]);
    expect(await createRunActionFacade(writerPool, {} as never).claimRunAction(row.action_id, 600)).not.toBeNull();
    // The identity now resolves for a follow-up child (its root's number), so the table's follow-up rule answers, and nothing starts (C29-0-5).
    expect(await mod.performAdvanceWorkItem(row.action_id)).toEqual({ result: "refused", errorCode: "not_advanceable" });
    expect(started).toEqual([]);
    // The control: the same shape without the follow-up link reaches triage.
    const plain = randomUUID();
    const plainNumber = number + 1;
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', 'triaged', $4)", [plain, a.accountId, a.repoId, plainNumber]);
    expect(await mod.advanceTriage(a.accountId, { ...input, workItemId: plain, number: plainNumber })).toMatchObject({ status: "triaged" });
    expect(triaged).toHaveLength(1);
  });
});
