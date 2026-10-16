import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { ForbiddenError, NotFoundError } from '../src/tenancy/errors.js';
import { MEMORY_AUTHOR_KINDS, MEMORY_STATUSES, decideMemory, deleteMemory, editMemory, listMemoryVersions, repoScopeRef, writeMemory, type MemoryCtx } from '../src/memory/index.js';
import { formatItemGroup, formatMemoryAge, formatMemoryProposedBy, formatMemoryRuns, formatMemorySource, formatMemoryStatus, formatMemoryTitle, formatRepoGroup, memoryText } from '../src/memory/format.js';
import { markMemoryOpened } from '../src/memory/batch.js';
import { listMemory, memoryPendingCounts, memoryQueue } from '../src/memory/view.js';

const NODE = 'R_kgDOQueue01';

/** D#601 MEM-4a1: the list, the queue, the badges, the batch and the opened state, against a real Postgres with row security forced. */
describe('memory queue and list (D#601 MEM-4a1)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let aAdmin: string;
  let aAdmin2: string;
  let aMember: string;
  let bAdmin: string;
  let repoRef: string;
  let n = 0;

  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, id, role]);
    return id;
  }
  const ctx = (accountId: string, userId: string): MemoryCtx => ({ pool: appPool, principal: { accountId, userId }, liveSecrets: () => [] as string[] });
  const text = (what: string) => `${what} ${++n} ${randomUUID()}`;
  const approved = (accountId: string, userId: string, over: Partial<{ scope: 'repo' | 'item' | 'account'; ref: string | null; kind: 'fact' | 'command'; body: string }> = {}) =>
    writeMemory(ctx(accountId, userId), { scope: over.scope ?? 'repo', scopeRef: over.ref === undefined ? repoRef : over.ref, kind: over.kind ?? 'fact', body: over.body ?? text('approved fact') });
  /** An agent or import proposal, written the way the pipeline does (no user in the session). */
  const proposal = (accountId: string, over: Partial<{ author: 'agent' | 'import' | 'runner_agent' | 'assistant'; prov: Record<string, string>; scope: 'repo' | 'item'; ref: string }> = {}): Promise<string> =>
    withTenant(appPool, accountId, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT memory_propose($1, $2, 'fact', $3, NULL, $4, $5::jsonb) AS id`, [
        over.scope ?? 'repo',
        over.ref ?? repoRef,
        text('proposal'),
        over.author ?? 'import',
        JSON.stringify(over.prov ?? { source_path: 'CLAUDE.md', source_commit: 'abcdef0123456789' }),
      ]);
      return rows[0]!.id;
    });
  async function runRecalling(accountId: string, entries: Array<{ id: string; version: number }>): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'executor', 'production', 'succeeded')`, [id, accountId]);
    await admin.query(`INSERT INTO run_context_inputs (account_id, run_id, recalled_entry_ids, recalled_entry_versions) VALUES ($1, $2, $3::uuid[], $4::integer[])`, [
      accountId,
      id,
      entries.map((e) => e.id),
      entries.map((e) => e.version),
    ]);
    return id;
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    aAdmin = await addMember(a.accountId, 'admin');
    aAdmin2 = await addMember(a.accountId, 'admin');
    aMember = await addMember(a.accountId, 'member');
    bAdmin = await addMember(b.accountId, 'admin');
    const inst = (await admin.query<{ g: string }>(`SELECT gh_installation_id::text AS g FROM installations WHERE id = $1`, [a.installationId])).rows[0]!.g;
    await admin.query(`UPDATE repos SET gh_node_id = $2, gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1`, [a.repoId, NODE]);
    await admin.query(`UPDATE work_items SET title = 'Add the thing', gh_number = 42 WHERE id = $1`, [a.workItemId]);
    repoRef = repoScopeRef(NODE, inst);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  describe('the list (acceptance 1)', () => {
    it('groups by scope with owner/name and number plus title, and gives every row its title, kind, source, age and runs', async () => {
      const used = await approved(a.accountId, aAdmin, { kind: 'command', body: 'pnpm test --run\nthen lint' });
      const unused = await approved(a.accountId, aAdmin);
      await runRecalling(a.accountId, [{ id: used.id, version: 1 }]);
      await runRecalling(a.accountId, [{ id: used.id, version: 1 }]);
      const item = await approved(a.accountId, aAdmin, { scope: 'item', ref: a.workItemId });
      const acct = await approved(a.accountId, aAdmin, { scope: 'account', ref: null });
      const list = await listMemory(ctx(a.accountId, aMember));
      expect(list.truncated).toBe(false);
      const labels = list.groups.map((g) => g.label);
      expect(labels.indexOf('acme/widgets')).toBeGreaterThanOrEqual(0);
      expect(labels.indexOf('#42 Add the thing')).toBeGreaterThan(labels.indexOf('acme/widgets'));
      expect(labels.indexOf('Account')).toBeGreaterThan(labels.indexOf('#42 Add the thing'));
      const repoGroup = list.groups.find((g) => g.label === 'acme/widgets')!;
      expect(repoGroup).toMatchObject({ scope: 'repo', scopeRef: repoRef, targetId: a.repoId });
      expect(list.groups.find((g) => g.scope === 'item')).toMatchObject({ targetId: a.workItemId });
      const row = (id: string) => list.groups.flatMap((g) => g.entries).find((e) => e.id === id)!;
      expect(row(used.id)).toMatchObject({ title: 'pnpm test --run', kind: 'command', kindLabel: 'Command', source: 'A member', runs: 2, runsLabel: 'Used in 2 runs', age: 'Just now', version: 1 });
      expect(row(unused.id).runs).toBe(0);
      expect(typeof row(unused.id).runs).toBe('number');
      expect(row(unused.id).runsLabel).toBe('Used in 0 runs');
      expect(row(item.id).scope).toBe('item');
      expect(row(acct.id).scope).toBe('account');
    });
    it("a lineage's count follows an edit, and the superseded version is left out of the default list but asked for by name", async () => {
      const v1 = await approved(a.accountId, aAdmin);
      await runRecalling(a.accountId, [{ id: v1.id, version: 1 }]);
      const v2 = await editMemory(ctx(a.accountId, aAdmin), { id: v1.id, body: text('edited') });
      await runRecalling(a.accountId, [{ id: v2.id, version: 2 }]);
      const ids = (l: Awaited<ReturnType<typeof listMemory>>) => l.groups.flatMap((g) => g.entries).map((e) => e.id);
      const def = await listMemory(ctx(a.accountId, aAdmin), { repoId: a.repoId });
      expect(ids(def)).toContain(v2.id);
      expect(ids(def)).not.toContain(v1.id);
      expect(def.groups.flatMap((g) => g.entries).find((e) => e.id === v2.id)!.runs).toBe(2);
      const history = await listMemory(ctx(a.accountId, aAdmin), { repoId: a.repoId, statuses: ['superseded'] });
      expect(ids(history)).toContain(v1.id);
      expect(history.groups.flatMap((g) => g.entries).find((e) => e.id === v1.id)!.statusDisplay.label).toBe('Replaced by a newer version');
    });
    it('filters by kind and by status, and leaves deleted entries for the Deleted tab', async () => {
      const cmd = await approved(a.accountId, aAdmin, { kind: 'command' });
      const gone = await approved(a.accountId, aAdmin);
      await deleteMemory(ctx(a.accountId, aAdmin), { id: gone.id });
      const rejected = await proposal(a.accountId, { author: 'agent', prov: {} });
      await decideMemory(ctx(a.accountId, aAdmin), { id: rejected, to: 'rejected' });
      const ids = (l: Awaited<ReturnType<typeof listMemory>>) => l.groups.flatMap((g) => g.entries).map((e) => e.id);
      expect(ids(await listMemory(ctx(a.accountId, aAdmin), { repoId: a.repoId, kinds: ['command'] }))).toContain(cmd.id);
      expect(ids(await listMemory(ctx(a.accountId, aAdmin), { repoId: a.repoId, kinds: ['gotcha'] }))).toEqual([]);
      expect(ids(await listMemory(ctx(a.accountId, aAdmin), { repoId: a.repoId }))).not.toContain(gone.id);
      expect(ids(await listMemory(ctx(a.accountId, aAdmin), { repoId: a.repoId, statuses: ['deleted'] }))).toContain(gone.id);
      expect(ids(await listMemory(ctx(a.accountId, aAdmin), { repoId: a.repoId, statuses: ['rejected'] }))).toEqual([rejected]);
      await expect(listMemory(ctx(a.accountId, aAdmin), { statuses: ['nonsense' as never] })).rejects.toMatchObject({ code: 'invalid_message' });
      await expect(listMemory(ctx(a.accountId, aAdmin), { kinds: ['nonsense' as never] })).rejects.toMatchObject({ code: 'invalid_message' });
    });
    it('a repo with no GitHub node id has no key and lists nothing; another account repo is NotFound', async () => {
      expect(await listMemory(ctx(b.accountId, bAdmin), { repoId: b.repoId })).toEqual({ groups: [], truncated: false });
      await expect(listMemory(ctx(b.accountId, bAdmin), { repoId: a.repoId })).rejects.toBeInstanceOf(NotFoundError);
      await expect(listMemory(ctx(a.accountId, aAdmin), { repoId: 'not-a-uuid' })).rejects.toBeInstanceOf(NotFoundError);
    });
    it("another account's entries never appear, and an entry whose repo is gone reads as a plain statement", async () => {
      await approved(b.accountId, bAdmin, { scope: 'account', ref: null });
      const mine = await listMemory(ctx(a.accountId, aAdmin));
      expect(mine.groups.flatMap((g) => g.entries).every((e) => e.scope !== 'account' || e.scopeRef === null)).toBe(true);
      const orphanRef = repoScopeRef('R_kgDOGone001', 999999);
      await admin.query(
        `INSERT INTO memory_entries (account_id, scope, scope_ref, kind, body, author_kind, status, version, content_sha256)
         VALUES ($1, 'repo', $2, 'fact', 'orphan fact', 'person', 'archived', 1, encode(sha256(convert_to('orphan fact','UTF8')),'hex'))`,
        [a.accountId, orphanRef],
      );
      const list = await listMemory(ctx(a.accountId, aAdmin), { statuses: ['archived'] });
      const g = list.groups.find((x) => x.scopeRef === orphanRef)!;
      expect(g.label).toBe('Repo no longer connected');
      expect(g.entries[0]!.statusDisplay.label).toBe('Archived');
    });
    it('no display field is ever null, undefined, blank or the words null and undefined, in any state', async () => {
      const list = await listMemory(ctx(a.accountId, aAdmin), { statuses: [...MEMORY_STATUSES] });
      const rows = list.groups.flatMap((g) => g.entries);
      expect(rows.length).toBeGreaterThan(5);
      for (const g of list.groups) expect(memoryText(g.label)).toBe(g.label);
      for (const r of rows) {
        for (const v of [r.title, r.kindLabel, r.source, r.age, r.runsLabel, r.statusDisplay.label, r.statusDisplay.icon]) {
          expect(typeof v).toBe('string');
          expect(v).not.toMatch(/^(null|undefined)?$/);
          expect(v).not.toContain('undefined');
        }
        expect(Number.isInteger(r.runs)).toBe(true);
      }
    });
  });

  describe('the pending counts (acceptance 2)', () => {
    it('equal the number of proposed rows for a repo and for an item, and drop after a decision', async () => {
      const item = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`, [item, a.accountId, a.repoId]);
      const baseRepo = (await memoryPendingCounts(ctx(a.accountId, aAdmin), { repoIds: [a.repoId] })).repos[a.repoId]!;
      const ids = [await proposal(a.accountId), await proposal(a.accountId), await proposal(a.accountId, { author: 'agent', prov: {} })];
      const itemIds = [await proposal(a.accountId, { scope: 'item', ref: item, author: 'agent', prov: {} })];
      const counts = await memoryPendingCounts(ctx(a.accountId, aAdmin), { repoIds: [a.repoId], itemIds: [item] });
      expect(counts.repos[a.repoId]).toBe(baseRepo + 3);
      expect(counts.items[item]).toBe(1);
      const exact = (await admin.query(`SELECT count(*)::int AS n FROM memory_entries WHERE account_id = $1 AND scope = 'repo' AND scope_ref = $2 AND status = 'proposed'`, [a.accountId, repoRef])).rows[0].n;
      expect(counts.repos[a.repoId]).toBe(exact);
      await decideMemory(ctx(a.accountId, aAdmin), { id: ids[2]!, to: 'approved' });
      await decideMemory(ctx(a.accountId, aMember), { id: itemIds[0]!, to: 'rejected' });
      const after = await memoryPendingCounts(ctx(a.accountId, aAdmin), { repoIds: [a.repoId], itemIds: [item] });
      expect(after.repos[a.repoId]).toBe(baseRepo + 2);
      expect(after.items[item]).toBe(0);
    });
    it('answers a number for every id asked, including a repo with no key and an id of another account', async () => {
      const other = randomUUID();
      const c = await memoryPendingCounts(ctx(b.accountId, bAdmin), { repoIds: [b.repoId, a.repoId], itemIds: [other] });
      expect(c).toEqual({ repos: { [b.repoId]: 0, [a.repoId]: 0 }, items: { [other]: 0 } });
      expect(await memoryPendingCounts(ctx(b.accountId, bAdmin), {})).toEqual({ repos: {}, items: {} });
      await expect(memoryPendingCounts(ctx(a.accountId, aAdmin), { repoIds: ['x'] })).rejects.toBeInstanceOf(NotFoundError);
      await expect(memoryPendingCounts(ctx(a.accountId, aAdmin), { itemIds: Array.from({ length: 201 }, () => randomUUID()) })).rejects.toMatchObject({ code: 'invalid_message' });
    });
  });

  describe('the queue and the opened state (section 2)', () => {
    it('shows each proposal with its provenance and evidence, and the open state of imported cards per person and per version', async () => {
      const imp = await proposal(a.accountId, { prov: { source_path: 'docs/CLAUDE.md', source_commit: 'abcdef0123456789', evidence: 'section 3 of the file' } });
      const agent = await proposal(a.accountId, { author: 'agent', prov: { source_run_id: 'run-77', evidence: 'the failing test' } });
      const find = async (as: MemoryCtx, id: string) => (await memoryQueue(as, { repoId: a.repoId })).cards.find((c) => c.entry.id === id)!;
      const first = await find(ctx(a.accountId, aAdmin), imp);
      expect(first).toMatchObject({ openState: 'unopened', source: 'Imported from CLAUDE.md', proposedBy: 'Imported from CLAUDE.md at abcdef0', evidence: 'section 3 of the file', age: 'Just now' });
      expect(first.entry).toMatchObject({ status: 'proposed', authorKind: 'import' });
      expect(await find(ctx(a.accountId, aAdmin), agent)).toMatchObject({ openState: 'not_required', proposedBy: 'Proposed by agent (run run-77)', evidence: 'the failing test', source: 'Agent' });
      expect(await markMemoryOpened(ctx(a.accountId, aAdmin), imp)).toEqual({ opened: true });
      expect((await find(ctx(a.accountId, aAdmin), imp)).openState).toBe('opened');
      expect((await find(ctx(a.accountId, aAdmin2), imp)).openState).toBe('unopened');
      expect(await markMemoryOpened(ctx(a.accountId, aAdmin), agent)).toEqual({ opened: false });
      // An edit is a new version with its own card, and it has to be opened again.
      const v2 = await editMemory(ctx(a.accountId, aAdmin), { id: imp, body: text('edited import') });
      expect((await find(ctx(a.accountId, aAdmin), v2.id)).openState).toBe('unopened');
      expect((await memoryQueue(ctx(a.accountId, aAdmin), { repoId: a.repoId })).cards.map((c) => c.entry.id)).not.toContain(imp);
    });
    it('keeps "Proposed by agent (run <id>)" after a person edits an agent proposal', async () => {
      const agent = await proposal(a.accountId, { author: 'agent', prov: { source_run_id: 'run-edit-1' } });
      const v2 = await editMemory(ctx(a.accountId, aAdmin), { id: agent, body: text('person edit of an agent proposal') });
      const card = (await memoryQueue(ctx(a.accountId, aAdmin), { repoId: a.repoId })).cards.find((c) => c.entry.id === v2.id)!;
      expect(card.proposedBy).toBe('Proposed by agent (run run-edit-1)');
      expect(card.entry.authorKind).toBe('agent');
    });
    it('a member may not open a repo card (Forbidden) and another account gets NotFound; the queue read opens nothing', async () => {
      const imp = await proposal(a.accountId);
      await expect(markMemoryOpened(ctx(a.accountId, aMember), imp)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(markMemoryOpened(ctx(b.accountId, bAdmin), imp)).rejects.toBeInstanceOf(NotFoundError);
      await memoryQueue(ctx(a.accountId, aAdmin), { repoId: a.repoId });
      expect((await admin.query(`SELECT 1 FROM memory_entry_opens WHERE entry_id = $1`, [imp])).rowCount).toBe(0);
    });
  });

  describe('the formatter (acceptance 3)', () => {
    it.each(MEMORY_STATUSES.map((s) => [s]))('status %s gives text and an icon, never null or undefined', (status) => {
      const d = formatMemoryStatus(status);
      expect(typeof d.label).toBe('string');
      expect(d.label.length).toBeGreaterThan(2);
      expect(d.label).not.toMatch(/null|undefined/i);
      expect(d.icon).not.toBe('question');
    });
    it('covers all eight statuses with eight different labels, and an unknown value still reads as text', () => {
      expect(new Set(MEMORY_STATUSES.map((s) => formatMemoryStatus(s).label)).size).toBe(8);
      for (const v of [undefined, null, '', 'undefined', 'null', 7, {}, 'SUPERSEDED']) expect(formatMemoryStatus(v)).toEqual({ label: 'Unknown status', icon: 'question' });
    });
    it('turns every missing value into a plain phrase', () => {
      expect(memoryText(null, 'none')).toBe('none');
      expect(memoryText(undefined)).toBe('');
      expect(memoryText('undefined', 'x')).toBe('x');
      expect(memoryText('  ok  ')).toBe('ok');
      expect(formatMemoryTitle('   \n\n  first line   with   gaps\nsecond')).toBe('first line with gaps');
      expect(formatMemoryTitle(null, 'repo', 'command')).toBe('repo command');
      expect(formatMemoryTitle('x'.repeat(200))).toHaveLength(80);
      expect(formatRepoGroup(null, 'name')).toBe('Repo no longer connected');
      expect(formatRepoGroup('acme', 'widgets')).toBe('acme/widgets');
      expect(formatItemGroup(42, 'Add it')).toBe('#42 Add it');
      expect(formatItemGroup('7', null)).toBe('#7');
      expect(formatItemGroup(null, undefined)).toBe('Item');
      expect(formatMemoryRuns(null)).toBe('Used in 0 runs');
      expect(formatMemoryRuns(1)).toBe('Used in 1 run');
      expect(formatMemoryAge(null)).toBe('Unknown age');
      expect(formatMemoryAge('not a date')).toBe('Unknown age');
      const now = new Date('2026-10-16T12:00:00Z');
      expect(formatMemoryAge(new Date('2026-10-13T12:00:00Z'), now)).toBe('3 days ago');
      expect(formatMemoryAge(new Date('2026-10-16T11:59:00Z'), now)).toBe('1 minute ago');
      expect(formatMemoryAge(new Date('2026-07-16T12:00:00Z'), now)).toBe('3 months ago');
      expect(formatMemoryAge(new Date('2026-10-17T12:00:00Z'), now)).toBe('Just now');
    });
    it('names a source and a proposer for every author kind, with or without provenance', () => {
      for (const kind of [...MEMORY_AUTHOR_KINDS, 'something else', null, undefined]) {
        for (const prov of [undefined, null, {}, { source_path: 'a/b/AGENTS.md', source_run_id: 'r1' }]) {
          for (const s of [formatMemorySource(kind, prov), formatMemoryProposedBy(kind, prov)]) {
            expect(s.length).toBeGreaterThan(3);
            expect(s).not.toMatch(/null|undefined/);
          }
        }
      }
      expect(formatMemorySource('import', { source_path: 'a/b/AGENTS.md' })).toBe('Imported from AGENTS.md');
    });
  });

  describe('a version chain still lists every prior text (the lineage the count reads)', () => {
    it('keeps the history the list leaves out', async () => {
      const v1 = await approved(a.accountId, aAdmin);
      const v2 = await editMemory(ctx(a.accountId, aAdmin), { id: v1.id, body: text('second') });
      expect((await listMemoryVersions(ctx(a.accountId, aAdmin), v2.id)).map((e) => e.version)).toEqual([1, 2]);
    });
  });
});
