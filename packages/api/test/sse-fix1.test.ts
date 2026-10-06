import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { generateToken, displayHint } from '../src/tokens/format.js';
import { bearerFromAuthorization, hashToken } from '../src/tokens/resolve.js';
import { sessionCookieFromHeader } from '../src/principal.js';
import { extractCredential, isCrossSiteCookieOpen } from '../src/sse/credentials.js';
import { RECHECK_INTERVAL_MS, handleEventsRequest, type StreamDeps, type StreamTarget } from '../src/sse/stream.js';
import { listRunEvents } from '@fx/core/src/events/read.js';
import { MAX_QUEUED_BYTES } from '../src/sse/stream.js';
import { MAX_RUN_EVENT_DATA_BYTES } from '../src/sse/views.js';
import { SESSION_STREAMS_PER_USER } from '../src/sse/leases.js';
import { AccountPoller, DEFAULT_SETTLE_MS, MIN_SETTLE_MS, settleMsFromEnv } from '../src/sse/poller.js';
import { seedAccountWithMember } from './helpers/seed.js';
import { ManualClock } from './helpers/manual-clock.js';
import { countingPool, eventually, openSse, sleep, startServer, type SseConnection, type TestServer } from './helpers/sse.js';

const CURSOR_KEY = randomBytes(32).toString('base64');

/** Secrets in every shape the shared redactor knows, old and new (D#31 API-5b fix round 1, security S1). */
const SHAPES: Record<string, string> = {
  fxat: `fxat_${'A1b2C3d4E5'.repeat(5)}xyz9`.slice(0, 54),
  whsec: `whsec_${'QWxhZGRpbjpvcGVuIHNlc2FtZQ'.repeat(2)}==`,
  vck: 'vck_abcdefghij0123456789',
  ghs: `ghs_${'abcdefghijklmnopqrstuvwxyz0123'}`,
  sk_live: 'sk_live_abcdefghij0123456789',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk',
  ghp: `ghp_${'A1b2C3d4E5'.repeat(4)}`,
  gho: `gho_${'A1b2C3d4E5'.repeat(4)}`,
  github_pat: `github_pat_11ABCDEFG0${'a1B2c3D4e5_'.repeat(5)}`,
  sk_ant_api03: `sk-ant-api03-${'aB1-_cD2eF'.repeat(5)}`,
  sk_ant: `sk-ant-${'aB1cD2eF3g'.repeat(3)}`,
  akia: 'AKIAABCDEFGHIJKLMNOP',
};

/** A pool that fails `connect` on demand, to model transient database errors. */
function flakyPool(inner: Pool): { pool: Pool; failNext(n: number): void } {
  let fail = 0;
  const pool = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'connect') {
        return async (...args: unknown[]) => {
          if (fail > 0) {
            fail--;
            throw new Error('transient connection failure');
          }
          return (target.connect as (...a: unknown[]) => Promise<PoolClient>)(...args);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { pool, failNext: (n) => void (fail = n) };
}

/** A pool whose `INSERT INTO stream_leases` waits on a gate while armed, to hold a lease acquisition in flight. */
function gatedLeasePool(inner: Pool): { pool: Pool; arm(): void; open(): void; reached: Promise<void> } {
  let gate: Promise<void> | undefined;
  let release!: () => void;
  let reachedResolve!: () => void;
  const reached = new Promise<void>((resolve) => (reachedResolve = resolve));
  const wrapClient = (client: PoolClient): PoolClient =>
    new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return async (...args: unknown[]) => {
            const sql = typeof args[0] === 'string' ? args[0] : '';
            if (gate && /INSERT INTO stream_leases/.test(sql)) {
              reachedResolve();
              await gate;
            }
            return (target.query as (...a: unknown[]) => unknown)(...args);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  const pool = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'connect') {
        return async (...args: unknown[]) => wrapClient(await (target.connect as (...a: unknown[]) => Promise<PoolClient>)(...args));
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return {
    pool,
    arm: () => void (gate = new Promise<void>((resolve) => (release = resolve))),
    open: () => release(),
    reached,
  };
}

describe('D#31 API-5b fix round 1', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let poller: AccountPoller;
  let server: TestServer;
  let deps: StreamDeps;
  const openConnections: SseConnection[] = [];
  const rawSockets: net.Socket[] = [];

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    process.env.FX_CURSOR_KEY_V1 = CURSOR_KEY;
    poller = new AccountPoller({ pool: appUserPool, platformOpsPool, activeIntervalMs: 40, idleIntervalMs: 40 });
    deps = { pool: appUserPool, platformOpsPool, poller, runPollIntervalMs: 40, stallTimeoutMs: 300 };
    server = await startServer((req) => handleEventsRequest(req, targetOf(req), deps));
  });

  afterEach(() => {
    for (const c of openConnections.splice(0)) c.abort();
    for (const s of rawSockets.splice(0)) s.destroy();
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

  async function cookie(identity: { userId: string; accountId: string }): Promise<string> {
    return `${SESSION_COOKIE_NAME}=${await signSession(identity, process.env, { epoch: 0 })}`;
  }

  async function mintToken(identity: { accountId: string; userId: string }): Promise<{ id: string; plaintext: string }> {
    const plaintext = generateToken();
    const inserted = await insertApiToken(appUserPool, {
      accountId: identity.accountId,
      createdBy: identity.userId,
      tokenHash: hashToken(plaintext),
      displayHint: displayHint(plaintext),
      scopes: ['read'],
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    });
    return { id: inserted.id, plaintext };
  }

  async function seedRun(accountId: string, status = 'running'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'build', 'local', $3)`, [id, accountId, status]);
    return id;
  }

  async function insertRunEvent(accountId: string, runId: string, seq: number, kind: string, payload: unknown): Promise<void> {
    await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, $4, $5::jsonb)`, [
      accountId,
      runId,
      seq,
      kind,
      JSON.stringify(payload),
    ]);
  }

  /** `count` events of about `bytes` payload bytes each, in one statement. */
  async function seedBigEvents(accountId: string, runId: string, count: number, bytes: number): Promise<void> {
    await admin.query(
      `INSERT INTO run_events (account_id, run_id, seq, kind, payload)
       SELECT $1, $2, g, 'message', jsonb_build_object('text', repeat('x', $4::int))
         FROM generate_series(1, $3::int) g`,
      [accountId, runId, count, bytes],
    );
  }

  async function leaseCount(accountId: string): Promise<number> {
    const { rows } = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM stream_leases WHERE account_id = $1`, [accountId]);
    return rows[0]!.n;
  }

  async function connect(path: string, headers: Record<string, string>): Promise<SseConnection> {
    const c = await openSse(`${server.url}${path}`, headers);
    openConnections.push(c);
    return c;
  }

  /** A raw TCP client that sends the request and then never reads a byte. */
  async function pausedClient(path: string, headers: Record<string, string>): Promise<net.Socket> {
    const url = new URL(server.url);
    const socket = net.connect({ host: url.hostname, port: Number(url.port) });
    rawSockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const lines = [`GET ${path} HTTP/1.1`, `Host: ${url.host}`, 'Accept: text/event-stream', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''];
    socket.write(lines.join('\r\n'));
    socket.pause();
    socket.on('error', () => {});
    return socket;
  }

  /** Resolves once `bytesWritten` has not moved for `quietMs`. */
  async function untilServerStalls(quietMs = 700, timeoutMs = 25_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let last = -1;
    let since = Date.now();
    for (;;) {
      const now = server.stats.bytesWritten;
      if (now !== last) {
        last = now;
        since = Date.now();
      } else if (Date.now() - since >= quietMs) {
        return now;
      }
      if (Date.now() > deadline) throw new Error('the server never stalled');
      await sleep(50);
    }
  }

  // -------------------------------------------------------------------
  describe('M1: a client that stops reading cannot pin unbounded memory or free its lease early', () => {
    it('an unread stream is dropped with an error (its queue is discarded, not delivered), and its lease is released by the drop itself', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const runId = await seedRun(accountId);
      // 40 events of 60 KB: 2.4 MB, more than the 1 MiB byte bound.
      await seedBigEvents(accountId, runId, 40, 60_000);
      const socketGone = new AbortController();
      // Keep the Request itself referenced: a Request only weakly follows the signal it was given, so once the
      // Request is garbage-collected an abort never reaches req.signal (in production Next holds the request).
      const req = new Request(`http://x/api/v1/runs/${runId}/events`, {
        headers: { cookie: await cookie({ accountId, userId }), accept: 'text/event-stream' },
        signal: socketGone.signal,
      });
      const res = await handleEventsRequest(req, { kind: 'run', runId }, deps);
      expect(res.status).toBe(200);
      await sleep(900); // nobody reads: the queue fills to the byte bound, the stall timer (300 ms here) fires, the stream is dropped
      expect(await leaseCount(accountId)).toBe(0); // the drop released it; nothing waits for a socket close
      const reader = res.body!.getReader();
      // The stream is errored: the frames that had piled up are gone, not handed to the reader.
      await expect(reader.read()).rejects.toThrow();
      expect(req.signal.aborted).toBe(false);
      socketGone.abort(); // a late abort after the drop is a no-op: the lease is not released twice
      await eventually(() => req.signal.aborted);
      await sleep(100);
      expect(await leaseCount(accountId)).toBe(0);
    });

    it('a real paused socket through a drain-aware pipe: the server stops pulling, the memory stays bounded, the drop frees the lease while the socket is still open', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const runId = await seedRun(accountId);
      const events = 700;
      const eventBytes = 60_000;
      await seedBigEvents(accountId, runId, events, eventBytes);
      const total = events * eventBytes;
      const before = server.stats.bytesWritten;
      const socket = await pausedClient(`/api/v1/runs/${runId}/events`, { Cookie: await cookie({ accountId, userId }) });
      const pulled = (await untilServerStalls()) - before;
      // The pipe was stalled by the client's full buffers, not run to the end: what it pulled is bounded by the
      // kernel's socket buffers, not by the size of the run. (Before the fix the whole run was buffered server-side.)
      expect(pulled).toBeLessThan(total / 2);
      await sleep(400); // past the 300 ms stall timer: the stream is dropped, and the socket is still open
      expect(await leaseCount(accountId)).toBe(0);
      expect(socket.destroyed).toBe(false);
      socket.destroy();
      await sleep(100);
      expect(await leaseCount(accountId)).toBe(0);
    }, 40_000);

    it('N paused readers cannot exceed the lease cap while they are within the stall window: with 3 stalled sockets the 4th open is refused, and a freed socket frees a slot', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const runId = await seedRun(accountId);
      await seedBigEvents(accountId, runId, 700, 60_000);
      const ck = await cookie({ accountId, userId });
      const stall = deps.stallTimeoutMs;
      deps.stallTimeoutMs = 20_000; // long enough that no drop happens inside this test
      try {
        const paused: net.Socket[] = [];
        for (let i = 0; i < SESSION_STREAMS_PER_USER; i++) paused.push(await pausedClient(`/api/v1/runs/${runId}/events`, { Cookie: ck }));
        await eventually(async () => (await leaseCount(accountId)) === SESSION_STREAMS_PER_USER);
        await untilServerStalls();
        expect(await leaseCount(accountId)).toBe(SESSION_STREAMS_PER_USER); // every stalled stream still holds its slot
        const over = await fetch(`${server.url}/api/v1/events`, { headers: { cookie: ck, accept: 'text/event-stream' } });
        expect(over.status).toBe(429);
        expect(((await over.json()) as { error: { code: string } }).error.code).toBe('stream_limit');
        paused[0]!.destroy();
        await eventually(async () => (await leaseCount(accountId)) === SESSION_STREAMS_PER_USER - 1);
        const again = await connect('/api/v1/events', { cookie: ck });
        expect(again.status).toBe(200);
      } finally {
        deps.stallTimeoutMs = stall;
      }
    }, 60_000);

    // M1-r2. Under `next start` the host closes a dropped stream's socket itself once the client reads again,
    // and `req.signal` never fires for that close (the harness in helpers/sse.ts mirrors Next's pipe for this:
    // it parks on `drain`, then destroys the response without aborting the signal). A lease that waited for the
    // signal was renewed by the recheck timer until the drawn lifetime, and three such streams locked the user out.
    it('a dropped stream whose socket the server closes later, without req.signal firing, holds no lease: three of them do not lock the user out', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const runId = await seedRun(accountId);
      await seedBigEvents(accountId, runId, 700, 60_000);
      const ck = await cookie({ accountId, userId });
      for (let i = 0; i < SESSION_STREAMS_PER_USER; i++) {
        const socket = await pausedClient(`/api/v1/runs/${runId}/events`, { Cookie: ck });
        let closed = false;
        socket.on('close', () => (closed = true));
        await eventually(async () => (await leaseCount(accountId)) === 1);
        // Never read: the 300 ms stall timer drops the stream. The lease is released by the drop, the socket is not closed yet.
        await eventually(async () => (await leaseCount(accountId)) === 0);
        expect(closed).toBe(false);
        // The client reads again: the host now closes the socket itself, and nothing tells the handler.
        socket.resume();
        await eventually(() => closed);
        await sleep(100);
        expect(await leaseCount(accountId)).toBe(0);
      }
      const fresh = await connect('/api/v1/events', { cookie: ck });
      expect(fresh.status).toBe(200);
    }, 60_000);

    it('a drop is a full exit: it releases the lease once, leaves no timer armed, and a late cancel or abort releases nothing more', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const runId = await seedRun(accountId);
      await seedBigEvents(accountId, runId, 40, 60_000);
      const clock = new ManualClock();
      const cp = countingPool(appUserPool);
      const socketGone = new AbortController();
      const req = new Request(`http://x/api/v1/runs/${runId}/events`, {
        headers: { cookie: await cookie({ accountId, userId }), accept: 'text/event-stream' },
        signal: socketGone.signal,
      });
      const res = await handleEventsRequest(req, { kind: 'run', runId }, { ...deps, pool: cp.pool, clock });
      expect(res.status).toBe(200);
      expect(await leaseCount(accountId)).toBe(1);
      await sleep(500); // nobody reads: the queue fills and the replay parks on the stall timer
      clock.advance(300); // the stall timeout (deps.stallTimeoutMs) elapses: the stream is dropped
      await eventually(async () => (await leaseCount(accountId)) === 0);
      const releases = () => cp.count(/DELETE FROM stream_leases WHERE id = /);
      expect(releases()).toBe(1);
      expect(clock.pendingTimers()).toBe(0); // no recheck (it would renew the lease), lifetime, heartbeat or idle timer survives
      socketGone.abort();
      await res.body!.cancel().catch(() => {});
      await sleep(150);
      expect(releases()).toBe(1);
      expect(cp.count(/UPDATE stream_leases/)).toBe(0);
      expect(await leaseCount(accountId)).toBe(0);
    });

    it('a run event over the wire cap keeps its seq, kind and time, replaces its payload with a marker, and does not drop the stream', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const runId = await seedRun(accountId);
      const ck = await cookie({ accountId, userId });
      const s = await connect(`/api/v1/runs/${runId}/events`, { cookie: ck });
      await s.waitFor((f) => f.comment === 'ok');
      await insertRunEvent(accountId, runId, 1, 'message', { text: 'y'.repeat(500_000) });
      await insertRunEvent(accountId, runId, 2, 'message', { text: 'small' });
      const big = await s.waitFor((f) => f.id === '1');
      const small = await s.waitFor((f) => f.id === '2');
      const data = JSON.parse(big.data!);
      expect(data.seq).toBe(1);
      expect(data.kind).toBe('message');
      expect(data.payload.truncated).toBe(true);
      expect(data.payload.original_bytes).toBeGreaterThan(500_000);
      expect(big.raw.length).toBeLessThan(2_000);
      expect(JSON.parse(small.data!).payload).toEqual({ text: 'small' });
      // The JSON mode still returns the full payload.
      const json = await fetch(`${server.url}/api/v1/runs/${runId}/events`, { headers: { cookie: ck, accept: 'application/json' } });
      expect(json.status).toBe(200);
      const page = (await json.json()) as { data: { payload: { text: string } }[] };
      expect(page.data[0]!.payload.text.length).toBe(500_000);
    });
  });

  // -------------------------------------------------------------------
  describe('R1: a replay page is bounded by bytes, not just by 200 rows', () => {
    const bounds = { payloadCapBytes: MAX_RUN_EVENT_DATA_BYTES, pageBudgetBytes: MAX_QUEUED_BYTES };

    it('a page of large events stops at the byte budget, points at the last row it returned, and paging still reaches every event once', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const runId = await seedRun(accountId);
      await seedBigEvents(accountId, runId, 200, 60_000); // 12 MB if one page held all of them
      const ctx = { pool: appUserPool, principal: { accountId, userId } };
      const first = await listRunEvents(ctx, runId, { afterSeq: 0, limit: 200, byteBounds: bounds });
      const held = first.data.reduce((n, e) => n + JSON.stringify(e.payload).length, 0);
      expect(first.data.length).toBeGreaterThan(1);
      expect(first.data.length).toBeLessThan(25);
      expect(held).toBeLessThan(MAX_QUEUED_BYTES + MAX_RUN_EVENT_DATA_BYTES);
      expect(first.next_after_seq).toBe(first.data[first.data.length - 1]!.seq);
      const seen: number[] = [];
      let after = 0;
      for (;;) {
        const page = await listRunEvents(ctx, runId, { afterSeq: after, limit: 200, byteBounds: bounds });
        seen.push(...page.data.map((e) => e.seq));
        if (page.next_after_seq === null) break;
        after = page.next_after_seq;
      }
      expect(seen).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    });

    it('a payload over the per-event cap is replaced by the marker in SQL; small events and the unbounded read are unchanged', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const runId = await seedRun(accountId);
      await insertRunEvent(accountId, runId, 1, 'message', { text: 'small' });
      await insertRunEvent(accountId, runId, 2, 'message', { text: 'y'.repeat(300_000) });
      await insertRunEvent(accountId, runId, 3, 'message', { text: 'small too' });
      const ctx = { pool: appUserPool, principal: { accountId, userId } };
      const bounded = await listRunEvents(ctx, runId, { afterSeq: 0, limit: 200, byteBounds: bounds });
      expect(bounded.next_after_seq).toBeNull();
      expect(bounded.data.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(bounded.data[0]!.payload).toEqual({ text: 'small' });
      expect(bounded.data[1]!.payload).toMatchObject({ truncated: true });
      expect((bounded.data[1]!.payload as { original_bytes: number }).original_bytes).toBeGreaterThan(300_000);
      expect(bounded.data[2]!.payload).toEqual({ text: 'small too' });
      const plain = await listRunEvents(ctx, runId, { afterSeq: 0, limit: 2 });
      expect(plain.data.map((e) => e.seq)).toEqual([1, 2]);
      expect(plain.next_after_seq).toBe(2);
      expect((plain.data[1]!.payload as { text: string }).text.length).toBe(300_000);
      // The row limit still applies together with the byte bounds.
      const limited = await listRunEvents(ctx, runId, { afterSeq: 0, limit: 2, byteBounds: bounds });
      expect(limited.data.map((e) => e.seq)).toEqual([1, 2]);
      expect(limited.next_after_seq).toBe(2);
    });
  });

  // -------------------------------------------------------------------
  describe('recheck(): a lease re-acquired after finish() is released, not stranded', () => {
    it('aborting the request while the re-check is re-acquiring a missing lease leaves no lease row behind', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const gated = gatedLeasePool(appUserPool);
      const clock = new ManualClock(Date.now(), 40);
      const controller = new AbortController();
      const req = new Request('http://x/api/v1/events', { headers: { cookie: await cookie({ accountId, userId }), accept: 'text/event-stream' }, signal: controller.signal });
      const res = await handleEventsRequest(
        req,
        { kind: 'account' },
        {
          pool: gated.pool,
          platformOpsPool,
          clock,
          poller: new AccountPoller({ pool: appUserPool, platformOpsPool, clock, idleIntervalMs: 120_000, activeIntervalMs: 120_000 }),
        },
      );
      const reader = res.body!.getReader();
      void (async () => {
        try {
          for (;;) if ((await reader.read()).done) break;
        } catch {
          // closed
        }
      })();
      expect(await leaseCount(accountId)).toBe(1);
      // The lease row vanishes (expired while the process was starved), so the re-check has to take a fresh one.
      await admin.query(`DELETE FROM stream_leases WHERE account_id = $1`, [accountId]);
      gated.arm();
      void clock.advance(RECHECK_INTERVAL_MS);
      await gated.reached; // the re-check is now inside acquireLease's INSERT
      controller.abort(); // finish() runs and releases the OLD lease id
      await sleep(150);
      gated.open();
      await eventually(async () => (await leaseCount(accountId)) === 0, 5000);
      await sleep(200);
      expect(await leaseCount(accountId)).toBe(0);
      expect(req.signal.aborted).toBe(true); // also keeps `req` (and so its signal's link to `controller`) alive
    });
  });

  // -------------------------------------------------------------------
  describe('transient database errors on a run stream', () => {
    it('two failed cycles in a row are retried and the stream keeps delivering; the third ends it with event: error', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const runId = await seedRun(accountId);
      const flaky = flakyPool(appUserPool);
      const res = await handleEventsRequest(
        new Request(`http://x/api/v1/runs/${runId}/events`, { headers: { cookie: await cookie({ accountId, userId }), accept: 'text/event-stream' } }),
        { kind: 'run', runId },
        { ...deps, pool: flaky.pool },
      );
      let text = '';
      let done = false;
      const reader = res.body!.getReader();
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
      await eventually(() => text.includes(': ok'));
      flaky.failNext(2);
      await insertRunEvent(accountId, runId, 1, 'message', { n: 1 });
      await eventually(() => text.includes('"seq":1'));
      expect(done).toBe(false);
      expect(text).not.toContain('event: error');
      flaky.failNext(3);
      await eventually(() => done);
      expect(text).toContain('event: error');
      expect(text).toContain('"code":"internal_error"');
    });
  });

  // -------------------------------------------------------------------
  describe('S2: a cookie-authenticated stream open must be same-origin', () => {
    it('cross-site and same-site Sec-Fetch-Site, and a foreign Origin, are refused with 403 before any lease; same-origin, none, a matching Origin and no headers are served', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const ck = await cookie({ accountId, userId });
      const host = new URL(server.url).host;
      const runId = await seedRun(accountId);
      for (const path of ['/api/v1/events', `/api/v1/runs/${runId}/events`]) {
        const refused: Record<string, string>[] = [
          { 'sec-fetch-site': 'cross-site' },
          { 'sec-fetch-site': 'same-site' },
          { 'sec-fetch-site': 'cross-site', origin: `http://${host}` },
          { origin: 'https://evil.example' },
          { origin: 'null' },
        ];
        for (const headers of refused) {
          const res = await fetch(`${server.url}${path}`, { headers: { cookie: ck, accept: 'text/event-stream', ...headers } });
          expect(res.status, JSON.stringify(headers)).toBe(403);
          expect(res.headers.get('content-type')).toContain('application/json');
          expect(((await res.json()) as { error: { code: string } }).error.code, JSON.stringify(headers)).toBe('cross_site_refused');
          expect(await leaseCount(accountId)).toBe(0);
        }
        const served: Record<string, string>[] = [{ 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, { origin: `http://${host}` }, {}];
        for (const headers of served) {
          const c = await connect(path, { cookie: ck, ...headers });
          expect(c.status, JSON.stringify(headers)).toBe(200);
          c.abort();
          await c.closed;
          await eventually(async () => (await leaseCount(accountId)) === 0);
        }
      }
    });

    it('a bearer token is not an ambient credential: it is not origin-checked', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const token = await mintToken({ accountId, userId });
      const c = await connect('/api/v1/events', { authorization: `Bearer ${token.plaintext}`, 'sec-fetch-site': 'cross-site', origin: 'https://other.example' });
      expect(c.status).toBe(200);
    });

    it('isCrossSiteCookieOpen: the decision table', () => {
      const req = (h: Record<string, string>) => new Request('http://app.example/api/v1/events', { headers: h });
      expect(isCrossSiteCookieOpen(req({}))).toBe(false);
      expect(isCrossSiteCookieOpen(req({ 'sec-fetch-site': 'same-origin' }))).toBe(false);
      expect(isCrossSiteCookieOpen(req({ 'sec-fetch-site': 'NONE' }))).toBe(false);
      expect(isCrossSiteCookieOpen(req({ 'sec-fetch-site': 'cross-site' }))).toBe(true);
      expect(isCrossSiteCookieOpen(req({ 'sec-fetch-site': 'same-site' }))).toBe(true);
      expect(isCrossSiteCookieOpen(req({ host: 'app.example', origin: 'https://app.example' }))).toBe(false);
      expect(isCrossSiteCookieOpen(req({ host: 'app.example', origin: 'https://evil.example' }))).toBe(true);
      expect(isCrossSiteCookieOpen(req({ host: 'app.example', origin: 'not a url' }))).toBe(true);
      expect(isCrossSiteCookieOpen(req({ 'x-forwarded-host': 'app.example', host: 'internal:3000', origin: 'https://app.example' }))).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  describe('S1: redaction covers object keys and the GitHub / Anthropic / AWS shapes, in the live stream and in JSON mode', () => {
    it.each(Object.entries(SHAPES))('%s: as a value, as a key, and as a kind, on the stream and in JSON mode', async (_name, secret) => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const runId = await seedRun(accountId);
      const ck = await cookie({ accountId, userId });
      const s = await connect(`/api/v1/runs/${runId}/events`, { cookie: ck });
      await s.waitFor((f) => f.comment === 'ok');
      // Raw INSERTs, bypassing redact-at-write.
      await insertRunEvent(accountId, runId, 1, 'message', { [secret]: 'as-a-key', nested: { [`prefix_${secret}`]: [{ [secret]: 1 }] }, text: `as a value: ${secret}` });
      await insertRunEvent(accountId, runId, 2, secret, { plain: 'ok' });
      await s.waitFor((f) => f.id === '2');
      await sleep(50);
      const json = await (await fetch(`${server.url}/api/v1/runs/${runId}/events`, { headers: { cookie: ck, accept: 'application/json' } })).text();
      for (const wire of [s.text(), json]) {
        expect(wire).not.toContain(secret);
        expect(wire).toContain('[redacted]');
        expect(wire).toContain('as-a-key'); // the value under a redacted key is kept
      }
    });
  });

  // -------------------------------------------------------------------
  describe('credential parsing is shared with the request path', () => {
    it('extractCredential returns exactly what principal.ts and tokens/resolve.ts parse', () => {
      const sessionCookies = [
        `${SESSION_COOKIE_NAME}=abc.def`,
        `other=1; ${SESSION_COOKIE_NAME}=a%20b; x=2`,
        `${SESSION_COOKIE_NAME}=%E0%A4%A`, // undecodable: treated as absent
        `${SESSION_COOKIE_NAME}=`,
        'x=1',
      ];
      for (const header of sessionCookies) {
        const req = new Request('http://x/api/v1/events', { headers: { cookie: header } });
        const expected = sessionCookieFromHeader(req);
        const got = extractCredential(req);
        if (expected === undefined) expect(got, header).toBeNull();
        else expect(got, header).toEqual({ kind: 'session', cookie: expected });
      }
      for (const header of ['Bearer fxat_abc', 'bearer   fxat_abc  ', 'fxat_abc']) {
        const req = new Request('http://x/api/v1/events', { headers: { authorization: header } });
        expect(extractCredential(req)).toEqual({ kind: 'token', bearer: bearerFromAuthorization(header) });
      }
    });
  });

  // -------------------------------------------------------------------
  describe('API-5-SETTLE 1 (C21 section 1): the default settle window is 1000 ms', () => {
    it('unset under NODE_ENV=production resolves to 1000, and every malformed value falls back to 1000, not 3000', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(DEFAULT_SETTLE_MS).toBe(1000);
      expect(settleMsFromEnv({ NODE_ENV: 'production' })).toBe(1000);
      for (const v of ['0', '0e0', '0.5', '0x10', '-1', 'NaN', '', ' 7 ', '999', '60001']) {
        expect(settleMsFromEnv({ NODE_ENV: 'production', FX_EVENTS_SETTLE_MS: v }), v).toBe(1000);
      }
      // The floor, the ceiling and strict parsing are unchanged.
      expect(settleMsFromEnv({ NODE_ENV: 'production', FX_EVENTS_SETTLE_MS: '1000' })).toBe(1000);
      expect(settleMsFromEnv({ NODE_ENV: 'production', FX_EVENTS_SETTLE_MS: '3000' })).toBe(3000);
      expect(settleMsFromEnv({ NODE_ENV: 'production', FX_EVENTS_SETTLE_MS: '60000' })).toBe(60000);
      warn.mockRestore();
    });

    it('the benchmark harness mirrors the server default and floor, and records the effective value in its results', () => {
      const src = readFileSync(new URL('../bench/sse-packing.mjs', import.meta.url), 'utf8');
      expect(Number(/const DEFAULT_SETTLE_MS = (\d+);/.exec(src)?.[1])).toBe(DEFAULT_SETTLE_MS);
      expect(Number(/const MIN_SETTLE_MS = (\d+);/.exec(src)?.[1])).toBe(MIN_SETTLE_MS);
      expect(src).toContain('fx_events_settle_ms_env');
      expect(src).toContain('settle_ms: SETTLE_MS');
    });
  });
});
