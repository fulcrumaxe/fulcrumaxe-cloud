import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sanitize } from "@fx/trust";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { addSpec, plannedFixture, row, type PlannedFixture } from "@fx/db/test/helpers/plannedChildren.js";
import { startBuildForItem } from "../src/advance/buildTesting.js";
import type { AdvanceRunOutcome, AdvanceRunPorts, AdvanceRunRequest, AdvanceRunStart } from "../src/advance/runPorts.js";
import { publishLightSpec } from "../src/advance/lightSpec.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * [pg] D#483 S5-b2d-2b (the review points on build.ts, C29-2b-3 and C29-2b-4): a follow-up child builds only after its launch (the parent's envelope on the child) and
 * only from its own short Spec; it never builds from `triaged`, a Spec that plans two or more pull requests stops it as `follow_up_too_large`, and its prompt and pull
 * request text name the follow-up (fenced as data) and `Refs #<parent>`. The fixture is made by the real definers.
 */
const h = pgHarness();
const PARENT_NUMBER = 41;

class World implements AdvanceRunPorts {
  readonly requests: AdvanceRunRequest[] = [];
  private readonly byStep = new Map<string, string>();
  constructor(private readonly accountId: string, private readonly workItemId: string) {}
  async startRun(req: AdvanceRunRequest): Promise<AdvanceRunStart> {
    this.requests.push(req);
    const known = this.byStep.get(req.step);
    if (known) return { ok: true, runId: known };
    const id = randomUUID();
    await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, spec_version_id) VALUES ($1, $2, $3, $4, 'production', 'running', $5)`, [id, this.accountId, this.workItemId, req.role, req.specVersionId ?? null]);
    this.byStep.set(req.step, id);
    return { ok: true, runId: id };
  }
  async findStep(prefix: string): Promise<{ step: string; runId: string } | null> {
    for (const [step, runId] of this.byStep) if (step === prefix) return { step, runId };
    return null;
  }
  async outcome(): Promise<AdvanceRunOutcome> {
    return { status: "running", done: false, envelope: null };
  }
  async cancel(): Promise<void> {}
}

interface Fu { f: PlannedFixture; child: string; key: string; followUp: string; world: World }

/** An approved parent (issue 41) and a follow-up child made by the real definer; `launched` leaves the child the way the launch does (the parent's envelope), `spec` gives it its own short Spec at Spec ready. */
async function fu(o: { launched?: boolean; spec?: boolean; title?: string } = {}): Promise<Fu> {
  const f = await plannedFixture(h.admin, h.pureAppUserPool, { dial: null, weeklyUsd: null, table: [] });
  await h.admin.query("UPDATE repos SET gh_owner = 'customer-co', gh_name = 'storefront' WHERE id = $1", [f.t.repoId]);
  await h.admin.query("UPDATE work_items SET gh_number = $2 WHERE id = $1", [f.parent, PARENT_NUMBER]);
  const followUp = (await h.admin.query<{ id: string }>(
    `INSERT INTO work_item_follow_ups (account_id, work_item_id, source_role, title, why, title_key, disposition) VALUES ($1, $2, 'code-reviewer', $3, 'why', $4, 'child') RETURNING id`,
    [f.t.accountId, f.parent, o.title ?? "Add a retry", randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")])).rows[0]!.id;
  const child = await withTenant(h.pureAppUserPool, f.t.accountId, f.t.userId, async (c) => (await c.query<{ o_child_id: string }>("SELECT * FROM follow_up_child_create($1)", [followUp])).rows[0]!.o_child_id);
  const key = (await h.admin.query<{ planned_pr_key: string }>("SELECT planned_pr_key FROM work_items WHERE id = $1", [child])).rows[0]!.planned_pr_key;
  if (o.launched !== false) await h.admin.query("UPDATE work_items SET envelope_id = (SELECT envelope_id FROM work_items WHERE id = $2) WHERE id = $1", [child, f.parent]);
  if (o.spec !== false) {
    await addSpec(h.admin, f.t, child, 1);
    await h.admin.query("UPDATE work_items SET stage = 'spec_ready' WHERE id = $1", [child]);
  }
  return { f, child, key, followUp, world: new World(f.t.accountId, child) };
}
const start = (k: Fu, options: { expectedVersion?: number } = {}) => startBuildForItem(h.runWriterPool, k.f.t.accountId, k.child, randomUUID(), k.world, options);
const runs = async (k: Fu) => (await h.admin.query("SELECT 1 FROM agent_runs WHERE work_item_id = $1", [k.child])).rowCount;

describe("a follow-up child's build [pg]", { timeout: 60_000 }, () => {
  it("builds from its own Spec on fx/<parent#>-fu-<hex>: the prompt names the follow-up (title fenced as data) and Refs the parent, and never says 'planned PR'", async () => {
    const k = await fu({ title: "Add a retry to the sync" });
    const out = await start(k);
    expect(out).toMatchObject({ status: "started", branch: `fx/${PARENT_NUMBER}-${k.key}` });
    const prompt = k.world.requests[0]!.prompt!;
    expect(prompt).toContain(`fx/${PARENT_NUMBER}-${k.key}`);
    expect(prompt).toContain("Build only this follow-up");
    expect(prompt).toContain(sanitize("Follow-up: Add a retry to the sync"));
    expect(prompt).toContain(`Refs #${PARENT_NUMBER}`);
    expect(prompt).toContain("a follow-up raised on the issue");
    expect(prompt).not.toMatch(/planned PR/i);
    expect(prompt).not.toMatch(/(Closes|Fixes|Resolves) #/i);
    expect(prompt).not.toContain("fx/issue-");
    expect(k.world.requests[0]!.specVersionId).toBeTruthy();
    expect((await h.admin.query("SELECT stage FROM work_items WHERE id = $1", [k.child])).rows[0].stage).toBe("in_progress");
  });

  it("point 2: it cannot build without its launch (no envelope on the child), without a Spec, or from Triaged", async () => {
    const noLaunch = await fu({ launched: false });
    expect(await start(noLaunch)).toMatchObject({ status: "refused", reason: "parent_no_envelope" });
    const noSpec = await fu({ spec: false });
    expect(await start(noSpec)).toMatchObject({ status: "refused", reason: "no_spec" });
    // a child at Triaged that somehow holds a Spec still does not build: a planned child's Triaged entry is not a follow-up child's
    const triaged = await fu();
    await h.admin.query("UPDATE work_items SET stage = 'triaged' WHERE id = $1", [triaged.child]);
    expect(await start(triaged)).toMatchObject({ status: "refused", reason: "stage_triaged" });
    for (const k of [noLaunch, noSpec, triaged]) expect(await runs(k)).toBe(0);
  });

  it("point 2: a re-specced parent, a closed parent and a follow-up row that no longer names the child each stop the build with their code", async () => {
    const respec = await fu();
    await addSpec(h.admin, respec.f.t, respec.f.parent, 2, []);
    expect(await start(respec)).toMatchObject({ status: "refused", reason: "respec_needs_approval" });
    const closed = await fu();
    await h.admin.query("UPDATE work_items SET stage = 'closed' WHERE id = $1", [closed.f.parent]);
    expect(await start(closed)).toMatchObject({ status: "refused", reason: "parent_closed" });
    const orphan = await fu();
    await h.admin.query("UPDATE work_item_follow_ups SET child_id = NULL WHERE id = $1", [orphan.followUp]);
    expect(await start(orphan)).toMatchObject({ status: "refused", reason: "child_orphaned" });
    for (const k of [respec, closed, orphan]) expect(await runs(k)).toBe(0);
  });

  it("the Spec version a build was approved for is pinned: a newer one is spec_changed", async () => {
    const k = await fu();
    await addSpec(h.admin, k.f.t, k.child, 2);
    expect(await start(k, { expectedVersion: 1 })).toMatchObject({ status: "refused", reason: "spec_changed" });
    expect(await runs(k)).toBe(0);
  });

  it("point 3 (backstop): a stored Spec that plans two or more pull requests stops the child as follow_up_too_large and never builds", async () => {
    // The store refuses such a table for a keyed item, so it is written by hand here: the build must still refuse it.
    const k = await fu({ spec: false });
    await addSpec(h.admin, k.f.t, k.child, 1, [row("a"), row("b")]);
    await h.admin.query("UPDATE work_items SET stage = 'spec_ready' WHERE id = $1", [k.child]);
    expect(await start(k)).toMatchObject({ status: "refused", reason: "follow_up_too_large" });
    expect(await runs(k)).toBe(0);
  });
});

describe("point 3: a short Spec for a follow-up child that proposes a split stops it [pg]", { timeout: 60_000 }, () => {
  const output = (over: Record<string, unknown>) => ({
    feasible: true, reason: "", summary: "do the thing", spec: "1. do it", acceptance_files: ["src/a.ts"], split_proposed: false, planned_prs: [], ...over,
  });

  it("the real publish (the real store) refuses the split with follow_up_too_large, publishes nothing, and the item stays at Triaged", async () => {
    const k = await fu({ spec: false });
    const split = await publishLightSpec(h.runWriterPool, k.f.t.accountId, k.child, output({ split_proposed: true, planned_prs: [row("a"), row("b")] }));
    expect(split).toEqual({ status: "refused", reason: "follow_up_too_large" });
    expect((await h.admin.query("SELECT 1 FROM spec_versions WHERE work_item_id = $1", [k.child])).rowCount).toBe(0);
    expect((await h.admin.query("SELECT stage FROM work_items WHERE id = $1", [k.child])).rows[0].stage).toBe("triaged");
    expect(await runs(k)).toBe(0);
  });

  it("feasible: false stops it with the reason (C28), and a one-pull-request Spec publishes", async () => {
    const k = await fu({ spec: false });
    expect(await publishLightSpec(h.runWriterPool, k.f.t.accountId, k.child, output({ feasible: false, reason: "The repository has no such module." }))).toEqual({ status: "not_feasible", reason: "The repository has no such module." });
    expect(await publishLightSpec(h.runWriterPool, k.f.t.accountId, k.child, output({}))).toMatchObject({ status: "published", version: 1 });
  });
});
