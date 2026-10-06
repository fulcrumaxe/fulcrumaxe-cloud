import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { insertAgentRun, writeRunStatus } from "../src/runStatusWriter.js";
import { RUN_STATUS_TRANSITIONS, isLegalRunTransition, type RunStatus } from "../src/statusTransitions.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount } from "./helpers/seed.js";

/**
 * D#2 H09c (correction C37 criteria 3-5) from the runner's side: the
 * runner's `insertAgentRun`/`writeRunStatus` reach `agent_runs` only through
 * the agent_run_writer-only functions (0642), the SQL edge table cannot
 * drift from `statusTransitions.ts`, and a pool that is a plain app_user
 * (no agent_run_writer membership) cannot start a run at all.
 */
describe("runner -> agent_runs writer [pg] (H09c)", () => {
  const db = pgHarness();

  async function seedRunnerTenant(admin: typeof db.admin): Promise<{ accountId: string }> {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    return { accountId };
  }

  const ALL: RunStatus[] = Object.keys(RUN_STATUS_TRANSITIONS) as RunStatus[];

  it("the SQL legal-edge table equals RUN_STATUS_TRANSITIONS for all 81 (from, to) pairs", async () => {
    const t = await seedRunnerTenant(db.admin);
    expect(ALL).toHaveLength(9);
    let legal = 0;
    for (const from of ALL) {
      for (const to of ALL) {
        // A run id that does not exist: a LEGAL edge returns false (no row
        // matched), an ILLEGAL one raises 23514 before touching any row.
        const outcome = await withTenant(db.runWriterPool, t.accountId, (c) =>
          c.query<{ updated: boolean }>(
            `SELECT agent_run_set_status($1::uuid, $2::uuid, $3::text, $4::text, NULL, NULL, NULL, NULL, NULL) AS updated`,
            [t.accountId, randomUUID(), from, to],
          ),
        ).then(
          (r) => ({ ok: r.rows[0]!.updated }),
          (e: { code?: string }) => ({ err: e.code }),
        );
        if (isLegalRunTransition(from, to)) {
          legal++;
          expect(outcome, `${from} -> ${to}`).toEqual({ ok: false });
        } else {
          expect(outcome, `${from} -> ${to}`).toEqual({ err: "23514" });
        }
      }
    }
    expect(legal).toBe(12);
  });

  it("the table-level write guard's edge table, the writer function's, and the status CHECK all equal RUN_STATUS_TRANSITIONS", async () => {
    const expected = ALL.flatMap((from) => RUN_STATUS_TRANSITIONS[from].map((to) => `${from}>${to}`)).sort();
    expect(expected).toHaveLength(12);
    for (const fn of ["agent_runs_write_guard", "agent_run_set_status"]) {
      const { rows } = await db.admin.query<{ def: string }>(
        `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`,
        [fn],
      );
      const pairs = [...rows[0]!.def.matchAll(/\('([a-z_]+)',\s*'([a-z_]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
      expect(pairs, fn).toEqual(expected);
    }
    const { rows } = await db.admin.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'agent_runs'::regclass AND conname = 'agent_runs_status_known'`,
    );
    const listed = [...rows[0]!.def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(listed).toEqual([...ALL].sort());
  });

  it("insertAgentRun creates the row through agent_run_create with a database-stamped created_at, and the run.created event is atomic with it", async () => {
    const t = await seedRunnerTenant(db.admin);
    const id = randomUUID();
    await insertAgentRun(db.runWriterPool, { id, accountId: t.accountId, role: "code-reviewer", runtime: "production", headSha: "d".repeat(40) });
    const { rows } = await db.admin.query(
      `SELECT status, head_sha, abs(extract(epoch FROM (now() - created_at))) AS age_s,
              (SELECT count(*)::int FROM run_events WHERE run_id = $1 AND kind = 'run.created') AS events
         FROM agent_runs WHERE id = $1`,
      [id],
    );
    expect(rows[0].status).toBe("pending");
    expect(rows[0].head_sha).toBe("d".repeat(40));
    expect(Number(rows[0].age_s)).toBeLessThan(30);
    expect(rows[0].events).toBe(1);
  });

  it("a pool that is a plain app_user (not an agent_run_writer member) cannot start a run: insertAgentRun fails 42501 and leaves nothing behind", async () => {
    const t = await seedRunnerTenant(db.admin);
    const id = randomUUID();
    await expect(
      insertAgentRun(db.pureAppUserPool, { id, accountId: t.accountId, role: "code-reviewer", runtime: "production" }),
    ).rejects.toMatchObject({ code: "42501" });
    const { rows } = await db.admin.query(`SELECT 1 FROM agent_runs WHERE id = $1`, [id]);
    expect(rows).toEqual([]);
    const events = await db.admin.query(`SELECT 1 FROM run_events WHERE run_id = $1`, [id]);
    expect(events.rows).toEqual([]);
  });

  it("writeRunStatus with a plain app_user pool fails 42501 and changes nothing", async () => {
    const t = await seedRunnerTenant(db.admin);
    const id = randomUUID();
    await insertAgentRun(db.runWriterPool, { id, accountId: t.accountId, role: "code-reviewer", runtime: "production" });
    await expect(
      writeRunStatus(db.pureAppUserPool, { accountId: t.accountId, runId: id, from: "pending", to: "running" }),
    ).rejects.toMatchObject({ code: "42501" });
    const { rows } = await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [id]);
    expect(rows[0].status).toBe("pending");
  });

  it("writeRunStatus keeps its compare-and-set contract: a stale `from` reports the current status and writes no event", async () => {
    const t = await seedRunnerTenant(db.admin);
    const id = randomUUID();
    await insertAgentRun(db.runWriterPool, { id, accountId: t.accountId, role: "code-reviewer", runtime: "production" });
    expect(await writeRunStatus(db.runWriterPool, { accountId: t.accountId, runId: id, from: "pending", to: "running" })).toEqual({ updated: true });
    const stale = await writeRunStatus(db.runWriterPool, { accountId: t.accountId, runId: id, from: "pending", to: "cancelled" });
    expect(stale).toEqual({ updated: false, currentStatus: "running" });
    const done = await writeRunStatus(db.runWriterPool, {
      accountId: t.accountId,
      runId: id,
      from: "running",
      to: "succeeded",
      result: { envelope: { verdict: "pass" }, tokensIn: 3, tokensOut: 4, usd: 0.25, sessionId: "sess-9" },
    });
    expect(done).toEqual({ updated: true });
    const { rows } = await db.admin.query(`SELECT status, envelope, tokens_in, tokens_out, usd, cc_session_id FROM agent_runs WHERE id = $1`, [id]);
    expect(rows[0]).toEqual({ status: "succeeded", envelope: { verdict: "pass" }, tokens_in: "3", tokens_out: "4", usd: "0.2500", cc_session_id: "sess-9" });
    const events = await db.admin.query(`SELECT count(*)::int AS n FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed'`, [id]);
    expect(events.rows[0].n).toBe(2);
  });
});
