import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '@fx/core/src/tenancy/withTenant.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';

interface ErrBody {
  error: { code: string; message: string };
  details?: Array<{ path: string; code: string }>;
}

/** D#601 MEM-9: the approval rules for an agent-proposed role lesson hold at the API, through the real dispatcher on real Postgres. No outside service is called. */
describe('D#601 MEM-9: role lessons at the memory routes', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let a: SeedRefs;
  let boss: { accountId: string; userId: string };
  let repo2: string;
  let run1: string;
  let run2: string;

  async function runIn(repoId: string): Promise<string> {
    const item = randomUUID();
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'bug', 'internal')`, [item, a.accountId, repoId]);
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1,$2,$3,'executor','local','succeeded')`, [id, a.accountId, item]);
    return id;
  }
  /** A role proposal written the way the pipeline does it (no user in the session), with the runs that back it. */
  async function lesson(runs: string[]): Promise<string> {
    return withTenant(appUserPool, a.accountId, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT memory_propose('role', 'executor', 'convention', $1, NULL, 'agent', $2::jsonb) AS id`, [`role lesson ${randomUUID()}`, JSON.stringify({ source_run_id: runs[0] })]);
      for (const r of runs) await c.query(`INSERT INTO memory_entry_evidence (account_id, entry_id, run_id) VALUES ($1, $2, $3)`, [a.accountId, rows[0]!.id, r]);
      return rows[0]!.id;
    });
  }
  async function call(method: string, urlPath: string, body?: unknown) {
    const h = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(boss)}` });
    if (body !== undefined) h.set('content-type', 'application/json');
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
  }
  const status = async (id: string) => (await admin.query<{ status: string }>(`SELECT status FROM memory_entries WHERE id = $1`, [id])).rows[0]!.status;

  beforeAll(async () => {
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
    boss = { accountId: a.accountId, userId: randomUUID() };
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [boss.userId, `${boss.userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')`, [a.accountId, boss.userId]);
    repo2 = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 2, 'team')`, [repo2, a.accountId, a.installationId]);
    run1 = await runIn(a.repoId);
    run2 = await runIn(repo2);
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await Promise.all([adminPool.end(), platformOpsPool.end(), appUserPool.end()]);
  });

  it('one repo of evidence: the queue says so, and the decide route refuses with the exact words; two repos approve', async () => {
    const weak = await lesson([run1]);
    const strong = await lesson([run1, run2]);
    const queue = (await (await call('GET', '/memory/queue')).json()) as { cards: Array<{ entry: { id: string }; evidence_repos: number; needs_second_repo: boolean }> };
    expect(queue.cards.find((c) => c.entry.id === weak)).toMatchObject({ evidence_repos: 1, needs_second_repo: true });
    expect(queue.cards.find((c) => c.entry.id === strong)).toMatchObject({ evidence_repos: 2, needs_second_repo: false });

    const refused = await call('POST', `/memory/${weak}/decide`, { to: 'approved' });
    expect(refused.status).toBe(422);
    const body = (await refused.json()) as ErrBody;
    expect(body.error).toMatchObject({ code: 'needs_second_repo', message: 'Needs evidence from a second repo' });
    expect(await status(weak)).toBe('proposed');

    expect((await call('POST', `/memory/${strong}/decide`, { to: 'approved' })).status).toBe(200);
    expect(await status(strong)).toBe('approved');
  });

  it('a batch holding a role lesson is refused, however much evidence it has, and nothing changes', async () => {
    const ids = [await lesson([run1, run2]), await lesson([run1, run2])];
    const res = await call('POST', '/memory/decide-batch', { ids, to: 'approved' });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrBody;
    expect(body.error.code).toBe('role_batch_refused');
    expect(body.details).toEqual([{ path: 'ids', code: 'role_batch_refused' }]);
    expect([await status(ids[0]!), await status(ids[1]!)]).toEqual(['proposed', 'proposed']);
  });
});
