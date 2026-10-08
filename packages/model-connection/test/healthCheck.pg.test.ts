import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { connect } from '../src/connect.js';
import { test as testConnection, healthCheck, type HealthCheckCtx } from '../src/validate.js';
import { fetchValidationHttpClient, type ValidationHttpClient, type ValidationOutcome } from '../src/httpClient.js';
import * as pkg from '../src/index.js';
import { fakeHttpClient, gatedHttpClient } from './helpers/fakeHttpClient.js';
import { fakeKekSource } from './helpers/fakeKek.js';
import { seedAccountWithMember } from './helpers/seed.js';
import { ctxFactory } from './helpers/ctx.js';
import { startStrictProviders, type StrictProviders } from './helpers/strictProviders.js';

/**
 * D#454 H2e (correction C1), criteria 3 to 6 against real Postgres: the health entry point, the two-strike rule, the
 * strike reset on a new key, and the grants. Provider answers come from a fake client for the sequences (one outcome
 * per call) and from the strict TLS fakes for the gateway 403 and the revoked-key runs.
 */
const OK: ValidationOutcome = { kind: 'ok' };
const R401: ValidationOutcome = { kind: 'rejected', code: '401', message: 'rejected' };
const NET500: ValidationOutcome = { kind: 'network_error', code: '500', message: 'server error' };

describe('healthCheck (D#454 H2e)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let ctx: ReturnType<typeof ctxFactory>;
  const kek = fakeKekSource();

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    ctx = ctxFactory(appUserPool, platformOpsPool);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  const hctx = (httpClient: ValidationHttpClient): HealthCheckCtx => ({ pool: appUserPool, platformOpsPool, httpClient, kek });
  const sequence = (...outcomes: ValidationOutcome[]) => {
    let i = 0;
    return fakeHttpClient(() => outcomes[Math.min(i++, outcomes.length - 1)]!);
  };
  async function seedConnected(key = `sk-h2e2-${randomUUID()}`) {
    const a = await seedAccountWithMember(admin, 'owner');
    await connect(ctx(a, fakeHttpClient(OK), kek), { provider: 'ai_gateway', key });
    return { ...a, key };
  }
  const row = async (accountId: string) =>
    (await admin.query(`SELECT id, status, health_strikes, last_error_code, last_validated_at, key_nonce FROM model_connections WHERE account_id = $1`, [accountId])).rows[0];
  const brokenAt = async (accountId: string) => (await admin.query(`SELECT key_broken_at FROM accounts WHERE id = $1`, [accountId])).rows[0].key_broken_at as Date | null;
  const events = async (accountId: string) =>
    (await admin.query(`SELECT type, payload FROM domain_events WHERE account_id = $1 ORDER BY seq`, [accountId])).rows.map((r) => `${r.type}:${r.payload.state ?? r.payload.code ?? ''}`);
  const checkAll = async (accountId: string, ...outcomes: ValidationOutcome[]) => {
    const client = sequence(...outcomes);
    const results = [];
    for (let i = 0; i < outcomes.length; i++) results.push(await healthCheck(hctx(client), accountId));
    return { results, calls: client.calls.length };
  };

  it('is exported from the package index, next to the four frozen functions', () => {
    expect(pkg.healthCheck).toBe(healthCheck);
  });

  describe('criterion 3: the entry point', () => {
    it('needs no principal and no membership: it reads the sealed key through the tenant scope and makes one call', async () => {
      const a = await seedConnected();
      const client = fakeHttpClient(OK);
      expect(await healthCheck(hctx(client), a.accountId)).toEqual({ action: 'cleared' });
      expect(client.calls).toEqual([{ provider: 'ai_gateway', plaintextKey: a.key }]);
    });

    it('an account with no connection, or a connection id that is not the one found, is skipped with no call', async () => {
      const none = await seedAccountWithMember(admin, 'owner');
      const client = fakeHttpClient(OK);
      expect(await healthCheck(hctx(client), none.accountId)).toBeNull();
      const a = await seedConnected();
      expect(await healthCheck(hctx(client), a.accountId, randomUUID())).toBeNull();
      expect(client.calls).toHaveLength(0);
    });

    it('a key rotated while the call is in flight is not written to at all, strikes included', async () => {
      const a = await seedConnected();
      const gated = gatedHttpClient();
      const pending = healthCheck(hctx(gated), a.accountId);
      await gated.started;
      // Replaced while the validation call is out (a rotation lands between the read and the lock).
      await connect(ctx(a, fakeHttpClient(OK), kek), { provider: 'ai_gateway', key: `sk-h2e2-${randomUUID()}` });
      const before = await row(a.accountId);
      gated.release(R401);
      expect(await pending).toEqual({ action: 'skipped' });
      const after = await row(a.accountId);
      expect(after.health_strikes).toBe(0);
      expect(after.status).toBe(before.status);
      expect(after.last_error_code).toBe(before.last_error_code);
    });
  });

  describe('criterion 4: two strikes', () => {
    it('401, 401: the first is a silent strike, the second marks the key broken with its event', async () => {
      const a = await seedConnected();
      const eventsBefore = await events(a.accountId);
      const client = sequence(R401);

      expect(await healthCheck(hctx(client), a.accountId)).toEqual({ action: 'strike' });
      let r = await row(a.accountId);
      expect([r.status, r.health_strikes, r.last_error_code]).toEqual(['ok', 1, null]);
      expect(await brokenAt(a.accountId)).toBeNull();
      expect(await events(a.accountId)).toEqual(eventsBefore); // nothing a user can see, and no event

      expect(await healthCheck(hctx(client), a.accountId)).toEqual({ action: 'broken' });
      r = await row(a.accountId);
      expect([r.status, r.last_error_code]).toEqual(['broken', '401']);
      expect(await brokenAt(a.accountId)).not.toBeNull();
      expect((await events(a.accountId)).slice(eventsBefore.length)).toEqual(['model_connection.broken:401', 'model_connection.changed:broken']);
    });

    it('401, 200, 401: the 200 resets the count, so the key is not broken', async () => {
      const a = await seedConnected();
      const { results } = await checkAll(a.accountId, R401, OK, R401);
      expect(results.map((r) => r?.action)).toEqual(['strike', 'cleared', 'strike']);
      const r = await row(a.accountId);
      expect([r.status, r.health_strikes]).toEqual(['ok', 1]);
    });

    it('401, 500, 401: a 5xx neither counts nor resets, so the key ends broken', async () => {
      const a = await seedConnected();
      const { results } = await checkAll(a.accountId, R401, NET500, R401);
      expect(results.map((r) => r?.action)).toEqual(['strike', 'unchanged', 'broken']);
      expect((await row(a.accountId)).status).toBe('broken');
    });

    it('a network error changes nothing at all: no strike added or reset, no status, no error code, no event', async () => {
      const a = await seedConnected();
      await checkAll(a.accountId, R401);
      const before = [await row(a.accountId), await events(a.accountId)];
      for (const code of ['500', '429', '402', 'fetch_failed', '403']) {
        await healthCheck(hctx(fakeHttpClient({ kind: 'network_error', code, message: 'x' })), a.accountId);
      }
      expect([await row(a.accountId), await events(a.accountId)]).toEqual(before);
      expect((await row(a.accountId)).health_strikes).toBe(1);
    });

    it('a 200 clears a broken key through the ok path: status ok, key_broken_at cleared, strikes zero, event ok', async () => {
      const a = await seedConnected();
      await checkAll(a.accountId, R401, R401);
      expect((await row(a.accountId)).status).toBe('broken');
      await healthCheck(hctx(fakeHttpClient(OK)), a.accountId);
      const r = await row(a.accountId);
      expect([r.status, r.health_strikes, r.last_error_code]).toEqual(['ok', 0, null]);
      expect(await brokenAt(a.accountId)).toBeNull();
      expect((await events(a.accountId)).at(-1)).toBe('model_connection.changed:ok');
    });

    it("a user's own Test key success also clears a strike", async () => {
      const a = await seedConnected();
      await checkAll(a.accountId, R401);
      expect((await row(a.accountId)).health_strikes).toBe(1);
      await testConnection(ctx(a, fakeHttpClient(OK), kek));
      expect((await row(a.accountId)).health_strikes).toBe(0);
    });

    it('an Anthropic 403 is a rejection too and breaks the key on its second, with code 403', async () => {
      // connect() does not take Anthropic yet (feature flag), so the stored provider is switched directly.
      const a = await seedConnected();
      await admin.query(`UPDATE model_connections SET provider = 'anthropic' WHERE account_id = $1`, [a.accountId]);
      await checkAll(a.accountId, { kind: 'rejected', code: '403', message: 'x' }, { kind: 'rejected', code: '403', message: 'x' });
      const r = await row(a.accountId);
      expect([r.status, r.last_error_code]).toEqual(['broken', '403']);
    });

    it('a connection that is already broken is not announced again by a later 401', async () => {
      const a = await seedConnected();
      await checkAll(a.accountId, R401, R401);
      const before = await events(a.accountId);
      expect(await healthCheck(hctx(fakeHttpClient(R401)), a.accountId)).toEqual({ action: 'unchanged' });
      expect(await events(a.accountId)).toEqual(before);
    });

    describe('through the strict gateway fake and the real client', () => {
      let world: StrictProviders;
      beforeAll(async () => {
        world = await startStrictProviders({ ai_gateway: [] });
      });
      afterAll(async () => {
        await world.close();
      });

      it('gateway 403, 403 stays ok: a plan restriction is "could not confirm", never a strike', async () => {
        const a = await seedConnected('vck_h2e2_plan_limited');
        world.reset();
        world.ai_gateway.mode = { status: 403 };
        const client = fetchValidationHttpClient(5000, world.transport);
        await healthCheck(hctx(client), a.accountId);
        await healthCheck(hctx(client), a.accountId);
        const r = await row(a.accountId);
        expect([r.status, r.health_strikes, r.last_error_code]).toEqual(['ok', 0, null]);
        expect(world.ai_gateway.seen.map((q) => `${q.method} ${q.path}`)).toEqual(['GET /v1/credits', 'GET /v1/credits']);
        expect(world.refused()).toEqual([]);
      });

      it('a revoked key (the fake no longer knows it) is broken on the second daily check, and a working one is not', async () => {
        const revoked = await seedConnected('vck_h2e2_revoked_key');
        const live = await seedConnected('vck_h2e2_live_key');
        world.reset();
        world.ai_gateway.knownKeys.add('vck_h2e2_live_key');
        const client = fetchValidationHttpClient(5000, world.transport);
        for (let day = 0; day < 2; day++) {
          await healthCheck(hctx(client), revoked.accountId);
          await healthCheck(hctx(client), live.accountId);
        }
        expect((await row(revoked.accountId)).status).toBe('broken');
        expect((await row(live.accountId)).status).toBe('ok');
        expect(world.refused()).toEqual([]);
      });
    });
  });

  describe('criterion 5: a new key resets the strike', () => {
    it('a strike, then a rotation, then a 401 gives a strike of 1, not broken', async () => {
      const a = await seedConnected();
      await checkAll(a.accountId, R401);
      expect((await row(a.accountId)).health_strikes).toBe(1);

      await connect(ctx(a, fakeHttpClient(OK), kek), { provider: 'ai_gateway', key: `sk-h2e2-${randomUUID()}` });
      expect((await row(a.accountId)).health_strikes).toBe(0);

      await healthCheck(hctx(fakeHttpClient(R401)), a.accountId);
      const r = await row(a.accountId);
      expect([r.status, r.health_strikes]).toEqual(['ok', 1]);
    });

    it('the reset comes from the trigger, not from the new key happening to validate: a rotation that could not be confirmed resets it too', async () => {
      const a = await seedConnected();
      await checkAll(a.accountId, R401);
      await connect(ctx(a, fakeHttpClient(NET500), kek), { provider: 'ai_gateway', key: `sk-h2e2-${randomUUID()}` });
      const rotated = await row(a.accountId);
      expect([rotated.status, rotated.health_strikes]).toEqual(['unvalidated', 0]);
      await healthCheck(hctx(fakeHttpClient(R401)), a.accountId);
      const r = await row(a.accountId);
      expect([r.status, r.health_strikes]).toEqual(['unvalidated', 1]);
    });

    it('the guard trigger itself resets the count when an app_user changes the key material directly', async () => {
      const a = await seedConnected();
      await checkAll(a.accountId, R401);
      await withTenant(appUserPool, a.accountId, async (client) => {
        await client.query(`UPDATE model_connections SET key_nonce = $1 WHERE account_id = $2`, [Buffer.alloc(12, 7), a.accountId]);
      });
      const r = await row(a.accountId);
      expect([r.health_strikes, r.status]).toEqual([0, 'unvalidated']);
    });
  });

  describe('criterion 6: grants', () => {
    it('platform_ops cannot read key_ciphertext or wrapped_dek, nor write a key column; it can write health_strikes', async () => {
      const a = await seedConnected();
      const ops = await platformOpsPool.connect();
      try {
        await expect(ops.query(`SELECT key_ciphertext FROM model_connections WHERE account_id = $1`, [a.accountId])).rejects.toMatchObject({ code: '42501' });
        await expect(ops.query(`SELECT wrapped_dek FROM model_connections WHERE account_id = $1`, [a.accountId])).rejects.toMatchObject({ code: '42501' });
        await expect(ops.query(`SELECT * FROM model_connections WHERE account_id = $1`, [a.accountId])).rejects.toMatchObject({ code: '42501' });
        await expect(ops.query(`UPDATE model_connections SET key_ciphertext = '\\x00' WHERE account_id = $1`, [a.accountId])).rejects.toMatchObject({ code: '42501' });
        await ops.query(`UPDATE model_connections SET health_strikes = 1 WHERE account_id = $1`, [a.accountId]);
      } finally {
        ops.release();
      }
      expect((await row(a.accountId)).health_strikes).toBe(1);
    });

    it('app_user cannot set health_strikes, on its own row or at insert', async () => {
      const a = await seedConnected();
      await expect(
        withTenant(appUserPool, a.accountId, (client) => client.query(`UPDATE model_connections SET health_strikes = 1 WHERE account_id = $1`, [a.accountId])),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        withTenant(appUserPool, a.accountId, (client) => client.query(`UPDATE model_connections SET health_strikes = 0 WHERE account_id = $1`, [a.accountId])),
      ).resolves.toBeDefined(); // writing the value it already has is not a change
      expect((await row(a.accountId)).health_strikes).toBe(0);

      const other = await seedAccountWithMember(admin, 'owner');
      await expect(
        withTenant(appUserPool, other.accountId, (client) =>
          client.query(
            `INSERT INTO model_connections (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint, health_strikes)
             VALUES ($1, 'ai_gateway', '\\x01', '\\x02', '\\x03', 1, 'abcd', 1)`,
            [other.accountId],
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });
});
