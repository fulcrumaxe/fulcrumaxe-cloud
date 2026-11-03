import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken, type Scope } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { generateToken } from '../../src/tokens/format.js';
import { hashToken } from '../../src/tokens/resolve.js';
import { handleApiRequest } from '../../src/handler.js';
import { ROUTES } from '../../src/routes/index.js';
import { seedAccountWithMember } from './seed.js';

/** One account with two repos (A is the token's, B is not), an item, a run and a receipt in each. Shared by the two CC-4b suites. */
export interface Side {
  repoId: string;
  itemId: string;
  runId: string;
}
export interface DelegationFixture {
  owner: { accountId: string; userId: string };
  a: Side;
  b: Side;
  /** A run with no work item: it belongs to no repo. */
  orphanRunId: string;
}

export interface Pools {
  adminPool: Pool;
  admin: PoolClient;
  app: Pool;
  ops: Pool;
}

export async function openPools(): Promise<Pools> {
  const adminPool = createPool(process.env.API_DATABASE_URL!);
  const admin = await adminPool.connect();
  const app = createPool(process.env.API_DATABASE_URL_APP_USER!);
  const ops = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
  process.env.FX_SESSION_SECRET = 's'.repeat(32);
  return { adminPool, admin, app, ops };
}

export async function closePools(p: Pools): Promise<void> {
  delete process.env.FX_SESSION_SECRET;
  p.admin.release();
  await Promise.all([p.adminPool.end(), p.app.end(), p.ops.end()]);
}

let ghId = 820_000_000;
async function seedSide(admin: PoolClient, accountId: string, gh: string): Promise<Side> {
  const repoId = randomUUID();
  const itemId = randomUUID();
  const runId = randomUUID();
  await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', 'acme', $4)`, [repoId, accountId, ghId++, gh]);
  await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', 'in_progress', $4)`, [itemId, accountId, repoId, ghId]);
  await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'build', 'local', 'running')`, [runId, accountId, itemId]);
  await admin.query(
    `INSERT INTO decision_receipts (account_id, work_item_id, decision_type, class, chosen, rejected_alternative, actor, created_at)
     VALUES ($1, $2, 'start_work_small', 'human_over_the_loop', 'start', 'hold', 'policy', '2026-10-20T10:00:00Z')`,
    [accountId, itemId],
  );
  return { repoId, itemId, runId };
}

export async function seedFixture(admin: PoolClient): Promise<DelegationFixture> {
  const owner = await seedAccountWithMember(admin, { role: 'owner' });
  const a = await seedSide(admin, owner.accountId, 'widgets');
  const b = await seedSide(admin, owner.accountId, 'gadgets');
  const orphanRunId = randomUUID();
  await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'build', 'local', 'running')`, [orphanRunId, owner.accountId]);
  return { owner, a, b, orphanRunId };
}

/** A delegation token bound to `repoId`, made at run time (nothing token-shaped is written in the source). */
export async function delegationToken(
  app: Pool,
  who: { accountId: string; userId: string },
  repoId: string,
  scopes: Scope[] = ['read', 'corrections:write'],
): Promise<string> {
  const plaintext = generateToken();
  await insertApiToken(app, {
    accountId: who.accountId,
    createdBy: who.userId,
    tokenHash: hashToken(plaintext),
    displayHint: 'fxat_...test',
    scopes,
    expiresAt: new Date(Date.now() + 3_000_000),
    delegation: { repoId, clientId: 'reads-probe' },
  });
  return plaintext;
}

/** The fields these suites read, typed as present: each test reads only the ones its route returns. */
export interface Body {
  data: { id: string }[];
  next_cursor: string | null;
  id: string;
  milestones: unknown[];
  total: number;
  receipts: unknown[];
  error: { code: string; message: string };
}

export async function get(p: Pools, auth: string | { accountId: string; userId: string }, urlPath: string): Promise<{ status: number; body: Body; raw: string }> {
  const h = new Headers();
  if (typeof auth === 'string') h.set('authorization', `Bearer ${auth}`);
  else h.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(auth)}`);
  h.set('accept', 'application/json');
  const res = await handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { headers: h }), p.app, p.ops, ROUTES);
  const raw = await res.text();
  let body = null as unknown as Body;
  try {
    body = JSON.parse(raw) as Body;
  } catch {
    // not JSON: the status is what the test reads
  }
  return { status: res.status, body, raw };
}
