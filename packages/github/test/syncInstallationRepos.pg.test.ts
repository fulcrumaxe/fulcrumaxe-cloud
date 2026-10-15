import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { InstallationTokenCache, syncInstallationRepos, type SyncDeps } from '../src/index.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { strictGithubFetch } from './helpers/strictGithub.js';
// Relative on purpose: @fx/github does not depend on @fx/roles; the test compares against the manifest itself.
import { ROLE_MANIFEST } from '../../roles/src/manifest.js';

/**
 * D#2 H17b-1 against real Postgres: repo sync as the tenant's app_user.
 * GitHub is faked (the list endpoint and the token mint).
 */
describe('syncInstallationRepos (D#2 H17b-1)', () => {
  let adminPool: Pool;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let admin: PoolClient;
  let pem: string;
  let nextGh = 8_100_000;
  const TOKEN = 'ghs_secret_sync_token';

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    appUserPool = createPool(process.env.GITHUB_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.GITHUB_DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
    pem = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
      .privateKey as unknown as string;
  });
  afterAll(async () => {
    admin.release();
    await appUserPool.end();
    await platformOpsPool.end();
    await adminPool.end();
  });

  async function account(): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [id, `cus_${id}`]);
    return id;
  }
  /** A claimed installation: an installations row plus its installer record. */
  async function install(accountId: string, kind = 'team', flags: { deleted?: boolean; suspended?: boolean; noInstaller?: boolean } = {}) {
    const id = randomUUID();
    const gh = nextGh++;
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, $4)`, [id, accountId, gh, kind]);
    if (!flags.noInstaller) {
      await admin.query(
        `INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id, deleted_at, suspended_at)
         VALUES ($1, $2, 1, $3, $4)`,
        [gh, kind, flags.deleted ? new Date() : null, flags.suspended ? new Date() : null],
      );
    }
    return { id, gh };
  }
  const repoRows = async (accountId: string) =>
    (await admin.query(`SELECT gh_repo_id, gh_owner, gh_name, installation_id, product FROM repos WHERE account_id = $1 ORDER BY gh_repo_id`, [accountId])).rows;

  /** A repository's node id as GitHub lists it (`R_kgDO` + the numeric id, base64url). */
  const nodeIdOf = (id: number): string => `R_kgDO${Buffer.from(Uint32Array.of(id).buffer).reverse().toString('base64url')}`;
  type Listed = { id: number; name: string; owner?: string; /** undefined: the real one; null: field left out; string: sent as is */ nodeId?: string | null };
  const page = (repos: Listed[], total = repos.length) =>
    Response.json({
      total_count: total,
      repositories: repos.map((r) => ({
        id: r.id,
        ...(r.nodeId === null ? {} : { node_id: r.nodeId ?? nodeIdOf(r.id) }),
        name: r.name,
        owner: { login: r.owner ?? 'acme' },
      })),
    });

  function harness(all: Array<Listed>) {
    const auths: string[] = [];
    const minted: Array<{ installationId: number; permissions: unknown; repositories: unknown }> = [];
    const warn = vi.fn();
    const fetchImpl = vi.fn(strictGithubFetch(async (url: string | URL | Request, init?: RequestInit) => {
      auths.push(String((init?.headers as Record<string, string>).authorization));
      const p = Number(new URL(String(url)).searchParams.get('page'));
      return page(all.slice((p - 1) * 100, p * 100), all.length);
    })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const deps: SyncDeps = {
      platformOpsPool,
      appUserPool,
      appCredentials: () => ({ appId: '7', privateKeyPem: pem, webhookSecret: '' }),
      requester: async (p) => {
        minted.push({ installationId: p.installationId, permissions: p.permissions, repositories: p.repositories });
        return { token: TOKEN, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
      },
      cache: new InstallationTokenCache(),
      fetchImpl,
      warn,
    };
    return { deps, fetchImpl, auths, minted, warn };
  }

  it('lists every page and writes one bound row per repo with owner and name; a bad name is skipped and never logged', async () => {
    const acc = await account();
    const inst = await install(acc);
    const all = Array.from({ length: 250 }, (_, i) => ({ id: 1000 + i, name: `repo-${i}` }));
    all.push({ id: 5000, name: 'bad name!' });
    const h = harness(all);
    const out = await syncInstallationRepos(h.deps, inst.id);
    expect(out).toMatchObject({ status: 'synced', inserted: 250, skippedInvalid: 1 });
    expect(h.fetchImpl).toHaveBeenCalledTimes(3);
    const rows = await repoRows(acc);
    expect(rows).toHaveLength(250);
    expect(rows[0]).toMatchObject({ gh_owner: 'acme', gh_name: 'repo-0', installation_id: inst.id, product: 'team' });
    expect(h.warn.mock.calls.flat().join(' ')).not.toContain('bad name');
    expect(h.warn.mock.calls.flat().join(' ')).not.toContain(TOKEN);
    expect(new Set(h.auths)).toEqual(new Set([`Bearer ${TOKEN}`]));
    // installation-wide token: metadata read only, no repository list
    expect(h.minted[0]).toEqual({ installationId: inst.gh, permissions: { metadata: 'read' }, repositories: null });
  });

  it('a newly synced repo gets exactly one role_settings row per manifest role, at the manifest default mode with no model (H08-followup)', async () => {
    const acc = await account();
    const inst = await install(acc);
    const h = harness([{ id: 2001, name: 'a' }, { id: 2002, name: 'b' }]);
    expect(await syncInstallationRepos(h.deps, inst.id)).toMatchObject({ status: 'synced', inserted: 2 });
    const { rows: repos } = await admin.query<{ id: string }>(`SELECT id FROM repos WHERE account_id = $1`, [acc]);
    expect(repos).toHaveLength(2);
    const expected = ROLE_MANIFEST.map((r) => [r.name, r.defaultMode]).sort();
    for (const repo of repos) {
      const { rows } = await admin.query<{ role: string; mode: string; model: string | null; account_id: string }>(
        `SELECT role, mode, model, account_id FROM role_settings WHERE repo_id = $1`,
        [repo.id],
      );
      expect(rows).toHaveLength(ROLE_MANIFEST.length);
      expect(rows.map((r) => [r.role, r.mode]).sort()).toEqual(expected);
      expect(rows.every((r) => r.model === null && r.account_id === acc)).toBe(true);
    }
  });

  it('a second sync of the same repos leaves a tenant-changed role_settings row alone', async () => {
    const acc = await account();
    const inst = await install(acc);
    const h = harness([{ id: 2101, name: 'a' }]);
    await syncInstallationRepos(h.deps, inst.id);
    const { rows: repos } = await admin.query<{ id: string }>(`SELECT id FROM repos WHERE account_id = $1`, [acc]);
    await admin.query(`UPDATE role_settings SET mode = 'off', model = 'opus-5' WHERE repo_id = $1 AND role = 'executor'`, [repos[0]!.id]);
    expect(await syncInstallationRepos(h.deps, inst.id)).toMatchObject({ status: 'synced', inserted: 0, updated: 1 });
    const { rows } = await admin.query(`SELECT mode, model FROM role_settings WHERE repo_id = $1 AND role = 'executor'`, [repos[0]!.id]);
    expect(rows).toEqual([{ mode: 'off', model: 'opus-5' }]);
    expect((await admin.query(`SELECT 1 FROM role_settings WHERE repo_id = $1`, [repos[0]!.id])).rowCount).toBe(ROLE_MANIFEST.length);
  });

  it('mints per kind: run for team, preview_read for team_readonly, sitekit_read for sitekit (all metadata read only, installation-wide)', async () => {
    const acc = await account();
    const ro = await install(acc, 'team_readonly');
    const h = harness([{ id: 1, name: 'a' }]);
    await syncInstallationRepos(h.deps, ro.id);
    expect(h.minted[0]?.permissions).toEqual({ metadata: 'read' });
    expect(h.minted[0]?.repositories).toBeNull();
    const sk = await install(acc, 'sitekit');
    expect(await syncInstallationRepos(h.deps, sk.id)).toMatchObject({ status: 'synced', inserted: 1 });
    expect(h.minted).toHaveLength(2);
    expect(h.minted[1]).toEqual({ installationId: sk.gh, permissions: { metadata: 'read' }, repositories: null });
  });

  it('a sitekit sync asks for its own credentials and the sitekit_read purpose (a run/preview_read mint would throw for this kind)', async () => {
    const acc = await account();
    const sk = await install(acc, 'sitekit');
    const h = harness([{ id: 1, name: 'a' }]);
    const kinds: string[] = [];
    h.deps.appCredentials = (k) => {
      kinds.push(String(k));
      return { appId: '7', privateKeyPem: pem, webhookSecret: '' };
    };
    expect(await syncInstallationRepos(h.deps, sk.id)).toMatchObject({ status: 'synced', inserted: 1 });
    expect(kinds).toEqual(['sitekit']);
    expect(await repoRows(acc)).toMatchObject([{ gh_repo_id: '1', installation_id: sk.id, product: 'sitekit' }]);
  });

  it('an unknown kind is still skipped as unsupported_kind, before any mint', async () => {
    // installations.app_kind has a CHECK, so an unknown kind can only be reached through a stubbed platform_ops read.
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM installations')) return { rows: [{ account_id: randomUUID(), gh_installation_id: '5', app_kind: 'mystery' }] };
      if (sql.includes('FROM installation_installers')) return { rows: [{ deleted_at: null, suspended_at: null }] };
      return { rows: [] };
    });
    const h = harness([{ id: 1, name: 'a' }]);
    h.deps.platformOpsPool = { connect: async () => ({ query, release: () => {} }) } as unknown as Pool;
    expect(await syncInstallationRepos(h.deps, randomUUID())).toEqual({ status: 'skipped', reason: 'unsupported_kind' });
    expect(h.minted).toHaveLength(0);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('team and sitekit rows sit side by side: install team, then sitekit, then team_readonly on one repo leaves exactly two rows', async () => {
    const acc = await account();
    const team = await install(acc, 'team');
    const sk = await install(acc, 'sitekit');
    const ro = await install(acc, 'team_readonly');
    const h = harness([{ id: 77, name: 'both' }]);
    await syncInstallationRepos(h.deps, team.id);
    expect(await syncInstallationRepos(h.deps, sk.id)).toMatchObject({ inserted: 1, repointed: 0 });
    expect(await syncInstallationRepos(h.deps, ro.id)).toMatchObject({ inserted: 0, updated: 0, repointed: 0 });
    const rows = await repoRows(acc);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.product, r.installation_id]).sort()).toEqual([['sitekit', sk.id], ['team', team.id]].sort());
  });

  it('a team install re-points only the team_readonly row, never a sitekit row', async () => {
    const acc = await account();
    const ro = await install(acc, 'team_readonly');
    const sk = await install(acc, 'sitekit');
    const team = await install(acc, 'team');
    const h = harness([{ id: 78, name: 'x' }]);
    await syncInstallationRepos(h.deps, sk.id);
    await syncInstallationRepos(h.deps, ro.id);
    expect(await syncInstallationRepos(h.deps, team.id)).toMatchObject({ repointed: 1, inserted: 0 });
    const rows = await repoRows(acc);
    expect(rows.map((r) => [r.product, r.installation_id]).sort()).toEqual([['sitekit', sk.id], ['team', team.id]].sort());
  });

  it('two concurrent syncs, one team and one sitekit, of the same repos leave exactly one row per (repo, product)', async () => {
    const acc = await account();
    const team = await install(acc, 'team');
    const sk = await install(acc, 'sitekit');
    const all = Array.from({ length: 30 }, (_, i) => ({ id: 600 + i, name: `s${i}` }));
    await Promise.all([
      ...Array.from({ length: 3 }, () => syncInstallationRepos(harness(all).deps, team.id)),
      ...Array.from({ length: 3 }, () => syncInstallationRepos(harness(all).deps, sk.id)),
    ]);
    const rows = await repoRows(acc);
    expect(rows).toHaveLength(60);
    expect(new Set(rows.map((r) => `${r.gh_repo_id}:${r.product}`)).size).toBe(60);
  });

  it('the advisory lock is per product: a held team lock on a repo does not stall a sitekit sync of it, and a held sitekit lock does', async () => {
    const acc = await account();
    const sk = await install(acc, 'sitekit');
    const holder = await adminPool.connect();
    const settled = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => 'done'), new Promise((r) => setTimeout(() => r('blocked'), ms))]);
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`repos-sync:${acc}:88:team`]);
      expect(await settled(syncInstallationRepos(harness([{ id: 88, name: 'k' }]).deps, sk.id), 3000)).toBe('done');
      await holder.query('COMMIT');

      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`repos-sync:${acc}:88:sitekit`]);
      const pending = syncInstallationRepos(harness([{ id: 88, name: 'k' }]).deps, sk.id);
      expect(await settled(pending, 1000)).toBe('blocked');
      await holder.query('COMMIT');
      expect(await pending).toMatchObject({ status: 'synced' });
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
    }
  });

  it("a sitekit sync writes only its own account, and app_user cannot write a foreign account's sitekit row", async () => {
    const a = await account();
    const b = await account();
    const instA = await install(a, 'sitekit');
    const instB = await install(b, 'sitekit');
    await syncInstallationRepos(harness([{ id: 19, name: 'mine', owner: 'orgb' }]).deps, instB.id);
    await syncInstallationRepos(harness([{ id: 19, name: 'renamed', owner: 'orgb' }]).deps, instA.id);
    expect(await repoRows(b)).toMatchObject([{ gh_name: 'mine', installation_id: instB.id, product: 'sitekit' }]);
    expect(await repoRows(a)).toMatchObject([{ gh_name: 'renamed', installation_id: instA.id, product: 'sitekit' }]);
    await expect(
      withTenant(appUserPool, a, (c) =>
        c.query(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, 20, 'sitekit')`, [b, instB.id]),
      ),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it('is idempotent, and reattaches a repo whose installation_id was cleared', async () => {
    const acc = await account();
    const inst = await install(acc);
    const h = harness([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
    await syncInstallationRepos(h.deps, inst.id);
    await admin.query(`UPDATE repos SET installation_id = NULL WHERE account_id = $1 AND gh_repo_id = 2`, [acc]);
    await syncInstallationRepos(h.deps, inst.id);
    const rows = await repoRows(acc);
    expect(rows.map((r) => [r.gh_repo_id, r.installation_id])).toEqual([['1', inst.id], ['2', inst.id]]);
  });

  it('a team install re-points a team_readonly row; a team_readonly sync never takes a team row back', async () => {
    const acc = await account();
    const ro = await install(acc, 'team_readonly');
    const team = await install(acc, 'team');
    const h = harness([{ id: 7, name: 'shared' }]);
    await syncInstallationRepos(h.deps, ro.id);
    expect((await repoRows(acc))[0]?.installation_id).toBe(ro.id);
    expect(await syncInstallationRepos(h.deps, team.id)).toMatchObject({ repointed: 1, inserted: 0 });
    expect(await repoRows(acc)).toMatchObject([{ installation_id: team.id }]);
    expect(await syncInstallationRepos(h.deps, ro.id)).toMatchObject({ status: 'synced', inserted: 0, updated: 0, repointed: 0 });
    expect(await repoRows(acc)).toMatchObject([{ installation_id: team.id }]);
  });

  it('skips an unknown, unclaimed, deleted or suspended installation before any GitHub call or write', async () => {
    const acc = await account();
    const cases = [
      [randomUUID(), 'unclaimed'],
      ['not-a-uuid', 'unclaimed'],
      [(await install(acc, 'team', { noInstaller: true })).id, 'unclaimed'],
      [(await install(acc, 'team', { deleted: true })).id, 'inactive'],
      [(await install(acc, 'team', { suspended: true })).id, 'inactive'],
    ] as const;
    const h = harness([{ id: 1, name: 'a' }]);
    for (const [id, reason] of cases) expect(await syncInstallationRepos(h.deps, id)).toEqual({ status: 'skipped', reason });
    expect(h.minted).toHaveLength(0);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(await repoRows(acc)).toHaveLength(0);
  });

  it('two concurrent syncs of one installation leave exactly one row per repo', async () => {
    const acc = await account();
    const inst = await install(acc);
    const all = Array.from({ length: 40 }, (_, i) => ({ id: 300 + i, name: `r${i}` }));
    await Promise.all(Array.from({ length: 4 }, () => syncInstallationRepos(harness(all).deps, inst.id)));
    const rows = await repoRows(acc);
    expect(rows).toHaveLength(40);
    expect(new Set(rows.map((r) => r.gh_repo_id)).size).toBe(40);
  });

  it("a sync writes only its own account: another account's row for the same GitHub repo is untouched, and app_user cannot write a foreign account_id", async () => {
    const a = await account();
    const b = await account();
    const instA = await install(a);
    const instB = await install(b);
    await syncInstallationRepos(harness([{ id: 9, name: 'mine', owner: 'orga' }]).deps, instB.id);
    await syncInstallationRepos(harness([{ id: 9, name: 'renamed', owner: 'orga' }]).deps, instA.id);
    expect(await repoRows(b)).toMatchObject([{ gh_name: 'mine', installation_id: instB.id }]);
    expect(await repoRows(a)).toMatchObject([{ gh_name: 'renamed', installation_id: instA.id }]);

    await expect(
      withTenant(appUserPool, a, (c) =>
        c.query(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, 10, 'team')`, [b, instB.id]),
      ),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    const upd = await withTenant(appUserPool, a, (c) => c.query(`UPDATE repos SET gh_name = 'x' WHERE account_id = $1`, [b]));
    expect(upd.rowCount).toBe(0);
  });

  describe('detaching repos the provider no longer lists', () => {
    const attachedTo = async (acc: string) => (await repoRows(acc)).map((r) => [Number(r.gh_repo_id), r.installation_id] as const);

    it("detaches (never deletes) this installation's repos missing from the listing, keeps their role settings, and reattaches them when they return", async () => {
      const acc = await account();
      const inst = await install(acc);
      await syncInstallationRepos(harness([{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }]).deps, inst.id);
      const out = await syncInstallationRepos(harness([{ id: 2, name: 'b' }]).deps, inst.id);
      expect(out).toMatchObject({ status: 'synced', inserted: 0, updated: 1, detached: 2 });
      expect(await attachedTo(acc)).toEqual([[1, null], [2, inst.id], [3, null]]);
      const { rows: kept } = await admin.query(
        `SELECT count(*)::int AS n FROM role_settings rs JOIN repos r ON r.id = rs.repo_id WHERE r.account_id = $1`,
        [acc],
      );
      expect(kept[0].n).toBe(3 * ROLE_MANIFEST.length);
      // a second identical sync has nothing left to detach
      expect(await syncInstallationRepos(harness([{ id: 2, name: 'b' }]).deps, inst.id)).toMatchObject({ detached: 0 });
      // the repo returns: it is reattached, not duplicated
      expect(await syncInstallationRepos(harness([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]).deps, inst.id)).toMatchObject({ inserted: 0, detached: 0 });
      expect(await attachedTo(acc)).toEqual([[1, inst.id], [2, inst.id], [3, null]]);
    });

    it('an empty listing detaches every repo of the installation', async () => {
      const acc = await account();
      const inst = await install(acc);
      await syncInstallationRepos(harness([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]).deps, inst.id);
      expect(await syncInstallationRepos(harness([]).deps, inst.id)).toMatchObject({ status: 'synced', detached: 2 });
      expect(await attachedTo(acc)).toEqual([[1, null], [2, null]]);
    });

    it('touches nothing that belongs to another installation, another product or another account', async () => {
      const a = await account();
      const b = await account();
      const team = await install(a, 'team');
      const other = await install(a, 'team');
      const sk = await install(a, 'sitekit');
      const bTeam = await install(b, 'team');
      await syncInstallationRepos(harness([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]).deps, team.id);
      await syncInstallationRepos(harness([{ id: 3, name: 'c' }]).deps, other.id);
      await syncInstallationRepos(harness([{ id: 1, name: 'a' }]).deps, sk.id);
      await syncInstallationRepos(harness([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]).deps, bTeam.id);
      // team now lists nothing: only its own two team rows go
      expect(await syncInstallationRepos(harness([]).deps, team.id)).toMatchObject({ detached: 2 });
      const rowsA = (await repoRows(a))
        .map((r) => [Number(r.gh_repo_id), r.product, r.installation_id])
        .sort((x, y) => Number(x[0]) - Number(y[0]) || String(x[1]).localeCompare(String(y[1])));
      expect(rowsA).toEqual([[1, 'sitekit', sk.id], [1, 'team', null], [2, 'team', null], [3, 'team', other.id]]);
      expect(await attachedTo(b)).toEqual([[1, bTeam.id], [2, bTeam.id]]);
    });

    it('a repo whose name fails our grammar but is still listed stays attached', async () => {
      const acc = await account();
      const inst = await install(acc);
      await syncInstallationRepos(harness([{ id: 1, name: 'ok' }, { id: 2, name: 'fine' }]).deps, inst.id);
      const out = await syncInstallationRepos(harness([{ id: 1, name: 'ok' }, { id: 2, name: 'no good!' }]).deps, inst.id);
      expect(out).toMatchObject({ skippedInvalid: 1, detached: 0 });
      expect(await attachedTo(acc)).toEqual([[1, inst.id], [2, inst.id]]);
    });

    it('a listing with an entry that has no usable id is refused: nothing is detached or added', async () => {
      const acc = await account();
      const inst = await install(acc);
      await syncInstallationRepos(harness([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]).deps, inst.id);
      const h = harness([]);
      h.deps.fetchImpl = (async () =>
        Response.json({ repositories: [{ id: 1, name: 'a', owner: { login: 'acme' } }, { id: null, name: 'x', owner: { login: 'acme' } }] })) as unknown as typeof fetch;
      await expect(syncInstallationRepos(h.deps, inst.id)).rejects.toMatchObject({ name: 'RepoListIncompleteError', reason: 'unusable_id' });
      expect(await attachedTo(acc)).toEqual([[1, inst.id], [2, inst.id]]);
    });

    it.each([
      ['an empty object', '{}'],
      ['null', 'null'],
      ['a message object', '{"message":"Bad credentials"}'],
      ['a non-array repositories value', '{"total_count":0,"repositories":"none"}'],
    ])('a 200 listing whose body is %s is refused: nothing is changed', async (_label, raw) => {
      const acc = await account();
      const inst = await install(acc);
      await syncInstallationRepos(harness([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]).deps, inst.id);
      const h = harness([]);
      h.deps.fetchImpl = (async () => new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
      await expect(syncInstallationRepos(h.deps, inst.id)).rejects.toMatchObject({ name: 'RepoListIncompleteError', reason: 'malformed_page' });
      expect(await attachedTo(acc)).toEqual([[1, inst.id], [2, inst.id]]);
    });

    it('a malformed later page is refused even after a good first page: nothing is changed', async () => {
      const acc = await account();
      const inst = await install(acc);
      const all = Array.from({ length: 120 }, (_, i) => ({ id: 400 + i, name: `m${i}` }));
      await syncInstallationRepos(harness(all).deps, inst.id);
      const h = harness(all.slice(0, 100));
      h.deps.fetchImpl = (async (url: string | URL | Request) =>
        Number(new URL(String(url)).searchParams.get('page')) === 1 ? page(all.slice(0, 100), 100) : Response.json({})) as unknown as typeof fetch;
      await expect(syncInstallationRepos(h.deps, inst.id)).rejects.toMatchObject({ name: 'RepoListIncompleteError', reason: 'malformed_page' });
      expect((await attachedTo(acc)).every(([, i]) => i === inst.id)).toBe(true);
    });

    it('a listing whose id count disagrees with its total_count is refused: nothing is changed', async () => {
      const acc = await account();
      const inst = await install(acc);
      await syncInstallationRepos(harness([{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }]).deps, inst.id);
      for (const total of [5, 0]) {
        const h = harness([]);
        h.deps.fetchImpl = (async () => page([{ id: 1, name: 'a' }], total)) as unknown as typeof fetch;
        await expect(syncInstallationRepos(h.deps, inst.id)).rejects.toMatchObject({ name: 'RepoListIncompleteError', reason: 'count_mismatch' });
        expect(await attachedTo(acc)).toEqual([[1, inst.id], [2, inst.id], [3, inst.id]]);
      }
    });

    it('a good multi-page listing whose total_count matches still detaches what is missing', async () => {
      const acc = await account();
      const inst = await install(acc);
      const all = Array.from({ length: 150 }, (_, i) => ({ id: 500 + i, name: `g${i}` }));
      await syncInstallationRepos(harness(all).deps, inst.id);
      const out = await syncInstallationRepos(harness(all.slice(0, 120)).deps, inst.id);
      expect(out).toMatchObject({ status: 'synced', detached: 30 });
      expect((await attachedTo(acc)).filter(([, i]) => i === null)).toHaveLength(30);
    });

    it('a failed listing detaches nothing', async () => {
      const acc = await account();
      const inst = await install(acc);
      await syncInstallationRepos(harness([{ id: 1, name: 'a' }]).deps, inst.id);
      const h = harness([]);
      h.deps.fetchImpl = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
      await expect(syncInstallationRepos(h.deps, inst.id)).rejects.toThrow();
      expect(await attachedTo(acc)).toEqual([[1, inst.id]]);
    });

    it('an installation suspended after the listing was read detaches nothing (the installer re-check covers the prune)', async () => {
      const acc = await account();
      const inst = await install(acc);
      await syncInstallationRepos(harness([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]).deps, inst.id);
      const h = harness([{ id: 1, name: 'a' }]);
      const listed = h.deps.fetchImpl!;
      h.deps.fetchImpl = (async (...args: Parameters<typeof fetch>) => {
        const res = await listed(...args);
        await admin.query(`UPDATE installation_installers SET suspended_at = now() WHERE gh_installation_id = $1`, [inst.gh]);
        return res;
      }) as unknown as typeof fetch;
      expect(await syncInstallationRepos(h.deps, inst.id)).toEqual({ status: 'skipped', reason: 'inactive' });
      expect(await attachedTo(acc)).toEqual([[1, inst.id], [2, inst.id]]);
    });

    it('a team_readonly sync detaches too, and logs nothing', async () => {
      const acc = await account();
      const inst = await install(acc, 'team_readonly');
      await syncInstallationRepos(harness([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]).deps, inst.id);
      const h = harness([{ id: 2, name: 'b' }]);
      expect(await syncInstallationRepos(h.deps, inst.id)).toMatchObject({ detached: 1 });
      expect(await attachedTo(acc)).toEqual([[1, null], [2, inst.id]]);
      expect(h.warn).not.toHaveBeenCalled();
    });
  });
  describe('D#601 MEM-3w: repos.gh_node_id is written by the sync, and filled for rows that predate it', () => {
    const nodeIds = async (accountId: string) =>
      (await admin.query<{ gh_repo_id: string; gh_node_id: string | null }>(`SELECT gh_repo_id::text, gh_node_id FROM repos WHERE account_id = $1 ORDER BY gh_repo_id`, [accountId])).rows.map(
        (r) => [Number(r.gh_repo_id), r.gh_node_id] as const,
      );
    /** What a conditional (reconciler) run sees: a list that has not changed, so every page answers 304 to the ETag it was given. */
    function conditionalHarness(all: Listed[], etag = 'W/"v1"') {
      const h = harness(all);
      const seen: Array<string | null> = [];
      h.deps.fetchImpl = vi.fn(strictGithubFetch(async (_url: string | URL | Request, init?: RequestInit) => {
        const inm = (init?.headers as Record<string, string>)['if-none-match'] ?? null;
        seen.push(inm);
        if (inm === etag) return new Response(null, { status: 304, headers: { etag } });
        const res = page(all, all.length);
        res.headers.set('etag', etag);
        return res;
      })) as unknown as typeof fetch;
      return { ...h, seen };
    }

    it('writes the node id GitHub lists on insert, and fills a null one on an update', async () => {
      const acc = await account();
      const inst = await install(acc);
      await syncInstallationRepos(harness([{ id: 31, name: 'a' }, { id: 32, name: 'b' }]).deps, inst.id);
      expect(await nodeIds(acc)).toEqual([[31, nodeIdOf(31)], [32, nodeIdOf(32)]]);
      await admin.query(`UPDATE repos SET gh_node_id = NULL WHERE account_id = $1 AND gh_repo_id = 32`, [acc]);
      expect(await syncInstallationRepos(harness([{ id: 31, name: 'a' }, { id: 32, name: 'b' }]).deps, inst.id)).toMatchObject({ status: 'synced', inserted: 0, updated: 2 });
      expect(await nodeIds(acc)).toEqual([[31, nodeIdOf(31)], [32, nodeIdOf(32)]]);
    });

    it('a listing entry with no node id, or one that fails the column format, still syncs the repo and never clears a stored id', async () => {
      const acc = await account();
      const inst = await install(acc);
      await syncInstallationRepos(harness([{ id: 41, name: 'a' }]).deps, inst.id);
      const out = await syncInstallationRepos(harness([{ id: 41, name: 'a', nodeId: null }, { id: 42, name: 'b', nodeId: 'bad id!' }, { id: 43, name: 'c', nodeId: null }]).deps, inst.id);
      expect(out).toMatchObject({ status: 'synced', inserted: 2, skippedInvalid: 0 });
      expect(await nodeIds(acc)).toEqual([[41, nodeIdOf(41)], [42, null], [43, null]]);
    });

    it('a conditional run on an installation with a null node id reads the list in full (no If-None-Match), fills the ids and uses the read-only installation token', async () => {
      const acc = await account();
      const inst = await install(acc);
      const all = [{ id: 51, name: 'a' }, { id: 52, name: 'b' }];
      await syncInstallationRepos(harness(all).deps, inst.id);
      await admin.query(`UPDATE repos SET gh_node_id = NULL WHERE account_id = $1`, [acc]); // rows from before the column was filled
      const h = conditionalHarness(all);
      const out = await syncInstallationRepos({ ...h.deps, conditional: { priorEtags: ['W/"v1"'] } }, inst.id);
      expect(out).toMatchObject({ status: 'synced', updated: 2 });
      expect(h.seen).toEqual([null]); // the saved ETag was not sent: a 304 would have written nothing
      expect(await nodeIds(acc)).toEqual([[51, nodeIdOf(51)], [52, nodeIdOf(52)]]);
      expect(h.minted).toEqual([{ installationId: inst.gh, permissions: { metadata: 'read' }, repositories: null }]);
    });

    it('is safe to re-run: once every id is set the ETag shortcut is back and nothing is written', async () => {
      const acc = await account();
      const inst = await install(acc);
      const all = [{ id: 61, name: 'a' }];
      await syncInstallationRepos(harness(all).deps, inst.id);
      await admin.query(`UPDATE repos SET gh_node_id = NULL WHERE account_id = $1`, [acc]);
      const first = conditionalHarness(all);
      await syncInstallationRepos({ ...first.deps, conditional: { priorEtags: ['W/"v1"'] } }, inst.id);
      const again = conditionalHarness(all);
      expect(await syncInstallationRepos({ ...again.deps, conditional: { priorEtags: ['W/"v1"'] } }, inst.id)).toEqual({ status: 'skipped', reason: 'unchanged' });
      expect(again.seen).toEqual(['W/"v1"']);
      expect(await nodeIds(acc)).toEqual([[61, nodeIdOf(61)]]);
    });

    it('only this installation and product count: another installation or a detached repo with a null id does not force a full read', async () => {
      const acc = await account();
      const inst = await install(acc);
      const other = await install(acc);
      const all = [{ id: 71, name: 'a' }];
      await syncInstallationRepos(harness(all).deps, inst.id);
      await admin.query(
        `INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, 72, 'team', 'acme', 'other'), ($4, $2, NULL, 73, 'team', 'acme', 'gone')`,
        [randomUUID(), acc, other.id, randomUUID()],
      );
      const h = conditionalHarness(all);
      expect(await syncInstallationRepos({ ...h.deps, conditional: { priorEtags: ['W/"v1"'] } }, inst.id)).toEqual({ status: 'skipped', reason: 'unchanged' });
      expect(h.seen).toEqual(['W/"v1"']);
    });

    it('a failed backfill check does not block the sync: it warns in fixed words and runs the conditional pass as before', async () => {
      const acc = await account();
      const inst = await install(acc);
      const all = [{ id: 81, name: 'a' }];
      await syncInstallationRepos(harness(all).deps, inst.id);
      const h = conditionalHarness(all);
      let calls = 0;
      const flaky = new Proxy(appUserPool, {
        get(target, prop, receiver) {
          if (prop === 'connect' && calls++ === 0) return async () => { throw new Error('connection refused for acct-secret'); };
          const v = Reflect.get(target, prop, target);
          return typeof v === 'function' ? v.bind(target) : Reflect.get(target, prop, receiver);
        },
      });
      const out = await syncInstallationRepos({ ...h.deps, appUserPool: flaky as Pool, conditional: { priorEtags: ['W/"v1"'] } }, inst.id);
      expect(out).toEqual({ status: 'skipped', reason: 'unchanged' });
      expect(h.seen).toEqual(['W/"v1"']);
      const said = h.warn.mock.calls.flat().join(' ');
      expect(said).toContain('node id backfill check failed');
      expect(said).not.toContain('acct-secret');
    });

    it('the column refuses a node id of the wrong shape (the sync checks the same pattern before it writes)', async () => {
      const acc = await account();
      const inst = await install(acc);
      await syncInstallationRepos(harness([{ id: 91, name: 'a' }]).deps, inst.id);
      await expect(admin.query(`UPDATE repos SET gh_node_id = 'no good' WHERE account_id = $1`, [acc])).rejects.toMatchObject({ code: '23514' });
    });
  });
});
