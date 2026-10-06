import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession, verifySession } from '@fx/core/src/auth/session.js';
import { redactEventPayload } from '@fx/core/src/events/redact.js';
import { emitDomainEvent } from '@fx/core/src/domain-events/emit.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { generateToken, displayHint } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import type { Scope } from '../src/registry.js';
import { openCursor, sealCursor } from '../src/sse/cursor.js';
import {
  HEARTBEAT_INTERVAL_MS,
  IDLE_TIMEOUT_MS,
  LIFETIME_MAX_MS,
  LIFETIME_MIN_MS,
  RECHECK_INTERVAL_MS,
  drawLifetimeMs,
  handleEventsRequest,
  type StreamDeps,
  type StreamTarget,
} from '../src/sse/stream.js';
import {
  LEASE_TTL_MS,
  SESSION_STREAMS_PER_ACCOUNT,
  SESSION_STREAMS_PER_USER,
  tokenStreamsPerTenant,
  StreamLimitError,
  acquireLease,
  recheckToken,
  releaseLease,
} from '../src/sse/leases.js';
import { AccountPoller } from '../src/sse/poller.js';
import { JSON_POLLS_PER_TOKEN_PER_MINUTE } from '../src/sse/json.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';
import { ManualClock } from './helpers/manual-clock.js';
import { countingPool, eventually, openSse, sleep, startServer, type SseConnection, type TestServer } from './helpers/sse.js';

const CURSOR_KEY = randomBytes(32).toString('base64');

/** Fake secrets in the shapes H11's redaction knows, including the two D#31/D#37 added (`fxat_`, `whsec_`). */
const FAKE_SECRETS = [
  `fxat_${'A1b2C3d4E5'.repeat(5)}xyz9`.slice(0, 54),
  `whsec_${'QWxhZGRpbjpvcGVuIHNlc2FtZQ'.repeat(2)}==`,
  `vck_${'abcdefghij0123456789'}`,
  `ghs_${'abcdefghijklmnopqrstuvwxyz0123'}`,
  `sk_live_${'abcdefghij0123456789'}`,
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk',
];

describe('D#31 API-5: the v1 event streams (real HTTP, real Postgres)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let poller: AccountPoller;
  let server: TestServer;
  let deps: StreamDeps;
  const openConnections: SseConnection[] = [];

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    process.env.FX_CURSOR_KEY_V1 = CURSOR_KEY;

    // Fast polling so live tests do not wait whole seconds; every other behaviour is the production code path.
    poller = new AccountPoller({ pool: appUserPool, platformOpsPool, activeIntervalMs: 40, idleIntervalMs: 40 });
    deps = { pool: appUserPool, platformOpsPool, poller, runPollIntervalMs: 40 };
    server = await startServer((req) => handleEventsRequest(req, targetOf(req), deps));
  });

  afterEach(() => {
    for (const c of openConnections.splice(0)) c.abort();
  });

  afterAll(async () => {
    await server.close();
    delete process.env.FX_SESSION_SECRET;
    delete process.env.FX_CURSOR_KEY_V1;
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  function targetOf(req: Request): StreamTarget {
    const m = /^\/api\/v1\/runs\/([^/]+)\/events$/.exec(new URL(req.url).pathname);
    return m ? { kind: 'run', runId: decodeURIComponent(m[1]!) } : { kind: 'account' };
  }

  async function cookie(identity: { userId: string; accountId: string }, epoch = 0): Promise<string> {
    return `${SESSION_COOKIE_NAME}=${await signSession(identity, process.env, { epoch })}`;
  }

  async function mintToken(identity: { accountId: string; userId: string }, scopes: Scope[] = ['read']): Promise<{ id: string; plaintext: string }> {
    const plaintext = generateToken();
    const inserted = await insertApiToken(appUserPool, {
      accountId: identity.accountId,
      createdBy: identity.userId,
      tokenHash: hashToken(plaintext),
      displayHint: displayHint(plaintext),
      scopes,
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    });
    return { id: inserted.id, plaintext };
  }

  async function connect(path: string, headers: Record<string, string>): Promise<SseConnection> {
    const c = await openSse(`${server.url}${path}`, headers);
    openConnections.push(c);
    return c;
  }

  async function addMember(accountId: string, role: 'owner' | 'admin' | 'member' = 'member'): Promise<string> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return userId;
  }

  async function insertEvent(accountId: string, type: string, payload: Record<string, unknown> = {}): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO domain_events (account_id, type, payload) VALUES ($1, $2, $3::jsonb) RETURNING id`,
      [accountId, type, JSON.stringify(payload)],
    );
    return rows[0]!.id;
  }

  async function seedRun(accountId: string, status = 'running'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'build', 'local', $3)`, [id, accountId, status]);
    return id;
  }

  async function insertRunEvent(accountId: string, runId: string, seq: number, kind = 'message', payload: unknown = { n: seq }): Promise<void> {
    await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, $4, $5::jsonb)`, [
      accountId,
      runId,
      seq,
      kind,
      JSON.stringify(payload),
    ]);
  }

  async function leaseCount(accountId: string): Promise<number> {
    const { rows } = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM stream_leases WHERE account_id = $1`, [accountId]);
    return rows[0]!.n;
  }

  // -------------------------------------------------------------------
  describe('account stream: ordered delivery and resume-from-cursor after a disconnect (real SSE connection)', () => {
    it('delivers events in order with sealed ids, then a reconnect with Last-Event-ID replays only later events', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const ck = await cookie({ accountId, userId });

      const first = await connect('/api/v1/events', { cookie: ck });
      expect(first.status).toBe(200);
      expect(first.headers.get('content-type')).toContain('text/event-stream');
      expect(first.headers.get('cache-control')).toContain('no-store');
      expect(first.headers.get('x-request-id')).toBeTruthy();
      await first.waitFor((f) => f.comment === 'ok');

      const ids: string[] = [];
      for (const type of ['pr.opened', 'budget.exhausted', 'work_item.needs_human']) {
        ids.push(await insertEvent(accountId, type, { workItemId: randomUUID() }));
      }
      await eventually(() => first.events().length >= 3);
      const got = first.events();
      expect(got.map((f) => f.event)).toEqual(['pr.opened', 'budget.exhausted', 'work_item.needs_human']);
      expect(got.map((f) => JSON.parse(f.data!).id)).toEqual(ids);
      for (const f of got) {
        expect(f.id).toMatch(/^[A-Za-z0-9_-]{60,}$/);
        expect(/^\d+$/.test(f.id!)).toBe(false);
        expect(Object.keys(JSON.parse(f.data!)).sort()).toEqual(['created_at', 'data', 'id', 'type']);
      }
      // The cursor of the 2nd event, as the browser would send it on reconnect.
      const resumeFrom = got[1]!.id!;
      first.abort();
      await first.closed;

      // Two more happen while nobody is connected.
      ids.push(await insertEvent(accountId, 'pr.opened'), await insertEvent(accountId, 'endpoint.test'));

      const second = await connect('/api/v1/events', { cookie: ck, 'last-event-id': resumeFrom });
      expect(second.status).toBe(200);
      await eventually(() => second.events().length >= 3);
      expect(second.events().map((f) => JSON.parse(f.data!).id)).toEqual(ids.slice(2)); // events 3, 4, 5 -- nothing at or before event 2
      // ...and live events keep flowing on the resumed stream.
      const live = await insertEvent(accountId, 'pr.ready_to_merge');
      await second.waitFor((f) => f.data !== undefined && JSON.parse(f.data).id === live);
    });

    it('a connect with no Last-Event-ID starts from now (no replay) but still hands the client a resume point', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      await insertEvent(accountId, 'pr.opened');
      const c = await connect('/api/v1/events', { cookie: await cookie({ accountId, userId }) });
      const idOnly = await c.waitFor((f) => f.id !== undefined && f.event === undefined && f.data === undefined);
      expect(() => openCursor(idOnly.id!, accountId, process.env)).not.toThrow();
      await sleep(200);
      expect(c.events()).toHaveLength(0);
    });

    it('a cursor older than the 7-day retention -> event: resync, then live events', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const stale = sealCursor({ accountId, serial: 1n, issuedAtMs: Date.now() - 8 * 24 * 60 * 60 * 1000 }, process.env);
      const c = await connect('/api/v1/events', { cookie: await cookie({ accountId, userId }), 'last-event-id': stale });
      expect(c.status).toBe(200);
      const resync = await c.waitFor((f) => f.event === 'resync');
      // The resync frame carries a fresh position, valid for this account.
      expect(openCursor(resync.id!, accountId, process.env).serial).toBeGreaterThanOrEqual(0n);
      const live = await insertEvent(accountId, 'pr.opened');
      await c.waitFor((f) => f.data !== undefined && f.event === 'pr.opened' && JSON.parse(f.data).id === live);
      // resync came before the live event.
      const names = c.frames.map((f) => f.event).filter(Boolean);
      expect(names).toEqual(['resync', 'pr.opened']);
    });

    it('emitDomainEvent (the real writer, in a tenant transaction) is what the stream delivers', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const c = await connect('/api/v1/events', { cookie: await cookie({ accountId, userId }) });
      await c.waitFor((f) => f.comment === 'ok');
      const emitted = await withTenant(appUserPool, accountId, (client) =>
        emitDomainEvent(client, { type: 'budget.exhausted', accountId, payload: { budget: 'model' } }),
      );
      const f = await c.waitFor((x) => x.event === 'budget.exhausted');
      expect(JSON.parse(f.data!)).toMatchObject({ id: emitted.id, type: 'budget.exhausted', data: { budget: 'model' } });
    });
  });

  // -------------------------------------------------------------------
  describe('tenant isolation: two tenants, concurrent streams, on live connections', () => {
    it('tenant A\'s streams see only A\'s events and tenant B\'s only B\'s, under interleaved concurrent writes', async () => {
      const a = await seedAccountWithMember(admin);
      const b = await seedAccountWithMember(admin);
      const a2 = await addMember(a.accountId);
      const tokenB = await mintToken(b);

      const streamA1 = await connect('/api/v1/events', { cookie: await cookie(a) });
      const streamA2 = await connect('/api/v1/events', { cookie: await cookie({ accountId: a.accountId, userId: a2 }) });
      const streamB1 = await connect('/api/v1/events', { authorization: `Bearer ${tokenB.plaintext}` });
      const streamB2 = await connect('/api/v1/events', { cookie: await cookie(b) });
      for (const s of [streamA1, streamA2, streamB1, streamB2]) {
        expect(s.status).toBe(200);
        await s.waitFor((f) => f.comment === 'ok');
      }

      const idsA: string[] = [];
      const idsB: string[] = [];
      for (let i = 0; i < 12; i++) {
        const [ea, eb] = await Promise.all([
          insertEvent(a.accountId, 'pr.opened', { prNumber: i + 1 }),
          insertEvent(b.accountId, 'pr.opened', { prNumber: 1000 + i }),
        ]);
        idsA.push(ea);
        idsB.push(eb);
      }
      await eventually(() => streamA1.events().length >= 12 && streamA2.events().length >= 12 && streamB1.events().length >= 12 && streamB2.events().length >= 12);
      const seen = (s: SseConnection): string[] => s.events().map((f) => JSON.parse(f.data!).id);
      expect(seen(streamA1)).toEqual(idsA);
      expect(seen(streamA2)).toEqual(idsA);
      expect(seen(streamB1)).toEqual(idsB);
      expect(seen(streamB2)).toEqual(idsB);
      // A byte-level check too: nothing of the other tenant, in any form, on the wire.
      for (const id of idsB) expect(streamA1.text()).not.toContain(id);
      for (const id of idsA) expect(streamB1.text()).not.toContain(id);
      expect(streamA1.text()).not.toContain(b.accountId);
      expect(streamB2.text()).not.toContain(a.accountId);
    });

    it('account B presenting account A\'s cursor -> 422 invalid_cursor, and no stream opens', async () => {
      const a = await seedAccountWithMember(admin);
      const b = await seedAccountWithMember(admin);
      const cursorA = sealCursor({ accountId: a.accountId, serial: 1n, issuedAtMs: Date.now() }, process.env);
      const res = await fetch(`${server.url}/api/v1/events`, { headers: { cookie: await cookie(b), 'last-event-id': cursorA, accept: 'text/event-stream' } });
      expect(res.status).toBe(422);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_cursor');
      expect(await leaseCount(b.accountId)).toBe(0);
    });

    it('forged, negative, huge, truncated and empty cursors all fail closed with 422 before the stream opens (account and run streams)', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const runId = await seedRun(accountId);
      const ck = await cookie({ accountId, userId });
      const good = sealCursor({ accountId, serial: 1n, issuedAtMs: Date.now() }, process.env);
      const forged = ['-1', '0', '18446744073709551616', 'A'.repeat(64), 'A'.repeat(100_000 > 8000 ? 6000 : 1), good.slice(0, -2), `${good}xx`, good.replace(/^./, 'B'), '../../etc/passwd', '%00'];
      for (const bad of forged) {
        const res = await fetch(`${server.url}/api/v1/events`, { headers: { cookie: ck, 'last-event-id': bad, accept: 'text/event-stream' } });
        expect(res.status, `account stream, Last-Event-ID ${bad.slice(0, 20)}`).toBe(422);
        await res.text();
      }
      for (const bad of ['-1', '1.5', 'abc', '99999999999999999999', good, '007']) {
        const res = await fetch(`${server.url}/api/v1/runs/${runId}/events`, { headers: { cookie: ck, 'last-event-id': bad, accept: 'text/event-stream' } });
        expect(res.status, `run stream, Last-Event-ID ${bad.slice(0, 20)}`).toBe(422);
        await res.text();
      }
      expect(await leaseCount(accountId)).toBe(0);
    });

    it('B\'s run id -> 404 before any stream byte, identical to a nonexistent and a malformed id', async () => {
      const a = await seedAccountWithMember(admin);
      const b = await seedAccountWithMember(admin);
      const runOfA = await seedRun(a.accountId);
      const ckB = await cookie(b);
      const bodies: string[] = [];
      for (const id of [runOfA, randomUUID(), 'not-a-uuid', '../../v1/events']) {
        const res = await fetch(`${server.url}/api/v1/runs/${encodeURIComponent(id)}/events`, { headers: { cookie: ckB, accept: 'text/event-stream' } });
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toContain('application/json');
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe('not_found');
        bodies.push(body.error.message);
      }
      expect(new Set(bodies).size).toBe(1);
      expect(await leaseCount(b.accountId)).toBe(0);
    });

    it('a stream_leases row is invisible to, and cannot be renewed or released by, another tenant', async () => {
      const a = await seedAccountWithMember(admin);
      const b = await seedAccountWithMember(admin);
      const leaseA = await acquireLease(appUserPool, { kind: 'session', accountId: a.accountId, principalKey: a.userId }, Date.now());

      await withTenant(appUserPool, b.accountId, async (client) => {
        expect((await client.query(`SELECT 1 FROM stream_leases WHERE id = $1`, [leaseA])).rowCount).toBe(0);
        expect((await client.query(`UPDATE stream_leases SET expires_at = now() + interval '1 day' WHERE id = $1`, [leaseA])).rowCount).toBe(0);
        expect((await client.query(`DELETE FROM stream_leases WHERE id = $1`, [leaseA])).rowCount).toBe(0);
        // Nor can B plant a row in A's name.
        await expect(
          client.query(`INSERT INTO stream_leases (account_id, kind, principal_key, expires_at) VALUES ($1, 'session', $2, now())`, [a.accountId, b.userId]),
        ).rejects.toThrow(/row-level security/);
      });
      // releaseLease under B's identity with A's lease id frees nothing.
      await releaseLease(appUserPool, { kind: 'session', accountId: b.accountId, principalKey: b.userId }, leaseA);
      expect(await leaseCount(a.accountId)).toBe(1);
      // Within a tenant it is also scoped to the holder: another member of A cannot release A's user's lease.
      const other = await addMember(a.accountId);
      await releaseLease(appUserPool, { kind: 'session', accountId: a.accountId, principalKey: other }, leaseA);
      expect(await leaseCount(a.accountId)).toBe(1);
      await releaseLease(appUserPool, { kind: 'session', accountId: a.accountId, principalKey: a.userId }, leaseA);
      expect(await leaseCount(a.accountId)).toBe(0);
    });

    it('the watermark function is callable by platform_ops only -- not by app_user, so no tenant-scoped code can read other tenants\' serials', async () => {
      const a = await seedAccountWithMember(admin);
      await expect(appUserPool.query(`SELECT * FROM domain_event_watermarks($1::uuid[])`, [[a.accountId]])).rejects.toThrow(/permission denied/);
      const { rows } = await platformOpsPool.query(`SELECT * FROM domain_event_watermarks($1::uuid[])`, [[a.accountId]]);
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]).sort()).toEqual(['account_id', 'max_seq', 'run_active']);
    });

    it('a token cannot be charged against another tenant\'s JSON-poll bucket, and a definer call outside a tenant context is refused', async () => {
      const a = await seedAccountWithMember(admin);
      const b = await seedAccountWithMember(admin);
      const tokenA = await mintToken(a);
      await withTenant(appUserPool, b.accountId, async (client) => {
        await expect(client.query(`SELECT * FROM stream_json_poll_check($1, 6)`, [tokenA.id])).rejects.toThrow(/does not belong/);
      });
      await expect(appUserPool.query(`SELECT * FROM stream_json_poll_check($1, 6)`, [tokenA.id])).rejects.toThrow(/tenant context/);
    });
  });

  // -------------------------------------------------------------------
  describe('run stream: replay, live events, close on terminal status (real SSE connection)', () => {
    it('replays in order, delivers live events, sends event: end when the run finishes, and a reconnect resumes after Last-Event-ID', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const runId = await seedRun(accountId, 'running');
      for (let seq = 1; seq <= 3; seq++) await insertRunEvent(accountId, runId, seq, 'message', { text: `line ${seq}` });
      const ck = await cookie({ accountId, userId });

      const c = await connect(`/api/v1/runs/${runId}/events`, { cookie: ck });
      expect(c.status).toBe(200);
      await eventually(() => c.events().length >= 3);
      await insertRunEvent(accountId, runId, 4, 'tool', { name: 'edit' });
      await insertRunEvent(accountId, runId, 5, 'message', { text: 'done' });
      await eventually(() => c.events().length >= 5);
      expect(c.events().map((f) => f.id)).toEqual(['1', '2', '3', '4', '5']);
      expect(c.events().map((f) => f.event)).toEqual(Array(5).fill('run_event'));
      expect(c.events().map((f) => JSON.parse(f.data!).seq)).toEqual([1, 2, 3, 4, 5]);
      expect(Object.keys(JSON.parse(c.events()[0]!.data!)).sort()).toEqual(['at', 'kind', 'payload', 'seq']);
      expect(c.isClosed()).toBe(false);

      await admin.query(`UPDATE agent_runs SET status = 'succeeded' WHERE id = $1`, [runId]);
      const end = await c.waitFor((f) => f.event === 'end');
      expect(JSON.parse(end.data!)).toEqual({ status: 'succeeded' });
      await c.closed; // "closes within one poll"
      expect(await eventually(async () => (await leaseCount(accountId)) === 0)).toBe(true);

      // Reconnect after seq 3: only 4 and 5 replay, then the run is already terminal -> end.
      const again = await connect(`/api/v1/runs/${runId}/events`, { cookie: ck, 'last-event-id': '3' });
      await again.closed;
      expect(again.events().map((f) => f.event)).toEqual(['run_event', 'run_event', 'end']);
      expect(again.events().slice(0, 2).map((f) => f.id)).toEqual(['4', '5']);
    });

    it('a run that is already terminal replays and ends; events written before the terminal status are never dropped', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const runId = await seedRun(accountId, 'failed');
      for (let seq = 1; seq <= 450; seq++) await insertRunEvent(accountId, runId, seq); // > 2 pages of 200
      const c = await connect(`/api/v1/runs/${runId}/events`, { cookie: await cookie({ accountId, userId }) });
      await c.closed;
      const seqs = c.events().filter((f) => f.event === 'run_event').map((f) => JSON.parse(f.data!).seq);
      expect(seqs).toEqual(Array.from({ length: 450 }, (_, i) => i + 1));
      expect(c.events().at(-1)!.event).toBe('end');
    });
  });

  describe('run.metering is platform data (H14c-3-2c)', () => {
    it('a tenant\'s run stream never replays a run.metering row, including after a resume', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const runId = await seedRun(accountId, 'failed');
      await insertRunEvent(accountId, runId, 1, 'message', { text: 'a' });
      await insertRunEvent(accountId, runId, 2, 'run.metering', { metered_usd: 1, reported_usd: null, flags: ['no_metering'] });
      await insertRunEvent(accountId, runId, 3, 'message', { text: 'b' });
      const ck = await cookie({ accountId, userId });

      const c = await connect(`/api/v1/runs/${runId}/events`, { cookie: ck });
      await c.closed;
      expect(c.events().filter((f) => f.event === 'run_event').map((f) => f.id)).toEqual(['1', '3']);

      const again = await connect(`/api/v1/runs/${runId}/events`, { cookie: ck, 'last-event-id': '1' });
      await again.closed;
      expect(again.events().filter((f) => f.event === 'run_event').map((f) => f.id)).toEqual(['3']);
    });
  });

  // -------------------------------------------------------------------
  describe('redaction end to end (criterion 9)', () => {
    it('H11\'s fake secrets -- including fxat_ and whsec_ -- never appear on either stream, even when a row reaches the table unredacted', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const runId = await seedRun(accountId, 'running');
      const ck = await cookie({ accountId, userId });
      const run = await connect(`/api/v1/runs/${runId}/events`, { cookie: ck });
      const acct = await connect('/api/v1/events', { cookie: ck });
      await acct.waitFor((f) => f.comment === 'ok');

      // Raw INSERTs, bypassing the runner's redact-at-write: the worst case the read side must still cover.
      await insertRunEvent(accountId, runId, 1, 'message', { text: `token ${FAKE_SECRETS[0]} and ${FAKE_SECRETS[1]}`, nested: { list: FAKE_SECRETS.slice(2) } });
      await insertRunEvent(accountId, runId, 2, FAKE_SECRETS[1]!, { plain: 'ok' });
      // The account stream carries ids/enums only; a secret-shaped value in an allowed enum field must be scrubbed as well.
      await insertEvent(accountId, 'budget.exhausted', { budget: 'model', stage: FAKE_SECRETS[1], reason: FAKE_SECRETS[0], title: `leak ${FAKE_SECRETS[2]}` });
      await run.waitFor((f) => f.id === '2');
      await acct.waitFor((f) => f.event === 'budget.exhausted');
      await sleep(100);

      for (const stream of [run, acct]) {
        const wire = stream.text();
        for (const secret of FAKE_SECRETS) expect(wire).not.toContain(secret);
        expect(wire).not.toMatch(/fxat_[0-9A-Za-z]{10}/);
        expect(wire).not.toMatch(/whsec_[0-9A-Za-z+/=_-]{20}/);
      }
      expect(run.text()).toContain('[redacted]');
      expect(acct.text()).not.toContain('leak'); // free text is dropped by the ids-only allowlist
    });

    it('applies the same function H11 applies at write time (parity, not a second implementation)', () => {
      const dirty = { a: FAKE_SECRETS[0], b: [FAKE_SECRETS[1]] };
      expect(JSON.stringify(redactEventPayload(dirty))).not.toContain('fxat_');
    });
  });

  // -------------------------------------------------------------------
  describe('caps (criterion 5)', () => {
    it('a 4th session stream for one user -> 429 stream_limit with Retry-After and no retry: field; a freed slot is usable again', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const ck = await cookie({ accountId, userId });
      const held: SseConnection[] = [];
      for (let i = 0; i < SESSION_STREAMS_PER_USER; i++) {
        const c = await connect('/api/v1/events', { cookie: ck });
        expect(c.status).toBe(200);
        held.push(c);
      }
      expect(await leaseCount(accountId)).toBe(SESSION_STREAMS_PER_USER);
      const over = await fetch(`${server.url}/api/v1/events`, { headers: { cookie: ck, accept: 'text/event-stream' } });
      expect(over.status).toBe(429);
      expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
      const text = await over.text();
      expect(text).not.toContain('retry:');
      expect(JSON.parse(text).error.code).toBe('stream_limit');

      // A different member of the same account is not blocked by this user's streams.
      const other = await addMember(accountId);
      const otherStream = await connect('/api/v1/events', { cookie: await cookie({ accountId, userId: other }) });
      expect(otherStream.status).toBe(200);

      held[0]!.abort();
      await eventually(async () => (await leaseCount(accountId)) === SESSION_STREAMS_PER_USER); // 2 of user's + 1 of other
      const again = await connect('/api/v1/events', { cookie: ck });
      expect(again.status).toBe(200);
    });

    it('sessions: 25 per account -- the 26th stream (from any member) is refused', async () => {
      const first = await seedAccountWithMember(admin);
      const users = [first.userId];
      for (let i = 0; i < 8; i++) users.push(await addMember(first.accountId));
      const conns: SseConnection[] = [];
      let opened = 0;
      for (const user of users) {
        const ck = await cookie({ accountId: first.accountId, userId: user });
        for (let i = 0; i < SESSION_STREAMS_PER_USER && opened < SESSION_STREAMS_PER_ACCOUNT; i++) {
          conns.push(await connect('/api/v1/events', { cookie: ck }));
          opened++;
        }
      }
      expect(conns.every((c) => c.status === 200)).toBe(true);
      expect(await leaseCount(first.accountId)).toBe(SESSION_STREAMS_PER_ACCOUNT);
      const ninth = await cookie({ accountId: first.accountId, userId: users[8]! });
      const res = await fetch(`${server.url}/api/v1/events`, { headers: { cookie: ninth, accept: 'text/event-stream' } });
      expect(res.status).toBe(429);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('stream_limit');
    });

    it('tokens: the Starter cap per tenant, and one tenant exhausting its cap does not touch another tenant\'s', async () => {
      const a = await seedAccountWithMember(admin, { plan: 'starter' });
      const b = await seedAccountWithMember(admin, { plan: 'starter' });
      const cap = tokenStreamsPerTenant('starter');
      const tokensA = [];
      for (let i = 0; i <= cap; i++) tokensA.push(await mintToken(a));
      const tokenB = await mintToken(b);
      const statuses: number[] = [];
      for (let i = 0; i < cap; i++) {
        const path = i === 1 ? '/api/v1/runs/' + (await seedRun(a.accountId)) + '/events' : '/api/v1/events';
        statuses.push((await connect(path, { authorization: `Bearer ${tokensA[i]!.plaintext}` })).status);
      }
      expect(statuses).toEqual(Array(cap).fill(200));
      const over = await fetch(`${server.url}/api/v1/events`, { headers: { authorization: `Bearer ${tokensA[cap]!.plaintext}`, accept: 'text/event-stream' } });
      expect(over.status).toBe(429);
      expect(over.headers.get('retry-after')).toBeTruthy();
      expect(((await over.json()) as { error: { code: string } }).error.code).toBe('stream_limit');

      // B is unaffected, and A's session (not a token stream) is not counted against the token cap.
      const sb = await connect('/api/v1/events', { authorization: `Bearer ${tokenB.plaintext}` });
      expect(sb.status).toBe(200);
      const sessionA = await connect('/api/v1/events', { cookie: await cookie(a) });
      expect(sessionA.status).toBe(200);
    });

    it('token caps follow the plan as data (the plan data under test: Starter 3, Team 6, Scale 9)', async () => {
      expect([tokenStreamsPerTenant('starter'), tokenStreamsPerTenant('team'), tokenStreamsPerTenant('scale')]).toEqual([3, 6, 9]);
      const team = await seedAccountWithMember(admin, { plan: 'team' });
      const tokens = [];
      const cap = tokenStreamsPerTenant('team');
      for (let i = 0; i <= cap; i++) tokens.push(await mintToken(team));
      for (let i = 0; i < cap; i++) {
        expect((await connect('/api/v1/events', { authorization: `Bearer ${tokens[i]!.plaintext}` })).status).toBe(200);
      }
      const res = await fetch(`${server.url}/api/v1/events`, { headers: { authorization: `Bearer ${tokens[cap]!.plaintext}`, accept: 'text/event-stream' } });
      expect(res.status).toBe(429);
    });

    it('concurrent opens cannot both slip under the cap (the count-and-insert is serialized per account)', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const ck = await cookie({ accountId, userId });
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => fetch(`${server.url}/api/v1/events`, { headers: { cookie: ck, accept: 'text/event-stream' } })),
      );
      const responses = results.map((r) => (r as PromiseFulfilledResult<Response>).value);
      const ok = responses.filter((r) => r.status === 200);
      const limited = responses.filter((r) => r.status === 429);
      expect(ok).toHaveLength(SESSION_STREAMS_PER_USER);
      expect(limited).toHaveLength(8 - SESSION_STREAMS_PER_USER);
      await Promise.all(responses.map((r) => r.body?.cancel().catch(() => {})));
    });
  });

  // -------------------------------------------------------------------
  describe('leases: 90-second expiry and takeover', () => {
    it('a lease expires 90 s after its last renewal, so a killed process frees its slot within 90 s', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const subject = { kind: 'session' as const, accountId, principalKey: userId };
      const t0 = Date.now();
      // Three streams' worth of leases held by a process that then dies without releasing anything.
      for (let i = 0; i < SESSION_STREAMS_PER_USER; i++) await acquireLease(appUserPool, subject, t0);
      await expect(acquireLease(appUserPool, subject, t0 + 1000)).rejects.toBeInstanceOf(StreamLimitError);
      await expect(acquireLease(appUserPool, subject, t0 + LEASE_TTL_MS - 1)).rejects.toBeInstanceOf(StreamLimitError);
      // 90 s after the last renewal, the slot is free and the new stream takes over.
      const takeover = await acquireLease(appUserPool, subject, t0 + LEASE_TTL_MS);
      expect(takeover).toBeTruthy();
      expect(await leaseCount(accountId)).toBe(1); // the three dead rows were swept by the takeover
      expect(LEASE_TTL_MS).toBe(90_000);
    });

    it('a renewal pushes expiry out by another 90 s: a live stream keeps its slot past the original expiry', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const clock = new ManualClock(Date.now(), 60);
      const fakeDeps: StreamDeps = { ...deps, clock, poller: new AccountPoller({ pool: appUserPool, platformOpsPool, clock, idleIntervalMs: 10 * 60_000, activeIntervalMs: 10 * 60_000 }) };
      const res = await handleEventsRequest(
        new Request('http://x/api/v1/events', { headers: { cookie: await cookie({ accountId, userId }), accept: 'text/event-stream' } }),
        { kind: 'account' },
        fakeDeps,
      );
      const before = await admin.query<{ expires_at: Date }>(`SELECT expires_at FROM stream_leases WHERE account_id = $1`, [accountId]);
      const exp0 = before.rows[0]!.expires_at.getTime();
      await clock.advance(RECHECK_INTERVAL_MS);
      // The re-check that renews the lease runs on a database round trip the fake clock does not wait
      // for beyond its short settle sleep, so wait for the renewed expiry itself, bounded.
      await eventually(async () => {
        const { rows } = await admin.query<{ expires_at: Date }>(`SELECT expires_at FROM stream_leases WHERE account_id = $1`, [accountId]);
        return rows.length === 1 && rows[0]!.expires_at.getTime() === exp0 + RECHECK_INTERVAL_MS;
      });
      const after = await admin.query<{ expires_at: Date }>(`SELECT expires_at FROM stream_leases WHERE account_id = $1`, [accountId]);
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0]!.expires_at.getTime()).toBe(exp0 + RECHECK_INTERVAL_MS);
      await res.body!.cancel();
      await eventually(async () => (await leaseCount(accountId)) === 0);
    });
  });

  // -------------------------------------------------------------------
  describe('lifecycle on a fake clock: heartbeat, idle, lifetime, revocation', () => {
    /** Opens a stream directly against the handler with a manual clock, reading frames as they arrive. */
    async function openFake(
      req: Request,
      target: StreamTarget,
      clock: ManualClock,
      extra: Partial<StreamDeps> = {},
    ): Promise<{ frames: () => string; closed: () => boolean; res: Response; cancel: () => Promise<void> }> {
      const fakeDeps: StreamDeps = {
        pool: appUserPool,
        platformOpsPool,
        clock,
        poller: new AccountPoller({ pool: appUserPool, platformOpsPool, clock, idleIntervalMs: 120_000, activeIntervalMs: 120_000 }),
        ...extra,
      };
      const res = await handleEventsRequest(req, target, fakeDeps);
      let text = '';
      let done = false;
      let cancel = async (): Promise<void> => {};
      if (res.body) {
        const reader = res.body.getReader();
        cancel = () => reader.cancel();
        const decoder = new TextDecoder();
        void (async () => {
          try {
            for (;;) {
              const r = await reader.read();
              if (r.done) break;
              text += decoder.decode(r.value, { stream: true });
            }
          } finally {
            done = true;
          }
        })();
      }
      return { frames: () => text, closed: () => done, res, cancel };
    }

    async function sessionReq(identity: { accountId: string; userId: string }, epoch = 0): Promise<Request> {
      return new Request('http://x/api/v1/events', { headers: { cookie: await cookie(identity, epoch), accept: 'text/event-stream' } });
    }

    it('lifetime is uniform on [720, 780] s: over 1,000 draws min >= 720, max <= 780, not all equal', () => {
      const draws = Array.from({ length: 1000 }, () => drawLifetimeMs());
      expect(Math.min(...draws)).toBeGreaterThanOrEqual(720_000);
      expect(Math.max(...draws)).toBeLessThanOrEqual(780_000);
      expect(new Set(draws).size).toBeGreaterThan(1);
      expect(LIFETIME_MIN_MS).toBe(720_000);
      expect(LIFETIME_MAX_MS).toBe(780_000);
      expect(drawLifetimeMs(() => 0)).toBe(720_000);
      expect(drawLifetimeMs(() => 0.9999999999)).toBeLessThanOrEqual(780_000);
      // roughly uniform: both halves of the window are populated.
      expect(draws.filter((d) => d < 750_000).length).toBeGreaterThan(300);
      expect(draws.filter((d) => d >= 750_000).length).toBeGreaterThan(300);
    });

    it('sends a heartbeat comment every 25 s', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const clock = new ManualClock(Date.now(), 30);
      const s = await openFake(await sessionReq({ accountId, userId }), { kind: 'account' }, clock);
      const beats = () => (s.frames().match(/^: heartbeat$/gm) ?? []).length;
      expect(beats()).toBe(0);
      await clock.advance(HEARTBEAT_INTERVAL_MS - 1);
      expect(beats()).toBe(0);
      await clock.advance(1);
      expect(beats()).toBe(1);
      await clock.advance(HEARTBEAT_INTERVAL_MS);
      expect(beats()).toBe(2);
      await s.cancel();
      await eventually(async () => (await leaseCount(accountId)) === 0);
    });

    it('after 5 minutes with no events: event: idle, then the server closes', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const clock = new ManualClock(Date.now(), 30);
      const s = await openFake(await sessionReq({ accountId, userId }), { kind: 'account' }, clock);
      await clock.advance(IDLE_TIMEOUT_MS - 1);
      expect(s.frames()).not.toContain('event: idle');
      expect(s.closed()).toBe(false);
      await clock.advance(1);
      await eventually(() => s.closed());
      expect(s.frames()).toContain('event: idle');
      expect(await eventually(async () => (await leaseCount(accountId)) === 0)).toBe(true);
    }, 30000);

    it('an event resets the idle clock; the server closes at the drawn lifetime, and only then', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const clock = new ManualClock(Date.now(), 25);
      // Poll every 120 s of fake time; an event just before each poll keeps the stream from going idle.
      const lifetime = 750_000;
      const s = await openFake(await sessionReq({ accountId, userId }), { kind: 'account' }, clock, { random: () => (lifetime - 720_000) / 60_001 });
      let elapsed = 0;
      while (elapsed + 120_000 < lifetime) {
        await insertEvent(accountId, 'pr.opened');
        await clock.advance(120_000);
        elapsed += 120_000;
        await eventually(() => s.frames().match(/event: pr\.opened/g)?.length === elapsed / 120_000);
      }
      expect(s.closed()).toBe(false);
      expect(s.frames()).not.toContain('event: idle');
      await clock.advance(lifetime - elapsed - 1);
      expect(s.closed()).toBe(false);
      await clock.advance(1);
      await eventually(() => s.closed());
      expect(s.frames()).not.toContain('event: idle');
      expect(s.frames()).not.toContain('event: revoked');
    }, 60000);

    describe('revocation: revoked -> event: revoked and a close within <= 60 s', () => {
      it('revoking the token mid-stream', async () => {
        const { accountId, userId } = await seedAccountWithMember(admin);
        const token = await mintToken({ accountId, userId });
        const clock = new ManualClock(Date.now(), 40);
        const s = await openFake(
          new Request('http://x/api/v1/events', { headers: { authorization: `Bearer ${token.plaintext}`, accept: 'text/event-stream' } }),
          { kind: 'account' },
          clock,
        );
        await clock.advance(RECHECK_INTERVAL_MS); // a healthy re-check first: still open
        expect(s.closed()).toBe(false);
        await admin.query(`UPDATE api_tokens SET revoked_at = now() WHERE id = $1`, [token.id]);
        await clock.advance(RECHECK_INTERVAL_MS - 1);
        expect(s.closed()).toBe(false);
        await clock.advance(1);
        await eventually(() => s.closed());
        expect(s.frames()).toContain('event: revoked');
        // The stream frees its lease after it closes (a fire-and-forget release), so the row goes a moment
        // later than the close does; waiting for that is the assertion, not an instantaneous read.
        expect(await eventually(async () => (await leaseCount(accountId)) === 0)).toBe(true);
      });

      it('signing out everywhere (session epoch bump)', async () => {
        const { accountId, userId } = await seedAccountWithMember(admin);
        const clock = new ManualClock(Date.now(), 40);
        const s = await openFake(await sessionReq({ accountId, userId }), { kind: 'account' }, clock);
        await admin.query(`UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1`, [userId]);
        await clock.advance(RECHECK_INTERVAL_MS);
        await eventually(() => s.closed());
        expect(s.frames()).toContain('event: revoked');
      });

      it('signing out this session (revoked_sessions row)', async () => {
        const { accountId, userId } = await seedAccountWithMember(admin);
        const req = await sessionReq({ accountId, userId });
        const cookieValue = decodeURIComponent(req.headers.get('cookie')!.split('=')[1]!);
        const sid = (await verifySession(cookieValue))!.sid;
        const clock = new ManualClock(Date.now(), 40);
        const s = await openFake(req, { kind: 'account' }, clock);
        await admin.query(`INSERT INTO revoked_sessions (session_id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [sid, userId]);
        await clock.advance(RECHECK_INTERVAL_MS);
        await eventually(() => s.closed());
        expect(s.frames()).toContain('event: revoked');
      });

      it('removing the creator from the account (session and token streams)', async () => {
        const { accountId } = await seedAccountWithMember(admin, { role: 'owner' });
        const creator = await addMember(accountId, 'member');
        const token = await mintToken({ accountId, userId: creator });
        const clock = new ManualClock(Date.now(), 40);
        const viaSession = await openFake(await sessionReq({ accountId, userId: creator }), { kind: 'account' }, clock);
        const viaToken = await openFake(
          new Request('http://x/api/v1/events', { headers: { authorization: `Bearer ${token.plaintext}`, accept: 'text/event-stream' } }),
          { kind: 'account' },
          clock,
        );
        await admin.query(`DELETE FROM account_members WHERE account_id = $1 AND user_id = $2`, [accountId, creator]);
        await clock.advance(RECHECK_INTERVAL_MS);
        await eventually(() => viaSession.closed() && viaToken.closed());
        expect(viaSession.frames()).toContain('event: revoked');
        expect(viaToken.frames()).toContain('event: revoked');
      });

      it('demoting the creator (owner -> admin, admin -> member)', async () => {
        const { accountId, userId } = await seedAccountWithMember(admin, { role: 'owner' });
        const admin2 = await addMember(accountId, 'admin');
        const tokenOwner = await mintToken({ accountId, userId });
        const clock = new ManualClock(Date.now(), 40);
        const viaSession = await openFake(await sessionReq({ accountId, userId: admin2 }), { kind: 'account' }, clock);
        const viaToken = await openFake(
          new Request('http://x/api/v1/events', { headers: { authorization: `Bearer ${tokenOwner.plaintext}`, accept: 'text/event-stream' } }),
          { kind: 'account' },
          clock,
        );
        await admin.query(`UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2`, [accountId, admin2]);
        await admin.query(`UPDATE account_members SET role = 'admin' WHERE account_id = $1 AND user_id = $2`, [accountId, userId]);
        await clock.advance(RECHECK_INTERVAL_MS);
        await eventually(() => viaSession.closed() && viaToken.closed());
        expect(viaSession.frames()).toContain('event: revoked');
        expect(viaToken.frames()).toContain('event: revoked');
      });

      it('a run stream is re-checked the same way', async () => {
        const { accountId, userId } = await seedAccountWithMember(admin);
        const runId = await seedRun(accountId);
        const clock = new ManualClock(Date.now(), 40);
        const s = await openFake(
          new Request(`http://x/api/v1/runs/${runId}/events`, { headers: { cookie: await cookie({ accountId, userId }), accept: 'text/event-stream' } }),
          { kind: 'run', runId },
          clock,
        );
        await admin.query(`UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1`, [userId]);
        await clock.advance(RECHECK_INTERVAL_MS);
        await eventually(() => s.closed());
        expect(s.frames()).toContain('event: revoked');
      });

      it('the lease renewal rides on the re-check: it adds NO query (same statement count with and without a lease)', async () => {
        const { accountId, userId } = await seedAccountWithMember(admin);
        const token = await mintToken({ accountId, userId });
        const subject = { kind: 'token' as const, accountId, principalKey: token.id };
        const leaseId = await acquireLease(appUserPool, subject, Date.now());
        const cp = countingPool(appUserPool);
        const t = Date.now();
        cp.reset();
        const withLease = await recheckToken(cp.pool, subject, hashToken(token.plaintext), leaseId, t);
        const withLeaseCount = cp.log.length;
        cp.reset();
        const noLease = await recheckToken(cp.pool, subject, hashToken(token.plaintext), null, t);
        const noLeaseCount = cp.log.length;
        expect(withLease).toMatchObject({ status: 'ok', renewed: true });
        expect(noLease).toMatchObject({ status: 'ok', renewed: false });
        expect(withLeaseCount).toBe(noLeaseCount);
        // Both runs sent the very same statements -- the renewal is a CTE inside the check, not an extra round trip.
        const statements = (log: { sql: string }[]) => log.map((l) => l.sql.replace(/\s+/g, ' '));
        cp.reset();
        await recheckToken(cp.pool, subject, hashToken(token.plaintext), leaseId, t);
        const a = statements(cp.log);
        cp.reset();
        await recheckToken(cp.pool, subject, hashToken(token.plaintext), null, t);
        expect(statements(cp.log)).toEqual(a);
        await releaseLease(appUserPool, subject, leaseId);
      });
    });
  });

  // -------------------------------------------------------------------
  describe('a disconnected client costs nothing (criterion 3) and poll economics (criterion 7)', () => {
    it('after the client goes away, no stream query runs 2 s later (query counter) and nothing is left polling', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const runId = await seedRun(accountId, 'running');
      const app = countingPool(appUserPool);
      const ops = countingPool(platformOpsPool);
      const realPoller = new AccountPoller({ pool: app.pool, platformOpsPool: ops.pool });
      const localDeps: StreamDeps = { pool: app.pool, platformOpsPool: ops.pool, poller: realPoller }; // production intervals: 2 s / 10 s
      const srv = await startServer((req) => handleEventsRequest(req, targetOf(req), localDeps));
      try {
        const ck = await cookie({ accountId, userId });
        const acct = await openSse(`${srv.url}/api/v1/events`, { cookie: ck });
        const run = await openSse(`${srv.url}/api/v1/runs/${runId}/events`, { cookie: ck });
        await insertRunEvent(accountId, runId, 1);
        await run.waitFor((f) => f.id === '1');
        await acct.waitFor((f) => f.comment === 'ok');
        await eventually(() => ops.count(/domain_event_watermarks/) >= 1);

        acct.abort();
        run.abort();
        await Promise.all([acct.closed, run.closed]);
        // Let statements already in flight at the moment of the abort finish.
        await eventually(async () => (await leaseCount(accountId)) === 0);
        await sleep(300);
        app.reset();
        ops.reset();
        await sleep(2300); // longer than one active poll interval
        expect(app.log.map((l) => l.sql)).toEqual([]);
        expect(ops.log.map((l) => l.sql)).toEqual([]);
        expect(realPoller.stats()).toEqual({ feeds: 0, subscribers: 0, timerArmed: false });
      } finally {
        await srv.close();
      }
    }, 30000);

    it('the request\'s abort signal alone (with the body still being read) stops the stream, its polling and its lease -- for both stream kinds', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const runId = await seedRun(accountId, 'running');
      const ck = await cookie({ accountId, userId });
      const localPoller = new AccountPoller({ pool: appUserPool, platformOpsPool, activeIntervalMs: 40, idleIntervalMs: 40 });
      const local: StreamDeps = { pool: appUserPool, platformOpsPool, poller: localPoller, runPollIntervalMs: 40 };
      for (const [path, target] of [
        ['/api/v1/events', { kind: 'account' }],
        [`/api/v1/runs/${runId}/events`, { kind: 'run', runId }],
      ] as [string, StreamTarget][]) {
        const controller = new AbortController();
        const res = await handleEventsRequest(
          new Request(`http://x${path}`, { headers: { cookie: ck, accept: 'text/event-stream' }, signal: controller.signal }),
          target,
          local,
        );
        const reader = res.body!.getReader();
        const first = await reader.read();
        expect(first.done).toBe(false);
        expect(await leaseCount(accountId)).toBe(1);
        controller.abort();
        // The stream ends (the read resolves done) without anyone cancelling the reader.
        await eventually(async () => (await reader.read()).done === true);
        await eventually(async () => (await leaseCount(accountId)) === 0);
        expect(localPoller.stats().subscribers).toBe(0);
      }
      // An already-aborted request never opens anything.
      const dead = new AbortController();
      dead.abort();
      const res = await handleEventsRequest(
        new Request('http://x/api/v1/events', { headers: { cookie: ck, accept: 'text/event-stream' }, signal: dead.signal }),
        { kind: 'account' },
        local,
      );
      const deadReader = res.body!.getReader();
      await eventually(async () => (await deadReader.read()).done === true);
      await eventually(async () => (await leaseCount(accountId)) === 0);
      expect(localPoller.stats().subscribers).toBe(0);
    });

    it('20 streams over 2 accounts: an idle account costs only the shared watermark query; a tenant read runs only when a watermark moves; 2 s while a run is active, 10 s otherwise', async () => {
      const a = await seedAccountWithMember(admin);
      const b = await seedAccountWithMember(admin);
      const runA = await seedRun(a.accountId, 'running'); // A has a run in flight; B is idle
      void runA;
      const clock = new ManualClock(Date.now(), 25);
      const app = countingPool(appUserPool);
      const ops = countingPool(platformOpsPool);
      const localPoller = new AccountPoller({ pool: app.pool, platformOpsPool: ops.pool, clock });
      const localDeps: StreamDeps = { pool: appUserPool, platformOpsPool, clock, poller: localPoller };

      const conns: Response[] = [];
      for (const acct of [a, b]) {
        const users = [acct.userId];
        for (let i = 0; i < 3; i++) users.push(await addMember(acct.accountId));
        let opened = 0;
        for (const user of users) {
          const ck = await cookie({ accountId: acct.accountId, userId: user });
          for (let i = 0; i < 3 && opened < 10; i++) {
            conns.push(
              await handleEventsRequest(
                new Request('http://x/api/v1/events', { headers: { cookie: ck, accept: 'text/event-stream' } }),
                { kind: 'account' },
                localDeps,
              ),
            );
            opened++;
          }
        }
      }
      expect(conns).toHaveLength(20);
      expect(conns.every((c) => c.status === 200)).toBe(true);
      const receivedByStream: string[] = conns.map(() => '');
      const readers = conns.map((res) => res.body!.getReader());
      readers.forEach((reader, i) => {
        const decoder = new TextDecoder();
        void (async () => {
          try {
            for (;;) {
              const r = await reader.read();
              if (r.done) break;
              receivedByStream[i] += decoder.decode(r.value, { stream: true });
            }
          } catch {
            // closed
          }
        })();
      });
      expect(localPoller.stats().subscribers).toBe(20);
      expect(localPoller.stats().feeds).toBe(2);

      // Let the first (immediate) tick run, then start counting.
      await clock.advance(0);
      await sleep(200);
      app.reset();
      ops.reset();

      const watermarkCalls = () => ops.log.filter((l) => /domain_event_watermarks/.test(l.sql));
      const tenantReads = () => app.log.filter((l) => /FROM domain_events/.test(l.sql));

      // 20 s of fake time with NO new events: only watermark queries, never a tenant read.
      await clock.advance(20_000);
      expect(tenantReads()).toHaveLength(0);
      const callsWith = (id: string) => watermarkCalls().filter((c) => ((c.params as string[][])[0] ?? []).includes(id)).length;
      expect(callsWith(a.accountId)).toBe(10); // 2 s while a run is active
      expect(callsWith(b.accountId)).toBe(2); // 10 s otherwise
      // One SHARED query per tick regardless of how many accounts are due: 10 ticks, not 12.
      expect(watermarkCalls().length).toBe(10);
      expect(app.log.filter((l) => /SELECT .*FROM (account_members|agent_runs|accounts)/.test(l.sql))).toHaveLength(0);

      // One event for A: exactly ONE tenant read, for A only, delivered to all 10 of A's streams and none of B's.
      const evId = await insertEvent(a.accountId, 'pr.opened');
      app.reset();
      await clock.advance(2_000);
      await sleep(150);
      expect(tenantReads()).toHaveLength(1);
      expect((tenantReads()[0]!.params as unknown[])[0]).toBe(a.accountId);
      const gotA = receivedByStream.slice(0, 10).filter((t) => t.includes(evId)).length;
      const gotB = receivedByStream.slice(10).filter((t) => t.includes(evId)).length;
      expect([gotA, gotB]).toEqual([10, 0]);

      // No further movement -> no further tenant reads.
      app.reset();
      await clock.advance(10_000);
      expect(tenantReads()).toHaveLength(0);

      await Promise.all(readers.map((r) => r.cancel()));
      await eventually(async () => localPoller.stats().subscribers === 0);
      expect(localPoller.stats().timerArmed).toBe(false);
    }, 60000);

    it('polling failures are bounded: three failed polls tell the subscribers to give up and stop polling', async () => {
      const { accountId } = await seedAccountWithMember(admin);
      const clock = new ManualClock(Date.now(), 5);
      const broken = { query: async () => { throw new Error('db down'); } } as unknown as Pool;
      const p = new AccountPoller({ pool: appUserPool, platformOpsPool: broken, clock });
      let failed = 0;
      p.subscribe(accountId, 0n, { onEvents: () => {}, onFail: () => { failed++; } });
      await clock.advance(10_000);
      expect(failed).toBe(1);
      expect(p.stats()).toEqual({ feeds: 0, subscribers: 0, timerArmed: false });
    });
  });

  // -------------------------------------------------------------------
  describe('JSON mode (criterion 8)', () => {
    async function dispatch(req: Request): Promise<Response> {
      return handleEventsRequest(req, targetOf(req), deps);
    }

    it('Accept: application/json returns {data, next_cursor} for the same events, resumable by cursor; sessions are not poll-limited', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const ck = await cookie({ accountId, userId });
      type Page = { data: { id: string; type: string }[]; next_cursor: string; resync?: boolean };
      const get = async (qs = ''): Promise<{ status: number; body: Page; headers: Headers }> => {
        const res = await dispatch(new Request(`http://x/api/v1/events${qs}`, { headers: { cookie: ck, accept: 'application/json' } }));
        return { status: res.status, body: (await res.json()) as Page, headers: res.headers };
      };
      const start = await get();
      expect(start.status).toBe(200);
      expect(start.headers.get('content-type')).toContain('application/json');
      expect(start.body.data).toEqual([]);
      const ids = [await insertEvent(accountId, 'pr.opened'), await insertEvent(accountId, 'budget.exhausted', { budget: 'model' })];
      const page = await get(`?cursor=${encodeURIComponent(start.body.next_cursor)}`);
      expect(page.body.data.map((e: { id: string }) => e.id)).toEqual(ids);
      expect(page.body.data[1]).toMatchObject({ type: 'budget.exhausted', data: { budget: 'model' } });
      // ...identical to what the stream sent for the same events.
      const sse = await connect('/api/v1/events', { cookie: ck, 'last-event-id': start.body.next_cursor });
      await eventually(() => sse.events().length >= 2);
      expect(sse.events().map((f) => JSON.parse(f.data!))).toEqual(page.body.data);
      // Resuming from the returned cursor yields nothing new, and the cursor stays usable.
      const empty = await get(`?cursor=${encodeURIComponent(page.body.next_cursor)}`);
      expect(empty.body.data).toEqual([]);
      const more = await insertEvent(accountId, 'pr.opened');
      const next = await get(`?cursor=${encodeURIComponent(empty.body.next_cursor)}`);
      expect(next.body.data.map((e: { id: string }) => e.id)).toEqual([more]);
      // A session may poll well past 6/min.
      for (let i = 0; i < 10; i++) expect((await get()).status).toBe(200);
      // A forged cursor is a 422 here too.
      expect((await get('?cursor=AAAA')).status).toBe(422);
      // A stale cursor -> resync, with a fresh cursor.
      const stale = sealCursor({ accountId, serial: 1n, issuedAtMs: Date.now() - 9 * 24 * 3600 * 1000 }, process.env);
      const resync = await get(`?cursor=${encodeURIComponent(stale)}`);
      expect(resync.body).toMatchObject({ data: [], resync: true });
    });

    it('the run events JSON page uses listRunEvents: {data, next_cursor}, resumable, redacted, 404 for another account\'s run', async () => {
      const a = await seedAccountWithMember(admin);
      const b = await seedAccountWithMember(admin);
      const runId = await seedRun(a.accountId);
      for (let seq = 1; seq <= 5; seq++) await insertRunEvent(a.accountId, runId, seq, 'message', { text: seq === 3 ? FAKE_SECRETS[0] : `l${seq}` });
      const ck = await cookie(a);
      const get = async (qs: string, who = ck) => dispatch(new Request(`http://x/api/v1/runs/${runId}/events${qs}`, { headers: { cookie: who, accept: 'application/json' } }));
      const p1 = (await (await get('?limit=2')).json()) as { data: { seq: number }[]; next_cursor: string };
      expect(p1.data.map((e) => e.seq)).toEqual([1, 2]);
      expect(p1.next_cursor).toBe('2');
      const p2 = (await (await get(`?cursor=${p1.next_cursor}&limit=10`)).json()) as { data: { seq: number; payload: unknown }[]; next_cursor: string };
      expect(p2.data.map((e) => e.seq)).toEqual([3, 4, 5]);
      expect(JSON.stringify(p2)).not.toContain(FAKE_SECRETS[0]!);
      expect(p2.next_cursor).toBe('5');
      const alias = (await (await get('?after_seq=4')).json()) as { data: { seq: number }[] };
      expect(alias.data.map((e) => e.seq)).toEqual([5]);
      expect((await get('?cursor=1&after_seq=1')).status).toBe(422);
      expect((await get('?cursor=-1')).status).toBe(422);
      expect((await get('', await cookie(b))).status).toBe(404);
    });

    it('a token\'s 7th JSON poll in one minute -> 429 rate_limited with an integer Retry-After (per token, not per tenant)', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { plan: 'scale' });
      const t1 = await mintToken({ accountId, userId });
      const t2 = await mintToken({ accountId, userId });
      const poll = (plaintext: string) =>
        dispatch(new Request('http://x/api/v1/events', { headers: { authorization: `Bearer ${plaintext}`, accept: 'application/json' } }));
      for (let i = 0; i < JSON_POLLS_PER_TOKEN_PER_MINUTE; i++) expect((await poll(t1.plaintext)).status, `poll ${i + 1}`).toBe(200);
      const seventh = await poll(t1.plaintext);
      expect(seventh.status).toBe(429);
      expect(((await seventh.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
      expect(Number.isInteger(Number(seventh.headers.get('retry-after')))).toBe(true);
      expect(JSON_POLLS_PER_TOKEN_PER_MINUTE).toBe(6);
      // A different token of the same tenant has its own budget.
      expect((await poll(t2.plaintext)).status).toBe(200);
      // The window resets: rewind the bucket's window_start.
      await admin.query(`UPDATE rate_limit_windows SET window_start = now() - interval '61 seconds' WHERE bucket_key = $1`, [`json-poll:${t1.id}`]);
      expect((await poll(t1.plaintext)).status).toBe(200);
    });

    it('JSON mode goes through the ordinary dispatcher: identical to handleApiRequest', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const headers = { cookie: await cookie({ accountId, userId }), accept: 'application/json' };
      const viaStream = await dispatch(new Request('http://x/api/v1/events', { headers }));
      const viaApi = await handleApiRequest(new Request('http://x/api/v1/events', { headers }), appUserPool, platformOpsPool, ROUTES);
      expect(viaStream.status).toBe(viaApi.status);
      expect(viaStream.headers.get('cache-control')).toBe(viaApi.headers.get('cache-control'));
    });
  });

  // -------------------------------------------------------------------
  describe('route files (criterion 1)', () => {
    it('both route files set maxDuration = 800, run on Node, and export a GET that is the stream handler', async () => {
      // Read as source, not imported: the route files import Next, which this package does not depend on.
      const routeDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'web', 'app', 'api', 'v1');
      for (const rel of ['events/route.ts', 'runs/[id]/events/route.ts']) {
        const source = readFileSync(path.join(routeDir, rel), 'utf8');
        expect(source, rel).toMatch(/^export const maxDuration = 800;$/m);
        expect(source, rel).toMatch(/^export const runtime = "nodejs";$/m);
        expect(source, rel).toMatch(/^export const dynamic = "force-dynamic";$/m);
        expect(source, rel).toMatch(/^export async function GET\(/m);
        expect(source, rel).toContain('handleEventsRequest');
        // The other methods go to the ordinary dispatcher, so a HEAD can never open a stream.
        expect(source, rel).toMatch(/export async function HEAD\([\s\S]*handleApiHeadRequest/);
      }
      // The lifetime that fits under that ceiling: every possible draw is below it, with headroom for the close.
      expect(LIFETIME_MAX_MS / 1000).toBeLessThan(800);
    });
  });

  // -------------------------------------------------------------------
  describe('authentication and authorization on the stream routes (criterion 10)', () => {
    it('no credential -> 401 JSON; a valid token in ?access_token= is IGNORED (the browser path is the cookie only)', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const token = await mintToken({ accountId, userId });
      for (const path of ['/api/v1/events', `/api/v1/runs/${randomUUID()}/events`]) {
        const bare = await fetch(`${server.url}${path}`, { headers: { accept: 'text/event-stream' } });
        expect(bare.status).toBe(401);
        expect(bare.headers.get('content-type')).toContain('application/json');
        await bare.text();
        const viaQuery = await fetch(`${server.url}${path}?access_token=${token.plaintext}`, { headers: { accept: 'text/event-stream' } });
        expect(viaQuery.status).toBe(401);
        await viaQuery.text();
        const viaQuery2 = await fetch(`${server.url}${path}?token=${token.plaintext}&access_token=${token.plaintext}`, { headers: { accept: 'text/event-stream' } });
        expect(viaQuery2.status).toBe(401);
        await viaQuery2.text();
      }
      // The cookie works without any query token; and a query token does not override a cookie's identity.
      const other = await seedAccountWithMember(admin);
      const c = await connect(`/api/v1/events?access_token=${token.plaintext}`, { cookie: await cookie(other) });
      expect(c.status).toBe(200);
      await eventually(() => leaseCountFor(other.accountId));
      async function leaseCountFor(id: string): Promise<boolean> {
        return (await leaseCount(id)) === 1 && (await leaseCount(accountId)) === 0;
      }
    });

    it('an invalid or revoked bearer token -> 401 invalid_token; a token without the read scope -> 403 insufficient_scope', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const cancelOnly = await mintToken({ accountId, userId }, ['runs:cancel']);
      const revoked = await mintToken({ accountId, userId });
      await admin.query(`UPDATE api_tokens SET revoked_at = now() WHERE id = $1`, [revoked.id]);
      const expectStatus = async (auth: string, status: number, code: string) => {
        const res = await fetch(`${server.url}/api/v1/events`, { headers: { authorization: auth, accept: 'text/event-stream', 'x-forwarded-for': randomUUID() } });
        expect(res.status).toBe(status);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
      };
      await expectStatus('Bearer fxat_notatoken', 401, 'invalid_token');
      await expectStatus(`Bearer ${revoked.plaintext}`, 401, 'invalid_token');
      await expectStatus(`Bearer ${cancelOnly.plaintext}`, 403, 'insufficient_scope');
      expect(await leaseCount(accountId)).toBe(0);
    });

    it('token streams count against the token and tenant per-minute caps like any token request', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { plan: 'scale' });
      const token = await mintToken({ accountId, userId });
      await admin.query(
        `INSERT INTO rate_limit_windows (bucket_key, window_start, request_count) VALUES ($1, now(), 100000) ON CONFLICT (bucket_key) DO UPDATE SET request_count = 100000, window_start = now()`,
        [`token:${token.id}`],
      );
      const res = await fetch(`${server.url}/api/v1/events`, { headers: { authorization: `Bearer ${token.plaintext}`, accept: 'text/event-stream' } });
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBeTruthy();
      await res.text();
      expect(await leaseCount(accountId)).toBe(0);
    });

    it('an SSE frame cannot be forged through event data: hostile kinds/newlines stay inside one JSON data line', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const runId = await seedRun(accountId, 'running');
      const c = await connect(`/api/v1/runs/${runId}/events`, { cookie: await cookie({ accountId, userId }) });
      await insertRunEvent(accountId, runId, 1, 'evil\nevent: revoked\ndata: {}', { text: 'line1\n\nevent: end\ndata: x' });
      await c.waitFor((f) => f.id === '1');
      await sleep(100);
      expect(c.frames.filter((f) => f.event === 'revoked' || f.event === 'end')).toHaveLength(0);
      expect(c.events()).toHaveLength(1);
      expect(JSON.parse(c.events()[0]!.data!).kind).toBe('evil\nevent: revoked\ndata: {}');
    });
  });
});
