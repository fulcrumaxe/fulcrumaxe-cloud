import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { sha256Hex, withIdempotency, type IdempotencyRequest } from '../src/idempotency.js';
import {
  ApiError,
  IdempotencyInProgressError,
  IdempotencyKeyReusedError,
  IdempotencyNotSupportedError,
} from '../src/errors.js';
import { seedAccount } from './helpers/seed.js';

/** D#31 API-1 criterion 7 -- a test-only entry, not anything the registry declares. */
function baseReq(overrides: Partial<IdempotencyRequest> = {}): IdempotencyRequest {
  return {
    accountId: overrides.accountId!,
    principalId: overrides.principalId ?? `session:${randomUUID()}`,
    method: 'POST',
    path: '/api/v1/test-only-entry',
    mode: 'optional',
    headerKey: null,
    rawBody: '{}',
    ...overrides,
  };
}

describe('withIdempotency', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  it('same key, same body, same principal, after the first finished -> replays the identical body', async () => {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    const principalId = `session:${randomUUID()}`;
    const req = baseReq({ accountId, principalId, mode: 'required', headerKey: 'k-replay', rawBody: '{"a":1}' });

    const first = await withIdempotency(appUserPool, req, async () => ({
      status: 201,
      body: { created: true, n: Math.random() },
    }));
    expect(first.replayed).toBe(false);

    const second = await withIdempotency(appUserPool, req, async () => {
      throw new Error('must not run again on replay');
    });
    expect(second.replayed).toBe(true);
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
  });

  it('same key, a different body -> IdempotencyKeyReusedError (422)', async () => {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    const principalId = `session:${randomUUID()}`;
    const reqA = baseReq({ accountId, principalId, headerKey: 'k-diff-body', rawBody: '{"a":1}' });
    const reqB = baseReq({ accountId, principalId, headerKey: 'k-diff-body', rawBody: '{"a":2}' });

    await withIdempotency(appUserPool, reqA, async () => ({ status: 200, body: { ok: true } }));

    await expect(
      withIdempotency(appUserPool, reqB, async () => {
        throw new Error('must not run on a reused key');
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  it('a request while the first is still in flight -> IdempotencyInProgressError (409)', async () => {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    const principalId = `session:${randomUUID()}`;
    const req = baseReq({ accountId, principalId, headerKey: 'k-in-flight', rawBody: '{}' });

    let runEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      runEntered = resolve;
    });
    let releaseRun!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });

    // The claim commits (its own short transaction) strictly before `run`
    // is ever invoked -- see idempotency.ts's `withIdempotency` -- so
    // waiting on `entered` guarantees the second call below observes an
    // already-committed `in_progress` row, with no race.
    const first = withIdempotency(appUserPool, req, async () => {
      runEntered();
      await released;
      return { status: 200, body: { ok: true } };
    });

    await entered;
    await expect(
      withIdempotency(appUserPool, req, async () => {
        throw new Error('must not run while the first request is in flight');
      }),
    ).rejects.toBeInstanceOf(IdempotencyInProgressError);

    releaseRun();
    await first;
  });

  it('the same key and body from a DIFFERENT principal (a member after an admin) -> 422, and the admin response is never returned', async () => {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    const adminPrincipal = `session:${randomUUID()}`;
    const memberPrincipal = `session:${randomUUID()}`;
    const reqAdmin = baseReq({ accountId, principalId: adminPrincipal, headerKey: 'k-cross-principal', rawBody: '{}' });
    const reqMember = baseReq({ accountId, principalId: memberPrincipal, headerKey: 'k-cross-principal', rawBody: '{}' });

    const adminResult = await withIdempotency(appUserPool, reqAdmin, async () => ({
      status: 200,
      body: { secret: 'only the admin should ever see this' },
    }));
    expect(adminResult.replayed).toBe(false);

    let caught: unknown;
    try {
      await withIdempotency(appUserPool, reqMember, async () => {
        throw new Error('must not run -- the key is already claimed by a different principal');
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IdempotencyKeyReusedError);
    // The rejection carries no response body at all -- the admin's stored
    // response never crosses into anything the member-principal caller sees.
    expect(JSON.stringify(caught)).not.toContain('only the admin should ever see this');
  });

  /**
   * Fix round item 1 (CWE-706 / OWASP A04, security review of this PR).
   * Fails on 98c1182 with: the second call resolves 200 `replayed: true`
   * with `/pa`'s body instead of rejecting -- the completed-branch
   * comparison only checked `principalId` and the body hash, never
   * `path`.
   */
  it('same key, same body, same principal, but a DIFFERENT request path -> IdempotencyKeyReusedError (422), and the second route never sees the earlier response', async () => {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    const principalId = `session:${randomUUID()}`;
    const reqA = baseReq({ accountId, principalId, headerKey: 'k-diff-path', rawBody: '{}', path: '/api/v1/pa' });
    const reqB = baseReq({ accountId, principalId, headerKey: 'k-diff-path', rawBody: '{}', path: '/api/v1/pb' });

    const first = await withIdempotency(appUserPool, reqA, async () => ({
      status: 200,
      body: { route: 'pa' },
    }));
    expect(first.replayed).toBe(false);

    await expect(
      withIdempotency(appUserPool, reqB, async () => {
        throw new Error('must not run -- the key was claimed for a different path');
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  /**
   * Fix round item 1: the same route TEMPLATE (`handler.ts` used to pass
   * `entry.path`, the template) with two different concrete `{id}`
   * values must NOT be treated as the same request. Fails on 98c1182 the
   * same way the different-route case above does.
   */
  it('same key and body on the same route TEMPLATE but a different concrete {id} -> IdempotencyKeyReusedError (422)', async () => {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    const principalId = `session:${randomUUID()}`;
    const reqA = baseReq({
      accountId,
      principalId,
      headerKey: 'k-diff-id',
      rawBody: '{}',
      path: '/api/v1/things/aaa/go',
    });
    const reqB = baseReq({
      accountId,
      principalId,
      headerKey: 'k-diff-id',
      rawBody: '{}',
      path: '/api/v1/things/bbb/go',
    });

    const first = await withIdempotency(appUserPool, reqA, async () => ({ status: 200, body: { id: 'aaa' } }));
    expect(first.replayed).toBe(false);

    await expect(
      withIdempotency(appUserPool, reqB, async () => {
        throw new Error('must not run -- the concrete path differs even though the route template is the same');
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  /** Fix round item 1: `method` was written on claim and never compared either. */
  it('same key, same body and path, but a DIFFERENT method -> IdempotencyKeyReusedError (422)', async () => {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    const principalId = `session:${randomUUID()}`;
    const reqA = baseReq({ accountId, principalId, headerKey: 'k-diff-method', rawBody: '{}', method: 'POST' });
    const reqB = baseReq({ accountId, principalId, headerKey: 'k-diff-method', rawBody: '{}', method: 'DELETE' });

    const first = await withIdempotency(appUserPool, reqA, async () => ({ status: 200, body: { ok: true } }));
    expect(first.replayed).toBe(false);

    await expect(
      withIdempotency(appUserPool, reqB, async () => {
        throw new Error('must not run -- the method differs');
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  it("a 'never' route rejects the header outright -> IdempotencyNotSupportedError (400)", async () => {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    const req = baseReq({ accountId, mode: 'never', headerKey: 'k-never', rawBody: '{}' });

    await expect(
      withIdempotency(appUserPool, req, async () => {
        throw new Error('must not run -- never routes reject the header before doing any work');
      }),
    ).rejects.toBeInstanceOf(IdempotencyNotSupportedError);
  });

  it('a never route with NO header runs normally (never just means "reject the header if sent")', async () => {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    const req = baseReq({ accountId, mode: 'never', headerKey: null, rawBody: '{}' });

    const result = await withIdempotency(appUserPool, req, async () => ({ status: 200, body: { ok: true } }));
    expect(result.replayed).toBe(false);
    expect(result.body).toEqual({ ok: true });
  });

  it('the same key reused in a DIFFERENT account runs fresh (RLS, not application code, makes this true)', async () => {
    const accountA = randomUUID();
    const accountB = randomUUID();
    await seedAccount(admin, accountA);
    await seedAccount(admin, accountB);
    const key = 'k-shared-across-accounts';

    const inA = await withIdempotency(
      appUserPool,
      baseReq({ accountId: accountA, headerKey: key, rawBody: '{}' }),
      async () => ({ status: 200, body: { account: 'A' } }),
    );
    expect(inA.replayed).toBe(false);

    const inB = await withIdempotency(
      appUserPool,
      baseReq({ accountId: accountB, headerKey: key, rawBody: '{}' }),
      async () => ({ status: 200, body: { account: 'B' } }),
    );
    expect(inB.replayed).toBe(false);
    expect(inB.body).toEqual({ account: 'B' });
  });

  /**
   * Fix round item 2 (CWE-324, security review of this PR). Fails on
   * 98c1182 with `replayed: true` and the stale `{ n: 1 }` body --
   * `expires_at` was written but never read back, so a completed key
   * replayed forever.
   */
  it('an EXPIRED completed key runs fresh, not a stale replay', async () => {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    const principalId = `session:${randomUUID()}`;
    const req = baseReq({ accountId, principalId, headerKey: 'k-expired-completed', rawBody: '{}' });

    const first = await withIdempotency(appUserPool, req, async () => ({ status: 200, body: { n: 1 } }));
    expect(first.replayed).toBe(false);

    await admin.query(`UPDATE idempotency_keys SET expires_at = now() - interval '1 day' WHERE key = $1`, [
      'k-expired-completed',
    ]);

    const second = await withIdempotency(appUserPool, req, async () => ({ status: 200, body: { n: 2 } }));
    expect(second.replayed).toBe(false);
    expect(second.body).toEqual({ n: 2 });
  });

  /**
   * Fix round item 2: a worker that crashed before its `catch`-path
   * release ran left a permanently stuck `in_progress` row before this
   * fix -- the conflict lookup had no `expires_at` filter, so it
   * returned 409 forever. Fails on 98c1182 with `IdempotencyInProgressError`
   * instead of a fresh run.
   */
  it('an EXPIRED in_progress row (simulating a crashed worker that never released it) can be re-claimed', async () => {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    const principalId = `session:${randomUUID()}`;
    const req = baseReq({ accountId, principalId, headerKey: 'k-expired-in-progress', rawBody: '{}' });

    await admin.query(
      `INSERT INTO idempotency_keys (account_id, key, principal_id, method, path, request_sha256, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'in_progress', now() - interval '1 day')`,
      [accountId, req.headerKey, principalId, req.method, req.path, sha256Hex(req.rawBody)],
    );

    const result = await withIdempotency(appUserPool, req, async () => ({ status: 200, body: { recovered: true } }));
    expect(result.replayed).toBe(false);
    expect(result.body).toEqual({ recovered: true });
  });

  it('an UNEXPIRED in_progress row still gives IdempotencyInProgressError (409)', async () => {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    const principalId = `session:${randomUUID()}`;
    const req = baseReq({ accountId, principalId, headerKey: 'k-unexpired-in-progress', rawBody: '{}' });

    await admin.query(
      `INSERT INTO idempotency_keys (account_id, key, principal_id, method, path, request_sha256, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'in_progress', now() + interval '1 hour')`,
      [accountId, req.headerKey, principalId, req.method, req.path, sha256Hex(req.rawBody)],
    );

    await expect(
      withIdempotency(appUserPool, req, async () => {
        throw new Error('must not run -- an unexpired in_progress row still blocks a retry');
      }),
    ).rejects.toBeInstanceOf(IdempotencyInProgressError);
  });

  /**
   * Fix round item 5 (CWE-400, security review of this PR: "an
   * 8,000-character key was accepted and stored in `text`"). Fails on
   * 98c1182 because no cap exists at all -- the oversized key is
   * accepted and `run` executes.
   */
  it('an Idempotency-Key over 255 characters -> ApiError 400 invalid_request, and the handler never runs', async () => {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    const req = baseReq({ accountId, headerKey: 'k'.repeat(256), rawBody: '{}' });

    let caught: unknown;
    try {
      await withIdempotency(appUserPool, req, async () => {
        throw new Error('must not run -- the key exceeds the length cap');
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(400);
    expect((caught as ApiError).code).toBe('invalid_request');
  });

  it('an Idempotency-Key with a non-printable-ASCII character -> ApiError 400 invalid_request', async () => {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    const req = baseReq({ accountId, headerKey: 'k-bad-\u0007-char', rawBody: '{}' });

    let caught: unknown;
    try {
      await withIdempotency(appUserPool, req, async () => {
        throw new Error('must not run -- the key contains a non-printable-ASCII character');
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(400);
    expect((caught as ApiError).code).toBe('invalid_request');
  });

  /**
   * Fix round item 6 (security review of this PR): "If `run()` succeeds
   * but `completeIdempotencyKey` throws, the `catch` releases the key
   * and a retry runs the work again." A `BigInt` in the returned body
   * makes `completeIdempotencyKey`'s own `JSON.stringify` throw --
   * exercising the real "run succeeded, the save failed" path without
   * mocking the DB. Fails on 98c1182: the second call resolves instead
   * of rejecting, because the first call's `catch` released the key,
   * so the retry claims it fresh and runs the handler a second time.
   */
  it('run() succeeds but saving the result fails -- the key stays in_progress so a retry gets 409, not a second run', async () => {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    const principalId = `session:${randomUUID()}`;
    const req = baseReq({ accountId, principalId, headerKey: 'k-complete-fails', rawBody: '{}' });
    let calls = 0;
    const unserializableBody = { n: 1n } as unknown as Record<string, unknown>;

    await expect(
      withIdempotency(appUserPool, req, async () => {
        calls++;
        return { status: 200, body: unserializableBody };
      }),
    ).rejects.toThrow(TypeError);
    expect(calls).toBe(1);

    await expect(
      withIdempotency(appUserPool, req, async () => {
        calls++;
        throw new Error('must not run again -- a completion-write failure must not release the key');
      }),
    ).rejects.toBeInstanceOf(IdempotencyInProgressError);
    expect(calls).toBe(1);
  });
});
