import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { writeEngineAudit, type EngineAuditAction } from '@fx/db/src/engineAudit.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { engineSettingsDeps } from '../src/routes/engine.js';

/**
 * [pg] Engine bridge EB-14: every engine operate route and every runner decide path writes exactly one audit row of its action, in the same
 * transaction as the change it makes, so when `audit_write` raises the change rolls back.
 *
 * HOW LATER ROWS USE THIS FILE. A row that adds an engine operate route (a command, a halt, a switch, a decision) or a runner decide path:
 *   1. adds one entry to ENGINE_AUDIT_GUARD below: the route's id, its audit action, a `run` that makes the real call as the tenant's member,
 *      and an `effects` that counts the rows the change leaves (it must read 1 after a good run and 0 after a rolled-back one);
 *   2. names the route's export in `covers` as `<file>#<export>` (for example `engine-commands.ts#registerEngineCommandRoutes`).
 * An export of `packages/api/src/routes/engine*.ts` (`engine.ts` and every `engine-*.ts`) that is neither covered nor listed in READ_ONLY_EXPORTS fails the meta-test.
 */

interface GuardContext {
  appUserPool: Pool;
  platformOpsPool: Pool;
  admin: PoolClient;
  accountId: string;
  userId: string;
}

interface GuardEntry {
  /** A label a person can read in a failing test, such as "POST /api/v1/engine/commands". */
  id: string;
  action: EngineAuditAction;
  /** Route exports this entry covers, as `<file>#<export>`. */
  covers: string[];
  /** Makes the real call and resolves when it commits. Rejects when the change is refused or rolled back. */
  run: (ctx: GuardContext) => Promise<void>;
  /** The count of rows the change leaves for this account (read as the admin). */
  effects: (ctx: GuardContext) => Promise<number>;
}

/** The real route, as the account's owner on a session, through the real handler. Rejects on any non-2xx so a refused call reads as a failed run. */
async function callEngineRoute(ctx: GuardContext, method: string, urlPath: string, body?: unknown): Promise<void> {
  process.env.FX_SESSION_SECRET ??= 's'.repeat(32);
  const platformOps = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
  try {
    const cookie = `${SESSION_COOKIE_NAME}=${await signSession({ accountId: ctx.accountId, userId: ctx.userId })}`;
    const req = new Request(`http://localhost/api/v1${urlPath}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const res = await handleApiRequest(req, ctx.appUserPool, platformOps, ROUTES);
    if (res.status >= 300) throw new Error(`${method} ${urlPath} answered ${res.status}`);
  } finally {
    await platformOps.end();
  }
}

/** One repo per (account, label), made on first use: the halt entries need a repo whose marker they own. */
const guardRepos = new Map<string, string>();
async function guardRepo(ctx: GuardContext, label: string): Promise<string> {
  const key = `${ctx.accountId}:${label}`;
  const known = guardRepos.get(key);
  if (known) return known;
  const { rows } = await ctx.admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, NULL, $2, 'web') RETURNING id`, [
    ctx.accountId,
    Math.floor(Math.random() * 1e12),
  ]);
  guardRepos.set(key, rows[0]!.id);
  return rows[0]!.id;
}

/**
 * The bridge tables the command route reads (EB-4's settings and sessions) when that row has not merged yet: tables of the Spec's shape, made here and
 * dropped after. Where the real tables exist these are not made.
 */
const standIns: string[] = [];
async function ensureBridgeTables(admin: PoolClient): Promise<void> {
  const make = async (name: string, ddl: string): Promise<void> => {
    if ((await admin.query<{ p: boolean }>('SELECT to_regclass($1) IS NOT NULL AS p', [`public.${name}`])).rows[0]!.p) return;
    await admin.query(ddl);
    await admin.query(`GRANT SELECT ON ${name} TO app_user`);
    standIns.push(name);
  };
  await make('engine_bridge_settings', 'CREATE TABLE engine_bridge_settings (account_id uuid PRIMARY KEY, watch_enabled boolean NOT NULL DEFAULT false, operate_enabled boolean NOT NULL DEFAULT false)');
  await make(
    'engine_sessions',
    `CREATE TABLE engine_sessions (id uuid PRIMARY KEY, account_id uuid NOT NULL, runner_id uuid NOT NULL, repo_id uuid NOT NULL, engine_instance_id uuid NOT NULL, engine_version text NOT NULL DEFAULT '1.0.0',
       last_seq bigint NOT NULL DEFAULT 0, first_event_at timestamptz NOT NULL DEFAULT now(), last_event_at timestamptz, last_heartbeat_at timestamptz)`,
  );
}

/** One runner_local repo with a runner that covers it and a live engine session, with operate on: what the command route needs. Made once per (account, label). */
const bridgeRepos = new Map<string, string>();
async function bridgeRepo(ctx: GuardContext, label: string): Promise<string> {
  const key = `${ctx.accountId}:${label}`;
  const known = bridgeRepos.get(key);
  if (known) return known;
  await ensureBridgeTables(ctx.admin);
  const repo = (await ctx.admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, NULL, $2, 'web', 'acme', 'guard', 'runner_local') RETURNING id`, [ctx.accountId, Math.floor(Math.random() * 1e12)])).rows[0]!.id;
  const runner = await insertRunner(ctx.admin, ctx.accountId, ctx.userId, { keepPlan: true });
  await ctx.admin.query('UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1', [runner, [repo]]);
  await ctx.admin.query('INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, true) ON CONFLICT (account_id) DO UPDATE SET watch_enabled = true, operate_enabled = true', [ctx.accountId]);
  await ctx.admin.query(
    "INSERT INTO engine_sessions (id, account_id, runner_id, repo_id, engine_instance_id, engine_version, last_event_at, last_heartbeat_at) VALUES ($1, $2, $3, $4, $5, '1.0.0', now() + interval '1 day', now() + interval '1 day')",
    [randomUUID(), ctx.accountId, runner, repo, randomUUID()],
  );
  bridgeRepos.set(key, repo);
  return repo;
}
const commandRows = async (ctx: GuardContext, label: string, where = 'true'): Promise<number> =>
  Number((await ctx.admin.query(`SELECT count(*) AS n FROM engine_commands WHERE repo_id = $1 AND ${where}`, [await bridgeRepo(ctx, label)])).rows[0].n);

/** What the settings entries below need that the account does not already have: a runner to hang a seeded session on, set up in `beforeAll`. */
const seeded: { runnerId: string } = { runnerId: '' };
const SEEDED_TABLE = 'engine_audit_guard_seeded';

/** Makes a real request to the API as the account's owner on a session, and rejects unless it answers 200 (so a rolled-back write rejects the run). */
async function callEngine(c: GuardContext, method: 'PUT', urlPath: string, body?: unknown): Promise<void> {
  const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession({ accountId: c.accountId, userId: c.userId })}`, accept: 'application/json' });
  if (body !== undefined) headers.set('content-type', 'application/json');
  const res = await handleApiRequest(new Request(`http://localhost${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), c.appUserPool, c.platformOpsPool, ROUTES);
  if (res.status !== 200) throw new Error(`${method} ${urlPath} answered ${res.status}`);
}

/** The decision the engine asked about, with no answer yet: each run of the answer route needs a fresh one, since an answer is final. */
async function askedDecision(ctx: GuardContext): Promise<string> {
  const repo = (
    await ctx.admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, NULL, $2, 'web') RETURNING id`, [ctx.accountId, Math.floor(Math.random() * 1e9)])
  ).rows[0]!.id;
  return (
    await ctx.admin.query<{ id: string }>(
      `INSERT INTO engine_decisions (account_id, repo_id, decision_type, request_key, subject, disposition, catalogue_version, preset)
       VALUES ($1, $2, 'engine_merge', $3, '{"pr":1}'::jsonb, 'ask', 11, 'default') RETURNING id`,
      [ctx.accountId, repo, `guard:${randomUUID()}`],
    )
  ).rows[0]!.id;
}

/** Later rows add their routes here. */
export const ENGINE_AUDIT_GUARD: GuardEntry[] = [
  {
    // EB-8a. The change is the command row: none before, one after, and a rolled-back issue leaves the first.
    id: 'POST /api/v1/engine/repos/{id}/commands',
    action: 'engine_command.issued',
    covers: ['engine-commands.ts#engineCommandRoutes'],
    run: async (ctx) => callEngineRoute(ctx, 'POST', `/engine/repos/${await bridgeRepo(ctx, 'issue')}/commands`, { kind: 'pause_loop', args: {} }),
    effects: (ctx) => commandRows(ctx, 'issue'),
  },
  {
    // EB-8a. Each run starts from a fresh pending command; the change is the cancelled count: one more after a good run, unchanged after a rolled-back one.
    id: 'DELETE /api/v1/engine/commands/{id}',
    action: 'engine_command.cancelled',
    covers: [],
    run: async (ctx) => {
      const repo = await bridgeRepo(ctx, 'cancel');
      const runner = (await ctx.admin.query<{ runner_id: string }>('SELECT runner_id FROM engine_sessions WHERE repo_id = $1', [repo])).rows[0]!.runner_id;
      const id = (
        await ctx.admin.query<{ id: string }>(
          `INSERT INTO engine_commands (account_id, runner_id, repo_id, command_seq, kind, args, issued_by, issued_at, expires_at)
           SELECT $1, $2, $3, COALESCE(max(command_seq), 0) + 1, 'pause_loop', '{}', $4, now(), now() + interval '600 seconds' FROM engine_commands WHERE runner_id = $2 AND repo_id = $3 RETURNING id`,
          [ctx.accountId, runner, repo, ctx.userId],
        )
      ).rows[0]!.id;
      await callEngineRoute(ctx, 'DELETE', `/engine/commands/${id}`);
    },
    effects: (ctx) => commandRows(ctx, 'cancel', "state = 'cancelled'"),
  },
  {
    id: 'PUT /api/v1/engine/settings',
    action: 'engine_bridge.settings_changed',
    covers: ['engine.ts#engineRoutes'],
    run: async (c) => {
      const repoId = randomUUID();
      await c.admin.query(
        `INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, execution_mode)
         SELECT $1, account_id, installation_id, $3, 'team', 'acme', $4, 'runner_local' FROM repos WHERE account_id = $2 LIMIT 1`,
        [repoId, c.accountId, 1_000_000 + Math.floor(Math.random() * 1_000_000_000), `guard-${repoId.slice(0, 8)}`],
      );
      const ticked = (await c.admin.query<{ repo_id: string }>(`SELECT repo_id FROM engine_bridge_repos WHERE account_id = $1`, [c.accountId])).rows.map((r) => r.repo_id);
      await callEngine(c, 'PUT', '/api/v1/engine/settings', { repo_ids: [...ticked, repoId] });
    },
    effects: async (c) => Number((await c.admin.query(`SELECT count(*) AS n FROM engine_bridge_repos WHERE account_id = $1`, [c.accountId])).rows[0].n),
  },
  {
    id: 'PUT /api/v1/engine/settings/delete-data',
    action: 'engine_bridge.data_deleted',
    covers: ['engine.ts#engineRoutes'],
    run: async (c) => {
      const sessionId = randomUUID();
      await c.admin.query(
        `INSERT INTO engine_sessions (id, account_id, runner_id, repo_id, engine_instance_id, engine_version)
         SELECT $1, $2, $3, (SELECT id FROM repos WHERE account_id = $2 ORDER BY id LIMIT 1), $4, '1.0.0'`,
        [sessionId, c.accountId, seeded.runnerId, randomUUID()],
      );
      await c.admin.query(`INSERT INTO ${SEEDED_TABLE} (session_id) VALUES ($1)`, [sessionId]);
      await callEngine(c, 'PUT', '/api/v1/engine/settings/delete-data');
    },
    effects: async (c) =>
      Number((await c.admin.query(`SELECT count(*) AS n FROM ${SEEDED_TABLE} s WHERE NOT EXISTS (SELECT 1 FROM engine_sessions e WHERE e.id = s.session_id)`)).rows[0].n),
  },
  {
    id: 'POST /api/v1/engine/decisions/{id}/answer',
    action: 'engine_decision.answered',
    covers: ['engine-decisions.ts#engineDecisionRoutes'],
    run: async (ctx) => {
      const id = await askedDecision(ctx);
      const platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
      const previousSecret = process.env.FX_SESSION_SECRET;
      process.env.FX_SESSION_SECRET = 's'.repeat(32);
      try {
        const res = await handleApiRequest(
          new Request(`http://localhost/api/v1/engine/decisions/${id}/answer`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${await signSession({ accountId: ctx.accountId, userId: ctx.userId })}` },
            body: JSON.stringify({ choice: 'approve' }),
          }),
          ctx.appUserPool,
          platformOpsPool,
          ROUTES,
        );
        if (res.status !== 200) throw new Error(`answer route answered ${res.status}`);
      } finally {
        if (previousSecret === undefined) delete process.env.FX_SESSION_SECRET;
        else process.env.FX_SESSION_SECRET = previousSecret;
        await platformOpsPool.end();
      }
    },
    effects: async (ctx) => Number((await ctx.admin.query(`SELECT count(*) AS n FROM engine_decision_answers WHERE account_id = $1`, [ctx.accountId])).rows[0].n),
  },
  {
    // EB-11a. The epoch is the change: 0 before, 1 after, and a rolled-back halt leaves it at 1. Each run starts from "not halted" so a repeat does not short-circuit.
    id: 'POST /api/v1/engine/repos/{id}/halt',
    action: 'engine_halt.set',
    covers: ['engine-halt.ts#engineHaltRoutes'],
    run: async (ctx) => {
      const repo = await guardRepo(ctx, 'halt');
      await ctx.admin.query(`UPDATE engine_repo_controls SET halted_at = NULL, halt_action_id = NULL WHERE repo_id = $1`, [repo]);
      await callEngineRoute(ctx, 'POST', `/engine/repos/${repo}/halt`, {});
    },
    effects: async (ctx) => {
      const repo = await guardRepo(ctx, 'halt');
      return Number((await ctx.admin.query(`SELECT COALESCE(sum(halt_epoch), 0) AS n FROM engine_repo_controls WHERE repo_id = $1`, [repo])).rows[0].n);
    },
  },
  {
    // EB-11a. The clear stamps cleared_at: none before, one after, and a rolled-back clear leaves the first stamp. Each run starts halted.
    id: 'POST /api/v1/engine/repos/{id}/halt/clear',
    action: 'engine_halt.cleared',
    covers: [],
    run: async (ctx) => {
      const repo = await guardRepo(ctx, 'clear');
      await ctx.admin.query(
        `INSERT INTO engine_repo_controls (account_id, repo_id, halted_at, halt_action_id, halt_epoch) VALUES ($1, $2, now(), gen_random_uuid(), 1)
         ON CONFLICT (account_id, repo_id) DO UPDATE SET halted_at = now(), halt_action_id = gen_random_uuid()`,
        [ctx.accountId, repo],
      );
      await callEngineRoute(ctx, 'POST', `/engine/repos/${repo}/halt/clear`, {});
    },
    effects: async (ctx) => {
      const repo = await guardRepo(ctx, 'clear');
      return Number((await ctx.admin.query(`SELECT count(*) AS n FROM engine_repo_controls WHERE repo_id = $1 AND cleared_at IS NOT NULL`, [repo])).rows[0].n);
    },
  },
];

/** Exports of engine*.ts route files that change nothing, each with the reason. A later row that adds a read-only export lists it here. */
export const READ_ONLY_EXPORTS: Record<string, string> = {
  'engine.ts#engineSettingsDeps': 'the GitHub visibility seam the settings routes read; it is not a route and changes nothing',
};

const ROUTES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes');

/** The exported names of every `engine*.ts` route file (`engine.ts` and each `engine-*.ts`), as `<file>#<name>`. */
export function engineRouteExports(dir: string = ROUTES_DIR): string[] {
  const out: string[] = [];
  for (const file of readdirSync(dir).filter((f) => /^engine.*\.ts$/.test(f)).sort()) {
    const src = readFileSync(path.join(dir, file), 'utf8');
    for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z0-9_$]+)/gm)) out.push(`${file}#${m[1]}`);
    for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
      for (const part of m[1]!.split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()!.trim();
        if (name) out.push(`${file}#${name}`);
      }
    }
  }
  return out;
}

/** The exports no entry covers and no read-only note excuses. */
export function uncoveredExports(exports: string[], entries: GuardEntry[], readOnly: Record<string, string>): string[] {
  const covered = new Set(entries.flatMap((e) => e.covers));
  return exports.filter((x) => !covered.has(x) && !(x in readOnly));
}

const FAIL_TABLE = 'engine_audit_guard_fail_accounts';
const FAIL_FN = 'engine_audit_guard_fail_fn';
const FAIL_TRIGGER = 'engine_audit_guard_fail_trg';

describe('engine audit guard', { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let a: SeedRefs;

  const ctx = (): GuardContext => ({ appUserPool, platformOpsPool, admin, accountId: a.accountId, userId: a.userId });
  const auditRows = async () =>
    (await admin.query<{ action: string }>(`SELECT action FROM audit_log WHERE account_id = $1 ORDER BY created_at`, [a.accountId])).rows.map((r) => r.action);

  /** While an account is in the fail table, any audit_log insert for it raises: audit_write raises, in the caller's transaction. */
  const failAudit = async (on: boolean) => {
    if (on) await admin.query(`INSERT INTO ${FAIL_TABLE} (account_id) VALUES ($1) ON CONFLICT DO NOTHING`, [a.accountId]);
    else await admin.query(`DELETE FROM ${FAIL_TABLE} WHERE account_id = $1`, [a.accountId]);
  };

  /** The guard's two checks for one entry: one audit row of its action beside the change; no change and no row when audit_write raises. */
  async function checkEntry(entry: GuardEntry): Promise<void> {
    const rowsBefore = await auditRows();
    const effectsBefore = await entry.effects(ctx());

    await entry.run(ctx());
    const rowsAfter = await auditRows();
    expect(rowsAfter.length - rowsBefore.length, `${entry.id}: audit rows written`).toBe(1);
    expect(rowsAfter[rowsAfter.length - 1], `${entry.id}: audit action`).toBe(entry.action);
    expect((await entry.effects(ctx())) - effectsBefore, `${entry.id}: change left`).toBe(1);

    await failAudit(true);
    try {
      await expect(entry.run(ctx()), `${entry.id}: audit failure must reject the call`).rejects.toBeDefined();
    } finally {
      await failAudit(false);
    }
    expect((await auditRows()).length, `${entry.id}: no audit row after a raised audit_write`).toBe(rowsAfter.length);
    expect((await entry.effects(ctx())) - effectsBefore, `${entry.id}: change rolled back with the audit`).toBe(1);
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    engineSettingsDeps.getVisibility = () => async () => 'private';
    await admin.query(`CREATE TABLE IF NOT EXISTS ${SEEDED_TABLE} (session_id uuid PRIMARY KEY)`);
    await admin.query(`CREATE TABLE IF NOT EXISTS ${FAIL_TABLE} (account_id uuid PRIMARY KEY)`);
    await admin.query(
      `CREATE OR REPLACE FUNCTION ${FAIL_FN}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
       BEGIN
         IF EXISTS (SELECT 1 FROM public.${FAIL_TABLE} WHERE account_id = NEW.account_id) THEN
           RAISE EXCEPTION 'engine audit guard: audit_log insert refused' USING ERRCODE = 'raise_exception';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await admin.query(`DROP TRIGGER IF EXISTS ${FAIL_TRIGGER} ON audit_log`);
    await admin.query(`CREATE TRIGGER ${FAIL_TRIGGER} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${FAIL_FN}()`);
    a = await seedAccount(admin, randomUUID());
    seeded.runnerId = randomUUID();
    await admin.query(
      `INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode) VALUES ($1, $2, $3, '{"kty":"OKP","crv":"Ed25519","x":"AAAA"}', $4, 'subscription')`,
      [seeded.runnerId, a.accountId, a.userId, randomUUID().replace(/-/g, '').padEnd(43, 'k')],
    );
    await admin.query(`UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1`, [a.repoId]);
  });
  afterAll(async () => {
    for (const name of standIns) await admin.query(`DROP TABLE IF EXISTS ${name}`);
    delete process.env.FX_SESSION_SECRET;
    engineSettingsDeps.getVisibility = null;
    await admin.query(`DROP TABLE IF EXISTS ${SEEDED_TABLE}`);
    await admin.query(`DROP TRIGGER IF EXISTS ${FAIL_TRIGGER} ON audit_log`);
    await admin.query(`DROP FUNCTION IF EXISTS ${FAIL_FN}()`);
    await admin.query(`DROP TABLE IF EXISTS ${FAIL_TABLE}`);
    admin.release();
    await Promise.all([adminPool.end(), appUserPool.end(), platformOpsPool.end()]);
  });

  describe('every engine operate route and runner decide path', () => {
    it('has one audit row of the right action, in the same transaction', async () => {
      for (const entry of ENGINE_AUDIT_GUARD) await checkEntry(entry);
    });

    it('lists every export of packages/api/src/routes/engine*.ts (meta-test)', () => {
      expect(uncoveredExports(engineRouteExports(), ENGINE_AUDIT_GUARD, READ_ONLY_EXPORTS)).toEqual([]);
    });

    it('names an action the audit allowlist knows for every entry', () => {
      for (const e of ENGINE_AUDIT_GUARD) expect(e.action, e.id).toMatch(/^engine_(bridge|command|decision|halt)\./);
    });
  });

  describe('the harness itself', () => {
    const probe = 'engine_audit_guard_probe';
    let probeEntry: GuardEntry;

    beforeAll(async () => {
      await admin.query(`CREATE TABLE IF NOT EXISTS ${probe} (id uuid PRIMARY KEY, account_id uuid NOT NULL)`);
      await admin.query(`GRANT INSERT ON ${probe} TO app_user`);
      probeEntry = {
        id: 'probe: change plus one audit row',
        action: 'engine_halt.set',
        covers: [],
        run: (c) =>
          withTenant(c.appUserPool, c.accountId, c.userId, async (client) => {
            await client.query(`INSERT INTO ${probe} (id, account_id) VALUES ($1, $2)`, [randomUUID(), c.accountId]);
            await writeEngineAudit(client, 'engine_halt.set', { repo_id: randomUUID(), halt_epoch: 1 });
          }),
        effects: async (c) => Number((await c.admin.query(`SELECT count(*) AS n FROM ${probe} WHERE account_id = $1`, [c.accountId])).rows[0].n),
      };
    });
    afterAll(async () => {
      await admin.query(`DROP TABLE IF EXISTS ${probe}`);
    });

    it('passes a route that audits in its own transaction', async () => {
      await checkEntry(probeEntry);
    });

    it('fails a route that writes no audit row', async () => {
      const silent: GuardEntry = {
        ...probeEntry,
        id: 'probe: no audit',
        run: (c) => withTenant(c.appUserPool, c.accountId, c.userId, async (client) => void (await client.query(`INSERT INTO ${probe} (id, account_id) VALUES ($1, $2)`, [randomUUID(), c.accountId]))),
      };
      await expect(checkEntry(silent)).rejects.toThrow(/audit rows written/);
    });

    it('fails a route that audits on a separate transaction, so the change survives a raised audit_write', async () => {
      const split: GuardEntry = {
        ...probeEntry,
        id: 'probe: audit on its own transaction',
        run: async (c) => {
          await withTenant(c.appUserPool, c.accountId, c.userId, async (client) => void (await client.query(`INSERT INTO ${probe} (id, account_id) VALUES ($1, $2)`, [randomUUID(), c.accountId])));
          await withTenant(c.appUserPool, c.accountId, c.userId, (client) => writeEngineAudit(client, 'engine_halt.set', { halt_epoch: 1 }));
        },
      };
      await expect(checkEntry(split)).rejects.toThrow(/change rolled back with the audit/);
    });

    it('fails a route that writes the wrong action', async () => {
      const wrong: GuardEntry = { ...probeEntry, id: 'probe: wrong action', action: 'engine_halt.cleared' };
      await expect(checkEntry(wrong)).rejects.toThrow(/audit action/);
    });
  });

  describe('the meta-test scan', () => {
    const entry = (covers: string[]): GuardEntry => ({ id: 'x', action: 'engine_halt.set', covers, run: async () => {}, effects: async () => 0 });

    it('finds the exports of engine*.ts files only, in every export form', async () => {
      const fs = await import('node:fs/promises');
      const os = await import('node:os');
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fx-engine-routes-'));
      try {
        await fs.writeFile(path.join(dir, 'engine-demo.ts'), `export async function a() {}\nexport const b = 1;\nexport class C {}\nconst d = 1;\nexport { d, d as e };\n`);
        await fs.writeFile(path.join(dir, 'other.ts'), `export const hidden = 1;\n`);
        expect(engineRouteExports(dir)).toEqual(['engine-demo.ts#a', 'engine-demo.ts#b', 'engine-demo.ts#C', 'engine-demo.ts#d', 'engine-demo.ts#e']);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('flags an export that is neither covered nor read-only', () => {
      const exports = ['engine-demo.ts#a', 'engine-demo.ts#b', 'engine-demo.ts#c'];
      expect(uncoveredExports(exports, [entry(['engine-demo.ts#a'])], { 'engine-demo.ts#b': 'lists only' })).toEqual(['engine-demo.ts#c']);
    });
  });
});
