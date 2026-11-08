import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { workItemEnvelopeSchema } from '../src/routes/work-items.js';
import { seedAccountWithMember } from './helpers/seed.js';

/** GET /api/v1/work-items/{id} carries the spend limit the item draws on, so a person can see (and raise) what a split parent's children are held by. */
describe('GET /api/v1/work-items/{id}: envelope', { timeout: 60_000 }, () => {
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

  async function get(who: { accountId: string; userId: string }, itemId: string): Promise<Response> {
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(who)}` });
    return handleApiRequest(new Request(`http://localhost/api/v1/work-items/${itemId}`, { method: 'GET', headers }), appUserPool, platformOpsPool, ROUTES);
  }

  async function seed(mode = 'runner_local') {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const repoId = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, execution_mode, gh_owner, gh_name, settings) VALUES ($1, $2, $3, 'team', $4, 'acme', 'docs', '{}'::jsonb)`, [repoId, owner.accountId, Math.floor(Math.random() * 1e9), mode]);
    return { owner, repoId };
  }
  const item = async (f: Awaited<ReturnType<typeof seed>>, envelopeId: string | null): Promise<string> =>
    (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, stage, envelope_id) VALUES ($1, $2, 'feature', 'internal', 'spec_ready', $3) RETURNING id`, [f.owner.accountId, f.repoId, envelopeId])).rows[0]!.id;

  it('an item with no envelope answers envelope: null', async () => {
    const f = await seed();
    const res = await get(f.owner, await item(f, null));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { envelope: unknown }).envelope).toBeNull();
  });

  it('an item on an envelope answers its id, scope, version, amount, what it has spent and what its next run needs', async () => {
    const f = await seed();
    const envelopeId = randomUUID();
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'item', 30, 1, $3)`, [envelopeId, f.owner.accountId, f.owner.userId]);
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'item', 45, 2, $3)`, [envelopeId, f.owner.accountId, f.owner.userId]);
    const itemId = await item(f, envelopeId);
    // A finished run on the person's own machine, priced at $1.25 by the cloud.
    const runner = randomUUID();
    const jkt = runner.replace(/-/g, '').padEnd(43, 'k');
    await admin.query(`INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode) VALUES ($1, $2, $3, $4::jsonb, $5, 'subscription')`, [runner, f.owner.accountId, f.owner.userId, JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: jkt }), jkt]);
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, execution_mode, status, runner_id, dispatch_repo_id) VALUES ($1, $2, $3, 'project-manager', 'runner', 'runner_local', 'succeeded', $4, $5)`, [runId, f.owner.accountId, itemId, runner, f.repoId]);
    await admin.query(`INSERT INTO runner_run_usage (account_id, run_id, runner_id, credential_mode, model, input_tokens, output_tokens, api_equivalent_usd, price_table_version) VALUES ($1, $2, $3, 'subscription', 'sonnet-5', 10, 10, 1.25, '2026-11-01')`, [f.owner.accountId, runId, runner]);

    const res = await get(f.owner, itemId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { envelope: unknown };
    expect(workItemEnvelopeSchema.parse(body.envelope)).toEqual(body.envelope);
    expect(body.envelope).toMatchObject({ id: envelopeId, scope: 'item', version: 2, amount_usd: 45, spent_usd: 1.25 });
    expect((body.envelope as { next_run_need_usd: number }).next_run_need_usd).toBeGreaterThan(0);
  });

  it("another account's item is a 404, never its envelope", async () => {
    const a = await seed();
    const b = await seed();
    const envelopeId = randomUUID();
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'item', 30, 1, $3)`, [envelopeId, b.owner.accountId, b.owner.userId]);
    expect((await get(a.owner, await item(b, envelopeId))).status).toBe(404);
  });
});
