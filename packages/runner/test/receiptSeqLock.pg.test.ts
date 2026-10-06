import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { writeReceipt, type WriteReceiptInput } from "@fx/db/src/receiptWriter.js";
import { insertAgentRun, recordAgentOutput, RUN_EVENTS_SEQ_LOCK_SQL, runEventsSeqLockKey } from "../src/runStatusWriter.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";

/**
 * D#2 RECEIPT-SEQ-LOCK: the class-1 receipt definer takes the same per-run advisory lock as the TypeScript
 * run_events writers. [pg]: real Postgres, zero model tokens. This lives in packages/runner because runner already
 * depends on @fx/db and owns recordAgentOutput, so no new dependency is needed.
 */
const INVOKER_LOGIN = "fx_receipt_seq_lock_test";
const ROUNDS = 60;

describe("class-1 receipt definer takes the run_events seq lock [pg]", { timeout: 120_000 }, () => {
  const db = pgHarness();
  let receiptPool: Pool;

  beforeAll(async () => {
    await db.admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN
          CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
    await db.admin.query(`GRANT app_user, receipt_writer_invoker TO ${INVOKER_LOGIN}`);
    const u = new URL(process.env.RUNNER_DATABASE_URL_APP_USER!);
    u.username = INVOKER_LOGIN;
    u.password = "";
    receiptPool = createPool(u.toString());
  });
  afterAll(async () => {
    await receiptPool.end();
  });

  async function seedRun(): Promise<{ accountId: string; runId: string }> {
    const accountId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, randomUUID());
    const { id } = await insertAgentRun(db.runWriterPool, { id: randomUUID(), accountId, role: "executor", runtime: "production" });
    return { accountId, runId: id };
  }

  const receipt = (runId: string): WriteReceiptInput => ({
    class: "automated_with_monitoring",
    runId,
    decisionType: "dependency_patch_bump",
    chosen: "bump",
    rejectedAlternative: "skip",
    dialVersion: 1,
    quotedInputs: [],
  });
  const writeOne = (accountId: string, runId: string) => withTenant(receiptPool, accountId, (c) => writeReceipt(c, receipt(runId)));

  it("criterion 2: the SQL key is byte-identical to the TypeScript key", async () => {
    for (let i = 0; i < 5; i++) {
      const id = randomUUID();
      const { rows } = await db.admin.query(
        `SELECT hashtextextended('run_events_seq:' || $1::uuid::text, 0) AS sql_key, hashtextextended($2::text, 0) AS ts_key`,
        [id, runEventsSeqLockKey(id)],
      );
      expect(rows[0].sql_key).toBe(rows[0].ts_key);
    }
  });

  it("criterion 2: a receipt for run R waits on the TS lock for R, not on the lock for another run", async () => {
    const a = await seedRun();
    const b = await seedRun();
    const holder = await db.adminPool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(RUN_EVENTS_SEQ_LOCK_SQL, [runEventsSeqLockKey(a.runId)]);
      const timedOut = withTenant(receiptPool, a.accountId, async (c) => {
        await c.query("SET LOCAL lock_timeout = '300ms'");
        return writeReceipt(c, receipt(a.runId));
      });
      await expect(timedOut).rejects.toMatchObject({ code: "55P03" });
      const other = await withTenant(receiptPool, b.accountId, async (c) => {
        await c.query("SET LOCAL lock_timeout = '300ms'");
        return writeReceipt(c, receipt(b.runId));
      });
      expect(other).toEqual({ store: "run_events", outcome: "written" });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  it("criterion 1: the definer takes the advisory lock before it touches run_receipt_counts", async () => {
    const { rows } = await db.admin.query(
      `SELECT pg_get_functiondef('decision_receipt_write_class1(text,text,text,integer,jsonb,uuid,uuid,integer)'::regprocedure) AS def`,
    );
    const def = rows[0].def as string;
    const lock = def.indexOf("pg_advisory_xact_lock");
    const counter = def.indexOf("run_receipt_counts");
    expect(lock).toBeGreaterThan(-1);
    expect(counter).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(counter);
    expect(def).toContain("hashtextextended('run_events_seq:'");
  });

  it(`criterion 4: a receipt racing two agent.output writes, ${ROUNDS} rounds, loses no row and repeats no seq`, async () => {
    const { accountId, runId } = await seedRun();
    const before = await db.admin.query(`SELECT count(*)::int AS n FROM run_events WHERE run_id = $1`, [runId]);
    for (let round = 0; round < ROUNDS; round++) {
      const results = await Promise.allSettled([
        writeOne(accountId, runId),
        recordAgentOutput(db.runWriterPool, { accountId, runId, payload: { text: `a${round}` } }),
        recordAgentOutput(db.runWriterPool, { accountId, runId, payload: { text: `b${round}` } }),
      ]);
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(failed.map((f) => (f.reason as { code?: string }).code ?? String(f.reason))).toEqual([]);
    }
    const { rows } = await db.admin.query(`SELECT seq::int AS seq, kind FROM run_events WHERE run_id = $1 ORDER BY seq`, [runId]);
    const seqs = rows.map((r: { seq: number }) => r.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    const count = (kind: string) => rows.filter((r: { kind: string }) => r.kind === kind).length;
    expect(count("decision_receipt")).toBe(ROUNDS);
    expect(count("agent.output")).toBe(2 * ROUNDS);
    expect(rows.length).toBe(before.rows[0].n + 3 * ROUNDS);
  });
});
