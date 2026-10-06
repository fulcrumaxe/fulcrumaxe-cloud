import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import {
  LEASE_TTL_MS,
  StreamLimitError,
  acquireLease,
  tokenStreamsPerTenant,
  recheckSessionMembership,
  recheckToken,
  releaseLease,
  type LeaseSubject,
} from '../src/sse/leases.js';
import { generateToken, displayHint } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

/** D#31 API-5 criterion 5: stream caps and leases, against the real 0639 table and its RLS. */
describe('stream leases (D#31 API-5)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let app: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    app = createPool(process.env.API_DATABASE_URL_APP_USER!);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await app.end();
  });

  async function token(accountId: string, userId: string, opts: { scopes?: string[]; expires?: string } = {}): Promise<{ id: string; plaintext: string }> {
    const plaintext = generateToken();
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + $6::interval) RETURNING id`,
      [accountId, userId, hashToken(plaintext), displayHint(plaintext), opts.scopes ?? ['read'], opts.expires ?? '90 days'],
    );
    return { id: rows[0]!.id, plaintext };
  }

  const sessionSubject = (accountId: string, userId: string): LeaseSubject => ({ kind: 'session', accountId, principalKey: userId });
  const expiry = async (leaseId: string): Promise<Date> =>
    (await admin.query<{ expires_at: Date }>('SELECT expires_at FROM stream_leases WHERE id = $1', [leaseId])).rows[0]!.expires_at;

  it('session caps: 6 per user, then a 7th is a StreamLimitError (429 stream_limit); a release frees a slot', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const subject = sessionSubject(accountId, userId);
    const now = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await acquireLease(app, subject, now));
    const err = await acquireLease(app, subject, now).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StreamLimitError);
    expect(err).toMatchObject({ status: 429, code: 'stream_limit' });
    await releaseLease(app, subject, ids[0]!);
    await expect(acquireLease(app, subject, now)).resolves.toEqual(expect.any(String));
  });

  it('session caps: 25 per account across users', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const now = Date.now();
    for (let i = 0; i < 24; i++) {
      await acquireLease(app, sessionSubject(accountId, randomUUID()), now);
    }
    await acquireLease(app, sessionSubject(accountId, userId), now); // the 25th
    await expect(acquireLease(app, sessionSubject(accountId, randomUUID()), now)).rejects.toBeInstanceOf(StreamLimitError);
  });

  it('token caps follow the plan data', async () => {
    for (const plan of ['starter', 'team', 'scale'] as const) {
      const cap = tokenStreamsPerTenant(plan);
      const { accountId, userId } = await seedAccountWithMember(admin, { plan });
      const t = await token(accountId, userId);
      const subject: LeaseSubject = { kind: 'token', accountId, principalKey: t.id };
      const now = Date.now();
      for (let i = 0; i < cap; i++) await acquireLease(app, subject, now);
      await expect(acquireLease(app, subject, now), plan).rejects.toBeInstanceOf(StreamLimitError);
    }
  });

  it('a lease expires 90 s after its last renewal and its slot is then reusable', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin, { plan: 'starter' });
    const t = await token(accountId, userId);
    const subject: LeaseSubject = { kind: 'token', accountId, principalKey: t.id };
    const now = Date.now();
    for (let i = 0; i < tokenStreamsPerTenant('starter'); i++) await acquireLease(app, subject, now);
    await expect(acquireLease(app, subject, now + LEASE_TTL_MS - 1)).rejects.toBeInstanceOf(StreamLimitError);
    await expect(acquireLease(app, subject, now + LEASE_TTL_MS)).resolves.toEqual(expect.any(String));
  });

  it('renewal pushes expiry to now + 90 s for a current member, and keeps the slot past the original expiry', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const subject = sessionSubject(accountId, userId);
    const t0 = Date.now();
    const lease = await acquireLease(app, subject, t0);
    expect((await expiry(lease)).getTime()).toBe(t0 + LEASE_TTL_MS);
    const out = await recheckSessionMembership(app, subject, lease, t0 + 60_000);
    expect(out).toMatchObject({ status: 'ok', renewed: true, role: 'member' });
    expect((await expiry(lease)).getTime()).toBe(t0 + 60_000 + LEASE_TTL_MS);
    // A "check only" re-check (JSON mode) does not touch the lease.
    await recheckSessionMembership(app, subject, null, t0 + 70_000);
    expect((await expiry(lease)).getTime()).toBe(t0 + 60_000 + LEASE_TTL_MS);
  });

  it('a removed member is revoked and the lease is NOT renewed', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const subject = sessionSubject(accountId, userId);
    const t0 = Date.now();
    const lease = await acquireLease(app, subject, t0);
    await admin.query('DELETE FROM account_members WHERE account_id = $1 AND user_id = $2', [accountId, userId]);
    const out = await recheckSessionMembership(app, subject, lease, t0 + 60_000);
    expect(out).toEqual({ status: 'revoked', reason: 'membership' });
    expect((await expiry(lease)).getTime()).toBe(t0 + LEASE_TTL_MS);
  });

  it('token re-check: ok + renewed while valid; revoked once the token is revoked, expired, loses its read scope, or its creator leaves', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const t0 = Date.now();

    const good = await token(accountId, userId);
    const goodSubject: LeaseSubject = { kind: 'token', accountId, principalKey: good.id };
    const lease = await acquireLease(app, goodSubject, t0);
    expect(await recheckToken(app, goodSubject, hashToken(good.plaintext), lease, t0 + 60_000)).toMatchObject({ status: 'ok', renewed: true });
    expect((await expiry(lease)).getTime()).toBe(t0 + 60_000 + LEASE_TTL_MS);

    const revokedTok = await token(accountId, userId);
    await admin.query('UPDATE api_tokens SET revoked_at = now() WHERE id = $1', [revokedTok.id]);
    expect(await recheckToken(app, { kind: 'token', accountId, principalKey: revokedTok.id }, hashToken(revokedTok.plaintext), null, t0)).toEqual({ status: 'revoked', reason: 'token' });

    const expired = await token(accountId, userId, { expires: '1 hour' });
    expect(await recheckToken(app, { kind: 'token', accountId, principalKey: expired.id }, hashToken(expired.plaintext), null, t0 + 2 * 60 * 60 * 1000)).toEqual({ status: 'revoked', reason: 'token' });

    const noRead = await token(accountId, userId, { scopes: ['audit:read'] });
    expect(await recheckToken(app, { kind: 'token', accountId, principalKey: noRead.id }, hashToken(noRead.plaintext), null, t0)).toEqual({ status: 'revoked', reason: 'token' });

    const otherUser = randomUUID();
    await seedUser(admin, otherUser);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [accountId, otherUser]);
    const orphan = await token(accountId, otherUser);
    await admin.query('DELETE FROM account_members WHERE account_id = $1 AND user_id = $2', [accountId, otherUser]);
    expect(await recheckToken(app, { kind: 'token', accountId, principalKey: orphan.id }, hashToken(orphan.plaintext), null, t0)).toEqual({ status: 'revoked', reason: 'token' });
  });

  it('tenancy: one account\'s cap does not touch another, and another account cannot renew or release a lease it does not own', async () => {
    const a = await seedAccountWithMember(admin, { plan: 'starter' });
    const b = await seedAccountWithMember(admin, { plan: 'starter' });
    const ta = await token(a.accountId, a.userId);
    const tb = await token(b.accountId, b.userId);
    const now = Date.now();
    const aSub: LeaseSubject = { kind: 'token', accountId: a.accountId, principalKey: ta.id };
    for (let i = 0; i < tokenStreamsPerTenant('starter'); i++) await acquireLease(app, aSub, now);
    await expect(acquireLease(app, aSub, now)).rejects.toBeInstanceOf(StreamLimitError);
    await expect(acquireLease(app, { kind: 'token', accountId: b.accountId, principalKey: tb.id }, now)).resolves.toEqual(expect.any(String));

    const bLease = await acquireLease(app, sessionSubject(b.accountId, b.userId), now);
    const before = await expiry(bLease);
    await recheckSessionMembership(app, sessionSubject(a.accountId, a.userId), bLease, now + 60_000);
    await releaseLease(app, sessionSubject(a.accountId, a.userId), bLease);
    expect(await expiry(bLease)).toEqual(before);
    // Unfiltered DML under A's tenant context reaches none of B's rows.
    await withTenant(app, a.accountId, (c) => c.query('DELETE FROM stream_leases'));
    expect(await expiry(bLease)).toEqual(before);
  });

  it('a plan name that is only an inherited Object property is refused, not read as a cap', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const t = await token(accountId, userId);
    // accounts.plan is constrained in the schema, so exercise the guard through a stubbed pool row.
    const stub = {
      connect: async () => ({
        query: async (sql: string) => {
          if (/count\(\*\) FILTER/.test(sql)) return { rows: [{ mine: 0, total: 0, plan: 'constructor' }] };
          return { rows: [] };
        },
        release: () => {},
      }),
    } as unknown as Pool;
    await expect(acquireLease(stub, { kind: 'token', accountId, principalKey: t.id }, Date.now())).rejects.toThrow(/no resolvable plan/);
  });
});
