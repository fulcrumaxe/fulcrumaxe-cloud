import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { stampPlanePush } from "@fx/core/src/repos/planePushRecord.js";
import { raiseBranchPushedByPerson } from "@fx/core/src/setup-requests/branchPushed.js";
import { keepBranch, releaseBranch, replaceBranch } from "@fx/core/src/setup-requests/branchPushedAnswer.js";
import { statusSentence } from "@fx/core/src/setup-requests/copy.js";
import { listSetupRequests } from "@fx/core/src/setup-requests/store.js";
import { checkPublicBranch } from "../src/fixRoundHeads.js";
import { getWorkItemActivity } from "@fx/core/src/work-items/activity.js";
import { FIX_ROUND_STOP_SENTENCE, REPUBLISH_BRANCH_MOVED_SENTENCE, REPUBLISH_FAILED_SENTENCE, REPUBLISH_NO_CHANGE_SENTENCE, REPUBLISH_PAIRING_OFF_SENTENCE, REPUBLISH_PR_CLOSED_SENTENCE, REPUBLISH_PR_MERGED_SENTENCE, REPUBLISH_TIP_MOVED_SENTENCE } from "@fx/core/src/work-items/baseSync.js";
import { generateKeyPairSync } from "node:crypto";
import { createPlanePushApi, createHostedPlanePush, InstallationTokenCache } from "@fx/github";
import { httpsRoundTrip, startStrictGithubServer, type LocalTlsServer } from "../../github/test/helpers/localTlsServer.js";
import { ghError, type GhReply } from "../../github/test/helpers/strictGithub.js";
import { mergeQueue } from "@fx/pipeline";
import { RUNNER_REPLACE_ROUND_KIND, createFakeSandbox, type AgentRuntime, type NetworkPolicyRule, type PlanePublishLine } from "@fx/runner";
import { phaseLine } from "../../runner/src/planePublish/protocol.js";
import { FIX_BASE_EVENT } from "../src/fixRoundBase.js";
import { createPlanePublish, createPublishSettler, type PlanePublishDeps } from "../src/planePublish.js";

/**
 * [pg] FIXROUND-REPUBLISH (R2-c2): the platform's step after a SANDBOX fix round whose item has an open public pull request. It publishes ONE new commit on the current public main to the platform's branch
 * (a compare-and-swap against the stamp, made by the hook and checked again by GitHub) and moves the stamp; every other ending sends the item to a person and leaves the push row as it was. The sandbox is the
 * runner package's strict fake; the hook's real behaviour on real git is tested in packages/runner (planePublishHook.test.ts), and the GitHub side is a recording stand-in with the real port's contract.
 */
describe("a sandbox fix round updates the open public pull request [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  let A: SeedRefs;
  const BASE = "a".repeat(40);
  const FIX_BASE = "f".repeat(40);
  const PRIVATE_HEAD = "b".repeat(40);
  const STAMP = "c".repeat(40);
  const TIP = "d".repeat(40);
  const DEFAULT_TIP = "9".repeat(40);
  const NEW_HEAD = "1".repeat(40);
  const NEW_TIP = "2".repeat(40);
  const POLICY: NetworkPolicyRule[] = [{ host: "gh-proxy.fixture.test", purpose: "github_proxy" }];
  const noRuntime = { start: async () => undefined, stop: async () => undefined, resume: async () => undefined } as unknown as AgentRuntime;

  let fake: ReturnType<typeof createFakeSandbox>;
  let output: () => { exitCode: number; stdout: string };
  let identityMissing = false;
  /** Runs while the sandbox is being started: what a person can do during a round (the round does not look at the row again until it ends). */
  let duringRound: (() => Promise<void>) | null = null;
  let privateHeadOf: () => Promise<string | null>;
  const updated = (): PlanePublishLine => ({ phase: "updated", head_sha: NEW_HEAD, tip_sha: NEW_TIP });
  const say = (...lines: PlanePublishLine[]) => ({ exitCode: 0, stdout: lines.map((l) => phaseLine(l)).join("\n") + "\n" });
  const gh = { pushed: true, verified: [] as Array<{ headSha: string; tipSha: string; branch: string }>, opened: 0 };

  function deps(over: Partial<PlanePublishDeps> = {}): PlanePublishDeps {
    const port = fake.port;
    return {
      pool: writerPool,
      port: { ...port, createSandbox: async (o) => (await duringRound?.(), fake.scriptCommand(o.sandboxName, output()), port.createSandbox(o)) } as PlanePublishDeps["port"],
      hook: () => "// the built hook",
      networkPolicy: async () => POLICY,
      identity: () => (identityMissing ? null : { name: "Fulcrumaxe Bot", email: "bot@example.com" }),
      privateHead: () => privateHeadOf(),
      privateDefaultHead: async () => DEFAULT_TIP,
      hosted: {
        verifyPushed: async (i) => (gh.verified.push({ headSha: i.headSha, tipSha: i.tipSha, branch: i.branch }), gh.pushed),
        verifyPullRequest: async () => ({ url: "https://github.com/acme/widgets-public/pull/9" }),
        pullRequestState: async () => "open",
        openPullRequest: async () => (gh.opened++, { number: 10, url: "https://github.com/acme/widgets-public/pull/10" }),
      },
      now: () => 1_000_000,
      ...over,
    };
  }
  const worker = (over: Partial<PlanePublishDeps> = {}) => createPlanePublish(deps(over));

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });

  const planeRow = async () => (await admin.query("SELECT * FROM plane_pushes WHERE work_item_id = $1", [A.workItemId])).rows[0];
  const attempts = async () => (await admin.query("SELECT * FROM plane_push_attempts WHERE account_id = $1 ORDER BY kind, attempt_no, created_at, id", [A.accountId])).rows;
  const publishRuns = async () => (await admin.query("SELECT id, status, sandbox_name, parent_run_id FROM agent_runs WHERE account_id = $1 AND role = 'plane_publish'", [A.accountId])).rows;
  const facts = async () => (await admin.query("SELECT kind, code FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq", [A.workItemId])).rows;
  const stageOf = async () => (await admin.query("SELECT stage FROM work_items WHERE id = $1", [A.workItemId])).rows[0].stage as string;
  const noticeOf = async () => (await getWorkItemActivity({ pool: adminPool, principal: { accountId: A.accountId, userId: A.userId } }, A.workItemId)).notice;
  const inputOf = () => JSON.parse(fake.state.writtenFiles.filter((f) => f.path.endsWith("input.json")).pop()!.content) as Record<string, unknown>;

  /** A sandbox fix round that finished: it carries the base the cloud brought its branch up to date with (written in its create transaction), like `advanceStartFix` does. */
  async function fixRound(over: { base?: boolean; branch?: string; conflict?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, head_sha) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded', 'sandbox', $4, $5)`,
      [id, A.accountId, A.workItemId, A.repoId, BASE],
    );
    if (over.base !== false) {
      await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, $3, $4)", [A.accountId, id, FIX_BASE_EVENT, JSON.stringify({ base_sha: FIX_BASE, branch: over.branch ?? "fx/issue-42", ...(over.conflict ? { conflict: true } : {}) })]);
    }
    return id;
  }
  const branchRequests = async () =>
    (await admin.query<{ state: string; origin: string; created_by: string | null; seen_head: string }>("SELECT state, origin, created_by, seen_head FROM setup_requests WHERE account_id = $1 AND kind = 'branch_pushed_by_person'", [A.accountId])).rows;
  const settle = (executorRunId: string, over: Partial<PlanePublishDeps> = {}) => worker(over).settlePairedBuild({ accountId: A.accountId, executorRunId });

  beforeEach(async () => {
    fake = createFakeSandbox(noRuntime);
    output = () => say(updated());
    identityMissing = false;
    duringRound = null;
    privateHeadOf = async () => PRIVATE_HEAD;
    Object.assign(gh, { pushed: true, verified: [], opened: 0 });
    A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [A.repoId]);
    await admin.query("UPDATE work_items SET gh_number = 42, title = 'Add a thing', stage = 'changes_requested' WHERE id = $1", [A.workItemId]);
    await admin.query(`INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', ARRAY['docs/ops/'])`, [A.repoId, A.accountId]);
    await withTenant(appPool, A.accountId, (c) => stampPlanePush(c, { accountId: A.accountId, workItemId: A.workItemId, repoId: A.repoId }));
    // The first publication is done: the public pull request is open and the stamp is the head the platform pushed.
    await admin.query(
      "UPDATE plane_pushes SET state = 'pr_opened', head_sha = $2, tip_sha = $3, pr_number = 9, pr_url = 'https://github.com/acme/widgets-public/pull/9' WHERE work_item_id = $1",
      [A.workItemId, STAMP, TIP],
    );
  });

  it("publishes the round: the hook is told the stamp, the signed base, the round's head and the platform's branch, and the verified head and tip become the new stamp on the same pull request", async () => {
    const run = await fixRound();
    const r = await settle(run);
    expect(r).toEqual({ privatePullRequest: "skipped", publish: { kind: "updated", attemptNo: 1 } });
    const branch = (await planeRow()).branch as string;
    expect(inputOf()).toMatchObject({ privateBase: FIX_BASE, privateDefaultTip: DEFAULT_TIP, privateHead: PRIVATE_HEAD, updateOf: STAMP, branch, codeRepo: "acme/widgets-public", own: { owner: "acme", name: "widgets" } });
    expect(gh.verified).toEqual([{ headSha: NEW_HEAD, tipSha: NEW_TIP, branch }]);
    expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: NEW_HEAD, tip_sha: NEW_TIP, source_head: PRIVATE_HEAD, pr_number: 9 });
    // One attempt of its own kind (not one of the three pushes of a first publish), finished, on a publish run that succeeded; no second pull request.
    expect(await attempts()).toEqual([expect.objectContaining({ kind: "fix_round", attempt_no: 1, runtime: "sandbox", outcome: "updated", finished_at: expect.any(Date) })]);
    expect(await publishRuns()).toEqual([expect.objectContaining({ status: "succeeded", parent_run_id: run })]);
    expect(gh.opened).toBe(0);
    expect(await facts()).toEqual([]);
    expect(await stageOf()).toBe("changes_requested");
  });

  it("every round has its attempt: five rounds run five updates numbered on their own, and a replay of one round starts no second sandbox", async () => {
    for (let n = 1; n <= 5; n++) {
      const run = await fixRound();
      expect(await settle(run)).toMatchObject({ publish: { kind: "updated", attemptNo: n } });
      if (n === 1) {
        expect(await settle(run)).toEqual({ privatePullRequest: "skipped", publish: { kind: "skipped", why: "busy" } });
        expect(fake.state.created).toHaveLength(1);
      }
    }
    expect((await attempts()).map((a) => [a.kind, a.attempt_no])).toEqual([1, 2, 3, 4, 5].map((n) => ["fix_round", n]));
  });

  it("a round that carries no base is not an update (nothing is started), and a round on an item with no open public pull request, or one a person took over, publishes nothing", async () => {
    expect(await settle(await fixRound({ base: false }))).toEqual({ privatePullRequest: "skipped", publish: { kind: "skipped", why: "not_paired" } });
    for (const state of ["refused", "building"]) {
      await admin.query("UPDATE plane_pushes SET state = $2, code = CASE WHEN $2 = 'refused' THEN 'scan_refused' END, head_sha = CASE WHEN $2 IN ('building', 'refused') THEN NULL ELSE head_sha END, tip_sha = CASE WHEN $2 IN ('building', 'refused') THEN NULL ELSE tip_sha END, pr_number = CASE WHEN $2 IN ('building', 'refused') THEN NULL ELSE pr_number END, pr_url = CASE WHEN $2 IN ('building', 'refused') THEN NULL ELSE pr_url END WHERE work_item_id = $1", [A.workItemId, state]);
      expect((await settle(await fixRound())).publish, state).toMatchObject({ kind: "skipped" });
    }
    await admin.query("UPDATE plane_pushes SET state = 'pr_opened', head_sha = $2, tip_sha = $3, pr_number = 9, pr_url = 'https://github.com/acme/widgets-public/pull/9', managed_by_person_at = now() WHERE work_item_id = $1", [A.workItemId, STAMP, TIP]);
    expect((await settle(await fixRound())).publish).toEqual({ kind: "skipped", why: "not_paired" });
    expect(fake.state.created).toEqual([]);
    expect(await attempts()).toEqual([]);
    expect(await facts()).toEqual([]);
  });

  it("D#598 P1g-1: a merged or closed public pull request is said in words, in both ways it is recorded: no sandbox, no attempt, the push row untouched, and the item shows the sentence", async () => {
    const cases: Array<[string, string, string, string]> = [
      ["item merged", "UPDATE work_items SET stage = 'merged' WHERE id = $1", "republish_pr_merged", REPUBLISH_PR_MERGED_SENTENCE],
      ["item closed unmerged", "UPDATE work_items SET stage = 'closed_unmerged' WHERE id = $1", "republish_pr_closed", REPUBLISH_PR_CLOSED_SENTENCE],
      ["push row merged", "UPDATE plane_pushes SET state = 'pr_merged' WHERE work_item_id = $1", "republish_pr_merged", REPUBLISH_PR_MERGED_SENTENCE],
      ["push row closed", "UPDATE plane_pushes SET state = 'pr_closed' WHERE work_item_id = $1", "republish_pr_closed", REPUBLISH_PR_CLOSED_SENTENCE],
    ];
    for (const [name, sql, code, sentence] of cases) {
      await admin.query("DELETE FROM work_item_driver_events WHERE work_item_id = $1", [A.workItemId]);
      await admin.query("UPDATE work_items SET stage = 'changes_requested' WHERE id = $1", [A.workItemId]);
      await admin.query("UPDATE plane_pushes SET state = 'pr_opened' WHERE work_item_id = $1", [A.workItemId]);
      await admin.query(sql, [A.workItemId]);
      expect((await settle(await fixRound())).publish, name).toEqual({ kind: "refused", code, attemptNo: null });
      expect(await facts(), name).toEqual([{ kind: "escalated", code }]);
      expect(sentence.startsWith(code === "republish_pr_merged" ? "Public PR already merged" : "Public PR closed")).toBe(true);
      if (name.startsWith("push row")) expect(await stageOf(), name).toBe("needs_human");
      // A terminal item cannot move; its record of the stop is the notice. An item still in review is paused in Needs a person with the same words.
      expect(await noticeOf(), name).toMatchObject({ kind: "public_update_stopped", reason: sentence });
    }
    expect(fake.state.created).toEqual([]);
    expect(await attempts()).toEqual([]);
    // A cancelled item stays a quiet skip.
    await admin.query("DELETE FROM work_item_driver_events WHERE work_item_id = $1", [A.workItemId]);
    await admin.query("UPDATE plane_pushes SET state = 'pr_opened' WHERE work_item_id = $1", [A.workItemId]);
    await admin.query("UPDATE work_items SET stage = 'closed' WHERE id = $1", [A.workItemId]);
    expect((await settle(await fixRound())).publish).toEqual({ kind: "skipped", why: "not_paired" });
    expect(await facts()).toEqual([]);
  });

  it("D#598 P1g-1: the pairing is off while the public pull request is open: the sentence, a pause in Needs a person, nothing pushed", async () => {
    await admin.query("DELETE FROM repo_pairing WHERE repo_id = $1", [A.repoId]);
    expect((await settle(await fixRound())).publish).toEqual({ kind: "refused", code: "republish_pairing_off", attemptNo: null });
    expect(await facts()).toEqual([{ kind: "escalated", code: "republish_pairing_off" }]);
    expect(await stageOf()).toBe("needs_human");
    expect(await noticeOf()).toMatchObject({ kind: "public_update_stopped", reason: REPUBLISH_PAIRING_OFF_SENTENCE });
    expect(fake.state.created).toEqual([]);
    expect(await attempts()).toEqual([]);
    expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: STAMP });
  });

  it("D#598 P1g-1: the public main moved twice (the hook's refusal): republish_tip_moved, said as 'Public main moved, try again', the push row untouched", async () => {
    output = () => say({ phase: "refused", code: "public_tip_moved" });
    expect((await settle(await fixRound())).publish).toMatchObject({ kind: "refused", code: "republish_tip_moved" });
    expect(await facts()).toEqual([{ kind: "escalated", code: "republish_tip_moved" }]);
    expect(await noticeOf()).toMatchObject({ kind: "public_update_stopped", reason: REPUBLISH_TIP_MOVED_SENTENCE });
    expect(REPUBLISH_TIP_MOVED_SENTENCE.startsWith("Public main moved, try again")).toBe(true);
    expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: STAMP, code: null });
  });

  it("D#598 P1g-1: every new stop has a sentence in the item view's table, with no raw code and no null", () => {
    for (const code of ["republish_tip_moved", "republish_pr_closed", "republish_pr_merged", "republish_pairing_off"]) {
      const sentence = FIX_ROUND_STOP_SENTENCE[code]!;
      expect(sentence, code).toMatch(/^[A-Z]/);
      expect(sentence, code).not.toMatch(/republish_|undefined|null|_/);
    }
  });

  it("an item closed after the facts were read but before the attempt is created starts no sandbox either", async () => {
    privateHeadOf = async () => {
      await admin.query("UPDATE work_items SET stage = 'closed_unmerged' WHERE id = $1", [A.workItemId]);
      return PRIVATE_HEAD;
    };
    expect((await settle(await fixRound())).publish).toEqual({ kind: "skipped", why: "not_paired" });
    expect(fake.state.created).toEqual([]);
    expect(await attempts()).toEqual([]);
  });

  it("D#598 P1g-3a: a Keep that arrives during the sandbox run loses to the push, and says so: the update is recorded on the managed row with its new head and a fixed-code event, the managed line names both commits, and the undo asks nobody", async () => {
    const THEIRS = "7".repeat(40);
    const asPerson = { pool: appPool };
    // A person pushed; the request was raised; they confirmed Replace, so the round's lease is on their head.
    const [req] = await withTenant(appPool, A.accountId, async (c) => {
      const raised = await raiseBranchPushedByPerson(c, { workItemId: A.workItemId, seenHead: THEIRS });
      return raised.kind === "not_applicable" ? [] : [raised.request];
    });
    await replaceBranch(asPerson, { accountId: A.accountId, userId: A.userId, id: req!.id, shownHead: THEIRS });
    duringRound = async () => void (await keepBranch(asPerson, { accountId: A.accountId, userId: A.userId, id: req!.id }));
    const run = await fixRound();
    expect(await settle(run)).toMatchObject({ publish: { kind: "updated", attemptNo: 1 } });
    expect(inputOf()).toMatchObject({ updateOf: THEIRS });
    // Keep's managed state stands, and the record is not stale: it holds the head the round put on the branch.
    expect(await planeRow()).toMatchObject({ state: "managed_by_person", head_sha: NEW_HEAD, tip_sha: NEW_TIP, replace_authorized_head: null });
    expect((await planeRow()).managed_by_person_at).not.toBeNull();
    const events = (await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'plane.updated_after_keep'", [run])).rows;
    expect(events).toEqual([{ payload: { code: "updated_after_keep", head: NEW_HEAD, replaced: THEIRS } }]);
    const [line] = (await withTenant(appPool, A.accountId, (c) => listSetupRequests(c, { state: "needs_you" }))).requests;
    const said = statusSentence(line!, { checksAvailable: false })!;
    expect(said).toContain("before your Keep was seen");
    expect(said).toContain(THEIRS.slice(0, 7));
    expect(said).toContain(NEW_HEAD.slice(0, 7));
    expect(line!.reason).not.toContain("Nothing was overwritten");
    // The undo: the branch is where the record says, so nobody is asked and the cloud's own commit is not called theirs.
    expect(await releaseBranch(asPerson, { accountId: A.accountId, userId: A.userId, workItemId: A.workItemId })).toBe(true);
    expect(await checkPublicBranch(writerPool, { publicHead: async () => NEW_HEAD }, { accountId: A.accountId, workItemId: A.workItemId })).toBeNull();
    expect(await branchRequests()).toMatchObject([{ state: "done" }]);
    expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: NEW_HEAD, kept_head: null, kept_replaced_at: null });
  });

  it("D#598 P1g-3a: after a confirmed Replace the hook's lease is the head the person was shown, not the stamp; the update that lands spends the authorization", async () => {
    const SHOWN = "b".repeat(40);
    await admin.query("UPDATE plane_pushes SET replace_authorized_head = $2 WHERE work_item_id = $1", [A.workItemId, SHOWN]);
    const r = await settle(await fixRound());
    expect(r.publish).toEqual({ kind: "updated", attemptNo: 1 });
    expect(inputOf()).toMatchObject({ updateOf: SHOWN });
    expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: NEW_HEAD, replace_authorized_head: null });
  });

  it("D#598 P1g-3a: a push after the confirmation makes the hook's lease fail: the round is refused, the authorization is spent", async () => {
    const SHOWN = "b".repeat(40);
    await admin.query("UPDATE plane_pushes SET replace_authorized_head = $2 WHERE work_item_id = $1", [A.workItemId, SHOWN]);
    output = () => say({ phase: "refused", code: "public_branch_moved" });
    expect((await settle(await fixRound())).publish).toEqual({ kind: "refused", code: "republish_branch_moved", attemptNo: 1 });
    expect(inputOf()).toMatchObject({ updateOf: SHOWN });
    expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: STAMP, replace_authorized_head: null });
  });

  it("the record changing under the attempt (a person takes the branch over, or the stamp moves) after the facts were read starts no sandbox", async () => {
    privateHeadOf = async () => {
      await admin.query("UPDATE plane_pushes SET managed_by_person_at = now() WHERE work_item_id = $1", [A.workItemId]);
      return PRIVATE_HEAD;
    };
    expect((await settle(await fixRound())).publish).toEqual({ kind: "skipped", why: "not_paired" });
    expect(fake.state.created).toEqual([]);
    expect(await attempts()).toEqual([]);
  });

  // D#598 P1g-3a-3: a round a person's Replace started that ends without a landed update is recorded under its Replace code, says so without "Build again", and asks the question again at the live head.
  describe("the round a person's Replace started, ended without a landed update", () => {
    const PERSON = "7".repeat(40);
    const markedRound = async () => {
      const run = await fixRound();
      await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 2, $3, '{}')", [A.accountId, run, RUNNER_REPLACE_ROUND_KIND]);
      return run;
    };
    /** The item's own branch reads as a person's commit; everything else is the default stand-in. */
    const personPushed = async () => ({ ...deps().hosted, branchHead: async () => PERSON });
    it.each([
      ["no change to publish", "republish_replace_no_change", () => say({ phase: "no_change" })],
      ["the public main moved twice", "republish_replace_tip_moved", () => say({ phase: "refused", code: "public_tip_moved" })],
      ["a scan refusal", "republish_replace_failed", () => say({ phase: "refused", code: "scan_refused", refusals: [{ kind: "identifier_hit", place: "src/a.ts:2", rule_key: "identifier-rule#1" }] })],
      ["a hook that crashed", "republish_replace_failed", () => ({ exitCode: 1, stdout: "" })],
    ])("%s: recorded as %s, the authorization is spent, one request is open with the live head, and the sentence does not say to build again", async (_label, code, hook) => {
      output = hook;
      await admin.query("UPDATE plane_pushes SET replace_authorized_head = $2 WHERE work_item_id = $1", [A.workItemId, PERSON]);
      expect((await settle(await markedRound(), { hosted: await personPushed() })).publish).toMatchObject({ kind: "refused", code });
      expect(await facts()).toEqual([{ kind: "escalated", code }]);
      expect(await branchRequests()).toEqual([expect.objectContaining({ state: "open", origin: "derived", seen_head: PERSON })]);
      expect(await planeRow()).toMatchObject({ state: "waiting_person_pushed", head_sha: STAMP, replace_authorized_head: null });
      expect(await noticeOf()).toMatchObject({ reason: FIX_ROUND_STOP_SENTENCE[code] });
      expect(FIX_ROUND_STOP_SENTENCE[code]).not.toMatch(/Build again/);
    });

    it("the publish run cannot start (pending to running is refused): the same Replace code is returned, and the question is raised again", async () => {
      await admin.query("UPDATE plane_pushes SET replace_authorized_head = $2 WHERE work_item_id = $1", [A.workItemId, PERSON]);
      await admin.query("CREATE OR REPLACE FUNCTION pp_block_start() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.role = 'plane_publish' AND NEW.status = 'running' THEN RETURN NULL; END IF; RETURN NEW; END $$");
      await admin.query("CREATE TRIGGER pp_block_start BEFORE UPDATE ON agent_runs FOR EACH ROW EXECUTE FUNCTION pp_block_start()");
      try {
        expect((await settle(await markedRound(), { hosted: await personPushed() })).publish).toMatchObject({ kind: "refused", code: "republish_replace_failed" });
      } finally {
        await admin.query("DROP TRIGGER pp_block_start ON agent_runs");
        await admin.query("DROP FUNCTION pp_block_start()");
      }
      expect(await facts()).toEqual([{ kind: "escalated", code: "republish_replace_failed" }]);
      expect(await branchRequests()).toEqual([expect.objectContaining({ state: "open", seen_head: PERSON })]);
      expect(await planeRow()).toMatchObject({ state: "waiting_person_pushed", replace_authorized_head: null });
    });

    it("refused before any sandbox starts (no platform identity): the same Replace code and the same question again", async () => {
      identityMissing = true;
      await admin.query("UPDATE plane_pushes SET replace_authorized_head = $2 WHERE work_item_id = $1", [A.workItemId, PERSON]);
      expect((await settle(await markedRound(), { hosted: await personPushed() })).publish).toMatchObject({ kind: "refused", code: "republish_replace_failed" });
      expect(await publishRuns()).toEqual([]);
      expect(await facts()).toEqual([{ kind: "escalated", code: "republish_replace_failed" }]);
      expect(await branchRequests()).toEqual([expect.objectContaining({ state: "open", seen_head: PERSON })]);
    });

    it("an ordinary round (no marker) with the same endings keeps its code, its sentence, and raises nothing", async () => {
      output = () => say({ phase: "no_change" });
      expect((await settle(await fixRound(), { hosted: await personPushed() })).publish).toMatchObject({ kind: "refused", code: "republish_no_change" });
      expect(await branchRequests()).toEqual([]);
      expect(await planeRow()).toMatchObject({ state: "pr_opened" });
    });
  });

  describe("every other ending sends the item to a person with a fixed sentence and leaves the push row as it was", () => {
    const unchanged = async () => expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: STAMP, tip_sha: TIP, pr_number: 9, code: null });

    it("the public branch moved (the hook's compare-and-swap refused): republish_branch_moved, and no 'Try the push again' state", async () => {
      output = () => say({ phase: "refused", code: "public_branch_moved" });
      const run = await fixRound();
      expect((await settle(run)).publish).toEqual({ kind: "refused", code: "republish_branch_moved", attemptNo: 1 });
      await unchanged();
      expect(await facts()).toEqual([{ kind: "escalated", code: "republish_branch_moved" }]);
      expect(await stageOf()).toBe("needs_human");
      expect(await noticeOf()).toEqual({ kind: "needs_human", reason: REPUBLISH_BRANCH_MOVED_SENTENCE });
      expect(await attempts()).toEqual([expect.objectContaining({ kind: "fix_round", outcome: "public_branch_moved" })]);
    });

    it("the round changed nothing to publish: republish_no_change", async () => {
      output = () => say({ phase: "no_change" });
      expect((await settle(await fixRound())).publish).toMatchObject({ kind: "refused", code: "republish_no_change" });
      await unchanged();
      expect(await facts()).toEqual([{ kind: "escalated", code: "republish_no_change" }]);
      expect(await noticeOf()).toEqual({ kind: "needs_human", reason: REPUBLISH_NO_CHANGE_SENTENCE });
    });

    it.each([
      ["a scan refusal", () => say({ phase: "refused", code: "scan_refused", refusals: [{ kind: "identifier_hit", place: "src/a.ts:2", rule_key: "identifier-rule#1" }] })],
      ["a hook that crashed", () => ({ exitCode: 1, stdout: "" })],
      ["a first-push line where an update was asked", () => say({ phase: "pr_opened", head_sha: NEW_HEAD, tip_sha: NEW_TIP, pr_number: 11 })],
    ])("%s: republish_failed", async (_label, hook) => {
      output = hook;
      expect((await settle(await fixRound())).publish).toMatchObject({ kind: "refused", code: "republish_failed" });
      await unchanged();
      expect(await facts()).toEqual([{ kind: "escalated", code: "republish_failed" }]);
      expect(await stageOf()).toBe("needs_human");
      expect(await noticeOf()).toEqual({ kind: "needs_human", reason: REPUBLISH_FAILED_SENTENCE });
      expect(gh.opened).toBe(0);
    });

    it("an update GitHub does not confirm changes no stamp", async () => {
      gh.pushed = false;
      expect((await settle(await fixRound())).publish).toMatchObject({ kind: "refused", code: "republish_failed" });
      await unchanged();
      expect(await attempts()).toEqual([expect.objectContaining({ outcome: "report_mismatch" })]);
    });

    it("a missing identity, an unreadable or missing private branch and a pairing now naming another repository start no sandbox", async () => {
      identityMissing = true;
      expect((await settle(await fixRound())).publish).toEqual({ kind: "refused", code: "republish_failed", attemptNo: null });
      identityMissing = false;
      privateHeadOf = async () => null;
      expect((await settle(await fixRound())).publish).toEqual({ kind: "refused", code: "republish_failed", attemptNo: null });
      privateHeadOf = async () => {
        throw new Error("github down");
      };
      expect((await settle(await fixRound())).publish).toEqual({ kind: "refused", code: "republish_failed", attemptNo: null });
      privateHeadOf = async () => PRIVATE_HEAD;
      // No readable private default tip: the rules cannot be read where they must be, so nothing is started.
      for (const privateDefaultHead of [async () => null, async () => "main", async (): Promise<string | null> => { throw new Error("down"); }]) {
        expect((await settle(await fixRound(), { privateDefaultHead })).publish).toEqual({ kind: "refused", code: "republish_failed", attemptNo: null });
      }
      await admin.query("UPDATE repo_pairing SET code_repo = 'acme/other-public' WHERE repo_id = $1", [A.repoId]);
      privateHeadOf = async () => PRIVATE_HEAD;
      expect((await settle(await fixRound())).publish).toEqual({ kind: "refused", code: "republish_failed", attemptNo: null });
      expect(fake.state.created).toEqual([]);
      await unchanged();
    });

    it("a publish sandbox lost mid-update is settled the same way: the attempt finishes hook_crashed, the push row is not refused, the item goes to a person", async () => {
      const run = await fixRound();
      const attemptId = randomUUID();
      const publishRun = randomUUID();
      const name = `pp-${attemptId}`;
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, sandbox_name, dispatch_repo_id, parent_run_id, sandbox_requested_at)
         VALUES ($1, $2, $3, 'plane_publish', 'production', 'running', $4, $5, $6, now() - interval '10 minutes')`,
        [publishRun, A.accountId, A.workItemId, name, A.repoId, run],
      );
      await admin.query(`INSERT INTO plane_push_attempts (id, account_id, plane_push_id, run_id, runtime, kind, attempt_no) VALUES ($1, $2, $3, $4, 'sandbox', 'fix_round', 1)`, [attemptId, A.accountId, (await planeRow()).id, publishRun]);
      fake.scriptExists(name, false);
      expect(await createPublishSettler({ pool: writerPool, port: fake.port, now: () => Date.now() }).settleIfLost({ id: publishRun, accountId: A.accountId })).toBe("settled");
      expect((await attempts())[0]).toMatchObject({ outcome: "hook_crashed", finished_at: expect.any(Date) });
      await unchanged();
      expect(await facts()).toEqual([{ kind: "escalated", code: "republish_failed" }]);
      expect(await stageOf()).toBe("needs_human");
    });
  });

  // D#519 MQ4-e1-b (C11-e1-4a to 4c): a MERGE-CONFLICT round's republish. The platform's real `verifyPushed` runs over the real API client, over Node's TLS path, against a strict GitHub that keeps a
  // commit graph: one-parent and main-history answers come from the graph. What it cannot fake: GitHub's own merge-base arithmetic (the compare answer is derived from the graph) and rate limits.
  describe("MQ4-e1-b: the conflict round's republish is judged against the main tip the platform read", () => {
    const OLD_MAIN = "3".repeat(40);
    const OTHER = "4".repeat(40);
    let server: LocalTlsServer;
    let graph: { parents: Map<string, string[]>; refs: Map<string, string>; mainReads: string[] };
    let key: string;
    beforeAll(() => {
      key = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
    });
    afterEach(async () => {
      await server?.close();
    });
    const json = (status: number, body: unknown): GhReply => ({ status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
    const ancestors = (c: string): Set<string> => {
      const seen = new Set<string>();
      for (const todo = [c]; todo.length > 0; ) {
        const x = todo.pop()!;
        if (seen.has(x)) continue;
        seen.add(x);
        todo.push(...(graph.parents.get(x) ?? []));
      }
      return seen;
    };
    async function github(): Promise<PlanePublishDeps["hosted"]> {
      const root = "/repos/acme/widgets-public";
      server = await startStrictGithubServer((req): GhReply => {
        if (req.method === "DELETE" && req.path === "/installation/token") return { status: 204, headers: {}, body: "" };
        if (req.path === `${root}/installation`) return json(200, { id: 42, app_slug: "fulcrumaxe" });
        if (req.path === `${root}/pulls/9`) return json(200, { state: "open", merged: false, html_url: "https://github.com/acme/widgets-public/pull/9", head: { ref: "x", repo: { full_name: "acme/widgets-public" } }, base: { ref: "main" } });
        const ref = req.path.startsWith(`${root}/git/ref/heads/`) ? decodeURIComponent(req.path.slice(`${root}/git/ref/heads/`.length)) : null;
        if (ref === "main" && graph.mainReads.length > 0) return json(200, { object: { sha: graph.mainReads.length > 1 ? graph.mainReads.shift()! : graph.mainReads[0]! } });
        if (ref !== null) return graph.refs.has(ref) ? json(200, { object: { sha: graph.refs.get(ref) } }) : ghError(404, "Not Found");
        const commit = /\/git\/commits\/([0-9a-f]{40})$/.exec(req.path);
        if (commit) return graph.parents.has(commit[1]!) ? json(200, { parents: graph.parents.get(commit[1]!)!.map((sha) => ({ sha })) }) : ghError(404, "Not Found");
        const compare = /\/compare\/main\.\.\.([0-9a-f]{40})$/.exec(req.path);
        if (compare) {
          const main = graph.refs.get("main")!;
          const c = compare[1]!;
          return json(200, { status: c === main ? "identical" : ancestors(main).has(c) ? "behind" : ancestors(c).has(main) ? "ahead" : "diverged" });
        }
        return ghError(404, "Not Found");
      });
      const s = server;
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const r = await httpsRoundTrip(
          { host: "api.github.com", port: s.port, path: url.pathname + url.search, method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, ca: s.ca, servername: "api.github.com",
            lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as never },
          init?.body as string | undefined,
        );
        return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers });
      }) as typeof fetch;
      const requester = async (p: { permissions?: Record<string, string>; repositories?: string[] }) => ({ token: "ghs_planepush1", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read", ...p.permissions }, repositories: p.repositories ?? [] });
      const api = createPlanePushApi({ appCredentials: () => ({ appId: "12345", privateKeyPem: key, webhookSecret: "unused" }), requester: requester as never, cache: new InstallationTokenCache(), fetchImpl });
      const real = createHostedPlanePush(api, { ownsInstallation: async (_a, id) => id === 42 });
      return { verifyPushed: real.verifyPushed, verifyPullRequest: real.verifyPullRequest, pullRequestState: real.pullRequestState, openPullRequest: real.openPullRequest, branchHead: real.branchHead };
    }
    /** The graph after the hook pushed: main is `tip`; the platform's branch holds `head`, whose parents are `parents`. */
    async function pushed(head: string, parents: string[], mainReads: string[] = [NEW_TIP]) {
      const branch = (await planeRow()).branch as string;
      graph = { parents: new Map([[OLD_MAIN, []], [NEW_TIP, [OLD_MAIN]], [OTHER, [OLD_MAIN]], [head, parents]]), refs: new Map([["main", NEW_TIP], [branch, head]]), mainReads };
    }
    const outcome = async (run: string) => mergeQueue.readRepublishOutcome(admin as never, { accountId: A.accountId, runId: run } as never);
    const writes = () => server.seen.filter((r) => r.method !== "GET" && r.method !== "DELETE");

    it("C11-e1-4a: one commit whose single parent is the main tip, on a branch at the recorded head: the stamp moves and the round's republish reads as done", async () => {
      await pushed(NEW_HEAD, [NEW_TIP]);
      const run = await fixRound({ conflict: true });
      expect((await settle(run, { hosted: await github() })).publish).toEqual({ kind: "updated", attemptNo: 1 });
      expect(await planeRow()).toMatchObject({ head_sha: NEW_HEAD, tip_sha: NEW_TIP, source_head: PRIVATE_HEAD });
      expect(await outcome(run)).toBe("done");
      expect(server.seen.every((r) => r.headers["user-agent"] === "fulcrumaxe-cloud")).toBe(true);
    });

    it("C11-e1-4a: main moving after the platform's first read still passes when the head sits on the tip read at the start or the one read at the end", async () => {
      await pushed(NEW_HEAD, [NEW_TIP], [NEW_TIP, OTHER]);
      graph.parents.set(OTHER, [NEW_TIP]);
      graph.refs.set("main", OTHER);
      expect((await settle(await fixRound({ conflict: true }), { hosted: await github() })).publish).toMatchObject({ kind: "updated" });
    });

    it("C11-e1-4a: the head may also sit on the tip read at the END (main moved forward while the publish ran, after the first read)", async () => {
      await pushed(NEW_HEAD, [NEW_TIP], [OLD_MAIN, NEW_TIP]);
      expect((await settle(await fixRound({ conflict: true }), { hosted: await github() })).publish).toMatchObject({ kind: "updated" });
    });

    it("an unreadable START read of the main tip refuses before any sandbox starts: republish_failed, no attempt, and the round reads it as a stop", async () => {
      await pushed(NEW_HEAD, [NEW_TIP]);
      const run = await fixRound({ conflict: true });
      const hosted = { ...(await github()), branchHead: async () => null };
      expect((await settle(run, { hosted })).publish).toEqual({ kind: "refused", code: "republish_failed", attemptNo: null });
      expect(fake.state.created).toEqual([]);
      expect(await attempts()).toEqual([]);
      expect(await outcome(run)).toBe("failed");
    });

    it.each([
      ["a scan refusal", () => say({ phase: "refused", code: "scan_refused", refusals: [{ kind: "identifier_hit", place: "src/a.ts:2", rule_key: "identifier-rule#1" }] })],
      ["a hook that crashed", () => ({ exitCode: 1, stdout: "" })],
      ["a report GitHub does not confirm (a first-push line)", () => say({ phase: "pr_opened", head_sha: NEW_HEAD, tip_sha: NEW_TIP, pr_number: 11 })],
    ])("%s: the round reads a stop (failed), never done, so no delta review is paid for", async (_label, hook) => {
      await pushed(NEW_HEAD, [NEW_TIP]);
      output = hook;
      const run = await fixRound({ conflict: true });
      expect((await settle(run, { hosted: await github() })).publish).toMatchObject({ kind: "refused", code: "republish_failed" });
      expect(await outcome(run)).toBe("failed");
    });

    it("a refusal recorded with no attempt row (identity missing) reads as the same stop, not pending", async () => {
      identityMissing = true;
      const run = await fixRound({ conflict: true });
      expect(await outcome(run)).toBe("pending");
      expect((await settle(run, { hosted: await github() })).publish).toEqual({ kind: "refused", code: "republish_failed", attemptNo: null });
      expect(await attempts()).toEqual([]);
      expect(await outcome(run)).toBe("failed");
    });

    it("an EARLIER run's recorded refusal on the same item is not this round's: the current round still reads pending, and an old no_change does not read done", async () => {
      identityMissing = true;
      const older = await fixRound({ conflict: true });
      const old = await fixRound({ conflict: true });
      expect((await settle(old, { hosted: await github() })).publish).toMatchObject({ kind: "refused", attemptNo: null });
      await admin.query(
        `INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, 'escalated', 'republish_no_change', 'republish_no_change:' || left(encode(sha256(convert_to($3::text, 'UTF8')), 'hex'), 32))`,
        [A.accountId, A.workItemId, older],
      );
      identityMissing = false;
      const current = await fixRound({ conflict: true });
      expect(await outcome(old)).toBe("failed");
      expect(await outcome(older)).toBe("done");
      expect(await outcome(current)).toBe("pending");
    });

    it("no attempt and the copy changed under the round: taken over reads branch_moved, closed or merged reads failed, and an update in flight still reads pending", async () => {
      const run = await fixRound({ conflict: true });
      expect(await outcome(run)).toBe("pending");
      await admin.query("UPDATE plane_pushes SET state = 'updating' WHERE work_item_id = $1", [A.workItemId]);
      expect(await outcome(run)).toBe("pending");
      await admin.query("UPDATE plane_pushes SET state = 'pr_closed' WHERE work_item_id = $1", [A.workItemId]);
      expect(await outcome(run)).toBe("failed");
      await admin.query("UPDATE plane_pushes SET state = 'pr_opened', managed_by_person_at = now() WHERE work_item_id = $1", [A.workItemId]);
      expect(await outcome(run)).toBe("branch_moved");
    });

    it.each([
      ["two parents", NEW_HEAD, [NEW_TIP, OTHER]],
      ["a parent that is in main's history but not its tip", NEW_HEAD, [OLD_MAIN]],
      ["a parent that is not in main's history", NEW_HEAD, [OTHER]],
    ])("C11-e1-4c: %s ends history_rewritten: no stamp moves, the item is in Needs a person, and the round reads it", async (_label, head, parents) => {
      await pushed(head, parents);
      output = () => say({ phase: "updated", head_sha: head, tip_sha: parents[0]! });
      const run = await fixRound({ conflict: true });
      expect((await settle(run, { hosted: await github() })).publish).toMatchObject({ kind: "refused", code: "republish_failed" });
      expect(await planeRow()).toMatchObject({ head_sha: STAMP, tip_sha: TIP });
      expect(await attempts()).toEqual([expect.objectContaining({ outcome: "history_rewritten" })]);
      expect(await outcome(run)).toBe("history_rewritten");
      expect(await stageOf()).toBe("needs_human");
      expect(writes()).toEqual([]);
    });

    it("C12-e1b-3: the same older-main parent on a REVIEW round (no conflict mark) is judged as before: the hook's tip is believed, the stamp moves", async () => {
      await pushed(NEW_HEAD, [OLD_MAIN]);
      output = () => say({ phase: "updated", head_sha: NEW_HEAD, tip_sha: OLD_MAIN });
      expect((await settle(await fixRound(), { hosted: await github() })).publish).toMatchObject({ kind: "updated" });
      expect(await outcome(await fixRound())).toBe("none");
    });

    it("C11-e1-4b: the hook's lease refusal (a person's commit on the public branch) republishes nothing, moves no public ref, and the round reads it as branch_moved", async () => {
      await pushed(OTHER, [OLD_MAIN]);
      output = () => say({ phase: "refused", code: "public_branch_moved" });
      const run = await fixRound({ conflict: true });
      expect((await settle(run, { hosted: await github() })).publish).toEqual({ kind: "refused", code: "republish_branch_moved", attemptNo: 1 });
      expect(await planeRow()).toMatchObject({ head_sha: STAMP, tip_sha: TIP });
      expect(await outcome(run)).toBe("branch_moved");
      expect(writes()).toEqual([]);
      expect([...graph.refs.values()]).toEqual([NEW_TIP, OTHER]);
      // D#598 P1g-2: the lease failure is asked about. The branch is read on GitHub, and one request holds the head seen (the person's commit); the item waits.
      expect(await branchRequests()).toEqual([expect.objectContaining({ state: "open", origin: "derived", created_by: null, seen_head: OTHER })]);
      expect(await planeRow()).toMatchObject({ state: "waiting_person_pushed", head_sha: STAMP });
    });

    it("D#598 P1g-2: a lease failure whose branch cannot be read on GitHub, or that is back at the stamp, raises nothing and still ends as the refusal", async () => {
      await pushed(OTHER, [OLD_MAIN]);
      output = () => say({ phase: "refused", code: "public_branch_moved" });
      const real = await github();
      // Main still reads as it does for the round; only the item's own branch cannot be read.
      const hosted = { ...real, branchHead: async (i: { accountId: string; codeRepo: string; branch: string }) => { if (i.branch === "main") return real.branchHead!(i); throw new Error("public_unavailable"); } };
      expect((await settle(await fixRound({ conflict: true }), { hosted })).publish).toEqual({ kind: "refused", code: "republish_branch_moved", attemptNo: 1 });
      expect(await branchRequests()).toEqual([]);
      expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: STAMP });
      const back = { ...real, branchHead: async (i: { accountId: string; codeRepo: string; branch: string }) => (i.branch === "main" ? real.branchHead!(i) : STAMP) };
      expect((await settle(await fixRound({ conflict: true }), { hosted: back })).publish).toMatchObject({ kind: "refused", code: "republish_branch_moved" });
      expect(await branchRequests()).toEqual([]);
    });

    it("the round reads pending while the republish has not finished, and none when the run signed no conflict base", async () => {
      const run = await fixRound({ conflict: true });
      expect(await outcome(run)).toBe("pending");
      expect(await outcome(await fixRound())).toBe("none");
    });
  });

  // D#6 REPUBLISH-CLOSED-PR: the record says open, GitHub may already say otherwise. The platform's real `pullRequestState` runs over the real API client and Node's TLS path, against a strict GitHub (User-Agent,
  // bearer token, `state` and `merged` fields as GitHub names them). What it cannot fake: GitHub's real rate-limit headers and the lag between a close and the webhook.
  describe("D#6 REPUBLISH-CLOSED-PR: the live state of the public pull request is read before anything is pushed", () => {
    let server: LocalTlsServer;
    let pull: GhReply;
    let key: string;
    beforeAll(() => {
      key = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
    });
    afterEach(async () => {
      await server?.close();
    });
    const json = (status: number, body: unknown): GhReply => ({ status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
    const prBody = (state: string, merged: boolean) => json(200, { number: 9, state, merged, html_url: "https://github.com/acme/widgets-public/pull/9", head: { ref: "fx/p-x", repo: { full_name: "acme/widgets-public" } }, base: { ref: "main" } });
    async function live(): Promise<PlanePublishDeps["hosted"]> {
      server = await startStrictGithubServer((req): GhReply => {
        if (req.method === "DELETE" && req.path === "/installation/token") return { status: 204, headers: {}, body: "" };
        if (req.path === "/repos/acme/widgets-public/installation") return json(200, { id: 42, app_slug: "fulcrumaxe" });
        return req.path === "/repos/acme/widgets-public/pulls/9" ? pull : ghError(404, "Not Found");
      });
      const s = server;
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const r = await httpsRoundTrip(
          { host: "api.github.com", port: s.port, path: url.pathname + url.search, method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, ca: s.ca, servername: "api.github.com",
            lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as never },
          init?.body as string | undefined,
        );
        return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers });
      }) as typeof fetch;
      const requester = async (p: { permissions?: Record<string, string>; repositories?: string[] }) => ({ token: "ghs_planepush1", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read", ...p.permissions }, repositories: p.repositories ?? [] });
      const api = createPlanePushApi({ appCredentials: () => ({ appId: "12345", privateKeyPem: key, webhookSecret: "unused" }), requester: requester as never, cache: new InstallationTokenCache(), fetchImpl });
      const real = createHostedPlanePush(api, { ownsInstallation: async (_a, id) => id === 42 });
      return { verifyPushed: async () => true, verifyPullRequest: real.verifyPullRequest, pullRequestState: real.pullRequestState, openPullRequest: real.openPullRequest, branchHead: real.branchHead };
    }
    const nothingPushed = async () => {
      expect(fake.state.created).toEqual([]);
      expect(await attempts()).toEqual([]);
      expect(await publishRuns()).toEqual([]);
    };

    it.each([
      ["closed on GitHub", prBody("closed", false), "republish_pr_closed"],
      ["merged on GitHub (state closed, merged true)", prBody("closed", true), "republish_pr_merged"],
    ])("a record that says open while the pull request is %s stops with its own code: no sandbox, no attempt, nothing stamped from the read", async (_n, reply, code) => {
      pull = reply;
      const before = await planeRow();
      expect((await settle(await fixRound(), { hosted: await live() })).publish).toEqual({ kind: "refused", code, attemptNo: null });
      await nothingPushed();
      const after = await planeRow();
      expect({ state: after.state, head_sha: after.head_sha, pr_number: after.pr_number }).toEqual({ state: before.state, head_sha: before.head_sha, pr_number: before.pr_number });
      expect(await facts()).toEqual([{ kind: "escalated", code }]);
      expect(server.seen.map((r) => `${r.method} ${r.path}`).filter((l) => l.includes("/pulls/"))).toEqual(["GET /repos/acme/widgets-public/pulls/9"]);
      expect(server.seen.every((r) => r.headers["user-agent"] === "fulcrumaxe-cloud")).toBe(true);
      expect(server.seen.find((r) => r.path.endsWith("/pulls/9"))?.headers["authorization"]).toMatch(/^Bearer ghs_/);
    });

    it.each([
      ["a 404", json(404, { message: "Not Found" })],
      ["a 200 that is not an object", json(200, [])],
      ["a state GitHub does not name", json(200, { state: "draft", merged: false })],
      ["a 500", json(500, { message: "Server Error" })],
      ["a 502", json(502, { message: "Bad Gateway" })],
      ["a rate limit (429)", { status: 429, headers: { "content-type": "application/json", "retry-after": "60" }, body: JSON.stringify({ message: "rate limited" }) }],
      ["a secondary rate limit (403)", json(403, { message: "You have exceeded a secondary rate limit" })],
    ] as Array<[string, GhReply]>)("%s fails closed with the failed code and is never reported as closed: nothing is pushed", async (_n, reply) => {
      pull = reply;
      expect((await settle(await fixRound(), { hosted: await live() })).publish).toEqual({ kind: "refused", code: "republish_failed", attemptNo: null });
      await nothingPushed();
      expect(await facts()).toEqual([{ kind: "escalated", code: "republish_failed" }]);
    });

    it("an open pull request republishes exactly as before, the read comes before any sandbox, and a hosted port without the read fails closed", async () => {
      pull = prBody("open", false);
      const hosted = await live();
      const order: string[] = [];
      const base = fake.port;
      const port = { ...base, createSandbox: async (o: Parameters<typeof base.createSandbox>[0]) => (order.push(`sandbox after ${server.seen.filter((x) => x.path.endsWith("/pulls/9")).length} read`), fake.scriptCommand(o.sandboxName, output()), base.createSandbox(o)) } as PlanePublishDeps["port"];
      expect((await settle(await fixRound(), { hosted, port })).publish).toEqual({ kind: "updated", attemptNo: 1 });
      expect(order).toEqual(["sandbox after 1 read"]);
      expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: NEW_HEAD, pr_number: 9 });
      // A port that cannot read the state is the same as no answer.
      const bare = { ...hosted };
      delete bare.pullRequestState;
      await admin.query("DELETE FROM work_item_driver_events WHERE work_item_id = $1", [A.workItemId]);
      await admin.query("UPDATE plane_pushes SET head_sha = $2 WHERE work_item_id = $1", [A.workItemId, STAMP]);
      expect((await settle(await fixRound(), { hosted: bare })).publish).toEqual({ kind: "refused", code: "republish_failed", attemptNo: null });
    });

    it("a pull request closed and then reopened on GitHub republishes on the next try: the state is derived per attempt, never stamped", async () => {
      pull = prBody("closed", false);
      const hosted = await live();
      expect((await settle(await fixRound(), { hosted })).publish).toMatchObject({ kind: "refused", code: "republish_pr_closed" });
      await nothingPushed();
      expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: STAMP });
      pull = prBody("open", false);
      await admin.query("UPDATE work_items SET stage = 'changes_requested' WHERE id = $1", [A.workItemId]);
      expect((await settle(await fixRound(), { hosted })).publish).toEqual({ kind: "updated", attemptNo: 1 });
    });
  });
});
