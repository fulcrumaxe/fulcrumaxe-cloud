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

/**
 * [pg] Engine bridge EB-14: every engine operate route and every runner decide path writes exactly one audit row of its action, in the same
 * transaction as the change it makes, so when `audit_write` raises the change rolls back.
 *
 * HOW LATER ROWS USE THIS FILE. A row that adds an engine operate route (a command, a halt, a switch, a decision) or a runner decide path:
 *   1. adds one entry to ENGINE_AUDIT_GUARD below: the route's id, its audit action, a `run` that makes the real call as the tenant's member,
 *      and an `effects` that counts the rows the change leaves (it must read 1 after a good run and 0 after a rolled-back one);
 *   2. names the route's export in `covers` as `<file>#<export>` (for example `engine-commands.ts#registerEngineCommandRoutes`).
 * An export of `packages/api/src/routes/engine-*.ts` that is neither covered nor listed in READ_ONLY_EXPORTS fails the meta-test.
 */

interface GuardContext {
  appUserPool: Pool;
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

/** Later rows add their routes here. EB-14 itself ships no route. */
export const ENGINE_AUDIT_GUARD: GuardEntry[] = [];

/** Exports of engine-*.ts route files that change nothing, each with the reason. A later row that adds a read-only export lists it here. */
export const READ_ONLY_EXPORTS: Record<string, string> = {};

const ROUTES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes');

/** The exported names of every `engine-*.ts` route file, as `<file>#<name>`. */
export function engineRouteExports(dir: string = ROUTES_DIR): string[] {
  const out: string[] = [];
  for (const file of readdirSync(dir).filter((f) => /^engine-.*\.ts$/.test(f)).sort()) {
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
  let a: SeedRefs;

  const ctx = (): GuardContext => ({ appUserPool, admin, accountId: a.accountId, userId: a.userId });
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
  });
  afterAll(async () => {
    await admin.query(`DROP TRIGGER IF EXISTS ${FAIL_TRIGGER} ON audit_log`);
    await admin.query(`DROP FUNCTION IF EXISTS ${FAIL_FN}()`);
    await admin.query(`DROP TABLE IF EXISTS ${FAIL_TABLE}`);
    admin.release();
    await Promise.all([adminPool.end(), appUserPool.end()]);
  });

  describe('every engine operate route and runner decide path', () => {
    it('has one audit row of the right action, in the same transaction', async () => {
      for (const entry of ENGINE_AUDIT_GUARD) await checkEntry(entry);
    });

    it('lists every export of packages/api/src/routes/engine-*.ts (meta-test)', () => {
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

    it('finds the exports of engine-*.ts files only, in every export form', async () => {
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
