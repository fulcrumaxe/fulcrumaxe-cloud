import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { verifyCreateRepoState } from '@fx/core/src/github/createRepoState.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { githubRouteDeps } from '../src/routes/github.js';
import { repoPairingDeps, type PairingRepoInspector } from '../src/routes/repoPairing.js';
import { TWIN_ENABLED } from '@fx/core/src/repos/twins.js';
import { bringTwinIssue, mergeTwinPr } from '@fx/runner-cloud';
import { twinRouteDeps, type TwinBringAnswer, type TwinIssuesAnswer, type TwinMergeAnswer } from '../src/routes/repoTwins.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
type Facts = Awaited<ReturnType<PairingRepoInspector['inspect']>>;
const PUBLIC: Facts = { visibility: 'public', defaultBranch: 'main', appInstalled: true, ownerGhId: 4242 };
const SECRET = 'state-secret-state-secret-state-secret!!';

/**
 * D#845 ON-27a through the real `handleApiRequest` against real Postgres: the create's intent, the read, pause/resume/stop, the kill switch, tenant scoping
 * and the pairing exclusion. GitHub is the recorded `inspect` fake below; no request ever leaves the process.
 */
describe('repo twins API', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const asked: string[] = [];
  let world: Facts | 'down' = PUBLIC;
  const fake: PairingRepoInspector = {
    async inspect(name) {
      asked.push(name);
      if (world === 'down') throw Object.assign(new Error('boom'), { name: 'PublicRepoInspectError', code: 'github_unavailable' });
      return world;
    },
  };
  const env = { GITHUB_INSTALL_STATE_SECRET: SECRET, GITHUB_APP_TEAM_CLIENT_ID: 'cid', FX_GITHUB_CALLBACK_URL: 'https://cloud.example.test/api/github/callback', FX_SESSION_SECRET: 's'.repeat(32) };
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    repoPairingDeps.getInspector = () => fake;
    githubRouteDeps.getPlatformOpsPool = () => platformOpsPool;
    twinRouteDeps.enabled = true;
  });
  afterEach(() => {
    world = PUBLIC;
    asked.length = 0;
    twinRouteDeps.enabled = true;
    twinRouteDeps.closePublishPr = null;
    twinRouteDeps.closeSyncPr = null;
    twinRouteDeps.mergePr = null;
    twinRouteDeps.listIssues = null;
    twinRouteDeps.bringIssue = null;
  });
  afterAll(async () => {
    repoPairingDeps.getInspector = () => null;
    twinRouteDeps.enabled = false;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
    await appUserPool.end();
  });

  async function call(identity: Identity, method: string, urlPath: string, body?: unknown): Promise<Response> {
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(identity)}` });
    if (body !== undefined) headers.set('content-type', 'application/json');
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
  }
  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [accountId, userId, role]);
    return { accountId, userId };
  }
  /** An account with an owner, an installed team App (the create's quota and install gate read it) and a synced repo. */
  async function account() {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const gh = Math.floor(Math.random() * 1e9) + 1e10;
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')`, [randomUUID(), owner.accountId, gh]);
    await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, 'team', 1)`, [gh]);
    return owner;
  }
  async function seedRepo(accountId: string, name = 'widgets'): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO repos (account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, 'web', 'acme', $3) RETURNING id`,
      [accountId, Math.floor(Math.random() * 1e9), name],
    );
    return rows[0]!.id;
  }
  const stateOf = async (id: string) => (await admin.query<{ state: string }>('SELECT state FROM repo_twins WHERE id = $1', [id])).rows[0]?.state;
  const authorize = async (res: Response) => {
    const { authorize_url } = (await res.json()) as { authorize_url: string };
    const url = new URL(authorize_url);
    return { url, claims: verifyCreateRepoState(url.searchParams.get('state')!, SECRET) };
  };
  /** Creates the twin through a real create: the callback's own function (`twin_record`) under the person's session, as `createCustomerRepo` calls it. */
  const makeTwin = async (who: Identity, pub: string, priv: string | null = null): Promise<string> => {
    const c = await appUserPool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)", [who.accountId, who.userId]);
      const { rows } = await c.query<{ o_id: string }>('SELECT o_id FROM twin_record($1, $2, 55, $3)', [pub, priv, 'widgets-private']);
      await c.query('COMMIT');
      return rows[0]!.o_id;
    } finally {
      c.release();
    }
  };

  it('the kill switch is on in the build (ON-27d4c), and still works: with it off every twin route answers 503 not_configured and writes nothing', async () => {
    expect(TWIN_ENABLED).toBe(true);
    twinRouteDeps.enabled = false;
    const owner = await account();
    const repo = await seedRepo(owner.accountId);
    for (const [method, path, body] of [['POST', `/repos/${repo}/twin`, {}], ['GET', `/repos/${repo}/twin`, undefined], ['POST', `/twins/${randomUUID()}/pause`, undefined], ['POST', `/twins/${randomUUID()}/resume`, undefined], ['DELETE', `/twins/${randomUUID()}`, undefined], ['POST', `/twins/${randomUUID()}/check`, undefined], ['POST', `/twins/${randomUUID()}/merge`, { pr: 'publish' }]] as const) {
      const res = await call(owner, method, path, body);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_configured');
    }
    expect(asked).toEqual([]);
  });

  /** A ready twin with both repos, optionally with the counts of its last parity check (a row in twin_parity_checks, as the sweep's record writes it). */
  const readyTwin = async (who: Identity, check?: { result: string; publish?: number; sync?: number }, names: [string, string] = ['widgets', 'widgets-private']) => {
    const pub = await seedRepo(who.accountId, names[0]);
    const priv = await seedRepo(who.accountId, names[1]);
    const id = await makeTwin(who, pub, priv);
    await admin.query("UPDATE repo_twins SET state = 'ready' WHERE id = $1", [id]);
    if (check) {
      await admin.query('INSERT INTO twin_parity_checks (twin_id, account_id, last_result, publish_count, sync_count, path_count) VALUES ($1, $2, $3, $4, $5, $6)', [id, who.accountId, check.result, check.publish ?? 0, check.sync ?? 0, check.publish ?? check.sync ?? 0]);
    }
    return { id, pub, priv };
  };
  const twinOf = async (who: Identity, repo: string) => ((await (await call(who, 'GET', `/repos/${repo}/twin`)).json()) as { twin: { merged_count: number | null; new_changes_count: number | null } }).twin;

  it('the twin item carries the merged count and the new-changes count of its last parity check, null before any check, and never another twin\'s', async () => {
    const owner = await account();
    const fresh = await readyTwin(owner);
    expect(await twinOf(owner, fresh.pub)).toMatchObject({ merged_count: null, new_changes_count: null });
    const waiting = await readyTwin(owner, { result: 'publish_pending', publish: 3 }, ['gadgets', 'gadgets-private']);
    const incoming = await readyTwin(owner, { result: 'sync_pending', sync: 2 }, ['gizmos', 'gizmos-private']);
    const parity = await readyTwin(owner, { result: 'in_parity' }, ['sprockets', 'sprockets-private']);
    // the SAME account's other twins keep their own counts
    expect(await twinOf(owner, fresh.pub)).toMatchObject({ merged_count: null, new_changes_count: null });
    expect(await twinOf(owner, waiting.pub)).toMatchObject({ merged_count: 3, new_changes_count: 0 });
    expect(await twinOf(owner, incoming.pub)).toMatchObject({ merged_count: 0, new_changes_count: 2 });
    expect(await twinOf(owner, parity.pub)).toMatchObject({ merged_count: 0, new_changes_count: 0 });
    // a second account's read of the first one's twin is a 404, and its own twin with no check reads null (not the first account's counts)
    const other = await account();
    expect((await call(other, 'GET', `/repos/${waiting.pub}/twin`)).status).toBe(404);
    const theirs = await readyTwin(other);
    expect(await twinOf(other, theirs.pub)).toMatchObject({ merged_count: null, new_changes_count: null });
    // pause / resume answer the same item shape
    const paused = (await (await call(owner, 'POST', `/twins/${waiting.id}/pause`)).json()) as { merged_count: number | null };
    expect(paused.merged_count).toBe(3);
  });

  it('the twin item carries the note the cloud keeps beside the state (the public repo turned private), null otherwise, and never another twin\'s', async () => {
    const owner = await account();
    const quiet = await readyTwin(owner);
    const noted = await readyTwin(owner, undefined, ['gizmos', 'gizmos-private']);
    await admin.query("UPDATE repo_twins SET note = 'public_repo_private' WHERE id = $1", [noted.id]);
    const noteOf = async (who: Identity, repo: string) => ((await (await call(who, 'GET', `/repos/${repo}/twin`)).json()) as { twin: { note: string | null } }).twin.note;
    expect(await noteOf(owner, quiet.pub)).toBeNull();
    expect(await noteOf(owner, noted.pub)).toBe('public_repo_private');
    expect(await noteOf(owner, noted.priv)).toBe('public_repo_private');
    const stopped = (await (await call(owner, 'POST', `/twins/${noted.id}/pause`)).json()) as { note: string | null };
    expect(stopped.note).toBe('public_repo_private');
    const other = await account();
    expect(await noteOf(other, (await readyTwin(other)).pub)).toBeNull();
  });

  it('Check again marks the twin due now for the sweep (owner or admin only), and only a ready or conflicting twin has anything to check', async () => {
    const owner = await account();
    const t = await readyTwin(owner, { result: 'publish_pending', publish: 1 });
    const due = async () => (await admin.query<{ due: boolean | null; mark_seq: string }>('SELECT due_at IS NOT NULL AND due_at <= now() + interval \'61 seconds\' AS due, mark_seq FROM twin_parity_checks WHERE twin_id = $1', [t.id])).rows[0]!;
    expect(await due()).toMatchObject({ due: false, mark_seq: '0' });
    const member = await addMember(owner.accountId, 'member');
    expect((await call(member, 'POST', `/twins/${t.id}/check`)).status).toBe(403);
    expect(await due()).toMatchObject({ due: false, mark_seq: '0' });
    const res = await call(await addMember(owner.accountId, 'admin'), 'POST', `/twins/${t.id}/check`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: t.id, state: 'ready', merged_count: 1 });
    expect(await due()).toMatchObject({ due: true, mark_seq: '1' });
    expect((await call(owner, 'POST', `/twins/${t.id}/check`)).status).toBe(200);
    expect((await due()).mark_seq).toBe('2');
    // a conflicting twin is checked again too; the others have nothing to compare and change nothing
    await admin.query("UPDATE repo_twins SET state = 'conflict' WHERE id = $1", [t.id]);
    expect((await call(owner, 'POST', `/twins/${t.id}/check`)).status).toBe(200);
    for (const state of ['seeding', 'paused', 'refused', 'failed']) {
      await admin.query('UPDATE repo_twins SET state = $2 WHERE id = $1', [t.id, state]);
      const before = (await due()).mark_seq;
      const bad = await call(owner, 'POST', `/twins/${t.id}/check`);
      expect(bad.status).toBe(409);
      expect(await bad.json()).toMatchObject({ error: { code: 'twin_state' }, data: { state } });
      expect((await due()).mark_seq).toBe(before);
    }
    // a second account's twin is not found, and a twin of no one is too
    expect((await call(await account(), 'POST', `/twins/${t.id}/check`)).status).toBe(404);
    expect((await call(owner, 'POST', `/twins/${randomUUID()}/check`)).status).toBe(404);
  });

  it('a Merge through the route writes one twin.merged audit row for the person, and a merge the app refuses or finds already done writes none', async () => {
    const owner = await account();
    const t = await readyTwin(owner);
    await admin.query('UPDATE repo_twins SET publish_pr = 7, publish_head = $2 WHERE id = $1', [t.id, 'd'.repeat(40)]);
    const sha = 'd'.repeat(40);
    let pr: { state: string; merged: boolean; headSha: string } = { state: 'OPEN', merged: false, headSha: sha };
    let merge: 'merged' | 'blocked' = 'merged';
    const setupInstall = { installPullRequest: async () => ({ ...pr, mergedByApp: false, files: [], totalCount: 0, complete: true }), mergeInstall: async () => merge } as never;
    twinRouteDeps.mergePr = (input) => mergeTwinPr({ appUserPool, setupInstall }, { accountId: input.accountId, userId: input.userId }, input.twinId);
    const rows = async () => (await admin.query<{ actor: string; payload: unknown }>("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'twin.merged'", [owner.accountId])).rows;
    merge = 'blocked';
    expect((await call(owner, 'POST', `/twins/${t.id}/merge`, { pr: 'publish' })).status).toBe(409);
    pr = { state: 'MERGED', merged: true, headSha: sha };
    expect(await (await call(owner, 'POST', `/twins/${t.id}/merge`, { pr: 'publish' })).json()).toEqual({ merged: true, already: true, pr: 7 });
    expect(await rows()).toEqual([]);
    pr = { state: 'OPEN', merged: false, headSha: sha };
    merge = 'merged';
    expect(await (await call(owner, 'POST', `/twins/${t.id}/merge`, { pr: 'publish' })).json()).toEqual({ merged: true, already: false, pr: 7 });
    expect(await rows()).toEqual([{ actor: owner.userId, payload: { twin_id: t.id, pr: 'publish', number: 7 } }]);
  });

  it('Merge asks the app to merge the publish pull request, for an owner or admin; each answer has its own code', async () => {
    const owner = await account();
    const t = await readyTwin(owner);
    const calls: Array<{ accountId: string; userId: string; twinId: string }> = [];
    let answer: TwinMergeAnswer = { result: 'merged', pr: 7 };
    twinRouteDeps.mergePr = async (input) => (calls.push(input), answer);
    const merge = (who: Identity, body: unknown = { pr: 'publish' }) => call(who, 'POST', `/twins/${t.id}/merge`, body);
    expect(await (await merge(owner)).json()).toEqual({ merged: true, already: false, pr: 7 });
    expect(calls).toEqual([{ accountId: owner.accountId, userId: owner.userId, twinId: t.id }]);
    answer = { result: 'already', pr: 7 };
    expect(await (await merge(owner)).json()).toEqual({ merged: true, already: true, pr: 7 });
    const refusals: Array<[TwinMergeAnswer, number, string]> = [
      [{ result: 'not_found' }, 404, 'not_found'],
      [{ result: 'twin_state', state: 'seeding' }, 409, 'twin_state'],
      [{ result: 'no_open_pr' }, 409, 'twin_no_pr'],
      [{ result: 'pr_changed' }, 409, 'twin_pr_changed'],
      [{ result: 'pr_blocked' }, 409, 'twin_pr_blocked'],
      [{ result: 'github_unavailable' }, 503, 'github_unavailable'],
    ];
    for (const [a, status, code] of refusals) {
      answer = a;
      const res = await merge(owner);
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    }
    // a member, a body that names a pull request number or nothing, and another account never reach the app
    const before = calls.length;
    expect((await merge(await addMember(owner.accountId, 'member'))).status).toBe(403);
    for (const body of [{}, { pr: 'sync' }, { pr: 'other' }, { pr: 'publish', number: 9 }]) expect((await merge(owner, body)).status, JSON.stringify(body)).toBe(422);
    expect((await call(owner, 'POST', `/twins/${t.id}/merge`)).status).toBe(422);
    expect(calls).toHaveLength(before);
    // a twin id that is no uuid is a 404 before the app is asked
    expect((await call(owner, 'POST', '/twins/not-a-uuid/merge', { pr: 'publish' })).status).toBe(404);
    expect(calls).toHaveLength(before);
    // no app wired: a fixed 503
    twinRouteDeps.mergePr = null;
    expect((await merge(owner)).status).toBe(503);
  });

  it('the issues list answers any member with what the app read, and each refusal has its own code; the bring button is the answer\'s can_bring', async () => {
    const owner = await account();
    const t = await readyTwin(owner);
    const calls: Array<{ accountId: string; userId: string; twinId: string }> = [];
    let answer: TwinIssuesAnswer = { result: 'ok', canBring: true, issues: [{ number: 12, title: 'It crashes', author: 'mallory', brought: null }, { number: 9, title: 'Typo', author: 'ada', brought: 3 }] };
    twinRouteDeps.listIssues = async (input) => (calls.push(input), answer);
    const member = await addMember(owner.accountId, 'member');
    const expected = { issues: [{ number: 12, title: 'It crashes', author: 'mallory', brought_issue: null }, { number: 9, title: 'Typo', author: 'ada', brought_issue: 3 }], can_bring: true };
    expect(await (await call(owner, 'GET', `/twins/${t.id}/issues`)).json()).toEqual(expected);
    answer = { result: 'ok', canBring: false, issues: [] };
    expect(await (await call(member, 'GET', `/twins/${t.id}/issues`)).json()).toEqual({ issues: [], can_bring: false });
    expect(calls).toEqual([{ accountId: owner.accountId, userId: owner.userId, twinId: t.id }, { accountId: owner.accountId, userId: member.userId, twinId: t.id }]);
    const refusals: Array<[TwinIssuesAnswer, number, string]> = [
      [{ result: 'not_found' }, 404, 'not_found'],
      [{ result: 'twin_state', state: 'refused' }, 409, 'twin_state'],
      [{ result: 'github_unavailable' }, 503, 'github_unavailable'],
    ];
    for (const [a, status, code] of refusals) {
      answer = a;
      const res = await call(owner, 'GET', `/twins/${t.id}/issues`);
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    }
    const before = calls.length;
    expect((await call(owner, 'GET', '/twins/not-a-uuid/issues')).status).toBe(404);
    expect(calls).toHaveLength(before);
    twinRouteDeps.listIssues = null;
    expect((await call(owner, 'GET', `/twins/${t.id}/issues`)).status).toBe(503);
    twinRouteDeps.enabled = false;
    twinRouteDeps.listIssues = async () => ({ result: 'ok', canBring: true, issues: [] });
    const off = await call(owner, 'GET', `/twins/${t.id}/issues`);
    expect(off.status).toBe(503);
    expect(((await off.json()) as { error: { code: string } }).error.code).toBe('not_configured');
  });

  it('Bring asks the app to bring one issue, for an owner or admin only; each answer has its own code and a bad number never reaches the app', async () => {
    const owner = await account();
    const t = await readyTwin(owner);
    const calls: Array<{ accountId: string; userId: string; twinId: string; issue: number }> = [];
    let answer: TwinBringAnswer = { result: 'ok', privateIssue: 4 };
    twinRouteDeps.bringIssue = async (input) => (calls.push(input), answer);
    const bring = (who: Identity, n: string | number = 12, id = t.id) => call(who, 'POST', `/twins/${id}/issues/${n}/bring`);
    expect(await (await bring(owner)).json()).toEqual({ private_issue: 4, already: false });
    expect(calls).toEqual([{ accountId: owner.accountId, userId: owner.userId, twinId: t.id, issue: 12 }]);
    answer = { result: 'already', privateIssue: 4 };
    expect(await (await bring(await addMember(owner.accountId, 'admin'))).json()).toEqual({ private_issue: 4, already: true });
    const refusals: Array<[TwinBringAnswer, number, string]> = [
      [{ result: 'not_found' }, 404, 'not_found'],
      [{ result: 'no_issue' }, 404, 'not_found'],
      [{ result: 'twin_state', state: 'seeding' }, 409, 'twin_state'],
      [{ result: 'issue_not_open' }, 409, 'issue_not_open'],
      [{ result: 'in_progress' }, 409, 'issue_bring_in_progress'],
      [{ result: 'not_private' }, 409, 'twin_not_private'],
      [{ result: 'visibility_unknown' }, 503, 'github_unavailable'],
      [{ result: 'github_unavailable' }, 503, 'github_unavailable'],
    ];
    for (const [a, status, code] of refusals) {
      answer = a;
      const res = await bring(owner);
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    }
    const before = calls.length;
    expect((await bring(await addMember(owner.accountId, 'member'))).status).toBe(403);
    for (const n of ['0', '-1', '1.5', 'x', '01', '12345678901']) expect((await bring(owner, n)).status, n).toBe(422);
    expect((await bring(owner, 12, 'not-a-uuid')).status).toBe(404);
    expect(calls).toHaveLength(before);
    twinRouteDeps.bringIssue = null;
    expect((await bring(owner)).status).toBe(503);
    twinRouteDeps.enabled = false;
    twinRouteDeps.bringIssue = async () => ({ result: 'ok', privateIssue: 1 });
    expect(((await (await bring(owner)).json()) as { error: { code: string } }).error.code).toBe('not_configured');
  });

  it('Bring through the route, with the real app function and a recording App port, opens one private issue, records the pair and writes one twin.issue_brought row; a second click opens nothing', async () => {
    const owner = await account();
    const t = await readyTwin(owner);
    const made: Array<{ repo: string; title: string }> = [];
    const setupInstall = {
      readIssue: async () => ({ number: 12, title: 'It crashes', body: 'text', author: 'mallory', open: true, pull: false }),
      createBroughtIssue: async (i: { repo: { name: string }; title: string }) => (made.push({ repo: i.repo.name, title: i.title }), 31),
    } as never;
    const repoVisibility = async () => 'private' as const;
    twinRouteDeps.bringIssue = (input) => bringTwinIssue({ appUserPool, setupInstall, repoVisibility }, { accountId: input.accountId, userId: input.userId }, input.twinId, input.issue);
    const rows = async () => (await admin.query<{ actor: string; payload: unknown }>("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'twin.issue_brought'", [owner.accountId])).rows;
    expect(await (await call(owner, 'POST', `/twins/${t.id}/issues/12/bring`)).json()).toEqual({ private_issue: 31, already: false });
    expect(await (await call(owner, 'POST', `/twins/${t.id}/issues/12/bring`)).json()).toEqual({ private_issue: 31, already: true });
    expect(made).toEqual([{ repo: 'widgets-private', title: 'It crashes' }]);
    expect(await rows()).toEqual([{ actor: owner.userId, payload: { twin_id: t.id, public_issue: 12, private_issue: 31 } }]);
  });

  it('the create asks for a state naming the public repo, its owner, private, no auto-init and Discussions only by the twin purpose', async () => {
    const owner = await account();
    const repo = await seedRepo(owner.accountId);
    const res = await call(owner, 'POST', `/repos/${repo}/twin`, {});
    expect(res.status).toBe(200);
    const { url, claims } = await authorize(res);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe('https://cloud.example.test/api/github/create-repo/callback');
    expect(claims).toMatchObject({ account_id: owner.accountId, user_id: owner.userId, owner_gh_id: 4242, name: 'widgets-private', visibility: 'private', auto_init: false, purpose: 'twin', twin_of: repo });
    expect(asked).toEqual(['acme/widgets']);
    const named = await authorize(await call(owner, 'POST', `/repos/${repo}/twin`, { name: 'my.twin_1' }));
    expect(named.claims?.name).toBe('my.twin_1');
    // Nothing is recorded by the intent itself.
    expect((await admin.query('SELECT 1 FROM repo_twins WHERE account_id = $1', [owner.accountId])).rows).toHaveLength(0);
  });

  it('refuses a bad name with 422 before GitHub is asked, and a repo that is not public with the same answer for every non-public case', async () => {
    const owner = await account();
    const repo = await seedRepo(owner.accountId);
    for (const name of ['', 'a b', '../x', '.', 'x'.repeat(101), 'acme/x']) {
      const res = await call(owner, 'POST', `/repos/${repo}/twin`, { name });
      expect(res.status).toBe(422);
    }
    expect((await call(owner, 'POST', `/repos/${repo}/twin`, { name: 'ok', extra: 1 })).status).toBe(422);
    expect(asked).toEqual([]);
    world = { visibility: 'not_public', defaultBranch: null, appInstalled: false, ownerGhId: null };
    const res = await call(owner, 'POST', `/repos/${repo}/twin`, {});
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('twin_repo_not_public');
    world = 'down';
    expect((await call(owner, 'POST', `/repos/${repo}/twin`, {})).status).toBe(503);
    world = { ...PUBLIC, ownerGhId: null };
    expect((await call(owner, 'POST', `/repos/${repo}/twin`, {})).status).toBe(503);
  });

  it('only an owner or admin creates; a member is refused, a stranger sees a 404, and neither reaches GitHub', async () => {
    const owner = await account();
    const other = await account();
    const repo = await seedRepo(owner.accountId);
    const member = await addMember(owner.accountId, 'member');
    expect((await call(member, 'POST', `/repos/${repo}/twin`, {})).status).toBe(403);
    expect((await call(other, 'POST', `/repos/${repo}/twin`, {})).status).toBe(404);
    expect((await call(other, 'GET', `/repos/${repo}/twin`)).status).toBe(404);
    expect(asked).toEqual([]);
    const admin2 = await addMember(owner.accountId, 'admin');
    expect((await call(admin2, 'POST', `/repos/${repo}/twin`, {})).status).toBe(200);
  });

  it('refuses a repo that already has a twin or a pairing, 409, before GitHub is asked', async () => {
    const owner = await account();
    const repo = await seedRepo(owner.accountId);
    const paired = await seedRepo(owner.accountId, 'paired');
    await admin.query(`INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/x', ARRAY['p/**'])`, [paired, owner.accountId]);
    const res = await call(owner, 'POST', `/repos/${paired}/twin`, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('pairing_exists');
    await makeTwin(owner, repo);
    const dup = await call(owner, 'POST', `/repos/${repo}/twin`, {});
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe('twin_exists');
    expect(asked).toEqual([]);
  });

  it('reads the live twin as the card needs it, and a removed twin reads as none', async () => {
    const owner = await account();
    const repo = await seedRepo(owner.accountId);
    expect(await (await call(owner, 'GET', `/repos/${repo}/twin`)).json()).toEqual({ twin: null });
    const id = await makeTwin(owner, repo);
    const got = (await (await call(await addMember(owner.accountId, 'member'), 'GET', `/repos/${repo}/twin`)).json()) as { twin: Record<string, unknown> };
    expect(got.twin).toMatchObject({ id, public_repo_id: repo, private_repo_id: null, private_name: 'widgets-private', state: 'not_connected', overlay_globs: [], publish_pr: null, sync_pr: null, failure_code: null });
    await call(owner, 'DELETE', `/twins/${id}`);
    expect(await (await call(owner, 'GET', `/repos/${repo}/twin`)).json()).toEqual({ twin: null });
  });

  it('pause, resume and stop publishing: owner or admin only, each audited, a wrong state is a 409 that changes nothing', async () => {
    const owner = await account();
    const repo = await seedRepo(owner.accountId);
    const priv = await seedRepo(owner.accountId, 'widgets-private');
    const id = await makeTwin(owner, repo, priv);
    const member = await addMember(owner.accountId, 'member');
    for (const [method, path] of [['POST', `/twins/${id}/pause`], ['POST', `/twins/${id}/resume`], ['DELETE', `/twins/${id}`]] as const) expect((await call(member, method, path)).status).toBe(403);
    expect(await stateOf(id)).toBe('seeding');
    const resumeEarly = await call(owner, 'POST', `/twins/${id}/resume`);
    expect(resumeEarly.status).toBe(409);
    expect(await resumeEarly.json()).toMatchObject({ error: { code: 'twin_state' }, data: { state: 'seeding' } });
    expect((await (await call(owner, 'POST', `/twins/${id}/pause`)).json()) as { state: string }).toMatchObject({ state: 'paused' });
    expect((await call(owner, 'POST', `/twins/${id}/pause`)).status).toBe(409);
    expect(await (await call(await addMember(owner.accountId, 'admin'), 'POST', `/twins/${id}/resume`)).json()).toMatchObject({ state: 'seeding' });
    const stopped = await call(owner, 'DELETE', `/twins/${id}`);
    expect(await stopped.json()).toMatchObject({ id, state: 'removed', private_repo_id: priv });
    expect((await call(owner, 'DELETE', `/twins/${id}`)).status).toBe(409);
    const log = await admin.query(`SELECT action FROM audit_log WHERE account_id = $1 AND action LIKE 'twin.%' ORDER BY created_at, id`, [owner.accountId]);
    expect(log.rows.map((r) => r.action)).toEqual(['twin.created', 'twin.paused', 'twin.resumed', 'twin.removed']);
    // We never delete a GitHub repo: the repo row is still there, and the only calls GitHub saw were none.
    expect((await admin.query('SELECT 1 FROM repos WHERE id = $1', [priv])).rows).toHaveLength(1);
    expect(asked).toEqual([]);
  });

  it('stopping a twin closes its open publish pull request after the removal, and only then; a close that fails never undoes the removal', async () => {
    const owner = await account();
    const closed: Array<{ accountId: string; userId: string; twinId: string }> = [];
    const states: Array<string | undefined> = [];
    twinRouteDeps.closePublishPr = async (input) => {
      closed.push(input);
      states.push(await stateOf(input.twinId));
    };
    // pause and resume close nothing
    const repo = await seedRepo(owner.accountId);
    const priv = await seedRepo(owner.accountId, 'widgets-private');
    const id = await makeTwin(owner, repo, priv);
    await call(owner, 'POST', `/twins/${id}/pause`);
    await call(owner, 'POST', `/twins/${id}/resume`);
    expect(closed).toEqual([]);
    // a member is refused before anything is closed, and a wrong state is a 409 that closes nothing
    expect((await call(await addMember(owner.accountId, 'member'), 'DELETE', `/twins/${id}`)).status).toBe(403);
    expect(closed).toEqual([]);
    expect((await call(owner, 'DELETE', `/twins/${id}`)).status).toBe(200);
    // asked once, by the person who stopped it, and the twin was already removed when it was
    expect(closed).toEqual([{ accountId: owner.accountId, userId: owner.userId, twinId: id }]);
    expect(states).toEqual(['removed']);
    expect((await call(owner, 'DELETE', `/twins/${id}`)).status).toBe(409);
    expect(closed).toHaveLength(1);
    // a hook that throws is reported and the removal stands
    twinRouteDeps.closePublishPr = async () => {
      throw new Error('github is down');
    };
    const repo2 = await seedRepo(owner.accountId, 'gadgets');
    const priv2 = await seedRepo(owner.accountId, 'gadgets-private');
    const id2 = await makeTwin(owner, repo2, priv2);
    const stopped = await call(owner, 'DELETE', `/twins/${id2}`);
    expect(stopped.status).toBe(200);
    expect(await stateOf(id2)).toBe('removed');
  });

  it('stopping a twin also closes its open sync pull request, each close on its own: a publish close that fails does not stop the sync close, and neither undoes the removal', async () => {
    const owner = await account();
    const order: string[] = [];
    const seen: Array<{ accountId: string; userId: string; twinId: string }> = [];
    twinRouteDeps.closePublishPr = async () => {
      order.push('publish');
      throw new Error('github is down');
    };
    twinRouteDeps.closeSyncPr = async (input) => {
      order.push(`sync:${await stateOf(input.twinId)}`);
      seen.push(input);
    };
    const repo = await seedRepo(owner.accountId, 'sync-widgets');
    const priv = await seedRepo(owner.accountId, 'sync-widgets-private');
    const id = await makeTwin(owner, repo, priv);
    await call(owner, 'POST', `/twins/${id}/pause`);
    await call(owner, 'POST', `/twins/${id}/resume`);
    expect(order).toEqual([]);
    expect((await call(await addMember(owner.accountId, 'member'), 'DELETE', `/twins/${id}`)).status).toBe(403);
    expect(order).toEqual([]);
    expect((await call(owner, 'DELETE', `/twins/${id}`)).status).toBe(200);
    expect(order).toEqual(['publish', 'sync:removed']);
    expect(seen).toEqual([{ accountId: owner.accountId, userId: owner.userId, twinId: id }]);
    expect(await stateOf(id)).toBe('removed');
    // a second stop is a 409 and closes nothing more
    expect((await call(owner, 'DELETE', `/twins/${id}`)).status).toBe(409);
    expect(order).toHaveLength(2);
    // a sync close that throws is reported and the removal stands
    twinRouteDeps.closeSyncPr = async () => {
      throw new Error('github is down');
    };
    const id2 = await makeTwin(owner, await seedRepo(owner.accountId, 'sync-gadgets'), await seedRepo(owner.accountId, 'sync-gadgets-private'));
    expect((await call(owner, 'DELETE', `/twins/${id2}`)).status).toBe(200);
    expect(await stateOf(id2)).toBe('removed');
  });

  it("a second account cannot pause, resume or stop the first one's twin, or read it", async () => {
    const one = await account();
    const two = await account();
    const id = await makeTwin(one, await seedRepo(one.accountId));
    for (const [method, path] of [['POST', `/twins/${id}/pause`], ['POST', `/twins/${id}/resume`], ['DELETE', `/twins/${id}`]] as const) {
      const res = await call(two, method, path);
      expect(res.status).toBe(404);
    }
    expect(await stateOf(id)).toBe('not_connected');
    expect((await call(two, 'POST', `/twins/${randomUUID()}/pause`)).status).toBe(404);
    expect((await call(two, 'POST', '/twins/not-a-uuid/pause')).status).toBe(404);
  });

  it('a repo of a live twin, either side, cannot be paired (409 twin_exists) and can again after Stop publishing', async () => {
    const owner = await account();
    const pub = await seedRepo(owner.accountId);
    const priv = await seedRepo(owner.accountId, 'widgets-private');
    const id = await makeTwin(owner, pub, priv);
    const body = { code_repo: 'acme/widgets-public', overlay_globs: ['private/**'] };
    for (const repo of [pub, priv]) {
      const res = await call(owner, 'PUT', `/repos/${repo}/pairing`, body);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('twin_exists');
      expect((await admin.query('SELECT 1 FROM repo_pairing WHERE repo_id = $1', [repo])).rows).toHaveLength(0);
    }
    // Another repo of the same account is unaffected.
    expect((await call(owner, 'PUT', `/repos/${await seedRepo(owner.accountId, 'free')}/pairing`, body)).status).toBe(200);
    await call(owner, 'DELETE', `/twins/${id}`);
    expect((await call(owner, 'PUT', `/repos/${pub}/pairing`, body)).status).toBe(200);
  });

  it('a repo a pairing would name as its public repo (code_repo) cannot be paired while a live twin holds it, either side, and can once the twin is gone', async () => {
    const owner = await account();
    const pub = await seedRepo(owner.accountId, 'widgets');
    const priv = await seedRepo(owner.accountId, 'widgets-private');
    const id = await makeTwin(owner, pub, priv);
    const third = await seedRepo(owner.accountId, 'third');
    for (const code_repo of ['acme/widgets', 'ACME/Widgets-Private']) {
      const res = await call(owner, 'PUT', `/repos/${third}/pairing`, { code_repo, overlay_globs: ['private/**'] });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('twin_exists');
    }
    expect((await admin.query('SELECT 1 FROM repo_pairing WHERE repo_id = $1', [third])).rows).toHaveLength(0);
    // A name that is no repo of the account is nobody's twin, and neither is a repo of ANOTHER account with the twin's name.
    expect((await call(owner, 'PUT', `/repos/${third}/pairing`, { code_repo: 'acme/unrelated', overlay_globs: ['private/**'] })).status).toBe(200);
    const other = await account();
    await seedRepo(other.accountId, 'widgets');
    expect((await call(other, 'PUT', `/repos/${await seedRepo(other.accountId, 'mine')}/pairing`, { code_repo: 'acme/widgets', overlay_globs: ['private/**'] })).status).toBe(200);
    await call(owner, 'DELETE', `/twins/${id}`);
    expect((await call(owner, 'PUT', `/repos/${third}/pairing`, { code_repo: 'acme/widgets', overlay_globs: ['private/**'] })).status).toBe(200);
  });

  it('a pairing and a twin made at the same moment cannot both stand: the open twin create holds the repo, and the pairing waits and is refused', async () => {
    const owner = await account();
    const pub = await seedRepo(owner.accountId, 'widgets');
    const priv = await seedRepo(owner.accountId, 'widgets-private');
    const c = await appUserPool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)", [owner.accountId, owner.userId]);
      expect((await c.query<{ o_result: string }>('SELECT o_result FROM twin_record($1, $2, 56, $3)', [pub, priv, 'widgets-private'])).rows[0]!.o_result).toBe('ok');
      const pairing = call(owner, 'PUT', `/repos/${pub}/pairing`, { code_repo: 'acme/widgets-public', overlay_globs: ['private/**'] });
      expect(await Promise.race([pairing.then(() => 'answered'), new Promise((r) => setTimeout(() => r('waiting'), 500))])).toBe('waiting');
      await c.query('COMMIT');
      const res = await pairing;
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('twin_exists');
    } finally {
      c.release();
    }
    expect((await admin.query('SELECT 1 FROM repo_pairing WHERE repo_id = $1', [pub])).rows).toHaveLength(0);
    expect((await admin.query('SELECT 1 FROM repo_twins WHERE public_repo_id = $1', [pub])).rows).toHaveLength(1);
  });
});
