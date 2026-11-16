import type { SeedRefs } from "@fx/db/test/helpers/seed.js";
import { PlanePushTokenReply } from "@fulcrumaxe/runner-protocol";
import { getWorkItemActivity } from "@fx/core/src/work-items/activity.js";
import { PUBLIC_CHANGE_REFUSAL_REASON } from "@fx/core/src/repos/publicChangeCopy.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorld, passedCheck, stageOf, startBuild, type Held, type Runner, type World } from "./world.js";

/**
 * PIPELINE-SCENARIO-HARNESS, scenario 3 [pg]: two paired items change the same generated file. The first one's public pull request is merged, so the second item's update of its own
 * public pull request is refused `base_diverged` (the public repository changed the same file since its build started) and the item goes to a person. A round that changes nothing then
 * asks to publish the pending head: it is refused again while the public base is still diverged, and once the public tip has been synced into the private branch it is granted and the
 * update lands. The card says why the update was refused, in the closed words of the stored code, and the first item is never touched.
 *
 * What is real: the builds, the claim and done routes, the push token and report routes over the real fence and the real `plane_pushes` and attempt rows, the item card (`getWorkItemActivity`)
 * and the issuer that signs each round's base. By hand: the fixture account, pairing and runner, the runner's own words (its push and its refusal), and the start of the update rounds
 * (the harness runs no review driver, see `startUpdateRound`). Fictional paths only.
 */
const GEN = "gen/catalog.generated.ts";
const HEAD_X = "a".repeat(40);
const HEAD_Y = "b".repeat(40);
const HEAD_Y2 = "d".repeat(40);

describe("scenario: two paired items change the same generated file [pg]", { timeout: 120_000 }, () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });
  afterAll(async () => {
    await w.close();
  });

  const row = async (item: string) => (await w.admin.query("SELECT state, head_sha, tip_sha, pr_number, branch FROM plane_pushes WHERE work_item_id = $1", [item])).rows[0];
  const attemptsOf = async (item: string) => (await w.admin.query("SELECT kind, outcome FROM plane_push_attempts WHERE plane_push_id = (SELECT id FROM plane_pushes WHERE work_item_id = $1) ORDER BY created_at, attempt_no, id", [item])).rows;
  const factsOf = async (item: string) => (await w.admin.query("SELECT kind, code FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq", [item])).rows;
  const noticeOf = async (a: SeedRefs, item: string) => (await getWorkItemActivity({ pool: w.appPool, principal: { accountId: a.accountId, userId: a.userId } }, item)).notice;

  /** An item built and published for the first time: its build passes, the runner pushes the public branch and opens the pull request, and the run is done. */
  async function published(a: SeedRefs, runner: Runner, files: string[], o: { head: string; pr: number }): Promise<{ item: string; build: Held; branch: string }> {
    const item = await w.itemWithSpec(a, files);
    await w.stampPush(a, item);
    const build = await runner.claim(await startBuild(w, a, item));
    const tip = runner.plane.publicRepo.mainTip;
    const granted = await runner.plane.token(build);
    expect(granted.status).toBe(200);
    const publicBranch = PlanePushTokenReply.parse(granted.body).branch;
    runner.plane.publicRepo.push(publicBranch, o.head, tip);
    expect((await runner.plane.report(build, { phase: "pushed", head_sha: o.head, tip_sha: tip })).status).toBe(200);
    expect((await runner.plane.report(build, { phase: "pr_opened", head_sha: o.head, tip_sha: tip, pr_number: o.pr })).status).toBe(200);
    expect((await runner.finish(build, { files, check: passedCheck() })).status).toBe(200);
    expect(await row(item)).toMatchObject({ state: "pr_opened", head_sha: o.head, pr_number: o.pr });
    return { item, build, branch: `fx/${build.runId}-g${build.g}` };
  }

  /** A fix round of `item` on `parent`'s branch, signed with `base`, claimed by the runner. */
  async function round(a: SeedRefs, runner: Runner, item: string, parent: Held, branch: string, base: string, tag: string): Promise<Held> {
    return runner.claim(await w.startUpdateRound(a, item, parent.runId, { sha: base, branch }, tag));
  }

  /** Both items published, the first one's pull request merged, and the second item's first update round refused `base_diverged` by the runner. */
  async function refusedUpdate() {
    const a = await w.account();
    await w.pairRepo(a);
    const runner = await w.runner(a);
    await w.allowTipPublish(a, runner);
    const pub = runner.plane.publicRepo;

    // Both items change the generated file; both publish while the public tip is the same one.
    const x = await published(a, runner, ["src/catalog/alpha.ts", GEN], { head: HEAD_X, pr: 41 });
    const y = await published(a, runner, ["src/catalog/beta.ts", GEN], { head: HEAD_Y, pr: 42 });
    const xBefore = { row: await row(x.item), attempts: await attemptsOf(x.item), facts: await factsOf(x.item) };

    // The first item's pull request merges: the public main moves and carries its version of the generated file.
    const oldTip = pub.mainTip;
    pub.mainTip = "c".repeat(40);

    // Round 1 for the second item: the runner finds the public tip changed the same file and refuses the update, in its own closed code.
    const r1 = await round(a, runner, y.item, y.build, y.branch, oldTip, "r1");
    const lease = await runner.plane.token(r1);
    expect(lease.status).toBe(200);
    expect(PlanePushTokenReply.parse(lease.body).replaces_head).toBe(HEAD_Y);
    expect((await runner.plane.report(r1, { phase: "refused", code: "base_diverged" })).status).toBe(200);
    expect((await runner.finish(r1, { files: ["src/catalog/beta.ts"], check: passedCheck(), branch: y.branch })).status).toBe(200);
    return { a, runner, pub, x, y, r1, oldTip, xBefore };
  }

  it("the second item's update is refused base_diverged, the item goes to a person, and its card says why in the closed words of the stored code; the first item is untouched", async () => {
    const { a, y, x, xBefore } = await refusedUpdate();
    expect((await attemptsOf(y.item)).slice(1)).toEqual([{ kind: "fix_round", outcome: "base_diverged" }]);
    expect(await row(y.item)).toMatchObject({ state: "pr_opened", head_sha: HEAD_Y });
    expect(await factsOf(y.item)).toEqual([{ kind: "escalated", code: "republish_failed" }]);
    expect(await stageOf(w, a, y.item)).toBe("needs_human");
    const why = PUBLIC_CHANGE_REFUSAL_REASON.base_diverged!;
    const reason = (await noticeOf(a, y.item))!.reason;
    expect(reason).toContain(`Refused: ${why}.`);
    expect(reason).not.toMatch(/base_diverged|republish_|null|undefined/);
    expect({ row: await row(x.item), attempts: await attemptsOf(x.item), facts: await factsOf(x.item) }).toEqual(xBefore);
  });

  it("after the refusal a round that changed nothing is granted the pending head, is refused again while the base is diverged, and lands once the public tip is synced; then nothing is pending", async () => {
    const { a, runner, pub, y, r1, oldTip } = await refusedUpdate();

    // Round 2 changes nothing and asks for the branch tip. The public base is still diverged, so it is refused again.
    const r2 = await round(a, runner, y.item, r1, y.branch, oldTip, "r2");
    const tipGrant = await runner.plane.token(r2, { atTip: true });
    expect(tipGrant.status).toBe(200);
    expect(PlanePushTokenReply.parse(tipGrant.body).replaces_head).toBe(HEAD_Y);
    expect((await runner.plane.report(r2, { phase: "refused", code: "base_diverged" })).status).toBe(200);
    expect((await runner.finish(r2, { files: ["src/catalog/beta.ts"], check: passedCheck(), branch: y.branch })).status).toBe(200);
    expect((await attemptsOf(y.item)).slice(1).map((e) => e.outcome)).toEqual(["base_diverged", "base_diverged"]);

    // The public tip is synced into the private branch. Round 3 changes nothing, asks for the tip, is granted, and the update lands on the open pull request.
    const synced = pub.mainTip;
    const r3 = await round(a, runner, y.item, r2, y.branch, synced, "r3");
    const landed = await runner.plane.token(r3, { atTip: true });
    expect(landed.status).toBe(200);
    const updateBranch = PlanePushTokenReply.parse(landed.body).branch;
    pub.push(updateBranch, HEAD_Y2, synced);
    expect((await runner.plane.report(r3, { phase: "updated", head_sha: HEAD_Y2, tip_sha: synced, branch: updateBranch })).status).toBe(200);
    expect((await runner.finish(r3, { files: ["src/catalog/beta.ts"], check: passedCheck(), branch: y.branch })).status).toBe(200);
    expect(await row(y.item)).toMatchObject({ state: "pr_opened", head_sha: HEAD_Y2, tip_sha: synced, pr_number: 42 });
    expect((await attemptsOf(y.item)).slice(1).map((e) => e.outcome)).toEqual(["base_diverged", "base_diverged", "updated"]);

    // Public carries the change now: a further round that adds nothing is refused the tip and writes nothing.
    const mintsBefore = pub.mints.length;
    const r4 = await round(a, runner, y.item, r3, y.branch, synced, "r4");
    const none = await runner.plane.token(r4, { atTip: true });
    expect(none.status).toBe(409);
    expect(none.body).toMatchObject({ error: { code: "no_changes" } });
    expect(pub.mints.length).toBe(mintsBefore);
    expect((await attemptsOf(y.item)).length).toBe(4);
  });
});
