import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedTenant, ctxFor, seedWorkItemAt, seedSpecVersion, forceParentId, count } from "./helpers/kit.js";
import { publishSpec, addCorrection } from "../src/specs.js";
import { setStage } from "../src/stages.js";
import { effectiveProvenance } from "../src/provenance.js";
import { ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";

// D#71 C7 / DS-2c: the external-provenance gate. Every case runs as app_user
// against a real Postgres, through the exported functions. Every refusal also
// asserts that nothing was written: stage, transitions, Specs, corrections
// and domain events are all unchanged.
describe("external provenance gate [pg]", () => {
  const db = pgHarness();
  const ctx = (p: Parameters<typeof ctxFor>[1]) => ctxFor(db.appUserPool, p);

  async function snapshot(accountId: string, wi: string) {
    const { rows } = await db.admin.query(`SELECT stage FROM work_items WHERE id = $1`, [wi]);
    return {
      stage: rows[0].stage as string,
      transitions: await count(db.admin, `SELECT 1 FROM work_item_transitions WHERE work_item_id = $1`, [wi]),
      specs: await count(db.admin, `SELECT 1 FROM spec_versions WHERE work_item_id = $1`, [wi]),
      corrections: await count(db.admin, `SELECT 1 FROM spec_corrections WHERE account_id = $1`, [accountId]),
      events: await count(db.admin, `SELECT 1 FROM domain_events WHERE account_id = $1`, [accountId]),
    };
  }

  /** Runs `call`, expects a rejection matching `matcher`, and asserts nothing changed. */
  async function refused(accountId: string, wi: string, call: () => Promise<unknown>, matcher: (e: unknown) => void) {
    const before = await snapshot(accountId, wi);
    let caught: unknown;
    try {
      await call();
    } catch (e) {
      caught = e;
    }
    expect(caught, "expected a refusal").toBeDefined();
    matcher(caught);
    expect(await snapshot(accountId, wi)).toEqual(before);
  }
  const isForbidden = (e: unknown) => expect(e).toBeInstanceOf(ForbiddenError);
  const hasCode = (code: string) => (e: unknown) => expect(e).toMatchObject({ code });

  it("criterion 1 (HT-5): system may not take an external item triaged/closed_unmerged -> in_progress; owner/admin may; internal and spec_ready -> in_progress stay open to system", async () => {
    const t = await seedTenant(db.admin);
    for (const from of ["triaged", "closed_unmerged"]) {
      const ext = await seedWorkItemAt(db.admin, t.accountId, from, { provenance: "external" });
      await refused(t.accountId, ext, () => setStage(ctx(t.system), { workItemId: ext, toStage: "in_progress" }), isForbidden);
      await expect(setStage(ctx(from === "triaged" ? t.owner : t.admin), { workItemId: ext, toStage: "in_progress" })).resolves.toMatchObject({ recorded: true });
      expect((await snapshot(t.accountId, ext)).stage).toBe("in_progress");

      const internal = await seedWorkItemAt(db.admin, t.accountId, from, { provenance: "internal" });
      await expect(setStage(ctx(t.system), { workItemId: internal, toStage: "in_progress" })).resolves.toMatchObject({ recorded: true });
    }
    const readyExt = await seedWorkItemAt(db.admin, t.accountId, "spec_ready", { provenance: "external" });
    await expect(setStage(ctx(t.system), { workItemId: readyExt, toStage: "in_progress" })).resolves.toMatchObject({ recorded: true });
  });

  describe("criterion 3 (effective provenance, R2)", () => {
    /** A (external) <- B (internal) <- C (internal). */
    async function chain(accountId: string, cStage: string, aProvenance: "internal" | "external" = "external") {
      const a = await seedWorkItemAt(db.admin, accountId, "triaged", { provenance: aProvenance });
      const b = await seedWorkItemAt(db.admin, accountId, "triaged", { provenance: "internal", parentId: a });
      const c = await seedWorkItemAt(db.admin, accountId, cStage, { provenance: "internal", parentId: b });
      return { a, b, c };
    }

    it("(a) system publishSpec on an internal child of an external grandparent is external_requires_human", async () => {
      const t = await seedTenant(db.admin);
      const { c } = await chain(t.accountId, "discussing");
      await refused(t.accountId, c, () => publishSpec(ctx(t.system), { workItemId: c, acceptanceFiles: ["src/**"], body: "s" }), hasCode("external_requires_human"));
    });

    it("(b) system discussing -> spec_ready on C (with a Spec row present) is forbidden", async () => {
      const t = await seedTenant(db.admin);
      const { c } = await chain(t.accountId, "discussing");
      await seedSpecVersion(db.admin, t.accountId, c);
      await refused(t.accountId, c, () => setStage(ctx(t.system), { workItemId: c, toStage: "spec_ready" }), isForbidden);
    });

    it("(c) system triaged -> in_progress on C is forbidden", async () => {
      const t = await seedTenant(db.admin);
      const { c } = await chain(t.accountId, "triaged");
      await refused(t.accountId, c, () => setStage(ctx(t.system), { workItemId: c, toStage: "in_progress" }), isForbidden);
    });

    it("(d) system addCorrection on C is external_requires_human", async () => {
      const t = await seedTenant(db.admin);
      const { c } = await chain(t.accountId, "spec_ready");
      await publishSpec(ctx(t.owner), { workItemId: c, acceptanceFiles: ["src/**"], body: "owner-published" });
      await refused(t.accountId, c, () => addCorrection(ctx(t.system), { workItemId: c, body: "x" }), hasCode("external_requires_human"));
    });

    it("(e) with A internal, the same four calls succeed for system", async () => {
      const t = await seedTenant(db.admin);
      const pub = await chain(t.accountId, "discussing", "internal");
      await expect(publishSpec(ctx(t.system), { workItemId: pub.c, acceptanceFiles: ["src/**"], body: "s" })).resolves.toMatchObject({ version: 1 });

      const promote = await chain(t.accountId, "discussing", "internal");
      await seedSpecVersion(db.admin, t.accountId, promote.c);
      await expect(setStage(ctx(t.system), { workItemId: promote.c, toStage: "spec_ready" })).resolves.toMatchObject({ recorded: true });

      const fast = await chain(t.accountId, "triaged", "internal");
      await expect(setStage(ctx(t.system), { workItemId: fast.c, toStage: "in_progress" })).resolves.toMatchObject({ recorded: true });

      const corr = await chain(t.accountId, "spec_ready", "internal");
      await publishSpec(ctx(t.owner), { workItemId: corr.c, acceptanceFiles: ["src/**"], body: "s" });
      await expect(addCorrection(ctx(t.system), { workItemId: corr.c, body: "x" })).resolves.toMatchObject({ code: "C1" });
    });

    it("(f) a parent_id cycle with no external item fails closed, quickly", async () => {
      const t = await seedTenant(db.admin);
      const x = await seedWorkItemAt(db.admin, t.accountId, "discussing", { provenance: "internal" });
      const y = await seedWorkItemAt(db.admin, t.accountId, "triaged", { provenance: "internal", parentId: x });
      const z = await seedWorkItemAt(db.admin, t.accountId, "triaged", { provenance: "internal", parentId: y });
      await db.admin.query(`UPDATE work_items SET parent_id = $2 WHERE id = $1`, [x, z]); // x -> z -> y -> x
      await seedSpecVersion(db.admin, t.accountId, x);
      const started = Date.now();
      await refused(t.accountId, x, () => publishSpec(ctx(t.system), { workItemId: x, acceptanceFiles: ["src/**"], body: "s" }), hasCode("external_requires_human"));
      await refused(t.accountId, x, () => setStage(ctx(t.system), { workItemId: x, toStage: "spec_ready" }), isForbidden);
      await refused(t.accountId, x, () => addCorrection(ctx(t.system), { workItemId: x, body: "c" }), hasCode("external_requires_human"));
      expect(Date.now() - started).toBeLessThan(1000);
      // A cycle item with no root counts as external for the owner-only edges too.
      await refused(t.accountId, z, () => setStage(ctx(t.system), { workItemId: z, toStage: "in_progress" }), isForbidden);
    });

    it("a missing parent row fails closed; an item with a root and only internal ancestors is internal", async () => {
      const t = await seedTenant(db.admin);
      const orphan = await seedWorkItemAt(db.admin, t.accountId, "triaged", { provenance: "internal" });
      await forceParentId(db.admin, orphan, randomUUID());
      await refused(t.accountId, orphan, () => setStage(ctx(t.system), { workItemId: orphan, toStage: "in_progress" }), isForbidden);
      const child = await seedWorkItemAt(db.admin, t.accountId, "discussing", { provenance: "internal", parentId: orphan });
      await refused(t.accountId, child, () => publishSpec(ctx(t.system), { workItemId: child, acceptanceFiles: ["src/**"], body: "s" }), hasCode("external_requires_human"));

      const read = (id: string) => withTenant(db.appUserPool, t.accountId, (client) => effectiveProvenance(client, id));
      const root = await seedWorkItemAt(db.admin, t.accountId, "triaged", { provenance: "internal" });
      const mid = await seedWorkItemAt(db.admin, t.accountId, "triaged", { provenance: "internal", parentId: root });
      const leaf = await seedWorkItemAt(db.admin, t.accountId, "triaged", { provenance: "internal", parentId: mid });
      expect(await read(leaf)).toBe("internal");
      expect(await read(orphan)).toBe("external");
      expect(await read(child)).toBe("external");
      // An external item in the middle of an otherwise internal chain.
      await db.admin.query(`UPDATE work_items SET provenance = 'external' WHERE id = $1`, [mid]);
      expect(await read(leaf)).toBe("external");
      expect(await read(mid)).toBe("external");
    });

    it("an ancestor in another tenant does not exist for the walk: the composite FK keeps chains inside one account", async () => {
      const t = await seedTenant(db.admin);
      const other = await seedTenant(db.admin);
      const foreign = await seedWorkItemAt(db.admin, other.accountId, "triaged", { provenance: "external" });
      const mine = await seedWorkItemAt(db.admin, t.accountId, "discussing", { provenance: "internal" });
      await expect(db.admin.query(`UPDATE work_items SET parent_id = $2 WHERE id = $1`, [mine, foreign])).rejects.toThrow();
      await expect(publishSpec(ctx(t.system), { workItemId: mine, acceptanceFiles: ["src/**"], body: "s" })).resolves.toMatchObject({ version: 1 });
    });
  });

  it("criterion 4 (R3): system addCorrection on an external item is external_requires_human and writes nothing; owner/admin succeed; system on internal gets the next C<n>", async () => {
    const t = await seedTenant(db.admin);
    const ext = await seedWorkItemAt(db.admin, t.accountId, "triaged", { provenance: "external" });
    await publishSpec(ctx(t.owner), { workItemId: ext, acceptanceFiles: ["src/**"], body: "owner Spec" });
    await refused(t.accountId, ext, () => addCorrection(ctx(t.system), { workItemId: ext, body: "injected" }), hasCode("external_requires_human"));
    await expect(addCorrection(ctx(t.owner), { workItemId: ext, body: "by owner" })).resolves.toMatchObject({ code: "C1" });
    await expect(addCorrection(ctx(t.admin), { workItemId: ext, body: "by admin" })).resolves.toMatchObject({ code: "C2" });

    const internal = await seedWorkItemAt(db.admin, t.accountId, "triaged", { provenance: "internal" });
    await publishSpec(ctx(t.owner), { workItemId: internal, acceptanceFiles: ["src/**"], body: "s" });
    await addCorrection(ctx(t.owner), { workItemId: internal, body: "one" });
    await expect(addCorrection(ctx(t.system), { workItemId: internal, body: "two" })).resolves.toMatchObject({ code: "C2" });
  });

  it("criterion 7 (R5): setStage to spec_ready with no Spec is no_spec_version for system and owner; with a Spec it succeeds", async () => {
    const t = await seedTenant(db.admin);
    for (const from of ["triaged", "discussing"]) {
      const wi = await seedWorkItemAt(db.admin, t.accountId, from, { provenance: "internal" });
      for (const p of [t.system, t.owner, t.admin]) {
        await refused(t.accountId, wi, () => setStage(ctx(p), { workItemId: wi, toStage: "spec_ready" }), hasCode("no_spec_version"));
      }
    }
    // An external item: the owner (allowed by HT-3) is still refused without a Spec.
    const ext = await seedWorkItemAt(db.admin, t.accountId, "triaged", { provenance: "external" });
    await refused(t.accountId, ext, () => setStage(ctx(t.owner), { workItemId: ext, toStage: "spec_ready" }), hasCode("no_spec_version"));

    // Reached through publishSpec -> in_progress -> needs_human -> discussing: a Spec exists, so system may promote.
    const wi = await seedWorkItemAt(db.admin, t.accountId, "discussing", { provenance: "internal" });
    await publishSpec(ctx(t.system), { workItemId: wi, acceptanceFiles: ["src/**"], body: "s" });
    await setStage(ctx(t.system), { workItemId: wi, toStage: "in_progress" });
    await setStage(ctx(t.system), { workItemId: wi, toStage: "needs_human" });
    await setStage(ctx(t.owner), { workItemId: wi, toStage: "discussing" });
    await expect(setStage(ctx(t.system), { workItemId: wi, toStage: "spec_ready" })).resolves.toMatchObject({ recorded: true });

    const fixture = await seedWorkItemAt(db.admin, t.accountId, "discussing", { provenance: "internal" });
    await seedSpecVersion(db.admin, t.accountId, fixture);
    await expect(setStage(ctx(t.system), { workItemId: fixture, toStage: "spec_ready" })).resolves.toMatchObject({ recorded: true });
    expect(await count(db.admin, `SELECT 1 FROM domain_events WHERE account_id = $1 AND type = 'spec.published'`, [t.accountId])).toBe(1);
  });
});
