import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import type { VercelEnvSource } from '@fx/core/src/setup-requests/checks.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { setupRequestDeps } from '../src/routes/setupRequests.js';
import { activityResponseSchema } from '../src/routes/work-item-activity.js';
import { seedAccountWithMember } from './helpers/seed.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'v1', 'getWorkItemActivity');
const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
// Every id below is random per run (the accounts, repo, item and request), so no other test file's rows can collide with these.
const originalSource = setupRequestDeps.getEnvSource;
const checkingSource: VercelEnvSource = { ...originalSource(), available: true };

interface Id {
  accountId: string;
  userId: string;
}
interface Pause {
  state: string;
  sentence: string | null;
}

/** D#598 P8c-3: the activity answer carries the held setup request's status sentence. The fixtures are written from the real route's answer. */
describe('GET /api/v1/work-items/{id}/activity: setup_pause (D#598 P8c-3)', { timeout: 60_000 }, () => {
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
    setupRequestDeps.getEnvSource = originalSource;
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  async function call(who: Id, method: string, urlPath: string, body?: unknown): Promise<Response> {
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(who)}` });
    if (body !== undefined) headers.set('content-type', 'application/json');
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
  }

  async function seed() {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const repoId = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, settings) VALUES ($1, $2, $3, 'team', 'acme', 'docs', '{}'::jsonb)`, [repoId, owner.accountId, Math.floor(Math.random() * 1e9)]);
    const itemId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', 'in_progress', 42)`, [itemId, owner.accountId, repoId]);
    return { owner, repoId, itemId };
  }
  const propose = async (f: Awaited<ReturnType<typeof seed>>, over: Record<string, unknown> = {}): Promise<{ id: string }> => {
    const res = await call(f.owner, 'POST', '/setup-requests', { kind: 'env_var', repo_id: f.repoId, work_item_id: f.itemId, target: 'cloud-staging', env_name: 'STRIPE_WEBHOOK_SECRET', reason: 'The webhook route needs this name set.', check: 'env_var_present', ...over });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  };
  const activity = async (f: Awaited<ReturnType<typeof seed>>): Promise<Record<string, unknown>> => {
    const res = await call(f.owner, 'GET', `/work-items/${f.itemId}/activity`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(activityResponseSchema.parse(body)).toEqual(body);
    return body;
  };
  /** Pins the answer to a fixture; only the ids a run mints are replaced, so the file is stable. */
  const pin = async (name: string, body: Record<string, unknown>, f: Awaited<ReturnType<typeof seed>>): Promise<void> => {
    expect(JSON.stringify(body)).not.toContain(f.itemId);
    const file = path.join(FIXTURES, `200-${name}.json`);
    if (process.env.FX_WRITE_FIXTURES === '1') writeFileSync(file, pretty(body));
    expect(existsSync(file), `${file} is missing: run with FX_WRITE_FIXTURES=1 and read the diff`).toBe(true);
    expect(pretty(body)).toBe(readFileSync(file, 'utf8'));
  };

  it('an item no request holds has no setup_pause field at all', async () => {
    const f = await seed();
    expect('setup_pause' in (await activity(f))).toBe(false);
  });

  it('an open request: its status sentence, per the setup-requests route, for an unchecked and a checked request', async () => {
    const f = await seed();
    const req = await propose(f);
    // No credential source is bound: the request cannot be checked, and the activity says so in the same words the request route does.
    const unchecked = await activity(f);
    const asked = (await (await call(f.owner, 'GET', `/setup-requests/${req.id}`)).json()) as { status_sentence: string };
    expect(unchecked.setup_pause).toEqual({ state: 'open', sentence: asked.status_sentence });
    expect(asked.status_sentence).not.toBe('');
    await pin('setup-pause-open-unchecked', unchecked, f);
    // A bound source: the sentence says a check runs, and it follows the request's state on the next read.
    setupRequestDeps.getEnvSource = () => checkingSource;
    const checked = await activity(f);
    const askedNow = (await (await call(f.owner, 'GET', `/setup-requests/${req.id}`)).json()) as { status_sentence: string };
    expect((checked.setup_pause as Pause).sentence).toBe(askedNow.status_sentence);
    expect((checked.setup_pause as Pause).sentence).not.toBe(asked.status_sentence);
    await pin('setup-pause-open-checked', checked, f);
  });

  it('withdrawn keeps the pause with no sentence; a person\'s next advance, or a request marked done, removes it', async () => {
    const f = await seed();
    const req = await propose(f, { check: null });
    expect((await call(f.owner, 'POST', `/setup-requests/${req.id}/withdraw`)).status).toBe(200);
    const withdrawn = await activity(f);
    expect(withdrawn.setup_pause).toEqual({ state: 'withdrawn', sentence: null });
    await pin('setup-pause-withdrawn', withdrawn, f);
    // The person's next advance of the item lifts the hold: the line is derived, nothing was stamped on the item.
    await admin.query(
      `INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, idempotency_key, request_hash) VALUES ($1, 'advance_work_item', $2, $3, 'session', $4, $5)`,
      [f.owner.accountId, f.itemId, f.owner.userId, randomUUID(), 'h'.repeat(8)],
    );
    expect('setup_pause' in (await activity(f))).toBe(false);
    // A second request, marked done, pauses nothing.
    const second = await propose(f, { target: 'other-project', check: null });
    expect((await activity(f)).setup_pause).toMatchObject({ state: 'open' });
    expect((await call(f.owner, 'POST', `/setup-requests/${second.id}/done`)).status).toBe(200);
    expect('setup_pause' in (await activity(f))).toBe(false);
  });

  it('another account never sees the pause, and a request for another item does not pause this one', async () => {
    const f = await seed();
    const other = await seed();
    await propose(f);
    expect('setup_pause' in (await activity(other))).toBe(false);
    const stranger = await call(other.owner, 'GET', `/work-items/${f.itemId}/activity`);
    expect(stranger.status).toBe(404);
  });
});
