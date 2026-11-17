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
import { SCOPES, type RouteEntry } from '../src/registry.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import * as engineModule from '../src/routes/engine.js';
import { engineCommandRoutes } from '../src/routes/engine-commands.js';
import { engineDecisionRoutes } from '../src/routes/engine-decisions.js';
import { engineHaltRoutes } from '../src/routes/engine-halt.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

const ROUTES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes');
// Every engine route, from all four files. The command routes are session-only by default (no `principals` key), so the probes read `principalsOf`.
const engineRoutes: RouteEntry[] = [...engineModule.engineRoutes, ...engineCommandRoutes, ...engineDecisionRoutes, ...engineHaltRoutes];
const principalsOf = (r: RouteEntry): readonly string[] => r.principals ?? ['session'];

/**
 * The pinned role of EVERY engine route, `operationId -> minRole`. The probes below take the role to test from THIS table, never from the route, so a
 * route lowered (or raised) in its own file is a failure here and not a quiet pass. A new engine route fails the first test until it is added with its
 * role, and a role change is a deliberate edit to this table.
 */
const EXPECTED_ROLES: Record<string, 'member' | 'admin' | 'owner'> = {
  listEngineRepos: 'member',
  listEngineAgents: 'member',
  listEngineLanes: 'member',
  listEngineGates: 'member',
  listEngineAsks: 'member',
  listEngineLog: 'member',
  getEngineUsage: 'member',
  getEngineStats: 'member',
  getEngineSettings: 'member',
  setEngineSettings: 'admin',
  deleteEngineData: 'owner',
  answerEngineDecision: 'admin',
  issueEngineCommand: 'admin',
  cancelEngineCommand: 'admin',
  listEngineCommands: 'member',
  haltEngineRepo: 'admin',
  clearEngineRepoHalt: 'admin',
};
const roleOf = (r: RouteEntry) => EXPECTED_ROLES[r.operationId]!;

/** The exports of every `packages/api/src/routes/engine*.ts`, as `<file>#<name>`. */
const exportsOf = (): string[] =>
  readdirSync(ROUTES_DIR).filter((f) => /^engine.*\.ts$/.test(f)).sort().flatMap((f) => [...readFileSync(path.join(ROUTES_DIR, f), 'utf8').matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/gm)].map((m) => `${f}#${m[1]}`));

/**
 * Every engine route's own auth, tested as a whole (L3: nothing defaults to open). A later engine route file is held to the same list: an export of
 * `routes/engine*.ts` that is neither a route array nor named below as a helper fails, and every route it registers must declare its principals and
 * role itself and pass the four probes.
 */
const ROUTE_ARRAYS = ['engine.ts#engineRoutes', 'engine-commands.ts#engineCommandRoutes', 'engine-decisions.ts#engineDecisionRoutes', 'engine-halt.ts#engineHaltRoutes'];
const HELPER_EXPORTS: Record<string, string> = {
  'engine.ts#engineSettingsDeps': 'the GitHub visibility seam, not a route',
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
  let decisionId: string;
  let readToken: string;
  let everyScopeToken: string;

  // The body each write route accepts: the decision answer, a command that is valid for any repo, nothing for the routes that take none, `{}` otherwise.
  const bodyOf2 = (method: string, urlPath: string): string | undefined => {
    if (method === 'GET' || method === 'DELETE' || urlPath.endsWith('/delete-data')) return undefined;
    if (urlPath.includes('/decisions/')) return JSON.stringify({ choice: 'approve' });
    if (urlPath.endsWith('/commands')) return JSON.stringify({ kind: 'pause_loop', args: {} });
    return '{}';
  };
  const call = async (method: string, urlPath: string, who: { accountId: string; userId: string } | 'none', bearer?: string) => {
    const headers = new Headers({ accept: 'application/json' });
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    else if (who !== 'none') headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    if (bodyOf2(method, urlPath) !== undefined) headers.set('content-type', 'application/json');
    return (await handleApiRequest(new Request(`http://localhost${urlPath}`, { method, headers, body: bodyOf2(method, urlPath) }), appUserPool, platformOpsPool, ROUTES)).status;
  };
  const bodyOf = async (urlPath: string, who: { accountId: string; userId: string }) => {
    const headers = new Headers({ accept: 'application/json', cookie: `${SESSION_COOKIE_NAME}=${await signSession(who)}` });
    return (await handleApiRequest(new Request(`http://localhost${urlPath}`, { headers }), appUserPool, platformOpsPool, ROUTES)).json() as Promise<{ items?: unknown[]; repos?: Array<{ repo_id: string }>; watch_enabled?: boolean }>;
  };
  // The decision route names a real decision of this account, so the stranger's 404 is isolation and not an unknown id.
  const urlOf = (p: string) => p.replace('{id}', p.includes('/decisions/') ? decisionId : A.repoId);

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
    decisionId = (await admin.query<{ id: string }>(
      `INSERT INTO engine_decisions (account_id, repo_id, decision_type, request_key, subject, disposition, catalogue_version, preset)
       VALUES ($1, $2, 'engine_merge', $3, '{"pr":1}'::jsonb, 'ask', 11, 'default') RETURNING id`,
      [A.accountId, A.repoId, `k:${randomUUID().slice(0, 8)}`],
    )).rows[0]!.id;
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

  it('pins the role of every engine route, and every export of routes/engine*.ts is a named route array or helper', () => {
    const unknown = exportsOf().filter((x) => !(x in HELPER_EXPORTS) && !ROUTE_ARRAYS.includes(x));
    expect(unknown).toEqual([]);
    expect(Object.keys(engineModule).sort()).toEqual(['engineRoutes', 'engineSettingsDeps']);
    // The live routes and the pinned table agree exactly: the same ids, no duplicate, and the same role on each.
    const live = Object.fromEntries(engineRoutes.map((r) => [r.operationId, r.minRole]));
    expect(engineRoutes.length).toBe(Object.keys(live).length);
    expect(live).toEqual(EXPECTED_ROLES);
    // A route registered under the engine path prefix that is in none of the four arrays is not left unprobed.
    expect(ROUTES.filter((r) => r.path.startsWith('/api/v1/engine/')).map((r) => r.operationId).sort()).toEqual(Object.keys(EXPECTED_ROLES).sort());
    expect(engineDecisionRoutes.map((r) => r.operationId)).toEqual(['answerEngineDecision']);
    expect(engineHaltRoutes.map((r) => r.operationId)).toEqual(['haltEngineRepo', 'clearEngineRepoHalt']);
    expect(engineCommandRoutes.map((r) => r.operationId)).toEqual(['issueEngineCommand', 'cancelEngineCommand', 'listEngineCommands']);
    for (const r of engineRoutes) {
      expect(ROUTES.includes(r), `${r.operationId} is registered in ROUTES`).toBe(true);
      expect(['member', 'admin', 'owner']).toContain(r.minRole);
      if (principalsOf(r).includes('token')) expect(r.scope, `${r.path}: a token route names its scope`).toBe('read');
      if (r.method !== 'GET') expect(principalsOf(r), `${r.method} ${r.path}: writes are session only`).toEqual(['session']);
    }
  });

  it('unauthenticated is 401 on every route', async () => {
    for (const r of engineRoutes) expect(await call(r.method, urlOf(r.path), 'none'), `${r.method} ${r.path}`).toBe(401);
  });

  it('a user of another account is 404 on every route that names a repo', async () => {
    for (const r of engineRoutes.filter((x) => x.path.includes('{id}'))) expect(await call(r.method, urlOf(r.path), stranger), `${r.method} ${r.path}`).toBe(404);
  });

  it('a member is 403 on every owner or admin route, and a read token is 403 on every session-only route', async () => {
    for (const r of engineRoutes.filter((x) => roleOf(x) !== 'member')) expect(await call(r.method, urlOf(r.path), member), `${r.method} ${r.path}`).toBe(403);
    for (const r of engineRoutes.filter((x) => !principalsOf(x).includes('token'))) expect(await call(r.method, urlOf(r.path), 'none', readToken), `${r.method} ${r.path}`).toBe(403);
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

  it('an admin is 2xx on the halt and on the halt clear; the clear is not a member route', async () => {
    const halt = engineRoutes.find((r) => r.operationId === 'haltEngineRepo')!;
    const clear = engineRoutes.find((r) => r.operationId === 'clearEngineRepoHalt')!;
    expect(roleOf(halt)).toBe('admin');
    expect(roleOf(clear)).toBe('admin');
    expect(await call(clear.method, urlOf(clear.path), member), 'member clear').toBe(403);
    expect(await call(halt.method, urlOf(halt.path), member), 'member halt').toBe(403);
    expect(await call(halt.method, urlOf(halt.path), admin2), 'admin halt').toBe(200);
    expect(await call(clear.method, urlOf(clear.path), admin2), 'admin clear').toBe(200);
  });

  it('a token that holds every scope is still 403 on both settings writes: they are session only', async () => {
    for (const r of engineRoutes.filter((x) => x.method === 'PUT')) expect(await call(r.method, urlOf(r.path), 'none', everyScopeToken), `${r.method} ${r.path}`).toBe(403);
    // A GET that is session only (the command list) is refused to a token too; every other GET answers.
    for (const r of engineRoutes.filter((x) => x.method === 'GET')) expect(await call('GET', urlOf(r.path), 'none', everyScopeToken), `${r.path}`).toBe(principalsOf(r).includes('token') ? 200 : 403);
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

  // Last: it deletes this account's engine data, so nothing after it may rely on the fixtures.
  it('the owner is 2xx on the owner route, and a member and an admin are not', async () => {
    const del = engineRoutes.find((r) => r.operationId === 'deleteEngineData')!;
    expect(roleOf(del)).toBe('owner');
    const owner = { accountId: A.accountId, userId: A.userId };
    expect(await call(del.method, urlOf(del.path), member)).toBe(403);
    expect(await call(del.method, urlOf(del.path), admin2)).toBe(403);
    const status = await call(del.method, urlOf(del.path), owner);
    expect(status, 'owner delete').toBeGreaterThanOrEqual(200);
    expect(status, 'owner delete').toBeLessThan(300);
  });
});
