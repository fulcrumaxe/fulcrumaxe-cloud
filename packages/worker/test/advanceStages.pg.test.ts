import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { insertAgentRun, writeRunStatus, type CancelResult, type ExecutionRun, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createRunActionFacade } from "../src/runActions.js";
import { createAdvanceModule, type AdvanceModuleDeps, type AdvanceStepPorts, type AdvanceStepResult } from "../src/advance.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";

/** D#483 P2 [pg]: the build approval at spec_ready, the clone / pr / exclusive run options, and the pipeline steps' ports. */
describe("advance: panel, Spec and build [pg]", { timeout: 60_000 }, () => {
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
  function fakeStarter() {
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
        return { runId };
      },
    };
    return { starter, inputs };
  }
  /** A registry whose only target records the runs it is asked to cancel. */
  function cancellingRegistry() {
    const cancelled: string[] = [];
    const target = {
      cancel: async (run: ExecutionRun): Promise<CancelResult> => {
        cancelled.push(run.id);
        return { settled_usd: 0, released_usd: 0 };
      },
    };
    return { registry: { sandbox: target } as unknown as ExecutionTargetRegistry, cancelled };
  }
  const ok = (over: Partial<AdvanceStepResult> = {}): AdvanceStepResult => ({ status: "ok", ...over });
  function build(over: Partial<AdvanceModuleDeps> = {}) {
    const { starter, inputs } = fakeStarter();
    const { registry, cancelled } = cancellingRegistry();
    const calls: Array<{ step: string; ports: AdvanceStepPorts; args: unknown[]; options?: unknown }> = [];
    const step = (name: string, result: AdvanceStepResult = ok()) => async (_pool: Pool, ...rest: unknown[]) => {
      const at = rest.findIndex((r) => typeof r === "object" && r !== null && "startRun" in r);
      calls.push({ step: name, ports: rest[at] as AdvanceStepPorts, args: rest.slice(0, at), options: rest[at + 1] });
      return result;
    };
    const deps: AdvanceModuleDeps = {
      starter,
      resolveRunSeat: vi.fn(async () => SEAT),
      startAdvance: async () => undefined,
      triage: null,
      panel: step("panel") as never,
      spec: step("spec") as never,
      build: step("build", { status: "started", runId: "r" }) as never,
      buildFailed: (async (_pool: Pool, ...rest: unknown[]) => (calls.push({ step: "buildFailed", ports: undefined as never, args: rest }), ok({ status: "recorded", stage: "needs_human" }))) as never,
      registry,
      ...over,
    };
    return { module: createAdvanceModule(writerPool, deps), inputs, calls, cancelled, deps };
  }

  async function setupRepo(a: SeedRefs) {
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
  }
  let nextNumber = 9000;
  let nextDiscussion = 100;
  /** A work item the webhook (or the pipeline) left at `stage`; `spec_ready` ones get a discussion of `kind` and a Spec unless told otherwise. */
  async function item(a: SeedRefs, o: { stage?: string; provenance?: string; kind?: string | null; spec?: boolean; discussion?: boolean; role?: string } = {}) {
    if (o.role) await admin.query("UPDATE account_members SET role = $3 WHERE account_id = $1 AND user_id = $2", [a.accountId, a.userId, o.role]);
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', $4, $5, $6)", [id, a.accountId, a.repoId, o.provenance ?? "internal", o.stage ?? "spec_ready", nextNumber++]);
    if (o.discussion !== false && (o.stage ?? "spec_ready") === "spec_ready") {
      const discussion = randomUUID();
      await admin.query(
        "INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, $4, 't', $5, 'internal', 'user')",
        [discussion, a.accountId, nextDiscussion++, o.kind === undefined ? "feature" : o.kind, id],
      );
      await admin.query("UPDATE work_items SET discussion_id = $1 WHERE id = $2", [discussion, id]);
    }
    if (o.spec !== false && (o.stage ?? "spec_ready") === "spec_ready") {
      await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')", [a.accountId, id]);
    }
    return id;
  }
  async function action(a: SeedRefs, workItemId: string): Promise<string> {
    const row = await withTenant(appPool, a.accountId, a.userId, undefined, async (c) => (await c.query("SELECT * FROM run_action_request('advance_work_item', $1, NULL, $2)", [workItemId, "h".repeat(64)])).rows[0]);
    expect(await createRunActionFacade(writerPool, {} as never).claimRunAction(row.action_id, 600)).not.toBeNull();
    return row.action_id;
  }
  async function run(a: SeedRefs, workItemId: string, status: string, role = "executor"): Promise<string> {
    const { id } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: a.accountId, workItemId, role: role as never, runtime: "production", executionMode: "sandbox", dispatchRepoId: a.repoId });
    if (status === "pending") return id;
    await writeRunStatus(writerPool, { accountId: a.accountId, runId: id, from: "pending", to: "running" });
    if (status !== "running") await writeRunStatus(writerPool, { accountId: a.accountId, runId: id, from: "running", to: status as "failed" });
    return id;
  }

  // ---- performAdvanceWorkItem at spec_ready -----------------------------------------------------

  it.each(["critical", "feature", "small", "bug", "doc"])("an owner's approval of a spec_ready item with a %s Spec starts the workflow", async (kind) => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a, { kind });
    const started: unknown[] = [];
    const t = build({ startAdvance: async (args) => void started.push(args) });
    expect(await t.module.performAdvanceWorkItem(await action(a, w))).toEqual({ result: "done", outcome: { work_item_id: w, advance: "started" } });
    expect(started).toHaveLength(1);
  });

  it.each([
    ["a project (its Spec is a plan)", { kind: "project" }],
    ["a question", { kind: "question" }],
    ["an item with no Spec", { spec: false }],
    ["an item with no discussion", { discussion: false }],
  ])("%s at spec_ready is refused not_advanceable and starts nothing", async (_n, o) => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a, o);
    const started: unknown[] = [];
    expect(await build({ startAdvance: async (args) => void started.push(args) }).module.performAdvanceWorkItem(await action(a, w))).toEqual({ result: "refused", errorCode: "not_advanceable" });
    expect(started).toEqual([]);
  });

  it("an external item at spec_ready is refused external_requires_human, and one whose executor is live already_running", async () => {
    const a = await seedAccount(admin, randomUUID());
    expect(await build().module.performAdvanceWorkItem(await action(a, await item(a, { provenance: "external" })))).toEqual({ result: "refused", errorCode: "external_requires_human" });
    const live = await item(a);
    await run(a, live, "running");
    expect(await build().module.performAdvanceWorkItem(await action(a, live))).toEqual({ result: "refused", errorCode: "already_running" });
  });

  it("advanceLoadItem tells the workflow the discussion's kind and whether a Spec is published (an erased one does not count)", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a, { kind: "critical" });
    const m = build().module;
    expect(await m.advanceLoadItem(a.accountId, w)).toMatchObject({ stage: "spec_ready", hasDiscussion: true, kind: "critical", hasSpec: true });
    await admin.query("UPDATE spec_versions SET erased_at = now() WHERE work_item_id = $1", [w]);
    expect(await m.advanceLoadItem(a.accountId, w)).toMatchObject({ hasSpec: false });
    const triaged = await item(a, { stage: "triaged" });
    expect(await m.advanceLoadItem(a.accountId, triaged)).toMatchObject({ hasDiscussion: false, kind: null, hasSpec: false });
  });

  // ---- advanceStartRun: clone, pr, exclusive ----------------------------------------------------

  it("a run with clone gets the working directory and the repository to clone; pr names the sandbox; without them neither is set", async () => {
    const a = await seedAccount(admin, randomUUID());
    await setupRepo(a);
    const w = await item(a);
    const t = build();
    const base = { accountId: a.accountId, workItemId: w, haltEpoch: 0, role: "executor", prompt: "p" };
    expect((await t.module.advanceStartRun({ ...base, step: "build:v1:x", clone: true, pr: 7 })).ok).toBe(true);
    expect(t.inputs[0]).toMatchObject({ workdir: "/vercel/sandbox/repo", cloneRepo: { owner: "acme", name: "widgets" }, pr: 7, repoId: a.repoId });
    expect((await t.module.advanceStartRun({ ...base, role: "project-manager", step: "classify:x" })).ok).toBe(true);
    expect(t.inputs[1]).not.toHaveProperty("cloneRepo");
    expect(t.inputs[1]).not.toHaveProperty("workdir");
    expect(t.inputs[1]).not.toHaveProperty("pr");
  });

  it("a clone with no repository name is refused no_repo before anything starts; a pr that is not a positive whole number is invalid_input", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const t = build();
    const base = { accountId: a.accountId, workItemId: w, haltEpoch: 0, role: "executor", prompt: "p", step: "build:v1:x" };
    expect(await t.module.advanceStartRun({ ...base, clone: true })).toEqual({ ok: false, reason: "no_repo" });
    for (const pr of [0, -1, 1.5, Number.NaN]) expect(await t.module.advanceStartRun({ ...base, pr })).toEqual({ ok: false, reason: "invalid_input" });
    expect(t.inputs).toEqual([]);
  });

  it("exclusive: another live run of the item refuses already_running; a finished one does not; the step's own claimed run is returned even while it is live", async () => {
    const a = await seedAccount(admin, randomUUID());
    await setupRepo(a);
    const w = await item(a);
    const base = { accountId: a.accountId, workItemId: w, haltEpoch: 0, role: "executor", prompt: "p", clone: true, pr: 7, exclusive: true };
    const live = await run(a, w, "running");
    const t = build();
    expect(await t.module.advanceStartRun({ ...base, step: "build:v1:second" })).toEqual({ ok: false, reason: "already_running" });
    expect(t.inputs).toEqual([]);
    // The same live run, claimed under this step's key (a replay of the step that started it), is not "another" run.
    const key = `advance:${w}:build:v1:first`;
    await admin.query("INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4)", [a.accountId, key, live, createHash("sha256").update(key).digest("hex")]);
    expect((await t.module.advanceStartRun({ ...base, step: "build:v1:first" })).ok).toBe(true);
    // Not exclusive: seats run side by side.
    expect((await t.module.advanceStartRun({ ...base, exclusive: false, step: "panel:x" })).ok).toBe(true);
    // A finished run does not block.
    await admin.query("UPDATE agent_runs SET status = 'failed' WHERE id = $1", [live]);
    expect((await build().module.advanceStartRun({ ...base, step: "build:v1:third" })).ok).toBe(true);
  });

  // ---- the pipeline steps ----------------------------------------------------------------------

  it("each step gets ports bound to its account and item: a run it starts is that item's, whatever it asks", async () => {
    const a = await seedAccount(admin, randomUUID());
    await setupRepo(a);
    const w = await item(a);
    const other = await item(a);
    const t = build();
    const who = { accountId: a.accountId, userId: a.userId, workItemId: w, haltEpoch: 0 };
    expect((await t.module.advancePanel(who)).status).toBe("ok");
    const ports = t.calls[0]!.ports;
    expect(t.calls[0]!.args).toEqual([a.accountId, w]);
    const started = await ports.startRun({ step: "panel:s", role: "technical-architect", prompt: "p", clone: true, ...({ workItemId: other, accountId: randomUUID() } as object) });
    expect(started.ok).toBe(true);
    expect(t.inputs[0]).toMatchObject({ accountId: a.accountId, workItemId: w });
    expect(t.deps.resolveRunSeat).toHaveBeenCalledWith({ accountId: a.accountId, role: "technical-architect", workItemId: w });
  });

  it("the steps refuse an item that is gone, external or malformed, and a missing port, as data and before any spend", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const external = await item(a, { provenance: "external" });
    const t = build();
    const who = (workItemId: string) => ({ accountId: a.accountId, userId: a.userId, workItemId, haltEpoch: 0 });
    for (const call of [(x: ReturnType<typeof who>) => t.module.advancePanel(x), (x: ReturnType<typeof who>) => t.module.advanceSpec(x), (x: ReturnType<typeof who>) => t.module.advanceBuild(x, randomUUID())]) {
      expect(await call(who(external))).toEqual({ status: "refused", reason: "external_requires_human" });
      expect(await call(who(randomUUID()))).toEqual({ status: "refused", reason: "target_not_found" });
      expect(await call(who("x"))).toEqual({ status: "refused", reason: "invalid_input" });
    }
    expect(await t.module.advanceBuild(who(w), "not-a-uuid")).toEqual({ status: "refused", reason: "invalid_input" });
    expect(t.calls).toEqual([]);
    const none = build({ panel: null, spec: null, build: null, buildFailed: null }).module;
    expect(await none.advancePanel(who(w))).toEqual({ status: "refused", reason: "panel_unavailable" });
    expect(await none.advanceSpec(who(w))).toEqual({ status: "refused", reason: "spec_unavailable" });
    expect(await none.advanceBuild(who(w), randomUUID())).toEqual({ status: "refused", reason: "build_unavailable" });
    expect(await none.advanceBuildFailed(a.accountId, w, randomUUID(), "run_failed")).toEqual({ status: "refused", reason: "build_unavailable" });
  });

  it("advanceBuild passes the approval to the pipeline; advanceBuildFailed passes a fixed code and refuses anything else", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const t = build();
    const approval = randomUUID();
    expect((await t.module.advanceBuild({ accountId: a.accountId, userId: a.userId, workItemId: w, haltEpoch: 0 }, approval)).status).toBe("started");
    expect(t.calls[0]!.args).toEqual([a.accountId, w, approval]);
    expect(t.calls[0]!.options).toEqual({});
    const runId = randomUUID();
    expect((await t.module.advanceBuildFailed(a.accountId, w, runId, "run_failed")).status).toBe("recorded");
    expect(t.calls[1]).toMatchObject({ step: "buildFailed", args: [a.accountId, w, runId, "run_failed"] });
    for (const code of ["Run Failed", "x".repeat(41), "run failed", ""]) expect(await t.module.advanceBuildFailed(a.accountId, w, runId, code)).toEqual({ status: "refused", reason: "invalid_input" });
    expect(await t.module.advanceBuildFailed(a.accountId, w, "x", "run_failed")).toEqual({ status: "refused", reason: "invalid_input" });
  });

  // ---- the cancel port ---------------------------------------------------------------------------

  it("cancel stops a LIVE run of this item through the runner's own cancel path, as the approver", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const live = await run(a, w, "running", "technical-architect");
    const t = build();
    await t.module.advancePanel({ accountId: a.accountId, userId: a.userId, workItemId: w, haltEpoch: 0 });
    await t.calls[0]!.ports.cancel(live);
    expect(t.cancelled).toEqual([live]);
    expect((await admin.query("SELECT status FROM agent_runs WHERE id = $1", [live])).rows[0].status).toBe("cancelled");
  });

  it("cancel leaves a finished run, another item's run, an unknown run and a lowered member alone", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const other = await item(a);
    const done = await run(a, w, "succeeded", "technical-architect");
    const foreign = await run(a, other, "running", "technical-architect");
    const t = build();
    await t.module.advancePanel({ accountId: a.accountId, userId: a.userId, workItemId: w, haltEpoch: 0 });
    const ports = t.calls[0]!.ports;
    await ports.cancel(done);
    await ports.cancel(foreign);
    await ports.cancel(randomUUID());
    await ports.cancel("not-a-uuid");
    expect(t.cancelled).toEqual([]);
    expect((await admin.query("SELECT status FROM agent_runs WHERE id = $1", [foreign])).rows[0].status).toBe("running");
    // No registry: nothing to cancel through, and no throw.
    const bare = build({ registry: null });
    await bare.module.advancePanel({ accountId: a.accountId, userId: a.userId, workItemId: w, haltEpoch: 0 });
    await expect(bare.calls[0]!.ports.cancel(foreign)).resolves.toBeUndefined();
  });

  it("outcome reads a run through the same account", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const finished = await run(a, w, "succeeded", "technical-architect");
    await admin.query(`UPDATE agent_runs SET envelope = '{"comment":"c","stance":"agree","challenge":false}'::jsonb WHERE id = $1`, [finished]);
    const t = build();
    await t.module.advancePanel({ accountId: a.accountId, userId: a.userId, workItemId: w, haltEpoch: 0 });
    expect(await t.calls[0]!.ports.outcome(finished)).toEqual({ status: "succeeded", done: true, envelope: { comment: "c", stance: "agree", challenge: false }, runtime: "production", tailRunId: finished, failureReason: null });
    const b = await seedAccount(admin, randomUUID());
    const wb = await item(b);
    const tb = build();
    await tb.module.advancePanel({ accountId: b.accountId, userId: b.userId, workItemId: wb, haltEpoch: 0 });
    expect(await tb.calls[0]!.ports.outcome(finished)).toEqual({ status: "missing", done: true, envelope: null });
  });
});
