import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { redactEventPayload } from '@fx/core/src/events/redact.js';
import { handleApiRequest } from '../src/handler.js';
import { buildOpenApiDocument } from '../src/openapi.js';
import { ROUTES } from '../src/routes/index.js';
import { runEventsExportRoutes } from '../src/routes/runEventsExport.js';
import { displayHint, generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { seedAccountWithMember } from './helpers/seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'v1', 'exportRunEvents', '200-ok.ndjson');
const lineSchema = z.strictObject({ seq: z.number().int(), kind: z.string(), at: z.string(), payload: z.unknown() });

/** D#45 S8a: `GET /api/v1/runs/{id}/events/export` through the real dispatcher. */
describe('GET /api/v1/runs/{id}/events/export (D#45 S8a)', () => {
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
  });

  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await app.end();
    await ops.end();
  });

  async function seedRun(accountId: string): Promise<string> {
    const runId = randomUUID();
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'build', 'local', 'succeeded')`,
      [runId, accountId],
    );
    return runId;
  }

  async function addEvents(accountId: string, runId: string, events: [number, string, unknown][]): Promise<void> {
    for (const [seq, kind, payload] of events) {
      await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, $4, $5)`, [
        accountId,
        runId,
        seq,
        kind,
        JSON.stringify(payload),
      ]);
    }
  }

  async function mintToken(accountId: string, userId: string, scopes: string[]): Promise<string> {
    const plaintext = generateToken();
    await admin.query(
      `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '90 days')`,
      [accountId, userId, hashToken(plaintext), displayHint(plaintext), scopes],
    );
    return plaintext;
  }

  const dispatch = (req: Request): Promise<Response> => handleApiRequest(req, app, ops, ROUTES);
  async function asSession(p: string, who: { userId: string; accountId: string }): Promise<Response> {
    const cookie = `${SESSION_COOKIE_NAME}=${await signSession(who)}`;
    return dispatch(new Request(`http://localhost${p}`, { headers: { cookie } }));
  }
  const asToken = (p: string, token: string): Promise<Response> =>
    dispatch(new Request(`http://localhost${p}`, { headers: { authorization: `Bearer ${token}` } }));
  const exportPath = (runId: string): string => `/api/v1/runs/${runId}/events/export`;

  it('declares session+token, read scope, member, never idempotent, does not start a run; the OpenAPI document lists the NDJSON body', () => {
    const [entry] = runEventsExportRoutes;
    expect(entry).toMatchObject({
      operationId: 'exportRunEvents',
      principals: ['session', 'token'],
      scope: 'read',
      minRole: 'member',
      idempotency: 'never',
      startsRun: false,
    });
    const pathItem = buildOpenApiDocument(ROUTES).paths['/api/v1/runs/{id}/events/export'] as {
      get: { responses: { '200': { content: Record<string, unknown>; headers: Record<string, unknown> } } };
    };
    const op = pathItem.get;
    expect(Object.keys(op.responses['200'].content)).toEqual(['application/x-ndjson']);
    expect(op.responses['200'].headers['Content-Disposition']).toBeDefined();
  });

  it('serves NDJSON with the attachment header; each line is exactly {seq, kind, at, payload}, in seq order, with no account_id', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const runId = await seedRun(accountId);
    await addEvents(accountId, runId, [
      [1, 'run.created', { role: 'build' }],
      [2, 'agent.output', { text: 'hello' }],
      [3, 'run.status_changed', { from: 'running', to: 'succeeded' }],
    ]);
    const res = await asSession(exportPath(runId), { accountId, userId });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="run-${runId}-events.ndjson"`);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-request-id')).toBeTruthy();
    const text = await res.text();
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.trimEnd().split('\n').map((l) => lineSchema.parse(JSON.parse(l)));
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(lines[1]).toEqual({ seq: 2, kind: 'agent.output', at: expect.any(String), payload: { text: 'hello' } });
    expect(text).not.toContain(accountId);
  });

  it('the checked-in fixture is valid NDJSON in the same line shape', () => {
    const lines = readFileSync(FIXTURE, 'utf8').trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) lineSchema.parse(JSON.parse(line));
  });

  it('a token with read scope exports; a token without it is refused', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const runId = await seedRun(accountId);
    await addEvents(accountId, runId, [[1, 'run.created', {}]]);
    const good = await asToken(exportPath(runId), await mintToken(accountId, userId, ['read']));
    expect(good.status).toBe(200);
    expect((await good.text()).trim().split('\n')).toHaveLength(1);
    const bad = await asToken(exportPath(runId), await mintToken(accountId, userId, ['audit:read']));
    expect(bad.status).toBe(403);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('insufficient_scope');
  });

  it("tenancy: B's run id, a random uuid and a malformed id return 404 with identical bodies apart from request_id", async () => {
    const a = await seedAccountWithMember(admin);
    const b = await seedAccountWithMember(admin);
    const runB = await seedRun(b.accountId);
    await addEvents(b.accountId, runB, [[1, 'agent.output', { text: 'SENTINEL-B-ONLY' }]]);
    const bodies: string[] = [];
    for (const id of [runB, randomUUID(), 'not-a-uuid']) {
      const res = await asSession(exportPath(id), a);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { request_id: string } };
      bodies.push(JSON.stringify({ ...body, error: { ...body.error, request_id: '-' } }));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toContain('SENTINEL-B-ONLY');
  });

  it('sentinel: a secret redacted at write time is not in the export', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const runId = await seedRun(accountId);
    await addEvents(accountId, runId, [[1, 'agent.output', redactEventPayload({ text: 'key sk-ant-api03-FAKE' })]]);
    const text = await (await asSession(exportPath(runId), { accountId, userId })).text();
    expect(text).not.toContain('sk-ant-api03-FAKE');
    expect(JSON.parse(text.trim()).payload).toEqual({ text: 'key [redacted]' });
  });

  it('budget: a 10,000-event run exports in under 3,000 ms (median of 3)', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const runId = await seedRun(accountId);
    await admin.query(
      `INSERT INTO run_events (account_id, run_id, seq, kind, payload)
       SELECT $1, $2, s, 'agent.output', jsonb_build_object('text', repeat('x', 200)) FROM generate_series(1, 10000) AS s`,
      [accountId, runId],
    );
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      const res = await asSession(exportPath(runId), { accountId, userId });
      const text = await res.text();
      times.push(performance.now() - start);
      expect(text.trimEnd().split('\n')).toHaveLength(10000);
    }
    times.sort((x, y) => x - y);
    expect(times[1]).toBeLessThan(3000);
  });
});
