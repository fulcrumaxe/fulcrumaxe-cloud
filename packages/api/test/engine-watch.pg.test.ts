import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { watchLimitsFor } from '@fx/spend';
import { AccountPoller } from '../src/sse/poller.js';
import { RECHECK_INTERVAL_MS, handleEventsRequest, type StreamDeps } from '../src/sse/stream.js';
import { recheckSessionMembership } from '../src/sse/leases.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { generateToken, displayHint } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';
import { ManualClock } from './helpers/manual-clock.js';
import { eventually } from './helpers/sse.js';

const woken: string[] = [];
vi.mock('@fx/core/src/pendingWork.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fx/core/src/pendingWork.js')>()),
  markRunnerWork: vi.fn(async (accountId: string) => {
    woken.push(accountId);
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any; // a decoded response body: its shape is what each test asserts

interface Who {
  accountId: string;
  userId: string;
}
type Plan = 'starter' | 'team' | 'scale';

/**
 * [pg] D#845 ON-24b: the watch route, its leases and its plan caps, through the real handler, row security and the real stream. Time is the database's own, so expiry is shown by moving a
 * lease's stamps into the past (a shift of every stamp keeps the table's own checks true), never by a fake clock the server does not read.
 */
describe('engine watch route, leases and caps [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    process.env.FX_CURSOR_KEY_V1 = randomBytes(32).toString('base64');
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    delete process.env.FX_CURSOR_KEY_V1;
    admin.release();
    await Promise.all([adminPool.end(), appUserPool.end(), platformOpsPool.end()]);
  });

  async function call(identity: Who | null, method: string, urlPath: string, body?: unknown, bearer?: string) {
    const headers = new Headers({ accept: 'application/json' });
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    else if (identity) headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(identity)}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const res = await handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
    return { status: res.status, body: (await res.json().catch(() => null)) as Json };
  }
  const watchPath = (repo: string) => `/engine/repos/${repo}/watch`;
  const start = (who: Who | null, repo: string, browser: string, extra: object = {}) => call(who, 'POST', watchPath(repo), { browser_id: browser, active: true, ...extra });

  /** An account on `plan` with an owner, two members, two ticked runner_local repos covered by one runner (protocol 23) and a live engine session on each. */
  async function world(plan: Plan = 'starter', opts: { protocol?: number | null; sessions?: boolean } = {}) {
    const owner = await seedAccountWithMember(admin, { role: 'owner', plan });
    const mk = async (): Promise<Who> => {
      const userId = randomUUID();
      await seedUser(admin, userId);
      await q(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [owner.accountId, userId]);
      return { accountId: owner.accountId, userId };
    };
    const repo = async (): Promise<string> =>
      (await q(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, NULL, $2, 'web', 'acme', 'w', 'runner_local') RETURNING id`, [owner.accountId, Math.floor(Math.random() * 1e9) + 1e9])).rows[0].id;
    const r1 = await repo();
    const r2 = await repo();
    const runner = randomUUID();
    await q(`INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode, protocol_version, allowed_repo_ids) VALUES ($1, $2, $3, '{"kty":"OKP","crv":"Ed25519","x":"AAAA"}', $4, 'subscription', $5, $6::uuid[])`, [
      runner, owner.accountId, owner.userId, randomBytes(32).toString('base64url'), opts.protocol === undefined ? 23 : opts.protocol, [r1, r2],
    ]);
    await q(`INSERT INTO engine_bridge_settings (account_id, watch_enabled) VALUES ($1, true)`, [owner.accountId]);
    for (const r of [r1, r2]) {
      await q(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [owner.accountId, r]);
      if (opts.sessions !== false) await engineSession(owner.accountId, runner, r, 0);
    }
    return { owner, a: await mk(), b: await mk(), r1, r2, runner, accountId: owner.accountId };
  }
  const engineSession = (accountId: string, runner: string, repo: string, heardAgoS: number, kind = 'engine', lastSeq: number | null = null) =>
    q(
      `INSERT INTO engine_sessions (account_id, runner_id, repo_id, engine_instance_id, engine_version, session_kind, last_seq, last_event_at, last_heartbeat_at, last_heard_at)
       VALUES ($1, $2, $3, $4, '1.0.0', $5, $6, now() - make_interval(secs => $7), now() - make_interval(secs => $7), now() - make_interval(secs => $7))`,
      [accountId, runner, repo, randomUUID(), kind, lastSeq, heardAgoS],
    );
  const leases = async (accountId: string, repo?: string) => (await q(`SELECT * FROM engine_watch_leases WHERE account_id = $1 AND ($2::uuid IS NULL OR repo_id = $2) ORDER BY started_at`, [accountId, repo ?? null])).rows;
  const commands = async (accountId: string) => (await q(`SELECT * FROM engine_commands WHERE account_id = $1 AND kind = 'watch' ORDER BY command_seq`, [accountId])).rows;
  /** Moves every stamp of the account's leases into the past by `seconds`, as if that much time had gone by (the table's own checks stay true). */
  const travel = (accountId: string, seconds: number) =>
    q(
      `UPDATE engine_watch_leases SET started_at = started_at - make_interval(secs => $2), hard_expires_at = hard_expires_at - make_interval(secs => $2),
              last_input_at = last_input_at - make_interval(secs => $2), expires_at = expires_at - make_interval(secs => $2) WHERE account_id = $1`,
      [accountId, seconds],
    );
  const ageCommands = (accountId: string, seconds: number) =>
    q(`UPDATE engine_commands SET issued_at = issued_at - make_interval(secs => $2), expires_at = expires_at - make_interval(secs => $2) WHERE account_id = $1 AND kind = 'watch'`, [accountId, seconds]);
  const browsers = (n: number) => Array.from({ length: n }, () => randomUUID());

  describe('who may watch', () => {
    it('is auth-tested: no credentials 401, a token 403, a foreign account and an unknown repo 404, a member in, nothing created on a refusal', async () => {
      const w = await world();
      const other = await world();
      const b = randomUUID();
      expect((await start(null, w.r1, b)).status).toBe(401);
      const tok = generateToken();
      await q(`INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at) VALUES ($1, $2, $3, $4, ARRAY['read'], now() + interval '1 day')`, [w.accountId, w.owner.userId, hashToken(tok), displayHint(tok)]);
      const viaToken = await start(null, w.r1, b);
      expect(viaToken.status).toBe(401);
      const tokenRes = await call(null, 'POST', watchPath(w.r1), { browser_id: b, active: true }, tok);
      expect(tokenRes.status).toBe(403);
      expect(tokenRes.body.error.code).toBe('session_required');
      expect((await call(null, 'DELETE', `${watchPath(w.r1)}?browser_id=${b}`, undefined, tok)).status).toBe(403);
      // Another account's member names this account's repo: not found, whatever the repo id.
      expect((await start(other.a, w.r1, b)).status).toBe(404);
      expect((await start(w.a, randomUUID(), b)).status).toBe(404);
      expect((await start(w.a, 'not-a-uuid', b)).status).toBe(404);
      expect(await leases(w.accountId)).toHaveLength(0);
      expect(await leases(other.accountId)).toHaveLength(0);
      const ok = await start(w.a, w.r1, b);
      expect(ok.status).toBe(200);
      expect((await leases(w.accountId))[0]).toMatchObject({ user_id: w.a.userId, repo_id: w.r1, browser_id: b });
    });

    it('refuses a body that is not exactly {browser_id, active, before?}', async () => {
      const w = await world();
      const b = randomUUID();
      expect((await call(w.a, 'POST', watchPath(w.r1), { active: true })).status).toBe(422);
      expect((await call(w.a, 'POST', watchPath(w.r1), { browser_id: 'x', active: true })).status).toBe(422);
      expect((await call(w.a, 'POST', watchPath(w.r1), { browser_id: b })).status).toBe(422);
      expect((await call(w.a, 'POST', watchPath(w.r1), { browser_id: b, active: true, extra: 1 })).status).toBe(422);
      expect((await call(w.a, 'POST', watchPath(w.r1), { browser_id: b, active: true, before: -1 })).status).toBe(422);
      expect(await leases(w.accountId)).toHaveLength(0);
    });

    it('answers 404 for a repo that is not enabled and for an account whose watch setting is off, and 409 for an engine that never connected', async () => {
      const w = await world();
      const b = randomUUID();
      await q(`DELETE FROM engine_bridge_repos WHERE account_id = $1 AND repo_id = $2`, [w.accountId, w.r2]);
      expect((await start(w.a, w.r2, b)).status).toBe(404);
      await q(`UPDATE engine_bridge_settings SET watch_enabled = false WHERE account_id = $1`, [w.accountId]);
      expect((await start(w.a, w.r1, b)).status).toBe(404);
      await q(`UPDATE engine_bridge_settings SET watch_enabled = true WHERE account_id = $1`, [w.accountId]);
      const bare = await world('starter', { sessions: false });
      const res = await start(bare.a, bare.r1, b);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('engine_not_connected');
      expect(await leases(bare.accountId)).toHaveLength(0);
      expect(await leases(w.accountId)).toHaveLength(0);
      expect(await commands(w.accountId)).toHaveLength(0);
    });

    it('an account on the runner tier watches with the runner tier\'s own figures', async () => {
      const w = await world();
      await q(`UPDATE accounts SET plan = 'runner' WHERE id = $1`, [w.accountId]);
      const res = await start(w.a, w.r1, randomUUID());
      expect(res.status).toBe(200);
      const { perRepo, perAccount } = watchLimitsFor('runner');
      expect(res.body.limits).toEqual({ per_repo: perRepo, per_account: perAccount });
      for (let i = 1; i < perRepo; i++) await start(w.a, w.r1, randomUUID());
      expect((await start(w.a, w.r1, randomUUID())).status).toBe(429);
    });

    it('an account whose hosted plan is not paid watches with the runner tier\'s figures, whatever plan the row records', async () => {
      const w = await world('scale');
      const scale = watchLimitsFor('scale');
      const paid = await start(w.a, w.r1, randomUUID());
      expect(paid.body.limits).toEqual({ per_repo: scale.perRepo, per_account: scale.perAccount });
      await q(`UPDATE accounts SET hosted_plan_paid = false WHERE id = $1`, [w.accountId]);
      const runnerTier = watchLimitsFor('runner');
      expect(runnerTier.perRepo).not.toBe(scale.perRepo);
      const res = await start(w.a, w.r1, randomUUID());
      expect(res.status).toBe(200);
      expect(res.body.limits).toEqual({ per_repo: runnerTier.perRepo, per_account: runnerTier.perAccount });
      // The runner tier's repo cap holds, counting the two slots already taken.
      let status = 200;
      for (let i = 0; i < runnerTier.perRepo + 1 && status === 200; i++) status = (await start(w.b, w.r1, randomUUID())).status;
      expect(status).toBe(429);
    });

    it('answers 503 plan_data_unavailable for a plan with no watch figures, and holds nothing', async () => {
      const w = await world();
      await q(`UPDATE accounts SET plan = 'ghost' WHERE id = $1`, [w.accountId]);
      const res = await start(w.a, w.r1, randomUUID());
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('plan_data_unavailable');
      expect(await leases(w.accountId)).toHaveLength(0);
      expect(await commands(w.accountId)).toHaveLength(0);
    });
  });

  describe('a start', () => {
    it('takes one lease and issues one watch command in the member\'s own name, with an audit row, and wakes the runner', async () => {
      const w = await world();
      const b = randomUUID();
      woken.length = 0;
      const res = await start(w.a, w.r1, b);
      expect(res.status).toBe(200);
      const limits = watchLimitsFor('starter');
      expect(res.body).toMatchObject({ command: 'issued', machine: 'online', detail_as_of: null, limits: { per_repo: limits.perRepo, per_account: limits.perAccount } });
      expect(res.body.last_seen).toMatch(/^\d{4}-/);
      const [lease] = await leases(w.accountId);
      expect(lease.id).toBe(res.body.lease_id);
      expect(Date.parse(res.body.expires_at) - Date.now()).toBeLessThanOrEqual(90_000);
      expect(Date.parse(res.body.session_ends_at) - lease.started_at.getTime()).toBe(limits.maxSessionMinutes * 60_000);
      expect(lease.idle_limit_s).toBe(limits.idleMinutes * 60);
      const cmds = await commands(w.accountId);
      expect(cmds).toHaveLength(1);
      expect(cmds[0]).toMatchObject({ repo_id: w.r1, runner_id: w.runner, issued_by: w.a.userId, state: 'pending' });
      const lifeMs = cmds[0].expires_at.getTime() - cmds[0].issued_at.getTime();
      expect(lifeMs).toBe(600_000);
      // `until` is the command's own end to the millisecond (the database's clock, truncated); the protocol allows at most 600 s past the issue time.
      expect(cmds[0].expires_at.getTime() - Date.parse(cmds[0].args.until)).toBeLessThan(1);
      expect(Date.parse(cmds[0].args.until)).toBeLessThanOrEqual(cmds[0].expires_at.getTime());
      const audit = (await q(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'engine_command.issued'`, [w.accountId])).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0].payload).toEqual({ repo_id: w.r1, command_id: cmds[0].id, kind: 'watch' });
      expect(woken).toEqual([w.accountId]);
    });

    it('is idempotent while a lease is held: a repeat start renews the one lease and sends no second command; two browsers and two people share one command', async () => {
      const w = await world('scale');
      const [b1, b2] = browsers(2) as [string, string];
      const first = await start(w.a, w.r1, b1);
      const again = await start(w.a, w.r1, b1);
      expect(again.body.lease_id).toBe(first.body.lease_id);
      expect(again.body.command).toBe('held');
      const second = await start(w.b, w.r1, b2);
      expect(second.body.lease_id).not.toBe(first.body.lease_id);
      expect(second.body.command).toBe('held');
      expect(await leases(w.accountId, w.r1)).toHaveLength(2);
      expect(await commands(w.accountId)).toHaveLength(1);
    });

    it('ten starts at once from one browser make one lease and one command; ten from ten browsers make ten leases (within the cap) and still one command', async () => {
      const w = await world('scale');
      await q(`UPDATE engine_commands SET state = 'cancelled' WHERE account_id = $1`, [w.accountId]);
      const same = randomUUID();
      const results = await Promise.all(Array.from({ length: 10 }, () => start(w.a, w.r1, same)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(new Set(results.map((r) => r.body.lease_id)).size).toBe(1);
      expect(await leases(w.accountId, w.r1)).toHaveLength(1);
      expect(await commands(w.accountId)).toHaveLength(1);
      expect(results.filter((r) => r.body.command === 'issued')).toHaveLength(1);
    });

    it('issues a fresh command when the last one is nearly over, and only once the 30 s gap has passed; a refused or cancelled one does not count as covering', async () => {
      const w = await world();
      const b = randomUUID();
      await start(w.a, w.r1, b);
      await ageCommands(w.accountId, 490); // 110 s left, issued 490 s ago
      expect((await start(w.a, w.r1, b)).body.command).toBe('issued');
      expect(await commands(w.accountId)).toHaveLength(2);
      await ageCommands(w.accountId, 10); // the new one is 10 s old: inside the gap
      await q(`UPDATE engine_commands SET state = 'cancelled' WHERE account_id = $1 AND command_seq = 2`, [w.accountId]);
      expect((await start(w.a, w.r1, b)).body.command).toBe('throttled');
      await ageCommands(w.accountId, 25);
      expect((await start(w.a, w.r1, b)).body.command).toBe('issued');
      expect(await commands(w.accountId)).toHaveLength(3);
    });

    it('another kind of command, or another repo\'s watch, neither throttles nor covers a start', async () => {
      const w = await world();
      const b = randomUUID();
      await q(`INSERT INTO engine_commands (account_id, runner_id, repo_id, command_seq, kind, args, issued_by, issued_at, expires_at, halt_epoch_at_issue) VALUES ($1, $2, $3, 1, 'pause_loop', '{}'::jsonb, $4, now(), now() + interval '600 seconds', 0)`, [w.accountId, w.runner, w.r1, w.owner.userId]);
      expect((await start(w.a, w.r1, b)).body.command).toBe('issued');
      expect((await start(w.a, w.r2, b)).body.command).toBe('issued');
      expect(await commands(w.accountId)).toHaveLength(2);
    });

    it('a runner below the watch protocol gets no command but the lease is held and the answer says so', async () => {
      const w = await world('starter', { protocol: 22 });
      const res = await start(w.a, w.r1, randomUUID());
      expect(res.status).toBe(200);
      expect(res.body.command).toBe('runner_too_old');
      expect(await leases(w.accountId)).toHaveLength(1);
      expect(await commands(w.accountId)).toHaveLength(0);
    });

    it('"load older" sends a watch with a before cursor within the detail high-water mark, refuses one ahead of it (400, nothing held), and is held to the 30 s gap', async () => {
      const w = await world();
      await engineSession(w.accountId, w.runner, w.r1, 0, 'detail', 50);
      const b = randomUUID();
      await start(w.a, w.r1, b);
      expect((await start(w.a, w.r1, b, { before: 10 })).body.command).toBe('throttled');
      await ageCommands(w.accountId, 40);
      const older = await start(w.a, w.r1, b, { before: 50 });
      expect(older.body.command).toBe('issued');
      expect((await commands(w.accountId))[1].args.before).toBe(50);
      await ageCommands(w.accountId, 40);
      const ahead = await start(w.a, w.r1, b, { before: 51 });
      expect(ahead.status).toBe(400);
      expect(ahead.body.error.code).toBe('invalid_request');
      expect(await commands(w.accountId)).toHaveLength(2);
    });

    it('says when the machine is offline, keeps the command waiting for it, and gives the last upload of detail', async () => {
      const w = await world('starter', { sessions: false });
      await engineSession(w.accountId, w.runner, w.r1, 1200); // last heard 20 minutes ago
      await engineSession(w.accountId, w.runner, w.r1, 900, 'detail', 5);
      const res = await start(w.a, w.r1, randomUUID());
      expect(res.status).toBe(200);
      expect(res.body.machine).toBe('offline');
      expect(res.body.command).toBe('issued');
      expect(Date.now() - Date.parse(res.body.last_seen)).toBeGreaterThan(880_000);
      expect(Date.now() - Date.parse(res.body.detail_as_of)).toBeGreaterThan(890_000);
      expect(Date.now() - Date.parse(res.body.detail_as_of)).toBeLessThan(930_000);
      expect((await commands(w.accountId))[0]).toMatchObject({ runner_id: w.runner, state: 'pending' });
      // A runner that is removed is no machine to wait for.
      await q(`UPDATE runners SET revoked_at = now() WHERE id = $1`, [w.runner]);
      expect((await start(w.b, w.r1, randomUUID())).status).toBe(409);
    });

    it('a member cannot use the insert rule to issue any other kind of command', async () => {
      const w = await world();
      const kinds: Array<[string, object]> = [['pause_loop', {}], ['start_day', {}]];
      for (const [kind, args] of kinds) {
        await expect(
          withTenant(appUserPool, w.accountId, w.a.userId, (c) =>
            c.query(`INSERT INTO engine_commands (account_id, runner_id, repo_id, command_seq, kind, args, issued_by, issued_at, expires_at, halt_epoch_at_issue) VALUES ($1, $2, $3, 1, $4, $5::jsonb, $6, now(), now() + interval '600 seconds', 0)`, [w.accountId, w.runner, w.r1, kind, JSON.stringify(args), w.a.userId]),
          ),
        ).rejects.toMatchObject({ code: '42501' });
      }
      // And a watch in another person's name is refused too.
      await expect(
        withTenant(appUserPool, w.accountId, w.a.userId, (c) =>
          c.query(`INSERT INTO engine_commands (account_id, runner_id, repo_id, command_seq, kind, args, issued_by, issued_at, expires_at, halt_epoch_at_issue) VALUES ($1, $2, $3, 1, 'watch', $4::jsonb, $5, now(), now() + interval '600 seconds', 0)`, [w.accountId, w.runner, w.r1, JSON.stringify({ until: new Date(Date.now() + 590_000).toISOString() }), w.b.userId]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('the plan caps', () => {
    for (const plan of ['starter', 'team', 'scale'] as Plan[]) {
      it(`${plan}: the repo cap and the account cap each answer 429 watch_limit, a repeat from a holder is never refused, and the other repo has its own room`, async () => {
        const { perRepo, perAccount } = watchLimitsFor(plan);
        expect(perAccount).toBeGreaterThan(perRepo);
        const w = await world(plan);
        const bs = browsers(perAccount + 2);
        const users = [w.a, w.b, w.owner as Who];
        let n = 0;
        for (let i = 0; i < perRepo; i++) expect((await start(users[i % 3]!, w.r1, bs[n++]!)).status).toBe(200);
        const full = await start(w.a, w.r1, bs[n++]!);
        expect(full.status).toBe(429);
        expect(full.body.error.code).toBe('watch_limit');
        expect(full.body.data).toEqual({ cap: 'repo', limit: perRepo, in_use: perRepo });
        // A holder at the cap renews; it does not take a second slot.
        expect((await start(w.a, w.r1, bs[0]!)).status).toBe(200);
        expect(await leases(w.accountId, w.r1)).toHaveLength(perRepo);
        // The other repo has room until the account's cap.
        for (let i = 0; i < perAccount - perRepo; i++) expect((await start(w.b, w.r2, bs[n++]!)).status).toBe(200);
        const acct = await start(w.b, w.r2, randomUUID());
        expect(acct.status).toBe(429);
        expect(acct.body.data).toEqual({ cap: 'account', limit: perAccount, in_use: perAccount });
        expect(await leases(w.accountId)).toHaveLength(perAccount);
      });
    }

    it('another account\'s leases never count against this one, and a full repo of another account does not block this one', async () => {
      const w = await world('starter');
      const v = await world('starter');
      const { perRepo } = watchLimitsFor('starter');
      for (const b of browsers(perRepo)) expect((await start(v.a, v.r1, b)).status).toBe(200);
      expect((await start(v.a, v.r1, randomUUID())).status).toBe(429);
      for (const b of browsers(perRepo)) expect((await start(w.a, w.r1, b)).status).toBe(200);
    });

    it('parallel starts cannot get past the per-repo cap: 12 at once leave exactly the cap, the rest 429', async () => {
      const w = await world('starter');
      const { perRepo } = watchLimitsFor('starter');
      const results = await Promise.all(browsers(12).map((b, i) => start(i % 2 ? w.a : w.b, w.r1, b)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(perRepo);
      expect(results.filter((r) => r.status === 429)).toHaveLength(12 - perRepo);
      expect(await leases(w.accountId, w.r1)).toHaveLength(perRepo);
    });

    it('parallel starts across two repos cannot get past the account cap: 14 at once leave exactly the cap', async () => {
      const w = await world('starter');
      const { perAccount } = watchLimitsFor('starter');
      const results = await Promise.all(browsers(14).map((b, i) => start(w.a, i % 2 ? w.r1 : w.r2, b)));
      expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(perAccount);
      const held = await leases(w.accountId);
      expect(held.length).toBeLessThanOrEqual(perAccount);
      expect(results.filter((r) => r.status === 200)).toHaveLength(held.length);
      expect(held.length).toBe(perAccount);
    });

    it('parallel starts and ends interleave without losing a slot or exceeding the cap', async () => {
      const w = await world('starter');
      const { perRepo } = watchLimitsFor('starter');
      const held = browsers(perRepo);
      for (const b of held) await start(w.a, w.r1, b);
      const racers = browsers(8);
      await Promise.all([
        ...racers.map((b) => start(w.b, w.r1, b)),
        call(w.a, 'DELETE', `${watchPath(w.r1)}?browser_id=${held[0]}`),
      ]);
      const now = await leases(w.accountId, w.r1);
      expect(now.length).toBeLessThanOrEqual(perRepo);
      expect(now.length).toBeGreaterThanOrEqual(perRepo - 1);
    });
  });

  describe('a view ends on the server\'s clock', () => {
    it('a lease nobody renews frees its slot after 90 s, and its row is swept by the next start', async () => {
      const w = await world('starter');
      const { perRepo } = watchLimitsFor('starter');
      const held = browsers(perRepo);
      for (const b of held) await start(w.a, w.r1, b);
      expect((await start(w.b, w.r1, randomUUID())).status).toBe(429);
      await travel(w.accountId, 89);
      expect((await start(w.b, w.r1, randomUUID())).status).toBe(429);
      await travel(w.accountId, 2);
      expect((await start(w.b, w.r1, randomUUID())).status).toBe(200);
      expect(await leases(w.accountId, w.r1)).toHaveLength(1);
    });

    it('the session maximum is fixed when the lease starts: refreshes never move it, the view ends at it, and a refresh after it is 409 watch_ended, not a new view', async () => {
      const w = await world('starter');
      const { maxSessionMinutes } = watchLimitsFor('starter');
      const b = randomUUID();
      const first = await start(w.a, w.r1, b);
      const ends = Date.parse(first.body.session_ends_at);
      const hard = maxSessionMinutes * 60;
      // Refresh with input every 60 s of server time until the maximum is within a minute: the lease keeps its slot and the same end.
      let t = 60;
      for (; t < hard; t += 60) {
        await travel(w.accountId, 60);
        const again = await start(w.a, w.r1, b);
        expect(again.status, `at ${t}s`).toBe(200);
        expect(again.body.lease_id).toBe(first.body.lease_id);
        expect(Date.parse(again.body.session_ends_at) + t * 1000).toBe(ends);
        expect(Date.parse(again.body.expires_at)).toBeLessThanOrEqual(ends - t * 1000);
        // Once the maximum is nearer than the 90 s a renewal adds, it is the lease's expiry.
        if (hard - t < 90) expect(Date.parse(again.body.expires_at) + t * 1000).toBe(ends);
      }
      await travel(w.accountId, hard - (t - 60) + 1);
      const gone = await call(w.a, 'POST', watchPath(w.r1), { browser_id: b, active: false });
      expect(gone.status).toBe(409);
      expect(gone.body.error.code).toBe('watch_ended');
      expect(await leases(w.accountId)).toHaveLength(0);
    }, 60000);

    it('refreshes with no input do not keep a view alive past the idle limit; input does; a refresh after the end never starts a view, only a start does', async () => {
      const w = await world('starter');
      const { idleMinutes } = watchLimitsFor('starter');
      const idle = idleMinutes * 60;
      const b = randomUUID();
      const refresh = (active: boolean) => call(w.a, 'POST', watchPath(w.r1), { browser_id: b, active });
      await start(w.a, w.r1, b);
      let t = 0;
      for (; t + 60 < idle; t += 60) {
        await travel(w.accountId, 60);
        expect((await refresh(false)).status, `refresh at ${t + 60}s`).toBe(200);
      }
      // Input just before the idle limit restarts the clock.
      await travel(w.accountId, 30);
      expect((await refresh(true)).status).toBe(200);
      const [row] = await leases(w.accountId);
      expect(Date.now() - Date.parse(row.last_input_at)).toBeLessThan(5000);
      // Then quiet refreshes: the lease dies at the idle limit.
      for (let s = 0; s + 60 < idle; s += 60) {
        await travel(w.accountId, 60);
        expect((await refresh(false)).status).toBe(200);
      }
      await travel(w.accountId, 61);
      const ended = await refresh(false);
      expect(ended.status).toBe(409);
      expect(ended.body.error.code).toBe('watch_ended');
      expect(await leases(w.accountId)).toHaveLength(0);
      // A start (input) is what brings a view back, as a new session.
      const again = await start(w.a, w.r1, b);
      expect(again.status).toBe(200);
      expect(again.body.lease_id).not.toBe(row.id);
    }, 60000);

    it('the stream\'s re-check renews a live lease in the statement it already runs (no extra query), never past the maximum or the idle limit, and never brings an ended one back', async () => {
      const w = await world('starter');
      const b = randomUUID();
      const { body } = await start(w.a, w.r1, b);
      const subject = { kind: 'session' as const, accountId: w.accountId, principalKey: w.a.userId };
      let count = 0;
      const wrapped = new WeakSet<object>();
      const counting = {
        connect: async () => {
          const client = await appUserPool.connect();
          if (!wrapped.has(client)) {
            wrapped.add(client);
            const orig = client.query.bind(client) as (...a: unknown[]) => unknown;
            (client as unknown as { query: unknown }).query = (...a: unknown[]) => {
              count++;
              return orig(...a);
            };
          }
          return client;
        },
      } as unknown as Pool;
      count = 0;
      await recheckSessionMembership(counting, subject, null, Date.now(), null);
      const plain = count;
      count = 0;
      await q(`UPDATE engine_watch_leases SET expires_at = now() + interval '5 seconds' WHERE id = $1`, [body.lease_id]);
      const out = await recheckSessionMembership(counting, subject, null, Date.now(), body.lease_id);
      expect(out).toMatchObject({ status: 'ok' });
      expect(count).toBe(plain);
      const [row] = await leases(w.accountId);
      expect(Date.parse(row.expires_at) - Date.now()).toBeGreaterThan(80_000);
      // Capped by the idle limit: input long ago leaves less than 90 s.
      await q(`UPDATE engine_watch_leases SET last_input_at = now() - make_interval(secs => idle_limit_s - 20), expires_at = now() + interval '5 seconds' WHERE id = $1`, [body.lease_id]);
      await recheckSessionMembership(appUserPool, subject, null, Date.now(), body.lease_id);
      const capped = (await leases(w.accountId))[0];
      expect(Date.parse(capped.expires_at) - Date.now()).toBeLessThanOrEqual(20_000);
      // Capped by the hard maximum.
      await q(`UPDATE engine_watch_leases SET last_input_at = now(), hard_expires_at = now() + interval '30 seconds', started_at = now() - interval '1 hour', expires_at = now() + interval '5 seconds' WHERE id = $1`, [body.lease_id]);
      await recheckSessionMembership(appUserPool, subject, null, Date.now(), body.lease_id);
      expect(Date.parse((await leases(w.accountId))[0].expires_at) - Date.now()).toBeLessThanOrEqual(30_000);
      // An ended lease is not revived.
      await q(`UPDATE engine_watch_leases SET expires_at = now() - interval '1 second', hard_expires_at = now() + interval '1 hour', last_input_at = now(), started_at = now() - interval '1 minute' WHERE id = $1`, [body.lease_id]);
      await recheckSessionMembership(appUserPool, subject, null, Date.now(), body.lease_id);
      expect(Date.parse((await leases(w.accountId))[0].expires_at)).toBeLessThan(Date.now());
    });

    it('opening a stream on a lease that has ended does not bring it back', async () => {
      const w = await world('starter');
      const { body } = await start(w.a, w.r1, randomUUID());
      await q(`UPDATE engine_watch_leases SET expires_at = now() - interval '1 second' WHERE id = $1`, [body.lease_id]);
      const clock = new ManualClock(Date.now(), 25);
      const deps: StreamDeps = { pool: appUserPool, platformOpsPool, clock, poller: new AccountPoller({ pool: appUserPool, platformOpsPool, clock, idleIntervalMs: 120_000, activeIntervalMs: 120_000 }) };
      const res = await handleEventsRequest(
        new Request(`http://x/api/v1/events?watch=${body.lease_id}`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${await signSession(w.a)}`, accept: 'text/event-stream' } }),
        { kind: 'account' },
        deps,
      );
      const row = (await q(`SELECT expires_at < now() AS ended FROM engine_watch_leases WHERE id = $1`, [body.lease_id])).rows[0];
      await res.body!.cancel();
      expect(row.ended).toBe(true);
    });

    it('a lease id that is another user\'s, another account\'s or unknown is neither renewed nor released through a stream', async () => {
      const w = await world('starter');
      const v = await world('starter');
      const mine = (await start(w.a, w.r1, randomUUID())).body.lease_id as string;
      const theirs = (await start(v.a, v.r1, randomUUID())).body.lease_id as string;
      await q(`UPDATE engine_watch_leases SET expires_at = now() + interval '5 seconds' WHERE id = ANY($1::uuid[])`, [[mine, theirs]]);
      // The other member of the same account, and a member of another account, name them.
      const subject = (who: Who) => ({ kind: 'session' as const, accountId: who.accountId, principalKey: who.userId });
      await recheckSessionMembership(appUserPool, subject(w.b), null, Date.now(), mine);
      await recheckSessionMembership(appUserPool, subject(v.b), null, Date.now(), mine);
      await recheckSessionMembership(appUserPool, subject(w.b), null, Date.now(), theirs);
      const left = (await q(`SELECT id, EXTRACT(EPOCH FROM (expires_at - now()))::float8 AS left FROM engine_watch_leases WHERE id = ANY($1::uuid[])`, [[mine, theirs]])).rows;
      for (const r of left) expect(r.left).toBeLessThan(10);
      // Closing a stream that names someone else's lease leaves it alone.
      const clock = new ManualClock(Date.now(), 25);
      const deps: StreamDeps = { pool: appUserPool, platformOpsPool, clock, poller: new AccountPoller({ pool: appUserPool, platformOpsPool, clock, idleIntervalMs: 120_000, activeIntervalMs: 120_000 }) };
      const res = await handleEventsRequest(
        new Request(`http://x/api/v1/events?watch=${mine}`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${await signSession(w.b)}`, accept: 'text/event-stream' } }),
        { kind: 'account' },
        deps,
      );
      await res.body!.cancel();
      await eventually(async () => (await q(`SELECT count(*)::int AS n FROM stream_leases WHERE account_id = $1`, [w.accountId])).rows[0].n === 0);
      expect(await leases(w.accountId)).toHaveLength(1);
    });
  });

  describe('closing a view', () => {
    it('closing the event stream removes its watch lease at once (inside the 10 s a hidden tab is promised), and the slot is free', async () => {
      const w = await world('starter');
      const { perRepo } = watchLimitsFor('starter');
      const held = browsers(perRepo);
      const leaseIds: string[] = [];
      for (const b of held) leaseIds.push((await start(w.a, w.r1, b)).body.lease_id);
      expect((await start(w.b, w.r1, randomUUID())).status).toBe(429);
      const clock = new ManualClock(Date.now(), 25);
      const deps: StreamDeps = { pool: appUserPool, platformOpsPool, clock, poller: new AccountPoller({ pool: appUserPool, platformOpsPool, clock, idleIntervalMs: 120_000, activeIntervalMs: 120_000 }) };
      await q(`UPDATE engine_watch_leases SET expires_at = now() + interval '3 seconds' WHERE id = $1`, [leaseIds[0]]);
      const res = await handleEventsRequest(
        new Request(`http://x/api/v1/events?watch=${leaseIds[0]}`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${await signSession(w.a)}`, accept: 'text/event-stream' } }),
        { kind: 'account' },
        deps,
      );
      // Opening renews the lease it names (a reconnecting stream must not wait a whole re-check).
      const renewed = (await q(`SELECT EXTRACT(EPOCH FROM (expires_at - now()))::float8 AS left FROM engine_watch_leases WHERE id = $1`, [leaseIds[0]])).rows[0].left;
      expect(renewed).toBeGreaterThan(80);
      const closedAt = Date.now();
      await res.body!.cancel();
      expect(await eventually(async () => (await leases(w.accountId, w.r1)).every((l: { id: string }) => l.id !== leaseIds[0]))).toBe(true);
      expect(Date.now() - closedAt).toBeLessThan(10_000);
      expect(await leases(w.accountId, w.r1)).toHaveLength(perRepo - 1);
      expect((await start(w.b, w.r1, randomUUID())).status).toBe(200);
    });

    it('the server ending a stream for being idle keeps the lease (the client reconnects and the 90 s life bridges the gap); the re-check renews it on the way', async () => {
      const w = await world('starter');
      const { body } = await start(w.a, w.r1, randomUUID());
      const clock = new ManualClock(Date.now(), 25);
      const deps: StreamDeps = {
        pool: appUserPool, platformOpsPool, clock, random: () => 0,
        poller: new AccountPoller({ pool: appUserPool, platformOpsPool, clock, idleIntervalMs: 600_000, activeIntervalMs: 600_000 }),
      };
      const res = await handleEventsRequest(
        new Request(`http://x/api/v1/events?watch=${body.lease_id}`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${await signSession(w.a)}`, accept: 'text/event-stream' } }),
        { kind: 'account' },
        deps,
      );
      const reader = res.body!.getReader();
      let closed = false;
      void (async () => {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
        closed = true;
      })();
      await q(`UPDATE engine_watch_leases SET expires_at = now() + interval '5 seconds' WHERE id = $1`, [body.lease_id]);
      await clock.advance(RECHECK_INTERVAL_MS);
      await eventually(async () => (await q(`SELECT EXTRACT(EPOCH FROM (expires_at - now()))::float8 AS left FROM engine_watch_leases WHERE id = $1`, [body.lease_id])).rows[0].left > 80);
      await clock.advance(300_000);
      await eventually(() => closed);
      await eventually(async () => (await q(`SELECT count(*)::int AS n FROM stream_leases WHERE account_id = $1`, [w.accountId])).rows[0].n === 0);
      expect(await leases(w.accountId)).toHaveLength(1);
    }, 60000);

    it('the server ending a stream at its drawn lifetime keeps the lease too', async () => {
      const w = await world('starter');
      const { body } = await start(w.a, w.r1, randomUUID());
      const clock = new ManualClock(Date.now(), 25);
      const deps: StreamDeps = {
        pool: appUserPool, platformOpsPool, clock, random: () => 0,
        poller: new AccountPoller({ pool: appUserPool, platformOpsPool, clock, idleIntervalMs: 120_000, activeIntervalMs: 120_000 }),
      };
      const res = await handleEventsRequest(
        new Request(`http://x/api/v1/events?watch=${body.lease_id}`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${await signSession(w.a)}`, accept: 'text/event-stream' } }),
        { kind: 'account' },
        deps,
      );
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let closed = false;
      void (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value);
        }
        closed = true;
      })();
      // Events keep the stream from going idle; the drawn lifetime (720 s) is what ends it.
      for (let i = 1; i <= 5; i++) {
        await q(`INSERT INTO domain_events (account_id, type, payload) VALUES ($1, 'pr.opened', '{}'::jsonb)`, [w.accountId]);
        await clock.advance(120_000);
        await eventually(() => (text.match(/event: pr\.opened/g)?.length ?? 0) === i);
      }
      expect(closed).toBe(false);
      await clock.advance(120_000);
      await eventually(() => closed);
      expect(text).not.toContain('event: idle');
      await eventually(async () => (await q(`SELECT count(*)::int AS n FROM stream_leases WHERE account_id = $1`, [w.accountId])).rows[0].n === 0);
      expect(await leases(w.accountId)).toHaveLength(1);
    }, 60000);

    it('DELETE ends the caller\'s own lease for that repo and browser only: not another user\'s with the same browser id, not another repo\'s, and calling it twice is fine', async () => {
      const w = await world('scale');
      const b = randomUUID();
      await start(w.a, w.r1, b);
      await start(w.a, w.r2, b);
      await start(w.b, w.r1, b);
      const gone = await call(w.a, 'DELETE', `${watchPath(w.r1)}?browser_id=${b}`);
      expect(gone).toMatchObject({ status: 200, body: { released: true } });
      expect((await call(w.a, 'DELETE', `${watchPath(w.r1)}?browser_id=${b}`)).body).toEqual({ released: false });
      const left = await leases(w.accountId);
      expect(left.map((l: { user_id: string; repo_id: string }) => `${l.user_id}/${l.repo_id}`).sort()).toEqual([`${w.a.userId}/${w.r2}`, `${w.b.userId}/${w.r1}`].sort());
      expect((await call(w.a, 'DELETE', `${watchPath(w.r1)}`)).status).toBe(422);
    });

    it('removing a member removes their leases', async () => {
      const w = await world('starter');
      await start(w.a, w.r1, randomUUID());
      await q(`DELETE FROM account_members WHERE account_id = $1 AND user_id = $2`, [w.accountId, w.a.userId]);
      expect(await leases(w.accountId)).toHaveLength(0);
    });
  });

  describe('tenancy of the lease table', () => {
    it('reads as the admin client with a foreign account id find nothing, and a tenant sees only its own account\'s rows', async () => {
      const w = await world('starter');
      const v = await world('starter');
      await start(w.a, w.r1, randomUUID());
      await start(v.a, v.r1, randomUUID());
      expect((await q(`SELECT count(*)::int AS n FROM engine_watch_leases WHERE account_id = $1 AND repo_id = $2`, [v.accountId, w.r1])).rows[0].n).toBe(0);
      expect((await q(`SELECT count(*)::int AS n FROM engine_watch_leases WHERE account_id = $1 AND user_id = $2`, [w.accountId, v.a.userId])).rows[0].n).toBe(0);
      const seen = await withTenant(appUserPool, w.accountId, w.b.userId, (c) => c.query('SELECT account_id FROM engine_watch_leases'));
      expect(seen.rows.every((r: { account_id: string }) => r.account_id === w.accountId)).toBe(true);
      expect(seen.rowCount).toBe(1);
    });

    it('a member writes only their own rows: not another user\'s lease, not for another user, not in another account, and only an expired row of someone else may be swept', async () => {
      const w = await world('scale');
      const v = await world('starter');
      const mine = (await start(w.a, w.r1, randomUUID())).body.lease_id as string;
      const as = (who: Who, sql: string, params: unknown[] = []) => withTenant(appUserPool, who.accountId, who.userId, (c) => c.query(sql, params));
      expect((await as(w.b, 'DELETE FROM engine_watch_leases WHERE id = $1', [mine])).rowCount).toBe(0);
      expect((await as(w.b, `UPDATE engine_watch_leases SET expires_at = expires_at - interval '1 second' WHERE id = $1`, [mine])).rowCount).toBe(0);
      expect((await as(v.a, 'DELETE FROM engine_watch_leases WHERE id = $1', [mine])).rowCount).toBe(0);
      const ins = (who: Who, as_user: string, account: string, repo: string) =>
        as(who, `INSERT INTO engine_watch_leases (account_id, repo_id, user_id, browser_id, hard_expires_at, idle_limit_s, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour', 600, now() + interval '60 seconds')`, [account, repo, as_user, randomUUID()]);
      await expect(ins(w.b, w.a.userId, w.accountId, w.r1)).rejects.toMatchObject({ code: '42501' });
      await expect(ins(v.a, v.a.userId, w.accountId, w.r1)).rejects.toMatchObject({ code: '42501' });
      await expect(ins(w.b, w.b.userId, v.accountId, v.r1)).rejects.toMatchObject({ code: '42501' });
      await q(`UPDATE engine_watch_leases SET expires_at = now() - interval '1 minute' WHERE id = $1`, [mine]);
      expect((await as(w.b, 'DELETE FROM engine_watch_leases WHERE id = $1', [mine])).rowCount).toBe(1);
    });

    it('a session may move only the two columns a renewal moves: the start, the hard maximum and the idle limit are refused at the grant', async () => {
      const w = await world('scale');
      await start(w.a, w.r1, randomUUID());
      const as = (sql: string) => withTenant(appUserPool, w.accountId, w.a.userId, (c) => c.query(sql));
      for (const set of [`started_at = started_at + interval '1 hour'`, `hard_expires_at = hard_expires_at + interval '1 hour'`, `idle_limit_s = 86400`, `browser_id = gen_random_uuid()`]) {
        await expect(as(`UPDATE engine_watch_leases SET ${set}`)).rejects.toMatchObject({ code: '42501' });
      }
      expect((await as(`UPDATE engine_watch_leases SET last_input_at = now(), expires_at = expires_at - interval '1 second'`)).rowCount).toBe(1);
    });

    it('a runner session reads and writes nothing in the table', async () => {
      const w = await world('starter');
      await start(w.a, w.r1, randomUUID());
      const out = await withTenant(appUserPool, w.accountId, async (c) => {
        await c.query(`SELECT set_config('app.runner_id', $1, true)`, [w.runner]);
        return c.query('SELECT * FROM engine_watch_leases');
      });
      expect(out.rowCount).toBe(0);
    });
  });
});
