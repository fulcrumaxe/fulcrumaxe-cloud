import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { AccountPoller } from '../src/sse/poller.js';
import { handleEventsRequest, type StreamDeps, type StreamTarget } from '../src/sse/stream.js';
import { seedAccountWithMember } from './helpers/seed.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** D#597 CC-4 review fix: the stream open applies the same route token policy as the JSON dispatcher. */
describe('streams refuse a delegation token (real Postgres)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let app: Pool;
  let ops: Pool;
  let deps: StreamDeps;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    app = createPool(process.env.API_DATABASE_URL_APP_USER!);
    ops = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    process.env.FX_CURSOR_KEY_V1 = randomBytes(32).toString('base64');
    deps = { pool: app, platformOpsPool: ops, poller: new AccountPoller({ pool: app, platformOpsPool: ops, activeIntervalMs: 40, idleIntervalMs: 40 }) };
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    delete process.env.FX_CURSOR_KEY_V1;
    admin.release();
    await Promise.all([adminPool.end(), app.end(), ops.end()]);
  });

  async function seedRun(accountId: string, repoId: string): Promise<string> {
    const item = randomUUID();
    const run = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'internal', 'in_progress')`, [item, accountId, repoId]);
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'build', 'local', 'running')`, [run, accountId, item]);
    return run;
  }

  async function open(auth: { token: string } | { session: { accountId: string; userId: string } }, target: StreamTarget) {
    const h = new Headers({ accept: 'text/event-stream' });
    if ('token' in auth) h.set('authorization', `Bearer ${auth.token}`);
    else h.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(auth.session)}`);
    const url = target.kind === 'account' ? 'http://localhost/api/v1/events' : `http://localhost/api/v1/runs/${target.runId}/events`;
    const res = await handleEventsRequest(new Request(url, { headers: h }), target, deps);
    await res.body?.cancel();
    return res;
  }

  it("a delegation token gets 403 on the account stream, opens its own repo's run stream and gets 404 for any other run; a session opens all", async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const repo = randomUUID();
    const other = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, 810000001, 'team', 'acme', 'widgets')`, [repo, o.accountId]);
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, 810000002, 'team', 'acme', 'gadgets')`, [other, o.accountId]);
    const runIn = await seedRun(o.accountId, repo);
    const runOut = await seedRun(o.accountId, other);
    const orphan = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'build', 'local', 'running')`, [orphan, o.accountId]);
    const plaintext = generateToken();
    await insertApiToken(app, {
      accountId: o.accountId, createdBy: o.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes: ['read', 'corrections:write'],
      expiresAt: new Date(Date.now() + 3_000_000), delegation: { repoId: repo, clientId: 'stream-probe' },
    });
    const account = { kind: 'account' } as const;
    const refused = await open({ token: plaintext }, account);
    expect(refused.status).toBe(403);
    expect(refused.headers.get('content-type')).not.toContain('text/event-stream');
    // the only stream a delegation token opens: a run of its own repo
    const allowed = await open({ token: plaintext }, { kind: 'run', runId: runIn });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('content-type')).toContain('text/event-stream');
    // another repo's run, a run with no work item and an id nothing has all answer 404, before any stream byte
    for (const runId of [runOut, orphan, randomUUID()]) {
      const r = await open({ token: plaintext }, { kind: 'run', runId });
      expect(r.status, runId).toBe(404);
      expect(r.headers.get('content-type'), runId).not.toContain('text/event-stream');
    }
    for (const target of [account, { kind: 'run', runId: runIn } as const, { kind: 'run', runId: runOut } as const]) {
      expect((await open({ session: o }, target)).status, JSON.stringify(target)).toBe(200);
    }
  });
});

/** The next transport cannot skip the policy: every place that authenticates a route request must call the shared function. */
describe('route-auth entry points share one policy', () => {
  const read = (f: string) => readFileSync(path.join(SRC, f), 'utf8');

  it('the JSON dispatcher and the stream open call assertRouteAccess and keep no copy of the checks', () => {
    for (const f of ['handler.ts', 'sse/stream.ts']) {
      const src = read(f);
      expect(src, f).toContain('assertRouteAccess(principal');
      expect(src, f).not.toMatch(/principal\.scopes\.includes\(/);
      expect(src, f).not.toMatch(/new (InsufficientScopeError|SessionRequiredError)\(/);
    }
  });

  it('only those two files resolve a principal for a route request, so no third entry point exists unchecked', () => {
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.ts') && e.name !== 'principal.ts' && /\bresolvePrincipal\(/.test(readFileSync(full, 'utf8'))) callers.push(path.relative(SRC, full));
      }
    };
    walk(SRC);
    expect(callers.sort()).toEqual(['handler.ts', path.join('sse', 'stream.ts')]);
  });
});
