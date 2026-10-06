import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { runActionDeps } from '../src/routes/run-actions.js';
import { HttpRunActionSignal, KICK_TIMEOUT_MS, kickHeader } from '../src/runActions/httpSignal.js';
import { seedAccountWithMember } from './helpers/seed.js';

/** The vector packages/pipeline's kick test verifies with its own code: the two sides must agree on it. */
export const VECTOR = {
  secret: 'kick-test-secret',
  timestamp: 1_700_000_000,
  body: '{"actionId":"11111111-1111-4111-8111-111111111111"}',
  sig: 'd663602c8dffed01a571b48d351906f96ae59b9ae0d6cd2fbb360de89c8b52a3',
};
const MSG = { actionId: '11111111-1111-4111-8111-111111111111', accountId: randomUUID(), kind: 'cancel_run' as const };

interface Seen {
  url: string;
  init: RequestInit;
}

function recordingFetch(respond: () => Response | Promise<Response>): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return respond();
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const options = (fetchImpl: typeof fetch, extra = {}) => ({
  url: 'https://kick.example.test/api/internal/run-actions/kick',
  secret: VECTOR.secret,
  nowSeconds: () => VECTOR.timestamp,
  fetchImpl,
  ...extra,
});

describe('D#2 H14c-3b C1: HttpRunActionSignal', () => {
  it('the signature vector: X-Fx-Kick is t=<unix>,sig=<hex HMAC-SHA256 of "<t>.<body>">', () => {
    expect(kickHeader(VECTOR.secret, VECTOR.timestamp, VECTOR.body)).toBe(`t=${VECTOR.timestamp},sig=${VECTOR.sig}`);
  });

  it('POSTs only the request id, signed, to the configured url', async () => {
    const { fetchImpl, seen } = recordingFetch(() => new Response(null, { status: 202 }));
    await new HttpRunActionSignal(options(fetchImpl)).signal(MSG);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://kick.example.test/api/internal/run-actions/kick');
    expect(seen[0]!.init.method).toBe('POST');
    expect(seen[0]!.init.body).toBe(VECTOR.body); // the account and kind are not sent
    expect((seen[0]!.init.headers as Record<string, string>)['x-fx-kick']).toBe(`t=${VECTOR.timestamp},sig=${VECTOR.sig}`);
    expect(seen[0]!.init.redirect).toBe('error');
  });

  it('sends x-vercel-protection-bypass only when a bypass secret is configured', async () => {
    const withIt = recordingFetch(() => new Response(null, { status: 202 }));
    await new HttpRunActionSignal(options(withIt.fetchImpl, { bypassSecret: 'bypass-value' })).signal(MSG);
    expect((withIt.seen[0]!.init.headers as Record<string, string>)['x-vercel-protection-bypass']).toBe('bypass-value');
    for (const bypassSecret of [undefined, '']) {
      const without = recordingFetch(() => new Response(null, { status: 202 }));
      await new HttpRunActionSignal(options(without.fetchImpl, { bypassSecret })).signal(MSG);
      expect(Object.keys(without.seen[0]!.init.headers as object)).not.toContain('x-vercel-protection-bypass');
    }
  });

  it('records a non-ok kick with its status only, and does not throw', async () => {
    const lines: string[] = [];
    const { fetchImpl } = recordingFetch(() => new Response('secret-body kick.example.test', { status: 401 }));
    await expect(new HttpRunActionSignal(options(fetchImpl, { bypassSecret: 'bypass-value', log: (l: string) => lines.push(l) })).signal(MSG)).resolves.toBeUndefined();
    expect(lines).toEqual(['run-action kick: refused status=401']);
  });

  it('records a failed kick by error name only, does not throw, and logs nothing on success', async () => {
    const lines: string[] = [];
    const boom = (async () => { throw Object.assign(new Error('connect to kick.example.test failed'), { name: 'TypeError' }); }) as unknown as typeof fetch;
    await expect(new HttpRunActionSignal(options(boom, { log: (l: string) => lines.push(l) })).signal(MSG)).resolves.toBeUndefined();
    expect(lines).toEqual(['run-action kick: failed TypeError']);
    const ok = recordingFetch(() => new Response(null, { status: 202 }));
    await new HttpRunActionSignal(options(ok.fetchImpl, { log: (l: string) => lines.push(l) })).signal(MSG);
    expect(lines).toHaveLength(1);
  });

  it('a throwing logger never reaches the request', async () => {
    const { fetchImpl } = recordingFetch(() => new Response(null, { status: 500 }));
    await expect(new HttpRunActionSignal(options(fetchImpl, { log: () => { throw new Error('x'); } })).signal(MSG)).resolves.toBeUndefined();
  });

  it('gives up after 2 s: the default timeout is 2000 ms and a hung kick ends as an abort, not a hang', async () => {
    expect(KICK_TIMEOUT_MS).toBe(2000);
    let aborted = false;
    const hung = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => {
          aborted = true;
          reject(init.signal!.reason);
        });
      })) as unknown as typeof fetch;
    const started = Date.now();
    await expect(new HttpRunActionSignal(options(hung, { timeoutMs: 50 })).signal(MSG)).resolves.toBeUndefined();
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('never throws to the caller: a network error, a 500 and a throwing fetch all resolve', async () => {
    const boom = (async () => {
      throw new Error('ECONNREFUSED secret-host');
    }) as unknown as typeof fetch;
    await expect(new HttpRunActionSignal(options(boom)).signal(MSG)).resolves.toBeUndefined();
    const five = recordingFetch(() => new Response('nope', { status: 500 }));
    await expect(new HttpRunActionSignal(options(five.fetchImpl)).signal(MSG)).resolves.toBeUndefined();
  });
});

/** A 500 from the kick does not change the route's 202. */
describe('D#2 H14c-3b C1: a failing kick does not change the cancel route [pg]', () => {
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
  afterEach(() => {
    runActionDeps.getRunActionSignal = () => null;
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
    await appUserPool.end();
  });

  it.each([500, 502])('the kick answers %i and the route still answers 202 with one row', async (status) => {
    const m = await seedAccountWithMember(admin, { role: 'member' });
    const workItem = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, kind, provenance) VALUES ($1, $2, 'feature', 'internal')`, [workItem, m.accountId]);
    const run = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'build', 'local', 'running')`, [
      run,
      m.accountId,
      workItem,
    ]);
    const { fetchImpl, seen } = recordingFetch(() => new Response('boom', { status }));
    runActionDeps.getRunActionSignal = () => new HttpRunActionSignal(options(fetchImpl));

    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(m)}` });
    const res = await handleApiRequest(
      new Request(`http://localhost/api/v1/runs/${run}/cancel`, { method: 'POST', headers }),
      appUserPool,
      platformOpsPool,
      ROUTES,
    );
    expect(res.status).toBe(202);
    expect(seen).toHaveLength(1); // the kick was attempted, and failed
    const { rows } = await admin.query('SELECT count(*)::int AS n FROM run_action_requests WHERE account_id = $1', [m.accountId]);
    expect(rows[0].n).toBe(1);
  });
});
