import { randomUUID, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedTenant, ctxFor, seedWorkItemAt, seedRunOn, count } from "./helpers/kit.js";
import { publishSpec, addCorrection, specAsOf, correctionsSince } from "../src/specs.js";
import { MAX_BODY_BYTES, STORAGE_QUOTA_BYTES, utf8ByteLength } from "../src/limits.js";
import { NotFoundError, ForbiddenError } from "@fx/core/src/tenancy/errors.js";

describe("specs.ts [pg]", () => {
  const db = pgHarness();
  const ctx = (p: Parameters<typeof ctxFor>[1]) => ctxFor(db.appUserPool, p);

  async function specRows(workItemId: string) {
    const { rows } = await db.admin.query(
      `SELECT version, body, body_sha256, created_by_kind, created_by_user_id FROM spec_versions WHERE work_item_id = $1 ORDER BY version`,
      [workItemId],
    );
    return rows;
  }

  it("criterion 6: publishSpec inserts version 1, 2, ... with a matching sha256; triaged/discussing move to spec_ready with one transition row, spec_ready stays put", async () => {
    const t = await seedTenant(db.admin);
    const fromTriaged = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    const fromDiscussing = await seedWorkItemAt(db.admin, t.accountId, "discussing");

    const v1 = await publishSpec(ctx(t.owner), { workItemId: fromTriaged, body: "Spec v1" });
    expect(v1.version).toBe(1);
    expect(v1.bodySha256).toBe(createHash("sha256").update("Spec v1").digest("hex"));
    const { rows: stage1 } = await db.admin.query(`SELECT stage FROM work_items WHERE id = $1`, [fromTriaged]);
    expect(stage1[0].stage).toBe("spec_ready");
    const { rows: tr } = await db.admin.query(
      `SELECT from_stage, to_stage FROM work_item_transitions WHERE work_item_id = $1`,
      [fromTriaged],
    );
    expect(tr).toEqual([{ from_stage: "triaged", to_stage: "spec_ready" }]);

    // From spec_ready: version 2, stage unchanged, no second transition.
    const v2 = await publishSpec(ctx(t.admin), { workItemId: fromTriaged, body: "Spec v2" });
    expect(v2.version).toBe(2);
    expect(await count(db.admin, `SELECT 1 FROM work_item_transitions WHERE work_item_id = $1`, [fromTriaged])).toBe(1);
    const { rows: stage2 } = await db.admin.query(`SELECT stage FROM work_items WHERE id = $1`, [fromTriaged]);
    expect(stage2[0].stage).toBe("spec_ready");

    await publishSpec(ctx(t.owner), { workItemId: fromDiscussing, body: "Spec" });
    const { rows: stage3 } = await db.admin.query(`SELECT stage FROM work_items WHERE id = $1`, [fromDiscussing]);
    expect(stage3[0].stage).toBe("spec_ready");

    const rows = await specRows(fromTriaged);
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({ created_by_kind: "user", created_by_user_id: (t.owner as { userId: string }).userId });
  });

  it("DP-C6: on a halted item a signed-in person's Spec is recorded and moves the stage, and the marker stays; a system publish writes nothing at any of the three stages", async () => {
    const t = await seedTenant(db.admin);
    for (const stage of ["triaged", "discussing", "spec_ready"]) {
      const person = await seedWorkItemAt(db.admin, t.accountId, stage);
      const system = await seedWorkItemAt(db.admin, t.accountId, stage);
      for (const wi of [person, system]) {
        await db.admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2, halt_epoch = 1 WHERE id = $1", [wi, randomUUID()]);
      }
      await expect(publishSpec(ctx(t.system), { workItemId: system, body: "from the pipeline" })).rejects.toMatchObject({ name: "WorkItemHaltedError" });
      expect(await specRows(system)).toHaveLength(0);
      expect((await db.admin.query(`SELECT stage FROM work_items WHERE id = $1`, [system])).rows[0].stage).toBe(stage);

      await expect(publishSpec(ctx(t.owner), { workItemId: person, body: "from a person" })).resolves.toMatchObject({ version: 1 });
      const { rows } = await db.admin.query(`SELECT stage, halted_at IS NOT NULL AS halted FROM work_items WHERE id = $1`, [person]);
      expect(rows[0]).toEqual({ stage: "spec_ready", halted: true });
    }
  });

  it("criterion 6: every stage other than triaged/discussing/spec_ready is spec_frozen and writes nothing", async () => {
    const t = await seedTenant(db.admin);
    for (const stage of ["in_progress", "pr_opened", "changes_requested", "review_passed", "needs_human", "merged", "closed_unmerged", "closed"]) {
      const wi = await seedWorkItemAt(db.admin, t.accountId, stage);
      await expect(publishSpec(ctx(t.owner), { workItemId: wi, body: "late" })).rejects.toMatchObject({ code: "spec_frozen" });
      expect(await specRows(wi)).toHaveLength(0);
      const { rows } = await db.admin.query(`SELECT stage FROM work_items WHERE id = $1`, [wi]);
      expect(rows[0].stage).toBe(stage);
      expect(await count(db.admin, `SELECT 1 FROM work_item_transitions WHERE work_item_id = $1`, [wi])).toBe(0);
    }
  });

  it("criterion 6 (HT-3): a system publish on an external work item is external_requires_human at every stage; a signed-in owner/admin may publish it", async () => {
    const t = await seedTenant(db.admin);
    for (const stage of ["triaged", "discussing", "spec_ready"]) {
      const wi = await seedWorkItemAt(db.admin, t.accountId, stage, { provenance: "external" });
      await expect(publishSpec(ctx(t.system), { workItemId: wi, body: "s" })).rejects.toMatchObject({ code: "external_requires_human" });
      expect(await specRows(wi)).toHaveLength(0);
      const { rows } = await db.admin.query(`SELECT stage FROM work_items WHERE id = $1`, [wi]);
      expect(rows[0].stage).toBe(stage);
    }
    const external = await seedWorkItemAt(db.admin, t.accountId, "triaged", { provenance: "external" });
    await expect(publishSpec(ctx(t.admin), { workItemId: external, body: "human approved" })).resolves.toMatchObject({ version: 1 });

    const internal = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    const v = await publishSpec(ctx(t.system), { workItemId: internal, body: "system, internal" });
    expect(v.version).toBe(1);
    const rows = await specRows(internal);
    expect(rows[0]).toMatchObject({ created_by_kind: "system", created_by_user_id: null });
  });

  it("publishSpec and addCorrection are forbidden for a member, a token and a run, and write nothing", async () => {
    const t = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    const run = await seedRunOn(db.admin, t.accountId, wi);
    for (const p of [t.member, t.tokenWrite, run]) {
      await expect(publishSpec(ctx(p), { workItemId: wi, body: "s" })).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await specRows(wi)).toHaveLength(0);

    await publishSpec(ctx(t.owner), { workItemId: wi, body: "s" });
    for (const p of [t.member, t.tokenWrite, run]) {
      await expect(addCorrection(ctx(p), { workItemId: wi, body: "c" })).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await count(db.admin, `SELECT 1 FROM spec_corrections WHERE account_id = $1`, [t.accountId])).toBe(0);
  });

  it("criterion 7: addCorrection needs a Spec version, and the service assigns C1, C2, ... across all versions of the work item", async () => {
    const t = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "discussing");

    await expect(addCorrection(ctx(t.owner), { workItemId: wi, body: "c" })).rejects.toMatchObject({ code: "no_spec_version" });

    await publishSpec(ctx(t.owner), { workItemId: wi, body: "v1" });
    const c1 = await addCorrection(ctx(t.owner), { workItemId: wi, body: "first" });
    const c2 = await addCorrection(ctx(t.system), { workItemId: wi, body: "second" });
    expect([c1.code, c2.code]).toEqual(["C1", "C2"]);

    // A new version restarts nothing: the next code is still C3, attached to v2.
    const v2 = await publishSpec(ctx(t.owner), { workItemId: wi, body: "v2" });
    const c3 = await addCorrection(ctx(t.owner), { workItemId: wi, body: "third" });
    expect(c3.code).toBe("C3");
    expect(c3.specVersionId).toBe(v2.id);

    // Callers cannot supply a code.
    await expect(
      addCorrection(ctx(t.owner), { workItemId: wi, body: "x", code: "C99" } as unknown as Parameters<typeof addCorrection>[1]),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await count(db.admin, `SELECT 1 FROM spec_corrections WHERE account_id = $1`, [t.accountId])).toBe(3);
  });

  it("criterion 7: concurrent corrections get distinct, gapless codes", async () => {
    const t = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    await publishSpec(ctx(t.owner), { workItemId: wi, body: "v1" });
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => addCorrection(ctx(t.owner), { workItemId: wi, body: `c${i}` })),
    );
    expect(results.map((r) => Number(r.code.slice(1))).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it("criterion 7: appliesTo accepts the Spec's own work item and its descendants, and refuses everything else with invalid_input", async () => {
    const t = await seedTenant(db.admin);
    const other = await seedTenant(db.admin);
    const root = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    const child = await seedWorkItemAt(db.admin, t.accountId, "triaged", { parentId: root });
    const grandchild = await seedWorkItemAt(db.admin, t.accountId, "triaged", { parentId: child });
    const unrelated = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    const foreign = await seedWorkItemAt(db.admin, other.accountId, "triaged");
    await publishSpec(ctx(t.owner), { workItemId: root, body: "v1" });

    const ok = await addCorrection(ctx(t.owner), { workItemId: root, body: "c", appliesTo: [root, child, grandchild, child] });
    expect([...ok.appliesTo].sort()).toEqual([root, child, grandchild].sort());

    const before = await count(db.admin, `SELECT 1 FROM spec_corrections WHERE account_id = $1`, [t.accountId]);
    for (const bad of [[unrelated], [foreign], [randomUUID()], ["not-a-uuid"], [child, unrelated]]) {
      await expect(addCorrection(ctx(t.owner), { workItemId: root, body: "c", appliesTo: bad })).rejects.toMatchObject({ code: "invalid_input" });
    }
    // An ancestor is not a descendant: the parent chain is walked UP from the target only.
    await publishSpec(ctx(t.owner), { workItemId: child, body: "child spec" });
    await expect(addCorrection(ctx(t.owner), { workItemId: child, body: "c", appliesTo: [root] })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await count(db.admin, `SELECT 1 FROM spec_corrections WHERE account_id = $1`, [t.accountId])).toBe(before);
  });

  it("criterion 8: specAsOf returns the pinned Spec plus corrections at-or-before the run's created_at; correctionsSince returns the later ones", async () => {
    const t = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    const v1 = await publishSpec(ctx(t.owner), { workItemId: wi, body: "the pinned Spec" });
    const c1 = await addCorrection(ctx(t.owner), { workItemId: wi, body: "before the run" });
    const run = await seedRunOn(db.admin, t.accountId, wi, { specVersionId: v1.id });
    const c2 = await addCorrection(ctx(t.owner), { workItemId: wi, body: "after the run" });

    const asOf = await specAsOf(ctx(t.owner), { runId: run.runId });
    expect(asOf.specVersion).toMatchObject({ id: v1.id, version: 1, body: "the pinned Spec" });
    expect(asOf.corrections.map((c) => c.code)).toEqual(["C1"]);
    expect((await correctionsSince(ctx(t.owner), { runId: run.runId })).map((c) => c.code)).toEqual(["C2"]);

    // Boundary: a correction created exactly at the run's created_at is "at or before".
    // created_at is set at INSERT (0642 froze it after insert, for every
    // role): a second run pinned to the same version, stamped with c2's
    // created_at.
    const boundaryRunId = randomUUID();
    await db.admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, spec_version_id, created_at)
       VALUES ($1, $2, $3, 'executor', 'production', 'running', $4, (SELECT created_at FROM spec_corrections WHERE id = $5))`,
      [boundaryRunId, t.accountId, wi, v1.id, c2.id],
    );
    expect((await specAsOf(ctx(t.owner), { runId: boundaryRunId })).corrections.map((c) => c.code)).toEqual(["C1", "C2"]);
    expect(await correctionsSince(ctx(t.owner), { runId: boundaryRunId })).toEqual([]);
    expect(c1.code).toBe("C1");
  });

  it("criterion 6 (R4): specAsOf is bounded by the pinned version and the run's created_at; correctionsSince is the complement", async () => {
    const t = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    const v1 = await publishSpec(ctx(t.owner), { workItemId: wi, body: "v1" });
    const c1 = await addCorrection(ctx(t.owner), { workItemId: wi, body: "on v1" });
    const v2 = await publishSpec(ctx(t.owner), { workItemId: wi, body: "v2" });
    const c2 = await addCorrection(ctx(t.owner), { workItemId: wi, body: "on v2" });
    expect([c1.specVersionId, c2.specVersionId]).toEqual([v1.id, v2.id]);

    // Same instant, after both corrections. created_at is set at INSERT
    // (0642 froze it after insert, for every role): both runs share one
    // stamp taken now, plus a second, so it is later than every correction.
    const { rows: stampRows } = await db.admin.query<{ ts: Date }>(`SELECT clock_timestamp() + interval '1 second' AS ts`);
    const stamp = stampRows[0]!.ts;
    const seedPinned = async (specVersionId: string): Promise<{ runId: string }> => {
      const runId = randomUUID();
      await db.admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, spec_version_id, created_at)
         VALUES ($1, $2, $3, 'executor', 'production', 'running', $4, $5)`,
        [runId, t.accountId, wi, specVersionId, stamp],
      );
      return { runId };
    };
    const pinnedV1 = await seedPinned(v1.id);
    const pinnedV2 = await seedPinned(v2.id);

    const onV1 = await specAsOf(ctx(t.owner), { runId: pinnedV1.runId });
    expect(onV1.specVersion.id).toBe(v1.id);
    expect(onV1.corrections.map((c) => c.code)).toEqual(["C1"]);
    expect((await correctionsSince(ctx(t.owner), { runId: pinnedV1.runId })).map((c) => c.code)).toEqual(["C2"]);

    const onV2 = await specAsOf(ctx(t.owner), { runId: pinnedV2.runId });
    expect(onV2.specVersion.id).toBe(v2.id);
    expect(onV2.corrections.map((c) => c.code)).toEqual(["C1", "C2"]);
    expect(await correctionsSince(ctx(t.owner), { runId: pinnedV2.runId })).toEqual([]);

    // Property: for every run, the two sets partition the work item's corrections.
    const c3 = await addCorrection(ctx(t.owner), { workItemId: wi, body: "after the runs" });
    const all = [c1.code, c2.code, c3.code];
    for (const run of [pinnedV1, pinnedV2]) {
      const asOf = (await specAsOf(ctx(t.owner), { runId: run.runId })).corrections.map((c) => c.code);
      const since = (await correctionsSince(ctx(t.owner), { runId: run.runId })).map((c) => c.code);
      expect(asOf.filter((c) => since.includes(c))).toEqual([]);
      expect([...asOf, ...since].sort()).toEqual([...all].sort());
    }
  });

  it("criterion 8: a run with a null spec_version_id gets no_spec_version from both readers", async () => {
    const t = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    const run = await seedRunOn(db.admin, t.accountId, wi);
    await expect(specAsOf(ctx(t.owner), { runId: run.runId })).rejects.toMatchObject({ code: "no_spec_version" });
    await expect(correctionsSince(ctx(t.owner), { runId: run.runId })).rejects.toMatchObject({ code: "no_spec_version" });
  });

  it("read scoping: a run reads its own work item's Spec (and its parent's), not an unrelated one; a read-scope token may read; malformed and cross-tenant ids are NotFoundError", async () => {
    const t = await seedTenant(db.admin);
    const other = await seedTenant(db.admin);
    const parent = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    const own = await seedWorkItemAt(db.admin, t.accountId, "triaged", { parentId: parent });
    const unrelated = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    const parentSpec = await publishSpec(ctx(t.owner), { workItemId: parent, body: "parent spec" });
    const ownSpec = await publishSpec(ctx(t.owner), { workItemId: own, body: "own spec" });
    const unrelatedSpec = await publishSpec(ctx(t.owner), { workItemId: unrelated, body: "unrelated spec" });

    const ownRun = await seedRunOn(db.admin, t.accountId, own, { specVersionId: ownSpec.id });
    const parentPinned = await seedRunOn(db.admin, t.accountId, own, { specVersionId: parentSpec.id });
    const unrelatedRun = await seedRunOn(db.admin, t.accountId, unrelated, { specVersionId: unrelatedSpec.id });

    await expect(specAsOf(ctx(ownRun), { runId: ownRun.runId })).resolves.toMatchObject({ specVersion: { body: "own spec" } });
    await expect(specAsOf(ctx(ownRun), { runId: parentPinned.runId })).resolves.toMatchObject({ specVersion: { body: "parent spec" } });
    await expect(specAsOf(ctx(ownRun), { runId: unrelatedRun.runId })).rejects.toBeInstanceOf(NotFoundError);
    await expect(correctionsSince(ctx(ownRun), { runId: unrelatedRun.runId })).rejects.toBeInstanceOf(NotFoundError);

    await expect(specAsOf(ctx(t.tokenRead), { runId: ownRun.runId })).resolves.toBeDefined();
    await expect(specAsOf(ctx({ ...t.tokenRead, scopes: [] } as typeof t.tokenRead), { runId: ownRun.runId })).rejects.toBeInstanceOf(ForbiddenError);

    // Another tenant cannot read A's run or Spec: RLS makes it a missing row.
    await expect(specAsOf(ctx(other.owner), { runId: ownRun.runId })).rejects.toBeInstanceOf(NotFoundError);
    await expect(correctionsSince(ctx(other.system), { runId: ownRun.runId })).rejects.toBeInstanceOf(NotFoundError);
    await expect(specAsOf(ctx(t.owner), { runId: "not-a-uuid" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("criterion 10/11/12: Spec and correction bodies obey the size limit, charge storage by exact UTF-8 bytes, and are redacted for system", async () => {
    const t = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    const bytes = async () => {
      const { rows } = await db.admin.query(`SELECT bytes_used FROM discussion_counters WHERE account_id = $1`, [t.accountId]);
      return rows.length ? Number(rows[0].bytes_used) : 0;
    };

    await expect(publishSpec(ctx(t.owner), { workItemId: wi, body: "x".repeat(MAX_BODY_BYTES + 1) })).rejects.toMatchObject({ code: "payload_too_large" });
    // Multi-byte: 3 bytes per character crosses the byte limit well before the character limit.
    await expect(publishSpec(ctx(t.owner), { workItemId: wi, body: "€".repeat(Math.floor(MAX_BODY_BYTES / 3) + 1) })).rejects.toMatchObject({ code: "payload_too_large" });
    expect(await specRows(wi)).toHaveLength(0);
    expect(await bytes()).toBe(0);

    const specBody = "Spec with a euro sign €";
    await publishSpec(ctx(t.owner), { workItemId: wi, body: specBody });
    expect(await bytes()).toBe(utf8ByteLength(specBody));
    await expect(addCorrection(ctx(t.owner), { workItemId: wi, body: "y".repeat(MAX_BODY_BYTES + 1) })).rejects.toMatchObject({ code: "payload_too_large" });
    const corrBody = "correction ✓";
    await addCorrection(ctx(t.owner), { workItemId: wi, body: corrBody });
    expect(await bytes()).toBe(utf8ByteLength(specBody) + utf8ByteLength(corrBody));

    const fakeKey = "sk-ant-api03-" + "A".repeat(40);
    await addCorrection(ctx(t.system), { workItemId: wi, body: `leaked ${fakeKey}` });
    const { rows } = await db.admin.query(`SELECT body FROM spec_corrections WHERE account_id = $1`, [t.accountId]);
    expect(rows.every((r) => !r.body.includes(fakeKey))).toBe(true);

    const wi2 = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    const v = await publishSpec(ctx(t.system), { workItemId: wi2, body: `spec with ${fakeKey}` });
    const stored = (await specRows(wi2))[0];
    expect(stored.body).not.toContain(fakeKey);
    // The stored hash is over the redacted body the row actually holds.
    expect(v.bodySha256).toBe(createHash("sha256").update(stored.body).digest("hex"));
  });

  it("criterion 11: a Spec or correction that would take bytes_used over the plan quota is storage_quota_exceeded and writes no row", async () => {
    const t = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    await publishSpec(ctx(t.owner), { workItemId: wi, body: "v1" });
    await db.admin.query(`UPDATE discussion_counters SET bytes_used = $2 WHERE account_id = $1`, [t.accountId, STORAGE_QUOTA_BYTES.starter - 5]);

    await expect(publishSpec(ctx(t.owner), { workItemId: wi, body: "x".repeat(100) })).rejects.toMatchObject({ code: "storage_quota_exceeded" });
    await expect(addCorrection(ctx(t.owner), { workItemId: wi, body: "x".repeat(100) })).rejects.toMatchObject({ code: "storage_quota_exceeded" });
    expect(await specRows(wi)).toHaveLength(1);
    expect(await count(db.admin, `SELECT 1 FROM spec_corrections WHERE account_id = $1`, [t.accountId])).toBe(0);
    const { rows } = await db.admin.query(`SELECT stage FROM work_items WHERE id = $1`, [wi]);
    expect(rows[0].stage).toBe("spec_ready");
  });

  it("criterion 15: publishSpec and addCorrection each emit exactly one event with ids and enums only", async () => {
    const t = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    const v = await publishSpec(ctx(t.owner), { workItemId: wi, body: "SECRET-SPEC-BODY" });
    const c = await addCorrection(ctx(t.owner), { workItemId: wi, body: "SECRET-CORRECTION-BODY" });

    const { rows } = await db.admin.query(
      `SELECT type, subject_id, payload FROM domain_events WHERE account_id = $1 AND type IN ('spec.published', 'spec.corrected') ORDER BY type`,
      [t.accountId],
    );
    expect(rows.map((r) => r.type)).toEqual(["spec.corrected", "spec.published"]);
    expect(rows[0]).toMatchObject({ subject_id: c.id, payload: { workItemId: wi, specVersionId: v.id, code: "C1" } });
    expect(rows[1]).toMatchObject({ subject_id: v.id, payload: { workItemId: wi, specVersionId: v.id, version: 1, stage: "spec_ready" } });
    for (const r of rows) {
      expect(Object.keys(r.payload)).not.toContain("body");
      expect(Object.keys(r.payload)).not.toContain("title");
      for (const value of Object.values(r.payload)) {
        if (typeof value === "string") expect(value.length).toBeLessThanOrEqual(64);
      }
      expect(JSON.stringify(r.payload)).not.toContain("SECRET");
    }
  });

  it("criterion 3: an input carrying account_id/accountId is invalid_input and writes no row", async () => {
    const t = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    for (const key of ["account_id", "accountId"]) {
      await expect(publishSpec(ctx(t.owner), { workItemId: wi, body: "s", [key]: randomUUID() } as never)).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(await specRows(wi)).toHaveLength(0);
    await publishSpec(ctx(t.owner), { workItemId: wi, body: "s" });
    await expect(addCorrection(ctx(t.owner), { workItemId: wi, body: "c", accountId: randomUUID() } as never)).rejects.toMatchObject({ code: "invalid_input" });
    const run = await seedRunOn(db.admin, t.accountId, wi);
    await expect(specAsOf(ctx(t.owner), { runId: run.runId, account_id: randomUUID() } as never)).rejects.toMatchObject({ code: "invalid_input" });
    expect(await count(db.admin, `SELECT 1 FROM spec_corrections WHERE account_id = $1`, [t.accountId])).toBe(0);
  });
});
