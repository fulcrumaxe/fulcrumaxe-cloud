import { describe, expect, it } from "vitest";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedTenant, ctxFor, seedWorkItemAt, seedRunOn, count } from "./helpers/kit.js";
import { addDependency, removeDependency } from "../src/deps.js";
import { ForbiddenError, NotFoundError } from "@fx/core/src/tenancy/errors.js";

describe("deps.ts [pg]", () => {
  const db = pgHarness();
  const ctx = (p: Parameters<typeof ctxFor>[1]) => ctxFor(db.appUserPool, p);
  const depCount = (accountId: string) => count(db.admin, `SELECT 1 FROM work_item_deps WHERE account_id = $1`, [accountId]);

  async function items(accountId: string, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push(await seedWorkItemAt(db.admin, accountId, "triaged"));
    return ids;
  }

  it("criterion 9: adds a dependency; a repeat is a no-op; diamonds and chains are not cycles", async () => {
    const t = await seedTenant(db.admin);
    const [a, b, c, d] = await items(t.accountId, 4);
    await addDependency(ctx(t.owner), { workItemId: a!, dependsOnId: b! });
    await addDependency(ctx(t.system), { workItemId: a!, dependsOnId: b! });
    expect(await depCount(t.accountId)).toBe(1);
    await addDependency(ctx(t.admin), { workItemId: a!, dependsOnId: c! });
    await addDependency(ctx(t.owner), { workItemId: b!, dependsOnId: d! });
    await addDependency(ctx(t.owner), { workItemId: c!, dependsOnId: d! });
    expect(await depCount(t.accountId)).toBe(4);
  });

  it("criterion 9: a self-dependency, a 2-cycle and a 3-cycle are dependency_cycle and write no row", async () => {
    const t = await seedTenant(db.admin);
    const [a, b, c] = await items(t.accountId, 3);
    await expect(addDependency(ctx(t.owner), { workItemId: a!, dependsOnId: a! })).rejects.toMatchObject({ code: "dependency_cycle" });
    expect(await depCount(t.accountId)).toBe(0);

    await addDependency(ctx(t.owner), { workItemId: a!, dependsOnId: b! });
    await expect(addDependency(ctx(t.owner), { workItemId: b!, dependsOnId: a! })).rejects.toMatchObject({ code: "dependency_cycle" });
    expect(await depCount(t.accountId)).toBe(1);

    await addDependency(ctx(t.owner), { workItemId: b!, dependsOnId: c! });
    await expect(addDependency(ctx(t.system), { workItemId: c!, dependsOnId: a! })).rejects.toMatchObject({ code: "dependency_cycle" });
    expect(await depCount(t.accountId)).toBe(2);
  });

  it("criterion 9: two concurrent adds that would close a cycle between them cannot both succeed", async () => {
    const t = await seedTenant(db.admin);
    for (let i = 0; i < 5; i++) {
      const [a, b] = await items(t.accountId, 2);
      const results = await Promise.allSettled([
        addDependency(ctx(t.owner), { workItemId: a!, dependsOnId: b! }),
        addDependency(ctx(t.owner), { workItemId: b!, dependsOnId: a! }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ code: "dependency_cycle" });
    }
  });

  it("deps.add and deps.remove are forbidden for member, token and run, and change nothing", async () => {
    const t = await seedTenant(db.admin);
    const [a, b] = await items(t.accountId, 2);
    const run = await seedRunOn(db.admin, t.accountId, a!);
    for (const p of [t.member, t.tokenWrite, run]) {
      await expect(addDependency(ctx(p), { workItemId: a!, dependsOnId: b! })).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await depCount(t.accountId)).toBe(0);
    await addDependency(ctx(t.owner), { workItemId: a!, dependsOnId: b! });
    for (const p of [t.member, t.tokenWrite, run]) {
      await expect(removeDependency(ctx(p), { workItemId: a!, dependsOnId: b! })).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await depCount(t.accountId)).toBe(1);
  });

  it("removeDependency deletes the edge (and re-adding the reverse is then legal); a missing edge is NotFoundError", async () => {
    const t = await seedTenant(db.admin);
    const [a, b] = await items(t.accountId, 2);
    await addDependency(ctx(t.owner), { workItemId: a!, dependsOnId: b! });
    await removeDependency(ctx(t.system), { workItemId: a!, dependsOnId: b! });
    expect(await depCount(t.accountId)).toBe(0);
    await expect(removeDependency(ctx(t.owner), { workItemId: a!, dependsOnId: b! })).rejects.toBeInstanceOf(NotFoundError);
    await addDependency(ctx(t.owner), { workItemId: b!, dependsOnId: a! });
    expect(await depCount(t.accountId)).toBe(1);
  });

  it("cross-tenant: another tenant's work item is NotFoundError on either end, and B cannot remove A's edge", async () => {
    const a = await seedTenant(db.admin);
    const b = await seedTenant(db.admin);
    const [a1, a2] = await items(a.accountId, 2);
    const [b1] = await items(b.accountId, 1);
    await expect(addDependency(ctx(b.owner), { workItemId: b1!, dependsOnId: a1! })).rejects.toBeInstanceOf(NotFoundError);
    await expect(addDependency(ctx(b.owner), { workItemId: a1!, dependsOnId: b1! })).rejects.toBeInstanceOf(NotFoundError);
    await expect(addDependency(ctx(b.owner), { workItemId: a1!, dependsOnId: a2! })).rejects.toBeInstanceOf(NotFoundError);
    await expect(addDependency(ctx(a.owner), { workItemId: a1!, dependsOnId: "not-a-uuid" })).rejects.toBeInstanceOf(NotFoundError);
    expect(await count(db.admin, `SELECT 1 FROM work_item_deps WHERE account_id IN ($1, $2)`, [a.accountId, b.accountId])).toBe(0);

    await addDependency(ctx(a.owner), { workItemId: a1!, dependsOnId: a2! });
    await expect(removeDependency(ctx(b.owner), { workItemId: a1!, dependsOnId: a2! })).rejects.toBeInstanceOf(NotFoundError);
    expect(await depCount(a.accountId)).toBe(1);
  });

  it("criterion 3: account_id/accountId in the input is invalid_input", async () => {
    const t = await seedTenant(db.admin);
    const [a, b] = await items(t.accountId, 2);
    await expect(addDependency(ctx(t.owner), { workItemId: a!, dependsOnId: b!, accountId: t.accountId } as never)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(removeDependency(ctx(t.owner), { workItemId: a!, dependsOnId: b!, account_id: t.accountId } as never)).rejects.toMatchObject({ code: "invalid_input" });
    expect(await depCount(t.accountId)).toBe(0);
  });
});
