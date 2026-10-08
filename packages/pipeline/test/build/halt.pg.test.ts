import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { insertAgentRun, writeRunStatus, WorkItemHaltedError as RunHaltedError, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { WorkItemHaltedError } from "@fx/core/src/work-items/stages.js";
import { setStage } from "@fx/discussions";
import { systemPrincipal } from "@fx/discussions/server";
import { dispatchSpecReadyExecutor } from "../../src/build/stageMachine.js";
import { recordReviewVerdict } from "../../src/build/fixLoop.js";
import { resumeAgentRun } from "../../src/build/resumeAgentRun.js";
import { publishLightSpec } from "../../src/advance/lightSpec.js";
import { createFakeExecutionTarget } from "./helpers/fakeExecutionTarget.js";
import { seedAccount, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * DP8 / DP-C6 criteria 2, 6 and 8 for the pipeline's own writers, on real Postgres: a customer halt is not undone by a review
 * that was still running, an executor is not dispatched or resumed for a halted item, and the pipeline publishes no Spec and
 * moves no stage behind it.
 */
describe("customer halt and the pipeline's writers [pg]", () => {
  const db = pgHarness();

  async function fixture(stage: string, halted = true) {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 7 });
    await db.admin.query("UPDATE work_items SET stage = $2 WHERE id = $1", [workItemId, stage]);
    if (halted) await db.admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2, halt_epoch = 1 WHERE id = $1", [workItemId, randomUUID()]);
    const { target, calls } = createFakeExecutionTarget();
    const registry: ExecutionTargetRegistry = { sandbox: target };
    return { accountId, repoId, workItemId, registry, calls };
  }
  const input = (f: { repoId: string }): Omit<StartAgentRunInput, "accountId" | "workItemId" | "role"> => ({
    repoId: f.repoId,
    pr: 7,
    product: "team",
    roleCard: "c",
    prompt: "p",
    model: "haiku-4.5",
    capUsd: 5,
    spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
  });
  const state = async (id: string) => (await db.admin.query("SELECT stage FROM work_items WHERE id = $1", [id])).rows[0].stage as string;
  const transitions = async (id: string) => (await db.admin.query("SELECT count(*)::int AS n FROM work_item_transitions WHERE work_item_id = $1", [id])).rows[0].n as number;
  const runs = async (id: string) => (await db.admin.query("SELECT count(*)::int AS n FROM agent_runs WHERE work_item_id = $1", [id])).rows[0].n as number;

  it("6: a late review verdict (needs-fix or pass) leaves a halted item parked, writes no transition and starts no resume", async () => {
    for (const [verdict, role] of [["needs-fix", "code-reviewer"], ["pass", "code-reviewer"], ["needs-fix", "acceptance-tester"]] as const) {
      const f = await fixture("needs_human");
      const out = await recordReviewVerdict(db.runWriterPool, f.registry, {
        accountId: f.accountId,
        workItemId: f.workItemId,
        role,
        runId: randomUUID(),
        verdict,
        resumeInput: { ...input(f), accountId: f.accountId, workItemId: f.workItemId, role: "executor" },
      } as never);
      expect(out).toEqual({ outcome: "halted", labels: { add: [], remove: [] } });
      expect(await state(f.workItemId)).toBe("needs_human");
      expect(await transitions(f.workItemId)).toBe(0);
      expect(await runs(f.workItemId)).toBe(0);
      expect(f.calls).toEqual([]);
    }
  });

  it("6: a halt that lands between the verdict's stage write and the resume is stopped at the insert", async () => {
    const f = await fixture("in_progress", false);
    const { id } = await insertAgentRun(db.runWriterPool, { id: randomUUID(), accountId: f.accountId, workItemId: f.workItemId, role: "executor", runtime: "production", executionMode: "sandbox", dispatchRepoId: f.repoId, dispatchPrNumber: 7 });
    await writeRunStatus(db.runWriterPool, { accountId: f.accountId, runId: id, from: "pending", to: "running", result: { sessionId: "s1" } });
    await writeRunStatus(db.runWriterPool, { accountId: f.accountId, runId: id, from: "running", to: "succeeded" });
    await db.admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2, halt_epoch = 1 WHERE id = $1", [f.workItemId, randomUUID()]);
    const before = await runs(f.workItemId);
    await expect(resumeAgentRun(db.runWriterPool, f.registry, { ...input(f), accountId: f.accountId, workItemId: f.workItemId, role: "executor" } as never)).rejects.toBeInstanceOf(RunHaltedError);
    expect(await runs(f.workItemId)).toBe(before);
    expect(f.calls).toEqual([]);
  });

  it("6: a halt that lands between recordReviewVerdict's stage write and its resume gives outcome halted, not a thrown error, and starts nothing", async () => {
    const f = await fixture("pr_opened", false);
    const { id } = await insertAgentRun(db.runWriterPool, { id: randomUUID(), accountId: f.accountId, workItemId: f.workItemId, role: "executor", runtime: "production", executionMode: "sandbox", dispatchRepoId: f.repoId, dispatchPrNumber: 7 });
    await writeRunStatus(db.runWriterPool, { accountId: f.accountId, runId: id, from: "pending", to: "running", result: { sessionId: "s1" } });
    await writeRunStatus(db.runWriterPool, { accountId: f.accountId, runId: id, from: "running", to: "succeeded" });
    const before = await runs(f.workItemId);
    // The customer's halt commits just before the run's create statement: the stage write above it has already passed.
    const pool = new Proxy(db.runWriterPool, {
      get(target, prop) {
        if (prop === "connect") {
          return async (...args: unknown[]) => {
            const client = await (target.connect as (...a: unknown[]) => Promise<{ query: (...q: unknown[]) => Promise<unknown> }>)(...args);
            const query = client.query.bind(client);
            client.query = async (...q: unknown[]) => {
              if (typeof q[0] === "string" && q[0].includes("agent_run_create")) {
                await db.admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2, halt_epoch = 1 WHERE id = $1", [f.workItemId, randomUUID()]);
              }
              return query(...q);
            };
            return client;
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const out = await recordReviewVerdict(pool, f.registry, {
      accountId: f.accountId,
      workItemId: f.workItemId,
      role: "code-reviewer",
      runId: id,
      verdict: "needs-fix",
      resumeInput: { ...input(f), accountId: f.accountId, workItemId: f.workItemId, role: "executor" },
    } as never);
    expect(out).toEqual({ outcome: "halted", labels: { add: [], remove: [] } });
    expect(await runs(f.workItemId)).toBe(before);
    expect(f.calls).toEqual([]);
  });

  it("2: a halt that lands between the executor run's start and its stage write answers item_halted and leaves the stage at spec_ready", async () => {
    const f = await fixture("spec_ready", false);
    const pool = new Proxy(db.runWriterPool, {
      get(target, prop) {
        if (prop === "connect") {
          return async (...args: unknown[]) => {
            const client = await (target.connect as (...a: unknown[]) => Promise<{ query: (...q: unknown[]) => Promise<unknown> }>)(...args);
            const query = client.query.bind(client);
            client.query = async (...q: unknown[]) => {
              if (typeof q[0] === "string" && q[0].includes("now() AS db_now, halted_at")) {
                await db.admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2, halt_epoch = 1 WHERE id = $1", [f.workItemId, randomUUID()]);
              }
              return query(...q);
            };
            return client;
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const out = await dispatchSpecReadyExecutor(pool, f.registry, { accountId: f.accountId, workItemId: f.workItemId, executorInput: input(f) });
    expect(out).toEqual({ status: "item_halted" });
    expect(await state(f.workItemId)).toBe("spec_ready");
    expect(await transitions(f.workItemId)).toBe(0);
  });

  it("2: dispatching the spec-ready executor on a halted item answers item_halted and reaches no target", async () => {
    const f = await fixture("spec_ready");
    const out = await dispatchSpecReadyExecutor(db.runWriterPool, f.registry, { accountId: f.accountId, workItemId: f.workItemId, executorInput: input(f) });
    expect(out).toEqual({ status: "item_halted" });
    expect(f.calls).toEqual([]);
    expect(await runs(f.workItemId)).toBe(0);
    expect(await state(f.workItemId)).toBe("spec_ready");
  });

  it("8: the pipeline publishes no Spec on a halted item at discussing or spec_ready, and its setStage moves nothing at triaged", async () => {
    for (const stage of ["discussing", "spec_ready"]) {
      const f = await fixture(stage);
      const out = await publishLightSpec(db.runWriterPool, f.accountId, f.workItemId, { summary: "s", spec: "# Spec\n\nDo the thing." });
      expect(out).toEqual({ status: "refused", reason: "item_halted" });
      expect((await db.admin.query("SELECT count(*)::int AS n FROM spec_versions WHERE work_item_id = $1", [f.workItemId])).rows[0].n).toBe(0);
      expect(await state(f.workItemId)).toBe(stage);
    }
    const f = await fixture("triaged");
    const ctx = { pool: db.runWriterPool, principal: systemPrincipal(f.accountId, "pipeline.triage") };
    await expect(setStage(ctx, { workItemId: f.workItemId, toStage: "discussing" })).rejects.toBeInstanceOf(WorkItemHaltedError);
    expect(await state(f.workItemId)).toBe("triaged");
    expect(await transitions(f.workItemId)).toBe(0);
  });

  it("8 (control): the same publish on an item that is not halted still works", async () => {
    const f = await fixture("discussing", false);
    const out = await publishLightSpec(db.runWriterPool, f.accountId, f.workItemId, { summary: "s", spec: "# Spec\n\nDo the thing." });
    expect(out.status).toBe("published");
    expect(await state(f.workItemId)).toBe("spec_ready");
  });
});
