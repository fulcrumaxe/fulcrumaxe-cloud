import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertAgentRun, writeRunStatus, type ExecutionRun, type ExecutionTarget, type ExecutionTargetRegistry } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { DECISION_SNAPSHOT_KIND, buildDecisionSnapshot, writeDecisionSnapshot, type DecisionSnapshot } from "../src/decisionSnapshot.js";
import { createRunActionFacade } from "../src/runActions.js";
import { createRetryModule, type RetrySeatConfig, type RetrySeatSource } from "../src/retry.js";

/**
 * [pg] D#7 DP4b-3c: a person's Retry of a failed run is a new run, so a retried executor run gets a decision snapshot of its own, from the dials now, written in its
 * create transaction, with the matching block in its prompt. Real Postgres, the real run insert and the real `run_action_*` definers; the fakes are the seat source and the
 * execution target (it records what it is handed). A failing snapshot WRITE is a real database trigger; a failing snapshot READ is a connection that refuses that one query.
 * What this cannot show is a sandbox or a runner actually launching the run.
 * The executor card declares, in this order, REFACTOR (d1) and TESTS (d2).
 */
const REFACTOR = "nonbreaking_refactor_approach";
const TESTS = "test_strategy_choice";
const BLOCK_HEAD = "DECISIONS YOU MAY MEET IN THIS WORK";
const PROMPT = "fix the flaky test in widgets";

describe("retry carries a fresh decision snapshot [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    await admin.query("DROP TRIGGER IF EXISTS retry_decisions_test_fail ON run_events");
    await admin.query("DROP FUNCTION IF EXISTS retry_decisions_test_fail()");
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });

  const seatFor = (repoId: string): RetrySeatConfig => ({
    repoId,
    product: "team",
    roleCard: "role card",
    model: "haiku-4.5",
    capUsd: 5,
    spend: { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 },
    limits: { maxRunMs: 30 * 60_000, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 15 * 60_000 },
    timeoutMs: 40 * 60_000,
    maxExtensions: 3,
  });
  const seats: RetrySeatSource = {
    async retrySeat(input) {
      const { rows } = await admin.query("SELECT repo_id FROM work_items WHERE id = $1 AND account_id = $2", [input.workItemId, input.accountId]);
      return rows[0] ? { ok: true, seat: seatFor(rows[0].repo_id) } : { ok: false, reason: "account_not_found" };
    },
  };
  function stubTarget() {
    const admitted: ExecutionRun[] = [];
    const target = {
      runtime: "production",
      admit: async (run: ExecutionRun) => (admitted.push(run), { admitted: true }),
      cancel: async () => ({ settled_usd: 0, released_usd: 0 }),
      finalize: async () => {},
      dispatch: async () => ({ hookToken: "t" }),
      resume: async () => ({ hookToken: "t" }),
    } as unknown as ExecutionTarget;
    return { registry: { sandbox: target } as ExecutionTargetRegistry, admitted };
  }
  /** The module on a pool; `failRead` makes the one query that reads the item's repository for the decision offer fail, as a lost connection would. */
  function module(target: ReturnType<typeof stubTarget>, opts: { failRead?: boolean } = {}) {
    const pool = opts.failRead
      ? ({
          query: writerPool.query.bind(writerPool),
          connect: async () => {
            const client = await writerPool.connect();
            const original = client.query;
            const query = original.bind(client) as (...args: unknown[]) => unknown;
            const release = client.release.bind(client);
            // The client goes back to the shared pool: put it back as it was.
            client.release = ((err?: boolean | Error) => ((client.query = original), (client.release = release as typeof client.release), release(err))) as typeof client.release;
            client.query = ((...args: unknown[]) => {
              if (typeof args[0] === "string" && args[0].startsWith("SELECT repo_id FROM work_items")) return Promise.reject(new Error("connection reset by peer"));
              return query(...args);
            }) as typeof client.query;
            return client;
          },
        } as unknown as Pool)
      : writerPool;
    return createRetryModule(pool, target.registry, { seats, authorCheck: () => null });
  }

  let nextNumber = 7300;
  async function failedRun(a: SeedRefs, o: { role?: string; parentSnapshot?: DecisionSnapshot | null; prompt?: string } = {}) {
    const itemId = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', $4)", [itemId, a.accountId, a.repoId, nextNumber++]);
    const snapshot = o.parentSnapshot === undefined ? buildDecisionSnapshot({ role: "executor", dials: new Map() }) : o.parentSnapshot;
    const { id } = await insertAgentRun(writerPool, {
      id: randomUUID(),
      accountId: a.accountId,
      workItemId: itemId,
      role: o.role ?? "executor",
      runtime: "production",
      executionMode: "sandbox",
      dispatchRepoId: a.repoId,
      startPrompt: o.prompt ?? PROMPT,
      ...(snapshot ? { inCreateTransaction: (client: PoolClient, runId: string) => writeDecisionSnapshot(client, runId, snapshot) } : {}),
    });
    await writeRunStatus(writerPool, { accountId: a.accountId, runId: id, from: "pending", to: "running" });
    await writeRunStatus(writerPool, { accountId: a.accountId, runId: id, from: "running", to: "failed" });
    return { id, itemId };
  }
  /** A claimed retry_run action for a run, requested by the session member through the real definer (a person's own click). */
  async function action(a: SeedRefs, runId: string): Promise<string> {
    const row = await withTenant(appPool, a.accountId, a.userId, undefined, async (c) => (await c.query("SELECT * FROM run_action_request('retry_run', $1, NULL, $2)", [runId, "h".repeat(64)])).rows[0]);
    expect(await createRunActionFacade(writerPool, {} as ExecutionTargetRegistry).claimRunAction(row.action_id, 600)).not.toBeNull();
    return row.action_id;
  }
  const dial = (a: SeedRefs, type: string, version: number, disposition: string) =>
    admin.query("INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, $3, $4, NULL, $5, $6)", [a.accountId, a.repoId, type, disposition, version, a.userId]);
  const snapshots = async (runId: string): Promise<DecisionSnapshot[]> => (await admin.query(`SELECT payload FROM run_events WHERE run_id = $1 AND kind = $2 ORDER BY seq`, [runId, DECISION_SNAPSHOT_KIND])).rows.map((r) => r.payload);
  const runIdOf = (out: unknown): string => (out as { outcome: { run_id: string } }).outcome.run_id;
  const blocks = (prompt: string): number => prompt.split(BLOCK_HEAD).length - 1;
  const instructionsOf = (prompt: string): Record<string, string> => Object.fromEntries([...prompt.matchAll(/^- (d\d+): ".*" -> (.*)$/gm)].map((m) => [m[1]!, m[2]!]));
  const runsOf = async (a: SeedRefs, itemId: string) => Number((await admin.query("SELECT count(*) AS n FROM agent_runs WHERE account_id = $1 AND work_item_id = $2", [a.accountId, itemId])).rows[0].n);
  const keysOf = async (a: SeedRefs, actionId: string) => Number((await admin.query("SELECT count(*) AS n FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2", [a.accountId, `run-action:${actionId}`])).rows[0].n);

  it("a retried executor run has one snapshot row of its own and a prompt that offers exactly its keys with the instruction its disposition reads as", async () => {
    const a = await seedAccount(admin, randomUUID());
    const failed = await failedRun(a);
    const t = stubTarget();
    const out = await module(t).performRetryRun(await action(a, failed.id));
    expect(out).toMatchObject({ result: "done" });
    const runId = runIdOf(out);
    const [snap, ...more] = await snapshots(runId);
    expect(more).toEqual([]);
    expect(snap!.entries.map((e) => [e.key, e.decision_type])).toEqual([["d1", REFACTOR], ["d2", TESTS]]);
    const prompt = t.admitted[0]!.prompt;
    expect(prompt.startsWith(PROMPT)).toBe(true);
    expect(blocks(prompt)).toBe(1);
    const read = instructionsOf(prompt);
    expect(Object.keys(read)).toEqual(snap!.entries.map((e) => e.key));
    for (const e of snap!.entries) expect(read[e.key]).toBe(e.disposition === "ask" ? "stop and ask" : "decide yourself and report it");
    expect(prompt).not.toMatch(/nonbreaking_refactor_approach|test_strategy_choice|human_in_the_loop|Balanced|Cautious|Autonomous/);
  });

  it("a Retry is a fresh executor run: it is never given the failed run's snapshot, so a dial changed since applies and the failed run's own row is left alone", async () => {
    const a = await seedAccount(admin, randomUUID());
    const failed = await failedRun(a);
    const parentBefore = await snapshots(failed.id);
    expect(parentBefore[0]!.entries[0]).toMatchObject({ decision_type: REFACTOR, dial_version: 0 });
    await dial(a, REFACTOR, 1, "ask");
    const t = stubTarget();
    const runId = runIdOf(await module(t).performRetryRun(await action(a, failed.id)));
    const [snap] = await snapshots(runId);
    expect(snap!.entries[0]).toEqual({ key: "d1", decision_type: REFACTOR, disposition: "ask", dial_version: 1 });
    expect(snap).not.toEqual(parentBefore[0]);
    expect(await snapshots(failed.id)).toEqual(parentBefore);
    expect(instructionsOf(t.admitted[0]!.prompt).d1).toBe("stop and ask");
  });

  it("a prompt the failed run kept with an older block has that block replaced, never repeated", async () => {
    const a = await seedAccount(admin, randomUUID());
    const first = stubTarget();
    const firstRun = await failedRun(a);
    await module(first).performRetryRun(await action(a, firstRun.id));
    const kept = first.admitted[0]!.prompt;
    expect(blocks(kept)).toBe(1);
    const second = await failedRun(a, { prompt: kept });
    await dial(a, TESTS, 1, "ask");
    const t = stubTarget();
    await module(t).performRetryRun(await action(a, second.id));
    const prompt = t.admitted[0]!.prompt;
    expect(blocks(prompt)).toBe(1);
    expect(instructionsOf(prompt).d2).toBe("stop and ask");
  });

  it("a failed run that never had a snapshot (built before they existed) is retried with one", async () => {
    const a = await seedAccount(admin, randomUUID());
    const failed = await failedRun(a, { parentSnapshot: null });
    expect(await snapshots(failed.id)).toEqual([]);
    const t = stubTarget();
    const runId = runIdOf(await module(t).performRetryRun(await action(a, failed.id)));
    expect(await snapshots(runId)).toHaveLength(1);
    expect(blocks(t.admitted[0]!.prompt)).toBe(1);
  });

  it("a role that declares no decisions gets no block and no snapshot row", async () => {
    const a = await seedAccount(admin, randomUUID());
    const failed = await failedRun(a, { role: "code-reviewer", parentSnapshot: null });
    const t = stubTarget();
    const out = await module(t).performRetryRun(await action(a, failed.id));
    expect(out).toMatchObject({ result: "done" });
    expect(t.admitted[0]!.prompt).toBe(PROMPT);
    expect(await snapshots(runIdOf(out))).toEqual([]);
  });

  it("REFUSAL: when the offer cannot be read the retry is refused decision_snapshot_unavailable, and no run, claim, snapshot or sandbox call exists", async () => {
    const a = await seedAccount(admin, randomUUID());
    const failed = await failedRun(a);
    const id = await action(a, failed.id);
    const t = stubTarget();
    expect(await module(t, { failRead: true }).performRetryRun(id)).toEqual({ result: "refused", errorCode: "decision_snapshot_unavailable" });
    expect(t.admitted).toEqual([]);
    expect(await runsOf(a, failed.itemId)).toBe(1);
    expect(await keysOf(a, id)).toBe(0);
    // Nothing is left half done: the same action performed with the read working starts its one run.
    expect(await module(t).performRetryRun(id)).toMatchObject({ result: "done" });
    expect(t.admitted).toHaveLength(1);
  });

  it("REFUSAL: a snapshot that cannot be WRITTEN rolls the whole create back: no run, no claim, no sandbox call, and the error is not swallowed", async () => {
    const a = await seedAccount(admin, randomUUID());
    const failed = await failedRun(a);
    const id = await action(a, failed.id);
    await admin.query(
      `CREATE OR REPLACE FUNCTION retry_decisions_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
         IF NEW.kind = '${DECISION_SNAPSHOT_KIND}' AND NEW.account_id = '${a.accountId}' THEN RAISE EXCEPTION 'forced snapshot write failure'; END IF;
         RETURN NEW; END $$`,
    );
    await admin.query("CREATE TRIGGER retry_decisions_test_fail BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION retry_decisions_test_fail()");
    const t = stubTarget();
    try {
      await expect(module(t).performRetryRun(id)).rejects.toBeDefined();
    } finally {
      await admin.query("DROP TRIGGER retry_decisions_test_fail ON run_events");
    }
    expect(t.admitted).toEqual([]);
    expect(await runsOf(a, failed.itemId)).toBe(1);
    expect(await keysOf(a, id)).toBe(0);
  });

  it("a replay of an already-performed action returns the recorded run even when the decision read now fails (the claim is looked up first)", async () => {
    const a = await seedAccount(admin, randomUUID());
    const failed = await failedRun(a);
    const id = await action(a, failed.id);
    const t = stubTarget();
    const first = await module(t).performRetryRun(id);
    expect(first).toMatchObject({ result: "done" });
    expect(await module(t, { failRead: true }).performRetryRun(id)).toEqual(first);
    expect(t.admitted).toHaveLength(1);
  });

  it("a replay of the same action starts nothing more and writes no second snapshot", async () => {
    const a = await seedAccount(admin, randomUUID());
    const failed = await failedRun(a);
    const id = await action(a, failed.id);
    const t = stubTarget();
    const m = module(t);
    const first = await m.performRetryRun(id);
    expect(await m.performRetryRun(id)).toEqual(first);
    expect(t.admitted).toHaveLength(1);
    expect(await snapshots(runIdOf(first))).toHaveLength(1);
  });
});
