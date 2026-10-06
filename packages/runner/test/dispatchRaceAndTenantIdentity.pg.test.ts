import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { cancelRun } from "../src/cancelRun.js";
import { SandboxTarget, type ModelConnectionPort } from "../src/targets/sandboxTarget.js";
import type { ExecutionTargetRegistry } from "../src/executionTarget.js";
import type { SandboxPort } from "../src/sandboxPort.js";
import { seedAccount, seedMember, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createSandboxTargetHarness, createFakeModelConnectionPort } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * PR #85 fix round 2: security re-review of 1781b3b found two things
 * still open after fix round 1 -- must-fix 1 (the cancel/TTL race window
 * moved, past `modelConnection.get`/`buildFirewallPolicy`, but never
 * closed) and must-fix 2 (`app_user` could rewrite `agent_runs`'
 * dispatch-identity columns and make a cancel stop a DIFFERENT tenant's
 * sandbox). These tests are the reviewer's own attack cases for exactly
 * those two findings, ported in: each one FAILS on 1781b3b and PASSES
 * after this round's fix (sandboxTarget.ts's second durable re-check
 * right before `startDetached`; 0605_execution_mode.sql's column-scoped
 * UPDATE grant plus the INSERT-time same-tenant trigger). Every other
 * case from that attack pass (NULL/unregistered mode, deadlock,
 * NotFound-message identity, timing) was already passing on 1781b3b and
 * is left uncovered here on purpose -- it belongs to the existing
 * suites (cancelRun.pg.test.ts, concurrency.pg.test.ts, sandboxTarget.
 * test.ts) that already assert it.
 */

function gate(): { p: Promise<void>; open: () => void } {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("dispatch/cancel race and tenant-identity forgery [pg]", () => {
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
      accountId,
      repoId,
      workItemId,
      role,
      product: "team",
      pr: role === "executor" ? 5 : undefined,
      roleCard: "rc",
      prompt: "p",
      model: "haiku-4.5",
      capUsd: 5,
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    };
    return { accountId, userId, repoId, workItemId, input };
  }

  /** Wraps the fake port with an ordered op log. */
  function logged(port: SandboxPort, log: string[]): SandboxPort {
    return {
      ...port,
      async createSandbox(o) {
        log.push(`create:${o.sandboxName}`);
        return port.createSandbox(o);
      },
      startDetached(h, o) {
        log.push(`start:${h.sandboxName}`);
        return port.startDetached(h, o);
      },
      async stop(h) {
        log.push(`stop:${h.sandboxName}`);
        return port.stop(h);
      },
      async deleteSandbox(h) {
        log.push(`delete:${h.sandboxName}`);
        return port.deleteSandbox(h);
      },
    };
  }

  async function runIdFor(accountId: string): Promise<string> {
    for (let i = 0; i < 200; i++) {
      const { rows } = await db.admin.query(`SELECT id FROM agent_runs WHERE account_id = $1`, [accountId]);
      if (rows[0]) return rows[0].id;
      await sleep(5);
    }
    throw new Error("no run row");
  }
  async function rowState(accountId: string) {
    const r = await db.admin.query(`SELECT id, status FROM agent_runs WHERE account_id = $1`, [accountId]);
    const s = await db.admin.query(
      `SELECT state, count(*)::int n FROM spend_reservations WHERE account_id = $1 GROUP BY state`,
      [accountId],
    );
    return { status: r.rows[0]?.status, reservations: s.rows };
  }
  /** true when an agent was started and no stop/delete came after the LAST start. */
  function agentLeftRunning(log: string[]): boolean {
    const lastStart = log.map((l) => l.startsWith("start:")).lastIndexOf(true);
    if (lastStart < 0) return false;
    return !log.slice(lastStart + 1).some((l) => l.startsWith("stop:") || l.startsWith("delete:"));
  }

  for (const variant of ["fresh-instance", "same-instance"] as const) {
    it(`must-fix 1 (${variant}): cancel landing AFTER the first re-check, while modelConnection.get is in flight -> agent must not be left running`, async () => {
      const s = await scenario();
      const h = createSandboxTargetHarness(db.runWriterPool);
      const log: string[] = [];
      const port = logged(h.deps.sandboxPort, log);
      const mg = gate();
      const entered = gate();
      const slowMc: ModelConnectionPort = {
        async get(a) {
          entered.open();
          await mg.p;
          return createFakeModelConnectionPort().get(a);
        },
      };
      const target = new SandboxTarget({ ...h.deps, sandboxPort: port, modelConnection: slowMc });
      // The fix makes `dispatch` itself re-check and abort once the
      // cancel below has already committed -- so, depending on exactly
      // when that lands relative to startAgentRun's own bookkeeping,
      // `startAgentRun` may now RESOLVE (a raceLost result) or REJECT
      // (DispatchAbortedError, propagated through dispatchOrCleanup)
      // for this exact interleaving. Both are safe outcomes; what
      // actually matters -- checked below -- is that the agent was
      // never left running either way.
      const p = startAgentRun(db.runWriterPool, { sandbox: target }, s.input, 60_000).then(
        (ok) => ({ ok }),
        (err) => ({ err: `${(err as Error).name}: ${(err as Error).message}` }),
      );
      await entered.p;
      const runId = await runIdFor(s.accountId);
      const reg: ExecutionTargetRegistry =
        variant === "same-instance" ? { sandbox: target } : { sandbox: new SandboxTarget({ ...h.deps, sandboxPort: port }) };
      const c = await cancelRun({ pool: db.runWriterPool, principal: { accountId: s.accountId, userId: s.userId } }, runId, reg);
      mg.open();
      const r = await p;
      await sleep(50);
      const st = await rowState(s.accountId);
      console.log(`must-fix-1 ${variant}`, JSON.stringify({ cancel: c, r, log, st }));
      expect(agentLeftRunning(log)).toBe(false);
    });
  }

  it("must-fix 1: queue TTL fires AFTER the first re-check, while modelConnection.get is in flight -> agent must not be left running", async () => {
    const s = await scenario();
    const h = createSandboxTargetHarness(db.runWriterPool);
    const log: string[] = [];
    const port = logged(h.deps.sandboxPort, log);
    const mg = gate();
    const slowMc: ModelConnectionPort = {
      async get(a) {
        await mg.p;
        return createFakeModelConnectionPort().get(a);
      },
    };
    const target = new SandboxTarget({ ...h.deps, sandboxPort: port, modelConnection: slowMc });
    const r = await startAgentRun(db.runWriterPool, { sandbox: target }, s.input, 150);
    mg.open();
    await sleep(200);
    const st = await rowState(s.accountId);
    console.log("must-fix-1 TTL", JSON.stringify({ r, log, st }));
    expect(agentLeftRunning(log)).toBe(false);
  });

  it("must-fix 2: app_user cannot rewrite its own run's dispatch identity to point at another tenant's executor sandbox", async () => {
    const attacker = await scenario("code-reviewer");
    const victim = await scenario("executor");
    const hv = createSandboxTargetHarness(db.runWriterPool);
    const vlog: string[] = [];
    const vr = await startAgentRun(
      db.runWriterPool,
      { sandbox: new SandboxTarget({ ...hv.deps, sandboxPort: logged(hv.deps.sandboxPort, vlog) }) },
      victim.input,
    );
    const ha = createSandboxTargetHarness(db.runWriterPool);
    const alog: string[] = [];
    const aport = logged(ha.deps.sandboxPort, alog);
    const ar = await startAgentRun(db.runWriterPool, { sandbox: new SandboxTarget({ ...ha.deps, sandboxPort: aport }) }, attacker.input);

    // Attacker = app_user scoped to ITS OWN tenant. Victim repo id is the
    // only "secret" needed -- the column-scoped UPDATE grant and the
    // INSERT-time same-tenant trigger (0605_execution_mode.sql) are what
    // this test exercises.
    let updErr = "";
    try {
      await withTenant(db.runWriterPool, attacker.accountId, (c) =>
        c.query(
          `UPDATE agent_runs SET role = 'executor', dispatch_repo_id = $2, dispatch_pr_number = 5 WHERE id = $1`,
          [ar.id, victim.repoId],
        ),
      );
    } catch (e) {
      updErr = (e as Error).message;
    }

    const forgedId = randomUUID();
    let insErr = "";
    try {
      await withTenant(db.runWriterPool, attacker.accountId, async (c) => {
        await c.query(
          `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, dispatch_pr_number)
           VALUES ($1, $2, 'executor', 'production', 'running', 'sandbox', $3, 5)`,
          [forgedId, attacker.accountId, victim.repoId],
        );
        await c.query(
          `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose)
           VALUES ($1, $2, 0, 'open', 'foreground_compute', 'run')`,
          [attacker.accountId, forgedId],
        );
      });
    } catch (e) {
      insErr = (e as Error).message;
    }

    const c1 = await cancelRun(
      { pool: db.runWriterPool, principal: { accountId: attacker.accountId, userId: attacker.userId } },
      ar.id,
      { sandbox: new SandboxTarget({ ...ha.deps, sandboxPort: aport }) },
    );
    let c2: unknown = null;
    if (!insErr) {
      c2 = await cancelRun(
        { pool: db.runWriterPool, principal: { accountId: attacker.accountId, userId: attacker.userId } },
        forgedId,
        { sandbox: new SandboxTarget({ ...ha.deps, sandboxPort: aport }) },
      );
    }
    // PR #85 fix round 3, must-fix 2: accountId is now part of the name.
    const victimSandbox = `ex-${victim.accountId}-${victim.repoId}-5`;
    console.log("must-fix-2", JSON.stringify({ victimRun: vr.status, updErr, insErr, c1, c2, alog, victimSandbox }));

    // The UPDATE never touched the identity columns (permission denied
    // by the column-scoped grant), and the forged INSERT never named a
    // row in the trigger's tenant check -- both are refused outright.
    expect(updErr).not.toBe("");
    expect(insErr).not.toBe("");
    // Whichever path the attacker tried, its own cancel never reaches --
    // let alone stops -- the victim's real sandbox.
    expect(alog).not.toContain(`stop:${victimSandbox}`);
  });

  it(
    "must-fix 1 regression: N >= pool max concurrent starts (random-delay create) + cancels at random offsets, pool max 3 -- no deadlock, zero leaked running agents",
    async () => {
      const POOL_MAX = 3;
      const N = 9;
      const small: Pool = createPool(process.env.RUNNER_DATABASE_URL_RUN_WRITER!, { max: POOL_MAX });
      try {
        const accountId = randomUUID();
        const userId = randomUUID();
        await seedAccount(db.admin, accountId);
        await seedMember(db.admin, accountId, userId);
        const h = createSandboxTargetHarness(small);
        const log: string[] = [];
        const base = logged(h.deps.sandboxPort, log);
        const port: SandboxPort = {
          ...base,
          createSandbox: async (o) => {
            await sleep(20 + Math.random() * 60);
            return base.createSandbox(o);
          },
        };
        const mc: ModelConnectionPort = {
          async get(a) {
            await sleep(Math.random() * 60);
            return createFakeModelConnectionPort().get(a);
          },
        };
        const target = new SandboxTarget({ ...h.deps, sandboxPort: port, modelConnection: mc });
        const repoIds: string[] = [];
        for (let i = 0; i < N; i++) {
          const r = randomUUID();
          await seedRepo(db.admin, accountId, r);
          repoIds.push(r);
        }
        const t0 = Date.now();
        const starts = repoIds.map((repoId) =>
          startAgentRun(
            small,
            { sandbox: target },
            {
              accountId,
              repoId,
              role: "code-reviewer",
              product: "team",
              roleCard: "rc",
              prompt: "p",
              model: "haiku-4.5",
              capUsd: 5,
              spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
            },
            60_000,
          ).then(
            (r) => r.status,
            (e) => (e as Error).name,
          ),
        );
        let ids: string[] = [];
        for (let i = 0; i < 400 && ids.length < N; i++) {
          ids = (await db.admin.query(`SELECT id FROM agent_runs WHERE account_id = $1`, [accountId])).rows.map((r) => r.id);
          await sleep(2);
        }
        const cancels = ids.map(async (id) => {
          await sleep(Math.random() * 120);
          const fresh = new SandboxTarget({ ...h.deps, sandboxPort: port, modelConnection: mc });
          return cancelRun({ pool: small, principal: { accountId, userId } }, id, { sandbox: fresh }).then(
            (r) => r.status,
            (e) => (e as Error).message,
          );
        });
        const all = await Promise.race([
          Promise.all([Promise.all(starts), Promise.all(cancels)]),
          sleep(15_000).then(() => "DEADLOCK" as const),
        ]);
        await sleep(200);
        const rows = (await db.admin.query(`SELECT id, status FROM agent_runs WHERE account_id = $1`, [accountId])).rows;
        const open = (
          await db.admin.query(`SELECT count(*)::int n FROM spend_reservations WHERE account_id = $1 AND state='open'`, [accountId])
        ).rows[0].n;
        // A run counts as "leaked" only if it ended in a NON-running
        // state yet its log shows the sandbox was started with no
        // stop/delete after -- i.e. an agent nobody can stop and nothing
        // still holds a reservation for.
        const leaked = rows
          .filter((r) => r.status !== "running")
          .map((r) => r.id)
          .filter((id) => {
            const name = log.find((l) => l.startsWith("create:") && l.endsWith(id));
            if (!name) return false;
            const sb = name.slice("create:".length);
            const sub = log.filter((l) => l.endsWith(sb));
            const ls = sub.map((l) => l.startsWith("start:")).lastIndexOf(true);
            return ls >= 0 && !sub.slice(ls + 1).some((l) => l.startsWith("stop:") || l.startsWith("delete:"));
          });
        console.log(
          "must-fix-1 regression",
          JSON.stringify({ ms: Date.now() - t0, all, statuses: rows.map((r) => r.status), open, leaked: leaked.length }),
        );
        expect(all).not.toBe("DEADLOCK");
        expect(leaked).toHaveLength(0);
      } finally {
        await small.end();
      }
    },
    30_000,
  );
});
