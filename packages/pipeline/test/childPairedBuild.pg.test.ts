import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { plannedFixture, type PlannedFixture } from "@fx/db/test/helpers/plannedChildren.js";
import { startBuildForItem } from "../src/advance/buildTesting.js";
import type { AdvanceRunOutcome, AdvanceRunPorts, AdvanceRunRequest, AdvanceRunStart } from "../src/advance/runPorts.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * [pg] D#483 S5-b2c-4, acceptance 1: a launched planned PR child on a repository paired with a public one starts its executor run. The refusal the build used to answer for it is gone, and no
 * code path answers it any more (a search of every source file). The child's public-change record is its own, one row, and the parent gets none.
 */
const h = pgHarness();
const PARENT_NUMBER = 41;
const BASE = "a".repeat(40);
const planeBase = { defaultHead: async () => BASE };

class World implements AdvanceRunPorts {
  readonly requests: AdvanceRunRequest[] = [];
  private readonly byStep = new Map<string, string>();
  constructor(private readonly accountId: string, private readonly workItemId: string) {}
  async startRun(req: AdvanceRunRequest): Promise<AdvanceRunStart> {
    this.requests.push(req);
    const known = this.byStep.get(req.step);
    if (known) return { ok: true, runId: known };
    const id = randomUUID();
    await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, spec_version_id) VALUES ($1, $2, $3, $4, 'production', 'running', $5)`, [id, this.accountId, this.workItemId, req.role, req.specVersionId ?? null]);
    this.byStep.set(req.step, id);
    return { ok: true, runId: id };
  }
  async findStep(prefix: string): Promise<{ step: string; runId: string } | null> {
    for (const [step, runId] of this.byStep) if (step === prefix) return { step, runId };
    return null;
  }
  async outcome(): Promise<AdvanceRunOutcome> {
    return { status: "running", done: false, envelope: null };
  }
  async cancel(): Promise<void> {}
}

async function pairedKid(): Promise<{ f: PlannedFixture; childId: string; world: World }> {
  const f = await plannedFixture(h.admin, h.pureAppUserPool, { dial: null, weeklyUsd: null });
  await h.admin.query("UPDATE repos SET gh_owner = 'customer-co', gh_name = 'storefront' WHERE id = $1", [f.t.repoId]);
  await h.admin.query("UPDATE work_items SET gh_number = $2 WHERE id = $1", [f.parent, PARENT_NUMBER]);
  await h.admin.query(`INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'customer-co/storefront-public', ARRAY['docs/ops/'])`, [f.t.repoId, f.t.accountId]);
  const childId = f.kids["api"]!;
  await h.admin.query("UPDATE work_items SET envelope_id = (SELECT envelope_id FROM work_items WHERE id = $2) WHERE id = $1", [childId, f.parent]);
  return { f, childId, world: new World(f.t.accountId, childId) };
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "dist" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe("a planned PR child on a paired repository [pg]", { timeout: 60_000 }, () => {
  it("S5b2c4-1: the build starts the executor run on the child's own branch, writes the child's own public-change record (and none for the parent), and answers no unsupported-repository refusal", async () => {
    const k = await pairedKid();
    const out = await startBuildForItem(h.runWriterPool, k.f.t.accountId, k.childId, randomUUID(), k.world, { planeBase });
    expect(out).toMatchObject({ status: "started", branch: "fx/41-api" });
    expect(out).not.toMatchObject({ status: "refused" });
    expect(k.world.requests).toHaveLength(1);
    expect(k.world.requests[0]!.role).toBe("executor");
    expect(k.world.requests[0]!.prompt).toContain("fx/41-api");
    expect(k.world.requests[0]!.prompt).not.toContain("fx/issue-");
    // one record, the child's, branch fx/p-<its own id>, building; the parent has none
    const rows = (await h.admin.query<{ work_item_id: string; id: string; branch: string; state: string; code_repo: string }>("SELECT work_item_id, id, branch, state, code_repo FROM plane_pushes WHERE account_id = $1", [k.f.t.accountId])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ work_item_id: k.childId, state: "building", code_repo: "customer-co/storefront-public", branch: `fx/p-${rows[0]!.id}` });
    // the run recorded the child's branch, once
    const ev = await h.admin.query(`SELECT e.payload FROM run_events e JOIN agent_runs r ON r.id = e.run_id WHERE r.work_item_id = $1 AND e.kind = 'child.binding'`, [k.childId]);
    expect(ev.rows.map((r) => r.payload)).toEqual([{ branch: "fx/41-api" }]);
  });

  it("S5b2c4-1: no source file answers the refusal any more", () => {
    const code = "child_paired_repo_unsupported";
    const found = [...sources(path.join(ROOT, "packages")), ...sources(path.join(ROOT, "apps"))].filter((f) => !f.endsWith("childPairedBuild.pg.test.ts") && readFileSync(f, "utf8").includes(code));
    expect(found.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});
