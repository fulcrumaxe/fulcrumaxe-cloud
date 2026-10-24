import { generateKeyPairSync } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { createTeamInstallationOwnership } from '@fx/core/src/tenancy/installationOwnership.js';
import { InstallationTokenCache, type AccessTokenRequester } from '../src/installationToken.js';
import { createPlanePushApi } from '../src/planePushApi.js';
import { createHostedPlanePush } from '../src/planePushHosted.js';
import { ghError, type GhReply } from './helpers/strictGithub.js';
import { httpsRoundTrip, startStrictGithubServer, type LocalTlsServer } from './helpers/localTlsServer.js';
import { seedAccountWithRepo } from './helpers/seed.js';

/**
 * The ownership check (its own cases are in packages/core) in front of every public-repo token mint, through the hosted push (the layer the runner routes and the
 * worker's publish step both mint through) against the strict GitHub server. The server names, for acme/widgets, the installation id the test chooses; a
 * token is minted only when that id is a live team installation of the asking account. What cannot be faked: that GitHub names the installation of the
 * repository's real owner (the table here is the test's), and that the platform_ops login is the one the app runs with.
 */
describe('team installation ownership in front of the hosted push', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let opsPool: Pool;
  let server: LocalTlsServer | undefined;
  let nextGh = 700_000 + Math.floor(Math.random() * 50_000);
  let privateKeyPem: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    opsPool = createPool(process.env.GITHUB_DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
    privateKeyPem = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey as unknown as string;
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });
  afterAll(async () => {
    admin.release();
    await opsPool.end();
    await adminPool.end();
  });

  async function account(opts: { installer?: 'live' | 'deleted' | 'suspended' | 'none'; kind?: 'team' | 'team_readonly' } = {}) {
    const gh = nextGh++;
    const kind = opts.kind ?? 'team';
    const refs = await seedAccountWithRepo(admin, gh, kind);
    const installer = opts.installer ?? 'live';
    if (installer !== 'none') {
      await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id, deleted_at, suspended_at) VALUES ($1, $2, 1, $3, $4)`, [
        gh, kind, installer === 'deleted' ? new Date() : null, installer === 'suspended' ? new Date() : null,
      ]);
    }
    return { accountId: refs.accountId, gh };
  }
  const owns = createTeamInstallationOwnership;

  describe('through the hosted push and a strict GitHub', () => {
    async function hostedFor(namedInstallation: number) {
      const minted: string[] = [];
      server = await startStrictGithubServer((req): GhReply => (req.path === '/repos/acme/widgets/installation' ? { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: namedInstallation }) } : ghError(404, 'Not Found')));
      const s = server;
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const r = await httpsRoundTrip(
          {
            host: 'api.github.com', port: s.port, path: url.pathname + url.search, method: init?.method ?? 'GET', headers: init?.headers as Record<string, string>, ca: s.ca, servername: 'api.github.com',
            lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4))) as never,
          },
          init?.body as string | undefined,
        );
        return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers });
      }) as typeof fetch;
      const requester: AccessTokenRequester = async (p) => {
        const token = ['ghs', '_', `t${minted.length}`.padEnd(36, 'x')].join(''); // gitleaks:allow
        minted.push(token);
        return { token, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: 'read', ...p.permissions }, repositories: p.repositories ?? [] };
      };
      const api = createPlanePushApi({ appCredentials: () => ({ appId: '12345', privateKeyPem, webhookSecret: 'unused' }), requester, cache: new InstallationTokenCache(), fetchImpl });
      return { hosted: createHostedPlanePush(api, { ownsInstallation: owns(opsPool) }), minted };
    }

    it('an installation that belongs to another account mints nothing; the owning account\'s mints; a deleted own installation mints nothing', async () => {
      const mine = await account();
      const theirs = await account();
      const gone = await account({ installer: 'deleted' });

      const other = await hostedFor(theirs.gh);
      await expect(other.hosted.mintToken('acme/widgets', mine.accountId)).rejects.toMatchObject({ code: 'code_repo_installation_not_owned' });
      await expect(other.hosted.openPullRequest({ accountId: mine.accountId, codeRepo: 'acme/widgets', branch: 'fx/p-0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e', title: 't', body: 'b' })).rejects.toMatchObject({ code: 'code_repo_installation_not_owned' });
      expect(other.minted).toEqual([]);
      await server?.close();

      const own = await hostedFor(mine.gh);
      const got = await own.hosted.mintToken('acme/widgets', mine.accountId);
      expect(own.minted).toEqual([got.token]);
      await server?.close();

      const deleted = await hostedFor(gone.gh);
      await expect(deleted.hosted.mintToken('acme/widgets', gone.accountId)).rejects.toMatchObject({ code: 'code_repo_installation_not_owned' });
      expect(deleted.minted).toEqual([]);
    });
  });
});
