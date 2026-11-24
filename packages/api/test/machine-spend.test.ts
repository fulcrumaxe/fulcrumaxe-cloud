import { createHash, randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { computeModelUsd } from '@fx/spend';
import { resetPlanDataCache } from '@fx/plan-data';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { nextGhInstallationId } from '@fx/db/test/helpers/seed.js';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { machineSpendResponseSchema } from '../src/routes/billing.js';
import { readMachineSpend, SERVER_ESTIMATE_NOTE, SERVER_PRICE_NOTE } from '../src/machines/spend.js';
import { generateToken, displayHint } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { seedAccountWithMember } from './helpers/seed.js';

const PATH = '/api/v1/billing/machines';
/** The route reads the real clock: a server made at the start of the current UTC month whose hourly prices are far above the monthly ones, so both are capped whatever the date. */
const CAPPED_BOX = { name: 'box', created: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString(), hourly: '9.000000', monthly: '5.0000', ipv4: '0.5000', ipv4Hourly: '9.000000' };
/** The clock of every case: 19.5 days into November 2026 (468 hours). */
const NOW = new Date('2026-11-20T12:00:00Z');

interface Identity { accountId: string; userId: string }
type Spend = Awaited<ReturnType<typeof readMachineSpend>>;

describe('D#845 MC-11b: machine spend (servers and Claude usage), real Postgres', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  const asTenant = (who: Identity, now = NOW, rows = true): Promise<Spend> => withTenant(appUserPool, who.accountId, who.userId, (c) => readMachineSpend(c, who.accountId, { includeServerRows: rows }, now));
  const sha = (): string => createHash('sha256').update(randomUUID()).digest('hex');

  async function credential(who: Identity): Promise<string> {
    return (await admin.query(`INSERT INTO machine_provider_credentials (account_id, provider, kek_version, token_hint, created_by, removed_at, removed_by) VALUES ($1, 'hetzner_cloud', 1, 'a1b2', $2, now(), $2) RETURNING id`, [who.accountId, who.userId])).rows[0].id as string;
  }
  interface Srv { name: string; created: string; deleted?: string; providerId?: string | null; priced?: boolean; hourly?: string; monthly?: string; ipv4?: string; ipv4Hourly?: string | null; currency?: string }
  async function server(who: Identity, cred: string, s: Srv): Promise<string> {
    const tok = (await admin.query(`INSERT INTO runner_provisioning_tokens (account_id, created_by, token_sha256, credential_mode, expires_at) VALUES ($1, $2, $3, 'subscription', now() + interval '1 hour') RETURNING id`, [who.accountId, who.userId, sha()])).rows[0].id as string;
    const priced = s.priced !== false;
    return (await admin.query(
      `INSERT INTO managed_servers (account_id, kind, credential_id, name, provisioning_token_id, created_by, provider_server_id, status, created_at, deleted_at, deleted_by, server_type, location,
                                    price_hourly_gross, price_monthly_gross, ipv4_monthly_gross, currency, ipv4_hourly_gross)
       VALUES ($1, 'hetzner_cloud', $2, $3, $4, $5, $6, $7, $8, $9, $10, 'cpx31', 'fsn1', $11, $12, $13, $14, $15) RETURNING id`,
      [who.accountId, cred, s.name, tok, who.userId, s.providerId === null ? null : (s.providerId ?? String(randomInt(1, 2_000_000_000))), s.deleted ? 'deleted' : 'ready', s.created,
        s.deleted ?? null, s.deleted ? who.userId : null, priced ? (s.hourly ?? '0.020000') : null, priced ? (s.monthly ?? '5.0000') : null, priced ? (s.ipv4 ?? '0.5000') : null, s.currency ?? 'EUR', priced ? (s.ipv4Hourly === undefined ? '0.001000' : s.ipv4Hourly) : null],
    )).rows[0].id as string;
  }

  async function repo(who: Identity, owner: string, name: string): Promise<string> {
    const inst = randomUUID();
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')`, [inst, who.accountId, nextGhInstallationId()]);
    const id = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, 'team', $5, $6)`, [id, who.accountId, inst, randomInt(1, 2_000_000_000), owner, name]);
    return id;
  }
  async function runner(who: Identity, name: string | null): Promise<string> {
    const id = await insertRunner(admin, who.accountId, who.userId);
    if (name) await admin.query(`INSERT INTO runner_settings (runner_id, account_id, name) VALUES ($1, $2, $3)`, [id, who.accountId, name]);
    return id;
  }
  interface Use { runner: string; repo: string | null; day: string; source?: 'engine_session' | 'run'; tier: string; i?: number; o?: number; cr?: number; cw?: number }
  async function usage(who: Identity, u: Use): Promise<void> {
    await admin.query(
      `INSERT INTO machine_usage_daily (account_id, runner_id, repo_id, day, source, model_tier, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10)`,
      [who.accountId, u.runner, u.repo, u.day, u.source ?? 'run', u.tier, u.i ?? 0, u.o ?? 0, u.cr ?? 0, u.cw ?? 0],
    );
  }
  const sonnet = (t: { i: number; o: number; cr: number; cw: number }): number => Math.round(computeModelUsd('sonnet-5', { inputTokens: t.i, outputTokens: t.o, cacheReadTokens: t.cr, cacheWriteTokens: t.cw }) * 10_000) / 10_000;
  const opus = (t: { i: number; o: number; cr: number; cw: number }): number => Math.round(computeModelUsd('opus-5', { inputTokens: t.i, outputTokens: t.o, cacheReadTokens: t.cr, cacheWriteTokens: t.cw }) * 10_000) / 10_000;

  describe('servers this month: min(billed hours x hourly, monthly) + min(billed hours x IPv4 hourly, IPv4 monthly), from the stamped prices', () => {
    it('table: whole month (capped), created mid-month, deleted mid-month, deleted last month, deleted on the 1st, never created, no price', async () => {
      const me = await seedAccountWithMember(admin, { role: 'owner' });
      const cred = await credential(me);
      // Hours are rounded UP to whole started hours; the IPv4 hourly price is 0.001 (monthly 0.50) and the server hourly 0.02 (monthly 5.00).
      const rows: [Srv, { hours: string; cost: string | null; listed: boolean }][] = [
        [{ name: 'whole', created: '2026-10-15T00:00:00Z' }, { hours: '468', cost: '5.4680', listed: true }], // 468 h x 0.02 = 9.36, capped at 5.00, plus 468 x 0.001 = 0.468
        [{ name: 'created-mid', created: '2026-11-18T12:00:00Z' }, { hours: '48', cost: '1.0080', listed: true }], // 48 h x 0.02 = 0.96 + 0.048
        [{ name: 'deleted-mid', created: '2026-11-02T00:00:00Z', deleted: '2026-11-04T06:00:00Z' }, { hours: '54', cost: '1.1340', listed: true }], // 54 h x 0.02 = 1.08 + 0.054
        [{ name: 'crossed-in', created: '2026-10-25T00:00:00Z', deleted: '2026-11-01T12:00:00Z' }, { hours: '12', cost: '0.2520', listed: true }], // only November's 12 h
        [{ name: 'half-hour', created: '2026-11-20T11:30:00Z' }, { hours: '1', cost: '0.0210', listed: true }], // 30 min bills one hour: 0.02 + 0.001
        [{ name: 'just-over-an-hour', created: '2026-11-20T10:59:59Z' }, { hours: '2', cost: '0.0420', listed: true }], // 1 h 0 m 1 s bills two hours: 0.04 + 0.002
        [{ name: 'last-month', created: '2026-10-10T00:00:00Z', deleted: '2026-10-20T00:00:00Z' }, { hours: '', cost: null, listed: false }],
        [{ name: 'deleted-at-start', created: '2026-10-10T00:00:00Z', deleted: '2026-11-01T00:00:00Z' }, { hours: '', cost: null, listed: false }],
        [{ name: 'never-created', created: '2026-11-03T00:00:00Z', providerId: null }, { hours: '', cost: null, listed: false }],
        [{ name: 'no-price', created: '2026-11-19T12:00:00Z', priced: false }, { hours: '24', cost: null, listed: true }],
      ];
      for (const [s] of rows) await server(me, cred, s);
      const spend = await asTenant(me);
      const byName = new Map(spend.servers.servers!.map((s) => [s.name, s]));
      for (const [s, want] of rows) {
        const got = byName.get(s.name);
        expect({ name: s.name, listed: got !== undefined }).toEqual({ name: s.name, listed: want.listed });
        if (got) expect({ name: s.name, hours: got.hours, cost: got.cost }).toEqual({ name: s.name, hours: want.hours, cost: want.cost });
      }
      expect(spend.servers.totals).toEqual([{ currency: 'EUR', amount: '7.9250' }]); // 5.468 + 1.008 + 1.134 + 0.252 + 0.021 + 0.042
      expect(spend.servers.estimate_note).toBeNull();
      expect(spend.servers.servers!.every((x) => !x.estimate)).toBe(true);
      expect(spend.servers.unpriced_count).toBe(1);
      expect(spend.servers.note).toBe(SERVER_PRICE_NOTE);
      expect(byName.get('whole')!.running).toBe(true);
      expect(byName.get('deleted-mid')!.running).toBe(false);
      expect(spend.period_start).toBe('2026-11-01T00:00:00.000Z');
      expect(spend.period_end).toBe('2026-12-01T00:00:00.000Z');
    });

    it('the cap holds exactly at the monthly price, and a server under the cap pays by the hour', async () => {
      const me = await seedAccountWithMember(admin, { role: 'owner' });
      const cred = await credential(me);
      await server(me, cred, { name: 'under', created: '2026-11-20T00:00:00Z', hourly: '0.010000', monthly: '4.0000', ipv4: '0.0000' }); // 12 h x 0.01
      await server(me, cred, { name: 'over', created: '2026-11-01T00:00:00Z', hourly: '0.010000', monthly: '4.0000', ipv4: '0.0000' }); // 468 h x 0.01 = 4.68, capped at 4.00
      const spend = await asTenant(me);
      expect(Object.fromEntries(spend.servers.servers!.map((s) => [s.name, s.cost]))).toEqual({ under: '0.1200', over: '4.0000' });
    });

    it('hours stop at the clock, and the stamped price is what is used (no list price is read)', async () => {
      const me = await seedAccountWithMember(admin, { role: 'owner' });
      const cred = await credential(me);
      await server(me, cred, { name: 'old', created: '2026-10-01T00:00:00Z', hourly: '0.001000', monthly: '9.0000', ipv4: '1.0000', ipv4Hourly: '0.002000' });
      const october = await asTenant(me, new Date('2026-10-31T23:00:00Z'));
      expect(october.servers.servers![0]).toMatchObject({ hours: '743', cost: '1.7430' });
      const later = await asTenant(me, new Date('2026-10-15T00:00:00Z'));
      expect(later.servers.servers![0]).toMatchObject({ hours: '336', cost: '1.0080' }); // 0.336 + min(336 x 0.002, 1.00)
    });

    it('IPv4: capped at its monthly price, and a server made before the hourly stamp falls back to the monthly price and is marked an estimate', async () => {
      const me = await seedAccountWithMember(admin, { role: 'owner' });
      const cred = await credential(me);
      // 12 h each. Server hourly 0.02 => 0.24 for all three.
      await server(me, cred, { name: 'stamped', created: '2026-11-20T00:00:00Z', ipv4: '0.5000', ipv4Hourly: '0.010000' }); // 12 x 0.01 = 0.12
      await server(me, cred, { name: 'capped', created: '2026-11-20T00:00:00Z', ipv4: '0.1000', ipv4Hourly: '0.010000' }); // 0.12 capped at 0.10
      await server(me, cred, { name: 'legacy', created: '2026-11-20T00:00:00Z', ipv4: '0.5000', ipv4Hourly: null }); // no hourly stamp: the whole 0.50, never an hourly worked out from it
      const spend = await asTenant(me);
      const by = Object.fromEntries(spend.servers.servers!.map((x) => [x.name, x]));
      expect(by.stamped).toMatchObject({ cost: '0.3600', estimate: false });
      expect(by.capped).toMatchObject({ cost: '0.3400', estimate: false });
      expect(by.legacy).toMatchObject({ cost: '0.7400', estimate: true });
      expect(spend.servers.estimate_note).toBe(SERVER_ESTIMATE_NOTE);
      expect(spend.servers.totals).toEqual([{ currency: 'EUR', amount: '1.4400' }]);
    });

    it('the hourly IPv4 stamp cannot be changed by the app role, and rejects a negative price', async () => {
      const me = await seedAccountWithMember(admin, { role: 'owner' });
      const id = await server(me, await credential(me), { name: 'fixed', created: '2026-11-20T00:00:00Z' });
      await expect(withTenant(appUserPool, me.accountId, me.userId, (c) => c.query(`UPDATE managed_servers SET ipv4_hourly_gross = 0 WHERE id = $1 AND account_id = $2`, [id, me.accountId]))).rejects.toMatchObject({ code: '42501' });
      await expect(server(me, await credential(me), { name: 'neg', created: '2026-11-20T00:00:00Z', ipv4Hourly: '-0.001000' })).rejects.toMatchObject({ code: '23514' });
    });

    it('currencies are never added together', async () => {
      const me = await seedAccountWithMember(admin, { role: 'owner' });
      const cred = await credential(me);
      await server(me, cred, { name: 'eur', created: '2026-11-20T00:00:00Z' });
      await server(me, cred, { name: 'usd', created: '2026-11-20T00:00:00Z', currency: 'USD' });
      const spend = await asTenant(me);
      expect(spend.servers.totals).toEqual([{ currency: 'EUR', amount: '0.2520' }, { currency: 'USD', amount: '0.2520' }]);
    });

    it("another account's servers never appear, and the same account's other credential does (the admin client names the account)", async () => {
      const mine = await seedAccountWithMember(admin, { role: 'owner' });
      const theirs = await seedAccountWithMember(admin, { role: 'owner' });
      await server(mine, await credential(mine), { name: 'mine', created: '2026-11-20T00:00:00Z' });
      await server(mine, await credential(mine), { name: 'mine-too', created: '2026-11-20T00:00:00Z' });
      await server(theirs, await credential(theirs), { name: 'theirs', created: '2026-11-20T00:00:00Z' });
      expect((await asTenant(mine)).servers.servers!.map((s) => s.name).sort()).toEqual(['mine', 'mine-too']);
      expect((await readMachineSpend(admin, mine.accountId, { includeServerRows: true }, NOW)).servers.servers!.map((s) => s.name).sort()).toEqual(['mine', 'mine-too']);
      expect((await readMachineSpend(admin, randomUUID(), { includeServerRows: true }, NOW)).servers.servers).toEqual([]);
    });
  });

  describe('Claude usage this month: tokens by machine and project, priced with the cloud price table', () => {
    it('sums sources and days, keeps repos apart, prices each tier, and a machine equals the sum of its projects', async () => {
      const me = await seedAccountWithMember(admin, { role: 'owner' });
      const rA = await runner(me, 'Studio laptop');
      const rB = await runner(me, null);
      const repoX = await repo(me, 'acme', 'site');
      const repoY = await repo(me, 'acme', 'api'); // a second repo of the same account
      const a = { i: 1_000_000, o: 200_000, cr: 3_000_000, cw: 100_000 };
      const b = { i: 500_000, o: 100_000, cr: 1_000_000, cw: 50_000 };
      await usage(me, { runner: rA, repo: repoX, day: '2026-11-05', source: 'run', tier: 'sonnet', i: a.i, o: a.o, cr: a.cr, cw: a.cw });
      await usage(me, { runner: rA, repo: repoX, day: '2026-11-06', source: 'engine_session', tier: 'sonnet', i: b.i, o: b.o, cr: b.cr, cw: b.cw });
      await usage(me, { runner: rA, repo: repoY, day: '2026-11-07', tier: 'opus', i: 10, o: 20, cr: 30, cw: 40 });
      await usage(me, { runner: rB, repo: null, day: '2026-11-08', tier: 'opus', i: 1_000, o: 2_000, cr: 0, cw: 0 });
      // Outside November: the last day of October and the first of December.
      await usage(me, { runner: rA, repo: repoX, day: '2026-10-31', tier: 'sonnet', i: 999_999_999 });
      await usage(me, { runner: rA, repo: repoX, day: '2026-12-01', tier: 'sonnet', i: 999_999_999 });
      const u = (await asTenant(me)).usage;
      const sumX = { i: a.i + b.i, o: a.o + b.o, cr: a.cr + b.cr, cw: a.cw + b.cw };
      const usdX = sonnet(sumX);
      const usdY = opus({ i: 10, o: 20, cr: 30, cw: 40 });
      const usdB = opus({ i: 1_000, o: 2_000, cr: 0, cw: 0 });
      const mA = u.machines.find((m) => m.runner_id === rA)!;
      const mB = u.machines.find((m) => m.runner_id === rB)!;
      expect(mA.name).toBe('Studio laptop');
      expect(mB.name).toBeNull();
      expect(mA.projects.map((p) => p.name).sort()).toEqual(['acme/api', 'acme/site']);
      const pX = mA.projects.find((p) => p.repo_id === repoX)!;
      const pY = mA.projects.find((p) => p.repo_id === repoY)!;
      expect(pX).toMatchObject({ input_tokens: String(sumX.i), output_tokens: String(sumX.o), cache_read_tokens: String(sumX.cr), cache_write_tokens: String(sumX.cw), api_equivalent_usd: usdX, priced: true });
      expect(pY).toMatchObject({ input_tokens: '10', output_tokens: '20', cache_read_tokens: '30', cache_write_tokens: '40', api_equivalent_usd: usdY });
      expect(mA.api_equivalent_usd).toBe(Math.round((usdX + usdY) * 10_000) / 10_000);
      expect(mB.projects).toEqual([expect.objectContaining({ repo_id: null, name: null, api_equivalent_usd: usdB })]);
      expect(u.api_equivalent_usd).toBe(Math.round((usdX + usdY + usdB) * 10_000) / 10_000);
      expect(u).toMatchObject({ input_tokens: String(sumX.i + 10 + 1_000), priced: true, note: 'at API prices' });
    });

    it('a tier with no price keeps its tokens and has no dollar figure (never zero), and the total says it is partial', async () => {
      const me = await seedAccountWithMember(admin, { role: 'owner' });
      const r = await runner(me, 'box');
      await usage(me, { runner: r, repo: null, day: '2026-11-05', tier: 'unknown', i: 77, o: 1 });
      const only = (await asTenant(me)).usage;
      expect(only).toMatchObject({ input_tokens: '77', api_equivalent_usd: null, priced: false });
      expect(only.machines[0]).toMatchObject({ api_equivalent_usd: null, priced: false });
      await usage(me, { runner: r, repo: null, day: '2026-11-06', tier: 'haiku', i: 1_000_000 });
      const mixed = (await asTenant(me)).usage;
      expect(mixed.priced).toBe(false);
      expect(mixed.api_equivalent_usd).toBe(Math.round(computeModelUsd('haiku-4.5', { inputTokens: 1_000_000, outputTokens: 0 }) * 10_000) / 10_000);
      expect(mixed.input_tokens).toBe('1000077');
    });

    it('with no plan data the servers still answer and the Claude dollars are null (never a failed route, never zero)', async () => {
      const me = await seedAccountWithMember(admin, { role: 'owner' });
      await server(me, await credential(me), { name: 'box', created: '2026-11-20T00:00:00Z' });
      const r = await runner(me, 'laptop');
      await usage(me, { runner: r, repo: null, day: '2026-11-05', tier: 'sonnet', i: 1000, o: 5 });
      await usage(me, { runner: r, repo: null, day: '2026-11-05', tier: 'haiku', i: 7 });
      const saved = process.env.FX_PLAN_DATA;
      try {
        delete process.env.FX_PLAN_DATA;
        resetPlanDataCache();
        const spend = await asTenant(me);
        expect(spend.servers.servers!.map((x) => x.name)).toEqual(['box']);
        expect(spend.servers.totals).toEqual([{ currency: 'EUR', amount: '0.2520' }]);
        expect(spend.usage).toMatchObject({ input_tokens: '1007', output_tokens: '5', api_equivalent_usd: null, priced: false });
        expect(spend.usage.machines[0]).toMatchObject({ api_equivalent_usd: null, priced: false });
        expect(spend.usage.machines[0]!.projects[0]).toMatchObject({ api_equivalent_usd: null, priced: false });
        const live = await seedAccountWithMember(admin, { role: 'owner' });
        await server(live, await credential(live), CAPPED_BOX);
        const route = await handleApiRequest(new Request(`http://localhost${PATH}`, { headers: new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(live)}` }) }), appUserPool, platformOpsPool, ROUTES);
        expect(route.status).toBe(200);
        const body = machineSpendResponseSchema.parse(await route.json());
        expect(body.servers.servers!.map((x) => x.name)).toEqual(['box']);
        expect(body.servers.totals).toEqual([{ currency: 'EUR', amount: '5.5000' }]);
      } finally {
        if (saved !== undefined) process.env.FX_PLAN_DATA = saved;
        resetPlanDataCache();
      }
    });

    it('a removed project keeps its rows without a name; an empty month is an empty list', async () => {
      const me = await seedAccountWithMember(admin, { role: 'owner' });
      const r = await runner(me, 'box');
      const gone = await repo(me, 'acme', 'gone');
      await usage(me, { runner: r, repo: gone, day: '2026-11-05', tier: 'sonnet', i: 5 });
      await admin.query(`DELETE FROM repos WHERE id = $1`, [gone]);
      const u = (await asTenant(me)).usage;
      expect(u.machines[0]!.projects).toEqual([expect.objectContaining({ repo_id: null, name: null, input_tokens: '5' })]);
      const empty = await seedAccountWithMember(admin, { role: 'owner' });
      expect((await asTenant(empty)).usage).toMatchObject({ machines: [], input_tokens: '0' });
    });

    it('tokens past 2^53 are carried as exact strings', async () => {
      const me = await seedAccountWithMember(admin, { role: 'owner' });
      const r = await runner(me, 'box');
      await admin.query(`INSERT INTO machine_usage_daily (account_id, runner_id, day, source, model_tier, input_tokens) VALUES ($1, $2, '2026-11-02', 'run', 'unknown', 9007199254740993), ($1, $2, '2026-11-03', 'run', 'unknown', 9007199254740993)`, [me.accountId, r]);
      expect((await asTenant(me)).usage.input_tokens).toBe('18014398509481986');
    });

    it("says how each machine's usage is paid from its sign-in kind (88.0a): plan, API key, and no line when unknown, revoked or never said", async () => {
      const me = await seedAccountWithMember(admin, { role: 'owner' });
      const mk = async (mode: 'subscription' | 'api_key', auth: boolean | null, revoked = false): Promise<string> => {
        const id = await insertRunner(admin, me.accountId, me.userId, { credentialMode: mode });
        await admin.query(`UPDATE runners SET model_auth_present = $2, revoked_at = $3 WHERE id = $1`, [id, auth, revoked ? new Date('2026-11-10T00:00:00Z') : null]);
        await usage(me, { runner: id, repo: null, day: '2026-11-05', tier: 'sonnet', i: 5 });
        return id;
      };
      const sub = await mk('subscription', true);
      const key = await mk('api_key', true);
      const noAuth = await mk('subscription', false);
      const silent = await mk('api_key', null);
      const gone = await mk('subscription', true, true);
      const u = (await asTenant(me)).usage;
      const of = (id: string) => u.machines.find((m) => m.runner_id === id)!;
      expect(of(sub)).toMatchObject({ sign_in_kind: 'subscription', paid_note: 'Covered by your Claude plan; shown at API prices for comparison' });
      expect(of(key)).toMatchObject({ sign_in_kind: 'api_key', paid_note: 'Billed to your API key' });
      for (const id of [noAuth, silent, gone]) expect(of(id)).toMatchObject({ sign_in_kind: 'unknown', paid_note: null });
      // The sign-in kind only labels a machine: it never splits a machine's rows or changes a figure.
      expect(u.machines).toHaveLength(5);
      expect(of(sub)).toMatchObject({ input_tokens: '5' });
    });

    it("another account's machine sign-in never leaks onto this account's usage", async () => {
      const mine = await seedAccountWithMember(admin, { role: 'owner' });
      const theirs = await seedAccountWithMember(admin, { role: 'owner' });
      const rm = await insertRunner(admin, mine.accountId, mine.userId, { credentialMode: 'subscription' });
      const rt = await insertRunner(admin, theirs.accountId, theirs.userId, { credentialMode: 'api_key' });
      await admin.query(`UPDATE runners SET model_auth_present = true WHERE id = ANY($1::uuid[])`, [[rm, rt]]);
      await usage(mine, { runner: rm, repo: null, day: '2026-11-05', tier: 'sonnet', i: 1 });
      await usage(theirs, { runner: rt, repo: null, day: '2026-11-05', tier: 'sonnet', i: 1 });
      expect((await asTenant(mine)).usage.machines.map((m) => [m.runner_id, m.sign_in_kind])).toEqual([[rm, 'subscription']]);
      expect((await readMachineSpend(admin, theirs.accountId, { includeServerRows: true }, NOW)).usage.machines.map((m) => [m.runner_id, m.sign_in_kind])).toEqual([[rt, 'api_key']]);
      // The RLS-bypassing client with a foreign account id: nothing of mine, nothing of theirs.
      expect((await readMachineSpend(admin, randomUUID(), { includeServerRows: true }, NOW)).usage.machines).toEqual([]);
    });

    it("another account's usage never appears, with the same machine id space and through the admin client", async () => {
      const mine = await seedAccountWithMember(admin, { role: 'owner' });
      const theirs = await seedAccountWithMember(admin, { role: 'owner' });
      const rm = await runner(mine, 'mine');
      const rt = await runner(theirs, 'theirs');
      const rx = await repo(mine, 'acme', 'mine');
      const rtheirs = await repo(theirs, 'acme', 'theirs');
      await usage(mine, { runner: rm, repo: rx, day: '2026-11-05', tier: 'sonnet', i: 1 });
      await usage(theirs, { runner: rt, repo: rtheirs, day: '2026-11-05', tier: 'sonnet', i: 1_000 });
      expect((await asTenant(mine)).usage).toMatchObject({ input_tokens: '1' });
      expect((await readMachineSpend(admin, mine.accountId, { includeServerRows: true }, NOW)).usage).toMatchObject({ input_tokens: '1' });
      expect((await readMachineSpend(admin, randomUUID(), { includeServerRows: true }, NOW)).usage.machines).toEqual([]);
    });
  });

  describe('the route', () => {
    const cookie = async (who: Identity) => `${SESSION_COOKIE_NAME}=${await signSession(who)}`;
    async function get(headers: Headers): Promise<Response> {
      await admin.query("DELETE FROM rate_limit_windows WHERE bucket_key LIKE 'session%'");
      return handleApiRequest(new Request(`http://localhost${PATH}`, { headers }), appUserPool, platformOpsPool, ROUTES);
    }

    it('answers a member with the schema-valid body, private and uncached, and the page-facing note', async () => {
      const me = await seedAccountWithMember(admin, { role: 'member' });
      await server(me, await credential(me), CAPPED_BOX);
      const res = await get(new Headers({ cookie: await cookie(me) }));
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      const body = machineSpendResponseSchema.parse(await res.json());
      // A member gets the totals and the usage, and no per-server rows (name, size and location are owner/admin-only everywhere else).
      expect(body.servers.servers).toBeNull();
      expect(body.servers.totals).toEqual([{ currency: 'EUR', amount: '5.5000' }]);
      expect(body.servers.note).toBe(SERVER_PRICE_NOTE);
      expect(JSON.stringify(body)).not.toMatch(/"box"|cpx31|fsn1/);
    });

    it.each(['owner', 'admin'] as const)('answers an %s with the per-server rows as well as the totals', async (role) => {
      const me = await seedAccountWithMember(admin, { role });
      await server(me, await credential(me), CAPPED_BOX);
      const res = await get(new Headers({ cookie: await cookie(me) }));
      expect(res.status).toBe(200);
      const body = machineSpendResponseSchema.parse(await res.json());
      expect(body.servers.servers!.map((s) => ({ name: s.name, server_type: s.server_type, location: s.location }))).toEqual([{ name: 'box', server_type: 'cpx31', location: 'fsn1' }]);
      expect(body.servers.totals).toEqual([{ currency: 'EUR', amount: '5.5000' }]);
    });

    it('is session only: a token is 403, no login is 401, and POST is refused', async () => {
      const me = await seedAccountWithMember(admin, { role: 'owner' });
      const plaintext = generateToken();
      await insertApiToken(appUserPool, { accountId: me.accountId, createdBy: me.userId, tokenHash: hashToken(plaintext), displayHint: displayHint(plaintext), scopes: ['read'], expiresAt: new Date(Date.now() + 3_600_000) });
      const asToken = await get(new Headers({ authorization: `Bearer ${plaintext}` }));
      expect(asToken.status).toBe(403);
      expect(((await asToken.json()) as { error: { code: string } }).error.code).toBe('session_required');
      expect((await get(new Headers())).status).toBe(401);
      const post = await handleApiRequest(new Request(`http://localhost${PATH}`, { method: 'POST', headers: new Headers({ cookie: await cookie(me), 'content-type': 'application/json' }), body: '{}' }), appUserPool, platformOpsPool, ROUTES);
      expect(post.status).toBeGreaterThanOrEqual(400);
      expect(post.status).toBeLessThan(500);
      const route = ROUTES.find((r) => r.operationId === 'getMachineSpend')!;
      expect(route).toMatchObject({ method: 'GET', path: PATH, minRole: 'member', rateClass: 'read' });
      expect(route.principals).toBeUndefined();
    });

    it("a member of another account never sees this account's figures", async () => {
      const mine = await seedAccountWithMember(admin, { role: 'owner' });
      const other = await seedAccountWithMember(admin, { role: 'owner' });
      await server(mine, await credential(mine), { name: 'secret-box', created: '2026-11-01T00:00:00Z' });
      const res = await get(new Headers({ cookie: await cookie(other) }));
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain('secret-box');
    });
  });
});
