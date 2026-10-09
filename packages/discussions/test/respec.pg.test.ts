import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedTenant, ctxFor, seedWorkItemAt, count } from "./helpers/kit.js";
import { publishSpec, respecSpec } from "../src/specs.js";
import { ForbiddenError } from "@fx/core/src/tenancy/errors.js";

/**
 * D#6 R4d-5b (C34 section 2.3, F9 and F11 at the store): `respecSpec` adds version N+1 to a Spec whose newest version has no readable file list,
 * and moves `needs_human -> discussing -> spec_ready` in the same transaction.
 */
describe("respecSpec [pg]", () => {
  const db = pgHarness();
  const ctx = (p: Parameters<typeof ctxFor>[1]) => ctxFor(db.appUserPool, p);
  const LIST = ["src/a.ts", "src/{b,c}.test.ts"];

  /** A Spec written before the file list existed: frontmatter `{}`, as every product row was. Inserted directly, as a pre-fix row. */
  async function seedPreFixSpec(accountId: string, workItemId: string, version: number, body: string): Promise<string> {
    const { rows } = await db.admin.query<{ id: string }>(
      `INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, $3, $4, $5, 'system') RETURNING id`,
      [accountId, workItemId, version, body, createHash("sha256").update(body).digest("hex")],
    );
    return rows[0]!.id;
  }
  const versions = async (wi: string) => (await db.admin.query(`SELECT version, body, frontmatter FROM spec_versions WHERE work_item_id = $1 ORDER BY version`, [wi])).rows;
  const stageOf = async (wi: string) => (await db.admin.query(`SELECT stage FROM work_items WHERE id = $1`, [wi])).rows[0].stage as string;
  const moves = async (wi: string) => (await db.admin.query(`SELECT from_stage, to_stage, source, source_ref FROM work_item_transitions WHERE work_item_id = $1 ORDER BY at, created_at`, [wi])).rows;

  it("F9: from spec_ready it publishes N+1 with the body it was given and frontmatter {acceptance_files: list}, and leaves the stage and the transitions alone", async () => {
    const t = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "spec_ready");
    await seedPreFixSpec(t.accountId, wi, 1, "the Spec the person read\n");

    const v2 = await respecSpec(ctx(t.system), { workItemId: wi, body: "the Spec the person read\n\nplus the list\n", acceptanceFiles: LIST, basedOnVersion: 1 });
    expect(v2.version).toBe(2);
    const rows = await versions(wi);
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[0].frontmatter).toEqual({});
    expect(rows[1]).toMatchObject({ body: "the Spec the person read\n\nplus the list\n", frontmatter: { acceptance_files: LIST } });
    expect(JSON.stringify(rows[1].frontmatter)).toBe(JSON.stringify({ acceptance_files: LIST }));
    expect(await stageOf(wi)).toBe("spec_ready");
    expect(await moves(wi)).toEqual([]);
  });

  it("F9: from needs_human it publishes N+1 and records needs_human -> discussing -> spec_ready in one transaction, each with source spec_version:<id>", async () => {
    const t = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "needs_human");
    await seedPreFixSpec(t.accountId, wi, 1, "spec\n");

    const v2 = await respecSpec(ctx(t.system), { workItemId: wi, body: "spec\n\nlist\n", acceptanceFiles: LIST, basedOnVersion: 1 });
    expect(v2.version).toBe(2);
    expect(await stageOf(wi)).toBe("spec_ready");
    const ref = `spec_version:${v2.id}`;
    expect(await moves(wi)).toEqual([
      { from_stage: "needs_human", to_stage: "discussing", source: "control_plane", source_ref: ref },
      { from_stage: "discussing", to_stage: "spec_ready", source: "control_plane", source_ref: ref },
    ]);
    // One transaction: both transition rows and the version row carry the same transaction clock.
    const { rows } = await db.admin.query(
      `SELECT count(DISTINCT t.created_at) AS n FROM work_item_transitions t JOIN spec_versions s ON s.created_at = t.created_at WHERE t.work_item_id = $1 AND s.id = $2`,
      [wi, v2.id],
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it("F9: an injected failure after the insert, at the second move, leaves the item at needs_human with no N+1 and no transition", async () => {
    const t = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "needs_human");
    await seedPreFixSpec(t.accountId, wi, 1, "spec\n");
    await db.admin.query(`CREATE OR REPLACE FUNCTION fx_respec_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure after the PM output'; END $$`);
    await db.admin.query(`CREATE TRIGGER fx_respec_boom BEFORE INSERT ON work_item_transitions FOR EACH ROW WHEN (NEW.to_stage = 'spec_ready' AND NEW.work_item_id = '${wi}') EXECUTE FUNCTION fx_respec_boom()`);
    try {
      await expect(respecSpec(ctx(t.system), { workItemId: wi, body: "spec\n\nlist\n", acceptanceFiles: LIST, basedOnVersion: 1 })).rejects.toThrow(/injected failure/);
    } finally {
      await db.admin.query(`DROP TRIGGER fx_respec_boom ON work_item_transitions`);
      await db.admin.query(`DROP FUNCTION fx_respec_boom()`);
    }
    expect(await stageOf(wi)).toBe("needs_human");
    expect((await versions(wi)).map((r) => r.version)).toEqual([1]);
    expect(await moves(wi)).toEqual([]);
  });

  it("F11: a Spec whose newest version already has a readable list is spec_has_file_list, and nothing is written", async () => {
    const t = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    await publishSpec(ctx(t.owner), { workItemId: wi, body: "with a list\n", acceptanceFiles: ["src/**"] });
    await expect(respecSpec(ctx(t.system), { workItemId: wi, body: "again\n", acceptanceFiles: LIST, basedOnVersion: 1 })).rejects.toMatchObject({ code: "spec_has_file_list" });
    expect((await versions(wi)).map((r) => r.version)).toEqual([1]);
    expect(await stageOf(wi)).toBe("spec_ready");
  });

  it("refuses a list the done check cannot read (invalid_file_scope), a version the body was not made from (spec_changed), and no Spec (no_spec_version): nothing written, stage unchanged", async () => {
    const t = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "needs_human");
    await seedPreFixSpec(t.accountId, wi, 1, "one\n");
    await seedPreFixSpec(t.accountId, wi, 2, "two\n");
    for (const bad of [[], ["**"], ["../x"], ["a/{b}"], "src/a.ts", undefined]) {
      await expect(respecSpec(ctx(t.system), { workItemId: wi, body: "x\n", acceptanceFiles: bad as never, basedOnVersion: 2 })).rejects.toMatchObject({ code: "invalid_file_scope" });
    }
    await expect(respecSpec(ctx(t.system), { workItemId: wi, body: "x\n", acceptanceFiles: LIST, basedOnVersion: 1 })).rejects.toMatchObject({ code: "spec_changed" });
    await expect(respecSpec(ctx(t.system), { workItemId: wi, body: "x\n", acceptanceFiles: LIST, basedOnVersion: undefined as never })).rejects.toMatchObject({ code: "invalid_input" });
    const bare = await seedWorkItemAt(db.admin, t.accountId, "spec_ready");
    await expect(respecSpec(ctx(t.system), { workItemId: bare, body: "x\n", acceptanceFiles: LIST, basedOnVersion: 1 })).rejects.toMatchObject({ code: "no_spec_version" });
    expect((await versions(wi)).map((r) => r.version)).toEqual([1, 2]);
    expect(await stageOf(wi)).toBe("needs_human");
    expect(await count(db.admin, `SELECT 1 FROM work_item_transitions WHERE work_item_id = $1`, [wi])).toBe(0);
  });

  it("F11: any stage but spec_ready and needs_human is spec_frozen (triaged, discussing and in_progress included); a member, a token and a run are forbidden", async () => {
    const t = await seedTenant(db.admin);
    for (const stage of ["triaged", "discussing", "in_progress", "pr_opened", "merged", "closed"]) {
      const wi = await seedWorkItemAt(db.admin, t.accountId, stage);
      await seedPreFixSpec(t.accountId, wi, 1, "s\n");
      await expect(respecSpec(ctx(t.system), { workItemId: wi, body: "x\n", acceptanceFiles: LIST, basedOnVersion: 1 })).rejects.toMatchObject({ code: "spec_frozen" });
      expect(await stageOf(wi)).toBe(stage);
    }
    const wi = await seedWorkItemAt(db.admin, t.accountId, "spec_ready");
    await seedPreFixSpec(t.accountId, wi, 1, "s\n");
    for (const p of [t.member, t.tokenWrite]) {
      await expect(respecSpec(ctx(p), { workItemId: wi, body: "x\n", acceptanceFiles: LIST, basedOnVersion: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect((await versions(wi)).map((r) => r.version)).toEqual([1]);
  });

  it("F11 (HT-3): the pipeline's Re-spec of an external work item is external_requires_human, at both stages; a signed-in owner may", async () => {
    const t = await seedTenant(db.admin);
    for (const stage of ["spec_ready", "needs_human"]) {
      const wi = await seedWorkItemAt(db.admin, t.accountId, stage, { provenance: "external" });
      await seedPreFixSpec(t.accountId, wi, 1, "s\n");
      await expect(respecSpec(ctx(t.system), { workItemId: wi, body: "x\n", acceptanceFiles: LIST, basedOnVersion: 1 })).rejects.toMatchObject({ code: "external_requires_human" });
      expect((await versions(wi)).map((r) => r.version)).toEqual([1]);
      expect(await stageOf(wi)).toBe(stage);
    }
    const wi = await seedWorkItemAt(db.admin, t.accountId, "needs_human", { provenance: "external" });
    await seedPreFixSpec(t.accountId, wi, 1, "s\n");
    await expect(respecSpec(ctx(t.owner), { workItemId: wi, body: "x\n", acceptanceFiles: LIST, basedOnVersion: 1 })).resolves.toMatchObject({ version: 2 });
    expect(await stageOf(wi)).toBe("spec_ready");
  });

  it("a halted item gets no Re-spec from the pipeline: nothing is written, at either stage", async () => {
    const t = await seedTenant(db.admin);
    for (const stage of ["spec_ready", "needs_human"]) {
      const wi = await seedWorkItemAt(db.admin, t.accountId, stage);
      await seedPreFixSpec(t.accountId, wi, 1, "s\n");
      await db.admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2, halt_epoch = 1 WHERE id = $1", [wi, randomUUID()]);
      await expect(respecSpec(ctx(t.system), { workItemId: wi, body: "x\n", acceptanceFiles: LIST, basedOnVersion: 1 })).rejects.toMatchObject({ name: "WorkItemHaltedError" });
      expect((await versions(wi)).map((r) => r.version)).toEqual([1]);
      expect(await stageOf(wi)).toBe(stage);
    }
  });
});
