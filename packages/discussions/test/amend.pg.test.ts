import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedTenant, ctxFor, seedWorkItemAt, count } from "./helpers/kit.js";
import { amendSpec, publishSpec } from "../src/specs.js";

/** D#597 CC-2b at the store: `amendSpec` adds version N+1 to a Spec that already has its file list, carrying the list forward. */
describe("amendSpec [pg]", () => {
  const db = pgHarness();
  const ctx = (p: Parameters<typeof ctxFor>[1]) => ctxFor(db.appUserPool, p);
  const LIST = ["src/a.ts", "src/{b,c}.test.ts"];
  const versions = async (wi: string) => (await db.admin.query(`SELECT version, body, frontmatter FROM spec_versions WHERE work_item_id = $1 ORDER BY version`, [wi])).rows;
  const stageOf = async (wi: string) => (await db.admin.query(`SELECT stage FROM work_items WHERE id = $1`, [wi])).rows[0].stage as string;

  async function specAt(stage: string, opts: { provenance?: "internal" | "external" } = {}) {
    const t = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, stage, opts);
    const body = "the Spec the person read\n";
    await db.admin.query(
      `INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind, frontmatter) VALUES ($1, $2, 1, $3, $4, 'system', $5::jsonb)`,
      [t.accountId, wi, body, createHash("sha256").update(body).digest("hex"), JSON.stringify({ acceptance_files: LIST })],
    );
    return { t, wi, body, IDS: [await acceptedAmendment(t.accountId, wi)] };
  }
  /** The stamp happens inside the version's transaction, so each delivered id must be a real `accepted` spec_amend of the item. */
  async function acceptedAmendment(accountId: string, wi: string): Promise<string> {
    const id = randomUUID();
    await db.admin.query(
      `INSERT INTO work_item_corrections (id, account_id, work_item_id, origin, kind, body, status, decided_via, decided_at, content_hash) VALUES ($1, $2, $3, 'person', 'spec_amend', 'x', 'accepted', 'workspace', now(), encode(sha256(convert_to('x', 'UTF8')), 'hex'))`,
      [id, accountId, wi],
    );
    return id;
  }
  const statusOf = async (id: string) => (await db.admin.query(`SELECT status FROM work_item_corrections WHERE id = $1`, [id])).rows[0].status as string;

  it("from spec_ready it publishes N+1 with the list carried forward and the delivered ids recorded; version 1 is unchanged and the stage stays", async () => {
    const { t, wi, body, IDS } = await specAt("spec_ready");
    const v2 = await amendSpec(ctx(t.system), { workItemId: wi, body: `${body}\n## Amendment (Ana, 2026-10-10)\n\nuse the staging key\n`, basedOnVersion: 1, correctionIds: IDS });
    expect(v2.version).toBe(2);
    const rows = await versions(wi);
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({ body, frontmatter: { acceptance_files: LIST } });
    expect(rows[1].frontmatter).toEqual({ acceptance_files: LIST, amended_corrections: IDS });
    expect(await statusOf(IDS[0]!)).toBe("applied");
    expect(rows[1].body.startsWith(body)).toBe(true);
    expect(await stageOf(wi)).toBe("spec_ready");
  });

  it("from needs_human it ends at spec_ready (the person's act), in the same transaction as the insert", async () => {
    const { t, wi, body, IDS } = await specAt("needs_human");
    await amendSpec(ctx(t.system), { workItemId: wi, body: `${body}\nmore\n`, basedOnVersion: 1, correctionIds: IDS });
    expect(await stageOf(wi)).toBe("spec_ready");
    expect(await count(db.admin, `SELECT 1 FROM work_item_transitions WHERE work_item_id = $1`, [wi])).toBe(2);
  });

  it("a halt does not refuse it (a person's click is behind it) and the halt stays", async () => {
    const { t, wi, body, IDS } = await specAt("spec_ready");
    await db.admin.query(`UPDATE work_items SET halted_at = now(), halt_action_id = $2, halt_epoch = 1 WHERE id = $1`, [wi, randomUUID()]);
    await expect(amendSpec(ctx(t.system), { workItemId: wi, body: `${body}\nx\n`, basedOnVersion: 1, correctionIds: IDS })).resolves.toMatchObject({ version: 2 });
    expect((await db.admin.query(`SELECT halted_at FROM work_items WHERE id = $1`, [wi])).rows[0].halted_at).not.toBeNull();
  });

  it("refuses, writing nothing: a version the body was not made from, no Spec, a Spec with no readable list, a frozen stage, an external item, no ids", async () => {
    const { t, wi, body, IDS } = await specAt("spec_ready");
    await publishSpec(ctx(t.owner), { workItemId: wi, body: "newer\n", acceptanceFiles: LIST });
    await expect(amendSpec(ctx(t.system), { workItemId: wi, body, basedOnVersion: 1, correctionIds: IDS })).rejects.toMatchObject({ code: "spec_changed" });
    await expect(amendSpec(ctx(t.system), { workItemId: wi, body, basedOnVersion: 0, correctionIds: IDS })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(amendSpec(ctx(t.system), { workItemId: wi, body, basedOnVersion: 2, correctionIds: [] })).rejects.toMatchObject({ code: "invalid_input" });
    expect((await versions(wi)).map((r) => r.version)).toEqual([1, 2]);

    const bare = await seedWorkItemAt(db.admin, t.accountId, "spec_ready");
    await expect(amendSpec(ctx(t.system), { workItemId: bare, body, basedOnVersion: 1, correctionIds: IDS })).rejects.toMatchObject({ code: "no_spec_version" });

    const noList = await seedWorkItemAt(db.admin, t.accountId, "spec_ready");
    await db.admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 's', $3, 'system')`, [t.accountId, noList, createHash("sha256").update("s").digest("hex")]);
    await expect(amendSpec(ctx(t.system), { workItemId: noList, body, basedOnVersion: 1, correctionIds: IDS })).rejects.toMatchObject({ code: "invalid_file_scope" });

    const frozen = await specAt("in_progress");
    await expect(amendSpec(ctx(frozen.t.system), { workItemId: frozen.wi, body, basedOnVersion: 1, correctionIds: IDS })).rejects.toMatchObject({ code: "spec_frozen" });
    const ext = await specAt("spec_ready", { provenance: "external" });
    await expect(amendSpec(ctx(ext.t.system), { workItemId: ext.wi, body, basedOnVersion: 1, correctionIds: IDS })).rejects.toMatchObject({ code: "external_requires_human" });
    for (const w of [noList, frozen.wi, ext.wi]) expect((await versions(w)).map((r) => r.version)).toEqual([1]);
  });

  it("a member and a token are forbidden", async () => {
    const { t, wi, body, IDS } = await specAt("spec_ready");
    for (const p of [t.member, t.tokenWrite]) {
      await expect(amendSpec(ctx(p), { workItemId: wi, body, basedOnVersion: 1, correctionIds: IDS })).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect((await versions(wi)).map((r) => r.version)).toEqual([1]);
  });

  it("a correction that is no longer accepted (rejected, or already delivered) stops the whole version: nothing is written and nothing is stamped", async () => {
    const { t, wi, body, IDS } = await specAt("spec_ready");
    const second = await acceptedAmendment(t.accountId, wi);
    await db.admin.query(`UPDATE work_item_corrections SET status = 'rejected' WHERE id = $1`, [second]);
    await expect(amendSpec(ctx(t.system), { workItemId: wi, body: `${body}\nx\n`, basedOnVersion: 1, correctionIds: [IDS[0]!, second] })).rejects.toMatchObject({ code: "correction_not_accepted" });
    expect((await versions(wi)).map((r) => r.version)).toEqual([1]);
    expect(await statusOf(IDS[0]!)).toBe("accepted");
    expect(await statusOf(second)).toBe("rejected");
  });
});
