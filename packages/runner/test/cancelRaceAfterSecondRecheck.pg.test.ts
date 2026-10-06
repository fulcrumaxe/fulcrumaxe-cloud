import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { cancelRun } from "../src/cancelRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import type { ExecutionTargetRegistry } from "../src/executionTarget.js";
import type { SandboxPort } from "../src/sandboxPort.js";
import { seedAccount, seedMember, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * PR #85 fix round 3: security re-review of 8bec34f found the race
 * window had moved again -- past the SECOND re-check right before
 * `startDetached`, into the gap between that read resolving and
 * `startDetached` actually being called (and, for the TTL path, into
 * `dispatch`'s own remaining awaits after that point). Ported from the
 * reviewer's attack file: every RACE case below FAILS on 8bec34f and
 * PASSES after sandboxTarget.ts's `bk.started`/`bk.cancelRequested`/
 * `directStop` fix (must-fix 1). The TRIGGERS case at the bottom is the
 * reviewer's own bypass-attempt sweep against 0605_execution_mode.sql's
 * two trigger functions (relevant to should-fix 3's `search_path` pin;
 * every attempt here was already refused before and after that fix).
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pool proxy: after the Nth `SELECT status FROM agent_runs` returns its
 * rows (i.e. the snapshot is already taken), run `hook` before handing
 * the result back. Models "another connection commits after the status
 * read but before startDetached". */
function hookedPool(pool: Pool, nth: number, hook: () => Promise<void>): Pool {
  let count = 0;
  return new Proxy(pool, {
    get(t, k) {
      if (k === "connect") {
        return async () => {
          const c = await t.connect();
          return new Proxy(c, {
            get(ct, ck) {
              if (ck === "query") {
                return async (sql: unknown, params?: unknown) => {
                  const r = await (ct as PoolClient).query(sql as string, params as unknown[]);
                  if (typeof sql === "string" && sql.startsWith("SELECT status FROM agent_runs")) {
                    count++;
                    if (count === nth) await hook();
                  }
                  return r;
                };
              }
              const v = (ct as unknown as Record<string | symbol, unknown>)[ck];
              return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(ct) : v;
            },
          });
        };
      }
      const v = (t as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as Pool;
}

describe("PR #85 fix round 3, must-fix 1: race after the second re-check [pg]", () => {
  const db = pgHarness();

  async function scenario(role: "code-reviewer" | "executor" = "code-reviewer") {
    const accountId = randomUUID();
    const userId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, userId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 5 });
    const input: StartAgentRunInput = {
      accountId, repoId, workItemId, role, product: "team",
      pr: role === "executor" ? 5 : undefined,
      roleCard: "rc", prompt: "p", model: "haiku-4.5", capUsd: 5,
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    };
    return { accountId, userId, repoId, workItemId, input };
  }
  function logged(port: SandboxPort, log: string[]): SandboxPort {
    return {
      ...port,
      async createSandbox(o) { log.push(`create`); return port.createSandbox(o); },
      startDetached(h, o) { log.push(`start`); return port.startDetached(h, o); },
      async stop(h) { log.push(`stop`); return port.stop(h); },
      async deleteSandbox(h) { log.push(`delete`); return port.deleteSandbox(h); },
    };
  }
  function agentLeftRunning(log: string[]): boolean {
    const lastStart = log.lastIndexOf("start");
    if (lastStart < 0) return false;
    return !log.slice(lastStart + 1).some((l) => l === "stop" || l === "delete");
  }
  async function rowState(accountId: string) {
    const r = await db.admin.query(`SELECT id, status FROM agent_runs WHERE account_id = $1`, [accountId]);
    const s = await db.admin.query(
      `SELECT state, count(*)::int n FROM spend_reservations WHERE account_id = $1 GROUP BY state`, [accountId]);
    return { status: r.rows[0]?.status, reservations: s.rows };
  }

  for (const variant of ["fresh-instance", "same-instance"] as const) {
    it(`RACE: cancel commits after the 2nd status read, before startDetached (${variant})`, async () => {
      const s = await scenario();
      const h = createSandboxTargetHarness(db.runWriterPool);
      const log: string[] = [];
      const port = logged(h.deps.sandboxPort, log);
      let cancelOut: unknown;
      // eslint-disable-next-line prefer-const
      let target!: SandboxTarget;
      const pool = hookedPool(db.runWriterPool, 2, async () => {
        const { rows } = await db.admin.query(`SELECT id FROM agent_runs WHERE account_id = $1`, [s.accountId]);
        const reg: ExecutionTargetRegistry =
          variant === "same-instance" ? { sandbox: target } : { sandbox: new SandboxTarget({ ...h.deps, sandboxPort: port }) };
        cancelOut = await cancelRun({ pool: db.runWriterPool, principal: { accountId: s.accountId, userId: s.userId } }, rows[0].id, reg);
      });
      target = new SandboxTarget({ ...h.deps, pool, sandboxPort: port });
      const r = await startAgentRun(db.runWriterPool, { sandbox: target }, s.input, 60_000).then(
        (ok) => ({ ok }), (err) => ({ err: `${(err as Error).name}: ${(err as Error).message}` }));
      await sleep(50);
      const st = await rowState(s.accountId);
      console.log(`RACE ${variant}`, JSON.stringify({ cancelOut, r, log, st }));
      expect(agentLeftRunning(log)).toBe(false);
    });
  }

  it("RACE: queue TTL fires after the 2nd status read, before startDetached", async () => {
    const s = await scenario();
    const h = createSandboxTargetHarness(db.runWriterPool);
    const log: string[] = [];
    const port = logged(h.deps.sandboxPort, log);
    const pool = hookedPool(db.runWriterPool, 2, async () => { await sleep(400); });
    const target = new SandboxTarget({ ...h.deps, pool, sandboxPort: port });
    const r = await startAgentRun(db.runWriterPool, { sandbox: target }, s.input, 150);
    await sleep(600);
    const st = await rowState(s.accountId);
    console.log("RACE TTL", JSON.stringify({ r, log, st }));
    expect(agentLeftRunning(log)).toBe(false);
  });

  it("RACE (uninstrumented): real network-ish delay only in COMMIT; concurrent cancels, count leaks", async () => {
    // No hook on the status read at all: the 2nd status read's own COMMIT and
    // RESET are awaited AFTER the snapshot, so a concurrent in-process cancel
    // gets event-loop turns there. Add 3 ms latency to every query (a DB on
    // another host) and fire cancels at random offsets.
    let leaks = 0;
    const N = 40;
    const latency = (pool: Pool): Pool =>
      new Proxy(pool, {
        get(t, k) {
          if (k === "connect") {
            return async () => {
              const c = await t.connect();
              return new Proxy(c, {
                get(ct, ck) {
                  if (ck === "query") {
                    return async (sql: unknown, params?: unknown) => {
                      await sleep(3);
                      return (ct as PoolClient).query(sql as string, params as unknown[]);
                    };
                  }
                  const v = (ct as unknown as Record<string | symbol, unknown>)[ck];
                  return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(ct) : v;
                },
              });
            };
          }
          const v = (t as unknown as Record<string | symbol, unknown>)[k];
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      }) as Pool;
    const results: string[] = [];
    await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        const s = await scenario();
        const h = createSandboxTargetHarness(db.runWriterPool);
        const log: string[] = [];
        const port = logged(h.deps.sandboxPort, log);
        const target = new SandboxTarget({ ...h.deps, pool: latency(db.runWriterPool), sandboxPort: port });
        const p = startAgentRun(db.runWriterPool, { sandbox: target }, s.input, 60_000).catch((e) => ({ err: String(e) }));
        // wait until createSandbox happened, then a random extra delay
        for (let j = 0; j < 400 && !log.includes("create"); j++) await sleep(1);
        await sleep(Math.floor(Math.random() * 30));
        const { rows } = await db.admin.query(`SELECT id FROM agent_runs WHERE account_id = $1`, [s.accountId]);
        await cancelRun(
          { pool: db.runWriterPool, principal: { accountId: s.accountId, userId: s.userId } },
          rows[0].id,
          { sandbox: new SandboxTarget({ ...h.deps, sandboxPort: port }) },
        );
        await p;
        await sleep(20);
        if (agentLeftRunning(log)) {
          leaks++;
          results.push(`${i}: ${log.join(",")} ${JSON.stringify(await rowState(s.accountId))}`);
        }
      }),
    );
    console.log(`UNINSTRUMENTED leaks=${leaks}/${N}\n${results.join("\n")}`);
    expect(leaks).toBe(0);
  }, 60_000);

  it("RACE (latency only): 4 ms response latency on the target's pool, cancel fired when the 2nd status SELECT is SENT", async () => {
    let leaks = 0;
    const N = 30;
    const rows: string[] = [];
    await Promise.all(Array.from({ length: N }, async (_, i) => {
      const s = await scenario();
      const h = createSandboxTargetHarness(db.runWriterPool);
      const log: string[] = [];
      const port = logged(h.deps.sandboxPort, log);
      let sent = 0;
      let cancelP: Promise<unknown> | undefined;
      const pool = new Proxy(db.runWriterPool, {
        get(t, k) {
          if (k === "connect") {
            return async () => {
              const c = await t.connect();
              return new Proxy(c, {
                get(ct, ck) {
                  if (ck === "query") {
                    return async (sql: unknown, params?: unknown) => {
                      if (typeof sql === "string" && sql.startsWith("SELECT status FROM agent_runs") && ++sent === 2) {
                        // fire-and-forget: another request handler / instance cancels now
                        cancelP = (async () => {
                          const r0 = await db.admin.query(`SELECT id FROM agent_runs WHERE account_id = $1`, [s.accountId]);
                          return cancelRun({ pool: db.runWriterPool, principal: { accountId: s.accountId, userId: s.userId } }, r0.rows[0].id,
                            { sandbox: new SandboxTarget({ ...h.deps, sandboxPort: port }) });
                        })();
                      }
                      const r = await (ct as PoolClient).query(sql as string, params as unknown[]);
                      await sleep(Number(process.env.LAT ?? 4)); // response-path latency only
                      return r;
                    };
                  }
                  const v = (ct as unknown as Record<string | symbol, unknown>)[ck];
                  return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(ct) : v;
                },
              });
            };
          }
          const v = (t as unknown as Record<string | symbol, unknown>)[k];
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      }) as Pool;
      const target = new SandboxTarget({ ...h.deps, pool, sandboxPort: port });
      const r = await startAgentRun(db.runWriterPool, { sandbox: target }, s.input, 60_000).catch((e) => ({ err: String((e as Error).name) }));
      await cancelP;
      await sleep(20);
      if (agentLeftRunning(log)) {
        leaks++;
        rows.push(`${i}: ${log.join(",")} r=${JSON.stringify(r)} ${JSON.stringify(await rowState(s.accountId))}`);
      }
    }));
    console.log(`LATENCY leaks=${leaks}/${N}\n${rows.slice(0, 3).join("\n")}`);
    expect(leaks).toBe(0);
  }, 60_000);

  // ---------------- DB trigger bypass probes (as app_user) -----------------
  async function asApp<T>(accountId: string, fn: (c: PoolClient) => Promise<T>): Promise<{ ok?: T; err?: string }> {
    try {
      return { ok: await withTenant(db.pureAppUserPool, accountId, fn) };
    } catch (e) {
      return { err: `${(e as { code?: string }).code ?? ""} ${(e as Error).message}` };
    }
  }

  it("should-fix 3: agent_runs trigger bypass attempts, incl. search_path/unqualified-name probes against 0605_execution_mode.sql", async () => {
    const a = await scenario("code-reviewer");
    const v = await scenario("executor");
    const ar = randomUUID();
    await db.admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id)
       VALUES ($1,$2,'code-reviewer','production','pending','sandbox',$3)`, [ar, a.accountId, a.repoId]);
    const out: Record<string, unknown> = {};

    out.who = await asApp(a.accountId, (c) => c.query(`SELECT current_user, session_user, current_setting('search_path') sp`).then((r) => r.rows[0]));
    out.owner = (await db.admin.query(
      `SELECT tableowner FROM pg_tables WHERE tablename='agent_runs'`)).rows;
    out.triggers = (await db.admin.query(
      `SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid='agent_runs'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows;
    out.fnconfig = (await db.admin.query(
      `SELECT proname, proconfig, prosecdef FROM pg_proc WHERE proname IN ('agent_runs_dispatch_identity_write_once','agent_runs_dispatch_repo_same_tenant')`)).rows;

    // 1 temp-table shadowing of unqualified `repos` in the INSERT trigger
    out.tempShadow = await asApp(a.accountId, async (c) => {
      await c.query(`CREATE TEMP TABLE repos (id uuid, account_id uuid)`);
      await c.query(`INSERT INTO repos VALUES ($1,$2)`, [v.repoId, a.accountId]);
      await c.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, dispatch_pr_number)
                     VALUES ($1,$2,'executor','production','pending','sandbox',$3,5)`, [randomUUID(), a.accountId, v.repoId]);
      return "INSERTED";
    });
    // 2 schemas app_user can CREATE in
    out.createSchemas = (await db.admin.query(
      `SELECT nspname FROM pg_namespace WHERE has_schema_privilege('app_user', oid, 'CREATE')`)).rows;
    out.tempPriv = (await db.admin.query(`SELECT has_database_privilege('app_user', current_database(), 'TEMP') t`)).rows;
    // 3 session_replication_role
    out.replicaRole = await asApp(a.accountId, (c) => c.query(`SET LOCAL session_replication_role = replica`).then(() => "SET"));
    // 4 disable trigger / replace function
    out.disableTrigger = await asApp(a.accountId, (c) => c.query(`ALTER TABLE agent_runs DISABLE TRIGGER agent_runs_dispatch_identity_write_once`).then(() => "DISABLED"));
    out.replaceFn = await asApp(a.accountId, (c) => c.query(`CREATE OR REPLACE FUNCTION agent_runs_dispatch_identity_write_once() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$`).then(() => "REPLACED"));
    // 5 UPDATE paths
    out.updRowExpr = await asApp(a.accountId, (c) => c.query(
      `UPDATE agent_runs SET (role, dispatch_repo_id, dispatch_pr_number) = (SELECT 'executor', $2::uuid, 5::bigint) WHERE id=$1`, [ar, v.repoId]).then((r) => r.rowCount));
    out.updFrom = await asApp(a.accountId, (c) => c.query(
      `UPDATE agent_runs t SET dispatch_repo_id = x.r FROM (SELECT $2::uuid r) x WHERE t.id=$1`, [ar, v.repoId]).then((r) => r.rowCount));
    out.updNullMode = await asApp(a.accountId, (c) => c.query(`UPDATE agent_runs SET execution_mode = NULL WHERE id=$1`, [ar]).then((r) => r.rowCount));
    out.updStatusOnly = await asApp(a.accountId, (c) => c.query(`UPDATE agent_runs SET status='pending', tokens_in=1 WHERE id=$1`, [ar]).then((r) => r.rowCount));
    out.merge = await asApp(a.accountId, (c) => c.query(
      `MERGE INTO agent_runs t USING (SELECT $1::uuid id) s ON t.id = s.id
       WHEN MATCHED THEN UPDATE SET role='executor', dispatch_repo_id=$2, dispatch_pr_number=5`, [ar, v.repoId]).then((r) => r.rowCount));
    // 6 INSERT paths
    out.insForged = await asApp(a.accountId, (c) => c.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, dispatch_pr_number)
       VALUES ($1,$2,'executor','production','pending','sandbox',$3,5)`, [randomUUID(), a.accountId, v.repoId]).then((r) => r.rowCount));
    out.onConflict = await asApp(a.accountId, (c) => c.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id)
       VALUES ($1,$2,'code-reviewer','production','pending','sandbox',$3)
       ON CONFLICT (id) DO UPDATE SET role='executor', dispatch_repo_id=$4, dispatch_pr_number=5`, [ar, a.accountId, a.repoId, v.repoId]).then((r) => r.rowCount));
    out.onConflictAcct = await asApp(a.accountId, (c) => c.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1,$2,'executor','production','pending')
       ON CONFLICT (account_id, id) DO UPDATE SET dispatch_repo_id=$3`, [ar, a.accountId, v.repoId]).then((r) => r.rowCount));
    out.mergeInsert = await asApp(a.accountId, (c) => c.query(
      `MERGE INTO agent_runs t USING (SELECT $1::uuid id) s ON t.id = s.id
       WHEN NOT MATCHED THEN INSERT (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, dispatch_pr_number)
       VALUES (s.id, $2, 'executor','production','pending','sandbox',$3,5)`, [randomUUID(), a.accountId, v.repoId]).then((r) => r.rowCount));
    out.insBadMode = await asApp(a.accountId, (c) => c.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode) VALUES ($1,$2,'executor','production','pending','Sandbox')`, [randomUUID(), a.accountId]).then((r) => r.rowCount));
    out.insVictimRunIdClash = await asApp(a.accountId, async (c) => {
      const vr = (await db.admin.query(`SELECT id FROM agent_runs WHERE account_id=$1 LIMIT 1`, [v.accountId])).rows[0];
      if (!vr) return "no victim run";
      return c.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1,$2,'code-reviewer','production','pending')`, [vr.id, a.accountId]).then((r) => r.rowCount);
    });
    // 7 platform path: startAgentRun writes identity once (as app_user)
    const hv = createSandboxTargetHarness(db.runWriterPool);
    const pr = await startAgentRun(db.runWriterPool, { sandbox: new SandboxTarget(hv.deps) }, v.input);
    out.platformWrite = { pr, row: (await db.admin.query(
      `SELECT role, execution_mode, dispatch_repo_id = $2 same_repo, dispatch_pr_number, status FROM agent_runs WHERE id=$1`, [pr.id, v.repoId])).rows[0] };
    // platform_ops
    const ops = createPool(process.env.RUNNER_DATABASE_URL_PLATFORM_OPS!);
    try {
      out.opsUpdate = await ops.query(`UPDATE agent_runs SET dispatch_repo_id=$2 WHERE id=$1`, [ar, v.repoId]).then((r) => r.rowCount, (e) => `${e.code} ${e.message}`);
      out.opsInsertCross = await ops.query(
        `INSERT INTO agent_runs (id, account_id, role, runtime, status, dispatch_repo_id) VALUES ($1,$2,'executor','production','pending',$3)`,
        [randomUUID(), a.accountId, v.repoId]).then((r) => r.rowCount, (e) => `${e.code} ${e.message}`);
    } finally {
      await ops.end();
    }
    console.log("TRIGGERS", JSON.stringify(out, null, 1));
  });
});
