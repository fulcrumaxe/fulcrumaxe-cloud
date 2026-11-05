import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CATALOGUE_VERSION } from '@fx/decisions';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * [pg] D#601 MEM-10 (migration 0986): memory_auto_approve and memory_auto_approve_reversal. Everything goes through the real logins (app_user, platform_ops)
 * and the real definer. A proposal is made as the intake makes it (memory_propose in a userless session); the dial is a decision_settings row.
 */
const NODE = 'R_kgDOAutoApprove';

describe('migration 0986: memory_auto_approve [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  let ghInst: string;
  let scopeRef: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, appPool, opsPool]) await p.end();
  });
  beforeEach(async () => {
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
    await admin.query(`UPDATE repos SET gh_node_id = $2 WHERE id = $1`, [A.repoId, NODE]);
    ghInst = (await admin.query<{ g: string }>(`SELECT gh_installation_id::text AS g FROM installations WHERE id = $1`, [A.installationId])).rows[0]!.g;
    scopeRef = `${NODE}@${ghInst}`;
    await admin.query(`UPDATE agent_runs SET work_item_id = $2 WHERE id = $1`, [A.runId, A.workItemId]);
  });

  const asApp = <T>(fn: (c: PoolClient) => Promise<T>, accountId = A.accountId, userId?: string): Promise<T> =>
    userId === undefined ? withTenant(appPool, accountId, fn) : withTenant(appPool, accountId, userId, fn);
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return 'no error';
  };
  const dial = (disposition: string, version: number, preset: string | null = null) =>
    admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, 'memory_auto_approve', $3, $4, $5, $6)`, [A.accountId, A.repoId, disposition, preset, version, A.userId]);

  interface Over { scope: string; ref: string | null; kind: string; body: string; author: string; run: string | null }
  /** A proposal as the intake files it: a userless session, provenance naming the run. */
  const propose = async (over: Partial<Over> = {}, accountId = A.accountId): Promise<string> => {
    const v: Over = { scope: 'repo', ref: scopeRef, kind: 'fact', body: `body ${randomUUID()}`, author: 'agent', run: A.runId, ...over };
    const prov = v.run === null ? {} : { source_run_id: v.run };
    return asApp(async (c) => (await c.query<{ id: string }>(`SELECT memory_propose($1,$2,$3,$4,NULL,$5,$6::jsonb) AS id`, [v.scope, v.ref, v.kind, v.body, v.author, JSON.stringify(prov)])).rows[0]!.id, accountId);
  };
  const approve = (client: PoolClient, id: string, args: { repo?: string; run?: string; version?: number } = {}) =>
    client.query<{ r: string }>('SELECT memory_auto_approve($1, $2, $3, $4, $5) AS r', [id, args.repo ?? A.repoId, args.run ?? A.runId, args.version ?? 1, CATALOGUE_VERSION]);
  const entry = async (id: string) => (await admin.query(`SELECT status, approved_by, approved_at, expires_at FROM memory_entries WHERE id = $1`, [id])).rows[0];
  const receipts = async () => (await admin.query(`SELECT * FROM decision_receipts WHERE account_id = $1 AND decision_type = 'memory_auto_approve' ORDER BY created_at`, [A.accountId])).rows;

  it('approves a proposed fact at repo scope: no person on it, one policy receipt naming the dial version, one audit row with the receipt id', async () => {
    await dial('announce', 1);
    const id = await propose();
    const out = await asApp((c) => approve(c, id));
    const e = await entry(id);
    expect(e).toMatchObject({ status: 'approved', approved_by: null, expires_at: null });
    expect(e.approved_at).not.toBeNull();
    const rs = await receipts();
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ id: out.rows[0]!.r, class: 'human_over_the_loop', chosen: 'announce', rejected_alternative: 'ask', dial_version: 1, actor: 'policy', run_id: A.runId, work_item_id: A.workItemId, catalogue_version: CATALOGUE_VERSION });
    const audit = (await admin.query(`SELECT actor, action, payload FROM audit_log WHERE payload->>'entry_id' = $1 ORDER BY created_at, id`, [id])).rows;
    expect(audit.map((a) => a.action)).toEqual(['memory.proposed', 'memory.approved']);
    expect(audit[1]).toMatchObject({ actor: 'policy:memory_auto_approve', payload: { from_status: 'proposed', to_status: 'approved', receipt_id: out.rows[0]!.r, dial_version: 1, author_kind: 'agent', kind: 'fact', scope: 'repo' } });
  });

  it('approves a command at item scope for the run\'s own work item, as an assistant too', async () => {
    await dial('announce', 1);
    const a = await propose({ scope: 'item', ref: A.workItemId, kind: 'command' });
    const b = await propose({ scope: 'item', ref: A.workItemId, kind: 'fact', author: 'assistant' });
    await asApp((c) => approve(c, a));
    await asApp((c) => approve(c, b));
    expect((await entry(a)).status).toBe('approved');
    expect((await entry(b)).status).toBe('approved');
    expect(await receipts()).toHaveLength(2);
  });

  it('refuses while the dial is not raised: no row, ask, a "use the default" version, a stale version, a lowered dial; nothing changes and no receipt is written', async () => {
    const id = await propose();
    expect(await code(asApp((c) => approve(c, id)))).toBe('42501'); // no row: the catalogue default, ask
    await dial('ask', 1);
    expect(await code(asApp((c) => approve(c, id)))).toBe('42501');
    await dial('announce', 2);
    expect(await code(asApp((c) => approve(c, id, { version: 1 })))).toBe('42501'); // the version named is no longer the current one
    await dial('ask', 3, 'default');
    expect(await code(asApp((c) => approve(c, id, { version: 2 })))).toBe('42501'); // lowered since
    expect(await code(asApp((c) => approve(c, id, { version: 3 })))).toBe('42501');
    expect(await code(asApp((c) => approve(c, id, { version: 9 })))).toBe('42501');
    expect((await entry(id)).status).toBe('proposed');
    expect(await receipts()).toHaveLength(0);
  });

  it('refuses a dial of another repository of the same account, and the repository that is not the work item\'s', async () => {
    const repo2 = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_node_id) VALUES ($1, $2, $3, 777001, 'cloud', 'R_kgDOOtherRepo')`, [repo2, A.accountId, A.installationId]);
    await admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, 'memory_auto_approve', 'announce', NULL, 1, $3)`, [A.accountId, repo2, A.userId]);
    const id = await propose();
    expect(await code(asApp((c) => approve(c, id, { repo: repo2 })))).toBe('P0002');
    // The right repository, whose dial is at ask.
    await dial('ask', 1);
    expect(await code(asApp((c) => approve(c, id)))).toBe('42501');
    expect((await entry(id)).status).toBe('proposed');
  });

  it('refuses every entry the dial may not touch, even at the raised setting: other kinds, role scope, person, import and runner authors', async () => {
    await dial('announce', 1);
    const refused: string[] = [];
    for (const kind of ['convention', 'gotcha', 'preference', 'decision']) refused.push(await propose({ kind }));
    refused.push(await propose({ scope: 'role', ref: 'executor' }));
    refused.push(await propose({ scope: 'role', ref: 'executor', kind: 'command' }));
    refused.push(await propose({ author: 'import' }));
    refused.push(await propose({ author: 'runner_agent' }));
    refused.push(await propose({ scope: 'item', ref: A.workItemId, author: 'import' }));
    refused.push(await propose({ scope: 'item', ref: A.workItemId, author: 'runner_agent', kind: 'command' }));
    for (const id of refused) {
      expect(await code(asApp((c) => approve(c, id))), id).toBe('P0002');
      expect((await entry(id)).status).toBe('proposed');
    }
    // A person's own proposal (a signed-in session) is not the agent path either.
    const person = await asApp(async (c) => (await c.query<{ id: string }>(`SELECT memory_propose('repo',$1,'fact','person text',NULL,'person','{}'::jsonb) AS id`, [scopeRef])).rows[0]!.id, A.accountId, A.userId);
    expect(await code(asApp((c) => approve(c, person)))).toBe('P0002');
    expect(await receipts()).toHaveLength(0);
  });

  it('refuses a forged claim: another run\'s entry, a run with no work item, an item entry for another item, a repo entry of another repository, an unknown entry', async () => {
    await dial('announce', 1);
    const otherRun = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, work_item_id) VALUES ($1, $2, 'executor', 'production', 'succeeded', NULL)`, [otherRun, A.accountId]);
    const second = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) SELECT $1, account_id, repo_id, kind, provenance FROM work_items WHERE id = $2`, [second, A.workItemId]);
    const noProv = await propose({ run: null });
    expect(await code(asApp((c) => approve(c, noProv)))).toBe('P0002');
    const mine = await propose();
    expect(await code(asApp((c) => approve(c, mine, { run: otherRun })))).toBe('P0002'); // not the run that proposed it
    const noItem = await propose({ run: otherRun });
    expect(await code(asApp((c) => approve(c, noItem, { run: otherRun })))).toBe('P0002'); // the run has no work item
    const wrongItem = await propose({ scope: 'item', ref: second });
    expect(await code(asApp((c) => approve(c, wrongItem)))).toBe('P0002'); // the run's item is another one
    const wrongRepo = await propose({ ref: `${NODE}@${Number(ghInst) + 1}` });
    expect(await code(asApp((c) => approve(c, wrongRepo)))).toBe('P0002');
    expect(await code(asApp((c) => approve(c, randomUUID())))).toBe('P0002');
    for (const id of [noProv, mine, noItem, wrongItem, wrongRepo]) expect((await entry(id)).status).toBe('proposed');
    expect(await receipts()).toHaveLength(0);
  });

  it('refuses another tenant: B cannot approve A\'s entry, with A\'s ids or its own', async () => {
    await dial('announce', 1);
    const id = await propose();
    expect(await code(asApp((c) => approve(c, id), B.accountId))).toBe('P0002');
    expect(await code(asApp((c) => approve(c, id, { repo: B.repoId, run: B.runId }), B.accountId))).toBe('P0002');
    expect((await entry(id)).status).toBe('proposed');
    expect(await receipts()).toHaveLength(0);
  });

  it('refuses a session that carries a person, and a platform_ops login, and a call with no account', async () => {
    await dial('announce', 1);
    const id = await propose();
    expect(await code(asApp((c) => approve(c, id), A.accountId, A.userId))).toBe('42501');
    expect(await code(withTenant(opsPool, A.accountId, (c) => approve(c, id)))).toBe('42501');
    const bare = await appPool.connect();
    try {
      expect(await code(approve(bare, id))).toBe('42501');
    } finally {
      bare.release();
    }
    expect((await entry(id)).status).toBe('proposed');
  });

  it('a replay finds the entry approved and writes no second receipt; eight concurrent calls leave one', async () => {
    await dial('announce', 1);
    const id = await propose();
    await asApp((c) => approve(c, id));
    expect(await code(asApp((c) => approve(c, id)))).toBe('P0002');
    const id2 = await propose();
    const raced = await Promise.all(Array.from({ length: 8 }, () => code(asApp((c) => approve(c, id2)))));
    expect(raced.filter((r) => r === 'no error')).toHaveLength(1);
    expect(raced.filter((r) => r === 'P0002')).toHaveLength(7);
    expect(await receipts()).toHaveLength(2);
  });

  it('an expired proposal is not approved', async () => {
    await dial('announce', 1);
    const id = await propose();
    await admin.query(`UPDATE memory_entries SET expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await code(asApp((c) => approve(c, id)))).toBe('P0002');
    expect((await entry(id)).status).toBe('proposed');
  });

  it('holds the place\'s cap: an item holds 30 approved entries, the 31st stays a proposal and leaves no receipt', async () => {
    await dial('announce', 1);
    for (let i = 0; i < 30; i += 1) {
      const id = await propose({ scope: 'item', ref: A.workItemId });
      await asApp((c) => approve(c, id));
    }
    const over = await propose({ scope: 'item', ref: A.workItemId });
    expect(await code(asApp((c) => approve(c, over)))).toBe('54000');
    expect((await entry(over)).status).toBe('proposed');
    expect(await receipts()).toHaveLength(30);
  });

  it('is one transaction with the receipt: if the receipt cannot be written, the entry stays a proposal', async () => {
    await dial('announce', 1);
    const id = await propose();
    await admin.query(`CREATE FUNCTION public.mem10_refuse_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt refused' USING ERRCODE = 'check_violation'; END $$`);
    await admin.query(`CREATE TRIGGER mem10_refuse BEFORE INSERT ON decision_receipts FOR EACH ROW WHEN (NEW.decision_type = 'memory_auto_approve') EXECUTE FUNCTION public.mem10_refuse_receipt()`);
    try {
      expect(await code(asApp((c) => approve(c, id)))).toBe('23514');
      expect((await entry(id)).status).toBe('proposed');
      expect((await admin.query(`SELECT 1 FROM audit_log WHERE payload->>'entry_id' = $1 AND action = 'memory.approved'`, [id])).rowCount).toBe(0);
    } finally {
      await admin.query(`DROP TRIGGER mem10_refuse ON decision_receipts`);
      await admin.query(`DROP FUNCTION public.mem10_refuse_receipt()`);
    }
    await asApp((c) => approve(c, id));
    expect((await entry(id)).status).toBe('approved');
  });

  it('the app login cannot do by hand what the function does: no direct update of a memory entry, no receipt insert', async () => {
    const id = await propose();
    expect(await code(asApp((c) => c.query(`UPDATE memory_entries SET status = 'approved' WHERE id = $1`, [id])))).toBe('42501');
    expect(await code(asApp((c) => c.query(`INSERT INTO decision_receipts (account_id, decision_type, class, chosen, rejected_alternative, dial_version, input_trust_classes, actor, catalogue_version) VALUES ($1, 'memory_auto_approve', 'human_over_the_loop', 'announce', 'ask', 1, '[]'::jsonb, 'policy', 1)`, [A.accountId])))).toBe('42501');
    expect((await entry(id)).status).toBe('proposed');
  });

  describe('memory_auto_approve_reversal', () => {
    const retire = (id: string) => asApp((c) => c.query(`SELECT memory_decide($1::uuid, 'retired')`, [id]), A.accountId, A.userId);
    const reverse = (id: string, userId: string | null = A.userId) =>
      asApp(async (c) => (await c.query<{ r: string | null }>('SELECT memory_auto_approve_reversal($1, $2) AS r', [id, CATALOGUE_VERSION])).rows[0]!.r, A.accountId, userId ?? undefined);

    beforeEach(async () => {
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT (account_id, user_id) DO UPDATE SET role = 'owner'`, [A.accountId, A.userId]);
      await dial('announce', 1);
    });

    it('leaves a reversal receipt attributed to the person whose session retired the entry, pointing at the policy receipt; a repeat answers the first', async () => {
      const id = await propose({ scope: 'item', ref: A.workItemId });
      const policy = (await asApp((c) => approve(c, id))).rows[0]!.r;
      await retire(id);
      const rev = await reverse(id);
      expect(rev).not.toBeNull();
      const row = (await admin.query(`SELECT decision_type, class, chosen, actor, reverses_receipt_id, run_id, work_item_id, dial_version FROM decision_receipts WHERE id = $1`, [rev])).rows[0];
      expect(row).toMatchObject({ decision_type: 'reversal_recorded', class: 'human_over_the_loop', chosen: 'reversed', actor: A.userId, reverses_receipt_id: policy, run_id: A.runId, work_item_id: A.workItemId, dial_version: 1 });
      expect(await reverse(id)).toBe(rev);
      expect((await admin.query(`SELECT 1 FROM decision_receipts WHERE reverses_receipt_id = $1`, [policy])).rowCount).toBe(1);
    });

    it('writes nothing for an entry a person approved, refuses an entry that is not retired, and refuses a session with no person', async () => {
      const person = await propose({ scope: 'item', ref: A.workItemId });
      await asApp((c) => c.query(`SELECT memory_decide($1::uuid, 'approved')`, [person]), A.accountId, A.userId);
      await retire(person);
      expect(await reverse(person)).toBeNull();
      const auto = await propose({ scope: 'item', ref: A.workItemId });
      await asApp((c) => approve(c, auto));
      expect(await code(reverse(auto))).toBe('P0002'); // still approved
      await retire(auto);
      expect(await code(reverse(auto, null))).toBe('42501');
      // A person's restore after the policy's approval means the policy's approval is no longer the step in force: nothing to reverse.
      await asApp((c) => c.query(`SELECT memory_decide($1::uuid, 'approved')`, [auto]), A.accountId, A.userId);
      await retire(auto);
      expect(await reverse(auto)).toBeNull();
      expect((await admin.query(`SELECT 1 FROM decision_receipts WHERE reverses_receipt_id IS NOT NULL AND account_id = $1`, [A.accountId])).rowCount).toBe(0);
    });

    // MEM-10 (migration 0993): the other two Undos of an auto-approved entry. Each helper is one person's click.
    const decide = (id: string, to: string) => asApp((c) => c.query(`SELECT memory_decide($1::uuid, $2)`, [id, to]), A.accountId, A.userId);
    const del = (id: string, restore = false) => asApp((c) => c.query(`SELECT memory_delete($1::uuid, $2)`, [id, restore]), A.accountId, A.userId);
    const auto = async (): Promise<{ id: string; policy: string }> => {
      const id = await propose({ scope: 'item', ref: A.workItemId });
      return { id, policy: (await asApp((c) => approve(c, id))).rows[0]!.r };
    };
    const reversalsOf = async (policy: string) => (await admin.query(`SELECT id, actor, chosen FROM decision_receipts WHERE reverses_receipt_id = $1`, [policy])).rows;
    const totalReversals = async () => (await admin.query(`SELECT 1 FROM decision_receipts WHERE reverses_receipt_id IS NOT NULL AND account_id = $1`, [A.accountId])).rowCount;

    it('retire, undo approval and delete of an auto-approved entry each write exactly one receipt, in the person\'s name, and a replay writes no second', async () => {
      const [r, u, d] = [await auto(), await auto(), await auto()];
      await retire(r.id);
      await decide(u.id, 'proposed');
      await del(d.id);
      for (const e of [r, u, d]) {
        const first = await reverse(e.id);
        expect(first).not.toBeNull();
        expect(await reverse(e.id)).toBe(first);
        expect(await reversalsOf(e.policy)).toEqual([{ id: first, actor: A.userId, chosen: 'reversed' }]);
      }
      expect(await totalReversals()).toBe(3);
    });

    it('an Undo of an approval a person made writes nothing: approved by hand, approved by hand after the policy\'s Undo, retired then restored by hand', async () => {
      const byHand = await propose({ scope: 'item', ref: A.workItemId });
      await decide(byHand, 'approved');
      await decide(byHand, 'proposed');
      expect(await reverse(byHand)).toBeNull();
      await decide(byHand, 'approved');
      await del(byHand);
      expect(await reverse(byHand)).toBeNull();
      // The policy approved, a person undid it, a person approved it by hand, a person undid that: the step before the last Undo is the person's.
      const again = await auto();
      await decide(again.id, 'proposed');
      await decide(again.id, 'approved');
      await decide(again.id, 'proposed');
      expect(await reverse(again.id)).toBeNull();
      // Policy approval, retire, a person's restore, delete: the restore is the step in force.
      const restored = await auto();
      await retire(restored.id);
      await decide(restored.id, 'approved');
      await del(restored.id);
      expect(await reverse(restored.id)).toBeNull();
      expect(await totalReversals()).toBe(0);
    });

    it('an entry that was never auto-approved writes nothing: waiting, rejected then reconsidered, deleted while waiting, deleted after a retire', async () => {
      const waiting = await propose({ scope: 'item', ref: A.workItemId });
      expect(await reverse(waiting)).toBeNull();
      await decide(waiting, 'rejected');
      await decide(waiting, 'proposed'); // a reconsider writes memory.reverted too, but from rejected
      expect(await reverse(waiting)).toBeNull();
      const gone = await propose({ scope: 'item', ref: A.workItemId });
      await del(gone);
      expect(await reverse(gone)).toBeNull();
      // Policy-approved, undone (receipt), rejected, reconsidered: the reconsider is not an Undo of an approval, so nothing new.
      const e = await auto();
      await decide(e.id, 'proposed');
      const first = await reverse(e.id);
      await decide(e.id, 'rejected');
      await decide(e.id, 'proposed');
      expect(await reverse(e.id)).toBeNull();
      expect(await reversalsOf(e.policy)).toHaveLength(1);
      expect(first).not.toBeNull();
      // Retired (receipt), then deleted: the entry was not approved when it was deleted.
      const r = await auto();
      await retire(r.id);
      expect(await reverse(r.id)).not.toBeNull();
      await del(r.id);
      expect(await reverse(r.id)).toBeNull();
      expect(await reversalsOf(r.policy)).toHaveLength(1);
    });

    it('holds each guard on its own, against states the screens cannot produce (rows written by hand): the Undo must be of an approval, the step before it and the step in force must be the policy\'s approval', async () => {
      const forge = (id: string, actor: string, action: string, payload: Record<string, unknown>) =>
        admin.query(`INSERT INTO audit_log (account_id, actor, action, payload) VALUES ($1, $2, $3, $4::jsonb)`, [A.accountId, actor, action, JSON.stringify({ entry_id: id, ...payload })]);
      const setStatus = (id: string, to: string) => admin.query(`UPDATE memory_entries SET status = $2 WHERE id = $1`, [id, to]);
      // A proposed entry whose latest step is a revert FROM REJECTED (a reconsider) right after the policy's approval: not an Undo of an approval.
      const reconsidered = await auto();
      await setStatus(reconsidered.id, 'proposed');
      await forge(reconsidered.id, A.userId, 'memory.reverted', { from_status: 'rejected', to_status: 'proposed' });
      expect(await reverse(reconsidered.id)).toBeNull();
      // A proposed entry whose latest step is a policy approval (written to look like an approval of an approved entry), not a revert.
      const noRevert = await auto();
      await setStatus(noRevert.id, 'proposed');
      await forge(noRevert.id, 'policy:memory_auto_approve', 'memory.approved', { receipt_id: noRevert.policy, from_status: 'approved' });
      expect(await reverse(noRevert.id)).toBeNull();
      // A retired entry whose latest step carries the policy\'s receipt id but is a person\'s approval, or is the policy\'s restore rather than its approval.
      const personRow = await auto();
      await setStatus(personRow.id, 'retired');
      await forge(personRow.id, A.userId, 'memory.approved', { receipt_id: personRow.policy });
      expect(await reverse(personRow.id)).toBeNull();
      const restoreRow = await auto();
      await setStatus(restoreRow.id, 'retired');
      await forge(restoreRow.id, 'policy:memory_auto_approve', 'memory.restored', { receipt_id: restoreRow.policy });
      expect(await reverse(restoreRow.id)).toBeNull();
      expect(await totalReversals()).toBe(0);
    });

    it('refuses an entry that is still in force or in another state the Undos do not reach, and another account\'s entry, for every Undo', async () => {
      const live = await auto();
      expect(await code(reverse(live.id))).toBe('P0002'); // approved
      const rejected = await propose({ scope: 'item', ref: A.workItemId });
      await decide(rejected, 'rejected');
      expect(await code(reverse(rejected))).toBe('P0002');
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT (account_id, user_id) DO UPDATE SET role = 'owner'`, [B.accountId, B.userId]);
      const other = (id: string) => asApp(async (c) => c.query('SELECT memory_auto_approve_reversal($1, $2)', [id, CATALOGUE_VERSION]), B.accountId, B.userId);
      const [u, d] = [await auto(), await auto()];
      await decide(u.id, 'proposed');
      await del(d.id);
      expect(await code(other(u.id))).toBe('P0002');
      expect(await code(other(d.id))).toBe('P0002');
      expect(await totalReversals()).toBe(0);
    });

    it('another account cannot reverse this one\'s entry', async () => {
      const id = await propose({ scope: 'item', ref: A.workItemId });
      await asApp((c) => approve(c, id));
      await retire(id);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT (account_id, user_id) DO UPDATE SET role = 'owner'`, [B.accountId, B.userId]);
      expect(await code(asApp(async (c) => c.query('SELECT memory_auto_approve_reversal($1, $2)', [id, CATALOGUE_VERSION]), B.accountId, B.userId))).toBe('P0002');
    });
  });

  describe('shape', () => {
    it('the role cannot log in, is a member of the receipt invoker only, holds no INSERT on decision_receipts or UPDATE beyond four columns; both functions are pinned and executable by app_user alone', async () => {
      const role = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = 'memory_auto_approve_definer'`);
      expect(Object.values(role.rows[0]).every((v) => v === false)).toBe(true);
      expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = 'memory_auto_approve_definer'::regrole`)).rowCount).toBe(0);
      const memberOf = await admin.query<{ r: string }>(`SELECT pg_get_userbyid(roleid) AS r FROM pg_auth_members WHERE member = 'memory_auto_approve_definer'::regrole`);
      expect(memberOf.rows.map((r) => r.r)).toEqual(['receipt_writer_invoker']);
      expect((await admin.query(`SELECT has_table_privilege('memory_auto_approve_definer', 'decision_receipts', 'INSERT') AS ok`)).rows[0].ok).toBe(false);
      expect((await admin.query(`SELECT has_table_privilege('memory_auto_approve_definer', 'memory_entries', 'DELETE') AS ok`)).rows[0].ok).toBe(false);
      for (const col of ['body', 'kind', 'scope', 'author_kind', 'approved_by', 'provenance']) {
        expect((await admin.query(`SELECT has_column_privilege('memory_auto_approve_definer', 'memory_entries', $1, 'UPDATE') AS ok`, [col])).rows[0].ok, col).toBe(false);
      }
      for (const sig of ['memory_auto_approve(uuid,uuid,uuid,integer,integer)', 'memory_auto_approve_reversal(uuid,integer)']) {
        const fn = await admin.query(
          `SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
                  (SELECT array_agg(DISTINCT pg_get_userbyid(a.grantee)::text) FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) AS grantees
             FROM pg_proc p WHERE p.oid = $1::regprocedure`,
          [sig],
        );
        expect(fn.rows[0], sig).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], owner: 'memory_auto_approve_definer', grantees: ['app_user'] });
      }
    });
  });
});
