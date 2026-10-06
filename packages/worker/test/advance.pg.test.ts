import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { insertAgentRun, writeRunStatus, type StartAgentRunInput } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createRunActionFacade } from "../src/runActions.js";
import { createAdvanceModule, ADVANCEABLE_STAGES, ADVANCE_TERMINAL_STATUSES, type AdvanceModuleDeps, type AdvanceStartArgs, type AdvanceTriageInput } from "../src/advance.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";

/** D#483 P1 [pg]: the advance_work_item performer and the workflow's step methods against the real definers. */
describe("advance_work_item [pg]", { timeout: 60_000 }, () => {
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
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });

  // ---- stand-ins -------------------------------------------------------------------------------
  const SEAT: SeatResult = {
    ok: true,
    seat: {
      repoId: "unused",
      product: "team",
      roleCard: "card",
      model: "haiku-4.5",
      capUsd: 5,
      spend: { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 },
      limits: { maxRunMs: 30 * 60_000, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 15 * 60_000 },
      timeoutMs: 40 * 60_000,
      maxExtensions: 3,
    } as never,
  };
  /** A starter that honours the idempotency key like the real one: the same key returns the same run. */
  function fakeStarter(refuse?: "refused_spend") {
    const inputs: StartAgentRunInput[] = [];
    const byKey = new Map<string, string>();
    const starter: RunStarter = {
      async start(input) {
        inputs.push(input);
        const key = input.idempotency!.key;
        const existing = byKey.get(key);
        if (existing) return { runId: existing };
        const runId = randomUUID();
        byKey.set(key, runId);
        return refuse ? { runId, refused: refuse } : { runId };
      },
    };
    return { starter, inputs };
  }
  function build(over: Partial<AdvanceModuleDeps> = {}) {
    const started: AdvanceStartArgs[] = [];
    const triaged: AdvanceTriageInput[] = [];
    const { starter, inputs } = fakeStarter();
    const deps: AdvanceModuleDeps = {
      starter,
      resolveRunSeat: vi.fn(async () => SEAT),
      startAdvance: async (args) => void started.push(args),
      triage: async (_pool, _account, input) => (triaged.push(input), { status: "triaged", category: input.category, stage: "discussing" }),
      ...over,
    };
    return { module: createAdvanceModule(writerPool, deps), started, triaged, inputs, deps };
  }

  // ---- worlds ----------------------------------------------------------------------------------
  let nextNumber = 700;
  async function world(a: SeedRefs, o: { provenance?: string; stage?: string; repo?: boolean; number?: boolean; role?: string } = {}) {
    if (o.role) await admin.query("UPDATE account_members SET role = $3 WHERE account_id = $1 AND user_id = $2", [a.accountId, a.userId, o.role]);
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', $4, $5, $6)", [
      id,
      a.accountId,
      o.repo === false ? null : a.repoId,
      o.provenance ?? "internal",
      o.stage ?? "triaged",
      o.number === false ? null : nextNumber++,
    ]);
    return id;
  }
  /** A claimed advance_work_item action, requested by the session member through the real definer. */
  async function action(a: SeedRefs, workItemId: string): Promise<string> {
    const row = await withTenant(appPool, a.accountId, a.userId, undefined, async (c) => (await c.query("SELECT * FROM run_action_request('advance_work_item', $1, NULL, $2)", [workItemId, "h".repeat(64)])).rows[0]);
    expect(await createRunActionFacade(writerPool, {} as never).claimRunAction(row.action_id, 600)).not.toBeNull();
    return row.action_id;
  }
  async function run(a: SeedRefs, workItemId: string, status: string): Promise<string> {
    const { id } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: a.accountId, workItemId, role: "project-manager", runtime: "production", executionMode: "sandbox", dispatchRepoId: a.repoId });
    if (status === "pending") return id;
    await writeRunStatus(writerPool, { accountId: a.accountId, runId: id, from: "pending", to: "running" });
    if (status !== "running") await writeRunStatus(writerPool, { accountId: a.accountId, runId: id, from: "running", to: status as "failed" });
    return id;
  }

  // ---- performAdvanceWorkItem ------------------------------------------------------------------

  it("starts the workflow once with the ids and nothing else, and settles done 'started'", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await world(a);
    const t = build();
    const out = await t.module.performAdvanceWorkItem(await action(a, w));
    expect(out).toEqual({ result: "done", outcome: { work_item_id: w, advance: "started" } });
    expect(t.started).toHaveLength(1);
    expect(t.started[0]).toMatchObject({ accountId: a.accountId, userId: a.userId, workItemId: w });
    expect(Object.keys(t.started[0]!).sort()).toEqual(["accountId", "actionId", "specVersion", "userId", "workItemId"]);
    expect((t.started[0] as { specVersion?: number | null }).specVersion).toBeNull();
  });

  it("an admin is allowed too", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await world(a, { role: "admin" });
    const t = build();
    expect((await t.module.performAdvanceWorkItem(await action(a, w))).result).toBe("done");
  });

  it.each([
    ["an external item", { provenance: "external" }, "external_requires_human"],
    ["an item with no repo", { repo: false }, "no_repo"],
    ["an item with no issue number", { number: false }, "no_issue_link"],
    ["an item already past triaged", { stage: "discussing" }, "not_advanceable"],
    ["an item at spec_ready that has no discussion or Spec behind it", { stage: "spec_ready" }, "not_advanceable"],
    ["a closed item", { stage: "closed" }, "not_advanceable"],
  ] as const)("%s is refused %s and starts nothing", async (_n, o, errorCode) => {
    const a = await seedAccount(admin, randomUUID());
    const w = await world(a, o);
    const t = build();
    expect(await t.module.performAdvanceWorkItem(await action(a, w))).toEqual({ result: "refused", errorCode });
    expect(t.started).toEqual([]);
  });

  it("a role lowered to member between the request and the perform is refused principal_not_authorised", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await world(a);
    const id = await action(a, w);
    await admin.query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2", [a.accountId, a.userId]);
    const t = build();
    expect(await t.module.performAdvanceWorkItem(id)).toEqual({ result: "refused", errorCode: "principal_not_authorised" });
    expect(t.started).toEqual([]);
  });

  it("a removed member is refused principal_not_authorised", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await world(a);
    const id = await action(a, w);
    await admin.query("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2", [a.accountId, a.userId]);
    const t = build();
    expect(await t.module.performAdvanceWorkItem(id)).toEqual({ result: "refused", errorCode: "principal_not_authorised" });
  });

  it("a paused account is refused principal_not_authorised", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await world(a);
    const id = await action(a, w);
    await admin.query("UPDATE accounts SET owner_paused_at = now(), status = 'paused' WHERE id = $1", [a.accountId]);
    const t = build();
    expect(await t.module.performAdvanceWorkItem(id)).toEqual({ result: "refused", errorCode: "principal_not_authorised" });
    expect(t.started).toEqual([]);
  });

  it.each(["pending", "running"])("a %s run on the item is refused already_running; a finished one is not", async (status) => {
    const a = await seedAccount(admin, randomUUID());
    const w = await world(a);
    await run(a, w, status);
    expect(await build().module.performAdvanceWorkItem(await action(a, w))).toEqual({ result: "refused", errorCode: "already_running" });
    const b = await seedAccount(admin, randomUUID());
    const w2 = await world(b);
    await run(b, w2, "failed");
    expect((await build().module.performAdvanceWorkItem(await action(b, w2))).result).toBe("done");
  });

  it("without a startAdvance port it refuses advance_unavailable; an action that is not claimed throws; a wrong kind is refused", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await world(a);
    expect(await build({ startAdvance: null }).module.performAdvanceWorkItem(await action(a, w))).toEqual({ result: "refused", errorCode: "advance_unavailable" });
    const row = await withTenant(appPool, a.accountId, a.userId, undefined, async (c) => (await c.query("SELECT * FROM run_action_request('cancel_work_item', $1, NULL, $2)", [w, "h".repeat(64)])).rows[0]);
    await createRunActionFacade(writerPool, {} as never).claimRunAction(row.action_id, 600);
    expect(await build().module.performAdvanceWorkItem(row.action_id)).toEqual({ result: "refused", errorCode: "kind_mismatch" });
    const unclaimed = await withTenant(appPool, a.accountId, a.userId, undefined, async (c) => (await c.query("SELECT * FROM run_action_request('advance_work_item', $1, NULL, $2)", [await world(a), "h".repeat(64)])).rows[0]);
    await expect(build().module.performAdvanceWorkItem(unclaimed.action_id)).rejects.toThrow();
    await expect(build().module.performAdvanceWorkItem("not-a-uuid")).rejects.toThrow();
  });

  it("the stage and status lists match what the API and the runner say (drift guard)", () => {
    expect([...ADVANCEABLE_STAGES]).toEqual(["triaged", "discussing", "spec_ready", "in_progress", "pr_opened", "changes_requested", "review_passed", "needs_human"]);
    expect([...ADVANCE_TERMINAL_STATUSES]).toEqual(["succeeded", "failed", "timed_out", "killed_spend", "refused_spend", "cancelled"]);
  });

  // ---- the workflow's step methods --------------------------------------------------------------

  it("advanceStartRun keys the run advance:<item>:<step>; a replay returns the same run; the seat comes from the item", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await world(a);
    const t = build();
    const req = { accountId: a.accountId, workItemId: w, step: "classify:abc", role: "project-manager", prompt: "p" };
    const first = await t.module.advanceStartRun(req);
    const second = await t.module.advanceStartRun(req);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    expect(t.inputs[0]).toMatchObject({ accountId: a.accountId, repoId: a.repoId, workItemId: w, role: "project-manager", prompt: "p", idempotency: { key: `advance:${w}:classify:abc` } });
    expect(t.deps.resolveRunSeat).toHaveBeenCalledWith({ accountId: a.accountId, role: "project-manager", workItemId: w });
    const other = await t.module.advanceStartRun({ ...req, step: "classify:def" });
    expect(other.ok && first.ok && other.runId !== first.runId).toBe(true);
  });

  it("advanceStartRun answers a refusal as data: a seat refusal, no starter, a refused admit, an item with no repo, a bad step", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await world(a);
    const req = { accountId: a.accountId, workItemId: w, step: "classify", role: "project-manager", prompt: "p" };
    expect(await build({ resolveRunSeat: async () => ({ ok: false, reason: "no_model" }) }).module.advanceStartRun(req)).toEqual({ ok: false, reason: "no_model" });
    expect(await build({ starter: null }).module.advanceStartRun(req)).toEqual({ ok: false, reason: "starter_unavailable" });
    expect(await build({ starter: fakeStarter("refused_spend").starter }).module.advanceStartRun(req)).toEqual({ ok: false, reason: "refused_spend" });
    expect(await build().module.advanceStartRun({ ...req, workItemId: await world(a, { repo: false }) })).toEqual({ ok: false, reason: "no_repo" });
    expect(await build().module.advanceStartRun({ ...req, step: "bad step!" })).toEqual({ ok: false, reason: "invalid_input" });
    expect(await build().module.advanceStartRun({ ...req, workItemId: "x" })).toEqual({ ok: false, reason: "invalid_input" });
  });

  it("advanceRunOutcome: live runs are not done; terminal ones are; the envelope is read as an object; another account's or a missing run is done 'missing'", async () => {
    const a = await seedAccount(admin, randomUUID());
    const b = await seedAccount(admin, randomUUID());
    const w = await world(a);
    const m = build().module;
    const running = await run(a, w, "running");
    expect(await m.advanceRunOutcome(a.accountId, running)).toEqual({ status: "running", done: false, envelope: null, runtime: "production" });
    const finished = await run(a, w, "succeeded");
    await admin.query(`UPDATE agent_runs SET envelope = '{"category":"bug"}'::jsonb WHERE id = $1`, [finished]);
    expect(await m.advanceRunOutcome(a.accountId, finished)).toEqual({ status: "succeeded", done: true, envelope: { category: "bug" }, runtime: "production" });
    const junk = await run(a, w, "failed");
    await admin.query(`UPDATE agent_runs SET envelope = '"just a string"'::jsonb WHERE id = $1`, [junk]);
    expect(await m.advanceRunOutcome(a.accountId, junk)).toEqual({ status: "failed", done: true, envelope: null, runtime: "production" });
    expect(await m.advanceRunOutcome(b.accountId, finished)).toEqual({ status: "missing", done: true, envelope: null });
    expect(await m.advanceRunOutcome(a.accountId, randomUUID())).toEqual({ status: "missing", done: true, envelope: null });
    expect(await m.advanceRunOutcome("x", "y")).toEqual({ status: "missing", done: true, envelope: null });
  });

  it("advanceTriage re-checks the item before it calls triage, and passes the input through", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await world(a);
    const n = Number((await admin.query("SELECT gh_number FROM work_items WHERE id = $1", [w])).rows[0].gh_number);
    const input: AdvanceTriageInput = { workItemId: w, title: "t", body: "b", category: "feature", sourceEventId: "s", repoId: a.repoId, login: "o", number: n };
    const t = build();
    expect(await t.module.advanceTriage(a.accountId, input)).toMatchObject({ status: "triaged", stage: "discussing" });
    expect(t.triaged).toEqual([input]);
    // Every refusal calls nothing.
    const none = build();
    expect(await none.module.advanceTriage(a.accountId, { ...input, number: n + 1 })).toEqual({ status: "refused", reason: "item_changed" });
    expect(await none.module.advanceTriage(a.accountId, { ...input, repoId: randomUUID() })).toEqual({ status: "refused", reason: "item_changed" });
    expect(await none.module.advanceTriage(a.accountId, { ...input, workItemId: randomUUID() })).toEqual({ status: "refused", reason: "target_not_found" });
    expect(await none.module.advanceTriage(a.accountId, { ...input, workItemId: "x" })).toEqual({ status: "refused", reason: "invalid_input" });
    expect(await build({ triage: null }).module.advanceTriage(a.accountId, input)).toEqual({ status: "refused", reason: "triage_unavailable" });
    const external = await world(a, { provenance: "external" });
    const en = Number((await admin.query("SELECT gh_number FROM work_items WHERE id = $1", [external])).rows[0].gh_number);
    expect(await none.module.advanceTriage(a.accountId, { ...input, workItemId: external, number: en })).toEqual({ status: "refused", reason: "external_requires_human" });
    const moved = await world(a, { stage: "discussing" });
    const mn = Number((await admin.query("SELECT gh_number FROM work_items WHERE id = $1", [moved])).rows[0].gh_number);
    expect(await none.module.advanceTriage(a.accountId, { ...input, workItemId: moved, number: mn })).toEqual({ status: "refused", reason: "not_advanceable" });
    expect(none.triaged).toEqual([]);
  });

  it("advanceTriage accepts a replay: an item closed as superseded by an earlier triage", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await world(a);
    const n = Number((await admin.query("SELECT gh_number FROM work_items WHERE id = $1", [w])).rows[0].gh_number);
    await admin.query("UPDATE work_items SET stage = 'closed' WHERE id = $1", [w]);
    await admin.query(
      `INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'triaged', 'closed', now(), 'control_plane', $3)`,
      [a.accountId, w, `superseded:${randomUUID()}`],
    );
    const input: AdvanceTriageInput = { workItemId: w, title: "t", body: "b", category: "bug", sourceEventId: "s", repoId: a.repoId, login: "o", number: n };
    const t = build();
    expect((await t.module.advanceTriage(a.accountId, input)).status).toBe("triaged");
    // A closed item that was NOT superseded by triage is not ours.
    const other = await world(a, { stage: "closed" });
    const on = Number((await admin.query("SELECT gh_number FROM work_items WHERE id = $1", [other])).rows[0].gh_number);
    expect(await t.module.advanceTriage(a.accountId, { ...input, workItemId: other, number: on })).toEqual({ status: "refused", reason: "not_advanceable" });
  });

  it("advanceLoadItem reads plain data and nothing across accounts", async () => {
    const a = await seedAccount(admin, randomUUID());
    const b = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
    const w = await world(a);
    const m = build().module;
    expect(await m.advanceLoadItem(a.accountId, w)).toMatchObject({ stage: "triaged", provenance: "internal", repoId: a.repoId, ghOwner: "acme", ghName: "widgets", hasDiscussion: false, kind: null, hasSpec: false });
    expect(await m.advanceLoadItem(b.accountId, w)).toBeNull();
    expect(await m.advanceLoadItem("x", w)).toBeNull();
  });
});
