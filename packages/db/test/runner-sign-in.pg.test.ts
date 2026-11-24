import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { RUNNER_SIGN_IN_KIND_SQL, runnerSignInKind, type RunnerSignInKind } from '../src/runnerSignIn.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const MODES = ['subscription', 'api_key'] as const;
const AUTH = [true, false, null] as const;
const REVOKED = [false, true] as const;

/** D#845 ON-10b1 (Ruling 88, 88.0a): how Claude is signed in on a machine, as one derived fact. The SQL fragment and the mapper are one rule. */
describe('runnerSignInKind: the mapper and the SQL fragment agree', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  const expected = (mode: string, auth: boolean | null, revoked: boolean): RunnerSignInKind => (revoked || auth !== true ? 'unknown' : mode === 'subscription' ? 'subscription' : 'api_key');

  it('every combination of mode, auth (true, false, NULL) and revoked gives the table\'s kind, in the mapper and in SQL read as the web login', async () => {
    for (const mode of MODES) {
      for (const auth of AUTH) {
        for (const revoked of REVOKED) {
          const id = await insertRunner(admin, a.accountId, a.userId, { credentialMode: mode });
          await admin.query('UPDATE runners SET model_auth_present = $2, revoked_at = $3 WHERE id = $1', [id, auth, revoked ? new Date() : null]);
          const row = (await withTenant(appPool, a.accountId, (c) => c.query<{ credential_mode: string; model_auth_present: boolean | null; revoked_at: Date | null; kind: string }>(
            `SELECT credential_mode, model_auth_present, revoked_at, ${RUNNER_SIGN_IN_KIND_SQL('rn')} AS kind FROM runners rn WHERE rn.account_id = $1 AND rn.id = $2`,
            [a.accountId, id],
          ))).rows[0]!;
          const label = `${mode} auth=${String(auth)} revoked=${revoked}`;
          expect(row.kind, label).toBe(expected(mode, auth, revoked));
          expect(runnerSignInKind(row), label).toBe(row.kind);
        }
      }
    }
  });

  it('no row, and a row with an unknown mode, are unknown', () => {
    expect(runnerSignInKind(null)).toBe('unknown');
    expect(runnerSignInKind(undefined)).toBe('unknown');
    expect(runnerSignInKind({ credential_mode: 'oauth', model_auth_present: true, revoked_at: null })).toBe('unknown');
    expect(runnerSignInKind({ credential_mode: null, model_auth_present: true, revoked_at: null })).toBe('unknown');
    expect(runnerSignInKind({ credential_mode: 'subscription', model_auth_present: true, revoked_at: '2026-11-01T00:00:00Z' })).toBe('unknown');
  });

  it('neither reads anything but credential_mode, model_auth_present and revoked_at', () => {
    const touched: string[] = [];
    const spy = new Proxy({ credential_mode: 'subscription', model_auth_present: true, revoked_at: null, registered_by: 'x', jkt: 'y', public_key_jwk: {} }, { get: (t, k, r) => (touched.push(String(k)), Reflect.get(t, k, r)) });
    runnerSignInKind(spy as never);
    expect([...new Set(touched)].sort()).toEqual(['credential_mode', 'model_auth_present', 'revoked_at']);
    const columns = [...RUNNER_SIGN_IN_KIND_SQL('rn').matchAll(/\brn\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(columns)].sort()).toEqual(['credential_mode', 'model_auth_present', 'revoked_at']);
  });

  it('refuses an alias that is not a plain identifier, so nothing else can ride into a query', () => {
    for (const bad of ['', 'rn; DROP TABLE runners', "rn'", 'Rn', '1rn', 'a.b', 'rn ']) expect(() => RUNNER_SIGN_IN_KIND_SQL(bad), bad).toThrow(TypeError);
    expect(() => RUNNER_SIGN_IN_KIND_SQL('r_2')).not.toThrow();
  });
});
