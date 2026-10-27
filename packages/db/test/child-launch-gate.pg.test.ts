import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { writeSubItemPolicyReceipt } from '../src/receiptWriter.js';
import { findRlsViolations } from '../src/rlsInventory.js';
import { withTenant } from '../src/withTenant.js';
import type { SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { TABLE, addSpec, plannedFixture, reapprove, row, type PlannedFixture, type PlannedOptions } from './helpers/plannedChildren.js';

/**
 * [pg] D#483 S5-b2c-1 (migration 0920), as the real roles: the dial's launch of a planned PR child (dial_launch_child), its envelope link, the child lister, the
 * re-stamp of an unstarted child when its parent is approved again (R6), and the privilege shape. The receipt login is a member of app_user and
 * receipt_writer_invoker, nothing else.
 */
const LOGIN = 'fx_child_launch_gate_test';
const NOT_IN_STATE = '55000';
const NOT_FOUND = 'P0002';

describe('migration 0920: the child launch gate [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let appPool: Pool;
  let opsPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = LOGIN;
    u.password = '';
    receiptPool = createPool(u.toString());
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), receiptPool.end(), appPool.end(), opsPool.end()]);
  });

  const fixture = (o: PlannedOptions = {}) => plannedFixture(admin, appPool, o);
  const counts = async (t: SeedRefs) => {
    const one = async (sql: string) => Number((await admin.query(sql, [t.accountId])).rows[0].n);
    return {
      actions: await one(`SELECT count(*) n FROM run_action_requests WHERE account_id = $1`),
      receipts: await one(`SELECT count(*) n FROM decision_receipts WHERE account_id = $1`),
      envelopes: await one(`SELECT count(*) n FROM work_items WHERE account_id = $1 AND parent_id IS NOT NULL AND envelope_id IS NOT NULL`),
      audits: await one(`SELECT count(*) n FROM audit_log WHERE account_id = $1 AND action = 'child_launch.dial'`),
    };
  };
  interface LaunchOptions {
    key?: string;
    /** Write the receipt first (default) or pass a made-up id. */
    receipt?: 'fresh' | 'random';
    chosen?: 'launch' | 'announce';
    /** Receipt key / parent overrides, to make a mismatched receipt. */
    receiptKey?: string;
    approvalId?: string;
    /** Run `before` on the same connection before the definer. */
    before?: (c: PoolClient, receiptId: string) => Promise<void>;
    user?: string;
  }
  /** The sweep's one transaction on the receipt login: the keyed policy receipt, then the definer. */
  async function launch(f: PlannedFixture, o: LaunchOptions = {}): Promise<{ receipt: string; row: Record<string, unknown> }> {
    const key = o.key ?? 'api';
    return withTenant(receiptPool, f.t.accountId, o.user as string, undefined, async (c) => {
      const receipt =
        o.receipt === 'random'
          ? randomUUID()
          : (await writeSubItemPolicyReceipt(c, {
              runId: f.pmRun, workItemId: f.parent, key: o.receiptKey ?? key, specVersionId: f.specV1, approvalId: o.approvalId ?? f.approvalId, chosen: o.chosen ?? 'launch', dialVersion: 1,
            })).id;
      if (o.before) await o.before(c, receipt);
      const r = (await c.query('SELECT * FROM dial_launch_child($1, $2)', [f.kids[key], receipt])).rows[0];
      return { receipt, row: r };
    });
  }
  const refused = (p: Promise<unknown>, message: string) => expect(p).rejects.toMatchObject({ code: NOT_IN_STATE, message });

  describe('S5b2c1-1/6/7: the launch and the receipt binding', () => {
    it('files one advance request for the child under dial:<receipt>, links the parent envelope, writes one audit row, and a replay writes nothing', async () => {
      const f = await fixture();
      const before = await counts(f.t);
      const { receipt, row: r } = await launch(f);
      expect(r).toMatchObject({ state: 'accepted', replayed: false });
      const after = await counts(f.t);
      expect(after).toEqual({ actions: before.actions + 1, receipts: before.receipts + 1, envelopes: 1, audits: 1 });
      const req = (await admin.query(`SELECT * FROM run_action_requests WHERE id = $1`, [r.action_id])).rows[0];
      expect(req).toMatchObject({ kind: 'advance_work_item', target_id: f.kids.api, principal_kind: 'session', requested_by: `session:${f.t.userId}`, idempotency_key: `dial:${receipt}` });
      expect((await admin.query(`SELECT envelope_id FROM work_items WHERE id = $1`, [f.kids.api])).rows[0].envelope_id).toBe(f.envelope);
      const audit = (await admin.query(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'child_launch.dial'`, [f.t.accountId])).rows[0];
      expect(audit.actor).toBe('policy');
      expect(audit.payload).toMatchObject({ parent_id: f.parent, child_id: f.kids.api, key: 'api', receipt_id: receipt, envelope_id: f.envelope });
      // The same child again, with a fresh receipt of the same keyed row: the receipt is an old one now, so the definer refuses and nothing is written.
      await refused(launch(f), 'work_started');
      expect(await counts(f.t)).toEqual(after);
    });

    it('announce receipts launch too; a sibling shares the parent envelope', async () => {
      const f = await fixture();
      await launch(f, { chosen: 'announce' });
      await launch(f, { key: 'docs' });
      const env = (await admin.query(`SELECT planned_pr_key, envelope_id FROM work_items WHERE parent_id = $1 AND envelope_id IS NOT NULL ORDER BY 1`, [f.parent])).rows;
      expect(env).toEqual([{ planned_pr_key: 'api', envelope_id: f.envelope }, { planned_pr_key: 'docs', envelope_id: f.envelope }]);
    });

    it('a receipt written in an earlier transaction is refused (receipt_not_in_transaction); nothing is written', async () => {
      const f = await fixture();
      const earlier = await withTenant(receiptPool, f.t.accountId, async (c) =>
        (await writeSubItemPolicyReceipt(c, { runId: f.pmRun, workItemId: f.parent, key: 'api', specVersionId: f.specV1, approvalId: f.approvalId, chosen: 'launch', dialVersion: 1 })).id);
      const before = await counts(f.t);
      await refused(withTenant(receiptPool, f.t.accountId, (c) => c.query('SELECT * FROM dial_launch_child($1, $2)', [f.kids.api, earlier])), 'receipt_not_in_transaction');
      await refused(launch(f, { receipt: 'random' }), 'receipt_not_in_transaction');
      expect(await counts(f.t)).toEqual(before);
    });

    it('a receipt for another key or a non-newest approval is receipt_mismatch; nothing is written', async () => {
      const f = await fixture();
      const before = await counts(f.t);
      // Another key under the same parent and version.
      await refused(launch(f, { key: 'api', receiptKey: 'docs' }), 'receipt_mismatch');
      // A non-newest approval: the receipt writer itself refuses to write one (22023), so the definer's own check is reached with a row written another way (as the
      // migration role, in one transaction, the way a bug or a forged writer would).
      await admin.query(`INSERT INTO work_item_approvals (account_id, work_item_id, approved_by, spec_version_id, source) VALUES ($1, $2, $3, $4, 'work_item_approve')`, [f.t.accountId, f.parent, f.t.userId, f.specV1]);
      await expect(launch(f)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      await admin.query('BEGIN');
      try {
        await admin.query(`SELECT set_config('app.account_id', $1, true)`, [f.t.accountId]);
        const stale = (await admin.query<{ id: string }>(
          `INSERT INTO decision_receipts (account_id, run_id, work_item_id, decision_type, class, chosen, rejected_alternative, dial_version, input_trust_classes, actor, catalogue_version, sub_item_key, spec_version_id, approval_id)
           VALUES ($1, $2, $3, 'launch_sub_item', 'human_over_the_loop', 'launch', 'wait_for_approval', 1, '[]'::jsonb, 'policy', 1, 'api', $4, $5) RETURNING id`,
          [f.t.accountId, f.pmRun, f.parent, f.specV1, f.approvalId])).rows[0]!.id;
        await expect(admin.query('SELECT * FROM dial_launch_child($1, $2)', [f.kids.api, stale])).rejects.toMatchObject({ code: NOT_IN_STATE, message: 'receipt_mismatch' });
      } finally {
        await admin.query('ROLLBACK');
      }
      expect(await counts(f.t)).toEqual({ ...before, receipts: before.receipts });
    });

    it("a person's receipt is receipt_mismatch (written in the same transaction by a session with no user it cannot be, so the person's receipt is used from an earlier one), and a session with a user is refused 42501", async () => {
      const f = await fixture();
      // The person's receipt (actor = the person) exists from the card's Approve; the dial's transaction can only name it, never write it.
      const person = await withTenant(receiptPool, f.t.accountId, f.t.userId, undefined, async (c) =>
        (await c.query<{ o_id: string }>(`SELECT * FROM sub_item_approval_receipt_write($1, 'api', $2, $3, 1, 1)`, [f.parent, f.specV1, f.pmRun])).rows[0]!.o_id);
      await refused(withTenant(receiptPool, f.t.accountId, (c) => c.query('SELECT * FROM dial_launch_child($1, $2)', [f.kids.api, person])), 'receipt_not_in_transaction');
      // A dial transaction that finds the keyed row already written (by the person) gets that older receipt back, never a new one: still not in transaction.
      await refused(launch(f), 'receipt_not_in_transaction');
      // The definer also reads the actor: a person's receipt row, written under THIS transaction by the same connection, is a mismatch.
      const g = await fixture();
      await expect(
        withTenant(receiptPool, g.t.accountId, g.t.userId, undefined, async (c) => {
          const id = (await c.query<{ o_id: string }>(`SELECT * FROM sub_item_approval_receipt_write($1, 'api', $2, $3, 1, 1)`, [g.parent, g.specV1, g.pmRun])).rows[0]!.o_id;
          return c.query('SELECT * FROM dial_launch_child($1, $2)', [g.kids.api, id]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(launch(await fixture(), { user: f.t.userId, receipt: 'random' })).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect((await counts(g.t)).actions).toBe(0);
    });
  });

  describe('S5b2c1-5/6: each refusal leaves request, receipt, envelope and audit counts unchanged', () => {
    const cases: Array<[string, PlannedOptions, (f: PlannedFixture) => Promise<void>]> = [
      ['child_orphaned', {}, async (f) => void (await admin.query('DELETE FROM work_items WHERE id = $1', [f.parent]))],
      ['parent_closed', {}, async (f) => void (await admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [f.parent]))],
      ['respec_needs_approval', {}, async (f) => void (await addSpec(admin, f.t, f.parent, 2, TABLE))],
      [
        'key_not_in_approved_spec',
        {},
        async (f) => {
          await addSpec(admin, f.t, f.parent, 2, [row('docs'), row('other')]);
          await reapprove(appPool, f);
        },
      ],
      ['external_needs_approval', { provenance: 'external' }, async () => {}],
      ['parent_no_envelope', { envelopeUsd: null }, async () => {}],
      ['work_started', {}, async (f) => void (await admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'executor', 'local', 'running')`, [f.t.accountId, f.kids.api]))],
      ['child_closed', {}, async (f) => void (await admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [f.kids.api]))],
    ];
    for (const [code, opts, arrange] of cases) {
      it(`${code}: refused with a valid receipt and with none, with nothing written`, async () => {
        const f = await fixture(opts);
        await arrange(f);
        const before = await counts(f.t);
        const child = f.kids.api;
        // With no receipt at all, the data-state code comes first.
        await refused(withTenant(receiptPool, f.t.accountId, (c) => c.query('SELECT * FROM dial_launch_child($1, $2)', [child, randomUUID()])), code);
        // With a receipt in the same transaction where the receipt writer accepts one, the same code.
        if (!['child_orphaned', 'respec_needs_approval', 'key_not_in_approved_spec'].includes(code)) {
          await refused(launch(f), code);
        }
        expect(await counts(f.t)).toEqual(before);
      });
    }

    it('an orphan raises child_orphaned even with a valid receipt (the keyed receipt names the old parent)', async () => {
      const f = await fixture();
      await admin.query('UPDATE work_items SET parent_id = NULL WHERE id = $1', [f.kids.api]);
      const before = await counts(f.t);
      await refused(launch(f), 'child_orphaned');
      expect(await counts(f.t)).toEqual(before);
    });

    it('the weekly limit off, or confirmed by someone who is no longer an owner or admin, fails closed', async () => {
      const f = await fixture({ weeklyUsd: null });
      await refused(launch(f), 'autostart_off');
      const g = await fixture();
      await admin.query(`UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2`, [g.t.accountId, g.t.userId]);
      await refused(launch(g), 'autostart_confirmer_not_admin');
      expect((await counts(g.t)).actions).toBe(0);
    });
  });

  describe('S5b2c1-6: the child lister', () => {
    const listed = async (ids: string[]): Promise<string[]> => {
      const out: string[] = [];
      let after: Array<string | null> = [null, null];
      for (;;) {
        const page: Array<{ child_id: string; created_at: Date }> = (await receiptPool.query('SELECT * FROM planned_pr_child_list_due(200, $1, $2)', after)).rows;
        out.push(...page.map((r) => r.child_id).filter((id) => ids.includes(id)));
        if (page.length < 200) return out;
        const last = page[page.length - 1]!;
        after = [last.created_at.toISOString(), last.child_id];
      }
    };
    it('lists unstarted children with a parent in a live account; never an orphan, a started, a closed or a limit-off one', async () => {
      const f = await fixture();
      const ids = Object.values(f.kids);
      expect((await listed(ids)).sort()).toEqual([...ids].sort());
      await admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'executor', 'local', 'cancelled')`, [f.t.accountId, f.kids.api]);
      expect(await listed([f.kids.api])).toEqual([f.kids.api]);
      await admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'executor', 'local', 'running')`, [f.t.accountId, f.kids.api]);
      await admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [f.kids.docs]);
      expect(await listed(ids)).toEqual([f.kids.ui]);
      await admin.query('DELETE FROM work_items WHERE id = $1', [f.parent]);
      expect(await listed(ids)).toEqual([]);
      const g = await fixture({ weeklyUsd: 0 });
      expect(await listed(Object.values(g.kids))).toEqual([]);
    });
    it('is keyset paged: a page of one never repeats a row', async () => {
      const f = await fixture();
      const seen: string[] = [];
      let after: Array<string | null> = [null, null];
      for (let i = 0; i < 400; i++) {
        const page: Array<{ child_id: string; created_at: Date }> = (await receiptPool.query('SELECT * FROM planned_pr_child_list_due(1, $1, $2)', after)).rows;
        if (page.length === 0) break;
        seen.push(page[0]!.child_id);
        after = [page[0]!.created_at.toISOString(), page[0]!.child_id];
      }
      expect(new Set(seen).size).toBe(seen.length);
      for (const id of Object.values(f.kids)) expect(seen).toContain(id);
    });
  });

  describe('S5b2c1-8: privilege', () => {
    const FNS = ['dial_launch_child(uuid,uuid)', 'work_item_set_child_envelope(uuid)', 'planned_pr_child_list_due(integer,timestamp with time zone,uuid)'];
    it('app_user and platform_ops hold no EXECUTE on the three; the receipt role does; owners are the definer roles', async () => {
      for (const fn of FNS) {
        for (const role of ['app_user', 'platform_ops']) {
          expect((await admin.query(`SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS x`, [role, fn])).rows[0].x, `${role} ${fn}`).toBe(false);
        }
        expect((await admin.query(`SELECT has_function_privilege('receipt_writer_invoker', $1::regprocedure, 'EXECUTE') AS x`, [fn])).rows[0].x, fn).toBe(true);
      }
      const owners = (await admin.query(`SELECT p.proname, pg_get_userbyid(p.proowner) AS o, p.prosecdef FROM pg_proc p WHERE p.proname IN ('dial_launch_child', 'work_item_set_child_envelope', 'planned_pr_child_list_due') ORDER BY 1`)).rows;
      expect(owners).toEqual([
        { proname: 'dial_launch_child', o: 'dial_start_definer', prosecdef: true },
        { proname: 'planned_pr_child_list_due', o: 'planned_pr_child_lister', prosecdef: true },
        { proname: 'work_item_set_child_envelope', o: 'envelope_definer', prosecdef: true },
      ]);
      expect((await admin.query(`SELECT has_function_privilege('dial_start_definer', 'work_item_set_child_envelope(uuid)'::regprocedure, 'EXECUTE') AS x`)).rows[0].x).toBe(true);
    });
    it('the web tier and a platform_ops login cannot call them', async () => {
      const f = await fixture();
      await expect(withTenant(appPool, f.t.accountId, f.t.userId, (c) => c.query('SELECT * FROM dial_launch_child($1, $2)', [f.kids.api, randomUUID()]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(withTenant(appPool, f.t.accountId, f.t.userId, (c) => c.query('SELECT work_item_set_child_envelope($1)', [f.kids.api]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(opsPool.query('SELECT * FROM planned_pr_child_list_due(10)')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(opsPool.query('SELECT * FROM dial_launch_child($1, $2)', [f.kids.api, randomUUID()])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
    it('the new lister role is NOLOGIN, unprivileged and a member of nothing; the RLS inventory has no violation', async () => {
      const { rows } = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = 'planned_pr_child_lister'`);
      expect(rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
      expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = 'planned_pr_child_lister'::regrole OR member = 'planned_pr_child_lister'::regrole`)).rowCount).toBe(0);
      expect(await findRlsViolations(admin)).toEqual([]);
    });
  });

  describe('work_item_set_child_envelope', () => {
    const setEnv = (f: PlannedFixture, key: string, user?: string) => withTenant(receiptPool, f.t.accountId, user as string, undefined, async (c) => (await c.query('SELECT work_item_set_child_envelope($1) AS e', [f.kids[key]])).rows[0].e);
    it('copies the parent envelope once, answers the same envelope again, and refuses a started child, a missing envelope, a different envelope and a non-child', async () => {
      const f = await fixture();
      expect(await setEnv(f, 'api')).toBe(f.envelope);
      expect(await setEnv(f, 'api')).toBe(f.envelope);
      expect(await setEnv(f, 'ui', f.t.userId)).toBe(f.envelope);
      await admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'executor', 'local', 'running')`, [f.t.accountId, f.kids.docs]);
      await refused(setEnv(f, 'docs'), 'work_started');
      const g = await fixture({ envelopeUsd: null });
      await refused(setEnv(g, 'api'), 'parent_no_envelope');
      // A different envelope already on the child: set by the migration role bypassing the guard is impossible, so set it through the definer's own table path.
      await expect(withTenant(receiptPool, f.t.accountId, (c) => c.query('SELECT work_item_set_child_envelope($1)', [f.parent]))).rejects.toMatchObject({ message: 'not_a_child' });
      await expect(withTenant(receiptPool, f.t.accountId, (c) => c.query('SELECT work_item_set_child_envelope($1)', [randomUUID()]))).rejects.toMatchObject({ code: NOT_FOUND });
      // A token in the session is refused.
      await expect(withTenant(receiptPool, f.t.accountId, f.t.userId, randomUUID(), (c) => c.query('SELECT work_item_set_child_envelope($1)', [f.kids.api]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
    it('a person in the session must be an owner or admin; a plain member is refused 42501 and nothing is set', async () => {
      const f = await fixture();
      const member = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [member, `${member}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [f.t.accountId, member]);
      await expect(setEnv(f, 'api', member)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect((await admin.query('SELECT envelope_id FROM work_items WHERE id = $1', [f.kids.api])).rows[0].envelope_id).toBeNull();
    });
    it('nothing else writes a child envelope: the web tier cannot set it', async () => {
      const f = await fixture();
      await expect(withTenant(appPool, f.t.accountId, f.t.userId, (c) => c.query('UPDATE work_items SET envelope_id = $2 WHERE id = $1', [f.kids.api, f.envelope]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });

  describe('S5b2c1-10: R6, a re-approved parent moves its unstarted children forward', () => {
    const pins = async (f: PlannedFixture) => Object.fromEntries((await admin.query<{ planned_pr_key: string; planned_pr_spec_version_id: string }>('SELECT planned_pr_key, planned_pr_spec_version_id FROM work_items WHERE parent_id = $1 AND planned_pr_key IS NOT NULL', [f.parent])).rows.map((r) => [r.planned_pr_key, r.planned_pr_spec_version_id]));
    it('moves an unstarted child whose key is in version 2, leaves one whose key is not, leaves a started one, and adds the new key', async () => {
      const f = await fixture();
      // api started (a live run), ui unstarted and in v2, docs unstarted and absent from v2.
      await admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'executor', 'local', 'running')`, [f.t.accountId, f.kids.api]);
      const v2 = await addSpec(admin, f.t, f.parent, 2, [row('api', 'The API'), row('ui', 'The screen', ['api']), row('extra', 'Extra')]);
      await reapprove(appPool, f);
      const p = await pins(f);
      expect(p.api).toBe(f.specV1);
      expect(p.ui).toBe(v2);
      expect(p.docs).toBe(f.specV1);
      expect(p.extra).toBe(v2);
      // The removed key now falls under case (d) at the gate.
      const blocker = async (id: string) => (await admin.query(`SELECT planned_pr_child_blocker($1) AS b`, [id])).rows[0].b;
      await admin.query(`SELECT set_config('app.account_id', $1, false)`, [f.t.accountId]);
      try {
        await admin.query('SET ROLE app_user');
        expect(await blocker(f.kids.docs)).toBe('key_not_in_approved_spec');
        expect(await blocker(f.kids.ui)).toBe('waiting_on_planned_pr');
      } finally {
        await admin.query('RESET ROLE');
        await admin.query(`SELECT set_config('app.account_id', '', false)`);
      }
    });
    it('a child with a queued advance request keeps its version; a cancelled run does not keep it', async () => {
      const f = await fixture();
      await admin.query(`INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, idempotency_key, request_hash) VALUES ($1, 'advance_work_item', $2, $3, 'session', 'k', 'h')`, [f.t.accountId, f.kids.api, `session:${f.t.userId}`]);
      await admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'executor', 'local', 'cancelled')`, [f.t.accountId, f.kids.ui]);
      const v2 = await addSpec(admin, f.t, f.parent, 2, TABLE);
      await reapprove(appPool, f);
      const p = await pins(f);
      expect(p.api).toBe(f.specV1);
      expect(p.ui).toBe(v2);
      expect(p.docs).toBe(v2);
    });
    it('a direct UPDATE of a planned PR column, by the web tier, the migration role or the receipt login, still raises 42501', async () => {
      const f = await fixture();
      const v2 = await addSpec(admin, f.t, f.parent, 2, TABLE);
      for (const sql of [`UPDATE work_items SET planned_pr_spec_version_id = $2 WHERE id = $1`]) {
        await expect(withTenant(appPool, f.t.accountId, f.t.userId, (c) => c.query(sql, [f.kids.api, v2]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(withTenant(receiptPool, f.t.accountId, f.t.userId, undefined, (c) => c.query(sql, [f.kids.api, v2]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(admin.query(sql, [f.kids.api, v2])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
      await expect(admin.query(`UPDATE work_items SET planned_pr_key = 'zzz' WHERE id = $1`, [f.kids.api])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
    it('even the approval definer cannot move a child backwards or to another parent\'s version', async () => {
      const f = await fixture();
      const g = await fixture();
      const v2 = await addSpec(admin, f.t, f.parent, 2, TABLE);
      const asDefiner = async (sql: string, params: unknown[]) => {
        await admin.query('BEGIN');
        try {
          await admin.query(`SELECT set_config('app.account_id', $1, true)`, [f.t.accountId]);
          await admin.query('SET LOCAL ROLE work_item_approval_definer');
          return await admin.query(sql, params);
        } finally {
          await admin.query('ROLLBACK');
        }
      };
      // forward to v2: allowed for the definer
      expect((await asDefiner(`UPDATE work_items SET planned_pr_spec_version_id = $2 WHERE id = $1`, [f.kids.api, v2])).rowCount).toBe(1);
      // the same child cannot be pointed at another parent's version, nor back to an older one.
      await expect(asDefiner(`UPDATE work_items SET planned_pr_spec_version_id = $2 WHERE id = $1`, [f.kids.api, g.specV1])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await admin.query('UPDATE spec_versions SET erased_at = now() WHERE id = $1', [v2]);
      await expect(asDefiner(`UPDATE work_items SET planned_pr_spec_version_id = $2 WHERE id = $1`, [f.kids.api, v2])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });
});
