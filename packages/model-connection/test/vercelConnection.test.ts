import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { FakeVercel } from '../../core/test/support/vercelEnvFake.js';
import {
  VERCEL_ERROR_COPY,
  VERCEL_ROTATE_COPY,
  VercelConnectionError,
  connectVercel,
  createSealedVercelCredentials,
  createVercelTokenValidator,
  getVercelConnection,
  removeVercel,
  rotateVercel,
  vercelStateCopy,
  type VercelConnectionCtx,
  type VercelTokenCheck,
  type VercelTokenValidator,
} from '../src/index.js';
import { NotFoundError, ForbiddenError } from '../src/errors.js';
import type { KekSource } from '../src/kek.js';
import { fakeKekSource, fakeVersionedKek } from './helpers/fakeKek.js';
import { seedAccountWithMember } from './helpers/seed.js';

/** A validator that answers from a table of known tokens and records what it was asked (the token itself is the only thing it sees). */
class StubValidator implements VercelTokenValidator {
  calls: string[] = [];
  verdicts = new Map<string, VercelTokenCheck>();
  async check({ token }: { token: string; teamId?: string }): Promise<VercelTokenCheck> {
    this.calls.push(token);
    return this.verdicts.get(token) ?? 'ok';
  }
}

const freshToken = (): string => `vtok${randomBytes(12).toString('hex')}`;

describe('D#598 P8d-2: sealed Vercel connection', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let kek: KekSource;
  let validator: StubValidator;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  const fresh = (): void => {
    kek = fakeKekSource();
    validator = new StubValidator();
  };
  const ctxOf = (t: { accountId: string; userId: string }): VercelConnectionCtx => ({ pool: appUserPool, principal: t, kek, validator });
  const resolverOf = (log: string[] = []) => createSealedVercelCredentials({ pool: appUserPool, kek, log: (l) => log.push(l) });

  async function tablesContaining(needle: string): Promise<string[]> {
    const { rows: tables } = await admin.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
    const hits: string[] = [];
    for (const { table_name } of tables) {
      const { rows } = await admin.query<{ n: string }>(`SELECT count(*) AS n FROM "${table_name}" t WHERE t::text LIKE $1`, [`%${needle}%`]);
      if (Number(rows[0]!.n) > 0) hits.push(table_name);
    }
    return hits;
  }

  it('connect: the view is a tail only, the token is nowhere in the database, one audit row names the tail', async () => {
    fresh();
    const t = await seedAccountWithMember(admin, 'owner');
    const token = freshToken();
    const view = await connectVercel(ctxOf(t), { token });
    expect(Object.keys(view).sort()).toEqual(['connected_at', 'fingerprint', 'rejected_at', 'rotated_at', 'state', 'team_id']);
    expect(view.state).toBe('connected');
    expect(view.fingerprint).toMatch(/^[0-9a-f]{4}$/);
    expect(JSON.stringify(view)).not.toContain(token);
    expect(await tablesContaining(token)).toEqual([]);
    const audit = await admin.query(`SELECT action, payload FROM audit_log WHERE account_id = $1`, [t.accountId]);
    expect(audit.rows).toEqual([{ action: 'vercel_connection.connect', payload: { fingerprint: view.fingerprint, team_scoped: false } }]);
    expect(validator.calls).toEqual([token]);
    expect(await resolverOf().resolve(t.accountId)).toMatchObject({ status: 'ok', token });
  });

  it('connect: only an owner or admin; a member is refused before Vercel is asked or anything is stored', async () => {
    fresh();
    const member = await seedAccountWithMember(admin, 'member');
    await expect(connectVercel(ctxOf(member), { token: freshToken() })).rejects.toBeInstanceOf(ForbiddenError);
    expect(validator.calls).toEqual([]);
    expect((await admin.query('SELECT 1 FROM vercel_connections WHERE account_id = $1', [member.accountId])).rowCount).toBe(0);
    const admin1 = await seedAccountWithMember(admin, 'admin');
    expect((await connectVercel(ctxOf(admin1), { token: freshToken() })).state).toBe('connected');
  });

  it('connect: a refused or unproven token, a bad format, a bad team id and a second connect store nothing and use fixed codes', async () => {
    fresh();
    const t = await seedAccountWithMember(admin, 'owner');
    const bad = freshToken();
    validator.verdicts.set(bad, 'rejected');
    const err = await connectVercel(ctxOf(t), { token: bad }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VercelConnectionError);
    expect((err as VercelConnectionError).code).toBe('token_rejected');
    expect(String((err as Error).message)).not.toContain(bad);
    const slow = freshToken();
    validator.verdicts.set(slow, 'unreachable');
    await expect(connectVercel(ctxOf(t), { token: slow })).rejects.toMatchObject({ code: 'provider_unreachable' });
    await expect(connectVercel(ctxOf(t), { token: 'has space' })).rejects.toMatchObject({ code: 'invalid_token_format' });
    await expect(connectVercel(ctxOf(t), { token: '' })).rejects.toMatchObject({ code: 'invalid_token_format' });
    await expect(connectVercel(ctxOf(t), { token: freshToken(), teamId: 'not-a-team' })).rejects.toMatchObject({ code: 'invalid_team_id' });
    expect((await admin.query('SELECT 1 FROM vercel_connections WHERE account_id = $1', [t.accountId])).rowCount).toBe(0);
    expect(await getVercelConnection(ctxOf(t))).toMatchObject({ state: 'not_connected', fingerprint: null });

    await connectVercel(ctxOf(t), { token: freshToken(), teamId: 'team_abc123' });
    await expect(connectVercel(ctxOf(t), { token: freshToken() })).rejects.toMatchObject({ code: 'already_connected' });
    expect(await resolverOf().resolve(t.accountId)).toMatchObject({ status: 'ok', teamId: 'team_abc123' });
  });

  it('rotate: the new token replaces the old atomically under the same row; a refused new token leaves the old one in use; a rejected connection recovers', async () => {
    fresh();
    const t = await seedAccountWithMember(admin, 'owner');
    const first = freshToken();
    await connectVercel(ctxOf(t), { token: first });
    const idBefore = (await admin.query<{ id: string }>('SELECT id FROM vercel_connections WHERE account_id = $1', [t.accountId])).rows[0]!.id;

    const refused = freshToken();
    validator.verdicts.set(refused, 'rejected');
    await expect(rotateVercel(ctxOf(t), { token: refused })).rejects.toMatchObject({ code: 'token_rejected' });
    expect(await resolverOf().resolve(t.accountId)).toMatchObject({ status: 'ok', token: first });

    // a rejection recorded against the first token ...
    const r = resolverOf();
    const cred = await r.resolve(t.accountId);
    expect(cred.status).toBe('ok');
    await r.markRejected!(t.accountId, cred.status === 'ok' ? cred.ref : undefined);
    expect(await getVercelConnection(ctxOf(t))).toMatchObject({ state: 'rejected' });
    expect(await r.resolve(t.accountId)).toEqual({ status: 'unavailable' });

    // ... is cleared by a rotate to a token Vercel accepts
    const second = freshToken();
    const view = await rotateVercel(ctxOf(t), { token: second });
    expect(view).toMatchObject({ state: 'connected', rejected_at: null });
    expect(view.rotated_at).not.toBeNull();
    expect(view.fingerprint).toMatch(/^[0-9a-f]{4}$/);
    expect(await r.resolve(t.accountId)).toMatchObject({ status: 'ok', token: second });
    expect((await admin.query<{ id: string }>('SELECT id FROM vercel_connections WHERE account_id = $1', [t.accountId])).rows).toEqual([{ id: idBefore }]);
    expect(await tablesContaining(first)).toEqual([]);
    expect(await tablesContaining(second)).toEqual([]);
    const actions = (await admin.query<{ action: string }>(`SELECT action FROM audit_log WHERE account_id = $1 ORDER BY created_at`, [t.accountId])).rows.map((x) => x.action);
    expect(actions).toEqual(['vercel_connection.connect', 'vercel_connection.rotate']);
  });

  it('a rejection recorded for the old token never lands on a token rotated in meanwhile', async () => {
    fresh();
    const t = await seedAccountWithMember(admin, 'owner');
    await connectVercel(ctxOf(t), { token: freshToken() });
    const r = resolverOf();
    const old = await r.resolve(t.accountId);
    await rotateVercel(ctxOf(t), { token: freshToken() });
    await r.markRejected!(t.accountId, old.status === 'ok' ? old.ref : undefined);
    expect(await getVercelConnection(ctxOf(t))).toMatchObject({ state: 'connected' });
    await r.markRejected!(t.accountId, undefined);
    await r.markRejected!(t.accountId, "'; DROP TABLE vercel_connections; --");
    expect(await getVercelConnection(ctxOf(t))).toMatchObject({ state: 'connected' });
  });

  it('rotate and remove: nothing to act on is not_connected / not found; remove deletes the row and writes one audit row', async () => {
    fresh();
    const t = await seedAccountWithMember(admin, 'owner');
    await expect(rotateVercel(ctxOf(t), { token: freshToken() })).rejects.toMatchObject({ code: 'not_connected' });
    await expect(removeVercel(ctxOf(t))).rejects.toBeInstanceOf(NotFoundError);
    await connectVercel(ctxOf(t), { token: freshToken() });
    await removeVercel(ctxOf(t));
    expect((await admin.query('SELECT 1 FROM vercel_connections WHERE account_id = $1', [t.accountId])).rowCount).toBe(0);
    expect(await resolverOf().resolve(t.accountId)).toEqual({ status: 'unavailable' });
    const actions = (await admin.query<{ action: string }>(`SELECT action FROM audit_log WHERE account_id = $1 ORDER BY created_at`, [t.accountId])).rows.map((x) => x.action);
    expect(actions).toEqual(['vercel_connection.connect', 'vercel_connection.remove']);
    const member = await seedAccountWithMember(admin, 'member');
    await expect(removeVercel(ctxOf(member))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('tenancy: another account cannot read, resolve or see the connection, and a non-member reads nothing', async () => {
    fresh();
    const a = await seedAccountWithMember(admin, 'owner');
    const b = await seedAccountWithMember(admin, 'owner');
    await connectVercel(ctxOf(a), { token: freshToken() });
    expect(await resolverOf().resolve(b.accountId)).toEqual({ status: 'unavailable' });
    expect(await getVercelConnection(ctxOf(b))).toMatchObject({ state: 'not_connected' });
    await expect(getVercelConnection(ctxOf({ accountId: a.accountId, userId: b.userId }))).rejects.toBeInstanceOf(NotFoundError);
    // b's tenant context cannot see a's row even by asking for it
    const seen = await withTenant(appUserPool, b.accountId, b.userId, async (c) => (await c.query('SELECT 1 FROM vercel_connections WHERE account_id = $1', [a.accountId])).rowCount);
    expect(seen).toBe(0);
  });

  it('fails closed: a KEK version that is not configured, a tampered row and a ciphertext moved to another account are all unavailable, logged by a fixed code', async () => {
    fresh();
    const a = await seedAccountWithMember(admin, 'owner');
    const b = await seedAccountWithMember(admin, 'owner');
    const tokenA = freshToken();
    await connectVercel(ctxOf(a), { token: tokenA });
    await connectVercel(ctxOf(b), { token: freshToken() });
    const log: string[] = [];
    const r = resolverOf(log);
    expect(await r.resolve(a.accountId)).toMatchObject({ status: 'ok' });

    // the row says it was sealed under version 2, which this platform has no key for
    await admin.query('UPDATE vercel_connections SET kek_version = 2 WHERE account_id = $1', [a.accountId]);
    expect(await r.resolve(a.accountId)).toEqual({ status: 'unavailable' });
    await admin.query('UPDATE vercel_connections SET kek_version = 1 WHERE account_id = $1', [a.accountId]);
    expect(await r.resolve(a.accountId)).toMatchObject({ status: 'ok' });

    // a flipped byte
    await admin.query(`UPDATE vercel_connections SET token_ciphertext = set_byte(token_ciphertext, 0, get_byte(token_ciphertext, 0) # 255) WHERE account_id = $1`, [a.accountId]);
    expect(await r.resolve(a.accountId)).toEqual({ status: 'unavailable' });

    // a's sealed columns copied onto b's row
    await admin.query('DELETE FROM vercel_connections WHERE account_id = $1', [a.accountId]);
    await connectVercel(ctxOf(a), { token: tokenA });
    await admin.query(
      `UPDATE vercel_connections b SET token_ciphertext = a.token_ciphertext, token_nonce = a.token_nonce, wrapped_dek = a.wrapped_dek, kek_version = a.kek_version
         FROM vercel_connections a WHERE a.account_id = $1 AND b.account_id = $2`,
      [a.accountId, b.accountId],
    );
    expect(await r.resolve(b.accountId)).toEqual({ status: 'unavailable' });
    expect(log.length).toBeGreaterThanOrEqual(3);
    for (const line of log) {
      expect(line).toMatch(/^\{"event":"vercel_credentials\.unavailable","code":"(open_failed|read_error)"\}$/);
      expect(line).not.toContain(tokenA);
    }
  });

  it('key versions: a row sealed under v1 still opens after the platform moves to v2, and a rotate re-seals under v2', async () => {
    fresh();
    const versioned = fakeVersionedKek();
    kek = versioned.source;
    const t = await seedAccountWithMember(admin, 'owner');
    const first = freshToken();
    await connectVercel(ctxOf(t), { token: first });
    const version = async () => (await admin.query<{ kek_version: number }>('SELECT kek_version FROM vercel_connections WHERE account_id = $1', [t.accountId])).rows[0]!.kek_version;
    expect(await version()).toBe(1);
    versioned.setCurrent(2);
    expect(await resolverOf().resolve(t.accountId)).toMatchObject({ status: 'ok', token: first });
    expect(await version()).toBe(1);
    const second = freshToken();
    await rotateVercel(ctxOf(t), { token: second });
    expect(await version()).toBe(2);
    expect(await resolverOf().resolve(t.accountId)).toMatchObject({ status: 'ok', token: second });
    // the old version's key is gone from the platform: the v2 row still opens, a v1 row would not
    await admin.query('UPDATE vercel_connections SET kek_version = 1 WHERE account_id = $1', [t.accountId]);
    expect(await resolverOf().resolve(t.accountId)).toEqual({ status: 'unavailable' });
  });

  it('a rotate whose team scope changed since the check is not applied', async () => {
    fresh();
    const t = await seedAccountWithMember(admin, 'owner');
    await connectVercel(ctxOf(t), { token: freshToken(), teamId: 'team_one1' });
    const racing: VercelTokenValidator = {
      async check() {
        await admin.query(`UPDATE vercel_connections SET team_id = 'team_two2' WHERE account_id = $1`, [t.accountId]);
        return 'ok';
      },
    };
    const before = await admin.query('SELECT token_nonce FROM vercel_connections WHERE account_id = $1', [t.accountId]);
    await expect(rotateVercel({ ...ctxOf(t), validator: racing }, { token: freshToken() })).rejects.toMatchObject({ code: 'provider_unreachable' });
    expect((await admin.query('SELECT token_nonce FROM vercel_connections WHERE account_id = $1', [t.accountId])).rows).toEqual(before.rows);
  });

  it('configured follows the platform key: unset means not configured, and a read with no key is unavailable', async () => {
    fresh();
    const none: KekSource = { currentVersion: () => 1, keyFor: () => { throw new Error('FX_KEK_V1 is not set'); } };
    const r = createSealedVercelCredentials({ pool: appUserPool, kek: none, log: () => undefined });
    expect(r.configured).toBe(false);
    expect(resolverOf().configured).toBe(true);
    const t = await seedAccountWithMember(admin, 'owner');
    await connectVercel(ctxOf(t), { token: freshToken() });
    expect(await r.resolve(t.accountId)).toEqual({ status: 'unavailable' });
  });
});

describe('D#598 P8d-2: the connect-time token check against a strict Vercel stand-in', () => {
  const fake = new FakeVercel();
  const check = (token: string, teamId?: string, opts: { timeoutMs?: number; fetch?: typeof fetch } = {}) =>
    createVercelTokenValidator({ fetch: opts.fetch ?? fake.fetchImpl(), ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) }).check({ token, ...(teamId !== undefined ? { teamId } : {}) });

  it('200 is ok; an unknown or revoked token, or a team the token is not scoped to, is rejected; the User-Agent and a bearer header are always sent', async () => {
    fake.connect('acct-a');
    fake.connect('acct-t', { teamId: 'team_x1' });
    expect(await check(fake.tokenOf('acct-a'))).toBe('ok');
    expect(await check('vtok_unknown')).toBe('rejected');
    expect(await check(fake.tokenOf('acct-t'))).toBe('rejected');
    expect(await check(fake.tokenOf('acct-t'), 'team_x1')).toBe('ok');
    fake.revoke('acct-a');
    expect(await check(fake.tokenOf('acct-a'))).toBe('rejected');
    expect(fake.calls.every((c) => c.userAgent !== null)).toBe(true);
  });

  it('a server error, a rate limit, a dropped connection and a call that never answers are unreachable, never rejected', async () => {
    fake.connect('acct-b');
    for (const mode of ['http_500', 'http_429', 'throw'] as const) {
      fake.failNext(mode);
      expect(await check(fake.tokenOf('acct-b'))).toBe('unreachable');
    }
    fake.failNext('hang');
    expect(await check(fake.tokenOf('acct-b'), undefined, { timeoutMs: 50 })).toBe('unreachable');
  });

  it('never follows a redirect (the token would travel with it)', async () => {
    let init: RequestInit | undefined;
    const spy = (async (_u: unknown, i?: RequestInit) => {
      init = i;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    await check('vtok_x', undefined, { fetch: spy });
    expect(init?.redirect).toBe('error');
    expect(init?.method).toBe('GET');
  });
});

describe('D#598 P8d-2: copy', () => {
  it('every state has a headline and a detail with the tail filled in, and no placeholder or token text is left over', () => {
    expect(vercelStateCopy('not_connected', null)).toMatchObject({ headline: 'Vercel is not connected', action: 'Connect Vercel', secondaryAction: null });
    expect(vercelStateCopy('connected', 'ab12').detail).toContain('fingerprint ab12');
    expect(vercelStateCopy('rejected', 'ab12')).toMatchObject({ headline: 'Vercel is not accepting your token', action: 'Replace token' });
    for (const s of ['not_connected', 'connected', 'rejected'] as const) {
      const c = vercelStateCopy(s, 'ab12');
      expect(c.detail).not.toMatch(/[{}]|undefined|null/);
    }
    for (const line of [...Object.values(VERCEL_ERROR_COPY), ...Object.values(VERCEL_ROTATE_COPY)]) expect(line.length).toBeGreaterThan(0);
    expect(VERCEL_ROTATE_COPY).toEqual({ prompt: expect.stringContaining('current one stays in use'), success: 'Token replaced.', disconnected: 'Vercel is disconnected.' });
    for (const line of [...Object.values(VERCEL_ERROR_COPY), ...Object.values(VERCEL_ROTATE_COPY)]) expect(line).not.toMatch(/[{}]|undefined|null/);
  });
});
