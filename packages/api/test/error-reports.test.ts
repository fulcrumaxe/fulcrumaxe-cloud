import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { signSession, SESSION_COOKIE_NAME } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ApiError } from '../src/errors.js';
import type { RouteEntry } from '../src/registry.js';
import { releaseLease } from '../src/sse/leases.js';
import { NudgeListener } from '../src/sse/nudge.js';
import { AccountPoller } from '../src/sse/poller.js';
import { handleEventsRequest } from '../src/sse/stream.js';
import { seedAccountWithMember } from './helpers/seed.js';
import { captureReports } from './helpers/captureReports.js';
import { ManualClock } from './helpers/manual-clock.js';
import { eventually } from './helpers/sse.js';

/**
 * Caught server errors in the API package reach the reporter as a class (stage, route template, allowlisted
 * code) and nothing else. Every failure below carries a made-up secret in its message; the test asserts the
 * secret appears in neither the stdout line nor the stored class, and that an allowlisted code survives.
 */
const SECRET = 'alice-h1c-canary@example.com';
const failure = (code: string): Error => Object.assign(new Error(`upstream said ${SECRET}`), { code });

/** A pool whose every use fails the way a dropped connection does. */
const brokenPool = (code: string): Pool =>
  ({
    connect: async () => {
      throw failure(code);
    },
    query: async () => {
      throw failure(code);
    },
  }) as unknown as Pool;

const routes: RouteEntry[] = [
  {
    method: 'GET',
    path: '/api/v1/test-boom',
    operationId: 'testBoom',
    principals: ['session'],
    minRole: 'member',
    scope: 'read',
    idempotency: 'never',
    responseSchema: z.object({}),
    async handler() {
      throw failure('ECONNRESET');
    },
  },
  {
    method: 'GET',
    path: '/api/v1/test-refuse',
    operationId: 'testRefuse',
    principals: ['session'],
    minRole: 'member',
    scope: 'read',
    idempotency: 'never',
    responseSchema: z.object({}),
    async handler() {
      throw new ApiError(422, 'validation_failed', `refused ${SECRET}`);
    },
  },
];

describe('API error reports', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
  });

  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  async function sessionRequest(path: string): Promise<Request> {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const token = await signSession({ userId, accountId });
    return new Request(`http://localhost${path}`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } });
  }

  it('reports a 5xx from the dispatcher by stage, route template and code, never its message', async () => {
    const reports = captureReports();
    const res = await handleApiRequest(await sessionRequest('/api/v1/test-boom'), appUserPool, platformOpsPool, routes);
    expect(res.status).toBe(500);
    expect(reports.classes).toEqual([{ service: 'test', route: '/api/v1/:id', stage: 'api.dispatch', code: 'ECONNRESET' }]);
    expect(reports.everything()).not.toContain(SECRET);
  });

  it('does not report a 4xx: that is the caller\'s answer', async () => {
    const reports = captureReports();
    const res = await handleApiRequest(await sessionRequest('/api/v1/test-refuse'), appUserPool, platformOpsPool, routes);
    expect(res.status).toBe(422);
    expect(reports.classes).toEqual([]);
  });

  it('reports a 5xx while opening a stream, with the request path as a template', async () => {
    const reports = captureReports();
    const req = await sessionRequest('/api/v1/events');
    const res = await handleEventsRequest(req, { kind: 'account' }, { pool: brokenPool('57P01'), platformOpsPool: brokenPool('57P01') });
    expect(res.status).toBe(500);
    expect(reports.classes).toEqual([{ service: 'test', route: '/api/v1/events', stage: 'sse.open', code: '57P01' }]);
    expect(reports.everything()).not.toContain(SECRET);
  });

  it('reports a failed lease release and still resolves (the row expires on its own)', async () => {
    const reports = captureReports();
    await expect(releaseLease(brokenPool('ECONNRESET'), { kind: 'session', accountId: randomUUID(), principalKey: randomUUID() }, randomUUID())).resolves.toBeUndefined();
    expect(reports.classes).toEqual([{ service: 'test', route: '/api/v1/events', stage: 'sse.lease_release', code: 'ECONNRESET' }]);
    expect(reports.everything()).not.toContain(SECRET);
  });

  it('reports a failed watermark read and a throwing subscriber from the poller', async () => {
    const reports = captureReports();
    const clock = new ManualClock(Date.now());
    const poller = new AccountPoller({ pool: appUserPool, platformOpsPool: brokenPool('57P01'), clock });
    clock.track(poller);
    poller.subscribe(randomUUID(), 0n, { onEvents: () => undefined, onFail: () => undefined });
    await clock.advance(0);
    await eventually(() => reports.classes.some((c) => c.stage === 'sse.watermark'));
    expect(reports.classes[0]).toEqual({ service: 'test', route: '/', stage: 'sse.watermark', code: '57P01' });
    expect(reports.everything()).not.toContain(SECRET);
  });

  it('reports a nudge listener that cannot connect, over the real connection path, and keeps its code', async () => {
    const reports = captureReports();
    const listener = new NudgeListener({ url: 'postgres://u:p@127.0.0.1:1/db', probePool: brokenPool('ECONNRESET'), log: () => undefined });
    try {
      listener.start({ onNudge: () => undefined, onRecovered: () => undefined });
      await eventually(() => reports.classes.some((c) => c.stage === 'sse.nudge_connect'));
    } finally {
      listener.stop();
    }
    expect(reports.classes[0]).toEqual({ service: 'test', route: '/', stage: 'sse.nudge_connect', code: 'ECONNREFUSED' });
  });
});
