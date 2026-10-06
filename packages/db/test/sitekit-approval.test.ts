import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { addExtraMember } from './helpers/members.js';
import {
  approve,
  attest,
  buildVerifyReport,
  carryForward,
} from '../../sitekit-publish-gates/src/approval/index.js';

// These tests are about K07a's own gates; the site checks approve() also runs (K07c) are covered in packages/api's sites-routes test.
vi.mock('../../sitekit-checks/src/index.js', () =>
  Object.fromEntries(
    ['checkLinks', 'checkMeta', 'checkNojs', 'checkWeight', 'checkRedaction', 'checkA11y', 'checkFreshness', 'checkRender', 'checkA11yStructure', 'checkMotion', 'checkDegrade'].map((k) => [k, async () => ({ ok: true, findings: [] })]),
  ),
);

/**
 * D#3 K07a: migration 0672 (freeze after approval, attestations.source_hash)
 * and the approval library in packages/sitekit-publish-gates/src/approval.
 * Runs against a real Postgres because the guarantees under test (tenant
 * binding, RLS, the freeze trigger) live there.
 */

const SHA = 'a'.repeat(40);
const AWS_KEY = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const PG_STATE = '55000';
const README = `https://github.com/owner/example/blob/${SHA}/README.md`;

interface ClaimSeed {
  key: string;
  kind?: string;
  verdict?: string;
  hash?: string | null;
  text?: string;
  locale?: string;
  runId?: string;
}
const verified = { verdict: 'VERIFIED' };
const EVIDENCE = [{ repo_sha: SHA, path: 'README.md', excerpt: 'x', checked_at: '2026-09-01T00:00:00Z' }];

function contentFor(claims: ClaimSeed[], hero: Record<string, unknown> = {}) {
  return {
    site: 'example',
    siteNameClaimId: 'site-name',
    repo: 'owner/example',
    repo_sha: SHA,
    domains: ['example.com'],
    pages: [
      {
        slug: 'index',
        sections: [
          { type: 'hero', props: { titleChrome: 'section.hero.title', ...hero } },
          { type: 'feature-grid', props: { titleChrome: 'section.features.title', featureClaimIds: claims.filter((c) => c.key !== 'site-name').map((c) => c.key) } },
        ],
      },
    ],
    claims: claims.map((c) => ({
      id: c.key, section: 'hero', locale: c.locale ?? 'en', text: c.text ?? 'Fast builds', kind: c.kind ?? 'feature', evidence: EVIDENCE,
      verdict: 'VERIFIED', checked_sha: SHA, checked_at: '2026-09-17T00:00:00Z', verifier_run_id: c.runId ?? 'run-1',
    })),
  };
}

describe('site-kit approval (D#3 K07a)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  let ownerA: string;
  let adminA: string;
  let memberA: string;
  let ownerB: string;

  const as = <T>(refs: SeedRefs, userId: string, fn: (c: PoolClient) => Promise<T>) => withTenant(appPool, refs.accountId, userId, fn);
  const pA = (userId: string) => ({ accountId: A.accountId, userId });

  /** A site with claim rows (default verified) and one version whose content lists them. */
  async function newSite(refs: SeedRefs, claims: ClaimSeed[], opts: { hero?: Record<string, unknown>; siteId?: string; createdAt?: string; report?: unknown } = {}) {
    const all: ClaimSeed[] = [{ key: 'site-name' }, ...claims];
    const siteId = opts.siteId ?? randomUUID();
    if (!opts.siteId) await admin.query(`INSERT INTO sites (id, account_id, repo_id) VALUES ($1, $2, $3)`, [siteId, refs.accountId, refs.repoId]);
    const ids: Record<string, string> = {};
    for (const c of all) {
      const existing = await admin.query(`SELECT id FROM claims WHERE site_id = $1 AND claim_key = $2`, [siteId, c.key]);
      if (existing.rows[0]) { ids[c.key] = existing.rows[0].id; continue; }
      ids[c.key] = randomUUID();
      const v = c.verdict ?? verified.verdict;
      await admin.query(
        `INSERT INTO claims (id, account_id, site_id, claim_key, text, kind, verdict, evidence, checked_sha, source_hash)
         VALUES ($1,$2,$3,$4,'t',$5,$6,$7::jsonb,$8,$9)`,
        [ids[c.key], refs.accountId, siteId, c.key, c.kind ?? 'feature', v, JSON.stringify(v === 'VERIFIED' ? EVIDENCE : []), v === 'VERIFIED' ? SHA : null, c.hash ?? null],
      );
    }
    const versionId = randomUUID();
    await admin.query(
      `INSERT INTO site_versions (id, account_id, site_id, repo_sha, content, report, template_version, template_digest, content_schema_version, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,'v1','d1',1, COALESCE($7::timestamptz, now()))`,
      [versionId, refs.accountId, siteId, SHA, JSON.stringify(contentFor(all, opts.hero)), opts.report ? JSON.stringify(opts.report) : null, opts.createdAt ?? null],
    );
    return { siteId, versionId, ids };
  }
  const approveOk = (versionId: string, terms = true, user = ownerA, approvedLinks = [README]) =>
    as(A, user, (c) => approve(c, pA(user), versionId, { termsAccepted: terms, approvedLinks }));
  const refusalOf = (r: { ok: boolean; refusal?: { code: string } }) => (r.ok ? 'ok' : r.refusal!.code);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
    ownerA = await addExtraMember(admin, A.accountId, 'owner');
    adminA = await addExtraMember(admin, A.accountId, 'admin');
    memberA = await addExtraMember(admin, A.accountId, 'member');
    ownerB = await addExtraMember(admin, B.accountId, 'owner');
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  describe('migration 0672', () => {
    it('freezes report, approved_by and approved_at once approved; published_at goes NULL to a value once', async () => {
      const { versionId } = await newSite(A, []);
      // Before approval every lifecycle column is still writable.
      await as(A, ownerA, (c) => c.query(`UPDATE site_versions SET report = '{"a":1}'::jsonb WHERE id = $1`, [versionId]));
      await admin.query(`UPDATE site_versions SET approved_by = $2, approved_at = now() WHERE id = $1`, [versionId, ownerA]);
      for (const set of [`report = '{"a":2}'::jsonb`, `approved_by = '${adminA}'`, `approved_at = now() + interval '1 day'`, `approved_by = NULL`]) {
        await expect(as(A, ownerA, (c) => c.query(`UPDATE site_versions SET ${set} WHERE id = $1`, [versionId]))).rejects.toMatchObject({ code: PG_STATE });
      }
      await as(A, ownerA, (c) => c.query(`UPDATE site_versions SET published_at = now() WHERE id = $1`, [versionId]));
      await expect(as(A, ownerA, (c) => c.query(`UPDATE site_versions SET published_at = now() + interval '1 day' WHERE id = $1`, [versionId]))).rejects.toMatchObject({ code: PG_STATE });
      await expect(as(A, ownerA, (c) => c.query(`UPDATE site_versions SET published_at = NULL WHERE id = $1`, [versionId]))).rejects.toMatchObject({ code: PG_STATE });
      // The trigger is not an app_user-only rule.
      await expect(admin.query(`UPDATE site_versions SET report = '{"a":3}'::jsonb WHERE id = $1`, [versionId])).rejects.toMatchObject({ code: PG_STATE });
    });

    it('stamps attestations.source_hash from the claim row, whatever the caller supplies', async () => {
      const { versionId, ids } = await newSite(A, [{ key: 'terms', kind: 'legal', hash: 'h1' }]);
      await as(A, ownerA, (c) => c.query(`INSERT INTO attestations (account_id, claim_id, version_id, user_id, source_hash) VALUES ($1,$2,$3,$4,'forged')`, [A.accountId, ids.terms, versionId, ownerA]));
      const r = await admin.query(`SELECT source_hash FROM attestations WHERE claim_id = $1`, [ids.terms]);
      expect(r.rows[0].source_hash).toBe('h1');
    });
  });

  describe('attest', () => {
    it('lets owner and admin attest a legal claim, once per claim and version', async () => {
      const { versionId, ids } = await newSite(A, [{ key: 'terms', kind: 'legal', verdict: 'PENDING' }]);
      expect(await as(A, ownerA, (c) => attest(c, pA(ownerA), ids.terms, versionId))).toEqual({ ok: true, created: true });
      expect(await as(A, adminA, (c) => attest(c, pA(adminA), ids.terms, versionId))).toEqual({ ok: true, created: false });
    });

    it('refuses a member, and a principal that is not the transaction session', async () => {
      const { versionId, ids } = await newSite(A, [{ key: 'terms', kind: 'legal', verdict: 'PENDING' }]);
      expect(refusalOf(await as(A, memberA, (c) => attest(c, pA(memberA), ids.terms, versionId)))).toBe('forbidden');
      // owner of B naming account A on a session for B
      expect(refusalOf(await as(B, ownerB, (c) => attest(c, pA(ownerB), ids.terms, versionId)))).toBe('forbidden');
      // owner of A claiming to be adminA on ownerA's session
      expect(refusalOf(await as(A, ownerA, (c) => attest(c, pA(adminA), ids.terms, versionId)))).toBe('forbidden');
    });

    it('is bound to the tenant: another account\'s claim or version is not found', async () => {
      const mine = await newSite(A, [{ key: 'terms', kind: 'legal', verdict: 'PENDING' }]);
      const theirs = await newSite(B, [{ key: 'terms', kind: 'legal', verdict: 'PENDING' }]);
      expect(refusalOf(await as(A, ownerA, (c) => attest(c, pA(ownerA), theirs.ids.terms, mine.versionId)))).toBe('not_found');
      expect(refusalOf(await as(A, ownerA, (c) => attest(c, pA(ownerA), mine.ids.terms, theirs.versionId)))).toBe('not_found');
      // With RLS out of the way (superuser session, GUCs set to account A) only the explicit account filter stands between A and B's rows.
      await admin.query('BEGIN');
      try {
        await admin.query(`SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)`, [A.accountId, ownerA]);
        expect(refusalOf(await attest(admin, pA(ownerA), theirs.ids.terms, mine.versionId))).toBe('not_found');
        expect(refusalOf(await attest(admin, pA(ownerA), mine.ids.terms, theirs.versionId))).toBe('not_found');
      } finally {
        await admin.query('ROLLBACK');
      }
    });

    it('refuses non-attestable kinds, a claim of another site, and an approved version', async () => {
      const s = await newSite(A, [{ key: 'terms', kind: 'legal', verdict: 'PENDING' }, { key: 'feat', kind: 'feature' }]);
      const other = await newSite(A, [{ key: 'terms', kind: 'legal', verdict: 'PENDING' }]);
      expect(await as(A, ownerA, (c) => attest(c, pA(ownerA), s.ids.feat, s.versionId))).toEqual({ ok: false, refusal: { code: 'not_attestable', kind: 'feature' } });
      expect(refusalOf(await as(A, ownerA, (c) => attest(c, pA(ownerA), other.ids.terms, s.versionId)))).toBe('claim_not_in_site');
      await admin.query(`UPDATE site_versions SET approved_by = $2, approved_at = now() WHERE id = $1`, [s.versionId, ownerA]);
      expect(refusalOf(await as(A, ownerA, (c) => attest(c, pA(ownerA), s.ids.terms, s.versionId)))).toBe('already_approved');
    });
  });

  describe('carry-forward by source_hash', () => {
    it('carries an unchanged hash as a new row for the new version, and not a changed hash', async () => {
      const v1 = await newSite(A, [{ key: 'terms', kind: 'legal', hash: 'h1' }, { key: 'price', kind: 'pricing', hash: 'p1' }], { createdAt: '2026-01-01' });
      for (const k of ['terms', 'price']) await as(A, ownerA, (c) => attest(c, pA(ownerA), v1.ids[k]!, v1.versionId));
      const same = [{ key: 'terms', kind: 'legal', hash: 'h1' }, { key: 'price', kind: 'pricing', hash: 'p1' }];
      const v2 = await newSite(A, same, { siteId: v1.siteId, createdAt: '2026-02-01' });
      await admin.query(`UPDATE claims SET source_hash = 'p2' WHERE id = $1`, [v1.ids.price]);
      const r = await as(A, adminA, (c) => carryForward(c, pA(adminA), v2.versionId));
      expect(r).toEqual({ ok: true, carried: [v1.ids.terms] });
      const rows = await admin.query(`SELECT claim_id, user_id, source_hash FROM attestations WHERE version_id = $1`, [v2.versionId]);
      expect(rows.rows).toEqual([{ claim_id: v1.ids.terms, user_id: adminA, source_hash: 'h1' }]);
    });

    it('does not carry from another site with the same hash, or a claim with no hash', async () => {
      const siteB = await newSite(A, [{ key: 'terms', kind: 'legal', hash: 'h1' }, { key: 'nohash', kind: 'legal', hash: null }], { createdAt: '2026-01-01' });
      for (const k of ['terms', 'nohash']) await as(A, ownerA, (c) => attest(c, pA(ownerA), siteB.ids[k]!, siteB.versionId));
      const siteA = await newSite(A, [{ key: 'terms', kind: 'legal', hash: 'h1' }, { key: 'nohash', kind: 'legal', hash: null }], { createdAt: '2026-02-01' });
      expect(await as(A, ownerA, (c) => carryForward(c, pA(ownerA), siteA.versionId))).toEqual({ ok: true, carried: [] });
      // An attestation row that sits on a version of a different site never carries either.
      const elsewhere = await newSite(A, [{ key: 'terms', kind: 'legal', hash: 'h9' }], { createdAt: '2026-01-01' });
      const target = await newSite(A, [{ key: 'terms', kind: 'legal', hash: 'h9' }], { createdAt: '2026-02-01' });
      await admin.query(`INSERT INTO attestations (account_id, claim_id, version_id, user_id) VALUES ($1,$2,$3,$4)`, [A.accountId, target.ids.terms, elsewhere.versionId, ownerA]);
      expect(await as(A, ownerA, (c) => carryForward(c, pA(ownerA), target.versionId))).toEqual({ ok: true, carried: [] });
      // ...and a later version's attestation is not "earlier".
      const early = await newSite(A, [{ key: 'terms', kind: 'legal', hash: 'h1' }], { createdAt: '2026-03-01' });
      const late = await newSite(A, [], { siteId: early.siteId, createdAt: '2026-04-01' });
      await as(A, ownerA, (c) => attest(c, pA(ownerA), early.ids.terms, late.versionId));
      expect(await as(A, ownerA, (c) => carryForward(c, pA(ownerA), early.versionId))).toEqual({ ok: true, carried: [] });
    });

    it('does not carry when the hash was reset but the text, kind or locale differ, or the claim is missing', async () => {
      const v1 = await newSite(A, [{ key: 'terms', kind: 'legal', hash: 'h1' }], { createdAt: '2026-01-01' });
      await as(A, ownerA, (c) => attest(c, pA(ownerA), v1.ids.terms, v1.versionId));
      // The claims row still carries h1 (a tenant can write it), so only the embedded content can tell.
      const carriedTo = async (claim: ClaimSeed[]) => {
        const v = await newSite(A, claim, { siteId: v1.siteId, createdAt: '2026-02-01' });
        return as(A, ownerA, (c) => carryForward(c, pA(ownerA), v.versionId));
      };
      expect(await carriedTo([{ key: 'terms', kind: 'legal', hash: 'h1', text: 'Different legal text' }])).toEqual({ ok: true, carried: [] });
      expect(await carriedTo([{ key: 'terms', kind: 'pricing', hash: 'h1' }])).toEqual({ ok: true, carried: [] });
      expect(await carriedTo([{ key: 'terms', kind: 'legal', hash: 'h1', locale: 'fr' }])).toEqual({ ok: true, carried: [] });
      expect(await carriedTo([])).toEqual({ ok: true, carried: [] });
      expect(await carriedTo([{ key: 'terms', kind: 'legal', hash: 'h1' }])).toEqual({ ok: true, carried: [v1.ids.terms] });
    });

    it('is owner/admin only', async () => {
      const v = await newSite(A, []);
      expect(refusalOf(await as(A, memberA, (c) => carryForward(c, pA(memberA), v.versionId)))).toBe('forbidden');
    });
  });

  describe('approve', () => {
    it('records approved_by and approved_at and persists the gate result, without publishing', async () => {
      const s = await newSite(A, [{ key: 'feat' }, { key: 'terms', kind: 'legal', verdict: 'PENDING' }]);
      await as(A, ownerA, (c) => attest(c, pA(ownerA), s.ids.terms, s.versionId));
      const r = await approveOk(s.versionId);
      expect(r.ok).toBe(true);
      const row = (await admin.query(`SELECT approved_by, approved_at, published_at, report->'publishGates'->>'ok' AS gates FROM site_versions WHERE id = $1`, [s.versionId])).rows[0];
      expect(row.approved_by).toBe(ownerA);
      expect(row.approved_at).not.toBeNull();
      expect(row.published_at).toBeNull();
      expect(row.gates).toBe('true');
      expect(refusalOf(await approveOk(s.versionId))).toBe('already_approved');
    });

    it('refuses a member, a false termsAccepted, and an unknown or other-tenant version', async () => {
      const s = await newSite(A, [{ key: 'feat' }]);
      expect(refusalOf(await approveOk(s.versionId, true, memberA))).toBe('forbidden');
      expect(refusalOf(await approveOk(s.versionId, false))).toBe('terms_not_accepted');
      expect(refusalOf(await approveOk(s.versionId, 'yes' as unknown as boolean))).toBe('terms_not_accepted');
      const theirs = await newSite(B, [{ key: 'feat' }]);
      expect(refusalOf(await approveOk(theirs.versionId))).toBe('not_found');
      expect((await admin.query(`SELECT approved_at FROM site_versions WHERE id = $1`, [s.versionId])).rows[0].approved_at).toBeNull();
    });

    it('fails closed: with no verdicts written, every claim is unverified and approval is refused', async () => {
      const s = await newSite(A, [{ key: 'feat', verdict: 'PENDING' }, { key: 'x', verdict: 'UNVERIFIABLE' }]);
      const r = await approveOk(s.versionId);
      expect(r).toMatchObject({ ok: false, refusal: { code: 'blocked' } });
      const rep = await as(A, ownerA, (c) => buildVerifyReport(c, A.accountId, s.versionId));
      expect(rep).toMatchObject({ ok: false, counts: { total: 3, VERIFIED: 1, PENDING: 1, UNVERIFIABLE: 1 } });
      expect(rep!.blockers.filter((b) => b.reason === 'claim-not-renderable').map((b) => b.claimId).sort()).toEqual(['feat', 'x']);
    });

    it('ignores verdicts embedded in content and a missing claims row: the database decides', async () => {
      const s = await newSite(A, [{ key: 'feat' }]);
      await admin.query(`DELETE FROM claims WHERE id = $1`, [s.ids.feat]);
      expect(refusalOf(await approveOk(s.versionId))).toBe('blocked');
    });

    it('needs an attestation bound to this version: neither another version\'s nor a stored ATTESTED verdict counts', async () => {
      const s = await newSite(A, [{ key: 'terms', kind: 'legal', verdict: 'ATTESTED' }]);
      const other = await newSite(A, [], { siteId: s.siteId });
      await as(A, ownerA, (c) => attest(c, pA(ownerA), s.ids.terms, other.versionId));
      const r = await approveOk(s.versionId);
      expect(r).toMatchObject({ ok: false, refusal: { code: 'unattested_claim', claimIds: ['terms'] } });
      const rep = await as(A, ownerA, (c) => buildVerifyReport(c, A.accountId, s.versionId));
      expect(rep!.counts).toMatchObject({ ATTESTED: 0, PENDING: 1 });
    });

    it('refuses a VERIFIED legal claim that has no attestation bound to this version', async () => {
      const s = await newSite(A, [{ key: 'terms', kind: 'legal', verdict: 'VERIFIED' }]);
      expect(await approveOk(s.versionId)).toMatchObject({ ok: false, refusal: { code: 'unattested_claim', claimIds: ['terms'] } });
      expect((await admin.query(`SELECT approved_at FROM site_versions WHERE id = $1`, [s.versionId])).rows[0].approved_at).toBeNull();
      await as(A, ownerA, (c) => attest(c, pA(ownerA), s.ids.terms, s.versionId));
      expect((await approveOk(s.versionId)).ok).toBe(true);
    });

    it('re-runs the leak gate on the server: a forged stored report cannot satisfy it', async () => {
      const forged = { publishGates: { version: 1, ok: true, leak: { ok: true, findings: [] }, links: { ok: true, findings: [] }, pendingLinks: [] } };
      const s = await newSite(A, [{ key: 'feat', text: `key ${AWS_KEY}` }], { report: forged });
      const r = await approveOk(s.versionId);
      expect(r).toMatchObject({ ok: false, refusal: { code: 'leak' } });
      expect((await admin.query(`SELECT approved_at, report->'publishGates'->>'ok' AS ok FROM site_versions WHERE id = $1`, [s.versionId])).rows[0]).toEqual({ approved_at: null, ok: 'false' });
    });

    it('scans the content JSON for leaks too: a secret that no rendered page shows still refuses', async () => {
      const s = await newSite(A, [{ key: 'feat', runId: AWS_KEY }]);
      expect(await approveOk(s.versionId)).toMatchObject({ ok: false, refusal: { code: 'leak', findings: [{ path: '/site.json' }] } });
    });

    it('re-runs the link gate on the server: an outbound link needs approval', async () => {
      const s = await newSite(A, [{ key: 'feat' }], { hero: { ctaChrome: 'section.hero.cta', ctaHref: 'https://github.com/owner/example' } });
      const r = await approveOk(s.versionId);
      expect(r).toMatchObject({ ok: false, refusal: { code: 'unapproved_link', links: ['https://github.com/owner/example'] } });
      // Approving exactly that URL lets it through; the evidence link alone is not enough.
      expect(refusalOf(await approveOk(s.versionId, true, ownerA, []))).toBe('unapproved_link');
      expect((await approveOk(s.versionId, true, ownerA, [README, 'https://github.com/owner/example'])).ok).toBe(true);
    });

    it('refuses when a site asset cannot be resolved, as render_failed', async () => {
      const s = await newSite(A, [{ key: 'feat' }], { hero: { backgroundImage: '/images/bg.png' } });
      expect(refusalOf(await approveOk(s.versionId))).toBe('render_failed');
    });
  });

  describe('verify report', () => {
    it('gives the evidence as commit-pinned links, with the date only when the record has one, and never claims a guarantee', async () => {
      const s = await newSite(A, [{ key: 'feat' }]);
      await admin.query(`UPDATE claims SET evidence = '[{"repo_sha":"${SHA}","path":"src/a b.ts","excerpt":"x"},{"repo_sha":"main","path":"x","excerpt":"x"}]' WHERE id = $1`, [s.ids.feat]);
      const rep = (await as(A, ownerA, (c) => buildVerifyReport(c, A.accountId, s.versionId)))!;
      const feat = rep.evidence.filter((e) => e.claimId === 'feat');
      expect(feat).toEqual([{ claimId: 'feat', path: 'src/a b.ts', sha: SHA, date: undefined, text: `traced to commit ${SHA}`, href: `https://github.com/owner/example/blob/${SHA}/src/a%20b.ts` }]);
      await admin.query(`UPDATE claims SET evidence = '[{"repo_sha":"${SHA}","path":"a","excerpt":"x","checked_at":"<b>2026-13-45</b>"},{"repo_sha":"${SHA}","path":"b","excerpt":"x","checked_at":"2026-02-31"},{"repo_sha":"${SHA}","path":"c","excerpt":"x","checked_at":"2026-09-01"}]' WHERE id = $1`, [s.ids.feat]);
      const dated = (await as(A, ownerA, (c) => buildVerifyReport(c, A.accountId, s.versionId)))!.evidence.filter((e) => e.claimId === 'feat');
      expect(dated.map((e) => e.date)).toEqual([undefined, undefined, '2026-09-01']);
      expect(dated.map((e) => e.text)).toEqual([`traced to commit ${SHA}`, `traced to commit ${SHA}`, `traced to commit ${SHA} on 2026-09-01`]);
      expect(rep.evidence.find((e) => e.claimId === 'site-name')!.text).toBe(`traced to commit ${SHA} on 2026-09-01T00:00:00Z`);
      expect(await as(A, ownerA, (c) => buildVerifyReport(c, A.accountId, randomUUID()))).toBeNull();
      const words = ['guarant' + 'eed', 'warr' + 'anty'];
      const dir = new URL('../../sitekit-publish-gates/src/approval/', import.meta.url);
      const text = [JSON.stringify(rep), ...readdirSync(dir).map((f) => readFileSync(new URL(f, dir), 'utf8'))].join('\n').toLowerCase();
      for (const w of words) expect(text).not.toContain(w);
    });
  });
});
