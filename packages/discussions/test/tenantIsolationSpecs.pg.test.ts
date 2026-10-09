import { describe, expect, it } from "vitest";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedTenant, ctxFor, seedWorkItemAt, seedRunOn } from "./helpers/kit.js";
import { publishSpec, addCorrection, specAsOf, correctionsSince } from "../src/specs.js";
import { setStage } from "../src/stages.js";
import { addDependency, removeDependency } from "../src/deps.js";
import type { Principal } from "../src/principals.js";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";

/** SECURITY: "Prove cross-tenant isolation LIVE with two tenants" for the
 * PR-b surface. Two seeded accounts on the same app_user pool; every
 * assertion here rests on RLS and the composite FKs, not on any check in
 * this package. B uses its strongest principals (owner and system). */
describe("cross-tenant isolation: Specs, corrections, stages, deps [pg]", () => {
  const db = pgHarness();
  const ctx = (p: Principal) => ctxFor(db.appUserPool, p);

  async function snapshotOf(accountId: string) {
    const out: Record<string, unknown[]> = {};
    for (const table of ["work_items", "work_item_transitions", "spec_versions", "spec_corrections", "work_item_deps", "domain_events", "discussion_counters"]) {
      const { rows } = await db.admin.query(`SELECT * FROM ${table} WHERE account_id = $1 ORDER BY 1, 2`, [accountId]);
      out[table] = rows;
    }
    return out;
  }

  it("tenant B cannot publish, correct, read, restage or re-wire tenant A's work items -- every attempt is NotFoundError and A's rows are byte-identical afterwards", async () => {
    const a = await seedTenant(db.admin);
    const b = await seedTenant(db.admin);

    const wiA = await seedWorkItemAt(db.admin, a.accountId, "triaged");
    const wiA2 = await seedWorkItemAt(db.admin, a.accountId, "in_progress");
    const specA = await publishSpec(ctx(a.owner), { workItemId: wiA, acceptanceFiles: ["src/**"], body: "A's Spec" });
    await addCorrection(ctx(a.owner), { workItemId: wiA, body: "A's correction" });
    await addDependency(ctx(a.owner), { workItemId: wiA, dependsOnId: wiA2 });
    const runA = await seedRunOn(db.admin, a.accountId, wiA, { specVersionId: specA.id });

    const before = await snapshotOf(a.accountId);
    for (const p of [b.owner, b.system]) {
      await expect(publishSpec(ctx(p), { workItemId: wiA, acceptanceFiles: ["src/**"], body: "hijack" })).rejects.toBeInstanceOf(NotFoundError);
      await expect(addCorrection(ctx(p), { workItemId: wiA, body: "hijack" })).rejects.toBeInstanceOf(NotFoundError);
      await expect(specAsOf(ctx(p), { runId: runA.runId })).rejects.toBeInstanceOf(NotFoundError);
      await expect(correctionsSince(ctx(p), { runId: runA.runId })).rejects.toBeInstanceOf(NotFoundError);
      await expect(setStage(ctx(p), { workItemId: wiA2, toStage: "pr_opened" })).rejects.toBeInstanceOf(NotFoundError);
      await expect(addDependency(ctx(p), { workItemId: wiA2, dependsOnId: wiA })).rejects.toBeInstanceOf(NotFoundError);
      await expect(removeDependency(ctx(p), { workItemId: wiA, dependsOnId: wiA2 })).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(await snapshotOf(a.accountId)).toEqual(before);
  });

  it("B cannot reach A through B's own Spec: appliesTo naming A's work item is invalid_input, and a B work item cannot depend on A's", async () => {
    const a = await seedTenant(db.admin);
    const b = await seedTenant(db.admin);
    const wiA = await seedWorkItemAt(db.admin, a.accountId, "triaged");
    const wiB = await seedWorkItemAt(db.admin, b.accountId, "triaged");
    await publishSpec(ctx(b.owner), { workItemId: wiB, acceptanceFiles: ["src/**"], body: "B's Spec" });

    await expect(addCorrection(ctx(b.owner), { workItemId: wiB, body: "c", appliesTo: [wiA] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(addDependency(ctx(b.owner), { workItemId: wiB, dependsOnId: wiA })).rejects.toBeInstanceOf(NotFoundError);
    const { rows } = await db.admin.query(`SELECT count(*) AS n FROM spec_corrections WHERE account_id = $1`, [b.accountId]);
    expect(Number(rows[0].n)).toBe(0);
  });

  it("a run principal from tenant A cannot read tenant B's Spec, and the same run id smuggled under B's account finds no run", async () => {
    const a = await seedTenant(db.admin);
    const b = await seedTenant(db.admin);
    const wiA = await seedWorkItemAt(db.admin, a.accountId, "triaged");
    const wiB = await seedWorkItemAt(db.admin, b.accountId, "triaged");
    const specB = await publishSpec(ctx(b.owner), { workItemId: wiB, acceptanceFiles: ["src/**"], body: "B's Spec" });
    const runA = await seedRunOn(db.admin, a.accountId, wiA);
    const runB = await seedRunOn(db.admin, b.accountId, wiB, { specVersionId: specB.id });

    await expect(specAsOf(ctx(runA), { runId: runB.runId })).rejects.toBeInstanceOf(NotFoundError);
    const forged: Principal = { kind: "run", accountId: b.accountId, runId: runA.runId };
    await expect(specAsOf(ctx(forged), { runId: runB.runId })).rejects.toBeInstanceOf(NotFoundError);
    await expect(correctionsSince(ctx(runA), { runId: runB.runId })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("both tenants version their Specs and number their corrections independently", async () => {
    const a = await seedTenant(db.admin);
    const b = await seedTenant(db.admin);
    const wiA = await seedWorkItemAt(db.admin, a.accountId, "triaged");
    const wiB = await seedWorkItemAt(db.admin, b.accountId, "triaged");
    await publishSpec(ctx(a.owner), { workItemId: wiA, acceptanceFiles: ["src/**"], body: "a1" });
    await publishSpec(ctx(a.owner), { workItemId: wiA, acceptanceFiles: ["src/**"], body: "a2" });
    const vB = await publishSpec(ctx(b.owner), { workItemId: wiB, acceptanceFiles: ["src/**"], body: "b1" });
    const cA = await addCorrection(ctx(a.owner), { workItemId: wiA, body: "ca" });
    const cB = await addCorrection(ctx(b.owner), { workItemId: wiB, body: "cb" });
    expect(vB.version).toBe(1);
    expect([cA.code, cB.code]).toEqual(["C1", "C1"]);
  });
});
