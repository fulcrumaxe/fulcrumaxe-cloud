import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { withTenant } from '@fx/core/src/tenancy/withTenant.js';
import { approve } from '../../sitekit-publish-gates/src/approval/index.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { generateToken, displayHint } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

/**
 * The site checks are the real ones unless a flag says otherwise. The rendered fixture fails real static checks (few words, and
 * the 40-hex commit sha in every evidence link), so a test that needs an approval turns `passStatic` / `passBrowser` on: a stub
 * passes with one advisory finding. A browser stub also passes when approve() is handed `stubs.driver`.
 */
const stubs = vi.hoisted(() => ({ passStatic: false, passBrowser: false, failMeta: false, driver: { open: async () => { throw new Error('unused'); }, close: async () => {} } }));
vi.mock('../../sitekit-checks/src/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../sitekit-checks/src/index.js')>();
  type Fn = (d: string, o?: Record<string, unknown>) => Promise<unknown>;
  const pass = { ok: true, findings: [{ path: '/', kind: 'not_applicable', message: 'stub', severity: 'advisory' }] };
  const stat = (fn: Fn): Fn => async (d, o) => (stubs.passStatic ? pass : fn(d, o));
  const browser = (fn: Fn): Fn => async (d, o) => (stubs.passBrowser || o?.driver === stubs.driver ? pass : fn(d, o));
  return {
    ...real,
    checkLinks: stat(real.checkLinks), checkNojs: stat(real.checkNojs), checkWeight: stat(real.checkWeight),
    checkRedaction: stat(real.checkRedaction), checkA11y: stat(real.checkA11y), checkFreshness: stat(real.checkFreshness as Fn),
    checkMeta: async (d: string, o?: Record<string, unknown>) =>
      stubs.failMeta ? { ok: false, findings: [{ path: '/', kind: 'bad_title', message: 'ATTACKER <script> injected', severity: 'error' }] } : stat(real.checkMeta)(d, o),
    checkRender: browser(real.checkRender as Fn), checkA11yStructure: browser(real.checkA11yStructure as Fn),
    checkMotion: browser(real.checkMotion as Fn), checkDegrade: browser(real.checkDegrade as Fn),
  };
});

interface Identity {
  accountId: string;
  userId: string;
}
const SHA = 'a'.repeat(40);
const README = `https://github.com/owner/example/blob/${SHA}/README.md`;
let seq = 5000;
const EVIDENCE = [{ repo_sha: SHA, path: 'README.md', excerpt: 'x', checked_at: '2026-09-01' }];

/** D#3 K07b: the site-version review, attest and approve routes through the real dispatcher against real Postgres. */
describe('D#3 K07b: site routes', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let owner: Identity;
  let adminU: Identity;
  let member: Identity;
  let other: Identity;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    owner = await seedAccountWithMember(admin, { role: 'owner' });
    adminU = await memberOf(owner, 'admin');
    member = await memberOf(owner, 'member');
    other = await seedAccountWithMember(admin, { role: 'owner' });
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  async function memberOf(account: Identity, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [account.accountId, userId, role]);
    return { accountId: account.accountId, userId };
  }
  async function call(who: Identity | string, method: string, path: string, body?: unknown): Promise<Response> {
    const h = new Headers();
    if (typeof who === 'string') h.set('authorization', `Bearer ${who}`);
    else h.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    if (body !== undefined) h.set('content-type', 'application/json');
    const init = { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) };
    return handleApiRequest(new Request(`http://localhost/api/v1${path}`, init), appUserPool, platformOpsPool, ROUTES);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = async (res: Response) => (await res.json()) as Record<string, any>;

  /** A site with a verified feature claim (+ a legal claim when asked) and one version whose content lists them. */
  async function newVersion(who: Identity, opts: { legal?: boolean; hero?: Record<string, unknown>; siteId?: string; createdAt?: string } = {}) {
    const siteId = opts.siteId ?? randomUUID();
    const repoId = randomUUID();
    if (!opts.siteId) {
      await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1, $2, $3, 'team')`, [repoId, who.accountId, ++seq]);
      await admin.query(`INSERT INTO sites (id, account_id, repo_id) VALUES ($1,$2,$3)`, [siteId, who.accountId, repoId]);
    }
    const keys = [{ key: 'site-name', kind: 'feature' }, { key: 'feat', kind: 'feature' }, ...(opts.legal ? [{ key: 'terms', kind: 'legal' }] : [])];
    const ids: Record<string, string> = {};
    for (const c of keys) {
      const ex = await admin.query(`SELECT id FROM claims WHERE site_id = $1 AND claim_key = $2`, [siteId, c.key]);
      if (ex.rows[0]) { ids[c.key] = ex.rows[0].id; continue; }
      ids[c.key] = randomUUID();
      await admin.query(
        `INSERT INTO claims (id, account_id, site_id, claim_key, text, kind, verdict, evidence, checked_sha, source_hash) VALUES ($1,$2,$3,$4,'t',$5,'VERIFIED',$6::jsonb,$7,'h1')`,
        [ids[c.key], who.accountId, siteId, c.key, c.kind, JSON.stringify(EVIDENCE), SHA],
      );
    }
    const content = {
      site: 'example', siteNameClaimId: 'site-name', repo: 'owner/example', repo_sha: SHA, domains: ['example.com'],
      pages: [{ slug: 'index', sections: [
        { type: 'hero', props: { titleChrome: 'section.hero.title', ...opts.hero } },
        { type: 'feature-grid', props: { titleChrome: 'section.features.title', featureClaimIds: keys.filter((k) => k.key !== 'site-name').map((k) => k.key) } },
      ] }],
      claims: keys.map((k) => ({ id: k.key, section: 'hero', locale: 'en', text: 'Fast builds', kind: k.kind, evidence: EVIDENCE, verdict: 'VERIFIED', checked_sha: SHA, checked_at: '2026-09-17', verifier_run_id: 'run-1' })),
    };
    const versionId = randomUUID();
    await admin.query(
      `INSERT INTO site_versions (id, account_id, site_id, repo_sha, content, template_version, template_digest, content_schema_version, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,'v1','d1',1, COALESCE($6::timestamptz, now()))`,
      [versionId, who.accountId, siteId, SHA, JSON.stringify(content), opts.createdAt ?? null],
    );
    return { siteId, versionId, ids };
  }
  const auditRows = async (accountId: string, action: string) =>
    (await admin.query(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = $2 ORDER BY created_at`, [accountId, action])).rows;
  const approvedAt = async (versionId: string) => (await admin.query(`SELECT approved_at FROM site_versions WHERE id = $1`, [versionId])).rows[0].approved_at;

  it('all three routes are session-only: a token is refused with session_required, even one holding every scope', async () => {
    const v = await newVersion(owner, { legal: true });
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: owner.accountId, createdBy: owner.userId, tokenHash: hashToken(plaintext), displayHint: displayHint(plaintext),
      scopes: ['read', 'work_items:write', 'discussions:write'] as never, expiresAt: new Date(Date.now() + 86_400_000),
    });
    for (const [method, path, body] of [
      ['GET', `/site-versions/${v.versionId}/review`, undefined],
      ['POST', `/site-versions/${v.versionId}/attest`, { claim_id: v.ids.terms }],
      ['POST', `/site-versions/${v.versionId}/approve`, { terms_accepted: true, approved_links: [README] }],
    ] as const) {
      const res = await call(plaintext, method, path, body);
      expect([res.status, (await json(res)).error.code]).toEqual([403, 'session_required']);
    }
    expect(await approvedAt(v.versionId)).toBeNull();
    expect(await auditRows(owner.accountId, 'site.claim_attested')).toHaveLength(0);
  });

  it('a member may read the review but cannot attest or approve; owner and admin can', async () => {
    const v = await newVersion(owner, { legal: true });
    const review = await json(await call(member, 'GET', `/site-versions/${v.versionId}/review`));
    expect(review).toMatchObject({ version_id: v.versionId, site_id: v.siteId, approved: false, claims: [{ claim_id: v.ids.terms, kind: 'legal', text: 'Fast builds', attested: false }] });
    expect(review.report.ok).toBe(false);
    for (const [path, body] of [['attest', { claim_id: v.ids.terms }], ['approve', { terms_accepted: true, approved_links: [README] }]] as const) {
      const res = await call(member, 'POST', `/site-versions/${v.versionId}/${path}`, body);
      expect([res.status, (await json(res)).error.code]).toEqual([403, 'insufficient_role']);
    }
    expect((await call(adminU, 'POST', `/site-versions/${v.versionId}/attest`, { claim_id: v.ids.terms })).status).toBe(200);
    expect(await approvedAt(v.versionId)).toBeNull();
  });

  it('attest writes one audit row saying it was direct; carry_forward writes one saying it was carried; a repeat writes none', async () => {
    const v1 = await newVersion(owner, { legal: true, createdAt: '2026-01-01' });
    const before = (await auditRows(owner.accountId, 'site.claim_attested')).length;
    const a = await json(await call(owner, 'POST', `/site-versions/${v1.versionId}/attest`, { claim_id: v1.ids.terms }));
    expect(a).toEqual({ created: true, carried: [] });
    expect((await json(await call(owner, 'POST', `/site-versions/${v1.versionId}/attest`, { claim_id: v1.ids.terms }))).created).toBe(false);
    const v2 = await newVersion(owner, { legal: true, siteId: v1.siteId, createdAt: '2026-02-01' });
    const c = await json(await call(adminU, 'POST', `/site-versions/${v2.versionId}/attest`, { carry_forward: true }));
    expect(c).toEqual({ created: false, carried: [v1.ids.terms] });
    const rows = (await auditRows(owner.accountId, 'site.claim_attested')).slice(before);
    expect(rows.map((r) => [r.actor, r.payload.carried])).toEqual([[owner.userId, false], [adminU.userId, true]]);
    expect(rows[1]!.payload).toMatchObject({ version_id: v2.versionId, claim_ids: [v1.ids.terms] });
  });

  beforeEach(() => {
    stubs.passStatic = true;
    stubs.passBrowser = true;
    stubs.failMeta = false;
  });
  const checksOf = async (versionId: string) => (await admin.query(`SELECT report->'approvalChecks' AS c FROM site_versions WHERE id = $1`, [versionId])).rows[0].c;
  const failedOf = async (versionId: string): Promise<{ check: string; findings: { kind: string }[] }[]> => (await checksOf(versionId)).checks.filter((c: { ok: boolean }) => !c.ok);
  const BROWSER = ['check-render', 'check-a11y-structure', 'check-motion', 'check-degrade'];
  const approveVia = (id: string) => call(owner, 'POST', `/site-versions/${id}/approve`, { terms_accepted: true, approved_links: [README] });

  it('approve with no browser driver: each of the four browser checks fails with browser_driver_missing, the version is refused (409) and the result is stored', async () => {
    stubs.passBrowser = false;
    const v = await newVersion(owner);
    const res = await approveVia(v.versionId);
    const body = await json(res);
    expect([res.status, body.error.code, body.error.message]).toEqual([409, 'browser_driver_missing', 'the browser checks cannot run on the server yet']);
    expect(await approvedAt(v.versionId)).toBeNull();
    const failed = await failedOf(v.versionId);
    expect(failed.map((c) => c.check)).toEqual(BROWSER);
    for (const c of failed) expect(c.findings.map((f) => f.kind)).toEqual(['browser_driver_missing']);
    expect((await admin.query(`SELECT report->'publishGates'->>'ok' AS g FROM site_versions WHERE id = $1`, [v.versionId])).rows[0].g).toBe('true');
    expect((await auditRows(owner.accountId, 'site.version_approved')).filter((r) => r.payload.version_id === v.versionId)).toHaveLength(0);
  });

  it('a stored report that says pass does not help: the checks are re-run on the render, and the real ones refuse', async () => {
    stubs.passStatic = false;
    stubs.passBrowser = false;
    const v = await newVersion(owner);
    await admin.query(`UPDATE site_versions SET report = '{"publishGates":{"version":1,"ok":true,"leak":{"ok":true,"findings":[]},"links":{"ok":true,"findings":[]},"pendingLinks":[]},"approvalChecks":{"version":1,"ok":true,"checks":[]}}'::jsonb WHERE id = $1`, [v.versionId]);
    const res = await approveVia(v.versionId);
    expect([res.status, (await json(res)).error.code]).toEqual([409, 'check_failed']);
    expect((await checksOf(v.versionId)).ok).toBe(false);
    expect((await failedOf(v.versionId)).map((c) => c.check)).toEqual(expect.arrayContaining(['check-nojs', ...BROWSER]));
  });

  it('a failing site check is 409 check_failed with a fixed message: the findings are stored, never echoed', async () => {
    stubs.failMeta = true;
    const v = await newVersion(owner);
    const res = await approveVia(v.versionId);
    const body = await json(res);
    expect([res.status, body.error.code, body.error.message]).toEqual([409, 'check_failed', 'the site failed one or more approval checks']);
    expect(JSON.stringify(body)).not.toContain('ATTACKER');
    expect(await failedOf(v.versionId)).toMatchObject([{ check: 'check-meta', findings: [{ kind: 'bad_title' }] }]);
  });

  it('a supplied driver whose checks pass lets approval through: the refusal comes from the missing driver, not the wiring', async () => {
    stubs.passBrowser = false;
    const v = await newVersion(owner);
    const out = await withTenant(appUserPool, owner.accountId, owner.userId, (c) =>
      approve(c, owner, v.versionId, { termsAccepted: true, approvedLinks: [README], browserDriver: stubs.driver }),
    );
    expect(out.ok).toBe(true);
    expect(await approvedAt(v.versionId)).not.toBeNull();
    expect((await checksOf(v.versionId)).ok).toBe(true);
    // Only the driver differs: the same call without one is refused.
    const w = await newVersion(owner);
    const refused = await withTenant(appUserPool, owner.accountId, owner.userId, (c) => approve(c, owner, w.versionId, { termsAccepted: true, approvedLinks: [README] }));
    expect(refused).toMatchObject({ ok: false, refusal: { code: 'check_failed', checks: BROWSER.map((check) => ({ check })) } });
  });

  it('approve: exactly the listed links are approved and audited; the version cannot be approved twice (409, no second audit row)', async () => {
    const v = await newVersion(owner);
    const res = await call(owner, 'POST', `/site-versions/${v.versionId}/approve`, { terms_accepted: true, approved_links: [README] });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ approved_links: [README] });
    expect(await approvedAt(v.versionId)).not.toBeNull();
    const rows = (await auditRows(owner.accountId, 'site.version_approved')).filter((r) => r.payload.version_id === v.versionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: owner.userId, payload: { approved_links: [README], terms_accepted: true } });
    const again = await call(adminU, 'POST', `/site-versions/${v.versionId}/approve`, { terms_accepted: true, approved_links: [README] });
    expect([again.status, (await json(again)).error.code]).toEqual([409, 'already_approved']);
    expect((await auditRows(owner.accountId, 'site.version_approved')).filter((r) => r.payload.version_id === v.versionId)).toHaveLength(1);
  });

  it('approvedLinks are never filled in from the pending links: none listed means unapproved_link, though the review shows the link', async () => {
    const v = await newVersion(owner);
    for (const body of [{ terms_accepted: true }, { terms_accepted: true, approved_links: [] }]) {
      const res = await call(owner, 'POST', `/site-versions/${v.versionId}/approve`, body);
      expect([res.status, (await json(res)).error.code]).toEqual([409, 'unapproved_link']);
    }
    expect((await json(await call(owner, 'GET', `/site-versions/${v.versionId}/review`))).pending_links).toContain(README);
    expect(await approvedAt(v.versionId)).toBeNull();
    expect((await auditRows(owner.accountId, 'site.version_approved')).filter((r) => r.payload.version_id === v.versionId)).toHaveLength(0);
  });

  it('the other typed refusals are 409 with a fixed code and message; the report ok flag does not decide', async () => {
    const legal = await newVersion(owner, { legal: true });
    const links = [README];
    const terms = await call(owner, 'POST', `/site-versions/${legal.versionId}/approve`, { terms_accepted: false, approved_links: links });
    expect([terms.status, (await json(terms)).error.code]).toEqual([409, 'terms_not_accepted']);
    const un = await call(owner, 'POST', `/site-versions/${legal.versionId}/approve`, { terms_accepted: true, approved_links: links });
    expect([un.status, (await json(un)).error.code]).toEqual([409, 'unattested_claim']);
    // A forged stored report makes the advisory ok flag true; approve() still refuses.
    await admin.query(`UPDATE site_versions SET report = '{"publishGates":{"version":1,"ok":true,"leak":{"ok":true,"findings":[]},"links":{"ok":true,"findings":[]},"pendingLinks":[]}}'::jsonb WHERE id = $1`, [legal.versionId]);
    expect((await json(await call(owner, 'GET', `/site-versions/${legal.versionId}/review`))).report.ok).toBe(true);
    expect((await call(owner, 'POST', `/site-versions/${legal.versionId}/approve`, { terms_accepted: true, approved_links: links })).status).toBe(409);
  });

  it('a request with no credentials is a 401 on all three routes', async () => {
    const v = await newVersion(owner, { legal: true });
    for (const [method, path, body] of [
      ['GET', `/site-versions/${v.versionId}/review`, undefined],
      ['POST', `/site-versions/${v.versionId}/attest`, { claim_id: v.ids.terms }],
      ['POST', `/site-versions/${v.versionId}/approve`, { terms_accepted: true, approved_links: [README] }],
    ] as const) {
      const init = { method, headers: new Headers(body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined };
      const res = await handleApiRequest(new Request(`http://localhost/api/v1${path}`, init), appUserPool, platformOpsPool, ROUTES);
      expect(res.status).toBe(401);
    }
    expect(await approvedAt(v.versionId)).toBeNull();
  });

  it('attest refuses a claim of another site (claim_not_in_site) and a feature claim (not_attestable) with 409 and writes nothing', async () => {
    const v = await newVersion(owner, { legal: true });
    const elsewhere = await newVersion(owner, { legal: true });
    const before = (await auditRows(owner.accountId, 'site.claim_attested')).length;
    const foreign = await call(owner, 'POST', `/site-versions/${v.versionId}/attest`, { claim_id: elsewhere.ids.terms });
    expect([foreign.status, (await json(foreign)).error.code]).toEqual([409, 'claim_not_in_site']);
    const feature = await call(owner, 'POST', `/site-versions/${v.versionId}/attest`, { claim_id: v.ids.feat });
    expect([feature.status, (await json(feature)).error.code]).toEqual([409, 'not_attestable']);
    expect((await auditRows(owner.accountId, 'site.claim_attested')).length).toBe(before);
  });

  it('approve: a body whose links exceed the size cap is a 422 before any write; the largest allowed body still succeeds', async () => {
    const pad = (i: number) => `https://p.example/${String(i).padStart(4, '0')}/`.padEnd(2048, 'x');
    const links = (n: number) => Array.from({ length: n }, (_, i) => pad(i));
    // 24 x 2048 = 49152 bytes, exactly the cap; 25 links is over it (and still under the 256 KiB body limit).
    const over = await newVersion(owner);
    const rowsBefore = (await auditRows(owner.accountId, 'site.version_approved')).length;
    const res = await call(owner, 'POST', `/site-versions/${over.versionId}/approve`, { terms_accepted: true, approved_links: [README, ...links(24)] });
    expect([res.status, (await json(res)).error.code]).toEqual([422, 'validation_failed']);
    expect(await approvedAt(over.versionId)).toBeNull();
    expect((await auditRows(owner.accountId, 'site.version_approved')).length).toBe(rowsBefore);

    const ok = await newVersion(owner);
    const max = [README, ...links(23), pad(23).slice(0, 2048 - README.length)];
    const good = await call(owner, 'POST', `/site-versions/${ok.versionId}/approve`, { terms_accepted: true, approved_links: max });
    expect(good.status).toBe(200);
    expect(await approvedAt(ok.versionId)).not.toBeNull();
    expect((await auditRows(owner.accountId, 'site.version_approved')).length).toBe(rowsBefore + 1);
  });

  it('render_failed returns a fixed code and message and never the raw error text', async () => {
    const v = await newVersion(owner, { hero: { backgroundImage: '/images/secret-bg-name.png' } });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await call(owner, 'POST', `/site-versions/${v.versionId}/approve`, { terms_accepted: true, approved_links: [README] });
    const body = await json(res);
    expect([res.status, body.error.code, body.error.message]).toEqual([409, 'render_failed', 'the site could not be rendered']);
    expect(JSON.stringify(body)).not.toContain('secret-bg-name');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('secret-bg-name'));
    log.mockRestore();
  });

  it("another account's version is a 404; malformed input is a 422; assetRoot and unknown keys cannot be sent", async () => {
    const v = await newVersion(other);
    expect((await call(owner, 'GET', `/site-versions/${v.versionId}/review`)).status).toBe(404);
    expect((await call(owner, 'POST', `/site-versions/${v.versionId}/approve`, { terms_accepted: true, approved_links: [README] })).status).toBe(404);
    const mine = await newVersion(owner);
    const p = `/site-versions/${mine.versionId}`;
    for (const [path, body] of [
      ['approve', { terms_accepted: true, asset_root: '/etc' }], ['approve', { terms_accepted: 'yes' }], ['attest', {}],
      ['attest', { claim_id: randomUUID(), carry_forward: true }], ['attest', { claim_id: 'nope' }],
    ] as const) {
      expect((await call(owner, 'POST', `${p}/${path}`, body)).status).toBe(422);
    }
    expect((await call(owner, 'GET', '/site-versions/not-a-uuid/review')).status).toBe(422);
  });

  describe('GET /sites/{id}/versions (the Site review picker)', () => {
    const versionsOf = async (who: Identity | string, siteId: string, query = '') => call(who, 'GET', `/sites/${siteId}/versions${query}`);

    it("never lists another account's versions: their site id is the same 404 a random id gets, and a member of the other account sees only its own", async () => {
      const theirs = await newVersion(other);
      const mine = await newVersion(owner);
      const foreign = await versionsOf(owner, theirs.siteId);
      const missing = await versionsOf(owner, randomUUID());
      expect([foreign.status, missing.status]).toEqual([404, 404]);
      const foreignBody = await json(foreign);
      const missingBody = await json(missing);
      expect(foreignBody.error.code).toBe('not_found');
      expect(foreignBody.error.message).toBe(missingBody.error.message);
      expect(JSON.stringify(foreignBody)).not.toContain(theirs.versionId);
      const own = await json(await versionsOf(other, theirs.siteId));
      expect(own.data.map((v: { version_id: string }) => v.version_id)).toEqual([theirs.versionId]);
      expect((await versionsOf(other, mine.siteId)).status).toBe(404);
    });

    it("confines itself to the caller's account even with row security out of the picture (the explicit account predicate, not only the policy)", async () => {
      // Row security is the first layer and would hide these rows from app_user. The handler also names the account in
      // its own SQL; run it on a connection that bypasses row security to prove that second layer works by itself.
      const role = await admin.query(`SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`);
      expect(role.rows[0].bypass).toBe(true);
      const theirs = await newVersion(other);
      const mine = await newVersion(owner);
      const entry = ROUTES.find((r) => r.operationId === 'listSiteVersions')!;
      const as = (who: Identity, siteId: string) =>
        entry.handler({ pool: adminPool, principal: { accountId: who.accountId, userId: who.userId } } as never, { params: { id: siteId }, query: {} } as never);
      await expect(as(owner, theirs.siteId)).rejects.toMatchObject({ name: 'NotFoundError' });
      await expect(as(other, mine.siteId)).rejects.toMatchObject({ name: 'NotFoundError' });
      const own = (await as(owner, mine.siteId)) as { data: { version_id: string }[] };
      expect(own.data.map((v) => v.version_id)).toEqual([mine.versionId]);
    });

    it('a member can read it; a token is refused with session_required; no credentials is 401', async () => {
      const v = await newVersion(owner);
      const res = await versionsOf(member, v.siteId);
      expect(res.status).toBe(200);
      expect((await json(res)).data.map((r: { version_id: string }) => r.version_id)).toEqual([v.versionId]);
      const plaintext = generateToken();
      await insertApiToken(appUserPool, {
        accountId: owner.accountId, createdBy: owner.userId, tokenHash: hashToken(plaintext), displayHint: displayHint(plaintext),
        scopes: ['read'] as never, expiresAt: new Date(Date.now() + 86_400_000),
      });
      const viaToken = await versionsOf(plaintext, v.siteId);
      expect([viaToken.status, (await json(viaToken)).error.code]).toEqual([403, 'session_required']);
      const anon = await handleApiRequest(new Request(`http://localhost/api/v1/sites/${v.siteId}/versions`), appUserPool, platformOpsPool, ROUTES);
      expect(anon.status).toBe(401);
      expect((await call(owner, 'GET', '/sites/not-a-uuid/versions')).status).toBe(422);
      const entry = ROUTES.find((r) => r.operationId === 'listSiteVersions');
      expect([entry?.rateClass, entry?.minRole, entry?.principals]).toEqual(['read', 'member', ['session']]);
    });

    it('lists newest first with the state derived from the approval columns and the counts of what is still pending', async () => {
      const v1 = await newVersion(owner, { legal: true, createdAt: '2026-03-01T00:00:00Z' });
      const v2 = await newVersion(owner, { legal: true, siteId: v1.siteId, createdAt: '2026-03-02T00:00:00Z' });
      const v3 = await newVersion(owner, { legal: true, siteId: v1.siteId, createdAt: '2026-03-03T00:00:00Z' });
      await admin.query(`UPDATE site_versions SET report = '{"publishGates":{"pendingLinks":["https://a.example/","https://b.example/"]}}'::jsonb WHERE id = $1`, [v3.versionId]);
      await admin.query(`UPDATE site_versions SET approved_by = $2, approved_at = now() WHERE id = $1`, [v2.versionId, owner.userId]);
      await admin.query(`UPDATE site_versions SET approved_by = $2, approved_at = now(), published_at = now() WHERE id = $1`, [v1.versionId, owner.userId]);
      await admin.query(`INSERT INTO attestations (account_id, claim_id, version_id, user_id) VALUES ($1,$2,$3,$4)`, [owner.accountId, v1.ids.terms, v1.versionId, owner.userId]);
      const body = await json(await versionsOf(owner, v1.siteId));
      expect(body.next_cursor).toBeNull();
      expect(body.data).toEqual([
        { version_id: v3.versionId, created_at: '2026-03-03T00:00:00.000Z', review_state: 'pending', pending_links: 2, pending_claims: 1 },
        { version_id: v2.versionId, created_at: '2026-03-02T00:00:00.000Z', review_state: 'approved', pending_links: 0, pending_claims: 1 },
        { version_id: v1.versionId, created_at: '2026-03-01T00:00:00.000Z', review_state: 'published', pending_links: 0, pending_claims: 0 },
      ]);
    });

    it('a site with no versions is an empty page, not an error; a malformed report or content never breaks the read', async () => {
      const repoId = randomUUID();
      const siteId = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1, $2, $3, 'team')`, [repoId, owner.accountId, ++seq]);
      await admin.query(`INSERT INTO sites (id, account_id, repo_id) VALUES ($1,$2,$3)`, [siteId, owner.accountId, repoId]);
      expect(await json(await versionsOf(owner, siteId))).toEqual({ data: [], next_cursor: null });
      const odd = await newVersion(owner, { siteId, createdAt: '2026-04-01T00:00:00Z' });
      await admin.query(`UPDATE site_versions SET report = '{"publishGates":{"pendingLinks":"nope"}}'::jsonb WHERE id = $1`, [odd.versionId]);
      expect((await json(await versionsOf(owner, siteId))).data[0]).toMatchObject({ version_id: odd.versionId, pending_links: 0 });
    });

    it('pages by keyset: no row repeated or skipped, a cap of 200, and a forged cursor is a 422', async () => {
      const first = await newVersion(owner, { createdAt: '2026-05-01T00:00:00Z' });
      const ids = [first.versionId];
      for (const day of ['02', '03', '04']) ids.unshift((await newVersion(owner, { siteId: first.siteId, createdAt: `2026-05-${day}T00:00:00Z` })).versionId);
      const p1 = await json(await versionsOf(owner, first.siteId, '?limit=3'));
      expect(p1.data.map((v: { version_id: string }) => v.version_id)).toEqual(ids.slice(0, 3));
      expect(typeof p1.next_cursor).toBe('string');
      const p2 = await json(await versionsOf(owner, first.siteId, `?limit=3&cursor=${p1.next_cursor}`));
      expect(p2.data.map((v: { version_id: string }) => v.version_id)).toEqual(ids.slice(3));
      expect(p2.next_cursor).toBeNull();
      for (const bad of ['?limit=201', '?limit=0', '?limit=abc', '?cursor=forged']) {
        const res = await versionsOf(owner, first.siteId, bad);
        expect(res.status).toBe(422);
      }
      const exact = await json(await versionsOf(owner, first.siteId, '?limit=200'));
      expect(exact.data).toHaveLength(4);
    });
  });
});
