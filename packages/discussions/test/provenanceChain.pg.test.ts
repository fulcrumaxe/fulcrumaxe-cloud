import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedTenant, seedWorkItemAt, forceParentId } from "./helpers/kit.js";
import { effectiveProvenance } from "../src/provenance.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { isEffectivelyInternal, readProvenanceChain } from "@fx/core/src/work-items/provenanceChain.js";
import { checkRetryAuthor, type IssueAuthorLookup } from "@fx/core/src/runActions/authorCheck.js";

// D#31 API-6b-3 X2: effectiveProvenance is rebuilt on the chain query that moved into @fx/core. The existing
// provenance/stages/specs tests are the pin that results did not change; this one shows that the stage/spec gate
// and the retry author check read the same chain and agree on every fixture shape.
describe("provenance chain: one walk, two readers [pg]", () => {
  const db = pgHarness();

  it("effectiveProvenance, the chain summary and the retry author check agree on internal, external, cycle and missing-parent fixtures", async () => {
    const t = await seedTenant(db.admin);
    const root = await seedWorkItemAt(db.admin, t.accountId, "triaged", { provenance: "internal" });
    const internalLeaf = await seedWorkItemAt(db.admin, t.accountId, "triaged", { provenance: "internal", parentId: root });
    const externalRoot = await seedWorkItemAt(db.admin, t.accountId, "triaged", { provenance: "external" });
    const externalLeaf = await seedWorkItemAt(db.admin, t.accountId, "triaged", { provenance: "internal", parentId: externalRoot });
    const cycleA = await seedWorkItemAt(db.admin, t.accountId, "triaged", { provenance: "internal" });
    const cycleB = await seedWorkItemAt(db.admin, t.accountId, "triaged", { provenance: "internal", parentId: cycleA });
    await db.admin.query(`UPDATE work_items SET parent_id = $2 WHERE id = $1`, [cycleA, cycleB]);
    const orphan = await seedWorkItemAt(db.admin, t.accountId, "triaged", { provenance: "internal" });
    await forceParentId(db.admin, orphan, randomUUID());

    const fixtures: Array<[string, string, "internal" | "external"]> = [
      ["internal chain", internalLeaf, "internal"],
      ["external root", externalLeaf, "external"],
      ["cycle", cycleB, "external"],
      ["missing parent", orphan, "external"],
      ["unknown id", randomUUID(), "external"],
    ];
    for (const [label, id, expected] of fixtures) {
      const chain = await withTenant(db.appUserPool, t.accountId, (client) => readProvenanceChain(client, id));
      const effective = await withTenant(db.appUserPool, t.accountId, (client) => effectiveProvenance(client, id));
      expect(effective, label).toBe(expected);
      expect(isEffectivelyInternal(chain), label).toBe(expected === "internal");

      const calls: unknown[] = [];
      const lookup: IssueAuthorLookup = async (req) => {
        calls.push(req);
        return { status: "missing" };
      };
      const verdict = await checkRetryAuthor({ pool: db.appUserPool, accountId: t.accountId, userId: (t.member as { userId: string }).userId, workItemId: id, lookup, allowlist: [] });
      // Internal: trusted with no GitHub call. Anything the walk calls external is never trusted here.
      if (expected === "internal") {
        expect(verdict, label).toBe("trusted");
        expect(calls, label).toEqual([]);
      } else {
        expect(verdict, label).not.toBe("trusted");
      }
    }
  });
});
