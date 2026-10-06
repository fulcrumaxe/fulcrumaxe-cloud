import { describe, expect, it, vi } from "vitest";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedTenant, ctxFor, seedWorkItemAt, seedRunOn, seedSpecVersion, count } from "./helpers/kit.js";
import { setStage, isHumanOnlyTransition } from "../src/stages.js";
import { WORK_ITEM_STAGES, WORK_ITEM_STAGE_TRANSITIONS } from "@fx/core/src/work-items/stages.js";
import { ForbiddenError, NotFoundError } from "@fx/core/src/tenancy/errors.js";

// Wrap the real recordStage so one test can inject a failure AFTER it has
// returned (criterion 5), and another can assert it received the
// transaction's own client. Every other call passes straight through.
const recordStageSpy = vi.hoisted(() => ({ failAfterReturn: false, calls: [] as unknown[][] }));
vi.mock("@fx/core/src/work-items/recordStage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fx/core/src/work-items/recordStage.js")>();
  return {
    ...actual,
    recordStage: async (...args: Parameters<typeof actual.recordStage>) => {
      recordStageSpy.calls.push(args);
      const result = await actual.recordStage(...args);
      if (recordStageSpy.failAfterReturn) throw new Error("injected after recordStage returned");
      return result;
    },
  };
});

/** The Conventions' human-only list, written out independently of the implementation. */
function expectedHumanOnly(from: string, to: string, provenance: "internal" | "external"): boolean {
  if (from === "needs_human") return true; // HT-1
  if (from === "closed") return true; // HT-2
  if (provenance === "external" && (from === "triaged" || from === "discussing") && to === "spec_ready") return true; // HT-3
  if (from === "spec_ready" && to === "closed") return true; // HT-4
  if (provenance === "external" && (from === "triaged" || from === "closed_unmerged") && to === "in_progress") return true; // HT-5
  return false;
}

describe("stages.ts", () => {
  it("isHumanOnlyTransition matches the Conventions' HT-1..HT-5 for every (from, to, provenance)", () => {
    for (const from of WORK_ITEM_STAGES) {
      for (const to of WORK_ITEM_STAGES) {
        for (const provenance of ["internal", "external"] as const) {
          expect(isHumanOnlyTransition(from, to, provenance), `${from} -> ${to} (${provenance})`).toBe(
            expectedHumanOnly(from, to, provenance),
          );
        }
      }
    }
    // Fail closed on a provenance value outside the vocabulary.
    expect(isHumanOnlyTransition("triaged", "spec_ready", "something-else")).toBe(true);
    expect(isHumanOnlyTransition("triaged", "in_progress", "something-else")).toBe(true);
    expect(isHumanOnlyTransition("closed_unmerged", "in_progress", "something-else")).toBe(true);
    // The exact expected set, spelled out as data (not derived from expectedHumanOnly above).
    const humanOnly: string[] = [];
    for (const from of WORK_ITEM_STAGES) {
      for (const to of WORK_ITEM_STAGES) {
        for (const provenance of ["internal", "external"] as const) {
          if (isHumanOnlyTransition(from, to, provenance)) humanOnly.push(`${provenance}:${from}->${to}`);
        }
      }
    }
    const both = ["internal", "external"] as const;
    const exactly = [
      ...WORK_ITEM_STAGES.flatMap((to) => both.map((p) => `${p}:needs_human->${to}`)), // HT-1
      ...WORK_ITEM_STAGES.flatMap((to) => both.map((p) => `${p}:closed->${to}`)), // HT-2
      "external:triaged->spec_ready", // HT-3
      "external:discussing->spec_ready", // HT-3
      "internal:spec_ready->closed", // HT-4
      "external:spec_ready->closed", // HT-4
      "external:triaged->in_progress", // HT-5
      "external:closed_unmerged->in_progress", // HT-5
    ];
    expect([...humanOnly].sort()).toEqual([...exactly].sort());
  });
});

describe("stages.ts [pg]", () => {
  const db = pgHarness();
  const ctx = (p: Parameters<typeof ctxFor>[1]) => ctxFor(db.appUserPool, p);

  async function stageOf(id: string): Promise<string> {
    const { rows } = await db.admin.query(`SELECT stage FROM work_items WHERE id = $1`, [id]);
    return rows[0].stage;
  }
  const transitions = (id: string) => count(db.admin, `SELECT 1 FROM work_item_transitions WHERE work_item_id = $1`, [id]);

  // [from, to, provenance]: one representative per human-only rule, plus edges that are NOT human-only.
  const HUMAN_ONLY: Array<[string, string, "internal" | "external", string]> = [
    ["needs_human", "in_progress", "internal", "HT-1"],
    ["needs_human", "discussing", "internal", "HT-1"],
    ["closed", "triaged", "internal", "HT-2"],
    ["triaged", "spec_ready", "external", "HT-3"],
    ["discussing", "spec_ready", "external", "HT-3"],
    ["spec_ready", "closed", "internal", "HT-4"],
    ["triaged", "in_progress", "external", "HT-5"],
    ["closed_unmerged", "in_progress", "external", "HT-5"],
  ];

  it("criterion 5: HT-1..HT-5 are refused with forbidden for system, member, token and run, and only an owner/admin session writes the transition", async () => {
    const t = await seedTenant(db.admin);
    for (const [from, to, provenance, rule] of HUMAN_ONLY) {
      const wi = await seedWorkItemAt(db.admin, t.accountId, from, { provenance });
      if (to === "spec_ready") await seedSpecVersion(db.admin, t.accountId, wi);
      const run = await seedRunOn(db.admin, t.accountId, wi);
      for (const p of [t.system, t.member, t.tokenWrite, t.tokenRead, run]) {
        await expect(setStage(ctx(p), { workItemId: wi, toStage: to as never }), `${rule} as ${p.kind}`).rejects.toBeInstanceOf(ForbiddenError);
      }
      expect(await transitions(wi), rule).toBe(0);
      expect(await stageOf(wi), rule).toBe(from);

      const by = rule === "HT-2" ? t.admin : t.owner;
      await expect(setStage(ctx(by), { workItemId: wi, toStage: to as never })).resolves.toMatchObject({ recorded: true });
      expect(await stageOf(wi)).toBe(to);
      expect(await transitions(wi)).toBe(1);
    }
  });

  it("criterion 5: a transition off the human-only list is open to system and owner/admin, and refused for member, token and run", async () => {
    const t = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "in_progress");
    const run = await seedRunOn(db.admin, t.accountId, wi);
    for (const p of [t.member, t.tokenWrite, run]) {
      await expect(setStage(ctx(p), { workItemId: wi, toStage: "pr_opened" })).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await transitions(wi)).toBe(0);
    await expect(setStage(ctx(t.system), { workItemId: wi, toStage: "pr_opened" })).resolves.toMatchObject({ recorded: true });
    await expect(setStage(ctx(t.admin), { workItemId: wi, toStage: "changes_requested", reviewer: "code" })).resolves.toMatchObject({ recorded: true });
    await expect(setStage(ctx(t.owner), { workItemId: wi, toStage: "review_passed", reviewer: "security" })).resolves.toMatchObject({ recorded: true });
    expect(await stageOf(wi)).toBe("review_passed");
    expect(await transitions(wi)).toBe(3);

    // An internal-provenance triaged -> spec_ready is not HT-3, so system may write it.
    const internal = await seedWorkItemAt(db.admin, t.accountId, "triaged");
    await seedSpecVersion(db.admin, t.accountId, internal);
    await expect(setStage(ctx(t.system), { workItemId: internal, toStage: "spec_ready" })).resolves.toMatchObject({ recorded: true });
  });

  it("every legal edge of D#45's graph is accepted for a session owner (non human-only and human-only alike), and every illegal one is illegal_transition", async () => {
    const t = await seedTenant(db.admin);
    for (const from of WORK_ITEM_STAGES) {
      for (const to of WORK_ITEM_STAGES) {
        const wi = await seedWorkItemAt(db.admin, t.accountId, from);
        if (to === "spec_ready") await seedSpecVersion(db.admin, t.accountId, wi);
        const needsReviewer = to === "changes_requested" || to === "review_passed";
        const call = setStage(ctx(t.owner), { workItemId: wi, toStage: to, reviewer: needsReviewer ? "code" : undefined });
        if ((WORK_ITEM_STAGE_TRANSITIONS[from] as readonly string[]).includes(to)) {
          await expect(call, `${from} -> ${to}`).resolves.toMatchObject({ recorded: true });
        } else {
          await expect(call, `${from} -> ${to}`).rejects.toMatchObject({ code: "illegal_transition" });
          expect(await transitions(wi)).toBe(0);
          expect(await stageOf(wi)).toBe(from);
        }
      }
    }
  });

  it("invalid input: unknown stage, wrong reviewer usage and a missing/malformed/foreign work item", async () => {
    const t = await seedTenant(db.admin);
    const other = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "in_progress");
    await expect(setStage(ctx(t.owner), { workItemId: wi, toStage: "nonsense" as never })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(setStage(ctx(t.owner), { workItemId: wi, toStage: "pr_opened", reviewer: "code" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(setStage(ctx(t.owner), { workItemId: wi, toStage: "pr_opened", reviewer: "nobody" as never })).rejects.toMatchObject({ code: "invalid_input" });
    await db.admin.query(`UPDATE work_items SET stage = 'pr_opened' WHERE id = $1`, [wi]);
    await expect(setStage(ctx(t.owner), { workItemId: wi, toStage: "review_passed" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(setStage(ctx(t.owner), { workItemId: "not-a-uuid", toStage: "closed" })).rejects.toBeInstanceOf(NotFoundError);
    // Another tenant's work item reads as missing, and stays untouched.
    await expect(setStage(ctx(other.owner), { workItemId: wi, toStage: "merged" })).rejects.toBeInstanceOf(NotFoundError);
    expect(await stageOf(wi)).toBe("pr_opened");
    expect(await transitions(wi)).toBe(0);
    await expect(setStage(ctx(t.owner), { workItemId: wi, toStage: "merged", accountId: other.accountId } as never)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("a repeated sourceRef is reported as a duplicate and writes nothing", async () => {
    const t = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "in_progress");
    await expect(setStage(ctx(t.system), { workItemId: wi, toStage: "pr_opened", sourceRef: "pr-1" })).resolves.toMatchObject({ recorded: true });
    await expect(setStage(ctx(t.system), { workItemId: wi, toStage: "pr_opened", sourceRef: "pr-1" })).resolves.toEqual({ recorded: false, reason: "duplicate" });
    expect(await transitions(wi)).toBe(1);
  });

  it("criterion 5: recordStage runs on the transaction's own client, and an error injected after it returns rolls back the transition row and the stage change", async () => {
    const t = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "in_progress");

    recordStageSpy.calls.length = 0;
    recordStageSpy.failAfterReturn = true;
    try {
      await expect(setStage(ctx(t.system), { workItemId: wi, toStage: "pr_opened" })).rejects.toThrow("injected after recordStage returned");
    } finally {
      recordStageSpy.failAfterReturn = false;
    }
    expect(recordStageSpy.calls).toHaveLength(1);
    const [client, input] = recordStageSpy.calls[0]! as [{ query: unknown }, { workItemId: string; toStage: string }];
    expect(typeof client.query).toBe("function");
    expect(input).toMatchObject({ workItemId: wi, toStage: "pr_opened" });
    expect(await transitions(wi)).toBe(0);
    expect(await stageOf(wi)).toBe("in_progress");

    // Control: without the injection the same call commits both.
    await setStage(ctx(t.system), { workItemId: wi, toStage: "pr_opened" });
    expect(await transitions(wi)).toBe(1);
    expect(await stageOf(wi)).toBe("pr_opened");
  });
});
