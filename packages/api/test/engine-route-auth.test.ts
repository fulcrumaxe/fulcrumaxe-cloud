import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { generateToken } from '../src/tokens/format.js';
import { SCOPES } from '../src/registry.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import * as engineModule from '../src/routes/engine.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

const ROUTES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes');
// This file's list is the routes of engine.ts (the read API and settings); the command routes (engine-commands.ts) are session-only by default and are guarded in their own test.
const engineRoutes = ROUTES.filter((r) => engineModule.engineRoutes.includes(r));

/** The exports of every `packages/api/src/routes/engine*.ts`, as `<file>#<name>`. */
const exportsOf = (): string[] =>
  readdirSync(ROUTES_DIR).filter((f) => /^engine.*\.ts$/.test(f)).sort().flatMap((f) => [...readFileSync(path.join(ROUTES_DIR, f), 'utf8').matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/gm)].map((m) => `${f}#${m[1]}`));

/**
 * Every engine route's own auth, tested as a whole (L3: nothing defaults to open). A later engine route file is held to the same list: an export of
 * `routes/engine*.ts` that is neither a route array nor named below as a helper fails, and every route it registers must declare its principals and
 * role itself and pass the four probes.
 */
const HELPER_EXPORTS: Record<string, string> = {
  'engine.ts#engineSettingsDeps': 'the GitHub visibility seam, not a route',
  'engine-commands.ts#engineCommandRoutes': 'the command routes: owner/admin, session only, audited, and tested in engine-commands.pg.test.ts and engine-audit-guard.test.ts',
};

describe('engine route auth meta-test [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let A: SeedRefs;
  let member: { accountId: string; userId: string };
  let admin2: { accountId: string; userId: string };
  let stranger: { accountId: string; userId: string };
  let readToken: string;
  let everyScopeToken: string;

  const call = async (method: string, urlPath: string, who: { accountId: string; userId: string } | 'none', bearer?: string) => {
    const headers = new Headers({ accept: 'application/json' });
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    else if (who !== 'none') headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    if (method !== 'GET') headers.set('content-type', 'application/json');
    return (await handleApiRequest(new Request(`http://localhost${urlPath}`, { method, headers, body: method === 'GET' ? undefined : '{}' }), appUserPool, platformOpsPool, ROUTES)).status;
  };
  const bodyOf = async (urlPath: string, who: { accountId: string; userId: string }) => {
    const headers = new Headers({ accept: 'application/json', cookie: `${SESSION_COOKIE_NAME}=${await signSession(who)}` });
    return (await handleApiRequest(new Request(`http://localhost${urlPath}`, { headers }), appUserPool, platformOpsPool, ROUTES)).json() as Promise<{ items?: unknown[]; repos?: Array<{ repo_id: string }>; watch_enabled?: boolean }>;
  };
  const urlOf = (p: string) => p.replace('{id}', A.repoId);

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    A = await seedAccount(admin, randomUUID());
    member = { accountId: A.accountId, userId: randomUUID() };
    await seedUser(admin, member.userId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [A.accountId, member.userId]);
    admin2 = { accountId: A.accountId, userId: randomUUID() };
    await seedUser(admin, admin2.userId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')`, [A.accountId, admin2.userId]);
    stranger = await seedAccountWithMember(admin, { role: 'owner' });
    await admin.query(`UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1`, [A.repoId]);
    await admin.query(`INSERT INTO engine_bridge_settings (account_id, watch_enabled) VALUES ($1, true)`, [A.accountId]);
    await admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [A.accountId, A.repoId]);
    readToken = generateToken();
    await insertApiToken(appUserPool, { accountId: A.accountId, createdBy: A.userId, tokenHash: hashToken(readToken), displayHint: 'fxat_...test', scopes: ['read'], expiresAt: new Date(Date.now() + 86_400_000) });
    everyScopeToken = generateToken();
    await insertApiToken(appUserPool, { accountId: A.accountId, createdBy: A.userId, tokenHash: hashToken(everyScopeToken), displayHint: 'fxat_...all', scopes: [...SCOPES], expiresAt: new Date(Date.now() + 86_400_000) });
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await Promise.all([adminPool.end(), appUserPool.end(), platformOpsPool.end()]);
  });

  it('lists every engine route and every export of routes/engine*.ts, and none is left unnamed', () => {
    expect(engineRoutes.length).toBeGreaterThanOrEqual(11);
    const unknown = exportsOf().filter((x) => !(x in HELPER_EXPORTS) && x !== 'engine.ts#engineRoutes');
    expect(unknown).toEqual([]);
    expect(Object.keys(engineModule).sort()).toEqual(['engineRoutes', 'engineSettingsDeps']);
    for (const r of engineRoutes) {
      expect(Object.hasOwn(r, 'principals'), `${r.method} ${r.path}: principals`).toBe(true);
      expect(['member', 'admin', 'owner']).toContain(r.minRole);
      if (r.principals!.includes('token')) expect(r.scope, `${r.path}: a token route names its scope`).toBe('read');
      if (r.method !== 'GET') expect(r.principals, `${r.method} ${r.path}: writes are session only`).toEqual(['session']);
    }
  });

  it('unauthenticated is 401 on every route', async () => {
    for (const r of engineRoutes) expect(await call(r.method, urlOf(r.path), 'none'), `${r.method} ${r.path}`).toBe(401);
  });

  it('a user of another account is 404 on every route that names a repo', async () => {
    for (const r of engineRoutes.filter((x) => x.path.includes('{id}'))) expect(await call(r.method, urlOf(r.path), stranger), `${r.method} ${r.path}`).toBe(404);
  });

  it('a member is 403 on every owner or admin route, and a read token is 403 on every session-only route', async () => {
    for (const r of engineRoutes.filter((x) => x.minRole !== 'member')) expect(await call(r.method, urlOf(r.path), member), `${r.method} ${r.path}`).toBe(403);
    for (const r of engineRoutes.filter((x) => !x.principals!.includes('token'))) expect(await call(r.method, urlOf(r.path), 'none', readToken), `${r.method} ${r.path}`).toBe(403);
  });

  it('a member reads every GET route', async () => {
    for (const r of engineRoutes.filter((x) => x.method === 'GET')) expect(await call('GET', urlOf(r.path), member), `${r.path}`).toBe(200);
  });
  it('an admin may change the settings but not delete the data; only the owner deletes', async () => {
    const put = engineRoutes.find((r) => r.operationId === 'setEngineSettings')!;
    const del = engineRoutes.find((r) => r.operationId === 'deleteEngineData')!;
    expect(put.minRole).toBe('admin');
    expect(del.minRole).toBe('owner');
    expect(await call(del.method, urlOf(del.path), admin2), `${del.method} ${del.path}`).toBe(403);
    expect(await call(put.method, urlOf(put.path), admin2), `${put.method} ${put.path}`).toBe(200);
  });

  it('a token that holds every scope is still 403 on both settings writes: they are session only', async () => {
    for (const r of engineRoutes.filter((x) => x.method === 'PUT')) expect(await call(r.method, urlOf(r.path), 'none', everyScopeToken), `${r.method} ${r.path}`).toBe(403);
    for (const r of engineRoutes.filter((x) => x.method === 'GET')) expect(await call('GET', urlOf(r.path), 'none', everyScopeToken), `${r.path}`).toBe(200);
  });

  it('a user of another account sees none of this account on the account-level routes', async () => {
    const repos = await bodyOf('/api/v1/engine/repos', stranger);
    expect(repos.items).toEqual([]);
    const settings = await bodyOf('/api/v1/engine/settings', stranger);
    expect(settings.watch_enabled).toBe(false);
    expect(settings.repos!.map((x) => x.repo_id)).not.toContain(A.repoId);
    // The same read as this account's own member does show them, so the stranger's empty answer is the isolation and not an empty fixture.
    expect(((await bodyOf('/api/v1/engine/repos', member)).items ?? []).length).toBe(1);
  });
});
