import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { stampPlanePush } from "@fx/core/src/repos/planePushRecord.js";
import { getWorkItemActivity } from "@fx/core/src/work-items/activity.js";
import { REPUBLISH_BRANCH_MOVED_SENTENCE, REPUBLISH_FAILED_SENTENCE, REPUBLISH_NO_CHANGE_SENTENCE } from "@fx/core/src/work-items/baseSync.js";
import { createFakeSandbox, type AgentRuntime, type NetworkPolicyRule, type PlanePublishLine } from "@fx/runner";
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
  let privateHeadOf: () => Promise<string | null>;
  const updated = (): PlanePublishLine => ({ phase: "updated", head_sha: NEW_HEAD, tip_sha: NEW_TIP });
  const say = (...lines: PlanePublishLine[]) => ({ exitCode: 0, stdout: lines.map((l) => phaseLine(l)).join("\n") + "\n" });
  const gh = { pushed: true, verified: [] as Array<{ headSha: string; tipSha: string; branch: string }>, opened: 0 };

  function deps(over: Partial<PlanePublishDeps> = {}): PlanePublishDeps {
    const port = fake.port;
    return {
      pool: writerPool,
      port: { ...port, createSandbox: async (o) => (fake.scriptCommand(o.sandboxName, output()), port.createSandbox(o)) } as PlanePublishDeps["port"],
      hook: () => "// the built hook",
      networkPolicy: async () => POLICY,
      identity: () => (identityMissing ? null : { name: "Fulcrumaxe Bot", email: "bot@example.com" }),
      privateHead: () => privateHeadOf(),
      privateDefaultHead: async () => DEFAULT_TIP,
      hosted: {
        verifyPushed: async (i) => (gh.verified.push({ headSha: i.headSha, tipSha: i.tipSha, branch: i.branch }), gh.pushed),
        verifyPullRequest: async () => ({ url: "https://github.com/acme/widgets-public/pull/9" }),
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
  const attempts = async () => (await admin.query("SELECT * FROM plane_push_attempts WHERE account_id = $1 ORDER BY kind, attempt_no", [A.accountId])).rows;
  const publishRuns = async () => (await admin.query("SELECT id, status, sandbox_name, parent_run_id FROM agent_runs WHERE account_id = $1 AND role = 'plane_publish'", [A.accountId])).rows;
  const facts = async () => (await admin.query("SELECT kind, code FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq", [A.workItemId])).rows;
  const stageOf = async () => (await admin.query("SELECT stage FROM work_items WHERE id = $1", [A.workItemId])).rows[0].stage as string;
  const noticeOf = async () => (await getWorkItemActivity({ pool: adminPool, principal: { accountId: A.accountId, userId: A.userId } }, A.workItemId)).notice;
  const inputOf = () => JSON.parse(fake.state.writtenFiles.filter((f) => f.path.endsWith("input.json")).pop()!.content) as Record<string, unknown>;

  /** A sandbox fix round that finished: it carries the base the cloud brought its branch up to date with (written in its create transaction), like `advanceStartFix` does. */
  async function fixRound(over: { base?: boolean; branch?: string } = {}): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, head_sha) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded', 'sandbox', $4, $5)`,
      [id, A.accountId, A.workItemId, A.repoId, BASE],
    );
    if (over.base !== false) {
      await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, $3, $4)", [A.accountId, id, FIX_BASE_EVENT, JSON.stringify({ base_sha: FIX_BASE, branch: over.branch ?? "fx/issue-42" })]);
    }
    return id;
  }
  const settle = (executorRunId: string, over: Partial<PlanePublishDeps> = {}) => worker(over).settlePairedBuild({ accountId: A.accountId, executorRunId });

  beforeEach(async () => {
    fake = createFakeSandbox(noRuntime);
    output = () => say(updated());
    identityMissing = false;
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
    expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: NEW_HEAD, tip_sha: NEW_TIP, pr_number: 9 });
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
    for (const state of ["pr_closed", "pr_merged", "refused", "building"]) {
      await admin.query("UPDATE plane_pushes SET state = $2, code = CASE WHEN $2 = 'refused' THEN 'scan_refused' END, head_sha = CASE WHEN $2 IN ('building', 'refused') THEN NULL ELSE head_sha END, tip_sha = CASE WHEN $2 IN ('building', 'refused') THEN NULL ELSE tip_sha END, pr_number = CASE WHEN $2 IN ('building', 'refused') THEN NULL ELSE pr_number END, pr_url = CASE WHEN $2 IN ('building', 'refused') THEN NULL ELSE pr_url END WHERE work_item_id = $1", [A.workItemId, state]);
      expect((await settle(await fixRound())).publish, state).toMatchObject({ kind: "skipped" });
    }
    await admin.query("UPDATE plane_pushes SET state = 'pr_opened', head_sha = $2, tip_sha = $3, pr_number = 9, pr_url = 'https://github.com/acme/widgets-public/pull/9', managed_by_person_at = now() WHERE work_item_id = $1", [A.workItemId, STAMP, TIP]);
    expect((await settle(await fixRound())).publish).toEqual({ kind: "skipped", why: "not_paired" });
    expect(fake.state.created).toEqual([]);
    expect(await attempts()).toEqual([]);
    expect(await facts()).toEqual([]);
  });

  it("an item that left the pull request stages (merged, closed unmerged, closed) is not updated even though the push row still says pr_opened: no sandbox, no attempt, no fact", async () => {
    for (const stage of ["merged", "closed_unmerged", "closed"]) {
      await admin.query("UPDATE work_items SET stage = $2 WHERE id = $1", [A.workItemId, stage]);
      expect((await settle(await fixRound())).publish, stage).toEqual({ kind: "skipped", why: "not_paired" });
    }
    expect(fake.state.created).toEqual([]);
    expect(await attempts()).toEqual([]);
    expect(await facts()).toEqual([]);
    expect(await planeRow()).toMatchObject({ state: "pr_opened", head_sha: STAMP });
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

  it("the record changing under the attempt (a person takes the branch over, or the stamp moves) after the facts were read starts no sandbox", async () => {
    privateHeadOf = async () => {
      await admin.query("UPDATE plane_pushes SET managed_by_person_at = now() WHERE work_item_id = $1", [A.workItemId]);
      return PRIVATE_HEAD;
    };
    expect((await settle(await fixRound())).publish).toEqual({ kind: "skipped", why: "not_paired" });
    expect(fake.state.created).toEqual([]);
    expect(await attempts()).toEqual([]);
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
});
