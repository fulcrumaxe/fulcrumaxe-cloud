import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { ForbiddenError } from '@fx/core/src/tenancy/errors.js';
import { connect } from '../src/connect.js';
import { remove } from '../src/remove.js';
import { getStatus } from '../src/summary.js';
import { test as testConnection } from '../src/validate.js';
import { markBroken } from '../src/markBroken.js';
import { InvalidModelKeyError } from '../src/errors.js';
import { fetchValidationHttpClient } from '../src/httpClient.js';
import { fakeHttpClient } from './helpers/fakeHttpClient.js';
import { fakeKekSource } from './helpers/fakeKek.js';
import { seedAccountWithMember } from './helpers/seed.js';
import { ctxFactory } from './helpers/ctx.js';

describe('connect / test / remove (criteria 1, 3, 4, 6)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let ctx: ReturnType<typeof ctxFactory>;

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

  it('criterion 3: an ok validation stores the connection as status=ok', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin, 'owner');
    const client = fakeHttpClient({ kind: 'ok' });
    const status = await connect(ctx({ accountId, userId }, client, fakeKekSource()), {
      provider: 'ai_gateway',
      key: 'sk-fake-ok',
    });
    expect(status.status).toBe('ok');
    expect(status.provider).toBe('ai_gateway');
    expect(status.fingerprint).toMatch(/^[0-9a-f]{4}$/);
    expect(status.last_validated_at).not.toBeNull();
    expect(client.calls).toHaveLength(1);
  });

  it('criterion 3: a rejected (401/403) key stores nothing at all', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin, 'owner');
    const client = fakeHttpClient({ kind: 'rejected', code: '401', message: 'ai_gateway: key rejected (HTTP 401)' });
    await expect(
      connect(ctx({ accountId, userId }, client, fakeKekSource()), { provider: 'ai_gateway', key: 'sk-fake-bad' }),
    ).rejects.toThrow(InvalidModelKeyError);

    const { rows } = await admin.query('SELECT * FROM model_connections WHERE account_id = $1', [accountId]);
    expect(rows).toHaveLength(0);
  });

  it('criterion 3: a network error stores the connection as unvalidated, not usable', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin, 'owner');
    const client = fakeHttpClient({ kind: 'network_error', code: 'timeout', message: 'no response' });
    const status = await connect(ctx({ accountId, userId }, client, fakeKekSource()), {
      provider: 'ai_gateway',
      key: 'sk-fake-flaky',
    });
    expect(status.status).toBe('unvalidated');
    expect(status.last_error_code).toBe('timeout');
  });

  it('criterion 4: getStatus() never carries the key, ciphertext, nonce or wrapped DEK', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin, 'owner');
    const plaintextKey = 'sk-fake-should-never-appear';
    const status = await connect(ctx({ accountId, userId }, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), {
      provider: 'ai_gateway',
      key: plaintextKey,
    });
    expect(Object.keys(status).sort()).toEqual(
      ['fingerprint', 'last_error_code', 'last_validated_at', 'provider', 'status'].sort(),
    );
    expect(JSON.stringify(status)).not.toContain(plaintextKey);

    const fetched = await getStatus(ctx({ accountId, userId }, fakeHttpClient({ kind: 'ok' }), fakeKekSource()));
    expect(fetched).not.toBeNull();
    expect(Object.keys(fetched!).sort()).toEqual(
      ['fingerprint', 'last_error_code', 'last_validated_at', 'provider', 'status'].sort(),
    );
    expect(JSON.stringify(fetched)).not.toContain(plaintextKey);
  });

  it('criterion 1: anthropic is rejected while the feature flag is off, and stores nothing', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin, 'owner');
    const client = fakeHttpClient({ kind: 'ok' });
    await expect(
      connect(ctx({ accountId, userId }, client, fakeKekSource()), { provider: 'anthropic', key: 'sk-ant-fake' }),
    ).rejects.toThrow(InvalidModelKeyError);
    expect(client.calls).toHaveLength(0);
    const { rows } = await admin.query('SELECT * FROM model_connections WHERE account_id = $1', [accountId]);
    expect(rows).toHaveLength(0);
  });

  it('criterion 6: a member (not owner/admin) cannot connect, and the HTTP client is never called', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin, 'member');
    const client = fakeHttpClient({ kind: 'ok' });
    await expect(
      connect(ctx({ accountId, userId }, client, fakeKekSource()), { provider: 'ai_gateway', key: 'sk-fake' }),
    ).rejects.toThrow(ForbiddenError);
    expect(client.calls).toHaveLength(0);
  });

  it('criterion 6: an admin (not just an owner) can connect', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin, 'admin');
    const status = await connect(ctx({ accountId, userId }, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), {
      provider: 'ai_gateway',
      key: 'sk-fake',
    });
    expect(status.status).toBe('ok');
  });

  it('criterion 6: connect() again rotates the existing row in place (never a second row) and resets validation', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin, 'owner');
    const first = await connect(ctx({ accountId, userId }, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), {
      provider: 'ai_gateway',
      key: 'sk-fake-first',
    });
    const second = await connect(ctx({ accountId, userId }, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), {
      provider: 'ai_gateway',
      key: 'sk-fake-second',
    });

    expect(second.fingerprint).not.toBe(first.fingerprint);
    const { rows } = await admin.query('SELECT id FROM model_connections WHERE account_id = $1', [accountId]);
    expect(rows).toHaveLength(1);
  });

  it('criterion 6: a member cannot remove, and the row survives', async () => {
    const { accountId, userId: ownerId } = await seedAccountWithMember(admin, 'owner');
    await connect(ctx({ accountId, userId: ownerId }, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), {
      provider: 'ai_gateway',
      key: 'sk-fake',
    });

    const memberUserId = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [memberUserId, `${memberUserId}@example.test`]);
    await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')", [
      accountId,
      memberUserId,
    ]);

    await expect(
      remove(ctx({ accountId, userId: memberUserId }, fakeHttpClient({ kind: 'ok' }), fakeKekSource())),
    ).rejects.toThrow(ForbiddenError);
    const { rows } = await admin.query('SELECT id FROM model_connections WHERE account_id = $1', [accountId]);
    expect(rows).toHaveLength(1);
  });

  it('criterion 6: remove (by owner) removes the row -- ciphertext and wrapped DEK are gone from the table', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin, 'owner');
    await connect(ctx({ accountId, userId }, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), {
      provider: 'ai_gateway',
      key: 'sk-fake',
    });

    await remove(ctx({ accountId, userId }, fakeHttpClient({ kind: 'ok' }), fakeKekSource()));

    const { rows } = await admin.query('SELECT * FROM model_connections WHERE account_id = $1', [accountId]);
    expect(rows).toHaveLength(0);
  });

  it('audit_log records connect/remove without ever storing the plaintext key', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin, 'owner');
    const plaintextKey = 'sk-fake-audit-check';
    await connect(ctx({ accountId, userId }, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), {
      provider: 'ai_gateway',
      key: plaintextKey,
    });
    await remove(ctx({ accountId, userId }, fakeHttpClient({ kind: 'ok' }), fakeKekSource()));

    const { rows } = await withTenant(appUserPool, accountId, userId, (client) =>
      client.query('SELECT action, payload FROM audit_log WHERE account_id = $1 ORDER BY created_at', [accountId]),
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('model_connection.connect');
    expect(actions).toContain('model_connection.remove');
    for (const row of rows) {
      expect(JSON.stringify(row.payload)).not.toContain(plaintextKey);
    }
  });

  describe('criterion 2 grep test: plaintext key never reaches Postgres, logs, events or responses', () => {
    const consoleCalls: string[] = [];

    beforeEach(() => {
      consoleCalls.length = 0;
      for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const) {
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          consoleCalls.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
        });
      }
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('a realistic connect/reject/test/rotate/markBroken/remove lifecycle never leaks the key into a pg_dump or the console', async () => {
      const PLAINTEXT_MARKER = `sk-PLAINTEXT-MARKER-${Date.now()}-do-not-store`;
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner');
      // One KEK for this lifecycle (unlike ctx()'s fresh-per-call KEK
      // elsewhere) -- testConnection below must decrypt what connect just encrypted.
      const testKek = fakeKekSource();
      const principal = { accountId, userId };
      const withKek = (client = fakeHttpClient({ kind: 'ok' })) => ctx(principal, client, testKek);

      const status = await connect(withKek(), { provider: 'ai_gateway', key: PLAINTEXT_MARKER });
      expect(JSON.stringify(status)).not.toContain(PLAINTEXT_MARKER);

      const rejectedMarker = `${PLAINTEXT_MARKER}-rejected`;
      try {
        await connect(withKek(fakeHttpClient({ kind: 'rejected', code: '401', message: 'bad key' })), {
          provider: 'ai_gateway',
          key: rejectedMarker,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidModelKeyError);
        expect((err as Error).message).not.toContain(rejectedMarker);
      }

      await testConnection(withKek());

      const rotatedMarker = `${PLAINTEXT_MARKER}-rotated`;
      await connect(withKek(), { provider: 'ai_gateway', key: rotatedMarker });

      await markBroken(platformOpsPool, accountId, 401);
      await remove(withKek());

      // Logs: nothing this package does should ever call console.*.
      const loggedText = consoleCalls.join('\n');
      for (const marker of [PLAINTEXT_MARKER, rejectedMarker, rotatedMarker]) {
        expect(loggedText).not.toContain(marker);
      }

      // "grep a full DB dump" and "emitted events" (audit_log, already in
      // the dump) in one check.
      const dump = execFileSync('pg_dump', ['--no-owner', '--no-privileges', process.env.DATABASE_URL!], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      for (const marker of [PLAINTEXT_MARKER, rejectedMarker, rotatedMarker]) {
        expect(dump).not.toContain(marker);
      }
    });
  });

  describe('security review findings 1 and 7 (PR #55 fix round)', () => {
    it(
      'finding 1: a key with embedded CR/LF is refused before any network call, and the plaintext never ' +
        'appears in the thrown error -- even against the REAL fetch-based HTTP client',
      async () => {
        const { accountId, userId: ownerId } = await seedAccountWithMember(admin, 'owner');
        const memberId = randomUUID();
        await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [memberId, `${memberId}@example.test`]);
        await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')", [
          accountId,
          memberId,
        ]);
        const kek = fakeKekSource();
        const MARKER = 'sk-PLAINTEXT-MARKER-crlf\r\nwrapped-tail';

        // The real implementation, with global fetch replaced by a
        // stand-in that runs undici's own Request/Headers validation
        // before anything else -- the exact step that, pre-fix, threw
        // an error whose message contained the entire "Bearer <key>"
        // header (and therefore the whole plaintext key).
        const realFetch = globalThis.fetch;
        let networkCalls = 0;
        globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
          new Request(url, init);
          networkCalls++;
          return new Response(null, { status: 200 });
        }) as typeof fetch;

        let thrown: unknown;
        try {
          await connect(ctx({ accountId, userId: ownerId }, fetchValidationHttpClient(), kek), {
            provider: 'ai_gateway',
            key: MARKER,
          });
        } catch (err) {
          thrown = err;
        } finally {
          globalThis.fetch = realFetch;
        }

        expect(thrown).toBeInstanceOf(InvalidModelKeyError);
        expect((thrown as Error).message).not.toContain(MARKER);
        expect((thrown as Error).message).not.toContain('PLAINTEXT-MARKER');

        // Never reached the network -- rejected on format, before validate().
        expect(networkCalls).toBe(0);

        // Nothing was ever stored, so there is nothing for a member to
        // read back via test() either.
        const { rows } = await admin.query('SELECT * FROM model_connections WHERE account_id = $1', [accountId]);
        expect(rows).toHaveLength(0);
        await expect(
          testConnection(ctx({ accountId, userId: memberId }, fetchValidationHttpClient(), kek)),
        ).rejects.toThrow('no connection for account');
      },
    );

    it('finding 1: keys with NUL, LF alone, or a raw control character are all refused the same way', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner');
      const client = fakeHttpClient({ kind: 'ok' });
      for (const badKey of ['sk-nul-\u0000-tail', 'sk-lf-\n-tail', 'sk-bell-\u0007-tail', '']) {
        await expect(
          connect(ctx({ accountId, userId }, client, fakeKekSource()), { provider: 'ai_gateway', key: badKey }),
        ).rejects.toThrow(InvalidModelKeyError);
      }
      // The HTTP client was never invoked for any of them.
      expect(client.calls).toHaveLength(0);
      const { rows } = await admin.query('SELECT * FROM model_connections WHERE account_id = $1', [accountId]);
      expect(rows).toHaveLength(0);
    });

    it('finding 1: httpClient.ts never echoes the underlying fetch/undici error text into the outcome message', async () => {
      const MARKER = 'sk-PLAINTEXT-MARKER-direct-httpclient\r\ntail';

      // Call fetchValidationHttpClient directly (bypassing connect()'s
      // own format gate) so this asserts httpClient.ts's OWN behaviour:
      // it must never surface `err.message` from a thrown fetch/undici
      // error, no matter what the caller passed it. No Postgres needed
      // for this one -- httpClient.ts never touches the database.
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        new Request(url, init); // throws for CR/LF in the header value
        return new Response(null, { status: 200 });
      }) as typeof fetch;
      try {
        const outcome = await fetchValidationHttpClient().validate({ provider: 'ai_gateway', plaintextKey: MARKER });
        expect(outcome.kind).toBe('network_error');
        expect(JSON.stringify(outcome)).not.toContain(MARKER);
        expect(JSON.stringify(outcome)).not.toContain('Bearer');
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it('finding 7: an unknown provider string (bypassing the static type) is refused before the HTTP client and before storage', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, 'owner');
      const client = fakeHttpClient({ kind: 'ok' });
      await expect(
        connect(ctx({ accountId, userId }, client, fakeKekSource()), {
          provider: 'Anthropic' as never,
          key: 'sk-fake-unknown-provider',
        }),
      ).rejects.toThrow(InvalidModelKeyError);
      expect(client.calls).toHaveLength(0);
      const { rows } = await admin.query('SELECT * FROM model_connections WHERE account_id = $1', [accountId]);
      expect(rows).toHaveLength(0);
    });
  });
});
