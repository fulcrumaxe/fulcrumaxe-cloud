import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedTenant, ctxFor, seedWorkItemAt } from "./helpers/kit.js";
import { amendSpec, publishSpec } from "../src/specs.js";

/** [pg] D#483 S5-b2d-2b-0 (C29-0-4): an item with a planned PR key never stores a Planned PRs table, so an approval on a follow-up child can never create grandchildren. */
describe("specs.ts: a follow-up child never stores a Planned PRs table [pg]", () => {
  const db = pgHarness();

  it("an amendment cannot carry a stored table forward onto a keyed item", async () => {
    const t = await seedTenant(db.admin);
    const ownerId = (t.owner as { userId: string }).userId;
    const parent = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    await db.admin.query(`INSERT INTO work_item_approvals (account_id, work_item_id, approved_by, source) VALUES ($1, $2, $3, 'work_item_approve')`, [t.accountId, parent, ownerId]);
    const followUp = (await db.admin.query(
      `INSERT INTO work_item_follow_ups (account_id, work_item_id, source_role, title, why, title_key, disposition) VALUES ($1, $2, 'code-reviewer', 'Add a retry', 'why', $3, 'child') RETURNING id`,
      [t.accountId, parent, randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")],
    )).rows[0].id as string;
    const client = await db.appUserPool.connect();
    let child: string;
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)`, [t.accountId, ownerId]);
      child = (await client.query(`SELECT o_child_id FROM follow_up_child_create($1)`, [followUp])).rows[0].o_child_id as string;
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    await db.admin.query(`UPDATE work_items SET stage = 'spec_ready' WHERE id = $1`, [child]);
    const body = "Spec v1";
    await db.admin.query(
      `INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind, frontmatter) VALUES ($1, $2, 1, $3, $4, 'agent', $5::jsonb)`,
      [t.accountId, child, body, createHash("sha256").update(body).digest("hex"), JSON.stringify({ acceptance_files: ["src/**"], planned_prs: [{ key: "a", title: "A", depends_on: [] }, { key: "b", title: "B", depends_on: [] }] })],
    );
    await expect(amendSpec(ctxFor(db.appUserPool, t.owner), { workItemId: child, body: "Spec v1\n\nAmended", basedOnVersion: 1, correctionIds: [randomUUID()] })).rejects.toMatchObject({ code: "invalid_planned_prs" });
    expect((await db.admin.query(`SELECT 1 FROM spec_versions WHERE work_item_id = $1`, [child])).rowCount).toBe(1);
  });

  it("its Spec is stored, but a table on it is refused invalid_planned_prs and writes nothing; a top-level item's table is stored as before", async () => {
    const t = await seedTenant(db.admin);
    const ownerId = (t.owner as { userId: string }).userId;
    const parent = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    await db.admin.query(`INSERT INTO work_item_approvals (account_id, work_item_id, approved_by, source) VALUES ($1, $2, $3, 'work_item_approve')`, [t.accountId, parent, ownerId]);
    const followUp = (await db.admin.query(
      `INSERT INTO work_item_follow_ups (account_id, work_item_id, source_role, title, why, title_key, disposition) VALUES ($1, $2, 'code-reviewer', 'Add a retry', 'why', $3, 'child') RETURNING id`,
      [t.accountId, parent, randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")],
    )).rows[0].id as string;
    const client = await db.appUserPool.connect();
    let child: string;
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)`, [t.accountId, ownerId]);
      child = (await client.query(`SELECT o_child_id FROM follow_up_child_create($1)`, [followUp])).rows[0].o_child_id as string;
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const table = [{ key: "a", title: "A", depends_on: [] }, { key: "b", title: "B", depends_on: [] }];
    const ctx = ctxFor(db.appUserPool, t.system);
    await expect(publishSpec(ctx, { workItemId: child, acceptanceFiles: ["src/**"], body: "Spec", plannedPrs: table })).rejects.toMatchObject({ code: "invalid_planned_prs" });
    expect((await db.admin.query(`SELECT 1 FROM spec_versions WHERE work_item_id = $1`, [child])).rowCount).toBe(0);
    const stored = await publishSpec(ctx, { workItemId: child, acceptanceFiles: ["src/**"], body: "Spec" });
    expect(stored.version).toBe(1);
    const top = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    await publishSpec(ctx, { workItemId: top, acceptanceFiles: ["src/**"], body: "Spec", plannedPrs: table });
    expect((await db.admin.query(`SELECT frontmatter -> 'planned_prs' AS p FROM spec_versions WHERE work_item_id = $1`, [top])).rows[0].p).toHaveLength(2);
  });
});
