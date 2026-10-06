import { describe, expect, it } from "vitest";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedTenant, ctxFor, count } from "./helpers/kit.js";
import { createDiscussion, DISCUSSION_KINDS, isBuildableKind } from "../src/discussions.js";
import { publishSpec } from "../src/specs.js";

describe("question and project kinds [pg] (D#2 H27a)", () => {
  const db = pgHarness();
  const ctx = (p: Parameters<typeof ctxFor>[1]) => ctxFor(db.appUserPool, p);

  it("DISCUSSION_KINDS equals the discussions.kind CHECK in the database (parity)", async () => {
    const { rows } = await db.admin.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'discussions'::regclass AND conname = 'discussions_kind_check'`,
    );
    const inDb = [...rows[0]!.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!).sort();
    expect(inDb).toEqual([...DISCUSSION_KINDS].sort());
    expect(inDb).toEqual(expect.arrayContaining(["question", "project"]));
  });

  it("a member can create a question and a project, and an unknown kind is still refused", async () => {
    const t = await seedTenant(db.admin);
    for (const kind of ["question", "project"] as const) {
      const d = await createDiscussion(ctx(t.member), { title: `a ${kind}`, kind, body: "b" });
      expect(d.kind).toBe(kind);
    }
    await expect(createDiscussion(ctx(t.member), { title: "x", kind: "epic" as never, body: "b" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("isBuildableKind: only question and project are unbuildable", () => {
    expect(DISCUSSION_KINDS.filter((k) => !isBuildableKind(k))).toEqual(["question", "project"]);
  });

  it("publishSpec on a question is kind_not_buildable for every principal and every stage it may be at; nothing is written", async () => {
    const t = await seedTenant(db.admin);
    const q = await createDiscussion(ctx(t.owner), { title: "how does X work?", kind: "question", body: "b" });
    for (const stage of ["triaged", "discussing"]) {
      await db.admin.query(`UPDATE work_items SET stage = $2 WHERE id = $1`, [q.rootWorkItemId, stage]);
      for (const p of [t.owner, t.admin, t.system]) {
        await expect(publishSpec(ctx(p), { workItemId: q.rootWorkItemId, body: "Spec" })).rejects.toMatchObject({ code: "kind_not_buildable" });
      }
      expect(await count(db.admin, `SELECT 1 FROM spec_versions WHERE work_item_id = $1`, [q.rootWorkItemId])).toBe(0);
      const { rows } = await db.admin.query(`SELECT stage FROM work_items WHERE id = $1`, [q.rootWorkItemId]);
      expect(rows[0].stage).toBe(stage);
    }
  });

  it("publishSpec on a project publishes its plan and moves it to spec_ready (a feature still does too)", async () => {
    const t = await seedTenant(db.admin);
    for (const kind of ["project", "feature"] as const) {
      const d = await createDiscussion(ctx(t.owner), { title: `a ${kind}`, kind, body: "b" });
      await expect(publishSpec(ctx(t.owner), { workItemId: d.rootWorkItemId, body: "Plan" })).resolves.toMatchObject({ version: 1 });
      const { rows } = await db.admin.query(`SELECT stage FROM work_items WHERE id = $1`, [d.rootWorkItemId]);
      expect(rows[0].stage).toBe("spec_ready");
    }
  });
});
