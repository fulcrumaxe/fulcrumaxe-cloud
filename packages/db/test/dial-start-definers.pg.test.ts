import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { writeReceipt } from '../src/receiptWriter.js';
import { withTenant } from '../src/withTenant.js';
import { findRlsViolations } from '../src/rlsInventory.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * [pg] D#483 S5-b1a-1 (migration 0901): the dial's own approval and start of a verified proposal, as the real roles. The gate runs on the
 * receipt login (a member of app_user and receipt_writer_invoker, nothing else): in ONE transaction it creates the work item, writes the
 * class-2 receipt (actor policy, anchored on the verifier run), approves through approve_proposal_by_dial (which attaches the weekly
 * auto-start envelope) and files advance_work_item through run_action_request_by_dial, on behalf of the person who confirmed the limit.
 */
const RECEIPT_LOGIN = 'fx_dial_gate_test';
const FUNCTIONS = {
  'approve_proposal_by_dial(uuid,uuid,uuid)': { owner: 'dial_start_definer', secdef: true, grantees: ['receipt_writer_invoker'] },
  'run_action_request_by_dial(uuid,uuid)': { owner: 'dial_start_definer', secdef: true, grantees: ['receipt_writer_invoker'] },
  'proposal_gate_list_due(integer,timestamp with time zone,uuid)': { owner: 'proposal_gate_lister', secdef: true, grantees: ['receipt_writer_invoker'] },
  'work_item_set_autostart_envelope(uuid)': { owner: 'envelope_definer', secdef: true, grantees: ['dial_start_definer'] },
  'dial_start_receipt(text,uuid,uuid)': { owner: null, secdef: false, grantees: ['dial_start_definer'] },
} as const;
const NAMES = ['approve_proposal_by_dial', 'run_action_request_by_dial', 'proposal_gate_list_due', 'work_item_set_autostart_envelope', 'dial_start_receipt'];

interface Fixture {
  t: SeedRefs;
  proposal: string;
  verifiedRun: string;
  envelope: string | null;
}
interface GateOptions {
  runId?: string;
  chosen?: string;
  dialVersion?: number;
  decisionType?: string;
  /** Skip the start request (to test the approval alone). */
  noStart?: boolean;
  /** Use this existing work item instead of creating one in the gate transaction. */
  workItem?: string;
}

describe('migration 0901: the dial approves and starts a verified proposal [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let appPool: Pool;
  let opsPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RECEIPT_LOGIN}') THEN
          CREATE ROLE ${RECEIPT_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${RECEIPT_LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = RECEIPT_LOGIN;
    u.password = '';
    receiptPool = createPool(u.toString());
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), receiptPool.end(), appPool.end(), opsPool.end()]);
  });

  let n = 0;
  /** A connected repo's verified, internal, product-owned proposal, under Balanced (start_work_small announces), with a weekly limit of $13. */
  async function fixture(o: { amount?: number | null; disposition?: string; provenance?: string; owner?: string; verified?: boolean } = {}): Promise<Fixture> {
    const t = await seedAccount(admin, randomUUID());
    let envelope: string | null = null;
    if (o.amount !== null) {
      envelope = randomUUID();
      await admin.query(`INSERT INTO approval_envelopes (id, account_id, repo_id, scope, amount_usd, version, created_by) VALUES ($1, $2, NULL, 'weekly_autostart', $3, 1, $4)`, [envelope, t.accountId, o.amount ?? 13, t.userId]);
    }
    await admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, 'start_work_small', $3, 'balanced', 1, $4)`, [t.accountId, t.repoId, o.disposition ?? 'announce', t.userId]);
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, title, provenance, owner_process) VALUES ($1, $2, $3, '{github_issue}', 'Fix the typo', $4, $5) RETURNING id`,
      [t.accountId, t.repoId, `gh:issue:${++n}`, o.provenance ?? 'internal', o.owner ?? 'product'],
    );
    const proposal = rows[0]!.id;
    if (o.verified !== false) await admin.query(`UPDATE proposals SET verification = 'verified', verified_at = now(), verified_run_id = $2 WHERE id = $1`, [proposal, t.runId]);
    return { t, proposal, verifiedRun: t.runId, envelope };
  }

  /** The gate's one transaction, as the receipt login with no person and no token in the session. */
  async function gate(f: Fixture, o: GateOptions = {}): Promise<{ workItem: string; receipt: string; approval: Record<string, unknown>; start: Record<string, unknown> | null }> {
    return withTenant(receiptPool, f.t.accountId, async (c) => {
      const wi = o.workItem ?? (await c.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'Fix the typo') RETURNING id`, [f.t.accountId, f.t.repoId])).rows[0]!.id;
      const r = await writeReceipt(c, {
        class: 'human_over_the_loop', runId: o.runId ?? f.verifiedRun, workItemId: wi, decisionType: o.decisionType ?? 'start_work_small',
        chosen: o.chosen ?? 'start', rejectedAlternative: 'wait_for_approval', dialVersion: o.dialVersion ?? 1, quotedInputs: [{ trust: 'trusted', storedBody: 'verified' }],
      });
      if (r.store !== 'decision_receipts') throw new Error('expected a durable receipt');
      const approval = (await c.query('SELECT * FROM approve_proposal_by_dial($1, $2, $3)', [f.proposal, wi, r.id])).rows[0];
      const start = o.noStart ? null : (await c.query('SELECT * FROM run_action_request_by_dial($1, $2)', [wi, r.id])).rows[0];
      return { workItem: wi, receipt: r.id, approval, start };
    });
  }
  const refusedWith = (p: Promise<unknown>, code: string, message?: string) => expect(p).rejects.toMatchObject(message ? { code, message } : { code });
  const counts = async (t: SeedRefs) => {
    const one = async (sql: string) => Number((await admin.query(sql, [t.accountId])).rows[0].n);
    return {
      receipts: await one('SELECT count(*) n FROM decision_receipts WHERE account_id = $1'),
      items: await one('SELECT count(*) n FROM work_items WHERE account_id = $1'),
      actions: await one('SELECT count(*) n FROM run_action_requests WHERE account_id = $1'),
      audits: await one('SELECT count(*) n FROM audit_log WHERE account_id = $1'),
      approved: await one(`SELECT count(*) n FROM proposals WHERE account_id = $1 AND state = 'approved'`),
    };
  };
  const listed = async (wanted: string[]): Promise<string[]> => {
    const out: string[] = [];
    let after: Array<string | null> = [null, null];
    for (;;) {
      const page: Array<{ proposal_id: string; verified_at: Date }> = (await receiptPool.query('SELECT * FROM proposal_gate_list_due(200, $1, $2)', after)).rows;
      out.push(...page.map((r) => r.proposal_id).filter((id) => wanted.includes(id)));
      if (page.length < 200) return out;
      const last = page[page.length - 1]!;
      after = [last.verified_at.toISOString(), last.proposal_id];
    }
  };

  describe('roles, owners and who may execute', () => {
    it('the two new roles are NOLOGIN, unprivileged and members of nothing; the RLS inventory has no violation', async () => {
      for (const role of ['dial_start_definer', 'proposal_gate_lister']) {
        const { rows } = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [role]);
        expect(rows[0], role).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
        expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole OR member = $1::regrole`, [role])).rowCount, role).toBe(0);
      }
      expect(await findRlsViolations(admin)).toEqual([]);
    });

    it('each function has its owner, a pinned search_path and EXECUTE for exactly one role; app_user and platform_ops hold none', async () => {
      const { rows } = await admin.query<{ sig: string; owner: string; secdef: boolean; config: string[]; grantees: string[] }>(
        `SELECT replace(p.oid::regprocedure::text, ', ', ',') AS sig, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef, p.proconfig AS config,
                COALESCE((SELECT array_agg(DISTINCT CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(g.grantee)::text END) FROM aclexplode(p.proacl) g WHERE g.grantee <> p.proowner), '{}') AS grantees
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1)`,
        [NAMES],
      );
      expect(rows.map((r) => r.sig).sort()).toEqual(Object.keys(FUNCTIONS).sort());
      for (const r of rows) {
        const want = FUNCTIONS[r.sig as keyof typeof FUNCTIONS];
        expect(r.config, r.sig).toEqual(['search_path=pg_catalog, public, pg_temp']);
        expect(r.secdef, r.sig).toBe(want.secdef);
        expect(r.grantees, r.sig).toEqual(want.grantees);
        if (want.owner) expect(r.owner, r.sig).toBe(want.owner);
        else expect(['dial_start_definer', 'envelope_definer', 'proposal_gate_lister', 'platform_ops', 'app_user']).not.toContain(r.owner);
        for (const role of ['app_user', 'platform_ops', 'agent_run_writer']) {
          expect((await admin.query(`SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`, [role, r.sig])).rows[0].ok, `${role} ${r.sig}`).toBe(false);
        }
      }
    });
  });

  describe('S5b1-1: under Balanced with a weekly limit, the gate approves and starts with one receipt', () => {
    it('approves as the dial, attaches the weekly envelope, files the start for the confirming person, and writes nothing more on a second run', async () => {
      const f = await fixture();
      const before = await counts(f.t);
      const g = await gate(f);
      expect(g.approval).toMatchObject({ state: 'approved', roadmap_position: 1, work_item_id: g.workItem, envelope_id: f.envelope, replayed: false });
      expect(g.start).toMatchObject({ state: 'accepted', replayed: false });

      const p = (await admin.query('SELECT * FROM proposals WHERE id = $1', [f.proposal])).rows[0];
      expect(p).toMatchObject({ state: 'approved', decided_by_kind: 'dial', decision_receipt_id: g.receipt, decided_by_user_id: null, work_item_id: g.workItem });
      expect(p.decided_at).not.toBeNull();
      const receipt = (await admin.query('SELECT * FROM decision_receipts WHERE id = $1', [g.receipt])).rows[0];
      expect(receipt).toMatchObject({
        account_id: f.t.accountId, class: 'human_over_the_loop', decision_type: 'start_work_small', chosen: 'start', rejected_alternative: 'wait_for_approval',
        actor: 'policy', run_id: f.verifiedRun, work_item_id: g.workItem, dial_version: 1,
      });
      const dial = (await admin.query('SELECT disposition FROM decision_settings WHERE account_id = $1 AND repo_id = $2 AND decision_type = $3 AND version = $4', [f.t.accountId, f.t.repoId, 'start_work_small', receipt.dial_version])).rows[0];
      expect(dial).toEqual({ disposition: 'announce' });
      expect((await admin.query('SELECT envelope_id FROM work_items WHERE id = $1', [g.workItem])).rows[0].envelope_id).toBe(f.envelope);
      const action = (await admin.query('SELECT * FROM run_action_requests WHERE id = $1', [(g.start as { action_id: string }).action_id])).rows[0];
      expect(action).toMatchObject({ kind: 'advance_work_item', target_id: g.workItem, principal_kind: 'session', requested_by: `session:${f.t.userId}`, state: 'accepted', idempotency_key: `dial:${g.receipt}` });
      const audits = (await admin.query(`SELECT actor, action FROM audit_log WHERE account_id = $1 AND action IN ('proposal.approved', 'run_action.requested') ORDER BY created_at`, [f.t.accountId])).rows;
      expect(audits).toEqual([{ actor: 'policy', action: 'proposal.approved' }, { actor: 'policy', action: 'run_action.requested' }]);
      const after = await counts(f.t);
      expect(after).toEqual({ ...before, receipts: before.receipts + 1, items: before.items + 1, actions: before.actions + 1, audits: before.audits + 2, approved: before.approved + 1 });

      // The gate again: the proposal is no longer listed, and a forced second pass is refused and leaves nothing behind.
      expect(await listed([f.proposal])).toEqual([]);
      await refusedWith(gate(f), '55000', 'not_new');
      expect(await counts(f.t)).toEqual(after);
    });

    it('the same calls again inside the gate transaction are replays and write nothing', async () => {
      const f = await fixture();
      await withTenant(receiptPool, f.t.accountId, async (c) => {
        const wi = (await c.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'T') RETURNING id`, [f.t.accountId, f.t.repoId])).rows[0]!.id;
        const r = await writeReceipt(c, { class: 'human_over_the_loop', runId: f.verifiedRun, workItemId: wi, decisionType: 'start_work_small', chosen: 'start', rejectedAlternative: 'wait_for_approval', dialVersion: 1, quotedInputs: [] });
        const id = (r as { id: string }).id;
        await c.query('SELECT * FROM approve_proposal_by_dial($1, $2, $3)', [f.proposal, wi, id]);
        expect((await c.query('SELECT * FROM approve_proposal_by_dial($1, $2, $3)', [f.proposal, wi, id])).rows[0]).toMatchObject({ replayed: true, envelope_id: f.envelope });
        const first = (await c.query('SELECT * FROM run_action_request_by_dial($1, $2)', [wi, id])).rows[0];
        expect((await c.query('SELECT * FROM run_action_request_by_dial($1, $2)', [wi, id])).rows[0]).toEqual({ ...first, replayed: true });
      });
      const c = await counts(f.t);
      expect([c.actions, c.approved]).toEqual([1, 1]);
    });
  });

  describe('S5b1-4: no route, token or person can approve or start as the dial', () => {
    it('the API login (app_user) cannot execute any of them, with a person, a token or nothing in the session; nor can platform_ops', async () => {
      const f = await fixture();
      const tokenId = randomUUID();
      await admin.query(`INSERT INTO api_tokens (id, account_id, created_by, name, token_hash, display_hint, scopes, expires_at) VALUES ($1, $2, $3, 'ci', $4, 'fxat_...test', '{work_items:write,runs:cancel}', now() + interval '1 day')`, [tokenId, f.t.accountId, f.t.userId, randomUUID()]);
      const calls = [
        ['SELECT * FROM approve_proposal_by_dial($1, $2, $3)', [f.proposal, f.t.workItemId, randomUUID()]],
        ['SELECT * FROM run_action_request_by_dial($1, $2)', [f.t.workItemId, randomUUID()]],
        ['SELECT * FROM proposal_gate_list_due(10)', []],
        ['SELECT work_item_set_autostart_envelope($1)', [f.t.workItemId]],
      ] as const;
      for (const [sql, args] of calls) {
        await refusedWith(withTenant(appPool, f.t.accountId, f.t.userId, (c) => c.query(sql, [...args])), '42501');
        await refusedWith(withTenant(appPool, f.t.accountId, f.t.userId, tokenId, (c) => c.query(sql, [...args])), '42501');
        await refusedWith(withTenant(appPool, f.t.accountId, (c) => c.query(sql, [...args])), '42501');
        await refusedWith(withTenant(opsPool, f.t.accountId, (c) => c.query(sql, [...args])), '42501');
        // The receipt login cannot reach the envelope helper directly either: only the dial's approval calls it.
        if (sql.includes('work_item_set_autostart_envelope')) await refusedWith(withTenant(receiptPool, f.t.accountId, (c) => c.query(sql, [...args])), '42501');
      }
    });

    it('on the receipt login, a person or a token in the session is refused before anything is read', async () => {
      const f = await fixture();
      const tokenId = randomUUID();
      await admin.query(`INSERT INTO api_tokens (id, account_id, created_by, name, token_hash, display_hint, scopes, expires_at) VALUES ($1, $2, $3, 'ci', $4, 'fxat_...test', '{work_items:write}', now() + interval '1 day')`, [tokenId, f.t.accountId, f.t.userId, randomUUID()]);
      for (const as of [(fn: (c: PoolClient) => Promise<unknown>) => withTenant(receiptPool, f.t.accountId, f.t.userId, fn), (fn: (c: PoolClient) => Promise<unknown>) => withTenant(receiptPool, f.t.accountId, f.t.userId, tokenId, fn)]) {
        await refusedWith(as((c) => c.query('SELECT * FROM approve_proposal_by_dial($1, $2, $3)', [f.proposal, f.t.workItemId, randomUUID()])), '42501');
        await refusedWith(as((c) => c.query('SELECT * FROM run_action_request_by_dial($1, $2)', [f.t.workItemId, randomUUID()])), '42501');
      }
      expect((await counts(f.t)).approved).toBe(0);
    });

    it('no API route or app source names any of the functions', () => {
      const root = fileURLToPath(new URL('../../../', import.meta.url));
      const hits: string[] = [];
      const walk = (dir: string): void => {
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (!['node_modules', 'dist', '.next', 'test', '__tests__'].includes(e.name)) walk(p);
          } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name) && !e.name.includes('.test.')) {
            const text = readFileSync(p, 'utf8');
            for (const name of NAMES) if (text.includes(name)) hits.push(`${path.relative(root, p)}: ${name}`);
          }
        }
      };
      walk(path.join(root, 'packages', 'api'));
      for (const app of readdirSync(path.join(root, 'apps'))) walk(path.join(root, 'apps', app));
      expect(hits).toEqual([]);
    });
  });

  describe('the hard rules and the free preview, at the data', () => {
    it.each([
      [{ provenance: 'external' }, 'external_needs_approval'],
      [{ owner: 'internal_loop' }, 'owned_by_internal_loop'],
      [{ verified: false }, 'not_checked'],
    ] as const)('%o refuses with %s and writes nothing', async (o, code) => {
      const f = await fixture(o);
      const before = await counts(f.t);
      await refusedWith(gate(f), '55000', code);
      expect(await counts(f.t)).toEqual(before);
    });

    it('an account that is not active (here the free preview: no checkout yet) refuses', async () => {
      const f = await fixture();
      await admin.query('UPDATE accounts SET stripe_customer_id = NULL WHERE id = $1', [f.t.accountId]);
      expect((await admin.query('SELECT status FROM accounts WHERE id = $1', [f.t.accountId])).rows[0].status).not.toBe('active');
      await refusedWith(gate(f), '55000', 'account_not_active');
    });
  });

  describe('the receipt and the dial', () => {
    it('a receipt written in an earlier transaction does not approve or start anything', async () => {
      const f = await fixture();
      const { wi, id } = await withTenant(receiptPool, f.t.accountId, async (c) => {
        const w = (await c.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'T') RETURNING id`, [f.t.accountId, f.t.repoId])).rows[0]!.id;
        const r = await writeReceipt(c, { class: 'human_over_the_loop', runId: f.verifiedRun, workItemId: w, decisionType: 'start_work_small', chosen: 'start', rejectedAlternative: 'wait_for_approval', dialVersion: 1, quotedInputs: [] });
        return { wi: w, id: (r as { id: string }).id };
      });
      await refusedWith(withTenant(receiptPool, f.t.accountId, (c) => c.query('SELECT * FROM approve_proposal_by_dial($1, $2, $3)', [f.proposal, wi, id])), '55000', 'receipt_not_in_transaction');
      await refusedWith(withTenant(receiptPool, f.t.accountId, (c) => c.query('SELECT * FROM run_action_request_by_dial($1, $2)', [wi, id])), '55000', 'receipt_not_in_transaction');
      expect((await counts(f.t)).approved).toBe(0);
    });

    it('a receipt anchored on another run, or choosing something else, is refused', async () => {
      const f = await fixture();
      const other = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'project-manager', 'local', 'pending')`, [other, f.t.accountId, f.t.workItemId]);
      await refusedWith(gate(f, { runId: other }), '55000', 'receipt_wrong_anchor');
      await refusedWith(gate(f, { chosen: 'launch' }), '55000', 'receipt_mismatch');
    });

    it('a dial that asks, the catalogue default (version 0), or a dial version that is no longer current is refused', async () => {
      const cautious = await fixture({ disposition: 'ask' });
      await refusedWith(gate(cautious), '55000', 'dial_not_open');
      const f = await fixture();
      await refusedWith(gate(f, { dialVersion: 0 }), '55000', 'dial_not_open');
      await admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, 'start_work_small', 'ask', 'cautious', 2, $3)`, [f.t.accountId, f.t.repoId, f.t.userId]);
      await refusedWith(gate(f, { dialVersion: 1 }), '55000', 'dial_not_open');
      expect((await counts(f.t)).approved).toBe(0);
    });
  });

  describe('the weekly limit and the person it acts for', () => {
    it('no weekly limit, or a limit turned off (0), starts nothing', async () => {
      await refusedWith(gate(await fixture({ amount: null })), '55000', 'autostart_off');
      await refusedWith(gate(await fixture({ amount: 0 })), '55000', 'autostart_off');
    });

    it('a limit turned off after it was set starts nothing', async () => {
      const f = await fixture();
      await admin.query(`INSERT INTO approval_envelopes (id, account_id, repo_id, scope, amount_usd, version, created_by) VALUES ($1, $2, NULL, 'weekly_autostart', 0, 2, $3)`, [f.envelope, f.t.accountId, f.t.userId]);
      await refusedWith(gate(f), '55000', 'autostart_off');
    });

    it('when the person who confirmed the limit is no longer an owner or admin, nothing starts until someone who is confirms it again', async () => {
      const f = await fixture();
      const admin2 = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [admin2, `${admin2}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [f.t.accountId, admin2]);
      await admin.query(`UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2`, [f.t.accountId, f.t.userId]);
      await refusedWith(gate(f), '55000', 'autostart_confirmer_not_admin');
      await admin.query(`INSERT INTO approval_envelopes (id, account_id, repo_id, scope, amount_usd, version, created_by) VALUES ($1, $2, NULL, 'weekly_autostart', 13, 2, $3)`, [f.envelope, f.t.accountId, admin2]);
      const g = await gate(f);
      const action = (await admin.query('SELECT requested_by FROM run_action_requests WHERE id = $1', [(g.start as { action_id: string }).action_id])).rows[0];
      expect(action).toEqual({ requested_by: `session:${admin2}` });
    });

    it('the start needs the dial approval of this receipt in the same transaction', async () => {
      const f = await fixture();
      await refusedWith(
        withTenant(receiptPool, f.t.accountId, async (c) => {
          const wi = (await c.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'T') RETURNING id`, [f.t.accountId, f.t.repoId])).rows[0]!.id;
          const r = await writeReceipt(c, { class: 'human_over_the_loop', runId: f.verifiedRun, workItemId: wi, decisionType: 'start_work_small', chosen: 'start', rejectedAlternative: 'wait_for_approval', dialVersion: 1, quotedInputs: [] });
          return c.query('SELECT * FROM run_action_request_by_dial($1, $2)', [wi, (r as { id: string }).id]);
        }),
        '55000',
        'not_dial_approved',
      );
    });
  });

  describe('decided_by_kind', () => {
    it("a person's approval is stamped 'person'; withdrawing a dial approval clears both columns", async () => {
      const f = await fixture();
      const wi = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, title) VALUES ($1, $2, $3, 'issue', 'internal', 'T')`, [wi, f.t.accountId, f.t.repoId]);
      await withTenant(appPool, f.t.accountId, f.t.userId, (c) => c.query('SELECT * FROM approve_proposal($1, $2)', [f.proposal, wi]));
      expect((await admin.query('SELECT decided_by_kind, decision_receipt_id FROM proposals WHERE id = $1', [f.proposal])).rows[0]).toEqual({ decided_by_kind: 'person', decision_receipt_id: null });

      const d = await fixture();
      await gate(d, { noStart: true });
      await withTenant(appPool, d.t.accountId, d.t.userId, (c) => c.query('SELECT * FROM withdraw_approval($1)', [d.proposal]));
      expect((await admin.query('SELECT state, decided_by_kind, decision_receipt_id FROM proposals WHERE id = $1', [d.proposal])).rows[0]).toEqual({ state: 'new', decided_by_kind: null, decision_receipt_id: null });
    });

    it('no other role writes the columns, a dial decision needs a receipt, and an approval keeps who decided it', async () => {
      const f = await fixture();
      await refusedWith(withTenant(appPool, f.t.accountId, f.t.userId, (c) => c.query(`UPDATE proposals SET decided_by_kind = 'dial' WHERE id = $1`, [f.proposal])), '42501');
      await refusedWith(admin.query(`UPDATE proposals SET state = 'approved', decided_at = now(), roadmap_position = 99, decided_by_kind = 'dial' WHERE id = $1`, [f.proposal]), '23514');
      const g = await gate(f, { noStart: true });
      await refusedWith(admin.query(`UPDATE proposals SET decided_by_kind = 'person', decision_receipt_id = NULL WHERE id = $1`, [f.proposal]), '42501');
      expect((await admin.query('SELECT decision_receipt_id FROM proposals WHERE id = $1', [f.proposal])).rows[0].decision_receipt_id).toBe(g.receipt);
    });
  });

  describe('withdrawing a dial approval (the undo path)', () => {
    const stamp = async (id: string) => (await admin.query('SELECT state, decided_by_kind, dial_withdrawn_at, dial_withdrawn_by FROM proposals WHERE id = $1', [id])).rows[0];
    const personApprove = async (f: Fixture) => {
      const wi = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, title) VALUES ($1, $2, $3, 'issue', 'internal', 'T')`, [wi, f.t.accountId, f.t.repoId]);
      await withTenant(appPool, f.t.accountId, f.t.userId, (c) => c.query('SELECT * FROM approve_proposal($1, $2)', [f.proposal, wi]));
    };

    it('a withdrawn dial approval is stamped, is not listed again, and a second gate pass approves nothing, even under a newer dial', async () => {
      const f = await fixture();
      await gate(f);
      await withTenant(appPool, f.t.accountId, f.t.userId, (c) => c.query('SELECT * FROM withdraw_approval($1)', [f.proposal]));
      const s = await stamp(f.proposal);
      expect(s).toMatchObject({ state: 'new', decided_by_kind: null, dial_withdrawn_by: f.t.userId });
      expect(s.dial_withdrawn_at).not.toBeNull();
      expect(await listed([f.proposal])).toEqual([]);
      const before = await counts(f.t);
      await refusedWith(gate(f), '55000', 'dial_withdrawn');
      await admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, 'start_work_small', 'act', 'autonomous', 2, $3)`, [f.t.accountId, f.t.repoId, f.t.userId]);
      await refusedWith(gate(f, { dialVersion: 2 }), '55000', 'dial_withdrawn');
      expect(await counts(f.t)).toEqual(before);
      expect((await stamp(f.proposal)).dial_withdrawn_at).not.toBeNull();
    });

    it("a person's own approval afterwards works and clears the stamp", async () => {
      const f = await fixture();
      await gate(f, { noStart: true });
      await withTenant(appPool, f.t.accountId, f.t.userId, (c) => c.query('SELECT * FROM withdraw_approval($1)', [f.proposal]));
      await personApprove(f);
      expect(await stamp(f.proposal)).toMatchObject({ state: 'approved', decided_by_kind: 'person', dial_withdrawn_at: null, dial_withdrawn_by: null });
    });

    it('neither the dial role nor the API login can clear or write the stamp, and the dial cannot re-approve over it', async () => {
      const f = await fixture();
      const g = await gate(f, { noStart: true });
      await withTenant(appPool, f.t.accountId, f.t.userId, (c) => c.query('SELECT * FROM withdraw_approval($1)', [f.proposal]));
      await refusedWith(withTenant(appPool, f.t.accountId, f.t.userId, (c) => c.query('UPDATE proposals SET dial_withdrawn_at = NULL WHERE id = $1', [f.proposal])), '42501');
      const asDialRole = async (sql: string, args: unknown[]) => {
        await admin.query('BEGIN');
        try {
          await admin.query('SET LOCAL ROLE dial_start_definer');
          await admin.query(`SELECT set_config('app.account_id', $1, true)`, [f.t.accountId]);
          await admin.query(sql, args);
        } finally {
          await admin.query('ROLLBACK');
        }
      };
      await refusedWith(asDialRole('UPDATE proposals SET dial_withdrawn_at = NULL, dial_withdrawn_by = NULL WHERE id = $1', [f.proposal]), '42501');
      await expect(
        asDialRole(`UPDATE proposals SET state = 'approved', decided_at = now(), roadmap_position = 77, work_item_id = $2, decided_by_kind = 'dial', decision_receipt_id = $3 WHERE id = $1`, [f.proposal, g.workItem, g.receipt]),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('only a person approves it again') });
      expect((await stamp(f.proposal)).dial_withdrawn_at).not.toBeNull();
    });
  });

  describe('the work item and the repo', () => {
    async function adminItem(f: Fixture, o: { repoId?: string; stage?: string; envelope?: string | null } = {}): Promise<string> {
      const id = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, title, stage, envelope_id) VALUES ($1, $2, $3, 'issue', 'internal', 'T', $4, $5)`, [id, f.t.accountId, o.repoId ?? f.t.repoId, o.stage ?? 'triaged', o.envelope ?? null]);
      return id;
    }

    it('refuses a repo that is no longer connected', async () => {
      const f = await fixture();
      await admin.query('UPDATE repos SET installation_id = NULL WHERE id = $1', [f.t.repoId]);
      await refusedWith(gate(f), '55000', 'repo_not_connected');
    });

    it('refuses a work item of another repo, one past triaged, and one that already draws on another envelope', async () => {
      const f = await fixture();
      const otherRepo = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, 'team')`, [otherRepo, f.t.accountId, f.t.installationId, Math.floor(Math.random() * 1e9) + 10]);
      await refusedWith(gate(f, { workItem: await adminItem(f, { repoId: otherRepo }) }), '55000', 'work_item_wrong_repo');
      await refusedWith(gate(f, { workItem: await adminItem(f, { stage: 'in_progress' }) }), '55000', 'work_item_wrong_stage');
      const itemEnvelope = randomUUID();
      await admin.query(`INSERT INTO approval_envelopes (id, account_id, repo_id, scope, amount_usd, version, created_by) VALUES ($1, $2, $3, 'item', 5, 1, $4)`, [itemEnvelope, f.t.accountId, f.t.repoId, f.t.userId]);
      await refusedWith(gate(f, { workItem: await adminItem(f, { envelope: itemEnvelope }) }), '55000', 'envelope_already_set');
      expect((await counts(f.t)).approved).toBe(0);
    });
  });

  describe('proposal_gate_list_due', () => {
    it('lists only gate-due proposals of live, active accounts with a weekly limit above 0, and pages by (verified_at, id)', async () => {
      const due = await fixture();
      const due2 = await fixture();
      const external = await fixture({ provenance: 'external' });
      const pending = await fixture({ verified: false });
      const noLimit = await fixture({ amount: null });
      const off = await fixture({ amount: 0 });
      const preview = await fixture();
      await admin.query('UPDATE accounts SET stripe_customer_id = NULL WHERE id = $1', [preview.t.accountId]);
      const wanted = [due, due2, external, pending, noLimit, off, preview].map((x) => x.proposal);
      expect(await listed(wanted)).toEqual([due.proposal, due2.proposal]);
      const first = (await receiptPool.query('SELECT * FROM proposal_gate_list_due(200)')).rows.find((r) => r.proposal_id === due.proposal);
      expect(Object.keys(first).sort()).toEqual(['account_id', 'proposal_id', 'verified_at']);
      const next = (await receiptPool.query('SELECT proposal_id FROM proposal_gate_list_due(200, $1, $2)', [first.verified_at, first.proposal_id])).rows.map((r) => r.proposal_id);
      expect(next).not.toContain(due.proposal);
      expect(next).toContain(due2.proposal);
    });

    it('refuses bad arguments', async () => {
      for (const args of [[0, null, null], [201, null, null], [null, null, null], [10, new Date().toISOString(), null], [10, null, randomUUID()]]) {
        await refusedWith(receiptPool.query('SELECT * FROM proposal_gate_list_due($1, $2, $3)', args), '22023');
      }
    });
  });
});
