import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DispatchFailedError, SandboxPortError, startAgentRun, writeRunStatus, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { resumeAgentRun } from "../../src/build/resumeAgentRun.js";
import { createFakeExecutionTarget } from "./helpers/fakeExecutionTarget.js";
import { seedAccount, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#483 S5-k3b-h (C27-k3h-1, the fix-round resume site): a resume the provider refuses with 429 ends `cancelled` / `provider_capacity`, and a cancel write that
 * fails is tried a second time. The failure is injected IN THE DATABASE: a test-only trigger refuses the next n `pending` -> `cancelled` moves of one account's
 * runs (a sequence counts them, so the count survives the refused transaction).
 */
describe("the resume's provider_capacity cancel write [pg]", () => {
  const db = pgHarness();
  beforeAll(async () => {
    await db.admin.query(`CREATE TABLE IF NOT EXISTS fx_test_cancel_faults (account_id uuid PRIMARY KEY, upto bigint NOT NULL)`);
    await db.admin.query(`CREATE SEQUENCE IF NOT EXISTS fx_test_cancel_fault_seq`);
    await db.admin.query(`CREATE OR REPLACE FUNCTION fx_test_cancel_fault() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
      DECLARE u bigint;
      BEGIN
        SELECT upto INTO u FROM public.fx_test_cancel_faults WHERE account_id = NEW.account_id;
        IF u IS NOT NULL AND nextval('public.fx_test_cancel_fault_seq') <= u THEN RAISE EXCEPTION 'injected cancel write fault'; END IF;
        RETURN NEW;
      END $$`);
    await db.admin.query(`CREATE OR REPLACE TRIGGER fx_test_cancel_fault BEFORE UPDATE OF status ON agent_runs FOR EACH ROW WHEN (OLD.status = 'pending' AND NEW.status = 'cancelled') EXECUTE FUNCTION fx_test_cancel_fault()`);
  });
  afterAll(async () => {
    await db.admin.query(`DROP TRIGGER IF EXISTS fx_test_cancel_fault ON agent_runs`);
    await db.admin.query(`DROP FUNCTION IF EXISTS fx_test_cancel_fault()`);
    await db.admin.query(`DROP TABLE IF EXISTS fx_test_cancel_faults`);
    await db.admin.query(`DROP SEQUENCE IF EXISTS fx_test_cancel_fault_seq`);
  });
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  const input = (repoId: string): Omit<StartAgentRunInput, "accountId" | "workItemId" | "role"> => ({
    repoId, pr: 7, product: "team", roleCard: "card", prompt: "p", model: "haiku-4.5", capUsd: 5,
    spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
  });

  /** An item whose executor run ended with a session, and a target whose resume the provider refuses with 429. */
  async function seed(cancelFailures: number) {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 7 });
    const normal: ExecutionTargetRegistry = { sandbox: createFakeExecutionTarget().target };
    const started = await startAgentRun(db.runWriterPool, normal, { ...input(repoId), accountId, workItemId, role: "executor" });
    if (started.status !== "running") throw new Error("test setup: dispatch failed");
    await writeRunStatus(db.runWriterPool, { accountId, runId: started.id, from: "running", to: "timed_out", result: { sessionId: "cc-owned" }, checkpoint: { kind: "run_time", ccSessionId: "cc-owned", meteredUsd: 1, extensionsUsed: 0 } });
    const full = createFakeExecutionTarget();
    full.target.resume = async () => {
      throw new SandboxPortError("createSandbox", 429);
    };
    const v = Number((await db.admin.query(`SELECT nextval('fx_test_cancel_fault_seq') AS v`)).rows[0].v);
    await db.admin.query(`INSERT INTO fx_test_cancel_faults (account_id, upto) VALUES ($1, $2)`, [accountId, v + cancelFailures]);
    const resume = () => resumeAgentRun(db.runWriterPool, { sandbox: full.target }, { ...input(repoId), accountId, workItemId, role: "executor", parentRunId: started.id });
    const round = async () => (await db.admin.query(`SELECT id, status FROM agent_runs WHERE account_id = $1 AND id <> $2`, [accountId, started.id])).rows[0] as { id: string; status: string };
    return { resume, round };
  }
  const lines = () => warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("run.capacity_cancel_write_failed"));

  it("the write fails once: the second try ends the round cancelled / provider_capacity, and nothing is logged", async () => {
    const f = await seed(1);
    await expect(f.resume()).rejects.toMatchObject({ failureReason: "provider_capacity" });
    const r = await f.round();
    expect(r.status).toBe("cancelled");
    const reason = (await db.admin.query(`SELECT payload->>'failureReason' AS r FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' AND payload->>'to' = 'cancelled'`, [r.id])).rows[0]?.r;
    expect(reason).toBe("provider_capacity");
    expect(lines()).toEqual([]);
  });

  it("the write fails twice: the round stays pending, one fixed line names its id and nothing else, and the caller still gets the provider_capacity refusal", async () => {
    const f = await seed(2);
    const err = await f.resume().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DispatchFailedError);
    expect(err).toMatchObject({ failureReason: "provider_capacity" });
    const r = await f.round();
    expect(r.status).toBe("pending");
    expect(lines()).toEqual([JSON.stringify({ event: "run.capacity_cancel_write_failed", run_id: r.id })]);
  });
});
