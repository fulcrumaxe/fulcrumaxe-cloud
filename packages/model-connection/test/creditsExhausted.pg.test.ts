import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { connect } from '../src/connect.js';
import { markBroken } from '../src/markBroken.js';
import { markCreditsExhausted } from '../src/creditsExhausted.js';
import { revalidateCreditsExhausted, test as testConnection, type HealthCheckCtx } from '../src/validate.js';
import { fetchValidationHttpClient, type ValidationHttpClient } from '../src/httpClient.js';
import * as pkg from '../src/index.js';
import { fakeHttpClient } from './helpers/fakeHttpClient.js';
import { fakeKekSource } from './helpers/fakeKek.js';
import { seedAccountWithMember } from './helpers/seed.js';
import { ctxFactory } from './helpers/ctx.js';
import { startStrictProviders, type StrictProviders } from './helpers/strictProviders.js';

/**
 * D#483 S5-k2 against real Postgres and the strict provider fakes: the out-of-credit mark, what it does and does not touch, and the re-validation that lifts it.
 * The re-validation goes through the real validation client over TLS to the strict gateway fake, which refuses anything but the one read endpoint: that is the
 * proof the call makes no model request and uses no tokens (a POST or a chat path lands in `refused`, and every test asserts `refused` is empty).
 */
describe('credits exhausted: the mark and the re-validation (D#483 S5-k2)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let world: StrictProviders;
  let ctx: ReturnType<typeof ctxFactory>;
  const kek = fakeKekSource();

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    ctx = ctxFactory(appUserPool, platformOpsPool);
    world = await startStrictProviders({ ai_gateway: [] });
  });
  afterAll(async () => {
    await world.close();
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  const hctx = (httpClient: ValidationHttpClient): HealthCheckCtx => ({ pool: appUserPool, platformOpsPool, httpClient, kek });
  const ok = fakeHttpClient({ kind: 'ok' });

  async function seedConnected() {
    const key = `vck_s5k2_${randomUUID()}`;
    world.ai_gateway.knownKeys.add(key);
    const a = await seedAccountWithMember(admin, 'owner');
    await connect(ctx(a, ok, kek), { provider: 'ai_gateway', key });
    const id = (await admin.query(`SELECT id FROM model_connections WHERE account_id = $1`, [a.accountId])).rows[0].id as string;
    return { ...a, key, id };
  }
  const row = async (accountId: string) => (await admin.query(`SELECT status, last_error_code, last_validated_at FROM model_connections WHERE account_id = $1`, [accountId])).rows[0];
  const account = async (accountId: string) => (await admin.query(`SELECT status, key_broken_at FROM accounts WHERE id = $1`, [accountId])).rows[0];
  const events = async (accountId: string) =>
    (await admin.query(`SELECT type, payload FROM domain_events WHERE account_id = $1 ORDER BY seq`, [accountId])).rows.map((r) => `${r.type}:${r.payload.state ?? r.payload.code ?? ''}`);

  it('is exported from the package index', () => {
    expect(pkg.markCreditsExhausted).toBe(markCreditsExhausted);
    expect(pkg.revalidateCreditsExhausted).toBe(revalidateCreditsExhausted);
    expect(pkg.isCreditsExhaustedAnswer).toBeTypeOf('function');
  });

  describe('the mark', () => {
    it('records status broken with last_error_code credits_exhausted, emits one changed event, and does NOT stop the account', async () => {
      const a = await seedConnected();
      const before = await events(a.accountId);
      expect(await markCreditsExhausted(platformOpsPool, a.accountId)).toBe(true);
      const r = await row(a.accountId);
      expect([r.status, r.last_error_code]).toEqual(['broken', 'credits_exhausted']);
      // The account keeps running what does not draw on the key: no key_broken_at, status stays active.
      const acct = await account(a.accountId);
      expect([acct.status, acct.key_broken_at]).toEqual(['active', null]);
      expect((await events(a.accountId)).slice(before.length)).toEqual(['model_connection.changed:broken']);
    });

    it('a second mark changes nothing and announces nothing', async () => {
      const a = await seedConnected();
      await markCreditsExhausted(platformOpsPool, a.accountId);
      const events1 = await events(a.accountId);
      expect(await markCreditsExhausted(platformOpsPool, a.accountId)).toBe(false);
      expect(await events(a.accountId)).toEqual(events1);
    });

    it('a connection already broken for a rejected key keeps its own code and its account stop', async () => {
      const a = await seedConnected();
      await markBroken(platformOpsPool, a.accountId, 401);
      expect(await markCreditsExhausted(platformOpsPool, a.accountId)).toBe(false);
      const r = await row(a.accountId);
      expect([r.status, r.last_error_code]).toEqual(['broken', '401']);
      expect((await account(a.accountId)).key_broken_at).not.toBeNull();
    });

    it('an account with no connection is a no-op', async () => {
      const none = await seedAccountWithMember(admin, 'owner');
      expect(await markCreditsExhausted(platformOpsPool, none.accountId)).toBe(false);
    });

    it('writes only the word: no provider text reaches the row or the event', async () => {
      const a = await seedConnected();
      await markCreditsExhausted(platformOpsPool, a.accountId);
      const dump = JSON.stringify((await admin.query(`SELECT payload FROM domain_events WHERE account_id = $1`, [a.accountId])).rows) + JSON.stringify(await row(a.accountId));
      expect(dump).not.toContain(a.key);
      expect(dump).not.toMatch(/balance|quota|insufficient/i);
    });
  });

  describe('the re-validation', () => {
    it('still out of credit (the endpoint answers 402): nothing changes, and the one call was the read endpoint', async () => {
      const a = await seedConnected();
      await markCreditsExhausted(platformOpsPool, a.accountId);
      world.reset();
      world.ai_gateway.mode = { status: 402 };
      const before = [await row(a.accountId), await events(a.accountId)];
      const result = await revalidateCreditsExhausted(hctx(fetchValidationHttpClient(5000, world.transport)), a.accountId, a.id);
      expect(result).toEqual({ action: 'still_exhausted' });
      expect([await row(a.accountId), await events(a.accountId)]).toEqual(before);
      expect(world.ai_gateway.seen.map((q) => `${q.method} ${q.path}`)).toEqual(['GET /v1/credits']);
      expect(world.refused()).toEqual([]);
    });

    it('credits are back (the endpoint answers 200): the connection is ok again with no person action, and the pause lifts', async () => {
      const a = await seedConnected();
      await markCreditsExhausted(platformOpsPool, a.accountId);
      world.reset();
      const result = await revalidateCreditsExhausted(hctx(fetchValidationHttpClient(5000, world.transport)), a.accountId, a.id);
      expect(result).toEqual({ action: 'resumed' });
      const r = await row(a.accountId);
      expect([r.status, r.last_error_code]).toEqual(['ok', null]);
      expect((await events(a.accountId)).at(-1)).toBe('model_connection.changed:ok');
      expect(world.ai_gateway.seen.map((q) => `${q.method} ${q.path}`)).toEqual(['GET /v1/credits']);
      expect(world.refused()).toEqual([]);
    });

    it('the whole cycle: broken for credits, still empty, then topped up, ends ok; a second pass has nothing to do', async () => {
      const a = await seedConnected();
      await markCreditsExhausted(platformOpsPool, a.accountId);
      const client = fetchValidationHttpClient(5000, world.transport);
      world.reset();
      world.ai_gateway.mode = { status: 402 };
      expect((await revalidateCreditsExhausted(hctx(client), a.accountId, a.id))?.action).toBe('still_exhausted');
      world.ai_gateway.mode = null;
      expect((await revalidateCreditsExhausted(hctx(client), a.accountId, a.id))?.action).toBe('resumed');
      expect((await revalidateCreditsExhausted(hctx(client), a.accountId, a.id))?.action).toBe('skipped');
      expect((await row(a.accountId)).status).toBe('ok');
      expect(world.refused()).toEqual([]);
    });

    it('the key itself is now rejected (401): the connection is broken for that reason, with the account stop', async () => {
      const a = await seedConnected();
      await markCreditsExhausted(platformOpsPool, a.accountId);
      world.reset();
      world.ai_gateway.knownKeys.delete(a.key);
      const result = await revalidateCreditsExhausted(hctx(fetchValidationHttpClient(5000, world.transport)), a.accountId, a.id);
      expect(result).toEqual({ action: 'now_rejected' });
      const r = await row(a.accountId);
      expect([r.status, r.last_error_code]).toEqual(['broken', '401']);
      expect((await account(a.accountId)).key_broken_at).not.toBeNull();
    });

    it('a connection that is not (or no longer) broken for credits gets no write', async () => {
      const a = await seedConnected();
      world.reset();
      expect((await revalidateCreditsExhausted(hctx(fakeHttpClient({ kind: 'ok' })), a.accountId, a.id))?.action).toBe('skipped');
      await markBroken(platformOpsPool, a.accountId, 401);
      expect((await revalidateCreditsExhausted(hctx(fakeHttpClient({ kind: 'ok' })), a.accountId, a.id))?.action).toBe('skipped');
      expect((await row(a.accountId)).last_error_code).toBe('401');
    });

    it('a key replaced while the call was in flight is not written to', async () => {
      const a = await seedConnected();
      await markCreditsExhausted(platformOpsPool, a.accountId);
      const replacement = `vck_s5k2_${randomUUID()}`;
      const rotating: ValidationHttpClient = {
        async validate() {
          await connect(ctx(a, ok, kek), { provider: 'ai_gateway', key: replacement });
          return { kind: 'ok' };
        },
      };
      expect((await revalidateCreditsExhausted(hctx(rotating), a.accountId, a.id))?.action).toBe('skipped');
    });

    it('returns null for an account with no connection or a connection id that is not the one found', async () => {
      const none = await seedAccountWithMember(admin, 'owner');
      expect(await revalidateCreditsExhausted(hctx(ok), none.accountId, randomUUID())).toBeNull();
      const a = await seedConnected();
      expect(await revalidateCreditsExhausted(hctx(ok), a.accountId, randomUUID())).toBeNull();
    });

    it('a person re-testing the key (Test key) lifts it the same way', async () => {
      const a = await seedConnected();
      await markCreditsExhausted(platformOpsPool, a.accountId);
      await testConnection(ctx(a, ok, kek));
      expect((await row(a.accountId)).status).toBe('ok');
    });
  });
});
