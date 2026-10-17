import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { NotFoundError } from '../src/tenancy/errors.js';
import * as planIndex from '../src/plan/index.js';
import { getProposal, listProposals, readProposal, proposalTenant, type ProposalCtx } from '../src/plan/proposals.js';
import {
  INBOX_SECTIONS,
  MAX_VERIFY_ATTEMPTS,
  VERIFICATIONS,
  buildEvidenceUrl,
  inboxSection,
  parseFileRef,
  verifyRetry,
  type Verification,
} from '../src/plan/proposalVerification.js';

/**
 * D#483 S4-i: the proposal verification read. Acceptance S4i-1 through S4i-4, S4i-6, S4i-8 and S4i-9 here (the routes' own
 * lines, S4i-5, S4i-7 and S4i-10, are in packages/api/test/proposal-routes.test.ts). Writes go through the real definer
 * (proposal_record_verification) in a tenant session; reads go through the module as the real app_user role under 0839's RLS.
 */
const SHA = 'a'.repeat(40);

describe('proposal verification read (S4-i)', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs;
  let b: SeedRefs;
  let repoA: string;
  let repoB: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    repoA = await newRepo(a, 'acme', 'widgets');
    repoB = await newRepo(b, 'other', 'thing');
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  async function newRepo(r: SeedRefs, owner: string | null, name: string | null): Promise<string> {
    const id = randomUUID();
    await admin.query('INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      id, r.accountId, r.installationId, Math.floor(Math.random() * 1e9) + 10, 'team', owner, name,
    ]);
    return id;
  }
  async function newProposal(r: SeedRefs, repoId: string, over: Record<string, unknown> = {}): Promise<string> {
    const row = { dedupe_key: `plan:T${randomUUID().slice(0, 8)}`, sources: ['plan_task'], title: 'A task', provenance: 'internal', owner_process: 'product', state: 'new', ...over };
    const cols = Object.keys(row);
    const { rows } = await admin.query(
      `INSERT INTO proposals (account_id, repo_id, ${cols.join(', ')}) VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
      [r.accountId, repoId, ...Object.values(row)],
    );
    return rows[0].id;
  }
  const ctxOf = (r: SeedRefs, pool: Pool = appPool): ProposalCtx => ({ pool, principal: { accountId: r.accountId, userId: r.userId } });
  /** The verifier's own session: a tenant transaction with no user, calling the one definer. */
  function record(r: SeedRefs, proposal: string, o: { verification: Verification; claims?: unknown[]; evidence?: unknown[] }) {
    const needsRun = o.verification === 'verified' || o.verification === 'partly_verified';
    const needsSha = needsRun || o.verification === 'refuted';
    return withTenant(appPool, r.accountId, (c) =>
      c.query('SELECT * FROM proposal_record_verification($1, $2, $3, $4, $5::jsonb, $6::jsonb)', [
        proposal, o.verification, needsSha ? SHA : null, needsRun ? r.runId : null, JSON.stringify(o.claims ?? []), JSON.stringify(o.evidence ?? []),
      ]),
    );
  }
  const ev = (over: Record<string, unknown> = {}) => ({ kind: 'file_lines', ref: 'src/app.ts:40-44', excerpt: 'const a = 1;', commit_sha: SHA, ...over });

  describe('S4i-1: the detail route reads claims and evidence in order, bytes unchanged', () => {
    it('returns all of them, refuted first and evidence by creation, with the stored text', async () => {
      const id = await newProposal(a, repoA);
      const excerpt = 'line one\n\tindented  \r\nünï "q" <b>';
      await record(a, id, {
        verification: 'partly_verified',
        claims: [
          { text: 'It is supported', verdict: 'supported' },
          { text: 'It cannot be checked', verdict: 'unverifiable' },
          { text: 'It was refuted', verdict: 'refuted', refute_code: 'cite_not_found' },
        ],
        evidence: [ev({ excerpt }), ev({ kind: 'issue', ref: '#12', commit_sha: null, excerpt: 'an issue' })],
      });
      const d = await getProposal(ctxOf(a), id);
      expect(d.claims.map((c) => [c.verdict, c.text, c.refute_code])).toEqual([
        ['refuted', 'It was refuted', 'cite_not_found'],
        ['unverifiable', 'It cannot be checked', null],
        ['supported', 'It is supported', null],
      ]);
      expect(d.claims[0]).toMatchObject({ checked_sha: SHA });
      expect(d.claims[0]!.checked_at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
      expect(d.evidence).toHaveLength(2);
      // both rows tie on created_at, so find each by kind rather than by position
      expect(d.evidence.find((e) => e.kind === 'file_lines')!.excerpt).toBe(excerpt);
      expect(d.evidence.find((e) => e.kind === 'issue')!.excerpt).toBe('an issue');
      expect(d.evidence.map((e) => e.kind).sort()).toEqual(['file_lines', 'issue']);
      // one definer call writes both rows in one transaction, so created_at ties and the order falls to the id
      expect(d.evidence.map((e) => e.id)).toEqual(d.evidence.map((e) => e.id).sort());
      expect(d).toMatchObject({ verification: 'partly_verified', verified_sha: SHA, claim_counts: { supported: 1, refuted: 1, unverifiable: 1, pending: 0 }, evidence_count: 2 });
    });

    it('orders equal verdicts by text, then id, and a proposal with nothing recorded has empty lists', async () => {
      const id = await newProposal(a, repoA);
      await record(a, id, { verification: 'verified', claims: [{ text: 'b', verdict: 'supported' }, { text: 'a', verdict: 'supported' }, { text: 'c', verdict: 'pending' }] });
      expect((await getProposal(ctxOf(a), id)).claims.map((c) => c.text)).toEqual(['c', 'a', 'b']);
      const bare = await getProposal(ctxOf(a), await newProposal(a, repoA));
      expect(bare).toMatchObject({ claims: [], evidence: [], evidence_count: 0, claim_counts: { supported: 0, refuted: 0, unverifiable: 0, pending: 0 }, verification: 'pending', verified_at: null, verified_sha: null });
    });
  });

  describe('S4i-2: inbox_section over all six verification values', () => {
    const expected: Record<Verification, string> = {
      verified: 'new', partly_verified: 'new', pending: 'being_checked', refuted: 'couldnt_confirm', check_failed: 'couldnt_confirm', not_checked: 'not_checked',
    };
    it('maps each value for a new product proposal, as the stored rows read back', async () => {
      for (const v of VERIFICATIONS) {
        const id = await newProposal(a, repoA);
        if (v !== 'pending') await record(a, id, { verification: v });
        expect((await getProposal(ctxOf(a), id)).inbox_section, v).toBe(expected[v]);
      }
    });
    it('is null for approved, rejected and withdrawn rows and for an internal_loop row, whatever the verification', async () => {
      for (const state of ['approved', 'rejected', 'withdrawn']) {
        const id = await newProposal(a, repoA);
        await record(a, id, { verification: 'verified' });
        // the decision columns are moved by an admin write (a verification write may not change them)
        if (state === 'approved') await admin.query(`UPDATE proposals SET state = 'approved', roadmap_position = 9999, decided_at = now(), decided_by_user_id = $2 WHERE id = $1`, [id, a.userId]);
        else if (state === 'rejected') await admin.query(`UPDATE proposals SET state = 'rejected', decided_at = now(), decided_by_user_id = $2, reject_kind = 'never' WHERE id = $1`, [id, a.userId]);
        else await admin.query(`UPDATE proposals SET state = 'withdrawn' WHERE id = $1`, [id]);
        expect((await getProposal(ctxOf(a), id)).inbox_section, state).toBeNull();
      }
      const loop = await newProposal(a, repoA, { owner_process: 'internal_loop' });
      await record(a, loop, { verification: 'verified' });
      expect((await getProposal(ctxOf(a), loop)).inbox_section).toBeNull();
    });
    it('the pure rule maps every value, and check_failed to Could not confirm', () => {
      for (const v of VERIFICATIONS) expect(INBOX_SECTIONS).toContain(inboxSection({ state: 'new', owner_process: 'product', verification: v }));
      expect(inboxSection({ state: 'new', owner_process: 'product', verification: 'check_failed' })).toBe('couldnt_confirm');
    });
  });

  describe('S4i-3: verify_retry and the shared cap', () => {
    it('is true at check_failed with 2 attempts and false at 3, through the stored counter', async () => {
      const id = await newProposal(a, repoA);
      await record(a, id, { verification: 'check_failed' });
      await record(a, id, { verification: 'check_failed' });
      expect(await getProposal(ctxOf(a), id)).toMatchObject({ verify_attempts: 2, verify_attempts_max: 3, verify_retry: true });
      await record(a, id, { verification: 'check_failed' });
      expect(await getProposal(ctxOf(a), id)).toMatchObject({ verify_attempts: 3, verify_attempts_max: 3, verify_retry: false });
    });
    it('is false for every other verification, however few attempts', () => {
      for (const v of VERIFICATIONS) if (v !== 'check_failed') expect(verifyRetry({ verification: v, verify_attempts: 0 }), v).toBe(false);
      expect(verifyRetry({ verification: 'check_failed', verify_attempts: 0 })).toBe(true);
    });
    it('verify_attempts_max is the one exported constant, 3, reachable from the plan index S4-b imports', () => {
      expect(MAX_VERIFY_ATTEMPTS).toBe(3);
      expect(planIndex.MAX_VERIFY_ATTEMPTS).toBe(MAX_VERIFY_ATTEMPTS);
    });
  });

  describe('S4i-4: cross-account reads under RLS', () => {
    it("account B's context gets 404 for A's proposal, and a direct SELECT as app_user returns none of A's rows", async () => {
      const id = await newProposal(a, repoA);
      await record(a, id, { verification: 'refuted', claims: [{ text: 'x', verdict: 'refuted', refute_code: 'contradicted' }], evidence: [ev()] });
      await expect(getProposal(ctxOf(b), id)).rejects.toBeInstanceOf(NotFoundError);
      expect((await listProposals(ctxOf(b), {})).proposals.map((p) => p.id)).not.toContain(id);
      for (const table of ['proposal_claims', 'proposal_evidence']) {
        const asB = await withTenant(appPool, b.accountId, (c) => c.query(`SELECT 1 FROM ${table} WHERE proposal_id = $1`, [id]));
        expect(asB.rowCount, table).toBe(0);
        const asA = await withTenant(appPool, a.accountId, (c) => c.query(`SELECT 1 FROM ${table} WHERE proposal_id = $1`, [id]));
        expect(asA.rowCount, table).toBe(1);
      }
    });
    it("counts cover only the caller's own rows", async () => {
      const mine = await newProposal(b, repoB);
      await record(b, mine, { verification: 'refuted', claims: [{ text: 'b claim', verdict: 'refuted', refute_code: 'cite_mismatch' }] });
      expect(await getProposal(ctxOf(b), mine)).toMatchObject({ claim_counts: { refuted: 1, supported: 0, unverifiable: 0, pending: 0 }, evidence_count: 0 });
    });
    it('an inactive account reads no claims and no evidence', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repo = await newRepo(r, 'acme', 'gone');
      const id = await newProposal(r, repo);
      await record(r, id, { verification: 'refuted', claims: [{ text: 'x', verdict: 'refuted', refute_code: 'contradicted' }], evidence: [ev()] });
      await admin.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [r.accountId]);
      const rows = await withTenant(appPool, r.accountId, (c) => c.query('SELECT 1 FROM proposal_claims UNION ALL SELECT 1 FROM proposal_evidence'));
      expect(rows.rowCount).toBe(0);
    });
  });

  describe('S4i-6: the list is counts only and costs a fixed number of statements', () => {
    it('50 proposals with claims and evidence: counts present, no lists, at most 3 data statements', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repo = await newRepo(r, 'acme', 'many');
      for (let i = 0; i < 50; i++) {
        const id = await newProposal(r, repo);
        await record(r, id, {
          verification: 'partly_verified',
          claims: [{ text: `c${i}a`, verdict: 'supported' }, { text: `c${i}b`, verdict: 'unverifiable' }],
          evidence: [ev(), ev({ kind: 'issue', ref: '#3', commit_sha: null })],
        });
      }
      const seen: string[] = [];
      const counting = {
        connect: async () => {
          const c = await appPool.connect();
          const q = c.query.bind(c) as (...a: unknown[]) => unknown;
          (c as unknown as { query: unknown }).query = (...args: unknown[]) => {
            const text = typeof args[0] === 'string' ? args[0] : ((args[0] as { text?: string })?.text ?? '');
            seen.push(text);
            return q(...args);
          };
          return c;
        },
      } as unknown as Pool;
      const out = await listProposals(ctxOf(r, counting), {});
      expect(out.proposals).toHaveLength(50);
      for (const p of out.proposals) {
        expect(p.claim_counts).toEqual({ supported: 1, refuted: 0, unverifiable: 1, pending: 0 });
        expect(p.evidence_count).toBe(2);
        expect(p).not.toHaveProperty('claims');
        expect(p).not.toHaveProperty('evidence');
      }
      // withTenant's own BEGIN, set_config, COMMIT and RESET are not data statements
      const data = seen.filter((t) => !/^\s*(BEGIN|COMMIT|ROLLBACK|RESET|SET\b|SELECT set_config)/i.test(t));
      expect(data.length, data.join('\n---\n')).toBeLessThanOrEqual(3);
      expect(data.length).toBeGreaterThanOrEqual(2);
    });
    it('the section filter selects in SQL and requires state=new', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repo = await newRepo(r, 'acme', 'sect');
      const ids: Record<string, string> = {};
      for (const v of VERIFICATIONS) {
        ids[v] = await newProposal(r, repo);
        if (v !== 'pending') await record(r, ids[v]!, { verification: v });
      }
      const loop = await newProposal(r, repo, { owner_process: 'internal_loop' });
      await record(r, loop, { verification: 'refuted' });
      const sec = async (section: (typeof INBOX_SECTIONS)[number]) => (await listProposals(ctxOf(r), { state: 'new', section })).proposals.map((p) => p.id).sort();
      expect(await sec('couldnt_confirm')).toEqual([ids.refuted!, ids.check_failed!].sort());
      expect(await sec('new')).toEqual([ids.verified!, ids.partly_verified!].sort());
      expect(await sec('being_checked')).toEqual([ids.pending!]);
      expect(await sec('not_checked')).toEqual([ids.not_checked!]);
      await expect(listProposals(ctxOf(r), { section: 'new' })).rejects.toMatchObject({ code: 'invalid_filter' });
      await expect(listProposals(ctxOf(r), { state: 'approved', section: 'new' })).rejects.toMatchObject({ code: 'invalid_filter' });
    });
  });

  describe('S4i-8: server-built URLs', () => {
    const repo = { owner: 'acme', name: 'widgets' };
    it('builds the percent-encoded blob URL with the line range', () => {
      expect(buildEvidenceUrl({ kind: 'file_lines', ref: 'docs/a b.md:3-7', commit_sha: SHA }, repo)).toBe(`https://github.com/acme/widgets/blob/${SHA}/docs/a%20b.md#L3-L7`);
      expect(buildEvidenceUrl({ kind: 'doc_passage', ref: 'README.md:9', commit_sha: SHA }, repo)).toBe(`https://github.com/acme/widgets/blob/${SHA}/README.md#L9`);
      expect(buildEvidenceUrl({ kind: 'issue', ref: '#12', commit_sha: null }, repo)).toBe('https://github.com/acme/widgets/issues/12');
      expect(buildEvidenceUrl({ kind: 'discussion', ref: '#7', commit_sha: null }, repo)).toBe('https://github.com/acme/widgets/discussions/7');
    });
    it('fences a path: reserved characters are encoded and traversal, absolute and backslash paths give no link', () => {
      expect(buildEvidenceUrl({ kind: 'file_lines', ref: 'a?x=1#y%2F.md:1-2', commit_sha: SHA }, repo)).toBe(`https://github.com/acme/widgets/blob/${SHA}/a%3Fx%3D1%23y%252F.md#L1-L2`);
      for (const ref of ['../etc/passwd:1-2', 'a/../b:1', '/abs:1', 'a\\b:1', 'a//b:1', './a:1', 'a:0', 'a:5-2', 'a:1-', 'a', ':3', 'a:99999999', 'a:1-2-3']) {
        expect(buildEvidenceUrl({ kind: 'file_lines', ref, commit_sha: SHA }, repo), ref).toBeNull();
      }
      expect(parseFileRef('x:1-2')).toEqual({ path: 'x', start: 1, end: 2 });
    });
    it('gives null for a malformed ref, a file kind with no or a bad sha, interview and preview rows, and a bad or missing repo name', () => {
      expect(buildEvidenceUrl({ kind: 'file_lines', ref: 'nonsense', commit_sha: SHA }, repo)).toBeNull();
      expect(buildEvidenceUrl({ kind: 'file_lines', ref: 'a.md:1-2', commit_sha: null }, repo)).toBeNull();
      expect(buildEvidenceUrl({ kind: 'doc_passage', ref: 'a.md:1-2', commit_sha: 'abc' }, repo)).toBeNull();
      expect(buildEvidenceUrl({ kind: 'issue', ref: '12', commit_sha: null }, repo)).toBeNull();
      expect(buildEvidenceUrl({ kind: 'issue', ref: '#0', commit_sha: null }, repo)).toBeNull();
      expect(buildEvidenceUrl({ kind: 'issue', ref: '#1/../../x', commit_sha: null }, repo)).toBeNull();
      expect(buildEvidenceUrl({ kind: 'interview_answer', ref: 'goals', commit_sha: null }, repo)).toBeNull();
      expect(buildEvidenceUrl({ kind: 'preview', ref: '#4', commit_sha: null }, repo)).toBeNull();
      expect(buildEvidenceUrl({ kind: 'issue', ref: '#4', commit_sha: null }, { owner: null, name: 'w' })).toBeNull();
      expect(buildEvidenceUrl({ kind: 'issue', ref: '#4', commit_sha: null }, { owner: 'a/b', name: 'w' })).toBeNull();
      expect(buildEvidenceUrl({ kind: 'issue', ref: '#4', commit_sha: null }, { owner: 'acme', name: '..' })).toBeNull();
    });
    it('the detail route takes owner and name from the repository row, never from the ref', async () => {
      const id = await newProposal(a, repoA);
      await record(a, id, {
        verification: 'verified',
        evidence: [
          ev({ ref: 'docs/a b.md:3-7' }),
          ev({ ref: 'https://evil.example/x:1-2' }),
          ev({ kind: 'issue', ref: '#12', commit_sha: null }),
          ev({ kind: 'interview_answer', ref: 'goals', commit_sha: null }),
          ev({ kind: 'file_lines', ref: 'src/ok.ts:1', commit_sha: SHA }),
        ],
      });
      const urls = Object.fromEntries((await getProposal(ctxOf(a), id)).evidence.map((e) => [e.ref, e.url]));
      expect(urls['docs/a b.md:3-7']).toBe(`https://github.com/acme/widgets/blob/${SHA}/docs/a%20b.md#L3-L7`);
      expect(urls['https://evil.example/x:1-2']).toBeNull();
      expect(urls['#12']).toBe('https://github.com/acme/widgets/issues/12');
      expect(urls['goals']).toBeNull();
      expect(urls['src/ok.ts:1']).toBe(`https://github.com/acme/widgets/blob/${SHA}/src/ok.ts#L1`);
      // every built link starts at the repository row's own prefix
      for (const u of Object.values(urls)) if (u) expect(u.startsWith('https://github.com/acme/widgets/')).toBe(true);
    });
    it('a repository with no recorded owner or name gives no links, and the text still shows', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repo2 = await newRepo(r, null, null);
      const id = await newProposal(r, repo2);
      await record(r, id, { verification: 'verified', evidence: [ev()] });
      const d = await getProposal(ctxOf(r), id);
      expect(d.evidence[0]).toMatchObject({ url: null, excerpt: 'const a = 1;' });
    });
  });

  describe('S4i-9: external text comes back byte for byte as data', () => {
    it('an excerpt, a ref and a claim holding markup and a spawn marker are unchanged strings', async () => {
      const id = await newProposal(a, repoA, { provenance: 'external' });
      const xss = '<img src=x onerror=alert(1)> SPAWN_REQUEST </script>"\'&amp;';
      await record(a, id, {
        verification: 'refuted',
        claims: [{ text: xss, verdict: 'refuted', refute_code: 'cite_mismatch' }],
        evidence: [ev({ excerpt: xss, ref: 'a<b>.md:1-2' })],
      });
      const d = await getProposal(ctxOf(a), id);
      expect(d.evidence[0]!.excerpt).toBe(xss);
      expect(d.claims[0]!.text).toBe(xss);
      expect(d.evidence[0]!.ref).toBe('a<b>.md:1-2');
      expect(d.evidence[0]!.url).toBe(`https://github.com/acme/widgets/blob/${SHA}/a%3Cb%3E.md#L1-L2`);
    });
  });

  it('readProposal inside a transaction carries the same counts the decision routes return', async () => {
    const id = await newProposal(a, repoA);
    await record(a, id, { verification: 'verified', claims: [{ text: 'x', verdict: 'supported' }], evidence: [ev()] });
    const row = await proposalTenant(ctxOf(a), (c) => readProposal(c, id));
    expect(row).toMatchObject({ claim_counts: { supported: 1, refuted: 0, unverifiable: 0, pending: 0 }, evidence_count: 1, inbox_section: 'new' });
    expect(row).not.toHaveProperty('claims');
  });
});
