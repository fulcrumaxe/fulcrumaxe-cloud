import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { CATALOGUE_VERSION } from '@fx/decisions';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { deleteMemory, editMemory, type MemoryCtx } from '../src/memory/index.js';
import { MEMORY_PROPOSALS_EVENT_KIND, ingestMemoryProposals, type IngestMemoryProposalsInput, type MemoryProposalsEvent } from '../src/memory/intake.js';
import { revertMemory } from '../src/memory/undo.js';
import { memoryAutoApproved, memoryQueue } from '../src/memory/view.js';
import { memoryHistory } from '../src/memory/history.js';

const NODE = 'R_kgDOAutoApprvd';

/** D#601 MEM-10: the intake approves a low-risk proposal by the repository's dial, in its own transaction, against a real Postgres (the app_user login, the definers). */
describe('memory auto-approve dial in the intake (D#601 MEM-10)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let owner: string;
  let repoRef: string;

  async function newRun(workItem: string | null = a.workItemId): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1,$2,$3,'executor','local','succeeded')`, [id, a.accountId, workItem]);
    return id;
  }
  const recordEvent = (accountId: string, runId: string) => async (client: PoolClient, event: MemoryProposalsEvent) => {
    const { rows } = await client.query<{ next: string }>('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = $1', [runId]);
    await client.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, $4, $5)`, [accountId, runId, rows[0]!.next, MEMORY_PROPOSALS_EVENT_KIND, JSON.stringify(event)]);
  };
  async function ingest(runId: string, proposals: unknown, extra: Partial<IngestMemoryProposalsInput> = {}, workItem: string | null = a.workItemId) {
    return ingestMemoryProposals({
      pool: appPool,
      accountId: a.accountId,
      runId,
      workItemId: workItem,
      role: 'executor',
      source: 'agent',
      envelope: { verdict: 'done', memory_proposals: proposals },
      liveSecrets: () => [],
      resolveRepoScopeRef: async () => repoRef,
      dialRepoId: workItem === null ? null : a.repoId,
      recordEvent: recordEvent(a.accountId, runId),
      ...extra,
    });
  }
  const ctx = (): MemoryCtx => ({ pool: appPool, principal: { accountId: a.accountId, userId: owner }, liveSecrets: () => [] });
  const setDial = async (disposition: 'ask' | 'announce', version: number) =>
    admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, 'memory_auto_approve', $3, NULL, $4, $5)`, [a.accountId, a.repoId, disposition, version, owner]);
  const status = async (body: string) => (await admin.query(`SELECT status, approved_by, author_kind FROM memory_entries WHERE account_id = $1 AND body = $2`, [a.accountId, body])).rows[0];
  const receipts = async (type = 'memory_auto_approve') => (await admin.query(`SELECT * FROM decision_receipts WHERE account_id = $1 AND decision_type = $2 ORDER BY created_at`, [a.accountId, type])).rows;
  const eventOf = async (runId: string) => (await admin.query(`SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'memory.proposals'`, [runId])).rows[0]?.payload as MemoryProposalsEvent;
  let n = 0;
  const text = (label: string) => `${label} ${++n} ${randomUUID().slice(0, 8)}`;
  const fact = (body: string, scope = 'repo') => ({ scope, kind: 'fact', body });

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });
  beforeEach(async () => {
    a = await seedAccount(admin, randomUUID());
    owner = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [owner, `${owner}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [a.accountId, owner]);
    await admin.query(`UPDATE repos SET gh_node_id = $2 WHERE id = $1`, [a.repoId, NODE]);
    const inst = (await admin.query<{ g: string }>(`SELECT gh_installation_id::text AS g FROM installations WHERE id = $1`, [a.installationId])).rows[0]!.g;
    repoRef = `${NODE}@${inst}`;
  });

  it('criterion 2: with no dial row, and with the dial at ask, nothing is approved and the queue holds every proposal; raised, the same proposals are approved (a pair)', async () => {
    const proposals = [fact(text('repo fact')), { scope: 'item', kind: 'command', body: text('item command') }];
    const bodies = proposals.map((p) => p.body);
    const run1 = await newRun();
    await ingest(run1, proposals);
    for (const b of bodies) expect(await status(b)).toMatchObject({ status: 'proposed', approved_by: null });
    expect((await eventOf(run1)).stored.every((s) => s.auto === undefined)).toBe(true);
    expect((await memoryQueue(ctx())).cards.map((c) => c.entry.body)).toEqual(expect.arrayContaining(bodies));

    await setDial('ask', 1);
    const askBodies = [text('ask fact'), text('ask command')];
    await ingest(await newRun(), [fact(askBodies[0]!), { scope: 'item', kind: 'command', body: askBodies[1]! }]);
    for (const b of askBodies) expect((await status(b)).status).toBe('proposed');
    expect(await receipts()).toHaveLength(0);

    await setDial('announce', 2);
    const raisedBodies = [text('raised fact'), text('raised command')];
    const run3 = await newRun();
    await ingest(run3, [fact(raisedBodies[0]!), { scope: 'item', kind: 'command', body: raisedBodies[1]! }]);
    for (const b of raisedBodies) expect(await status(b)).toMatchObject({ status: 'approved', approved_by: null, author_kind: 'agent' });
    expect((await eventOf(run3)).stored.map((s) => s.auto)).toEqual(['approved', 'approved']);
    expect((await memoryQueue(ctx())).cards.map((c) => c.entry.body)).not.toEqual(expect.arrayContaining(raisedBodies));
  });

  it('criterion 3: raised, each approved proposal leaves one class 2 policy receipt naming the dial version; a re-ingest of the same run writes no second one', async () => {
    await setDial('announce', 1);
    const run = await newRun();
    const body = text('receipt fact');
    expect((await ingest(run, [fact(body)])).status).toBe('ingested');
    const rs = await receipts();
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ class: 'human_over_the_loop', actor: 'policy', chosen: 'announce', rejected_alternative: 'ask', dial_version: 1, run_id: run, work_item_id: a.workItemId, catalogue_version: CATALOGUE_VERSION, input_trust_classes: ['untrusted'] });
    expect(rs[0].reversal_free_until).not.toBeNull();
    expect((await ingest(run, [fact(body), fact(text('again'))])).status).toBe('already_ingested');
    expect(await receipts()).toHaveLength(1);
    // The history says who: the setting, not a person.
    const id = (await admin.query(`SELECT id FROM memory_entries WHERE body = $1`, [body])).rows[0].id as string;
    expect((await memoryHistory(ctx(), id)).at(-1)).toMatchObject({ action: 'memory.approved', actor: { kind: 'system', source: 'autonomy_setting' } });
  });

  it('criterion 4: no other kind, no role or account scope, is ever approved, at any level', async () => {
    await setDial('announce', 1);
    const run = await newRun();
    const kinds = ['convention', 'gotcha', 'preference', 'decision'];
    const proposals: Array<Record<string, unknown>> = kinds.map((kind) => ({ scope: 'repo', kind, body: text(`${kind} repo`) }));
    proposals.push({ scope: 'item', kind: 'gotcha', body: text('gotcha item') });
    await ingest(run, proposals.slice(0, 3));
    const run2 = await newRun();
    await ingest(run2, proposals.slice(3));
    const run3 = await newRun();
    const roleFact = { scope: 'role', kind: 'fact', body: text('role fact') };
    const roleCmd = { scope: 'role', kind: 'command', body: text('role command') };
    const account = { scope: 'account', kind: 'fact', body: text('account fact') };
    const out = await ingest(run3, [roleFact, roleCmd, account], { allowRoleScope: true, itemTerminal: true });
    expect(out).toMatchObject({ status: 'ingested' });
    for (const p of proposals.slice(0, 5)) expect((await status(p.body as string))?.status, p.body as string).toBe('proposed');
    expect((await status(roleFact.body)).status).toBe('proposed');
    expect((await status(roleCmd.body)).status).toBe('proposed');
    expect(await status(account.body)).toBeUndefined(); // refused today: account entries are person-written only
    expect(await receipts()).toHaveLength(0);
  });

  it('criterion 5: runner-sourced and imported proposals are never approved, and a forged author, status or approval field in the payload changes nothing', async () => {
    await setDial('announce', 1);
    const runnerBody = text('runner fact');
    const runnerRun = await newRun();
    await ingest(runnerRun, [fact(runnerBody)], { source: 'runner_agent' });
    expect(await status(runnerBody)).toMatchObject({ status: 'proposed', author_kind: 'runner_agent' });
    // The dial is not even tried for these sources: no outcome on the event (not 'refused' by the database).
    expect((await eventOf(runnerRun)).stored.map((s) => s.auto)).toEqual([undefined]);
    const importBody = text('import fact');
    const importRun = await newRun();
    await ingest(importRun, [fact(importBody)], { source: 'import' as unknown as 'agent' });
    expect(await status(importBody)).toMatchObject({ status: 'proposed', author_kind: 'import' });
    expect((await eventOf(importRun)).stored.map((s) => s.auto)).toEqual([undefined]);
    // The in-product path stays "agent" whatever the payload claims.
    const forged = text('forged fact');
    await ingest(await newRun(), [{ ...fact(forged), author_kind: 'person', source: 'person', status: 'approved', approved_by: owner, dial: 'announce' }]);
    expect(await status(forged)).toMatchObject({ status: 'approved', approved_by: null, author_kind: 'agent' });
    expect(await receipts()).toHaveLength(1);
    // Gated entries wait in the queue, unopened, for a person to open each.
    const cards = (await memoryQueue(ctx())).cards.filter((c) => [runnerBody, importBody].includes(c.entry.body));
    expect(cards.map((c) => c.openState)).toEqual(['unopened', 'unopened']);
  });

  it('criterion 6: a secret, a duplicate, an oversize body and a full pending queue are refused exactly as before and never reach the dial', async () => {
    await setDial('announce', 1);
    const dup = text('dup fact');
    await ingest(await newRun(), [fact(dup)]);
    const run = await newRun();
    const secret = ['ghs', '_', 'Zq81LiveTokenValue', 'aB3dE5fG7hJ9kL'].join(''); // gitleaks:allow
    const out = await ingest(run, [fact(dup.toUpperCase()), fact(`has a ${secret} inside`), fact('x'.repeat(1025))], { liveSecrets: () => [secret] });
    expect(out).toMatchObject({ status: 'ingested', stored: [] });
    expect((out as { refused: Array<{ reason: string }> }).refused.map((r) => r.reason)).toEqual(['duplicate', 'secret_detected', 'invalid_message']);
    expect(await receipts()).toHaveLength(1); // only the first, accepted one
  });

  it('criterion 7: lowering the dial stops the next approval at once; entries approved earlier stay approved and each can be retired, with a reversal receipt in the clicker\'s name', async () => {
    await setDial('announce', 1);
    const first = text('before lowering');
    await ingest(await newRun(), [fact(first)]);
    await setDial('ask', 2);
    const second = text('after lowering');
    await ingest(await newRun(), [fact(second)]);
    expect((await status(first)).status).toBe('approved');
    expect((await status(second)).status).toBe('proposed');
    const firstId = (await admin.query(`SELECT id FROM memory_entries WHERE body = $1`, [first])).rows[0].id as string;
    // Still listed under the autonomy heading: the dial is derived at each proposal, never stamped.
    expect((await memoryAutoApproved(ctx())).cards.map((c) => c.entry.id)).toEqual([firstId]);
    const out = await revertMemory(ctx(), { ids: [firstId], action: 'retire' });
    expect(out.entries[0]!.status).toBe('retired');
    const rev = (await receipts('reversal_recorded'))[0];
    expect(rev).toMatchObject({ actor: owner, chosen: 'reversed', reverses_receipt_id: (await receipts())[0].id });
    expect((await memoryAutoApproved(ctx())).cards).toEqual([]);
  });

  it('undo approval and delete of an auto-approved entry each leave one reversal receipt in the clicker\'s name, and a restore then a second delete leave no more', async () => {
    await setDial('announce', 1);
    const [undone, deleted] = [text('undone'), text('deleted')];
    await ingest(await newRun(), [fact(undone), fact(deleted)]);
    const [uId, dId] = [await idOf(undone), await idOf(deleted)];
    const policy = await receipts();
    expect(policy).toHaveLength(2);
    await revertMemory(ctx(), { ids: [uId], action: 'undo_approve' });
    expect((await status(undone)).status).toBe('proposed');
    await deleteMemory(ctx(), { id: dId });
    expect((await status(deleted)).status).toBe('deleted');
    const reversals = await receipts('reversal_recorded');
    expect(reversals.map((r) => r.reverses_receipt_id).sort()).toEqual(policy.map((r) => r.id).sort());
    for (const r of reversals) expect(r).toMatchObject({ actor: owner, chosen: 'reversed' });
    await deleteMemory(ctx(), { id: dId, restore: true });
    await deleteMemory(ctx(), { id: dId });
    expect(await receipts('reversal_recorded')).toHaveLength(2);
  });

  it('the review screen\'s list: place and run are words, never null; a person\'s approval, a retired entry and a restored one are not listed', async () => {
    await setDial('announce', 1);
    const bodies = [text('listed one'), text('listed two')];
    const run = await newRun();
    await ingest(run, bodies.map((b) => fact(b)));
    // A person's approval of a proposal.
    const manual = text('manual fact');
    await setDialAskFor(manual);
    const cards = (await memoryAutoApproved(ctx())).cards;
    expect(cards.map((c) => c.entry.body).sort()).toEqual([...bodies].sort());
    for (const c of cards) {
      expect(c.scopeLabel).not.toMatch(/null|undefined|NaN/);
      expect(c.proposedBy).toContain(run.slice(0, 8));
      expect(c.approvedAge).toBe('Just now');
    }
    const id = cards[0]!.entry.id;
    await revertMemory(ctx(), { ids: [id], action: 'retire' });
    await revertMemory(ctx(), { ids: [id], action: 'restore_retired' }); // a person's restore: no longer the setting's approval
    expect((await memoryAutoApproved(ctx())).cards.map((c) => c.entry.id)).not.toContain(id);
  });

  async function setDialAskFor(body: string): Promise<void> {
    // Lower the dial, file a proposal, and approve it by hand as a person would.
    await setDial('ask', 2);
    await ingest(await newRun(), [fact(body)]);
    const id = (await admin.query(`SELECT id FROM memory_entries WHERE body = $1`, [body])).rows[0].id as string;
    await appPool.connect().then(async (c) => {
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)`, [a.accountId, owner]);
        await c.query(`SELECT memory_decide($1::uuid, 'approved')`, [id]);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
    });
    await setDial('announce', 3);
  }

  async function decideAsOwner(id: string, to: 'approved' | 'rejected'): Promise<void> {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)`, [a.accountId, owner]);
      await c.query(`SELECT memory_decide($1::uuid, $2)`, [id, to]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  }
  const idOf = async (body: string) => (await admin.query(`SELECT id FROM memory_entries WHERE account_id = $1 AND body = $2 ORDER BY created_at DESC LIMIT 1`, [a.accountId, body])).rows[0].id as string;

  it('a person\'s Undo holds: the same text proposed again after a retire is left for a person (no second approval, no second receipt); a reworded text is still approved', async () => {
    await setDial('announce', 1);
    const body = text('undone fact');
    await ingest(await newRun(), [fact(body)]);
    expect((await status(body)).status).toBe('approved');
    await revertMemory(ctx(), { ids: [await idOf(body)], action: 'retire' });
    expect(await receipts()).toHaveLength(1);
    const run2 = await newRun();
    await ingest(run2, [fact(body.toUpperCase())]);
    expect((await admin.query(`SELECT status FROM memory_entries WHERE account_id = $1 AND lower(body) = lower($2) ORDER BY created_at`, [a.accountId, body])).rows.map((r) => r.status)).toEqual(['retired', 'proposed']);
    expect((await eventOf(run2)).stored.map((s) => s.auto)).toEqual(['previously_declined']);
    expect(await receipts()).toHaveLength(1);
    // The limit, stated: this is a floor for honest repeats. A reworded proposal has another hash and is treated as new.
    const reworded = `${body} (reworded)`;
    await ingest(await newRun(), [fact(reworded)]);
    expect((await status(reworded)).status).toBe('approved');
  });

  it('a person\'s reject holds: after the dial is raised, the same text proposed again waits for a person', async () => {
    await setDial('ask', 1);
    const body = text('rejected fact');
    await ingest(await newRun(), [fact(body)]);
    await decideAsOwner(await idOf(body), 'rejected');
    expect((await status(body)).status).toBe('rejected');
    await setDial('announce', 2);
    const run2 = await newRun();
    await ingest(run2, [fact(body)]);
    expect((await admin.query(`SELECT status FROM memory_entries WHERE account_id = $1 AND body = $2 ORDER BY created_at`, [a.accountId, body])).rows.map((r) => r.status)).toEqual(['rejected', 'proposed']);
    expect((await eventOf(run2)).stored.map((s) => s.auto)).toEqual(['previously_declined']);
    expect(await receipts()).toHaveLength(0);
    // A decline covers the whole repository: the same words at item scope are left for a person too.
    const itemRun = await newRun();
    await ingest(itemRun, [{ scope: 'item', kind: 'fact', body }]);
    expect((await eventOf(itemRun)).stored.map((s) => s.auto)).toEqual(['previously_declined']);
  });

  it('the cap lock is held: while a person\'s open approval holds the place\'s cap lock the dial waits, then finds the place full and leaves its entry for a person', async () => {
    const person = text('person approval');
    const dialBody = text('dial approval');
    await ingest(await newRun(), [{ scope: 'item', kind: 'fact', body: person }]); // no dial yet: it waits
    for (let i = 0; i < 29; i += 1) {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO memory_entries (id, account_id, scope, scope_ref, kind, body, author_kind, provenance, status, version, content_sha256) VALUES ($1,$2,'item',$3,'fact',$4,'person','{}'::jsonb,'approved',1,encode(sha256(convert_to($4,'UTF8')),'hex'))`,
        [id, a.accountId, a.workItemId, `lockfiller ${i} ${id}`],
      );
    }
    await setDial('announce', 1);
    const holder = await appPool.connect();
    let settled = false;
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)`, [a.accountId, owner]);
      await holder.query(`SELECT memory_decide($1::uuid, 'approved')`, [await idOf(person)]); // the 30th entry; the cap lock is held until COMMIT
      const run = await newRun();
      pending = ingest(run, [{ scope: 'item', kind: 'fact', body: dialBody }]).finally(() => {
        settled = true;
      });
      let waiting = false;
      for (let i = 0; i < 100 && !waiting && !settled; i += 1) {
        waiting = (await admin.query(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)).rowCount! > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 50));
      }
      expect(waiting, 'the dial waits on the held cap lock').toBe(true);
      expect(settled).toBe(false);
      await holder.query('COMMIT');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    await pending;
    expect(settled).toBe(true);
    expect((await status(dialBody)).status).toBe('proposed');
    const count = (await admin.query(`SELECT count(*)::int AS n FROM memory_entries WHERE account_id = $1 AND scope = 'item' AND scope_ref = $2 AND status = 'approved'`, [a.accountId, a.workItemId])).rows[0].n;
    expect(count).toBe(30);
    expect(await receipts()).toHaveLength(0);
  });

  it('the autonomy list is derived from the step that put the entry in force: an entry the setting approved and a person later restored, and one a person approved with no approver recorded, are not listed', async () => {
    const run = await newRun();
    const mk = async (body: string, audits: Array<[string, string, string]>) => {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO memory_entries (id, account_id, scope, scope_ref, kind, body, author_kind, provenance, status, version, approved_at, content_sha256)
         VALUES ($1,$2,'repo',$3,'fact',$4,'agent',$5::jsonb,'approved',1,now(),encode(sha256(convert_to($4,'UTF8')),'hex'))`,
        [id, a.accountId, repoRef, body, JSON.stringify({ source_run_id: run })],
      );
      for (const [actor, action, ago] of audits) {
        await admin.query(`INSERT INTO audit_log (account_id, actor, action, payload, created_at) VALUES ($1,$2,$3,$4::jsonb, now() - $5::interval)`, [a.accountId, actor, action, JSON.stringify({ entry_id: id }), ago]);
      }
      return id;
    };
    const policy = await mk(text('listed policy'), [['policy:memory_auto_approve', 'memory.approved', '2 minutes']]);
    const restored = await mk(text('policy then person'), [['policy:memory_auto_approve', 'memory.approved', '3 minutes'], [owner, 'memory.restored', '1 minute']]);
    const byPerson = await mk(text('person only'), [[owner, 'memory.approved', '2 minutes']]);
    const ids = (await memoryAutoApproved(ctx())).cards.map((c) => c.entry.id);
    expect(ids).toContain(policy);
    expect(ids).not.toContain(restored);
    expect(ids).not.toContain(byPerson);
  });

  /** The same text coming back: it must be stored as a waiting proposal, with the fixed word, and no receipt may be added. */
  async function expectLeftForPerson(body: string, scope: 'repo' | 'item' = 'repo'): Promise<void> {
    const before = (await receipts()).length;
    const run = await newRun();
    await ingest(run, [{ scope, kind: 'fact', body }]);
    expect((await eventOf(run)).stored.map((x) => x.auto)).toEqual(['previously_declined']);
    const newest = (await admin.query(`SELECT status FROM memory_entries WHERE account_id = $1 AND body = $2 ORDER BY created_at DESC LIMIT 1`, [a.accountId, body])).rows[0];
    expect(newest.status).toBe('proposed');
    expect(await receipts()).toHaveLength(before);
  }

  it('a person\'s Delete holds: approved by the dial, deleted, then the same text comes back with the dial raised', async () => {
    await setDial('announce', 1);
    const body = text('deleted after approval');
    await ingest(await newRun(), [fact(body)]);
    expect((await status(body)).status).toBe('approved');
    await deleteMemory(ctx(), { id: await idOf(body) });
    expect((await status(body)).status).toBe('deleted');
    await expectLeftForPerson(body);
  });

  it('a person\'s Delete holds after an Undo: retired, then deleted, then the same text comes back', async () => {
    await setDial('announce', 1);
    const body = text('retired then deleted');
    await ingest(await newRun(), [fact(body)]);
    const id = await idOf(body);
    await revertMemory(ctx(), { ids: [id], action: 'retire' });
    await deleteMemory(ctx(), { id });
    expect((await status(body)).status).toBe('deleted');
    await expectLeftForPerson(body);
  });

  it('a person\'s Delete holds after a reject: rejected, deleted, the dial is raised, then the same text comes back', async () => {
    await setDial('ask', 1);
    const body = text('rejected then deleted');
    await ingest(await newRun(), [fact(body)]);
    const id = await idOf(body);
    await decideAsOwner(id, 'rejected');
    await deleteMemory(ctx(), { id });
    expect((await status(body)).status).toBe('deleted');
    await setDial('announce', 2);
    await expectLeftForPerson(body);
  });

  it('a person\'s edit holds: the entry is corrected by an edit, then the old text comes back with the dial raised', async () => {
    await setDial('announce', 1);
    const body = text('before the correction');
    await ingest(await newRun(), [fact(body)]);
    const id = await idOf(body);
    await editMemory(ctx(), { id, body: `${body} corrected` });
    expect((await status(body)).status).toBe('superseded');
    await expectLeftForPerson(body);
  });

  it('a no covers the whole repository: an item-scope no stops the text at repo scope, and a repo-scope no stops it at item scope', async () => {
    await setDial('ask', 1);
    const first = text('declined at item');
    await ingest(await newRun(), [{ scope: 'item', kind: 'fact', body: first }]);
    await decideAsOwner(await idOf(first), 'rejected');
    const second = text('declined at repo');
    await ingest(await newRun(), [fact(second)]);
    await decideAsOwner(await idOf(second), 'rejected');
    await setDial('announce', 2);
    await expectLeftForPerson(first, 'repo');
    await expectLeftForPerson(second, 'item');
  });

  /** An entry in a given state written straight into the table, with the audit row of the step that put it there (actor `by`; none when null). */
  async function seedEntry(scope: string, scopeRef: string | null, body: string, st: string, by: string | null, ageDays = 0, count = 1) {
    await admin.query(
      `WITH ins AS (
         INSERT INTO memory_entries (account_id, scope, scope_ref, kind, body, author_kind, status, content_sha256, updated_at, deleted_at)
         SELECT $1, $2, $3, 'fact', CASE WHEN $4::int = 1 THEN $5 ELSE $5 || ' #' || g END, 'person', $6,
                encode(sha256(convert_to(CASE WHEN $4::int = 1 THEN $5 ELSE $5 || ' #' || g END, 'UTF8')), 'hex'), now() - make_interval(days => $8::int), CASE WHEN $6 = 'deleted' THEN now() END
           FROM generate_series(1, $4::int) g
         RETURNING id)
       INSERT INTO audit_log (account_id, actor, action, payload, created_at)
       SELECT $1, $7, 'memory.' || $6, jsonb_build_object('entry_id', id), now() - make_interval(days => $8::int) FROM ins WHERE $7::text IS NOT NULL`,
      [a.accountId, scope, scopeRef, count, body, st, by, ageDays],
    );
  }
  const SWEEP = 'system:memory_sweep';
  const autoOf = async (body: string, scope = 'repo') => {
    const run = await newRun();
    await ingest(run, [fact(body, scope)]);
    return (await eventOf(run)).stored.map((x) => x.auto);
  };

  it('an old person\'s no still blocks after more than 400 sweep retirements have followed it', async () => {
    await setDial('announce', 1);
    const body = text('old person retire');
    await seedEntry('repo', repoRef, body, 'retired', owner, 200);
    await seedEntry('repo', repoRef, text('swept'), 'retired', SWEEP, 1, 405);
    expect(await autoOf(body)).toEqual(['previously_declined']);
    expect(await receipts()).toHaveLength(0);
  });

  it('a no at role scope (the run\'s own role) and a no at account scope both block; another role\'s no does not', async () => {
    await setDial('announce', 1);
    const roleText = text('role no');
    const accountText = text('account no');
    const otherRole = text('other role no');
    await seedEntry('role', 'executor', roleText, 'rejected', owner);
    await seedEntry('account', null, accountText, 'deleted', owner);
    await seedEntry('role', 'reviewer', otherRole, 'rejected', owner);
    expect(await autoOf(roleText)).toEqual(['previously_declined']);
    expect(await autoOf(accountText)).toEqual(['previously_declined']);
    expect(await autoOf(otherRole)).toEqual(['approved']);
  });

  it('a sweep retirement alone is not a no: the same text is approved again', async () => {
    await setDial('announce', 1);
    const body = text('swept only');
    await seedEntry('repo', repoRef, body, 'retired', SWEEP, 100);
    expect(await autoOf(body)).toEqual(['approved']);
    expect(await receipts()).toHaveLength(1);
  });

  /** One more audit row for the entry with this body, `ageDays` old: the history of an entry that was retired, restored and retired again. */
  async function addAudit(body: string, actor: string, action: string, ageDays: number) {
    await admin.query(
      `INSERT INTO audit_log (account_id, actor, action, payload, created_at)
       SELECT $1, $3, $4, jsonb_build_object('entry_id', id), now() - make_interval(days => $5::int) FROM memory_entries WHERE account_id = $1 AND body = $2`,
      [a.accountId, body, actor, action, ageDays],
    );
  }

  it('the latest retire decides: a sweep retire followed by a person\'s restore and retire still blocks', async () => {
    await setDial('announce', 1);
    const body = text('sweep then person');
    await seedEntry('repo', repoRef, body, 'retired', SWEEP, 30);
    await addAudit(body, owner, 'memory.restored', 20);
    await addAudit(body, owner, 'memory.retired', 10);
    expect(await autoOf(body)).toEqual(['previously_declined']);
    expect(await receipts()).toHaveLength(0);
  });

  it('the latest retire decides: a person\'s retire followed by a restore and a later sweep retire does not block', async () => {
    await setDial('announce', 1);
    const body = text('person then sweep');
    await seedEntry('repo', repoRef, body, 'retired', owner, 30);
    await addAudit(body, owner, 'memory.restored', 20);
    await addAudit(body, SWEEP, 'memory.retired', 10);
    expect(await autoOf(body)).toEqual(['approved']);
    expect(await receipts()).toHaveLength(1);
  });

  it('a retired entry with no audit row counts as a no: the look-back fails toward a person', async () => {
    await setDial('announce', 1);
    const body = text('retired without a row');
    await seedEntry('repo', repoRef, body, 'retired', null, 50);
    expect((await admin.query(`SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1 AND action = 'memory.retired'`, [a.accountId])).rows[0].n).toBe(0);
    expect(await autoOf(body)).toEqual(['previously_declined']);
    expect(await receipts()).toHaveLength(0);
  });

  it('a no in another repository does not count: the dial is per repository', async () => {
    await setDial('announce', 1);
    const other = (await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, 987654, 'team') RETURNING id`, [a.accountId, a.installationId])).rows[0]!.id;
    const otherItem = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance) VALUES ($1, $2, 'bug', 'internal') RETURNING id`, [a.accountId, other])).rows[0]!.id;
    const viaRepo = text('declined elsewhere repo');
    const viaItem = text('declined elsewhere item');
    for (const [scope, ref, body] of [['repo', 'R_kgDOElsewhere@1', viaRepo], ['item', otherItem, viaItem]] as const) {
      await admin.query(
        `INSERT INTO memory_entries (id, account_id, scope, scope_ref, kind, body, author_kind, provenance, status, version, content_sha256) VALUES ($1,$2,$3,$4,'fact',$5,'agent','{}'::jsonb,'rejected',1,encode(sha256(convert_to($5,'UTF8')),'hex'))`,
        [randomUUID(), a.accountId, scope, ref, body],
      );
    }
    const run = await newRun();
    await ingest(run, [fact(viaRepo), { scope: 'item', kind: 'fact', body: viaItem }]);
    expect((await eventOf(run)).stored.map((x) => x.auto)).toEqual(['approved', 'approved']);
  });

  it('a place already at its cap leaves the proposal waiting for a person and says so on the run event; later proposals elsewhere are still approved', async () => {
    await setDial('announce', 1);
    for (let i = 0; i < 30; i += 1) {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO memory_entries (id, account_id, scope, scope_ref, kind, body, author_kind, provenance, status, version, content_sha256) VALUES ($1,$2,'item',$3,'fact',$4,'person','{}'::jsonb,'approved',1,encode(sha256(convert_to($4,'UTF8')),'hex'))`,
        [id, a.accountId, a.workItemId, `filler ${i} ${id}`],
      );
    }
    const itemBody = text('item over cap');
    const repoBody = text('repo with room');
    const run = await newRun();
    await ingest(run, [{ scope: 'item', kind: 'fact', body: itemBody }, fact(repoBody)]);
    expect((await status(itemBody)).status).toBe('proposed');
    expect((await status(repoBody)).status).toBe('approved');
    expect((await eventOf(run)).stored.map((s) => s.auto)).toEqual(['memory_full', 'approved']);
    expect(await receipts()).toHaveLength(1);
  });

  it('a run with no work item gets no approval (the receipt and Undo both need the item); a failed receipt rolls the whole intake back', async () => {
    await setDial('announce', 1);
    const body = text('no item run');
    const run = await newRun(null);
    await ingest(run, [fact(body)], {}, null);
    expect((await status(body)).status).toBe('proposed');

    const failing = text('receipt fails');
    await admin.query(`CREATE FUNCTION public.mem10_refuse_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt refused' USING ERRCODE = 'check_violation'; END $$`);
    await admin.query(`CREATE TRIGGER mem10_refuse BEFORE INSERT ON decision_receipts FOR EACH ROW WHEN (NEW.decision_type = 'memory_auto_approve') EXECUTE FUNCTION public.mem10_refuse_receipt()`);
    const run2 = await newRun();
    try {
      await expect(ingest(run2, [fact(failing)])).rejects.toMatchObject({ code: '23514' });
    } finally {
      await admin.query(`DROP TRIGGER mem10_refuse ON decision_receipts`);
      await admin.query(`DROP FUNCTION public.mem10_refuse_receipt()`);
    }
    // Nothing was written: no entry, no event, so a later call tries again and succeeds.
    expect(await status(failing)).toBeUndefined();
    expect(await eventOf(run2)).toBeUndefined();
    expect((await ingest(run2, [fact(failing)])).status).toBe('ingested');
    expect((await status(failing)).status).toBe('approved');
  });
});
