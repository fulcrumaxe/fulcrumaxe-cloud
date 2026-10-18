import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { stampPlanePush } from "@fx/core/src/repos/planePushRecord.js";
import { createFakeSandbox, type AgentRuntime, type NetworkPolicyRule, type PlanePublishLine } from "@fx/runner";
import type { PullRequestRef, RunPullRequestPort, RunPullRequestText } from "@fx/runner-cloud";
import type { StackBasePort, StackParentFacts } from "@fx/pipeline";
import { phaseLine } from "../../runner/src/planePublish/protocol.js";
import { createFakeModelConnectionPort } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { createReaperSdkFake } from "../../runner/test/helpers/reaperSdkFake.js";
import { buildWorker } from "../src/compositionRoot.js";
import { PUBLIC_UNAVAILABLE_NOTE, createPlanePublish, type PlanePublishDeps } from "../src/planePublish.js";

/**
 * [pg] D#598 P1f-5c: the platform's own steps after a paired sandbox build (open the private pull request, publish the public change) and the hosted
 * "open the pull request again". The sandbox is the runner package's strict fake; both GitHub sides are recording stand-ins that answer the way the real
 * ports do (the real calls are exercised in packages/runner-cloud and packages/github).
 */
describe("settling a paired sandbox build, and opening the public pull request again [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  let A: SeedRefs;
  let executorRunId: string;
  const BASE = "a".repeat(40);
  const PRIVATE_HEAD = "b".repeat(40);
  const HEAD = "c".repeat(40);
  const TIP = "d".repeat(40);
  const POLICY: NetworkPolicyRule[] = [{ host: "gh-proxy.fixture.test", purpose: "github_proxy" }];
  const noRuntime = { start: async () => undefined, stop: async () => undefined, resume: async () => undefined } as unknown as AgentRuntime;

  let fake: ReturnType<typeof createFakeSandbox>;
  let output: () => { exitCode: number; stdout: string };
  let identityMissing = false;
  const prOpened = (): PlanePublishLine => ({ phase: "pr_opened", branch: undefined, head_sha: HEAD, tip_sha: TIP, pr_number: 9 });
  const say = (...lines: PlanePublishLine[]) => ({ exitCode: 0, stdout: lines.map((l) => phaseLine(l)).join("\n") + "\n" });

  /** The private side. `existing` is an open pull request our App already opened on the branch (it is reused). */
  const priv = {
    calls: [] as string[],
    opened: [] as Array<{ branch: string; base: string; run: RunPullRequestText }>,
    ready: [] as number[],
    existing: false,
    openError: false,
    readyError: false,
    defaultBranch: "main",
  };
  const privatePort: RunPullRequestPort = {
    defaultBranch: async () => (priv.calls.push("defaultBranch"), priv.defaultBranch),
    branchState: async () => ({ exists: true, headOid: PRIVATE_HEAD, aheadBy: 1, defaultBranch: "main" }),
    openDraft: async (i) => {
      priv.calls.push("openDraft");
      if (priv.openError) throw new Error("github down");
      priv.opened.push({ branch: i.branch, base: i.base, run: i.run });
      const ref: PullRequestRef = { number: 7, nodeId: "PR_7", draft: true, reused: priv.existing };
      return ref;
    },
    changedFiles: async () => ({ files: [], totalCount: 0, complete: true }),
    markReady: async (i) => {
      if (priv.readyError) throw new Error("not allowed");
      priv.ready.push(i.pullRequest.number);
    },
    close: async () => undefined,
  };
  let parent: StackParentFacts | Error;
  const stackBase: StackBasePort = { readParent: async () => (parent instanceof Error ? Promise.reject(parent) : parent) };

  /** The public side. */
  const gh = { pushed: true, pr: { url: "https://github.com/acme/widgets-public/pull/9" } as { url: string } | null, opened: [] as Array<{ codeRepo: string; branch: string; title: string; body: string }>, openError: undefined as string | undefined, calls: [] as string[] };

  function deps(over: Partial<PlanePublishDeps> = {}): PlanePublishDeps {
    const port = fake.port;
    return {
      pool: writerPool,
      port: {
        ...port,
        createSandbox: async (o) => {
          const h = await port.createSandbox(o);
          fake.scriptCommand(o.sandboxName, output());
          return h;
        },
      } as PlanePublishDeps["port"],
      hook: () => "// the built hook",
      networkPolicy: async () => POLICY,
      identity: () => (identityMissing ? null : { name: "Fulcrumaxe Bot", email: "bot@example.com" }),
      privateHead: async () => PRIVATE_HEAD,
      hosted: {
        verifyPushed: async () => (gh.calls.push("pushed"), gh.pushed),
        verifyPullRequest: async () => (gh.calls.push("pr"), gh.pr),
        openPullRequest: async (i) => {
          gh.calls.push("open");
          gh.opened.push(i);
          if (gh.openError) throw Object.assign(new Error("x"), { code: gh.openError });
          return { number: 9, url: "https://github.com/acme/widgets-public/pull/9" };
        },
      },
      pullRequests: privatePort,
      stackBase,
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

  const pair = () =>
    admin.query(`INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', ARRAY['docs/ops/']) ON CONFLICT (repo_id) DO NOTHING`, [A.repoId, A.accountId]);
  const planeRow = async () => (await admin.query("SELECT * FROM plane_pushes WHERE work_item_id = $1", [A.workItemId])).rows[0];
  const attempts = async () => (await admin.query("SELECT * FROM plane_push_attempts WHERE account_id = $1 ORDER BY attempt_no", [A.accountId])).rows;
  const publishRuns = async () => (await admin.query("SELECT id, role, runtime, status, envelope, sandbox_name, parent_run_id, work_item_id, sandbox_requested_at FROM agent_runs WHERE account_id = $1 AND role = 'plane_publish'", [A.accountId])).rows;

  /** Puts the push record in `state` with the fields that state's shape requires (the table's checks). */
  const setState = (state: string) =>
    admin.query(
      `UPDATE plane_pushes SET state = $2, code = CASE WHEN $2 = 'refused' THEN 'scan_refused' END, head_sha = CASE WHEN $2 IN ('pr_opened', 'pushed_pr_not_opened') THEN $3 END,
              tip_sha = CASE WHEN $2 IN ('pr_opened', 'pushed_pr_not_opened') THEN $4 END, pr_number = CASE WHEN $2 = 'pr_opened' THEN 9 END,
              pr_url = CASE WHEN $2 = 'pr_opened' THEN 'https://github.com/acme/widgets-public/pull/9' END
        WHERE work_item_id = $1`,
      [A.workItemId, state, HEAD, TIP],
    );

  async function executorRun(status = "succeeded", runtime = "production"): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, head_sha) VALUES ($1, $2, $3, 'executor', $4, $5, 'sandbox', $6, $7)`,
      [id, A.accountId, A.workItemId, runtime, status, A.repoId, BASE],
    );
    return id;
  }

  beforeEach(async () => {
    fake = createFakeSandbox(noRuntime);
    output = () => say(prOpened());
    identityMissing = false;
    Object.assign(priv, { calls: [], opened: [], ready: [], existing: false, openError: false, readyError: false, defaultBranch: "main" });
    Object.assign(gh, { pushed: true, pr: { url: "https://github.com/acme/widgets-public/pull/9" }, opened: [], openError: undefined, calls: [] });
    parent = { state: "open", merged: false, headSha: "e".repeat(40), headRef: "fx/issue-40", headInBaseRepo: true, branchTipSha: "e".repeat(40) };
    A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [A.repoId]);
    await admin.query("UPDATE work_items SET gh_number = 42, title = 'Add a thing' WHERE id = $1", [A.workItemId]);
    await pair();
    await withTenant(appPool, A.accountId, (c) => stampPlanePush(c, { accountId: A.accountId, workItemId: A.workItemId, repoId: A.repoId }));
    executorRunId = await executorRun();
  });

  describe("the private pull request (Q1)", () => {
    it("is opened as a draft on the dispatch repo from the branch fx/issue-<n>, then made ready, with the fixed text from our rows; the publish step then runs", async () => {
      const r = await worker().settlePairedBuild({ accountId: A.accountId, executorRunId });
      expect(r).toEqual({ privatePullRequest: "opened", publish: { kind: "published", state: "pr_opened", attemptNo: 1 } });
      expect(priv.opened).toEqual([{ branch: "fx/issue-42", base: "main", run: { runId: executorRunId, workItemId: A.workItemId, workItemTitle: "Add a thing", issueNumber: 42 } }]);
      expect(priv.ready).toEqual([7]);
      const runs = await publishRuns();
      expect(runs).toHaveLength(1);
      // The run is marked for the lost-run settle: without a requested time the settler could never list it.
      expect(runs[0].sandbox_requested_at).toBeInstanceOf(Date);
      expect(runs[0].sandbox_name).toMatch(/^pp-[0-9a-f-]{36}$/);
    });

    it("an open pull request on the branch is reused, not duplicated, and a second call opens nothing at all", async () => {
      priv.existing = true;
      expect((await worker().settlePairedBuild({ accountId: A.accountId, executorRunId })).privatePullRequest).toBe("reused");
      priv.calls.length = 0;
      const again = await worker().settlePairedBuild({ accountId: A.accountId, executorRunId });
      expect(again).toEqual({ privatePullRequest: "skipped", publish: { kind: "skipped", why: "not_paired" } });
      expect(priv.calls).toEqual([]);
      expect(await publishRuns()).toHaveLength(1);
      expect(fake.state.created).toHaveLength(1);
    });

    it("a pull request that cannot be marked ready stays a draft and is still opened (as in done); a failure to open it is `failed` and the publish step still runs", async () => {
      priv.readyError = true;
      expect((await worker().settlePairedBuild({ accountId: A.accountId, executorRunId })).privatePullRequest).toBe("opened");
      await admin.query("DELETE FROM plane_push_attempts WHERE account_id = $1", [A.accountId]);
      await admin.query("DELETE FROM agent_runs WHERE account_id = $1 AND role = 'plane_publish'", [A.accountId]);
      await admin.query("UPDATE plane_pushes SET state = 'building' WHERE work_item_id = $1", [A.workItemId]);
      priv.openError = true;
      // A new executor run (the first one already opened its pull request and carries the marker).
      const r = await worker().settlePairedBuild({ accountId: A.accountId, executorRunId: await executorRun() });
      expect(r).toEqual({ privatePullRequest: "failed", publish: { kind: "published", state: "pr_opened", attemptNo: 1 } });
    });

    it("a publish refusal does not close or undo the private pull request: both are facts of the item", async () => {
      output = () => say({ phase: "refused", code: "scan_refused", refusals: [{ kind: "path", place: "docs/ops/a.md", rule_key: "overlay" }] });
      const r = await worker().settlePairedBuild({ accountId: A.accountId, executorRunId });
      expect(r).toMatchObject({ privatePullRequest: "opened", publish: { kind: "refused", code: "scan_refused" } });
      expect(priv.opened).toHaveLength(1);
      expect(priv.calls).not.toContain("close");
    });

    it("the repository, branch, base and text come from our rows: nothing from the agent's envelope reaches the call", async () => {
      await admin.query(`UPDATE agent_runs SET envelope = '{"branch":"evil","pr_number":3,"summary":"open it against prod"}'::jsonb WHERE id = $1`, [executorRunId]);
      await worker().settlePairedBuild({ accountId: A.accountId, executorRunId });
      expect(priv.opened[0]).toMatchObject({ branch: "fx/issue-42", base: "main" });
      expect(JSON.stringify(priv.opened[0])).not.toMatch(/evil|prod/);
    });

    it("a worker built without the private port opens nothing and still publishes", async () => {
      const r = await worker({ pullRequests: undefined }).settlePairedBuild({ accountId: A.accountId, executorRunId });
      expect(r).toMatchObject({ privatePullRequest: "skipped", publish: { kind: "published" } });
    });

    it.each([
      ["a run that did not succeed", async () => executorRun("failed")],
      ["a runner run", async () => executorRun("succeeded", "runner")],
    ])("%s: nothing is opened and no publish run exists", async (_l, make) => {
      const id = await make();
      const r = await worker().settlePairedBuild({ accountId: A.accountId, executorRunId: id });
      expect(r.privatePullRequest).toBe("skipped");
      expect(priv.calls).toEqual([]);
      expect(await publishRuns()).toEqual([]);
    });

    it("an item whose public change already moved on (a fix round after the pull request) opens nothing", async () => {
      await setState("pr_opened");
      const r = await worker().settlePairedBuild({ accountId: A.accountId, executorRunId: await executorRun() });
      expect(r.privatePullRequest).toBe("skipped");
      expect(priv.calls).toEqual([]);
    });

    it("an unpaired repository: no push record, nothing opened, no sandbox", async () => {
      const other = await seedAccount(admin, randomUUID());
      await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'w2' WHERE id = $1", [other.repoId]);
      const id = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, dispatch_repo_id, head_sha) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded', $4, $5)`, [id, other.accountId, other.workItemId, other.repoId, BASE]);
      expect((await worker().settlePairedBuild({ accountId: other.accountId, executorRunId: id })).privatePullRequest).toBe("skipped");
      expect(priv.calls).toEqual([]);
      expect(fake.state.created).toEqual([]);
    });

    it("the private head the publish step read is kept on the publish run (the recorded sha for the branch cleanup)", async () => {
      await worker().settlePairedBuild({ accountId: A.accountId, executorRunId });
      expect((await publishRuns())[0].envelope.publish.private_head).toBe(PRIVATE_HEAD);
    });
  });

  describe("Build again: \"already settled\" is judged per executor run, not per record", () => {
    /** Build again: the record is re-stamped to building (its old attempts stay), the item is In progress, and a new executor run finishes. */
    async function buildAgain(): Promise<string> {
      await withTenant(appPool, A.accountId, (c) => stampPlanePush(c, { accountId: A.accountId, workItemId: A.workItemId, repoId: A.repoId }));
      await admin.query("UPDATE work_items SET stage = 'in_progress' WHERE id = $1", [A.workItemId]);
      return executorRun();
    }
    const refusedHook = () => say({ phase: "refused", code: "scan_refused", refusals: [{ kind: "path", place: "docs/ops/a.md", rule_key: "overlay" }] });
    const pushNumbers = async () => (await attempts()).filter((a) => a.kind === "push").map((a) => a.attempt_no);

    it("after a refused publish, the new run opens its private pull request and publishes (attempt 2)", async () => {
      output = refusedHook;
      expect(await worker().settlePairedBuild({ accountId: A.accountId, executorRunId })).toMatchObject({ privatePullRequest: "opened", publish: { kind: "refused", code: "scan_refused", attemptNo: 1 } });
      expect((await planeRow()).state).toBe("refused");
      priv.calls.length = 0;
      output = () => say(prOpened());
      const again = await buildAgain();
      expect(await worker().settlePairedBuild({ accountId: A.accountId, executorRunId: again })).toEqual({ privatePullRequest: "opened", publish: { kind: "published", state: "pr_opened", attemptNo: 2 } });
      expect(priv.opened).toHaveLength(2);
      expect(await pushNumbers()).toEqual([1, 2]);
      expect(await planeRow()).toMatchObject({ state: "pr_opened", pr_number: 9 });
    });

    it("after a private open that failed (and a refused publish), the new run opens it and publishes", async () => {
      priv.openError = true;
      output = refusedHook;
      expect(await worker().settlePairedBuild({ accountId: A.accountId, executorRunId })).toMatchObject({ privatePullRequest: "failed", publish: { kind: "refused", attemptNo: 1 } });
      priv.openError = false;
      output = () => say(prOpened());
      const again = await buildAgain();
      expect(await worker().settlePairedBuild({ accountId: A.accountId, executorRunId: again })).toMatchObject({ privatePullRequest: "opened", publish: { kind: "published", attemptNo: 2 } });
    });

    it("a replay of the same run opens nothing more, and a private pull request a person closed is never reopened", async () => {
      identityMissing = true;
      const first = await worker().settlePairedBuild({ accountId: A.accountId, executorRunId });
      expect(first).toEqual({ privatePullRequest: "opened", publish: { kind: "refused", code: "bad_input", attemptNo: null } });
      expect(priv.opened).toHaveLength(1);
      // The person closes that pull request on GitHub. The workflow step is replayed: the run's marker is there, so nothing is opened and nothing asked of GitHub.
      identityMissing = false;
      priv.calls.length = 0;
      const replay = await worker().settlePairedBuild({ accountId: A.accountId, executorRunId });
      expect(replay.privatePullRequest).toBe("skipped");
      expect(priv.calls).toEqual([]);
      expect(priv.opened).toHaveLength(1);
      expect(await publishRuns()).toEqual([]);
    });

    it("a record that already holds three push attempts opens the private pull request, publishes nothing, and settles the item to Needs human with a named reason", async () => {
      output = refusedHook;
      let run = executorRunId;
      for (const n of [1, 2, 3]) {
        expect(await worker().settlePairedBuild({ accountId: A.accountId, executorRunId: run })).toMatchObject({ publish: { kind: "refused", code: "scan_refused", attemptNo: n } });
        run = await buildAgain();
      }
      priv.calls.length = 0;
      const capped = await worker().settlePairedBuild({ accountId: A.accountId, executorRunId: run });
      expect(capped).toEqual({ privatePullRequest: "opened", publish: { kind: "refused", code: "retry_limit", attemptNo: null } });
      expect(await pushNumbers()).toEqual([1, 2, 3]);
      expect(await publishRuns()).toHaveLength(3);
      expect((await admin.query("SELECT stage FROM work_items WHERE id = $1", [A.workItemId])).rows[0].stage).toBe("needs_human");
      const moves = (await admin.query("SELECT source_ref FROM work_item_transitions WHERE work_item_id = $1 AND to_stage = 'needs_human'", [A.workItemId])).rows;
      expect(moves.map((m) => m.source_ref)).toEqual([`build_failed:push_cap_reached:${run}`]);
      expect(await planeRow()).toMatchObject({ state: "refused", code: "retry_limit" });
    });
  });

  describe("when the public repository cannot be reached", () => {
    it("an App that is not installed, a failed mint and a GitHub that is down all store the one code public_unavailable, and the note says so in words", async () => {
      for (const failing of [() => Promise.reject(Object.assign(new Error("x"), { code: "app_not_installed" })), () => Promise.reject(new Error("mint failed"))]) {
        const r = await worker({ privateHead: failing }).settlePairedBuild({ accountId: A.accountId, executorRunId });
        expect(r.publish).toEqual({ kind: "refused", code: "public_unavailable", attemptNo: null });
        await admin.query("UPDATE plane_pushes SET state = 'building', code = NULL WHERE work_item_id = $1", [A.workItemId]);
      }
      expect(PUBLIC_UNAVAILABLE_NOTE).toMatch(/not be installed/);
      expect(PUBLIC_UNAVAILABLE_NOTE).toMatch(/token could not be made/);
      expect(PUBLIC_UNAVAILABLE_NOTE).toMatch(/cannot tell these apart/);
      expect(fake.state.created).toEqual([]);
    });
  });

  describe("a stacked item (read through the stack-base port)", () => {
    beforeEach(async () => {
      const parentItem = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, gh_number, title) VALUES ($1, $2, $3, 'bug', 'internal', 40, 'Parent')`, [parentItem, A.accountId, A.repoId]);
      await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, dispatch_repo_id, envelope) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded', $4, '{"pr_number":31}'::jsonb)`, [randomUUID(), A.accountId, parentItem, A.repoId]);
      await admin.query("UPDATE work_items SET stack_parent_id = $2 WHERE id = $1", [A.workItemId, parentItem]);
    });

    it("opens against the parent's branch", async () => {
      expect((await worker().settlePairedBuild({ accountId: A.accountId, executorRunId })).privatePullRequest).toBe("opened");
      expect(priv.opened[0]).toMatchObject({ branch: "fx/issue-42", base: "fx/issue-40" });
    });

    it("a parent that merged since: against the default branch", async () => {
      parent = { state: "closed", merged: true, headSha: "e".repeat(40), headRef: "fx/issue-40", headInBaseRepo: true, branchTipSha: "" };
      await worker().settlePairedBuild({ accountId: A.accountId, executorRunId });
      expect(priv.opened[0]).toMatchObject({ base: "main" });
    });

    it.each([
      ["a parent that cannot be read", () => (parent = new Error("down"))],
      ["a parent closed without merging", () => (parent = { state: "closed", merged: false, headSha: "e".repeat(40), headRef: "fx/issue-40", headInBaseRepo: true, branchTipSha: "" })],
    ])("%s: no pull request is opened (never one against the wrong base), and the publish step still runs", async (_l, arrange) => {
      arrange();
      const r = await worker().settlePairedBuild({ accountId: A.accountId, executorRunId });
      expect(r).toMatchObject({ privatePullRequest: "failed", publish: { kind: "published" } });
      expect(priv.opened).toEqual([]);
    });
  });

  describe("open the public pull request again (pushed_pr_not_opened)", () => {
    const stuck = () => setState("pushed_pr_not_opened");
    const reopen = (over: Partial<PlanePublishDeps> = {}) => worker(over).openPublicPullRequest({ accountId: A.accountId, workItemId: A.workItemId });

    it("sandbox-run row: opens the pull request with the fixed text, records pr_opened, and writes a pr_open attempt with no sandbox and no run row", async () => {
      output = () => say({ phase: "pr_failed", head_sha: HEAD, tip_sha: TIP });
      await worker().settlePairedBuild({ accountId: A.accountId, executorRunId });
      expect((await planeRow()).state).toBe("pushed_pr_not_opened");
      const sandboxes = fake.state.created.length;
      const runs = (await admin.query("SELECT count(*)::int AS n FROM agent_runs WHERE account_id = $1", [A.accountId])).rows[0].n;

      expect(await reopen()).toEqual({ kind: "opened", prNumber: 9, attemptNo: 1 });
      const row = await planeRow();
      expect(row).toMatchObject({ state: "pr_opened", pr_number: 9, pr_url: "https://github.com/acme/widgets-public/pull/9", head_sha: HEAD, tip_sha: TIP, code: null });
      expect(gh.opened).toEqual([{ codeRepo: "acme/widgets-public", branch: row.branch, title: expect.any(String), body: expect.any(String) }]);
      expect(gh.opened[0]!.body).not.toContain("Add a thing");
      const [push, pr] = await attempts();
      expect(push).toMatchObject({ kind: "push", attempt_no: 1 });
      expect(pr).toMatchObject({ kind: "pr_open", runtime: "hosted", run_id: null, attempt_no: 1, outcome: "pr_opened" });
      expect(pr.finished_at).toBeInstanceOf(Date);
      // No git, no sandbox, no run row.
      expect(fake.state.created).toHaveLength(sandboxes);
      expect((await admin.query("SELECT count(*)::int AS n FROM agent_runs WHERE account_id = $1", [A.accountId])).rows[0].n).toBe(runs);
    });

    it("runner-run row: the same, from a row a runner's report left behind (no sandbox attempt exists)", async () => {
      await executorRun("succeeded", "runner");
      await stuck();
      expect(await reopen()).toEqual({ kind: "opened", prNumber: 9, attemptNo: 1 });
      expect(await planeRow()).toMatchObject({ state: "pr_opened", pr_number: 9 });
      expect((await attempts())[0]).toMatchObject({ kind: "pr_open", runtime: "hosted", run_id: null });
      expect(fake.state.created).toEqual([]);
    });

    it("a refusal by GitHub (pr_failed) or GitHub being down leaves the row exactly as it was, ends the attempt with that word, and can be tried again", async () => {
      await stuck();
      for (const [code, n] of [["pr_failed", 1], ["public_unavailable", 2]] as const) {
        gh.openError = code;
        expect(await reopen()).toEqual({ kind: "refused", code, attemptNo: n });
        expect(await planeRow()).toMatchObject({ state: "pushed_pr_not_opened", pr_number: null, head_sha: HEAD });
      }
      gh.openError = undefined;
      expect(await reopen()).toMatchObject({ kind: "opened", attemptNo: 3 });
      expect((await attempts()).map((a) => [a.attempt_no, a.outcome])).toEqual([[1, "pr_failed"], [2, "public_unavailable"], [3, "pr_opened"]]);
    });

    it("PR-open retries never use up push attempts: after several of them a sandbox push still gets all three of its own, and a fourth is refused", async () => {
      output = () => say({ phase: "pr_failed", head_sha: HEAD, tip_sha: TIP });
      await worker().settlePairedBuild({ accountId: A.accountId, executorRunId });
      gh.openError = "pr_failed";
      for (const n of [1, 2, 3, 4]) expect(await reopen()).toMatchObject({ kind: "refused", attemptNo: n });
      // The item's push is refused later (a new build would do this); its retries are numbered among the pushes alone.
      await setState("refused");
      output = () => say({ phase: "refused", code: "scan_refused", refusals: [] });
      expect(await worker().retryPublish({ accountId: A.accountId, workItemId: A.workItemId })).toMatchObject({ kind: "refused", attemptNo: 2 });
      expect(await worker().retryPublish({ accountId: A.accountId, workItemId: A.workItemId })).toMatchObject({ kind: "refused", attemptNo: 3 });
      expect(await worker().retryPublish({ accountId: A.accountId, workItemId: A.workItemId })).toMatchObject({ kind: "refused", code: "retry_limit", attemptNo: null });
      const all = await attempts();
      expect(all.filter((a) => a.kind === "push").map((a) => a.attempt_no)).toEqual([1, 2, 3]);
      expect(all.filter((a) => a.kind === "pr_open").map((a) => a.attempt_no)).toEqual([1, 2, 3, 4]);
    });

    it("a branch that is no longer what was pushed is report_mismatch: no pull request is asked for", async () => {
      await stuck();
      gh.pushed = false;
      expect(await reopen()).toEqual({ kind: "refused", code: "report_mismatch", attemptNo: 1 });
      expect(gh.opened).toEqual([]);
      expect((await planeRow()).state).toBe("pushed_pr_not_opened");
    });

    it("a pull request GitHub does not show as ours is report_mismatch and nothing is recorded", async () => {
      await stuck();
      gh.pr = null;
      expect(await reopen()).toMatchObject({ kind: "refused", code: "report_mismatch" });
      expect((await planeRow()).state).toBe("pushed_pr_not_opened");
    });

    it("the pairing now off: pairing_off, nothing asked of GitHub, nothing recorded (no attempt row, the pushed branch kept)", async () => {
      await stuck();
      await admin.query("DELETE FROM repo_pairing WHERE repo_id = $1", [A.repoId]);
      expect(await reopen()).toEqual({ kind: "refused", code: "pairing_off", attemptNo: null });
      expect(gh.calls).toEqual([]);
      expect(await attempts()).toEqual([]);
      expect(await planeRow()).toMatchObject({ state: "pushed_pr_not_opened", head_sha: HEAD });
    });

    it("the pairing now pointing at another repository: pairing_changed, nothing written", async () => {
      await stuck();
      await admin.query("UPDATE repo_pairing SET code_repo = 'acme/elsewhere' WHERE repo_id = $1", [A.repoId]);
      expect(await reopen()).toEqual({ kind: "refused", code: "pairing_changed", attemptNo: null });
      expect(gh.calls).toEqual([]);
    });

    it.each(["building", "refused", "pr_opened", "no_public_change"])("an item in %s is not retryable: skipped, nothing asked of GitHub", async (state) => {
      await setState(state);
      expect(await reopen()).toEqual({ kind: "skipped", why: "not_retryable" });
      expect(gh.calls).toEqual([]);
      expect(await attempts()).toEqual([]);
    });

    it("an item whose branch a person took over is not touched", async () => {
      await stuck();
      await admin.query("UPDATE plane_pushes SET managed_by_person_at = now() WHERE work_item_id = $1", [A.workItemId]);
      expect(await reopen()).toEqual({ kind: "skipped", why: "not_retryable" });
    });

    it("an unpaired item (no push record) is skipped; a worker without the ports answers not_configured", async () => {
      const other = await seedAccount(admin, randomUUID());
      expect(await worker().openPublicPullRequest({ accountId: other.accountId, workItemId: other.workItemId })).toEqual({ kind: "skipped", why: "not_retryable" });
      expect(await createPlanePublish(null).openPublicPullRequest({ accountId: A.accountId, workItemId: A.workItemId })).toEqual({ kind: "not_configured" });
    });
  });
});

describe("through the Worker surface [pg] (D#598 P1f-5c)", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });
  const build = () =>
    buildWorker({
      env: { FX_GH_FORWARD_SUFFIX: "fixture.test", FX_GH_FORWARD_HOST: "gh-proxy.fixture.test" },
      vercel: { teamId: "team_1", projectId: "prj_1", getToken: async () => "tok" },
      ports: {
        decryptTenantKey: async () => "k",
        modelConnection: createFakeModelConnectionPort(),
        connectionStatus: { markBroken: async () => {}, markCreditsExhausted: async () => {} },
        hooks: { resume: async () => {} },
        planePublish: {
          hook: () => "x",
          identity: () => ({ name: "B", email: "b@example.com" }),
          privateHead: async () => null,
          hosted: { verifyPushed: async () => false, verifyPullRequest: async () => null, openPullRequest: async () => Promise.reject(new Error("unused")) },
        },
      },
      sdk: createReaperSdkFake().sdk,
      createPools: async () => ({ runnerPool: writerPool, platformOpsPool: writerPool, receiptPool: writerPool, close: async () => undefined }),
    });

  it("the surface carries settlePairedBuild and openPublicPullRequest: an unpaired item is skipped on both, with no run row", async () => {
    const worker = await build();
    const a = await seedAccount(admin, randomUUID());
    const run = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, dispatch_repo_id) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded', $4)`, [run, a.accountId, a.workItemId, a.repoId]);
    expect(await worker.settlePairedBuild({ accountId: a.accountId, executorRunId: run })).toEqual({ privatePullRequest: "skipped", publish: { kind: "skipped", why: "not_paired" } });
    expect(await worker.openPublicPullRequest({ accountId: a.accountId, workItemId: a.workItemId })).toEqual({ kind: "skipped", why: "not_retryable" });
    expect((await admin.query("SELECT count(*)::int AS n FROM agent_runs WHERE account_id = $1 AND role = 'plane_publish'", [a.accountId])).rows[0].n).toBe(0);
  });

  it("the compute-settle tick lists a dead publish run (its worker died mid-attempt) and settles it by its recorded pp- name: run failed, attempt hook_crashed, the item refused so a retry is offered", async () => {
    const worker = await build();
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
    await admin.query("UPDATE work_items SET gh_number = 42 WHERE id = $1", [a.workItemId]);
    await admin.query(`INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', ARRAY['docs/ops/'])`, [a.repoId, a.accountId]);
    const appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    try {
      await withTenant(appPool, a.accountId, (c) => stampPlanePush(c, { accountId: a.accountId, workItemId: a.workItemId, repoId: a.repoId }));
    } finally {
      await appPool.end();
    }
    const executor = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded', 'sandbox', $4)`, [executor, a.accountId, a.workItemId, a.repoId]);
    const runId = randomUUID();
    const attemptId = randomUUID();
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, sandbox_name, dispatch_repo_id, parent_run_id, sandbox_requested_at)
       VALUES ($1, $2, $3, 'plane_publish', 'production', 'running', $4, $5, $6, now() - interval '10 minutes')`,
      [runId, a.accountId, a.workItemId, `pp-${attemptId}`, a.repoId, executor],
    );
    const push = (await admin.query("SELECT id FROM plane_pushes WHERE work_item_id = $1", [a.workItemId])).rows[0].id;
    await admin.query(`INSERT INTO plane_push_attempts (id, account_id, plane_push_id, run_id, runtime, kind, attempt_no) VALUES ($1, $2, $3, $4, 'sandbox', 'push', 1)`, [attemptId, a.accountId, push, runId]);
    await admin.query("UPDATE plane_pushes SET state = 'scanning' WHERE id = $1", [push]);

    const tick = await worker.sweepComputeSettle();
    expect(tick.lost.settled).toBeGreaterThanOrEqual(1);
    expect((await admin.query("SELECT status FROM agent_runs WHERE id = $1", [runId])).rows[0].status).toBe("failed");
    expect((await admin.query("SELECT outcome, finished_at FROM plane_push_attempts WHERE id = $1", [attemptId])).rows[0]).toMatchObject({ outcome: "hook_crashed" });
    expect((await admin.query("SELECT state, code FROM plane_pushes WHERE id = $1", [push])).rows[0]).toEqual({ state: "refused", code: "hook_crashed" });
  });
});
