import { randomInt, randomUUID, generateKeyPairSync } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { createRunResolver } from '../src/runResolver.js';
import { decideProxyRequest, type ProxyDecisionDeps } from '../src/proxyDecision.js';
import { InstallationTokenCache, type AccessTokenRequester } from '../src/installationToken.js';
import { ensureGhProxyTestLogin } from './helpers/ghProxyLogin.js';
import { seedAccountWithRepo, seedAgentRun, setRepoGithubNames, type SeedRefs } from './helpers/seed.js';

/**
 * D#2 H17c-2 (CT-3): the gh-proxy's handling of an onboarding preview run, over the real
 * resolver (real Postgres), the real decideProxyRequest and a fake GitHub (the token
 * requester). A preview run mints the read-only App's read token, never a `run` token;
 * it refuses every write before any mint; and it is refused outright on any App but the
 * read-only one. A run that is not a preview behaves as it always did.
 */
describe('gh-proxy: onboarding preview runs (H17c-2, CT-3)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let opsPool: Pool;
  let privateKeyPem: string;

  beforeAll(async () => {
    privateKeyPem = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey as unknown as string;
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    opsPool = createPool(await ensureGhProxyTestLogin(process.env.GITHUB_DATABASE_URL!));
    admin = await adminPool.connect();
  });
  afterAll(async () => {
    admin.release();
    await opsPool.end();
    await adminPool.end();
  });

  /** An account with one repo on the given App kind and a running run, optionally marked as a preview. */
  async function world(appKind: 'team' | 'team_readonly', preview: boolean, role = 'project-manager') {
    const refs: SeedRefs = await seedAccountWithRepo(admin, 700_000 + randomInt(1_000_000), appKind);
    await setRepoGithubNames(admin, refs.repoId, 'acme-corp', 'widgets');
    const sandboxName = `sbx-preview-${randomUUID()}`;
    const runId = await seedAgentRun(admin, refs.accountId, { sandboxName, role, status: 'running', dispatchRepoId: refs.repoId });
    if (preview) {
      await admin.query(
        `INSERT INTO onboarding_previews (account_id, installation_id, repo_id, gh_user_id, gh_installation_id, gh_owner, run_action_id, state, run_id, started_at)
         VALUES ($1, $2, $3, $4, $7, $8, $5, 'running', $6, now())`,
        [refs.accountId, refs.installationId, refs.repoId, 10_000_000 + randomInt(1_000_000_000), randomUUID(), runId, 10_000_000 + randomInt(1_000_000_000), randomUUID()],
      );
    }
    return { sandboxName };
  }

  function deps() {
    const requester = vi.fn<AccessTokenRequester>(async () => ({ token: 'ghs_fake', expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
    const d: ProxyDecisionDeps = {
      resolveSandboxRun: createRunResolver(opsPool),
      appCredentials: () => ({ appId: 'app-1', privateKeyPem, webhookSecret: 'unused' }),
      tokenCache: new InstallationTokenCache(),
      accessTokenRequester: requester,
    };
    return { d, requester };
  }
  const empty = new Uint8Array();
  const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

  it('resolves a run with an onboarding_previews row as a preview, and any other run as before', async () => {
    const resolve = createRunResolver(opsPool);
    const p = await world('team_readonly', true);
    const n = await world('team_readonly', false);
    expect((await resolve(p.sandboxName))?.isPreview).toBe(true);
    const plain = await resolve(n.sandboxName);
    expect(plain).not.toBeNull();
    expect(plain).not.toHaveProperty('isPreview');
  });

  it('allows the reads a preview needs and mints only the read-only token (metadata, contents and issues, read)', async () => {
    const { sandboxName } = await world('team_readonly', true);
    const { d, requester } = deps();
    const reads: Array<{ method: string; path: string; query: Record<string, string> }> = [
      { method: 'GET', path: '/repos/acme-corp/widgets/issues/5', query: {} },
      { method: 'GET', path: '/repos/acme-corp/widgets/issues', query: {} },
      { method: 'GET', path: '/acme-corp/widgets.git/info/refs', query: { service: 'git-upload-pack' } },
      { method: 'POST', path: '/acme-corp/widgets.git/git-upload-pack', query: {} },
    ];
    for (const r of reads) {
      const res = await decideProxyRequest({ ...r, rawBody: empty, sandboxName }, d);
      expect(res, `${r.method} ${r.path}`).toMatchObject({ allow: true, installationToken: 'ghs_fake' });
    }
    expect(requester).toHaveBeenCalled();
    for (const call of requester.mock.calls) {
      expect(call[0].permissions).toEqual({ metadata: 'read', contents: 'read', issues: 'read' });
    }
  });

  it('refuses every write before any mint', async () => {
    const { sandboxName } = await world('team_readonly', true);
    const { d, requester } = deps();
    const writes: Array<{ method: string; path: string; query: Record<string, string>; body: Uint8Array; contentEncoding?: string }> = [
      { method: 'POST', path: '/acme-corp/widgets.git/git-receive-pack', query: {}, body: empty },
      { method: 'GET', path: '/acme-corp/widgets.git/info/refs', query: { service: 'git-receive-pack' }, body: empty },
      { method: 'PATCH', path: '/repos/acme-corp/widgets/issues/5', query: {}, body: json({ title: 'x' }) },
      { method: 'POST', path: '/repos/acme-corp/widgets/issues/5/labels', query: {}, body: json({ labels: ['bug'] }) },
      { method: 'POST', path: '/repos/acme-corp/widgets/issues/5/comments', query: {}, body: json({ body: 'hi' }) },
      { method: 'POST', path: '/repos/acme-corp/widgets/pulls', query: {}, body: json({ title: 't' }) },
      { method: 'PUT', path: '/repos/acme-corp/widgets/contents/a.txt', query: {}, body: json({ message: 'm' }) },
      { method: 'DELETE', path: '/repos/acme-corp/widgets/issues/5/labels/bug', query: {}, body: empty },
      { method: 'POST', path: '/acme-corp/widgets.git/git-upload-pack', query: {}, body: empty, contentEncoding: 'br' },
    ];
    for (const w of writes) {
      const res = await decideProxyRequest({ method: w.method, path: w.path, query: w.query, rawBody: w.body, sandboxName, contentEncoding: w.contentEncoding }, d);
      expect(res.allow, `${w.method} ${w.path}`).toBe(false);
    }
    // The ones that reach the preview gate (everything but the bad content-encoding) say why.
    const sample = await decideProxyRequest({ method: 'PATCH', path: '/repos/acme-corp/widgets/issues/5', query: {}, rawBody: json({ title: 'x' }), sandboxName }, d);
    expect(sample).toMatchObject({ allow: false, status: 403, reason: 'preview_read_only' });
    expect(requester).not.toHaveBeenCalled();
  });

  it('refuses a preview run on any App but the read-only one, before any mint', async () => {
    const { sandboxName } = await world('team', true);
    const { d, requester } = deps();
    const res = await decideProxyRequest({ method: 'GET', path: '/repos/acme-corp/widgets/issues/5', query: {}, rawBody: empty, sandboxName }, d);
    expect(res).toMatchObject({ allow: false, status: 403, reason: 'installation_not_writable' });
    expect(requester).not.toHaveBeenCalled();
  });

  it('leaves a run that is not a preview exactly as it was: a write is decided by the policy and mints a run token', async () => {
    const { sandboxName } = await world('team', false);
    const { d, requester } = deps();
    const res = await decideProxyRequest(
      { method: 'PATCH', path: '/repos/acme-corp/widgets/issues/5', query: {}, rawBody: json({ title: 'x' }), sandboxName },
      d,
    );
    expect(res).toMatchObject({ allow: true });
    expect(requester.mock.calls[0]![0].permissions).not.toEqual({ metadata: 'read', contents: 'read' });
  });
});
