import type { SeedRefs } from "@fx/db/test/helpers/seed.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startCheckFixRound } from "../../src/checkFix.js";
import { createWorld, failedCheck, failureReasonOf, jobScope, passedCheck, startBuild, stageOf, type World } from "./world.js";

/**
 * PIPELINE-SCENARIO-HARNESS, scenario 1 [pg]: a check fails in a test the Spec did not list but whose imports reach the change. The first fix round's job names
 * that test beside the Spec's patterns, so the runner and the done check let the one-file fix through; a second round, failing on another linked test, still
 * carries the first test (the pull request holds that edit and done judges the whole of it).
 */
describe("scenario: a check-fix chain over import-linked tests outside the Spec's list [pg]", { timeout: 90_000 }, () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });
  afterAll(async () => {
    await w.close();
  });

  const SPEC = ["src/widget/total.ts", "src/widget/total.test.ts"];
  const LINKED_A = "src/report/summaryA.test.ts";
  const LINKED_B = "src/report/summaryB.test.ts";

  it("round 1 is allowed the linked test A, round 2 (failing on linked test B) is allowed A and B, and a passing round 2 opens the pull request", async () => {
    const a: SeedRefs = await w.account();
    const item = await w.itemWithSpec(a, SPEC);
    const runner = await w.runner(a);

    // The build: the runner's check fails in test A, which imports the changed code but is not in the Spec's list.
    const build = await startBuild(w, a, item);
    const claimed = await runner.claim(build);
    expect(await jobScope(w, build)).toEqual(SPEC);
    const first = await runner.finish(claimed, { files: ["src/widget/total.ts"], check: failedCheck({ failed: [LINKED_A], changed: ["src/widget/total.ts"], linked: [LINKED_A] }) });
    expect(first.status).toBe(200);
    expect(await failureReasonOf(w, build)).toBe("check_failed");

    // Fix round 1: the real fix-round start. The job's scope is the Spec's list plus the one linked test, and the Spec's own row is untouched.
    const r1 = await startCheckFixRound(w.checkFixDeps(a.accountId), { accountId: a.accountId, workItemId: item }, build);
    if (!r1.ok) throw new Error(`round 1 refused: ${r1.reason}`);
    expect(await jobScope(w, r1.runId)).toEqual([...SPEC, LINKED_A]);
    expect((await w.admin.query("SELECT frontmatter->'acceptance_files' AS f FROM spec_versions WHERE work_item_id = $1", [item])).rows[0].f).toEqual(SPEC);

    // Round 1 fixes A, then the check fails in B, another linked test.
    const c1 = await runner.claim(r1.runId);
    await runner.finish(c1, { files: ["src/widget/total.ts", LINKED_A], check: failedCheck({ failed: [LINKED_B], changed: ["src/widget/total.ts", LINKED_A], linked: [LINKED_B] }) });
    expect(await failureReasonOf(w, r1.runId)).toBe("check_failed");

    // Fix round 2 carries A forward and adds B.
    const r2 = await startCheckFixRound(w.checkFixDeps(a.accountId), { accountId: a.accountId, workItemId: item }, r1.runId);
    if (!r2.ok) throw new Error(`round 2 refused: ${r2.reason}`);
    expect(await jobScope(w, r2.runId)).toEqual([...SPEC, LINKED_A, LINKED_B]);

    // Round 2 passes with both test edits in the pull request: not a scope violation, the run succeeds and the item is at the pull request.
    const c2 = await runner.claim(r2.runId);
    const done = await runner.finish(c2, { files: ["src/widget/total.ts", LINKED_A, LINKED_B], check: passedCheck() });
    expect(done.body).toMatchObject({ outcome: "succeeded" });
    expect(await failureReasonOf(w, r2.runId)).toBeNull();
    expect(runner.repo.pulls).toHaveLength(1);
    expect(await stageOf(w, a, item)).not.toBe("failed");
  });

  it("a linked test the runner's older protocol reported is not granted: the round starts with the Spec's list alone", async () => {
    const a = await w.account();
    const item = await w.itemWithSpec(a, SPEC);
    const old = await w.runner(a, 18);
    const build = await startBuild(w, a, item);
    const claimed = await old.claim(build);
    await old.finish(claimed, { files: ["src/widget/total.ts"], check: failedCheck({ failed: [LINKED_A], changed: ["src/widget/total.ts"], linked: [LINKED_A] }) });
    const r1 = await startCheckFixRound(w.checkFixDeps(a.accountId), { accountId: a.accountId, workItemId: item }, build);
    // A protocol-18 runner writes no end-of-header marker, so its summary's graph line cannot be told from output and nothing is taken from it: the round starts as it did before the grant.
    if (!r1.ok) throw new Error(`round refused: ${r1.reason}`);
    expect(await jobScope(w, r1.runId)).toEqual(SPEC);
  });
});
