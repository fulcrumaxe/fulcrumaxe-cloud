import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBuildForItem } from "@fx/pipeline/testing/build";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { publishLightSpec } from "../../pipeline/src/advance/lightSpec.js";
import type { AdvanceRunPorts } from "../../pipeline/src/advance/runPorts.js";
import { runTriageStep } from "../../pipeline/src/plan/step.js";
import { OWNER, fixtureClassifier } from "../../pipeline/test/plan/helpers/panelFixtures.js";
import { createAdvanceModule } from "../src/advance.js";

/**
 * D#483 S5-b2b / A-S5-8 [pg]: a short Spec that plans two or more pull requests waits at Spec ready for a person's approval, which is what creates the children; the
 * parent itself never runs an executor. The Spec is published by the REAL `publishLightSpec` through the worker's REAL `advanceLightSpec`, the approval is the function the
 * approve route calls (`work_item_approval_record`), and the build start is the real `startBuildForItem`. No approval or child row is inserted by hand.
 */
describe("a short Spec that plans several pull requests waits for the person's approval [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  let nextNumber = 9700;

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

  const ROWS = [
    { key: "page-a", title: "Docs page A", depends_on: [] },
    { key: "page-b", title: "Docs page B", depends_on: [] },
  ];
  const ONE = { feasible: true, reason: "", split_proposed: false, summary: "Fix the year.", spec: "1. The footer shows the year.\n2. A test pins it.", acceptance_files: ["src/a.ts"] };
  const SPLIT = { ...ONE, summary: "Two independent pages.", acceptance_files: ["docs/a.md", "docs/b.md"], split_proposed: true, planned_prs: ROWS };

  async function triaged(): Promise<{ a: SeedRefs; workItemId: string }> {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
    const t = await runTriageStep(
      { pool: writerPool, accountId: a.accountId, classifier: fixtureClassifier("doc") },
      { mode: "new", event: { ...OWNER, body: "Document both pages." }, title: "Docs pages", sourceEventId: randomUUID(), repoId: a.repoId },
    );
    if (t.status !== "triaged") throw new Error(`fixture: ${JSON.stringify(t)}`);
    await admin.query("UPDATE work_items SET gh_number = $2, repo_id = $3 WHERE id = $1", [t.workItemId, nextNumber++, a.repoId]);
    return { a, workItemId: t.workItemId };
  }

  /** The workflow's publish step: the PM's finished run holds `output`; the worker publishes it with the pipeline's real short-Spec publisher. */
  async function publishVia(a: SeedRefs, workItemId: string, output: unknown) {
    const run = randomUUID();
    await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, envelope) VALUES ($1, $2, $3, 'project-manager', 'production', 'succeeded', $4::jsonb)", [run, a.accountId, workItemId, JSON.stringify(output)]);
    const m = createAdvanceModule(writerPool, { starter: null as never, resolveRunSeat: null as never, startAdvance: async () => undefined, triage: null, registry: {} as never, lightSpec: publishLightSpec });
    const action = randomUUID();
    const who = { accountId: a.accountId, userId: a.userId, workItemId, haltEpoch: 0 };
    const first = await m.advanceLightSpec(who, run, action);
    return { first, replay: await m.advanceLightSpec(who, run, action) };
  }

  const stageOf = async (id: string) => (await admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [id])).rows[0]!.stage;
  const kidsOf = async (id: string) => (await admin.query<{ planned_pr_key: string }>("SELECT planned_pr_key FROM work_items WHERE parent_id = $1 ORDER BY planned_pr_key", [id])).rows.map((r) => r.planned_pr_key);
  const executorRuns = async (id: string) => Number((await admin.query<{ n: string }>("SELECT count(*) AS n FROM agent_runs WHERE work_item_id = $1 AND role = 'executor'", [id])).rows[0]!.n);
  const noStart: AdvanceRunPorts = {
    startRun: async () => {
      throw new Error("an executor run was started");
    },
    outcome: async () => {
      throw new Error("unused");
    },
    cancel: async () => undefined,
  };

  it("a split Spec reports the split (and its replay does too); nothing is built and no child exists until a person approves the Spec", async () => {
    const { a, workItemId } = await triaged();
    const { first, replay } = await publishVia(a, workItemId, SPLIT);
    expect(first).toEqual({ status: "published", reason: null, version: 1, split: true });
    expect(replay).toEqual(first);
    expect(await stageOf(workItemId)).toBe("spec_ready");
    expect(await kidsOf(workItemId)).toEqual([]);
    expect(await executorRuns(workItemId)).toBe(0);
    expect((await admin.query("SELECT 1 FROM work_item_approvals WHERE work_item_id = $1", [workItemId])).rows).toEqual([]);

    // The approve route's own call: the person's approval of the Spec version creates the children.
    await withTenant(appPool, a.accountId, a.userId, (c) => c.query("SELECT 1 FROM work_item_approval_record($1::uuid, 'work_item_approve')", [workItemId]));
    expect(await kidsOf(workItemId)).toEqual(["page-a", "page-b"]);

    // The workflow's load of the approved parent says it splits, so it ends without asking for a build.
    expect(await createAdvanceModule(writerPool, { starter: null as never, resolveRunSeat: null as never, startAdvance: async () => undefined, triage: null, registry: {} as never }).advanceLoadItem(a.accountId, workItemId)).toMatchObject({ stage: "spec_ready", splits: true });

    // Should anything still ask for the parent's build (the backstop), the request for the build of the parent: refused, and no executor ever runs for the parent.
    const out = await startBuildForItem(writerPool, a.accountId, workItemId, randomUUID(), noStart);
    expect(out).toMatchObject({ status: "refused", reason: "parent_splits" });
    expect(await executorRuns(workItemId)).toBe(0);
    expect(await stageOf(workItemId)).toBe("spec_ready");
    expect(await kidsOf(workItemId)).toEqual(["page-a", "page-b"]);
  });

  it("startBuild refuses a parent with parent_splits even before any approval exists, and starts nothing", async () => {
    const { a, workItemId } = await triaged();
    await publishVia(a, workItemId, SPLIT);
    expect(await startBuildForItem(writerPool, a.accountId, workItemId, randomUUID(), noStart)).toMatchObject({ status: "refused", reason: "parent_splits" });
    expect(await executorRuns(workItemId)).toBe(0);
  });

  it("a single-PR Spec carries no split flag, so the workflow goes on to build it, and startBuild does not refuse it as a parent", async () => {
    const { a, workItemId } = await triaged();
    const { first, replay } = await publishVia(a, workItemId, ONE);
    expect(first).toEqual({ status: "published", reason: null, version: 1 });
    expect(replay).toEqual(first);
    expect(await kidsOf(workItemId)).toEqual([]);
    expect(await createAdvanceModule(writerPool, { starter: null as never, resolveRunSeat: null as never, startAdvance: async () => undefined, triage: null, registry: {} as never }).advanceLoadItem(a.accountId, workItemId)).not.toHaveProperty("splits");
    // Whatever else the start does with this fixture, it is not the split refusal.
    const out = await startBuildForItem(writerPool, a.accountId, workItemId, randomUUID(), noStart).catch((e: unknown) => ({ status: "threw", reason: String(e) }));
    expect(out).not.toMatchObject({ reason: "parent_splits" });
  });
});
