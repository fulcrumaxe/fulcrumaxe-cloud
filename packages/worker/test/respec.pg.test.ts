import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { insertAgentRun, writeRunStatus, type StartAgentRunInput } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createRunActionFacade } from "../src/runActions.js";
import { createAdvanceModule, type AdvanceModuleDeps, type AdvanceStartArgs, type AdvanceStepWho } from "../src/advance.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";

/** D#6 R4d-5b [pg]: `respec_work_item`, the run action that starts the stage driver in Re-spec mode, and the step that publishes the next Spec version. */
describe("respec_work_item [pg]", { timeout: 60_000 }, () => {
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

  const SEAT: SeatResult = { ok: true, seat: { repoId: "unused", product: "team", roleCard: "card", model: "haiku-4.5", capUsd: 5 } as never };
  function build(over: Partial<AdvanceModuleDeps> = {}) {
    const started: AdvanceStartArgs[] = [];
    const inputs: StartAgentRunInput[] = [];
    const starter: RunStarter = { start: async (input) => (inputs.push(input), { runId: randomUUID() }) };
    const resolveRunSeat = vi.fn(async (_req: { role: string }) => SEAT);
    const deps: AdvanceModuleDeps = { starter, resolveRunSeat: resolveRunSeat as never, startAdvance: async (args) => void started.push(args), triage: null, ...over };
    return { module: createAdvanceModule(writerPool, deps), started, resolveRunSeat };
  }

  let nextNumber = 12000;
  let nextDiscussion = 500;
  /** An item at `stage` with a discussion of `kind` and a Spec (version 1) whose frontmatter is `frontmatter`. */
  async function item(a: SeedRefs, o: { stage?: string; provenance?: string; kind?: string; frontmatter?: object; role?: string } = {}) {
    if (o.role) await admin.query("UPDATE account_members SET role = $3 WHERE account_id = $1 AND user_id = $2", [a.accountId, a.userId, o.role]);
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', $4, $5, $6)", [id, a.accountId, a.repoId, o.provenance ?? "internal", o.stage ?? "spec_ready", nextNumber++]);
    const discussion = randomUUID();
    await admin.query("INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, $4, 't', $5, 'internal', 'user')", [discussion, a.accountId, nextDiscussion++, o.kind ?? "feature", id]);
    await admin.query("UPDATE work_items SET discussion_id = $1 WHERE id = $2", [discussion, id]);
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind, frontmatter) VALUES ($1, $2, 1, 'spec', $3, 'system', $4::jsonb)", [a.accountId, id, createHash("sha256").update("spec").digest("hex"), JSON.stringify(o.frontmatter ?? {})]);
    return id;
  }
  async function action(a: SeedRefs, workItemId: string, kind = "respec_work_item"): Promise<string> {
    const row = await withTenant(appPool, a.accountId, a.userId, undefined, async (c) => (await c.query("SELECT * FROM run_action_request($1, $2, NULL, $3)", [kind, workItemId, "h".repeat(64)])).rows[0]);
    expect(await createRunActionFacade(writerPool, {} as never).claimRunAction(row.action_id, 600)).not.toBeNull();
    return row.action_id;
  }
  async function run(a: SeedRefs, workItemId: string, status: string, role = "project-manager", envelope?: object): Promise<string> {
    const { id } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: a.accountId, workItemId, role: role as never, runtime: "production", executionMode: "sandbox", dispatchRepoId: a.repoId });
    if (status === "pending") return id;
    await writeRunStatus(writerPool, { accountId: a.accountId, runId: id, from: "pending", to: "running" });
    if (status !== "running") await writeRunStatus(writerPool, { accountId: a.accountId, runId: id, from: "running", to: status as "succeeded", ...(envelope ? { result: { envelope } } : {}) } as never);
    return id;
  }

  it.each(["spec_ready", "needs_human"])("at %s with a Spec that has no list it starts the workflow in Re-spec mode, pinned to the newest Spec, with the project manager's seat checked first", async (stage) => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a, { stage });
    const t = build();
    expect(await t.module.performRespecWorkItem(await action(a, w))).toEqual({ result: "done", outcome: { work_item_id: w, advance: "started" } });
    expect(t.started).toHaveLength(1);
    expect(t.started[0]).toMatchObject({ accountId: a.accountId, workItemId: w, specVersion: 1, respec: true, haltEpoch: 0 });
    expect(t.resolveRunSeat.mock.calls[0]![0].role).toBe("project-manager");
  });

  it.each([
    ["a Spec that already has a readable list", { frontmatter: { acceptance_files: ["src/**"] } }, "spec_has_file_list"],
    ["an item at in_progress", { stage: "in_progress" }, "not_advanceable"],
    ["a question (never built)", { kind: "question" }, "not_advanceable"],
    ["an external item", { provenance: "external" }, "external_requires_human"],
  ] as const)("%s is refused %s and starts nothing", async (_n, o, errorCode) => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a, o);
    const t = build();
    expect(await t.module.performRespecWorkItem(await action(a, w))).toEqual({ result: "refused", errorCode });
    expect(t.started).toEqual([]);
  });

  it("a member is refused, a live run refuses already_running, and an advance_work_item action is not performed as a Re-spec (nor the reverse)", async () => {
    const a = await seedAccount(admin, randomUUID());
    const t = build();
    const asMember = await item(a);
    const lowered = await action(a, asMember);
    await admin.query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2", [a.accountId, a.userId]);
    expect(await t.module.performRespecWorkItem(lowered)).toEqual({ result: "refused", errorCode: "principal_not_authorised" });
    await admin.query("UPDATE account_members SET role = 'owner' WHERE account_id = $1 AND user_id = $2", [a.accountId, a.userId]);
    const busy = await item(a);
    await run(a, busy, "running");
    expect(await t.module.performRespecWorkItem(await action(a, busy))).toEqual({ result: "refused", errorCode: "already_running" });
    const w = await item(a);
    expect(await t.module.performRespecWorkItem(await action(a, w, "advance_work_item"))).toEqual({ result: "refused", errorCode: "kind_mismatch" });
    expect(await t.module.performAdvanceWorkItem(await action(a, await item(a), "respec_work_item"))).toEqual({ result: "refused", errorCode: "kind_mismatch" });
    expect(t.started).toEqual([]);
  });

  it("a request for a missing seat is refused with the seat's reason and records no build_refused fact", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const t = build({ resolveRunSeat: vi.fn(async () => ({ ok: false, reason: "no_model" })) as never });
    expect(await t.module.performRespecWorkItem(await action(a, w))).toEqual({ result: "refused", errorCode: "no_model" });
    expect((await admin.query("SELECT 1 FROM work_item_driver_events WHERE work_item_id = $1", [w])).rowCount).toBe(0);
  });

  describe("advanceRespec", () => {
    const who = (a: SeedRefs, workItemId: string): AdvanceStepWho => ({ accountId: a.accountId, userId: a.userId, workItemId, haltEpoch: 0 });

    it("hands the finished project-manager run's envelope and the pinned version to the pipeline, and answers its version", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const runId = await run(a, w, "succeeded", "project-manager", { acceptance_files: ["src/a.ts"] });
      const respec = vi.fn(async () => ({ status: "published", version: 2 }));
      const t = build({ respec });
      expect(await t.module.advanceRespec(who(a, w), runId, randomUUID(), 1)).toEqual({ status: "published", reason: null, version: 2 });
      expect(respec).toHaveBeenCalledWith(expect.anything(), a.accountId, w, { acceptance_files: ["src/a.ts"] }, 1);
    });

    it("an unreadable list is refused invalid_file_scope and recorded as the fact respec_list_unreadable, once per press", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const runId = await run(a, w, "succeeded", "project-manager", { acceptance_files: [] });
      const t = build({ respec: async () => ({ status: "refused", reason: "invalid_file_scope" }) });
      const press = randomUUID();
      for (let i = 0; i < 2; i++) expect(await t.module.advanceRespec(who(a, w), runId, press, 1)).toEqual({ status: "refused", reason: "invalid_file_scope", version: null });
      const { rows } = await admin.query("SELECT kind, code FROM work_item_driver_events WHERE work_item_id = $1", [w]);
      expect(rows).toEqual([{ kind: "stopped", code: "respec_list_unreadable" }]);
    });

    it("refuses a run that is not a succeeded project-manager run of this item, and does nothing without the pipeline step", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const respec = vi.fn(async () => ({ status: "published", version: 2 }));
      const t = build({ respec });
      const failed = await run(a, w, "failed");
      const executor = await run(a, w, "succeeded", "executor");
      for (const id of [failed, executor, randomUUID()]) expect(await t.module.advanceRespec(who(a, w), id, randomUUID(), 1)).toMatchObject({ status: "refused", reason: "run_not_usable" });
      expect(respec).not.toHaveBeenCalled();
      expect(await build().module.advanceRespec(who(a, w), failed, randomUUID(), 1)).toMatchObject({ status: "refused", reason: "respec_unavailable" });
    });

    it("a replay after the new version was published publishes nothing more", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const runId = await run(a, w, "succeeded", "project-manager", { acceptance_files: ["src/a.ts"] });
      await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind, frontmatter) VALUES ($1, $2, 2, 'spec', $3, 'system', $4::jsonb)", [a.accountId, w, createHash("sha256").update("spec").digest("hex"), JSON.stringify({ acceptance_files: ["src/a.ts"] })]);
      const respec = vi.fn();
      expect(await build({ respec }).module.advanceRespec(who(a, w), runId, randomUUID(), 1)).toEqual({ status: "published", reason: null, version: 2 });
      expect(respec).not.toHaveBeenCalled();
    });
  });
});
