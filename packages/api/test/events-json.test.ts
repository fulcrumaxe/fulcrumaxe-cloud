import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { InvalidCursorError } from '../src/errors.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { openCursor, sealCursor } from '../src/sse/cursor.js';
import { JSON_POLLS_PER_TOKEN_PER_MINUTE, accountEventsPage, chargeJsonPoll, runEventsPage } from '../src/sse/json.js';
import { generateToken, displayHint } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { seedAccountWithMember } from './helpers/seed.js';

/** D#31 API-5 criterion 8: the JSON mode of the two event routes, through the real handler. */
const KEY = randomBytes(32).toString('base64');
const ENV = { FX_CURSOR_KEY_V1: KEY };

describe('JSON event pages (D#31 API-5)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let app: Pool;
  let ops: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    app = createPool(process.env.API_DATABASE_URL_APP_USER!);
    ops = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    process.env.FX_CURSOR_KEY_V1 = KEY;
  });

  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    delete process.env.FX_CURSOR_KEY_V1;
    admin.release();
    await adminPool.end();
    await app.end();
    await ops.end();
  });

  async function ev(accountId: string, payload: object = {}): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO domain_events (account_id, type, payload) VALUES ($1, 'pr.opened', $2) RETURNING id`,
      [accountId, JSON.stringify(payload)],
    );
    return rows[0]!.id;
  }

  async function token(accountId: string, userId: string): Promise<{ id: string; plaintext: string }> {
    const plaintext = generateToken();
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at)
       VALUES ($1, $2, $3, $4, ARRAY['read'], now() + interval '90 days') RETURNING id`,
      [accountId, userId, hashToken(plaintext), displayHint(plaintext)],
    );
    return { id: rows[0]!.id, plaintext };
  }

  const dispatch = (req: Request): Promise<Response> => handleApiRequest(req, app, ops, ROUTES);
  async function sessionGet(path: string, identity: { userId: string; accountId: string }): Promise<Response> {
    const cookie = `${SESSION_COOKIE_NAME}=${await signSession(identity)}`;
    return dispatch(new Request(`http://x${path}`, { headers: { cookie, accept: 'application/json' } }));
  }

  describe('account events', () => {
    it('resumes from next_cursor: every event exactly once across pages, and only later events after an idle echo', async () => {
      const { accountId } = await seedAccountWithMember(admin);
      const start = await accountEventsPage(app, accountId, { limit: 50 }, Date.now(), ENV);
      expect(start.data).toEqual([]);
      const ids = [await ev(accountId), await ev(accountId), await ev(accountId)];

      const p1 = await accountEventsPage(app, accountId, { cursor: start.next_cursor, limit: 2 }, Date.now(), ENV);
      expect(p1.data.map((d) => d.id)).toEqual(ids.slice(0, 2));
      const p2 = await accountEventsPage(app, accountId, { cursor: p1.next_cursor, limit: 2 }, Date.now(), ENV);
      expect(p2.data.map((d) => d.id)).toEqual(ids.slice(2));
      const idle = await accountEventsPage(app, accountId, { cursor: p2.next_cursor, limit: 2 }, Date.now(), ENV);
      expect(idle.data).toEqual([]);
      expect(openCursor(idle.next_cursor, accountId, ENV).serial).toBe(openCursor(p2.next_cursor, accountId, ENV).serial);

      const fresh = await ev(accountId);
      const p3 = await accountEventsPage(app, accountId, { cursor: idle.next_cursor, limit: 50 }, Date.now(), ENV);
      expect(p3.data.map((d) => d.id)).toEqual([fresh]);
    });

    it('data carries only the wire fields: id, type, created_at, allowlisted data, never the private serial', async () => {
      const { accountId } = await seedAccountWithMember(admin);
      const zero = sealCursor({ accountId, serial: 0n, issuedAtMs: Date.now() }, ENV);
      await ev(accountId, { pr_number: 7, title: 'must not appear' });
      const page = await accountEventsPage(app, accountId, { cursor: zero, limit: 10 }, Date.now(), ENV);
      expect(Object.keys(page.data[0]!).sort()).toEqual(['created_at', 'data', 'id', 'type']);
      expect(JSON.stringify(page)).not.toContain('must not appear');
    });

    it('a cursor older than retention answers resync:true with no data and a fresh cursor at head', async () => {
      const { accountId } = await seedAccountWithMember(admin);
      const old = sealCursor({ accountId, serial: 0n, issuedAtMs: Date.now() - 8 * 24 * 60 * 60 * 1000 }, ENV);
      await ev(accountId);
      const page = await accountEventsPage(app, accountId, { cursor: old, limit: 50 }, Date.now(), ENV);
      expect(page.resync).toBe(true);
      expect(page.data).toEqual([]);
      const resumed = await accountEventsPage(app, accountId, { cursor: page.next_cursor, limit: 50 }, Date.now(), ENV);
      expect(resumed.resync).toBeUndefined();
      expect(resumed.data).toEqual([]);
    });

    it('over HTTP: a bad cursor is 422 invalid_cursor, and the page shape is {data, next_cursor}', async () => {
      const a = await seedAccountWithMember(admin);
      const bad = await sessionGet('/api/v1/events?cursor=not-a-cursor', a);
      expect(bad.status).toBe(422);
      const ok = await sessionGet('/api/v1/events', a);
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { data: unknown[]; next_cursor: string };
      expect(body.data).toEqual([]);
      expect(typeof body.next_cursor).toBe('string');
      await expect(accountEventsPage(app, a.accountId, { cursor: 'x', limit: 5 }, Date.now(), ENV)).rejects.toBeInstanceOf(InvalidCursorError);
    });
  });

  describe('run events', () => {
    async function seedRun(accountId: string, count: number): Promise<string> {
      const runId = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'build', 'local', 'running')`, [runId, accountId]);
      for (let seq = 1; seq <= count; seq++) {
        await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, 'log', $4)`, [accountId, runId, seq, JSON.stringify({ line: `l${seq}` })]);
      }
      return runId;
    }

    it('resumes from next_cursor (the run seq), and an empty poll echoes the position it was given', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const runId = await seedRun(accountId, 5);
      const principal = { accountId, userId };
      const p1 = await runEventsPage(app, principal, runId, { limit: 2 });
      expect(p1.data.map((d) => d.seq)).toEqual([1, 2]);
      expect(p1.next_cursor).toBe('2');
      const p2 = await runEventsPage(app, principal, runId, { cursor: p1.next_cursor, limit: 10 });
      expect(p2.data.map((d) => d.seq)).toEqual([3, 4, 5]);
      const idle = await runEventsPage(app, principal, runId, { cursor: p2.next_cursor, limit: 10 });
      expect(idle.data).toEqual([]);
      expect(idle.next_cursor).toBe('5');
      await expect(runEventsPage(app, principal, runId, { cursor: '01', limit: 10 })).rejects.toBeInstanceOf(InvalidCursorError);
    });

    it('H14c-3-2c: a run.metering row is platform data -- the JSON page (and its cursor) never carries it', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const runId = await seedRun(accountId, 3);
      await admin.query(`UPDATE run_events SET kind = 'run.metering' WHERE run_id = $1 AND seq = 2`, [runId]);
      const res = await sessionGet(`/api/v1/runs/${runId}/events`, { accountId, userId });
      const page = (await res.json()) as { data: { seq: number; kind: string }[] };
      expect(page.data.map((d) => d.seq)).toEqual([1, 3]);
      const first = await runEventsPage(app, { accountId, userId }, runId, { limit: 1 });
      const next = await runEventsPage(app, { accountId, userId }, runId, { cursor: first.next_cursor, limit: 1 });
      expect(next.data.map((d) => d.seq)).toEqual([3]);
    });

    it('another account\'s run is a 404 over HTTP, and a cursor plus after_seq together is rejected', async () => {
      const a = await seedAccountWithMember(admin);
      const b = await seedAccountWithMember(admin);
      const runB = await seedRun(b.accountId, 1);
      expect((await sessionGet(`/api/v1/runs/${runB}/events`, a)).status).toBe(404);
      const runA = await seedRun(a.accountId, 1);
      expect((await sessionGet(`/api/v1/runs/${runA}/events?cursor=1&after_seq=1`, a)).status).toBe(422);
      const good = await sessionGet(`/api/v1/runs/${runA}/events?after_seq=0`, a);
      expect(good.status).toBe(200);
      expect(((await good.json()) as { data: unknown[] }).data).toHaveLength(1);
    });
  });

  describe('token poll cap (6 per minute)', () => {
    it('the 6th JSON poll is served and the 7th is a 429 with Retry-After, over HTTP', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const t = await token(accountId, userId);
      const get = (): Promise<Response> => dispatch(new Request('http://x/api/v1/events', { headers: { authorization: `Bearer ${t.plaintext}`, accept: 'application/json' } }));
      for (let i = 1; i <= JSON_POLLS_PER_TOKEN_PER_MINUTE; i++) {
        expect((await get()).status, `poll ${i}`).toBe(200);
      }
      const seventh = await get();
      expect(seventh.status).toBe(429);
      expect(Number(seventh.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    });

    it('a session is not metered by the poll cap', async () => {
      const a = await seedAccountWithMember(admin);
      for (let i = 0; i < JSON_POLLS_PER_TOKEN_PER_MINUTE + 3; i++) {
        expect((await sessionGet('/api/v1/events', a)).status).toBe(200);
      }
    });

    it('chargeJsonPoll refuses a token id from another tenant and a token principal without an id, and never charges the real owner', async () => {
      const a = await seedAccountWithMember(admin);
      const b = await seedAccountWithMember(admin);
      const tb = await token(b.accountId, b.userId);
      await expect(chargeJsonPoll(app, { kind: 'token', accountId: a.accountId, tokenId: tb.id })).rejects.toThrow(/does not belong/);
      await expect(chargeJsonPoll(app, { kind: 'token', accountId: b.accountId })).rejects.toThrow(/missing tokenId/);
      // The refused attempts left B's bucket untouched: all six real polls still pass.
      for (let i = 0; i < JSON_POLLS_PER_TOKEN_PER_MINUTE; i++) {
        await chargeJsonPoll(app, { kind: 'token', accountId: b.accountId, tokenId: tb.id });
      }
      await expect(chargeJsonPoll(app, { kind: 'token', accountId: b.accountId, tokenId: tb.id })).rejects.toMatchObject({ status: 429 });
    });
  });
});
