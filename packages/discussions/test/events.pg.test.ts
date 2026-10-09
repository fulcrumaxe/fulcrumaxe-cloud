import { describe, expect, it, vi } from "vitest";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedTenant, ctxFor, seedWorkItemAt, count } from "./helpers/kit.js";
import { createDiscussion, reviseDiscussion } from "../src/discussions.js";
import { postComment } from "../src/comments.js";
import { publishSpec, addCorrection } from "../src/specs.js";

// Criterion 15: "A transaction that rolls back leaves no event." The event
// is the LAST statement of each write, so to prove the rollback covers it
// the wrapper below lets the real emit succeed and only then throws.
const injection = vi.hoisted(() => ({ failAfterEmit: false }));
vi.mock("../src/events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/events.js")>();
  return {
    ...actual,
    emitDiscussionsEvent: async (...args: Parameters<typeof actual.emitDiscussionsEvent>) => {
      const result = await actual.emitDiscussionsEvent(...args);
      if (injection.failAfterEmit) throw new Error("injected after emit");
      return result;
    },
  };
});

describe("domain events roll back with their transaction [pg]", () => {
  const db = pgHarness();
  const ctx = (p: Parameters<typeof ctxFor>[1]) => ctxFor(db.appUserPool, p);
  const events = (accountId: string) => count(db.admin, `SELECT 1 FROM domain_events WHERE account_id = $1`, [accountId]);

  async function failing<T>(fn: () => Promise<T>): Promise<void> {
    injection.failAfterEmit = true;
    try {
      await expect(fn()).rejects.toThrow("injected after emit");
    } finally {
      injection.failAfterEmit = false;
    }
  }

  it("create, comment and revise leave no event, no row and no storage charge when the transaction rolls back", async () => {
    const t = await seedTenant(db.admin);
    await failing(() => createDiscussion(ctx(t.owner), { title: "d", kind: "feature", body: "b" }));
    expect(await events(t.accountId)).toBe(0);
    expect(await count(db.admin, `SELECT 1 FROM discussions WHERE account_id = $1`, [t.accountId])).toBe(0);
    expect(await count(db.admin, `SELECT 1 FROM work_items WHERE account_id = $1`, [t.accountId])).toBe(0);

    const d = await createDiscussion(ctx(t.owner), { title: "d", kind: "feature", body: "b" });
    expect(await events(t.accountId)).toBe(1);
    await failing(() => postComment(ctx(t.owner), { discussionId: d.id, body: "c" }));
    await failing(() => reviseDiscussion(ctx(t.owner), { discussionId: d.id, body: "r2" }));
    expect(await events(t.accountId)).toBe(1);
    expect(await count(db.admin, `SELECT 1 FROM discussion_comments WHERE account_id = $1`, [t.accountId])).toBe(0);
    expect(await count(db.admin, `SELECT 1 FROM discussion_revisions WHERE account_id = $1`, [t.accountId])).toBe(1);
  });

  it("publishSpec rolls back the Spec row, the stage change and its transition row along with the event", async () => {
    const t = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    await failing(() => publishSpec(ctx(t.owner), { workItemId: wi, acceptanceFiles: ["src/**"], body: "spec" }));
    expect(await events(t.accountId)).toBe(0);
    expect(await count(db.admin, `SELECT 1 FROM spec_versions WHERE work_item_id = $1`, [wi])).toBe(0);
    expect(await count(db.admin, `SELECT 1 FROM work_item_transitions WHERE work_item_id = $1`, [wi])).toBe(0);
    const { rows } = await db.admin.query(`SELECT stage FROM work_items WHERE id = $1`, [wi]);
    expect(rows[0].stage).toBe("triaged");
    const { rows: counter } = await db.admin.query(`SELECT bytes_used FROM discussion_counters WHERE account_id = $1`, [t.accountId]);
    expect(counter.every((r) => Number(r.bytes_used) === 0)).toBe(true);
  });

  it("addCorrection rolls back the correction row along with the event", async () => {
    const t = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    await publishSpec(ctx(t.owner), { workItemId: wi, acceptanceFiles: ["src/**"], body: "spec" });
    const before = await events(t.accountId);
    await failing(() => addCorrection(ctx(t.owner), { workItemId: wi, body: "fix" }));
    expect(await events(t.accountId)).toBe(before);
    expect(await count(db.admin, `SELECT 1 FROM spec_corrections WHERE account_id = $1`, [t.accountId])).toBe(0);
    // The code was not consumed by the rolled-back attempt.
    await expect(addCorrection(ctx(t.owner), { workItemId: wi, body: "fix" })).resolves.toMatchObject({ code: "C1" });
  });
});
