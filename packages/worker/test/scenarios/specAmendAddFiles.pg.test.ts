import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publishAmendment } from "@fx/pipeline";
import { acceptCorrection } from "@fx/core/src/corrections/accept.js";
import { createCorrection } from "@fx/core/src/corrections/index.js";
import { createRecordingRunActionSignal } from "@fx/core/src/runActions/index.js";
import { createAdvanceModule } from "../../src/advance.js";
import { createRunActionFacade } from "../../src/runActions.js";
import { buildFailed, createWorld, failureReasonOf, jobScope, passedCheck, stageOf, startBuild, type World } from "./world.js";

/**
 * PIPELINE-SCENARIO-HARNESS, scenario 2 [pg]: the Spec's file list misses a file the change needs. The build ends scope_violation; a person's Spec amendment
 * that adds the file is created, accepted and delivered through the real correction, run-action and publish path; the next Spec version's list holds the
 * file, the next build is pinned to it and its job scope names it, and the same change then passes the done check.
 */
describe("scenario: a Spec amendment adds the file the Spec missed [pg]", { timeout: 90_000 }, () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });
  afterAll(async () => {
    await w.close();
  });

  const SOURCE = "src/widget/total.ts";
  const MISSED = "src/widget/total.test.ts";

  it("build 1 ends scope_violation on the missed file; the amendment publishes version 2 with it; build 2 is pinned to version 2 and passes", async () => {
    const a = await w.account();
    const item = await w.itemWithSpec(a, [SOURCE]);
    const runner = await w.runner(a);

    const build1 = await startBuild(w, a, item);
    const c1 = await runner.claim(build1);
    expect(await jobScope(w, build1)).toEqual([SOURCE]);
    const first = await runner.finish(c1, { files: [SOURCE, MISSED], check: passedCheck() });
    expect(first.body).toMatchObject({ outcome: "failed", failure_reason: "scope_violation" });
    expect(await failureReasonOf(w, build1)).toBe("scope_violation");
    // The driver reads the failed build and hands the item to a person.
    expect(await buildFailed(w, a, item, build1, "scope_violation")).toEqual({ status: "recorded", stage: "needs_human" });

    // The person proposes the amendment with the file, accepts it, and the worker delivers it: no agent runs.
    const ctx = { pool: w.appPool, principal: { accountId: a.accountId, userId: a.userId } };
    const proposed = await createCorrection(ctx, { workItemId: item, kind: "spec_amend", body: "The total's test belongs to this change.", addFiles: [MISSED] });
    const signal = createRecordingRunActionSignal();
    const accepted = await acceptCorrection(ctx, { id: proposed.id, via: "workspace" }, { signal, itemKinds: [], createItem: async () => undefined });
    expect(accepted.correction.status).toBe("accepted");
    const actionId = signal.sent[0]!.actionId;
    expect(await createRunActionFacade(w.writerPool, {} as never).claimRunAction(actionId, 600)).not.toBeNull();
    const worker = createAdvanceModule(w.writerPool, { starter: null, resolveRunSeat: (async () => ({ ok: false, reason: "unused" })) as never, startAdvance: null, triage: null, amendSpec: publishAmendment });
    expect(await worker.performAmendSpec(actionId)).toEqual({ result: "done", outcome: { work_item_id: item, amended: 1, version: 2 } });

    const versions = (await w.admin.query<{ version: number; frontmatter: { acceptance_files: string[] } }>("SELECT version, frontmatter FROM spec_versions WHERE work_item_id = $1 ORDER BY version", [item])).rows;
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0]!.frontmatter.acceptance_files).toEqual([SOURCE]);
    expect(versions[1]!.frontmatter.acceptance_files).toEqual([SOURCE, MISSED]);
    expect(await stageOf(w, a, item)).toBe("spec_ready");

    // Build 2 reads version 2: pinned to it, scope holds the file, and the same two-file change now succeeds.
    const build2 = await startBuild(w, a, item);
    const pinned = (await w.admin.query<{ version: number }>("SELECT s.version FROM agent_runs r JOIN spec_versions s ON s.id = r.spec_version_id WHERE r.id = $1", [build2])).rows[0]!;
    expect(pinned.version).toBe(2);
    const c2 = await runner.claim(build2);
    expect(await jobScope(w, build2)).toEqual([SOURCE, MISSED]);
    const second = await runner.finish(c2, { files: [SOURCE, MISSED], check: passedCheck() });
    expect(second.body).toMatchObject({ outcome: "succeeded" });
    expect(runner.repo.pulls.some((p) => p.state === "open")).toBe(true);
  });
});
