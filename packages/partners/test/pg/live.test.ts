import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { PG_ERROR } from '@fx/db/test/helpers/pgErrors.js';
import { brandingBodyFor, resolvePartnerContext, STATIC_BRAND, type PartnerBrandingEnvelope } from '../../src/context/index.js';
import {
  CachedHostResolver,
  PgHostResolver,
  RESOLVE_HOST_COLUMNS,
  UNKNOWN_HOST,
} from '../../src/host/index.js';
import { assignPartnerOnSignup } from '../../src/signup/index.js';

/**
 * The partner host resolver and the signup hook against the real database functions (migration 0803), through the same roles
 * the web tier uses: app_user for the lookup, platform_ops for account creation. The pure logic is tested without a database in
 * the other files here; this file is what proves the two halves agree about names, columns and refusals.
 */
describe('host resolver and signup hook against Postgres', () => {
  let platformOpsPool: Pool;
  let appUserPool: Pool;
  const sfx = randomUUID().slice(0, 8);
  const ENV_ON = { FX_PARTNER_LAYER: 'on', FX_APP_ORIGIN: 'https://cloud.fulcrumaxe.example' };

  beforeAll(() => {
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });

  afterAll(async () => {
    await platformOpsPool.end();
    await appUserPool.end();
  });

  async function seedPartner(label: string, status: 'active' | 'suspended' | 'pending' = 'active'): Promise<{ partnerId: string; hostname: string }> {
    const partnerId = randomUUID();
    const hostname = `${label}-${sfx}.example.test`;
    await platformOpsPool.query(`INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', $2, $3)`, [partnerId, status, label]);
    await platformOpsPool.query(
      `INSERT INTO partner_branding (partner_id, product_name, logo_object_key, color_primary, color_accent, support_email, terms_url, privacy_url, status)
       VALUES ($1, $2, 'k/logo.png', '#112233', '#445566', 'help@acme.example', 'https://acme.example/terms', 'https://acme.example/privacy', 'approved')`,
      [partnerId, `Acme ${label}`],
    );
    await platformOpsPool.query(
      `INSERT INTO partner_domains (partner_id, hostname, txt_verified_at, attached_at) VALUES ($1, $2, now(), now())`,
      [partnerId, hostname],
    );
    return { partnerId, hostname };
  }

  it('reads the columns resolve_host returns, by name and in order', async () => {
    const res = await appUserPool.query(`SELECT * FROM resolve_host('nobody.example.test')`);
    expect(res.fields.map((f) => f.name)).toEqual([...RESOLVE_HOST_COLUMNS]);
  });

  it('resolves an active partner host as app_user, whatever the case, port or trailing dot of the Host header', async () => {
    const { partnerId, hostname } = await seedPartner('live');
    const resolver = new PgHostResolver(appUserPool);
    for (const header of [hostname, hostname.toUpperCase(), `${hostname}:443`, `${hostname}.`, `${hostname.toUpperCase()}.:8443`]) {
      const ctx = await resolvePartnerContext({ hostHeader: header, env: ENV_ON, resolver });
      expect(ctx.kind, header).toBe('partner');
      const body = brandingBodyFor(ctx) as PartnerBrandingEnvelope;
      expect(body).toMatchObject({
        product_name: 'Acme live',
        state: 'active',
        logo_url: null,
        terms_url: 'https://acme.example/terms',
        colors: { accent: '#112233', accentFaint: '#445566' },
      });
      expect(ctx).toMatchObject({ partnerId, host: hostname });
    }
  });

  it('answers our static brand for an unknown host, and suspended for a suspended partner', async () => {
    const { hostname } = await seedPartner('susp', 'suspended');
    const resolver = new PgHostResolver(appUserPool);
    const unknown = await resolvePartnerContext({ hostHeader: `nobody-${sfx}.example.test`, env: ENV_ON, resolver });
    expect(brandingBodyFor(unknown)).toEqual(STATIC_BRAND);
    const suspended = await resolvePartnerContext({ hostHeader: hostname, env: ENV_ON, resolver });
    expect(suspended.kind).toBe('suspended');
    expect(brandingBodyFor(suspended)).toMatchObject({ state: 'suspended', product_name: STATIC_BRAND.product_name });
    expect(await resolver.resolve(`pending-${sfx}.example.test`)).toEqual(UNKNOWN_HOST);
  });

  it('sees an approval change within 60 seconds through the cache (fake clock) and at once without it', async () => {
    const { partnerId, hostname } = await seedPartner('cache');
    let now = 0;
    const cached = new CachedHostResolver(new PgHostResolver(appUserPool), { now: () => now });
    expect((await cached.resolve(hostname)).state).toBe('active');
    await platformOpsPool.query(`UPDATE partner_branding SET status = 'rejected' WHERE partner_id = $1`, [partnerId]);
    now += 59_000;
    expect((await cached.resolve(hostname)).state).toBe('active');
    now += 1_000;
    expect((await cached.resolve(hostname)).state).toBe('unknown');
    expect((await new PgHostResolver(appUserPool).resolve(hostname)).state).toBe('unknown');
  });

  describe('signup hook', () => {
    async function newAccount(): Promise<string> {
      const id = randomUUID();
      await platformOpsPool.query(`INSERT INTO accounts (id, plan) VALUES ($1, 'starter')`, [id]);
      return id;
    }
    async function partnerOf(accountId: string): Promise<string | null> {
      const { rows } = await platformOpsPool.query(`SELECT partner_id FROM accounts WHERE id = $1`, [accountId]);
      return rows[0].partner_id;
    }

    it('assigns the account inside the signup transaction when the signup carried a partner host and the layer is on', async () => {
      const { partnerId, hostname } = await seedPartner('signup');
      const accountId = await newAccount();
      const client = await platformOpsPool.connect();
      try {
        await client.query('BEGIN');
        await assignPartnerOnSignup({ accountId, signupHost: `${hostname.toUpperCase()}:443`, client }, ENV_ON);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      expect(await partnerOf(accountId)).toBe(partnerId);
    });

    it('fails the signup when the host is not an active partner host (the account is not left direct on a partner host)', async () => {
      const { hostname } = await seedPartner('pend', 'pending');
      const accountId = await newAccount();
      const client = await platformOpsPool.connect();
      try {
        await expect(assignPartnerOnSignup({ accountId, signupHost: hostname, client }, ENV_ON)).rejects.toMatchObject({
          code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        });
      } finally {
        client.release();
      }
      expect(await partnerOf(accountId)).toBeNull();
    });

  });
});
