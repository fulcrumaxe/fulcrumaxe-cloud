import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';

/**
 * D#749 VERIFY-SIGNIN-EXPIRY: GET /api/v1/verify-sign-in through the real `handleApiRequest` against real Postgres (RLS, membership). The list is derived on every read from the runners' last
 * reports and the rows parked for a sign-in; nothing here stores "this repository is on the list", so renewing the sign-in (a runner reporting `ok`) is what removes it.
 */
interface Item {
  repo_id: string;
  repo: string | null;
  kind: string;
  command: string;
  since: string | null;
}
const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/v1/listVerifySignInNeeds/200-ok.json', import.meta.url), 'utf8')) as { items: Item[] };
const BASE = 'https://staging.example.test';

describe('D#749 VERIFY-SIGNIN-EXPIRY: verify-sign-in list', () => {
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
    await Promise.all([adminPool.end(), platformOpsPool.end(), appUserPool.end()]);
  });

  async function fixture(o: { enabled?: boolean } = {}) {
    const refs: SeedRefs = await seedAccount(admin, randomUUID());
    const userId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [refs.accountId, userId]);
    await admin.query(`UPDATE repos SET gh_owner = 'example-org', gh_name = 'example-repo' WHERE id = $1`, [refs.repoId]);
    await admin.query(`INSERT INTO verify_settings (repo_id, account_id, enabled, base_url, eligibility) VALUES ($1, $2, $3, $4, 'all')`, [refs.repoId, refs.accountId, o.enabled ?? true, BASE]);
    return { refs, who: { accountId: refs.accountId, userId } };
  }
  const read = async (who: { accountId: string; userId: string }): Promise<Response> => {
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(who)}` });
    return handleApiRequest(new Request('http://localhost/api/v1/verify-sign-in', { method: 'GET', headers }), appUserPool, platformOpsPool, ROUTES);
  };
  const items = async (who: { accountId: string; userId: string }): Promise<Item[]> => ((await (await read(who)).json()) as { items: Item[] }).items;
  const report = async (refs: SeedRefs, userId: string, state: string | null): Promise<string> => {
    const id = await insertRunner(admin, refs.accountId, userId, { protocolVersion: 18 });
    if (state !== null) await admin.query(`UPDATE runners SET verify_sign_in = $2, verify_sign_in_at = now() WHERE id = $1`, [id, state]);
    return id;
  };
  async function parkedRow(refs: SeedRefs): Promise<string> {
    const item = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'internal', 'merged')`, [item, refs.accountId, refs.repoId]);
    const batch = (await admin.query(`INSERT INTO verify_batches (account_id, repo_id) VALUES ($1, $2) RETURNING id`, [refs.accountId, refs.repoId])).rows[0].id as string;
    const row = randomUUID();
    await admin.query(`INSERT INTO verify_rows (id, account_id, repo_id, batch_id, work_item_id, pr_number, merge_sha, journeys) VALUES ($1, $2, $3, $4, $5, 1, $6, '[]')`, [row, refs.accountId, refs.repoId, batch, item, 'a'.repeat(40)]);
    await admin.query(`UPDATE verify_rows SET hold_reason = 'needs_sign_in', hold_since = now() WHERE id = $1`, [row]);
    return row;
  }

  it('is empty when no runner has said anything (an older runner, or none with an address set) and nothing is parked', async () => {
    const f = await fixture();
    expect(await items(f.who)).toEqual([]);
    await report(f.refs, f.who.userId, null);
    expect(await items(f.who)).toEqual([]);
  });

  it('lists one entry in the shape of the contract fixture, with the fixed command and the repository\'s configured address', async () => {
    const f = await fixture();
    await report(f.refs, f.who.userId, 'expired');
    const res = await read(f.who);
    expect(res.status).toBe(200);
    const list = ((await res.json()) as { items: Item[] }).items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ repo_id: f.refs.repoId, repo: 'example-org/example-repo', kind: 'expired', command: `fx-runner verify-login --base-url ${BASE}`, since: null });
    expect(Object.keys(list[0]!).sort()).toEqual(Object.keys(FIXTURE.items[0]!).sort());
    expect(FIXTURE.items[0]!.command).toMatch(/^fx-runner verify-login --base-url https:\/\/\S+$/);
  });

  it('names each state: expired, missing and expiring_soon; a good runner (ok) takes the repository off the list, which is how a renewed sign-in leaves it', async () => {
    const f = await fixture();
    const runner = await report(f.refs, f.who.userId, 'expiring_soon');
    expect((await items(f.who)).map((i) => i.kind)).toEqual(['expiring_soon']);
    await admin.query(`UPDATE runners SET verify_sign_in = 'missing' WHERE id = $1`, [runner]);
    expect((await items(f.who)).map((i) => i.kind)).toEqual(['missing']);
    await admin.query(`UPDATE runners SET verify_sign_in = 'expired' WHERE id = $1`, [runner]);
    expect((await items(f.who)).map((i) => i.kind)).toEqual(['expired']);
    await report(f.refs, f.who.userId, 'ok');
    expect(await items(f.who)).toEqual([]);
    await admin.query(`UPDATE runners SET verify_sign_in = 'ok' WHERE id = $1`, [runner]);
    expect(await items(f.who)).toEqual([]);
  });

  it('a check parked for a sign-in is listed as waiting, whatever the runners say, with when the wait began; it leaves when the row runs again', async () => {
    const f = await fixture();
    await report(f.refs, f.who.userId, 'ok');
    const row = await parkedRow(f.refs);
    const list = await items(f.who);
    expect(list.map((i) => i.kind)).toEqual(['waiting']);
    expect(Number.isNaN(Date.parse(list[0]!.since!))).toBe(false);
    await admin.query(`UPDATE verify_rows SET status = 'deploying', hold_reason = NULL, hold_since = NULL WHERE id = $1`, [row]);
    expect(await items(f.who)).toEqual([]);
  });

  it('lists nothing for a repository with checking off, a revoked runner, or another account\'s runners', async () => {
    const off = await fixture({ enabled: false });
    await report(off.refs, off.who.userId, 'expired');
    expect(await items(off.who)).toEqual([]);
    const f = await fixture();
    const revoked = await report(f.refs, f.who.userId, 'expired');
    await admin.query(`UPDATE runners SET revoked_at = now(), revoked_reason = 'test' WHERE id = $1`, [revoked]);
    const other = await fixture();
    await report(other.refs, other.who.userId, 'expired');
    expect(await items(f.who)).toEqual([]);
    expect((await items(other.who)).map((i) => i.repo_id)).toEqual([other.refs.repoId]);
  });

  it('needs a session: no cookie is 401', async () => {
    const res = await handleApiRequest(new Request('http://localhost/api/v1/verify-sign-in', { method: 'GET' }), appUserPool, platformOpsPool, ROUTES);
    expect(res.status).toBe(401);
  });
});
