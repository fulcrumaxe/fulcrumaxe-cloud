import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { queueAnalysis } from '@fx/db/src/discoveryAnalyses.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../../src/tenancy/withTenant.js';
import { setPendingHooks } from '../../src/pendingWork.js';
import { mergeCandidates, mergeCandidatesAsImporter, type AnalysisCandidate, type MergeCounts } from '../../src/discovery/candidates.js';

const NORM_KEY = (title: string) => `'src:' || left(encode(sha256(convert_to(proposal_title_norm(${title}), 'UTF8')), 'hex'), 16)`;
const cand = (over: Partial<AnalysisCandidate> = {}): AnalysisCandidate => ({ kind: 'docs', title: 'Add a CLI flag', summary: 'Document the flag.', refs: [{ path: 'docs/cli.md', start_line: 3, end_line: 9 }], ...over });

/** D#483 S4-f2 against real Postgres: the de-duplication writer, as `plan_importer`, through `mergeCandidates` (C25 R-C25-1, R-C25-6, R-C25-7). */
describe('mergeCandidates (D#483 S4-f2)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let sha = 0;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });
  afterEach(() => setPendingHooks(null));

  /** A fresh account with one connected sandbox repo (its issues and proposals are this test's own). */
  async function tenant(): Promise<SeedRefs> {
    return seedAccount(admin, randomUUID());
  }
  async function analysis(t: SeedRefs, repoId = t.repoId): Promise<string> {
    return (await queueAnalysis(appPool, t.accountId, repoId, (++sha).toString(16).padStart(40, '0')))!.id;
  }
  async function put(t: SeedRefs, key: string, over: Record<string, unknown> = {}, repoId = t.repoId): Promise<string> {
    const row = { sources: ['github_issue'], title: 'Existing', summary: null, provenance: 'external', owner_process: 'product', state: 'new', ...over };
    const cols = Object.keys(row);
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO proposals (account_id, repo_id, dedupe_key, ${cols.join(', ')}) VALUES ($1, $2, $3, ${cols.map((_, i) => `$${i + 4}`).join(', ')}) RETURNING id`,
      [t.accountId, repoId, key, ...Object.values(row)],
    );
    return rows[0]!.id;
  }
  const rowsOf = async (t: SeedRefs, repoId = t.repoId) => (await admin.query(`SELECT * FROM proposals WHERE repo_id = $1 ORDER BY created_at, id`, [repoId])).rows;
  const one = async (id: string) => (await admin.query(`SELECT * FROM proposals WHERE id = $1`, [id])).rows[0]!;
  async function merge(t: SeedRefs, candidates: AnalysisCandidate[], over: { repoId?: string; ownerProcess?: 'product' | 'internal_loop' } = {}): Promise<MergeCounts> {
    const repoId = over.repoId ?? t.repoId;
    const out = await mergeCandidates(appPool, t.accountId, { repoId, analysisId: await analysis(t, repoId), ownerProcess: over.ownerProcess ?? 'product', candidates });
    if (out.state !== 'merged') throw new Error(`skipped: ${out.reason}`);
    return out.counts;
  }
  const noMerge: MergeCounts = { merged_issue: 0, merged_duplicate: 0, merged_title: 0, created: 0, named_item_not_in_inbox: 0 };

  it('S4f-1: a candidate naming issue #4 merges into issue #4 proposal: one row, sources github_issue and docs, and the row keeps its issue number for the "Issue #4" badge', async () => {
    const t = await tenant();
    const id = await put(t, 'gh:issue:4', { gh_number: 4, title: 'Something else entirely' });
    const counts = await merge(t, [cand({ names_issue: 4 })]);
    expect(counts).toEqual({ ...noMerge, merged_issue: 1 });
    const rows = await rowsOf(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, sources: ['github_issue', 'docs'], gh_number: 4, title: 'Something else entirely', summary: null, analysis_refs: null, state: 'new', verification: 'pending' });
  });

  it('a Discussion named by a candidate merges the same way, and an issue wins over a duplicate_of and a matching title', async () => {
    const t = await tenant();
    const disc = await put(t, 'gh:discussion:9', { sources: ['github_discussion'], discussion_number: 9, title: 'A Discussion' });
    const issue = await put(t, 'gh:issue:2', { gh_number: 2, title: 'Issue two' });
    const dup = await put(t, 'plan:x', { sources: ['plan_task'], title: 'Add a CLI flag' });
    expect(await merge(t, [cand({ kind: 'code', names_discussion: 9, title: 'Zed' })])).toEqual({ ...noMerge, merged_issue: 1 });
    expect(await merge(t, [cand({ names_issue: 2, duplicate_of: dup, title: 'Add a CLI flag' })])).toEqual({ ...noMerge, merged_issue: 1 });
    expect((await one(disc)).sources).toEqual(['github_discussion', 'code']);
    expect((await one(issue)).sources).toEqual(['github_issue', 'docs']);
    expect((await one(dup)).sources).toEqual(['plan_task']);
  });

  it("S4f-2: a duplicate_of naming another repo's proposal (or another account's) is ignored; the candidate falls to the title and new rules and the other row is unchanged", async () => {
    const t = await tenant();
    const other = await tenant();
    const second = (await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, 77, 'team') RETURNING id`, [t.accountId, t.installationId])).rows[0]!.id;
    const foreign = await put(t, 'gh:issue:1', { gh_number: 1, title: 'Sibling repo row' }, second);
    const foreignAccount = await put(other, 'gh:issue:1', { gh_number: 1, title: 'Other account row' });
    const before = [await one(foreign), await one(foreignAccount)];
    const titled = await put(t, 'gh:issue:5', { gh_number: 5, title: 'Fresh Idea!' });

    expect(await merge(t, [cand({ title: 'Brand new idea', duplicate_of: foreign }), cand({ title: 'Another one', duplicate_of: foreignAccount })])).toEqual({ ...noMerge, created: 2 });
    expect(await merge(t, [cand({ kind: 'code', title: 'fresh idea', duplicate_of: foreign })])).toEqual({ ...noMerge, merged_title: 1 });
    expect([await one(foreign), await one(foreignAccount)]).toEqual(before);
    expect((await one(titled)).sources).toEqual(['github_issue', 'code']);
    expect((await rowsOf(t, second))).toHaveLength(1);
  });

  it('a duplicate_of naming a proposal of this repo merges into it', async () => {
    const t = await tenant();
    const id = await put(t, 'gh:issue:3', { gh_number: 3, title: 'Unrelated words' });
    expect(await merge(t, [cand({ duplicate_of: id })])).toEqual({ ...noMerge, merged_duplicate: 1 });
    expect((await one(id)).sources).toEqual(['github_issue', 'docs']);
    expect(await rowsOf(t)).toHaveLength(1);
  });

  it('S4f-3: two candidates in one call, "Add a CLI flag!" and "add a cli flag", make one row (and a docs and a code reading make it both)', async () => {
    const t = await tenant();
    const counts = await merge(t, [cand({ title: 'Add a CLI flag!' }), cand({ kind: 'code', title: 'add a cli flag', summary: 'Second reading.', refs: [] })]);
    expect(counts).toEqual({ ...noMerge, created: 1 });
    const rows = await rowsOf(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Add a CLI flag!', sources: ['code', 'docs'] });
  });

  it('S4f-4: a candidate whose normalised title matches a rejected "Never" row adds docs to it, and nothing appears in New; state, reject_kind and title are unchanged', async () => {
    const t = await tenant();
    const id = await put(t, 'src:00000000000000aa', { sources: ['code'], title: 'Add a CLI flag', state: 'rejected', decided_at: new Date(), reject_kind: 'never', reject_note: 'No thanks' });
    const before = await one(id);
    expect(await merge(t, [cand({ title: 'add a cli flag!!' })])).toEqual({ ...noMerge, merged_title: 1 });
    const after = await one(id);
    expect(after).toEqual({ ...before, sources: ['code', 'docs'] });
    expect(after).toMatchObject({ state: 'rejected', reject_kind: 'never', title: 'Add a CLI flag' });
    expect((await rowsOf(t)).filter((p) => p.state === 'new')).toHaveLength(0);
  });

  it('C25-f2-1: a candidate naming issue #999, which has no proposal, writes nothing and counts named_item_not_in_inbox (even with a fresh title or a duplicate_of)', async () => {
    const t = await tenant();
    const keep = await put(t, 'gh:issue:1', { gh_number: 1, title: 'Keep' });
    const before = await rowsOf(t);
    expect(await merge(t, [cand({ names_issue: 999, title: 'Would be new' }), cand({ names_discussion: 998, title: 'Also new', duplicate_of: keep })])).toEqual({ ...noMerge, named_item_not_in_inbox: 2 });
    expect(await rowsOf(t)).toEqual(before);
  });

  it('C25-f2-2: a merge into an approved row changes only sources: every other column, the claims and the evidence are the same before and after', async () => {
    const t = await tenant();
    const wi = (await admin.query<{ id: string }>(`SELECT id FROM work_items WHERE account_id = $1 LIMIT 1`, [t.accountId])).rows[0]!.id;
    const id = await put(t, 'gh:issue:8', { gh_number: 8, title: 'Approved idea', summary: 'S', state: 'approved', decided_at: new Date(), roadmap_position: 1, work_item_id: wi, verification: 'verified', verified_at: new Date(), verified_sha: 'a'.repeat(40) });
    await admin.query(`INSERT INTO proposal_claims (account_id, proposal_id, text) VALUES ($1, $2, 'a claim')`, [t.accountId, id]);
    await admin.query(`INSERT INTO proposal_evidence (account_id, repo_id, proposal_id, kind, ref, excerpt) VALUES ($1, $2, $3, 'issue', '#8', 'text')`, [t.accountId, t.repoId, id]);
    const snap = async () => ({
      row: await one(id),
      claims: (await admin.query(`SELECT * FROM proposal_claims WHERE proposal_id = $1 ORDER BY id`, [id])).rows,
      evidence: (await admin.query(`SELECT * FROM proposal_evidence WHERE proposal_id = $1 ORDER BY id`, [id])).rows,
    });
    const before = await snap();
    expect(await merge(t, [cand({ kind: 'code', names_issue: 8, summary: 'A different summary', refs: [{ path: 'a.ts', start_line: 1, end_line: 2 }] })])).toEqual({ ...noMerge, merged_issue: 1 });
    const after = await snap();
    expect(after.row).toEqual({ ...before.row, sources: ['github_issue', 'code'] });
    expect(after.claims).toEqual(before.claims);
    expect(after.evidence).toEqual(before.evidence);
    // Again, by title this time: the same call twice adds nothing more.
    await merge(t, [cand({ kind: 'code', title: 'approved idea' })]);
    expect((await snap()).row).toEqual(after.row);
  });

  it('C25-f2-3: a new src row is new and pending with the given owner, refs, internal provenance, and the SQL-computed key', async () => {
    const t = await tenant();
    for (const owner of ['product', 'internal_loop'] as const) {
      const title = `  Teach the "importer" to read TOML (${owner})!  `;
      expect(await merge(t, [cand({ title, summary: '  A  summary \n with   gaps ', refs: [{ path: 'docs/a.md', start_line: 3, end_line: 9 }, { path: 'src/b.ts', start_line: 1, end_line: 1 }] })], { ownerProcess: owner })).toEqual({ ...noMerge, created: 1 });
      const row = (await admin.query(`SELECT p.*, ${NORM_KEY('p.title')} AS expected_key FROM proposals p WHERE p.repo_id = $1 AND p.title LIKE $2`, [t.repoId, `%${owner})!`])).rows[0]!;
      expect(row).toMatchObject({
        state: 'new', verification: 'pending', verified_at: null, owner_process: owner, provenance: 'internal', sources: ['docs'],
        summary: 'A summary with gaps', analysis_refs: ['docs/a.md:3-9', 'src/b.ts:1-1'], gh_number: null, discussion_number: null, work_item_id: null, decided_at: null,
      });
      expect(row.dedupe_key).toBe(row.expected_key);
      expect(row.dedupe_key).toMatch(/^src:[0-9a-f]{16}$/);
    }
  });

  it('C25-f2-4: a second call with a changed summary updates the summary and sends a checked row back to pending (claims cleared); the same summary leaves it checked; a withdrawn src row returns to new', async () => {
    const t = await tenant();
    await merge(t, [cand({ title: 'Cache the manifest' })]);
    const id = (await rowsOf(t))[0]!.id as string;
    await admin.query(`UPDATE proposals SET verification = 'verified', verified_at = now(), verified_sha = $2 WHERE id = $1`, [id, 'b'.repeat(40)]);
    await admin.query(`INSERT INTO proposal_claims (account_id, proposal_id, text) VALUES ($1, $2, 'old claim')`, [t.accountId, id]);

    expect(await merge(t, [cand({ title: 'Cache the manifest!', kind: 'code' })])).toEqual({ ...noMerge, merged_title: 1 });
    expect(await one(id)).toMatchObject({ verification: 'verified', sources: ['docs', 'code'] });

    expect(await merge(t, [cand({ title: 'cache the manifest', summary: 'A newer summary.' })])).toEqual({ ...noMerge, merged_title: 1 });
    expect(await one(id)).toMatchObject({ summary: 'A newer summary.', title: 'Cache the manifest', verification: 'pending', verified_at: null, verified_sha: null, verify_attempts: 0 });
    expect((await admin.query(`SELECT 1 FROM proposal_claims WHERE proposal_id = $1`, [id])).rowCount).toBe(0);

    // Refs alone changing is a change too (they are part of what the verifier is asked).
    await admin.query(`UPDATE proposals SET verification = 'partly_verified', verified_at = now(), verified_sha = $2 WHERE id = $1`, [id, 'c'.repeat(40)]);
    await merge(t, [cand({ title: 'cache the manifest', summary: 'A newer summary.', refs: [{ path: 'x.ts', start_line: 2, end_line: 3 }] })]);
    expect(await one(id)).toMatchObject({ analysis_refs: ['x.ts:2-3'], verification: 'pending' });

    await admin.query(`UPDATE proposals SET state = 'withdrawn' WHERE id = $1`, [id]);
    expect(await merge(t, [cand({ title: 'Cache the manifest', summary: 'Back again.' })])).toEqual({ ...noMerge, merged_title: 1 });
    expect(await one(id)).toMatchObject({ state: 'new', summary: 'Back again.' });
    expect(await rowsOf(t)).toHaveLength(1);
  });

  it('a row that is not the analyst\'s (an issue row, an interview row) keeps its own summary and refs when a candidate merges into it', async () => {
    const t = await tenant();
    const issue = await put(t, 'gh:issue:7', { gh_number: 7, title: 'Seven', summary: 'Own text' });
    const interview = await put(t, 'src:00000000000000bb', { sources: ['interview'], title: 'From the interview', summary: 'Interview text' });
    await merge(t, [cand({ names_issue: 7, summary: 'Analyst text' }), cand({ title: 'From the interview', summary: 'Analyst text two' })]);
    expect(await one(issue)).toMatchObject({ summary: 'Own text', analysis_refs: null, sources: ['github_issue', 'docs'] });
    expect(await one(interview)).toMatchObject({ summary: 'Interview text', analysis_refs: null, sources: ['interview', 'docs'] });
  });

  it('C25-f2-7: it creates no work item, agent run or action request, the role holds no grant on them, and it refuses to run with any role but plan_importer', async () => {
    const t = await tenant();
    const count = async () => (await admin.query(`SELECT (SELECT count(*) FROM work_items) w, (SELECT count(*) FROM agent_runs) a, (SELECT count(*) FROM run_action_requests) q`)).rows[0];
    const before = await count();
    await merge(t, [cand({ title: 'One' }), cand({ title: 'Two', kind: 'code' }), cand({ names_issue: 404, title: 'Three' })]);
    expect(await count()).toEqual(before);
    expect((await admin.query(`SELECT (SELECT count(*) FROM proposals WHERE account_id = $1) n`, [t.accountId])).rows[0].n).toBe('2');

    await withTenant(appPool, t.accountId, async (c) => {
      await expect(mergeCandidatesAsImporter(c, t.accountId, { repoId: t.repoId, analysisId: randomUUID(), ownerProcess: 'product', candidates: [cand()] })).rejects.toThrow('plan_importer role must be in force');
    });
    for (const table of ['work_items', 'agent_runs', 'run_action_requests']) {
      const priv = (await admin.query(`SELECT has_table_privilege('plan_importer', $1, 'INSERT') i, has_table_privilege('plan_importer', $1, 'UPDATE') u, has_table_privilege('plan_importer', $1, 'DELETE') d`, [table])).rows[0];
      expect(priv).toEqual({ i: false, u: false, d: false });
    }
    expect((await admin.query(`SELECT has_table_privilege('app_user', 'proposals', 'INSERT') i`)).rows[0].i).toBe(false);
  });

  it('a repo that is not connected any more gets nothing written; an unknown analysis is a skip; more than 10 candidates are refused', async () => {
    const t = await tenant();
    const a = await analysis(t);
    await admin.query(`UPDATE repos SET installation_id = NULL WHERE id = $1`, [t.repoId]);
    expect(await mergeCandidates(appPool, t.accountId, { repoId: t.repoId, analysisId: a, ownerProcess: 'product', candidates: [cand()] })).toEqual({ state: 'skipped', reason: 'repo_not_connected' });
    expect(await rowsOf(t)).toHaveLength(0);
    expect(await mergeCandidates(appPool, t.accountId, { repoId: t.repoId, analysisId: randomUUID(), ownerProcess: 'product', candidates: [cand()] })).toEqual({ state: 'skipped', reason: 'analysis_not_visible' });
    await expect(mergeCandidates(appPool, t.accountId, { repoId: t.repoId, analysisId: a, ownerProcess: 'product', candidates: Array.from({ length: 11 }, (_, i) => cand({ title: `T${i}` })) })).rejects.toThrow('at most 10');
  });

  it('one bad ref rolls the whole call back (no partial write); titles with nothing left after cleaning are dropped; control tokens are stripped', async () => {
    const t = await tenant();
    await expect(merge(t, [cand({ title: 'Good one' }), cand({ title: 'Bad ref', refs: [{ path: '../etc/passwd', start_line: 1, end_line: 2 }] })])).rejects.toMatchObject({ code: '23514' });
    expect(await rowsOf(t)).toHaveLength(0);
    expect(await merge(t, [cand({ title: '!!!' }), cand({ title: '   ' }), cand({ title: 'Real one', summary: 'Visible <!-- hidden instruction --> text' })])).toEqual({ ...noMerge, created: 1 });
    const rows = await rowsOf(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).not.toContain('<!--');
  });

  it('a withdrawn row named by a candidate returns to new (as the import upserts do); an approved one stays approved', async () => {
    const t = await tenant();
    const id = await put(t, 'gh:issue:11', { gh_number: 11, title: 'Closed once', state: 'withdrawn' });
    await merge(t, [cand({ names_issue: 11 })]);
    expect(await one(id)).toMatchObject({ state: 'new', sources: ['github_issue', 'docs'] });
  });

  it('marks the verifier sweep pending after the commit when it wrote something, and not when it wrote nothing', async () => {
    const markers = new Map<string, number>();
    setPendingHooks({ store: { get: async (k) => markers.get(k) ?? null, set: async (k, v) => void markers.set(k, v), delete: async (k) => void markers.delete(k) } });
    const t = await tenant();
    await merge(t, [cand({ names_issue: 5000 })]);
    await new Promise((res) => setTimeout(res, 50));
    expect([...markers.keys()]).not.toContain('pending:proposal-verify-sweep');
    await merge(t, [cand({ title: 'Wakes the sweep' })]);
    await vi.waitFor(() => expect([...markers.keys()]).toContain('pending:proposal-verify-sweep'));
    expect((await rowsOf(t)).length).toBe(1);
  });

  it("another account's ids are invisible: its issue number, title and proposal id match nothing here", async () => {
    const t = await tenant();
    const o = await tenant();
    const theirs = await put(o, 'gh:issue:4', { gh_number: 4, title: 'Add a CLI flag' });
    const before = await one(theirs);
    expect(await merge(t, [cand({ names_issue: 4 })])).toEqual({ ...noMerge, named_item_not_in_inbox: 1 });
    expect(await merge(t, [cand({ duplicate_of: theirs })])).toEqual({ ...noMerge, created: 1 });
    expect(await one(theirs)).toEqual(before);
  });

  it('rule 3 is scoped to this repo: the same normalised title in a sibling repo of the same account creates THIS repo\'s own src row and leaves the sibling\'s row unchanged', async () => {
    const t = await tenant();
    const second = (await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, 78, 'team') RETURNING id`, [t.accountId, t.installationId])).rows[0]!.id;
    const sibling = await put(t, 'src:00000000000000cc', { sources: ['docs'], title: 'Add a CLI flag', summary: 'Sibling text', provenance: 'internal' }, second);
    const before = await one(sibling);
    expect(await merge(t, [cand({ kind: 'code', title: 'add a cli flag!', summary: 'This repo text' })])).toEqual({ ...noMerge, created: 1 });
    const mine = await rowsOf(t);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ repo_id: t.repoId, sources: ['code'], summary: 'This repo text', state: 'new' });
    expect(mine[0]!.dedupe_key).toMatch(/^src:[0-9a-f]{16}$/);
    expect(mine[0]!.id).not.toBe(sibling);
    expect(await one(sibling)).toEqual(before);
    expect(await rowsOf(t, second)).toHaveLength(1);
  });

  it('C0 controls in a title or summary are stripped before the write: a NUL no longer rolls the whole call back, and BEL and ESC are not stored', async () => {
    const t = await tenant();
    const counts = await merge(t, [
      cand({ title: 'Good one', summary: 'Fine.' }),
      cand({ title: 'Nul\u0000 in title', summary: 'ok' }),
      cand({ title: 'Bell and escape', summary: 'S\u0000ummary \u0007bell \u001b[31mred\u007f' }),
      cand({ title: 'Bell\u0007 esc\u001b[31m title', summary: null as unknown as string }),
      cand({ title: '\u0000\u0007', summary: 'dropped, nothing left of the title' }),
    ]);
    expect(counts).toEqual({ ...noMerge, created: 4 });
    const rows = await rowsOf(t);
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.title).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(r.summary ?? '').not.toMatch(/[\u0000-\u001f\u007f]/);
    }
    expect(rows.map((r) => r.title).sort()).toEqual(['Bell and escape', 'Bell esc[31m title', 'Good one', 'Nul in title']);
    expect(rows.find((r) => r.title === 'Bell and escape')!.summary).toBe('Summary bell [31mred');
  });

  it('an analysis the session cannot see is a skip (analysis_not_visible), while an analysis of ANOTHER repo of the account is still refused', async () => {
    const t = await tenant();
    const second = (await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, 79, 'team') RETURNING id`, [t.accountId, t.installationId])).rows[0]!.id;
    // Unknown id: nothing to see.
    expect(await mergeCandidates(appPool, t.accountId, { repoId: t.repoId, analysisId: randomUUID(), ownerProcess: 'product', candidates: [cand()] })).toEqual({ state: 'skipped', reason: 'analysis_not_visible' });
    // The account stopped being active: its rows are invisible to its own session.
    const a = await analysis(t);
    await admin.query(`UPDATE accounts SET deleted_at = now() WHERE id = $1`, [t.accountId]);
    try {
      expect(await mergeCandidates(appPool, t.accountId, { repoId: t.repoId, analysisId: a, ownerProcess: 'product', candidates: [cand()] })).toEqual({ state: 'skipped', reason: 'analysis_not_visible' });
    } finally {
      await admin.query(`UPDATE accounts SET deleted_at = NULL WHERE id = $1`, [t.accountId]);
    }
    expect(await rowsOf(t)).toHaveLength(0);
    // A real mismatch: the analysis is visible but belongs to the sibling repo.
    const sibling = await analysis(t, second);
    await expect(mergeCandidates(appPool, t.accountId, { repoId: t.repoId, analysisId: sibling, ownerProcess: 'product', candidates: [cand()] })).rejects.toThrow('does not belong');
    expect(await rowsOf(t)).toHaveLength(0);
  });
});
