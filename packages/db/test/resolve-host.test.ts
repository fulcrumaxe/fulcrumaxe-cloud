import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * Partner layer P02a (migration 0803): resolve_host and assign_partner_on_signup against a real Postgres, as the real roles.
 * resolve_host answers exactly one row for any input and derives its answer from the current rows on every call, so every
 * undo (a detach, a revoked approval, an unsuspend) is a plain UPDATE followed by another call.
 */
describe('resolve_host / assign_partner_on_signup (0803)', () => {
  let adminPool: Pool;
  let platformOpsPool: Pool;
  let appUserPool: Pool;
  let partnerUserPool: Pool;

  const sfx = randomUUID().slice(0, 8);
  const host = (label: string): string => `${label}-${sfx}.example.test`;

  const COLUMNS = [
    'partner_id',
    'product_name',
    'logo_url',
    'color_primary',
    'color_accent',
    'support_email',
    'terms_url',
    'privacy_url',
    'state',
  ];

  interface Seed {
    kind?: 'reseller' | 'affiliate';
    status?: 'pending' | 'active' | 'suspended';
    branding?: 'approved' | 'draft' | 'pending_review' | 'rejected' | 'none';
    productName?: string | null;
    termsUrl?: string | null;
    privacyUrl?: string | null;
    verified?: boolean;
    attached?: boolean;
    detached?: boolean;
  }

  /** One partner with one domain, in whatever state the case needs. Returns its id and hostname. */
  async function seedPartner(label: string, s: Seed = {}): Promise<{ partnerId: string; hostname: string }> {
    const partnerId = randomUUID();
    const hostname = host(label);
    await platformOpsPool.query(`INSERT INTO partners (id, kind, status, name) VALUES ($1, $2, $3, $4)`, [
      partnerId,
      s.kind ?? 'reseller',
      s.status ?? 'active',
      `P ${label}`,
    ]);
    if ((s.branding ?? 'approved') !== 'none') {
      await platformOpsPool.query(
        `INSERT INTO partner_branding (partner_id, product_name, logo_object_key, color_primary, color_accent, support_email, terms_url, privacy_url, status)
         VALUES ($1, $2, 'k/logo.png', '#112233', '#445566', 'help@acme.example', $3, $4, $5)`,
        [
          partnerId,
          s.productName === undefined ? `Acme ${label}` : s.productName,
          s.termsUrl === undefined ? 'https://acme.example/terms' : s.termsUrl,
          s.privacyUrl === undefined ? 'https://acme.example/privacy' : s.privacyUrl,
          s.branding ?? 'approved',
        ],
      );
    }
    await platformOpsPool.query(
      `INSERT INTO partner_domains (partner_id, hostname, txt_verified_at, attached_at, detached_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        partnerId,
        hostname,
        s.verified === false ? null : new Date(),
        s.attached === false ? null : new Date(),
        s.detached ? new Date() : null,
      ],
    );
    return { partnerId, hostname };
  }

  async function resolve(hostname: string | null, pool: Pool = appUserPool) {
    const res = await pool.query(`SELECT * FROM resolve_host($1)`, [hostname]);
    return res;
  }

  async function stateOf(hostname: string): Promise<string> {
    const res = await resolve(hostname);
    expect(res.rows).toHaveLength(1);
    return res.rows[0].state as string;
  }

  async function newAccount(): Promise<string> {
    const id = randomUUID();
    await platformOpsPool.query(`INSERT INTO accounts (id, plan) VALUES ($1, 'starter')`, [id]);
    return id;
  }

  beforeAll(() => {
    adminPool = createPool(process.env.DATABASE_URL!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    partnerUserPool = createPool(process.env.DATABASE_URL_PARTNER_USER!);
  });

  afterAll(async () => {
    await adminPool.end();
    await platformOpsPool.end();
    await appUserPool.end();
    await partnerUserPool.end();
  });

  describe('resolve_host', () => {
    it('returns exactly the nine documented columns, in order (schema pin)', async () => {
      const res = await resolve(host('nobody'));
      expect(res.fields.map((f) => f.name)).toEqual(COLUMNS);
    });

    it('is a SECURITY DEFINER function owned by partner_host_definer, not platform_ops, with a pinned search_path', async () => {
      const { rows } = await adminPool.query(
        `SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig
           FROM pg_proc p WHERE p.proname IN ('resolve_host', 'assign_partner_on_signup') ORDER BY p.proname`,
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.prosecdef).toBe(true);
        expect(row.owner).toBe('partner_host_definer');
        expect(row.proconfig).toContain('search_path=pg_catalog, public, pg_temp');
      }
    });

    it('the owning role is NOLOGIN, has no members and no privileged attribute', async () => {
      const role = await adminPool.query(
        `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = 'partner_host_definer'`,
      );
      expect(role.rows).toEqual([
        { rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false },
      ]);
      const members = await adminPool.query(`SELECT 1 FROM pg_auth_members WHERE roleid = 'partner_host_definer'::regrole`);
      expect(members.rows).toEqual([]);
    });

    it('the owning role holds exactly the column grants the two bodies need, and nothing on any other table', async () => {
      const { rows } = await adminPool.query<{ x: string }>(
        `SELECT c.relname || '.' || a.attname || ' ' || p.privilege_type AS x
           FROM pg_class c
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
           CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(privilege_type)
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
            AND has_column_privilege('partner_host_definer', c.oid, a.attnum, p.privilege_type)
          ORDER BY 1`,
      );
      expect(rows.map((r) => r.x)).toEqual([
        'accounts.created_at SELECT',
        'accounts.deleted_at SELECT',
        'accounts.id SELECT',
        'accounts.partner_id SELECT',
        'accounts.partner_id UPDATE',
        'accounts.referred_by_partner_id SELECT',
        'partner_audit_log.action INSERT',
        'partner_audit_log.actor INSERT',
        'partner_audit_log.partner_id INSERT',
        'partner_audit_log.payload INSERT',
        'partner_branding.color_accent SELECT',
        'partner_branding.color_primary SELECT',
        'partner_branding.logo_object_key SELECT',
        'partner_branding.partner_id SELECT',
        'partner_branding.privacy_url SELECT',
        'partner_branding.product_name SELECT',
        'partner_branding.status SELECT',
        'partner_branding.support_email SELECT',
        'partner_branding.terms_url SELECT',
        'partner_domains.attached_at SELECT',
        'partner_domains.detached_at SELECT',
        'partner_domains.hostname SELECT',
        'partner_domains.partner_id SELECT',
        'partner_domains.txt_verified_at SELECT',
        'partners.id SELECT',
        'partners.kind SELECT',
        'partners.status SELECT',
      ]);
    });

    it('platform_ops owns neither function and holds EXECUTE on assign_partner_on_signup alone', async () => {
      const { rows } = await adminPool.query<{ x: string }>(
        `SELECT p.oid::regprocedure::text AS x FROM pg_proc p
          WHERE p.proname IN ('resolve_host', 'assign_partner_on_signup') AND has_function_privilege('platform_ops', p.oid, 'EXECUTE')`,
      );
      expect(rows.map((r) => r.x)).toEqual(['assign_partner_on_signup(uuid,text)']);
    });

    it('returns approved branding for an active partner with a verified, attached domain', async () => {
      const { partnerId, hostname } = await seedPartner('active');
      const res = await resolve(hostname);
      expect(res.rows).toEqual([
        {
          partner_id: partnerId,
          product_name: 'Acme active',
          logo_url: 'k/logo.png',
          color_primary: '#112233',
          color_accent: '#445566',
          support_email: 'help@acme.example',
          terms_url: 'https://acme.example/terms',
          privacy_url: 'https://acme.example/privacy',
          state: 'active',
        },
      ]);
    });

    const UNKNOWN_ROW = {
      partner_id: null,
      product_name: null,
      logo_url: null,
      color_primary: null,
      color_accent: null,
      support_email: null,
      terms_url: null,
      privacy_url: null,
      state: 'unknown',
    };

    it.each<[string, Seed]>([
      ['an unverified domain', { verified: false }],
      ['a domain that is not attached', { attached: false }],
      ['a detached domain', { detached: true }],
      ['a pending partner', { status: 'pending' }],
      ['an affiliate that holds a domain', { kind: 'affiliate' }],
      ['draft branding', { branding: 'draft' }],
      ['branding in review', { branding: 'pending_review' }],
      ['rejected branding', { branding: 'rejected' }],
      ['no branding row at all', { branding: 'none' }],
      ['a missing terms_url', { termsUrl: null }],
      ['a blank terms_url', { termsUrl: '   ' }],
      ['a missing privacy_url', { privacyUrl: null }],
      ['a blank privacy_url', { privacyUrl: '' }],
      ['a missing product name', { productName: null }],
    ])('answers the unknown row for %s', async (name, seed) => {
      const { hostname } = await seedPartner(`u${Math.abs([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7))}`, seed);
      const res = await resolve(hostname);
      expect(res.rows).toEqual([UNKNOWN_ROW]);
    });

    it('answers the unknown row for a host nobody owns, for NULL, and for a name that is not in canonical form', async () => {
      const { hostname } = await seedPartner('canon');
      expect((await resolve(host('nobody'))).rows).toEqual([UNKNOWN_ROW]);
      expect((await resolve(null)).rows).toEqual([UNKNOWN_ROW]);
      expect((await resolve(hostname.toUpperCase())).rows).toEqual([UNKNOWN_ROW]);
      expect((await resolve(`${hostname}.`)).rows).toEqual([UNKNOWN_ROW]);
      expect((await resolve(`${hostname}:443`)).rows).toEqual([UNKNOWN_ROW]);
      expect((await resolve(` ${hostname}`)).rows).toEqual([UNKNOWN_ROW]);
    });

    it('answers a suspended partner as suspended with only its id, none of its text or colours', async () => {
      const { partnerId, hostname } = await seedPartner('susp', { status: 'suspended' });
      expect((await resolve(hostname)).rows).toEqual([{ ...UNKNOWN_ROW, partner_id: partnerId, state: 'suspended' }]);
    });

    it('derives state from the current rows: every undo is visible on the next call', async () => {
      const { partnerId, hostname } = await seedPartner('undo');
      expect(await stateOf(hostname)).toBe('active');

      // branding revoked by mistake-correction, then re-approved
      await platformOpsPool.query(`UPDATE partner_branding SET status = 'rejected' WHERE partner_id = $1`, [partnerId]);
      expect(await stateOf(hostname)).toBe('unknown');
      await platformOpsPool.query(`UPDATE partner_branding SET status = 'approved' WHERE partner_id = $1`, [partnerId]);
      expect(await stateOf(hostname)).toBe('active');

      // domain detached, then cleared
      await platformOpsPool.query(`UPDATE partner_domains SET detached_at = now() WHERE partner_id = $1`, [partnerId]);
      expect(await stateOf(hostname)).toBe('unknown');
      await platformOpsPool.query(`UPDATE partner_domains SET detached_at = NULL WHERE partner_id = $1`, [partnerId]);
      expect(await stateOf(hostname)).toBe('active');

      // partner suspended, then unsuspended
      await platformOpsPool.query(`UPDATE partners SET status = 'suspended' WHERE id = $1`, [partnerId]);
      expect(await stateOf(hostname)).toBe('suspended');
      await platformOpsPool.query(`UPDATE partners SET status = 'active' WHERE id = $1`, [partnerId]);
      expect(await stateOf(hostname)).toBe('active');

      // terms link removed
      await platformOpsPool.query(`UPDATE partner_branding SET terms_url = NULL WHERE partner_id = $1`, [partnerId]);
      expect(await stateOf(hostname)).toBe('unknown');
    });

    it('is executable by app_user and refused to partner_user (and to PUBLIC)', async () => {
      await expect(resolve(host('x'), appUserPool)).resolves.toBeTruthy();
      await expect(resolve(host('x'), partnerUserPool)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const { rows } = await adminPool.query(
        `SELECT has_function_privilege('app_user', 'resolve_host(text)', 'EXECUTE') AS app_user,
                has_function_privilege('partner_user', 'resolve_host(text)', 'EXECUTE') AS partner_user,
                has_function_privilege('public', 'resolve_host(text)', 'EXECUTE') AS public`,
      );
      expect(rows[0]).toEqual({ app_user: true, partner_user: false, public: false });
    });
  });

  describe('assign_partner_on_signup', () => {
    const assign = (pool: Pool, accountId: string | null, hostname: string | null) =>
      pool.query(`SELECT assign_partner_on_signup($1, $2) AS partner_id`, [accountId, hostname]);

    async function partnerOf(accountId: string): Promise<string | null> {
      const { rows } = await platformOpsPool.query(`SELECT partner_id FROM accounts WHERE id = $1`, [accountId]);
      return rows[0].partner_id;
    }

    it('assigns a brand-new account to the partner of an active host, and writes one audit row', async () => {
      const { partnerId, hostname } = await seedPartner('assign');
      const accountId = await newAccount();
      const res = await assign(platformOpsPool, accountId, hostname);
      expect(res.rows[0].partner_id).toBe(partnerId);
      expect(await partnerOf(accountId)).toBe(partnerId);
      const audit = await platformOpsPool.query(
        `SELECT actor, action, payload FROM partner_audit_log WHERE partner_id = $1 AND action = 'account_assigned'`,
        [partnerId],
      );
      expect(audit.rows).toEqual([{ actor: 'signup', action: 'account_assigned', payload: { account_id: accountId } }]);
    });

    it('rolls back with the signup transaction (nothing is left assigned)', async () => {
      const { hostname } = await seedPartner('rollback');
      const accountId = await newAccount();
      const client = await platformOpsPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT assign_partner_on_signup($1, $2)`, [accountId, hostname]);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      expect(await partnerOf(accountId)).toBeNull();
    });

    it('refuses an account that already has a partner', async () => {
      const first = await seedPartner('has1');
      const second = await seedPartner('has2');
      const accountId = await newAccount();
      await assign(platformOpsPool, accountId, first.hostname);
      await expect(assign(platformOpsPool, accountId, second.hostname)).rejects.toMatchObject({
        code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        message: expect.stringMatching(/already has a partner or a referrer/),
      });
      expect(await partnerOf(accountId)).toBe(first.partnerId);
    });

    it('refuses an account that already has a referrer', async () => {
      const { hostname } = await seedPartner('refd');
      const affiliate = randomUUID();
      await platformOpsPool.query(`INSERT INTO partners (id, kind, status, name) VALUES ($1, 'affiliate', 'active', 'Aff')`, [affiliate]);
      const accountId = await newAccount();
      await platformOpsPool.query(`UPDATE accounts SET referred_by_partner_id = $1 WHERE id = $2`, [affiliate, accountId]);
      await expect(assign(platformOpsPool, accountId, hostname)).rejects.toMatchObject({
        code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        message: expect.stringMatching(/already has a partner or a referrer/),
      });
      expect(await partnerOf(accountId)).toBeNull();
    });

    it('refuses an account older than 10 minutes, and accepts one just inside the limit', async () => {
      const { hostname } = await seedPartner('age');
      const old = await newAccount();
      await adminPool.query(`UPDATE accounts SET created_at = now() - interval '10 minutes 5 seconds' WHERE id = $1`, [old]);
      await expect(assign(platformOpsPool, old, hostname)).rejects.toMatchObject({
        code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        message: expect.stringMatching(/older than 10 minutes/),
      });
      expect(await partnerOf(old)).toBeNull();

      const fresh = await newAccount();
      await adminPool.query(`UPDATE accounts SET created_at = now() - interval '9 minutes 50 seconds' WHERE id = $1`, [fresh]);
      await expect(assign(platformOpsPool, fresh, hostname)).resolves.toBeTruthy();
    });

    it.each<[string, Seed]>([
      ['an unverified host', { verified: false }],
      ['a detached host', { detached: true }],
      ['a pending partner', { status: 'pending' }],
      ['a suspended partner', { status: 'suspended' }],
      ['unapproved branding', { branding: 'pending_review' }],
    ])('refuses %s, and leaves the account direct', async (name, seed) => {
      const { hostname } = await seedPartner(`r${Math.abs([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 3))}`, seed);
      const accountId = await newAccount();
      await expect(assign(platformOpsPool, accountId, hostname)).rejects.toMatchObject({
        code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        message: expect.stringMatching(/not an active partner host/),
      });
      expect(await partnerOf(accountId)).toBeNull();
    });

    it('refuses a host nobody owns and a hostname that is not canonical', async () => {
      const { hostname } = await seedPartner('canon2');
      const accountId = await newAccount();
      await expect(assign(platformOpsPool, accountId, host('nobody'))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(assign(platformOpsPool, accountId, hostname.toUpperCase())).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('answers P0002 for a missing account and 22023 for a missing argument', async () => {
      const { hostname } = await seedPartner('args');
      await expect(assign(platformOpsPool, randomUUID(), hostname)).rejects.toMatchObject({ code: 'P0002' });
      await expect(assign(platformOpsPool, null, hostname)).rejects.toMatchObject({ code: '22023' });
      await expect(assign(platformOpsPool, randomUUID(), null)).rejects.toMatchObject({ code: '22023' });
    });

    it('is refused to app_user and partner_user: a customer session cannot assign itself to a partner', async () => {
      const { hostname } = await seedPartner('deny');
      const accountId = await newAccount();
      await expect(assign(appUserPool, accountId, hostname)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(assign(partnerUserPool, accountId, hostname)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const { rows } = await adminPool.query(
        `SELECT has_function_privilege('app_user', 'assign_partner_on_signup(uuid, text)', 'EXECUTE') AS app_user,
                has_function_privilege('partner_user', 'assign_partner_on_signup(uuid, text)', 'EXECUTE') AS partner_user,
                has_function_privilege('public', 'assign_partner_on_signup(uuid, text)', 'EXECUTE') AS public,
                has_function_privilege('platform_ops', 'assign_partner_on_signup(uuid, text)', 'EXECUTE') AS platform_ops`,
      );
      expect(rows[0]).toEqual({ app_user: false, partner_user: false, public: false, platform_ops: true });
      expect(await partnerOf(accountId)).toBeNull();
    });
  });
});
