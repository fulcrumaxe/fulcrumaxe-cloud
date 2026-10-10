import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DoneReply, DoneRetryReply, StopReply, sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import {
  DISPATCH_BASE_KIND,
  MAX_BODY_BYTES,
  createRunPullRequestPort,
  donePath,
  doneRun,
  toResponse,
  type RunnerCloudDeps,
  type RunnerDoneStored,
  type RunnerHttpRequest,
  type RunnerLeaseOps,
} from "../src/index.js";
import { FAKE_APP_LOGIN, FakeGithub, type FakeChangeType, type FakeRepo } from "./helpers/githubFake.js";
import { harness, newKey, registerKey, signed, type Harness, type TestKey } from "./helpers.js";

/**
 * [pg] D#6 R2b-3f: the `done` route's judgement of a run, against the real tables for everything it reads (the run, its signed job, the
 * repository, the Spec's scope, the work item, the dispatch record) and the real GitHub port over a strict fake of GitHub. The lease
 * facade is a recording stand-in here (the worker's own suite drives the real one); what is proved is which verdict the route reaches, and
 * which calls it makes, for every outcome and every failure reason.
 */
describe("done route [pg]", () => {
  let h: Harness;
  let A: SeedRefs;
  let key: TestKey;
  let runnerId: string;
  const signing = generateKeyPairSync("ed25519").privateKey;

  const begun: Array<Record<string, unknown>> = [];
  const finished: Array<Record<string, unknown>> = [];
  let begin: Awaited<ReturnType<RunnerLeaseOps["beginRunnerDone"]>> = { kind: "proceed" };
  let finish: "echo" | Awaited<ReturnType<RunnerLeaseOps["finishRunnerDone"]>> = "echo";
  const never = async () => {
    throw new Error("not used by these tests");
  };
  const leases: RunnerLeaseOps = {
    claimRunnerRun: never,
    heartbeatRunnerRun: never,
    ingestRunnerEvents: never,
    gitTicketContext: never,
    signGitTicket: never,
    beginRunnerDone: async (input) => (begun.push({ ...input }), begin),
    finishRunnerDone: async (input) => (finished.push({ ...input }), finish === "echo" ? { kind: "recorded", verdict: input.verdict } : finish),
  };

  beforeAll(async () => {
    h = await harness();
    A = await seedAccount(h.admin, randomUUID());
    key = newKey();
    runnerId = await registerKey(h.admin, A.accountId, A.userId, key);
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
    await h.admin.query("UPDATE work_items SET title = 'Add the footer' WHERE id = $1", [A.workItemId]);
  });
  afterAll(() => h.close());
  beforeEach(() => {
    begun.length = 0;
    finished.length = 0;
    begin = { kind: "proceed" };
    finish = "echo";
  });

  interface Scene {
    runId: string;
    gen: number;
    branch: string;
    fake: FakeGithub;
    repo: FakeRepo;
    call: (over?: { body?: object; deps?: Partial<RunnerCloudDeps> }) => Promise<{ status: number; body: unknown; headers?: Record<string, string> }>;
  }
  interface SceneOptions {
    role?: string;
    runtime?: string;
    runMode?: string;
    repoMode?: string;
    gen?: number;
    files?: Array<{ path: string; changeType: FakeChangeType }>;
    aheadBy?: number;
    /** false: the run's branch is not pushed at all. */
    pushed?: boolean;
    drafts?: boolean;
    /** The Spec's `acceptance_files`; `false` attaches no spec version at all. */
    scope?: unknown;
    continues?: { branch: string } | null;
    /** The head recorded at dispatch: a hash, null (branch absent then), or "unrecorded" (no row). */
    dispatchBase?: string | null | "unrecorded";
    branchOid?: string;
    port?: "real" | "none";
    /** false: the run has no work item. */
    workItem?: false;
  }

  const file = (path: string, changeType: FakeChangeType = "MODIFIED") => ({ path, changeType });

  async function scene(o: SceneOptions = {}): Promise<Scene> {
    const runId = randomUUID();
    const gen = o.gen ?? 1;
    const fake = new FakeGithub();
    const repo = fake.addRepo("acme", "widgets", { supportsDrafts: o.drafts ?? true });
    const branch = o.continues ? o.continues.branch : `fx/${runId}-g${gen}`;
    if (o.pushed !== false) fake.pushBranch(repo, branch, { files: o.files ?? [file("src/app.ts")], aheadBy: o.aheadBy ?? 1, ...(o.branchOid ? { oid: o.branchOid } : {}) });

    let specId: string | null = null;
    if (o.scope !== false) {
      specId = randomUUID();
      await h.admin.query(
        `INSERT INTO spec_versions (id, account_id, work_item_id, version, body, body_sha256, frontmatter, created_by_kind)
         VALUES ($1, $2, $3, (SELECT COALESCE(max(version), 0) + 1 FROM spec_versions WHERE work_item_id = $3), 'spec', $4, $5::jsonb, 'system')`,
        [specId, A.accountId, A.workItemId, sha256Text("spec"), JSON.stringify({ acceptance_files: o.scope === undefined ? ["src/**"] : o.scope })],
      );
    }
    const job: Job = {
      schema_version: 1,
      job_id: randomUUID(),
      run_id: runId,
      repo: { id: A.repoId, owner: "acme", name: "widgets", private: true },
      role: (o.role ?? "executor") as Job["role"],
      mode: "local",
      spec: null,
      task: { kind: o.continues ? "fix" : "implement", prompt: "p", prompt_sha256: sha256Text("p") },
      role_card: { text: "c", sha256: sha256Text("c") },
      role_tools_sha256: "a".repeat(64),
      continues: o.continues ? { parent_run_id: randomUUID(), session_id: "sess-1", branch: o.continues.branch } : null,
      branch_prefix: "fx/",
      model_hint: null,
      issued_at: "2026-10-10T12:00:00.000Z",
      expires_at: "2026-10-13T12:00:00.000Z",
      key_id: "k1",
    };
    await h.admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed, runner_id, lease_generation, lease_expires_at, started_at, spec_version_id)
       VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, $8::jsonb, $9, $10, now() + interval '90 seconds', now(), $11)`,
      [runId, A.accountId, o.workItem === false ? null : A.workItemId, o.role ?? "executor", o.runtime ?? "runner", o.runMode ?? "runner_local", A.repoId, JSON.stringify(signJob(job, signing)), runnerId, gen, specId],
    );
    if (o.repoMode) await h.admin.query("UPDATE repos SET execution_mode = $2 WHERE id = $1", [A.repoId, o.repoMode]);
    else await h.admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
    if (o.dispatchBase !== undefined && o.dispatchBase !== "unrecorded") {
      await h.admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, $3, $4::jsonb)", [A.accountId, runId, DISPATCH_BASE_KIND, JSON.stringify({ head_oid: o.dispatchBase })]);
    }
    const port = createRunPullRequestPort({ open: async () => fake, appLogin: async () => FAKE_APP_LOGIN, sleep: async () => undefined });
    return {
      runId,
      gen,
      branch,
      fake,
      repo,
      call: ({ body, deps } = {}) =>
        toResponse(() => {
          const payload = body ?? { run_id: runId, lease_generation: gen };
          const req: RunnerHttpRequest = signed(key, donePath(runId), payload);
          return doneRun(h.deps({ leases, pullRequests: o.port === "none" ? null : port, ...deps }), req, runId);
        }),
    };
  }

  const labels = (f: FakeGithub) => f.calls.map((c) => c.label);
  const verdictOf = (): RunnerDoneStored => finished[0]!.verdict as RunnerDoneStored;
  const parsedDone = (res: { body: unknown }) => DoneReply.parse(res.body);

  describe("an executor with a commit inside the Spec's scope", () => {
    it("opens a DRAFT first, reads the paths, marks it ready, and succeeds with the pull request number: A1 to A5 only, zero refusals", async () => {
      const s = await scene({ files: [file("src/app.ts"), file("src/lib/x.ts", "ADDED")] });
      const res = await s.call();
      expect(res.status).toBe(200);
      expect(parsedDone(res)).toEqual({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: 1 });
      expect(labels(s.fake)).toEqual(["A2", "A1 RunBranchState", "A3", "A4", "A1 PullRequestFiles", "A1 MarkReady"]);
      expect(s.fake.denied).toBe(0);
      expect(s.repo.pulls).toHaveLength(1);
      expect(s.repo.pulls[0]).toMatchObject({ draft: false, state: "open", head: s.branch, title: "Add the footer" });
      expect(s.repo.pulls[0]!.body).toContain(s.runId);
      // The branch the verdict was judged on is recorded next to the pull request number (C25 section 1.2).
      expect(verdictOf()).toEqual({ outcome: "succeeded", failureReason: null, prNumber: 1, branch: s.branch });
    });

    it("the pull request body names the work item's issue (Closes #N) from our own row, so the webhook moves the item at once; an item with no issue gets today's body", async () => {
      await h.admin.query("UPDATE work_items SET gh_number = 595 WHERE id = $1", [A.workItemId]);
      try {
        const s = await scene({ files: [file("src/app.ts")] });
        expect((await s.call()).status).toBe(200);
        expect(s.repo.pulls[0]!.body.split("\n")).toContain("Closes #595");
      } finally {
        await h.admin.query("UPDATE work_items SET gh_number = NULL WHERE id = $1", [A.workItemId]);
      }
      const bare = await scene({ files: [file("src/app.ts")] });
      await bare.call();
      expect(bare.repo.pulls[0]!.body).not.toMatch(/Closes #/);
    });

    it("records the fresh run's branch fx/<run>-g<generation> with the pull request number, on a violation too, and no branch where there is no pull request", async () => {
      const g2 = await scene({ gen: 2 });
      await g2.call();
      expect(verdictOf().branch).toBe(`fx/${g2.runId}-g2`);
      finished.length = 0;
      const violation = await scene({ files: [file("outside/x.ts", "ADDED")] });
      await violation.call();
      expect(verdictOf()).toMatchObject({ failureReason: "scope_violation", prNumber: 1, branch: violation.branch });
      finished.length = 0;
      const none = await scene({ aheadBy: 0 });
      await none.call();
      expect(verdictOf()).toEqual({ outcome: "failed", failureReason: "no_commit", prNumber: null });
    });

    it("passes the runner's session id and agentOutput on to be recorded, and nothing else of its body", async () => {
      const s = await scene();
      await s.call({ body: { run_id: s.runId, lease_generation: s.gen, session_id: "7f0c1d2e-aaaa", agentOutput: { verdict: "pass", note: "ok" } } });
      expect(finished[0]).toMatchObject({ accountId: A.accountId, runnerId, runId: s.runId, leaseGeneration: s.gen, sessionId: "7f0c1d2e-aaaa", agentOutput: { verdict: "pass", note: "ok" } });
    });

    it("every change type that deletes nothing passes when its path is in scope: ADDED, MODIFIED, CHANGED, DELETED and COPIED", async () => {
      const s = await scene({ files: (["ADDED", "MODIFIED", "CHANGED", "DELETED", "COPIED"] as const).map((t, i) => file(`src/f${i}.ts`, t)) });
      expect(parsedDone(await s.call())).toMatchObject({ outcome: "succeeded", pr_number: 1 });
    });

    it("scope entries with brace groups and Next.js segments are held to (C23)", async () => {
      const s = await scene({ scope: ["apps/web/app/api/runner/runs/[id]/{events,done}/route.ts"], files: [file("apps/web/app/api/runner/runs/[id]/done/route.ts")] });
      expect(parsedDone(await s.call())).toMatchObject({ outcome: "succeeded" });
    });
  });

  describe("no commit (C21 section 5.4, the first test; C23 section 5)", () => {
    it("a missing branch ends the run failed no_commit and opens no pull request", async () => {
      const s = await scene({ pushed: false });
      const res = await s.call();
      expect(parsedDone(res)).toEqual({ continue: false, outcome: "failed", failure_reason: "no_commit", pr_number: null });
      expect(labels(s.fake)).toEqual(["A2", "A1 RunBranchState"]);
      expect(s.repo.pulls).toHaveLength(0);
    });

    it("a branch with no commits ahead of the base is no_commit", async () => {
      const s = await scene({ aheadBy: 0 });
      expect(parsedDone(await s.call()).failure_reason).toBe("no_commit");
      expect(labels(s.fake)).not.toContain("A4");
    });

    it("an aheadBy of null (the base cannot be compared) is no_commit, and no pull request call is made", async () => {
      const s = await scene();
      s.fake.inject = { label: /^A1 RunBranchState$/, reply: { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main" }, ref: { name: s.branch, target: { oid: "b".repeat(40) } }, baseRef: null } } } } };
      const res = await s.call();
      expect(parsedDone(res)).toEqual({ continue: false, outcome: "failed", failure_reason: "no_commit", pr_number: null });
      expect(labels(s.fake)).toEqual(["A2", "A1 RunBranchState"]);
      s.fake.inject = { label: /^A1 RunBranchState$/, reply: { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main" }, ref: { name: s.branch, target: { oid: "b".repeat(40) } }, baseRef: { compare: null } } } } } };
      const again = await s.call();
      expect(parsedDone(again).failure_reason).toBe("no_commit");
      expect(s.repo.pulls).toHaveLength(0);
    });

    // C25 section 4 / the review's blocker: "no commit" is judged BEFORE "the scope cannot be read". Swapping the two checks in done.ts must turn these red.
    it("a missing branch whose scope is also unreadable ends no_commit, never scope_unknown, and the pull request port is never called", async () => {
      const s = await scene({ pushed: false, scope: false });
      expect(parsedDone(await s.call())).toEqual({ continue: false, outcome: "failed", failure_reason: "no_commit", pr_number: null });
      expect(labels(s.fake)).toEqual(["A2", "A1 RunBranchState"]);
      expect(labels(s.fake)).not.toContain("A3");
      expect(labels(s.fake)).not.toContain("A4");
    });

    it("a branch with no commit ahead whose scope is also unreadable ends no_commit, never scope_unknown, and the pull request port is never called", async () => {
      const s = await scene({ aheadBy: 0, scope: [] });
      expect(parsedDone(await s.call())).toEqual({ continue: false, outcome: "failed", failure_reason: "no_commit", pr_number: null });
      expect(labels(s.fake)).toEqual(["A2", "A1 RunBranchState"]);
    });

    it("checks the CURRENT generation's branch: a commit on another generation's branch does not count", async () => {
      const s = await scene({ gen: 2, pushed: false });
      s.fake.pushBranch(s.repo, `fx/${s.runId}-g1`, { files: [file("src/app.ts")], aheadBy: 3 });
      expect(parsedDone(await s.call()).failure_reason).toBe("no_commit");
      expect(s.repo.pulls).toHaveLength(0);
      expect(s.fake.calls.every((c) => !JSON.stringify(c).includes("-g1"))).toBe(true);
    });
  });

  describe("a continuation (a fix round) works on exactly its own branch and must add a commit of its own", () => {
    const BRANCH = "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1";
    it("succeeds when the head differs from the head recorded at dispatch, on the continuation's branch", async () => {
      const s = await scene({ continues: { branch: BRANCH }, dispatchBase: "c".repeat(40), branchOid: "d".repeat(40) });
      expect(parsedDone(await s.call())).toMatchObject({ outcome: "succeeded" });
      expect(s.repo.pulls[0]!.head).toBe(BRANCH);
    });

    it("is no_commit when the head is the one recorded at dispatch, even though the branch is ahead of the base", async () => {
      const s = await scene({ continues: { branch: BRANCH }, dispatchBase: "c".repeat(40), branchOid: "c".repeat(40), aheadBy: 4 });
      expect(parsedDone(await s.call()).failure_reason).toBe("no_commit");
      expect(s.repo.pulls).toHaveLength(0);
    });

    it("a continuation with NO recorded dispatch head ends internal_error, not no_commit, and GitHub is not asked (C25 section 4 a)", async () => {
      const s = await scene({ continues: { branch: BRANCH }, dispatchBase: "unrecorded", branchOid: "d".repeat(40) });
      expect(parsedDone(await s.call())).toEqual({ continue: false, outcome: "failed", failure_reason: "internal_error", pr_number: null });
      expect(s.fake.calls).toEqual([]);
      expect(s.repo.pulls).toHaveLength(0);
    });

    it("done for a continuation records the continuation's own branch next to the pull request number, and a two-round chain keeps the first run's branch", async () => {
      const s = await scene({ continues: { branch: BRANCH }, dispatchBase: "c".repeat(40), branchOid: "d".repeat(40) });
      await s.call();
      expect(verdictOf()).toEqual({ outcome: "succeeded", failureReason: null, prNumber: 1, branch: BRANCH });
    });

    it("a branch that did not exist at dispatch (recorded null) passes once it exists and is ahead", async () => {
      const s = await scene({ continues: { branch: BRANCH }, dispatchBase: null, branchOid: "d".repeat(40) });
      expect(parsedDone(await s.call())).toMatchObject({ outcome: "succeeded" });
    });

    it("reads the newest dispatch record, not the first", async () => {
      const s = await scene({ continues: { branch: BRANCH }, dispatchBase: "c".repeat(40), branchOid: "e".repeat(40) });
      await h.admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 2, $3, $4::jsonb)", [A.accountId, s.runId, DISPATCH_BASE_KIND, JSON.stringify({ head_oid: "e".repeat(40) })]);
      expect(parsedDone(await s.call()).failure_reason).toBe("no_commit");
    });
  });

  describe("the scope cannot be checked (C21 section 5.4)", () => {
    // D#6 R4d-5a (C34 section 2.2, F7): a Spec with no list (an empty one, or none stored) names the cause; an unreadable list keeps the detail-less answer.
    for (const [label, scope, detail] of [
      ["no Spec version on the run", false, undefined],
      ["a Spec with an empty list", [], "no_file_list"],
      ["a Spec whose stored list is null", null, "no_file_list"],
      ["a list the matcher cannot read", ["src/[ab].ts"], undefined],
      ["a brace group with one alternative", ["a/{b}"], undefined],
      ["a list that is not a list", "src/**", undefined],
    ] as const) {
      it(`${label} ends failed scope_unknown, with no pull request and the branch kept`, async () => {
        const s = await scene({ scope });
        const res = await s.call();
        expect(parsedDone(res)).toEqual({ continue: false, outcome: "failed", failure_reason: "scope_unknown", pr_number: null });
        expect(s.repo.pulls).toHaveLength(0);
        expect(s.repo.branches.has(s.branch)).toBe(true);
        expect(labels(s.fake)).not.toContain("A4");
        expect(verdictOf().detail).toBe(detail);
      });
    }
  });

  describe("a path outside the scope (C21 section 5.4)", () => {
    it("closes the pull request and ends failed scope_violation, with the pull request number and the branch kept", async () => {
      const s = await scene({ files: [file("src/app.ts"), file("secrets/key.pem", "ADDED")] });
      const res = await s.call();
      expect(parsedDone(res)).toEqual({ continue: false, outcome: "failed", failure_reason: "scope_violation", pr_number: 1 });
      expect(s.repo.pulls[0]!.state).toBe("closed");
      expect(s.repo.branches.has(s.branch)).toBe(true);
      expect(labels(s.fake)).toEqual(["A2", "A1 RunBranchState", "A3", "A4", "A1 PullRequestFiles", "A5"]);
      expect(labels(s.fake)).not.toContain("A1 MarkReady");
    });

    it("a DELETED path outside the scope is a violation: a deletion reports its own path", async () => {
      const s = await scene({ files: [file("src/app.ts"), file("docs/old.md", "DELETED")] });
      expect(parsedDone(await s.call())).toMatchObject({ failure_reason: "scope_violation", pr_number: 1 });
      expect(s.repo.pulls[0]!.state).toBe("closed");
    });

    it("a listing with fewer paths than its total (an incomplete count) is a violation, even if every path read is in scope", async () => {
      const s = await scene();
      s.fake.before = () => {
        s.fake.inject = null;
      };
      const original = s.fake.request.bind(s.fake);
      s.fake.request = async (req) => {
        const res = await original(req);
        const body = res.body as { data?: { repository?: { pullRequest?: { files?: { totalCount: number } } } } };
        if (body.data?.repository?.pullRequest?.files) body.data.repository.pullRequest.files.totalCount = 5;
        return res;
      };
      const res = await s.call();
      expect(parsedDone(res)).toMatchObject({ failure_reason: "scope_violation", pr_number: 1 });
      expect(s.repo.pulls[0]!.state).toBe("closed");
    });
  });

  describe("renames end the run scope_unknown (C23 section 3)", () => {
    it("a RENAMED entry whose new path is in scope: the draft is closed, the run fails scope_unknown, the branch stays", async () => {
      const s = await scene({ files: [file("src/new-name.ts", "RENAMED")] });
      const res = await s.call();
      expect(parsedDone(res)).toEqual({ continue: false, outcome: "failed", failure_reason: "scope_unknown", pr_number: 1 });
      expect(verdictOf().detail).toBe("renamed");
      expect(s.repo.pulls[0]!.state).toBe("closed");
      expect(s.repo.branches.has(s.branch)).toBe(true);
      expect(labels(s.fake)).not.toContain("A1 MarkReady");
    });

    it("an unknown change type ends it the same way", async () => {
      const s = await scene({ files: [file("src/a.ts", "SYMLINKED")] });
      expect(parsedDone(await s.call())).toMatchObject({ failure_reason: "scope_unknown", pr_number: 1 });
      expect(verdictOf().detail).toBe("unknown_change_type");
      expect(s.repo.pulls[0]!.state).toBe("closed");
    });

    it("the rename check runs BEFORE path matching: a rename next to an out-of-scope path is scope_unknown, not scope_violation", async () => {
      const s = await scene({ files: [file("src/new.ts", "RENAMED"), file("elsewhere/x.ts", "ADDED")] });
      expect(parsedDone(await s.call()).failure_reason).toBe("scope_unknown");
    });

    it("the count check runs BEFORE the rename check: an incomplete listing holding a rename is a scope_violation", async () => {
      const s = await scene({ files: [file("src/new.ts", "RENAMED")] });
      const original = s.fake.request.bind(s.fake);
      s.fake.request = async (req) => {
        const res = await original(req);
        const body = res.body as { data?: { repository?: { pullRequest?: { files?: { totalCount: number } } } } };
        if (body.data?.repository?.pullRequest?.files) body.data.repository.pullRequest.files.totalCount = 9;
        return res;
      };
      expect(parsedDone(await s.call()).failure_reason).toBe("scope_violation");
    });
  });

  describe("a repository without draft pull requests (C23 section 4)", () => {
    it("opens ONE ready pull request after the draft is refused, skips MarkReady, and succeeds", async () => {
      const s = await scene({ drafts: false });
      const res = await s.call();
      expect(parsedDone(res)).toEqual({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: 1 });
      expect(labels(s.fake)).toEqual(["A2", "A1 RunBranchState", "A3", "A4", "A3", "A4", "A1 PullRequestFiles"]);
      expect(labels(s.fake)).not.toContain("A1 MarkReady");
      expect(s.repo.pulls[0]!.draft).toBe(false);
      expect(s.repo.pulls[0]!.body).toContain("Opened as ready because this repository does not support draft pull requests.");
    });

    it("a violation after the fallback still closes the (ready) pull request", async () => {
      const s = await scene({ drafts: false, files: [file("outside/x.ts", "ADDED")] });
      expect(parsedDone(await s.call())).toMatchObject({ failure_reason: "scope_violation", pr_number: 1 });
      expect(s.repo.pulls[0]!.state).toBe("closed");
      expect(labels(s.fake)).not.toContain("A1 MarkReady");
    });

    it("a pull request that is already ready (reused after an earlier attempt marked it) is not marked again", async () => {
      const s = await scene();
      s.fake.addForeignPull(s.repo, { head: s.branch, author: { login: FAKE_APP_LOGIN, type: "Bot" }, draft: false });
      expect(parsedDone(await s.call())).toMatchObject({ outcome: "succeeded", pr_number: 1 });
      expect(labels(s.fake)).not.toContain("A1 MarkReady");
      expect(labels(s.fake)).not.toContain("A4");
    });
  });

  describe("GitHub refuses the pull request for good: pr_rejected (C23 section 4, and the author rule)", () => {
    it("a 422 on create that is not the draft refusal ends failed pr_rejected with the status, no pull request, branch kept, and no 503", async () => {
      const s = await scene();
      s.fake.inject = { label: /^A4$/, reply: { status: 422, body: { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "A pull request already exists for acme:other." }] } } };
      const res = await s.call();
      expect(res.status).toBe(200);
      expect(parsedDone(res)).toEqual({ continue: false, outcome: "failed", failure_reason: "pr_rejected", pr_number: null });
      expect(verdictOf()).toEqual({ outcome: "failed", failureReason: "pr_rejected", prNumber: null, prHttpStatus: 422 });
      expect(s.repo.pulls).toHaveLength(0);
      expect(s.repo.branches.has(s.branch)).toBe(true);
    });

    it("a 422 on the ready retry is final too", async () => {
      const s = await scene({ drafts: false });
      let creates = 0;
      s.fake.before = (req) => {
        if (req.method === "POST") creates++;
        if (req.method === "POST" && creates === 2) s.fake.inject = { label: /^A4$/, reply: { status: 422, body: { message: "Validation Failed", errors: [{ message: "No commits between main and x" }] } } };
      };
      const res = await s.call();
      expect(parsedDone(res).failure_reason).toBe("pr_rejected");
      expect(verdictOf().prHttpStatus).toBe(422);
      expect(creates).toBe(2);
    });

    it("an open pull request on the run's branch that our App did not open is left alone and ends the run pr_rejected, with no status", async () => {
      const s = await scene();
      s.fake.addForeignPull(s.repo, { head: s.branch, author: { login: "octocat", type: "User" } });
      const res = await s.call();
      expect(parsedDone(res)).toEqual({ continue: false, outcome: "failed", failure_reason: "pr_rejected", pr_number: null });
      expect(verdictOf().prHttpStatus).toBeUndefined();
      expect(s.repo.pulls).toHaveLength(1);
      expect(s.repo.pulls[0]!.state).toBe("open");
      expect(labels(s.fake)).toEqual(["A2", "A1 RunBranchState", "A3"]);
    });

    it("an open pull request our App opened is reused: no second one, same number", async () => {
      const s = await scene();
      s.fake.addForeignPull(s.repo, { head: s.branch, author: { login: FAKE_APP_LOGIN, type: "Bot" }, draft: true });
      expect(parsedDone(await s.call())).toMatchObject({ outcome: "succeeded", pr_number: 1 });
      expect(s.repo.pulls).toHaveLength(1);
      expect(labels(s.fake)).not.toContain("A4");
    });

    it("a permanent refusal at the read step has no reason of its own in the Spec: internal_error and no pull request", async () => {
      const read = await scene();
      read.fake.inject = { label: /^A2$/, reply: { status: 404, body: { message: "Not Found" } } };
      expect(parsedDone(await read.call())).toEqual({ continue: false, outcome: "failed", failure_reason: "internal_error", pr_number: null });
    });

    // GitHub's real answer when the runner's pull request token (pull_requests:write, no contents:write) calls markPullRequestReadyForReview:
    // HTTP 200, data null, one FORBIDDEN error. The scope check has already passed, so the pull request stays open as a draft (C37).
    const FORBIDDEN_READY: { status: number; body: unknown } = {
      status: 200,
      body: { data: { markPullRequestReadyForReview: null }, errors: [{ type: "FORBIDDEN", path: ["markPullRequestReadyForReview"], locations: [{ line: 2, column: 3 }], message: "Resource not accessible by integration" }] },
    };

    it("a FORBIDDEN refusal to mark ready (after the scope check passed) succeeds the run, leaves the pull request open as a draft, closes nothing and logs one line", async () => {
      const ready = await scene();
      const lines: string[] = [];
      ready.fake.inject = { label: /^A1 MarkReady$/, reply: FORBIDDEN_READY };
      expect(parsedDone(await ready.call({ deps: { log: (l) => void lines.push(l) } }))).toEqual({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: 1 });
      expect(ready.repo.pulls[0]).toMatchObject({ draft: true, state: "open" });
      expect(labels(ready.fake)).not.toContain("A5");
      // The branch the run was judged on is still recorded with the pull request number.
      expect(verdictOf()).toEqual({ outcome: "succeeded", failureReason: null, prNumber: 1, branch: ready.branch });
      expect(lines.map((l) => JSON.parse(l))).toEqual([{ event: "runner.done.pr_failure", run_id: ready.runId, stage: "ready", op: "MarkReady", reason: "rejected", status: 200, graphql_types: ["FORBIDDEN"] }]);
    });

    it("a refusal at the files step still closes the pull request, while a scope violation is still judged before any mark-ready", async () => {
      const files = await scene();
      files.fake.inject = { label: /^A1 PullRequestFiles$/, reply: { status: 200, body: { data: { repository: { pullRequest: null } }, errors: [{ type: "FORBIDDEN", message: "gone" }] } } };
      expect(parsedDone(await files.call())).toMatchObject({ outcome: "failed", failure_reason: "internal_error", pr_number: 1 });
      expect(files.repo.pulls[0]).toMatchObject({ draft: true, state: "closed" });
      expect(labels(files.fake)).toContain("A5");
      expect(labels(files.fake)).not.toContain("A1 MarkReady");
    });

    it("a permanent refusal reading the changed files closes the draft and ends internal_error with its number", async () => {
      const s = await scene();
      s.fake.inject = { label: /^A1 PullRequestFiles$/, reply: { status: 200, body: { data: { repository: { pullRequest: null } }, errors: [{ type: "FORBIDDEN", message: "gone" }] } } };
      expect(parsedDone(await s.call())).toEqual({ continue: false, outcome: "failed", failure_reason: "internal_error", pr_number: 1 });
      expect(s.repo.pulls[0]!.state).toBe("closed");
      expect(labels(s.fake)).not.toContain("A1 MarkReady");
    });

    it("a permanent refusal after the READY fallback closes that ready pull request too", async () => {
      const s = await scene({ drafts: false });
      s.fake.inject = { label: /^A1 PullRequestFiles$/, reply: { status: 200, body: { data: { repository: { pullRequest: null } }, errors: [{ type: "FORBIDDEN", message: "gone" }] } } };
      expect(parsedDone(await s.call())).toMatchObject({ failure_reason: "internal_error", pr_number: 1 });
      expect(s.repo.pulls[0]).toMatchObject({ draft: false, state: "closed" });
    });

    it("if closing the unchecked pull request cannot reach GitHub, the answer is 503 with no write (the retry finds it again)", async () => {
      const s = await scene();
      s.fake.inject = { label: /^A1 PullRequestFiles$/, reply: { status: 200, body: { data: { repository: { pullRequest: null } }, errors: [{ type: "FORBIDDEN", message: "gone" }] } } };
      s.fake.before = (req) => {
        if (req.method === "PATCH") s.fake.inject = { label: /^A5$/, reply: { status: 502, body: {} } };
      };
      const res = await s.call();
      expect(res.status).toBe(503);
      expect(finished).toEqual([]);
    });

    // The live failure: the pull request was opened a second before, and GraphQL answered NOT_FOUND for it.
    const notFound = { status: 200, body: { data: { repository: { pullRequest: null } }, errors: [{ type: "NOT_FOUND", path: ["repository", "pullRequest"], message: "Could not resolve to a PullRequest with the number of 1." }] } };
    const lagFor = (s: Scene, reads: number) => {
      const real = s.fake.request.bind(s.fake);
      let seen = 0;
      s.fake.request = async (req) => (req.path === "/graphql" && (req.body as { query: string }).query.includes("PullRequestFiles") && ++seen <= reads ? notFound : real(req));
    };

    it("a new pull request GraphQL cannot show for a moment is waited for: the run succeeds, no log line", async () => {
      const s = await scene();
      const lines: string[] = [];
      lagFor(s, 2);
      expect(parsedDone(await s.call({ deps: { log: (l) => void lines.push(l) } }))).toEqual({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: 1 });
      expect(s.repo.pulls[0]).toMatchObject({ draft: false, state: "open" });
      expect(lines).toEqual([]);
    });

    it("one that stays invisible is 503 with no write and the pull request left open (the runner's next done finds it again)", async () => {
      const s = await scene();
      lagFor(s, 1000);
      const res = await s.call();
      expect(res.status).toBe(503);
      expect(finished).toEqual([]);
      expect(s.repo.pulls[0]!.state).toBe("open");
    });

    it("every permanent failure after the pull request exists logs one structured line: run, stage, call, status, GraphQL types, nothing GitHub wrote", async () => {
      const files = await scene();
      const lines: string[] = [];
      files.fake.inject = { label: /^A1 PullRequestFiles$/, reply: { status: 200, body: { data: { repository: { pullRequest: null } }, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration acme/widgets" }] } } };
      expect(parsedDone(await files.call({ deps: { log: (l) => void lines.push(l) } }))).toMatchObject({ failure_reason: "internal_error", pr_number: 1 });
      expect(lines.map((l) => JSON.parse(l))).toEqual([{ event: "runner.done.pr_failure", run_id: files.runId, stage: "files", op: "PullRequestFiles", reason: "rejected", status: 200, graphql_types: ["FORBIDDEN"] }]);
      expect(lines.join("")).not.toMatch(/acme|widgets|accessible/);

      const ready = await scene();
      const readyLines: string[] = [];
      ready.fake.inject = { label: /^A1 MarkReady$/, reply: { status: 200, body: { data: { markPullRequestReadyForReview: null }, errors: [{ type: "UNPROCESSABLE", message: "nope" }] } } };
      await ready.call({ deps: { log: (l) => void readyLines.push(l) } });
      expect(readyLines.map((l) => JSON.parse(l))).toEqual([{ event: "runner.done.pr_failure", run_id: ready.runId, stage: "ready", op: "MarkReady", reason: "rejected", status: 200, graphql_types: ["UNPROCESSABLE"] }]);

      const rest = await scene();
      const restLines: string[] = [];
      rest.fake.inject = { label: /^A2$/, reply: { status: 404, body: { message: "Not Found" } } };
      await rest.call({ deps: { log: (l) => void restLines.push(l) } });
      expect(restLines.map((l) => JSON.parse(l))).toEqual([{ event: "runner.done.pr_failure", run_id: rest.runId, stage: "read", op: "defaultBranch", reason: "rejected", status: 404, graphql_types: [] }]);
    });
  });

  describe("GitHub cannot be asked: 503 { retry_after } and nothing is written (C21 section 1)", () => {
    const failures: Array<[string, RegExp, GithubReply]> = [
      ["the default branch read", /^A2$/, { status: 502, body: { message: "Bad Gateway" } }],
      ["the branch state", /^A1 RunBranchState$/, { status: 503, body: {} }],
      ["the pull request lookup", /^A3$/, { status: 500, body: {} }],
      ["the create", /^A4$/, { status: 502, body: {} }],
      ["the file listing", /^A1 PullRequestFiles$/, { status: 200, body: { errors: [{ type: "RATE_LIMITED", message: "slow down" }] } }],
      ["marking ready", /^A1 MarkReady$/, { status: 429, body: {} }],
    ];
    type GithubReply = { status: number; body: unknown };
    for (const [label, match, reply] of failures) {
      it(`${label}: 503, retry_after 15, no write`, async () => {
        const s = await scene();
        s.fake.inject = { label: match, reply };
        const res = await s.call();
        expect(res.status).toBe(503);
        expect(DoneRetryReply.parse(res.body)).toEqual({ retry_after: 15 });
        expect(res.headers).toMatchObject({ "retry-after": "15" });
        expect(finished).toEqual([]);
      });
    }

    it("a transport error (a thrown request) is 503 as well, with no write", async () => {
      const s = await scene();
      s.fake.inject = { label: /^A1 RunBranchState$/, reply: new Error("ECONNRESET 10.0.0.1:443") };
      const res = await s.call();
      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).not.toContain("ECONNRESET");
      expect(finished).toEqual([]);
    });

    it("closing a violating pull request that GitHub cannot reach is a 503 too, with no write; the retry then finds it and finishes", async () => {
      const s = await scene({ files: [file("outside/x.ts", "ADDED")] });
      s.fake.inject = { label: /^A5$/, reply: { status: 502, body: {} } };
      expect((await s.call()).status).toBe(503);
      expect(finished).toEqual([]);
      expect(parsedDone(await s.call())).toMatchObject({ failure_reason: "scope_violation", pr_number: 1 });
      expect(s.repo.pulls).toHaveLength(1);
    });

    it("after a 503 the retry reuses the pull request the first attempt opened (our App's) and succeeds", async () => {
      const s = await scene();
      s.fake.inject = { label: /^A1 PullRequestFiles$/, reply: { status: 502, body: {} } };
      expect((await s.call()).status).toBe(503);
      expect(parsedDone(await s.call())).toMatchObject({ outcome: "succeeded", pr_number: 1 });
      expect(s.repo.pulls).toHaveLength(1);
    });
  });

  describe("the run's OWN execution mode decides, never the repository's current one (C24 section 2)", () => {
    it("a run claimed as runner_local keeps the local-only path through done after its repository was switched away", async () => {
      const s = await scene({ repoMode: "sandbox" });
      const res = await s.call();
      expect(parsedDone(res)).toMatchObject({ outcome: "succeeded", pr_number: 1 });
      expect(s.fake.denied).toBe(0);
      expect(labels(s.fake)).toEqual(["A2", "A1 RunBranchState", "A3", "A4", "A1 PullRequestFiles", "A1 MarkReady"]);
    });

    // D#6 R5b-1 (C38): `done` takes both runner modes. The run keeps its own mode through the verdict (C24 section 2).
    it("a runner_verified executor run that pushed through path A is recorded exactly as a runner_local one is, even after its repository moved to runner_local", async () => {
      for (const repoMode of ["runner_verified", "runner_local"]) {
        const s = await scene({ runMode: "runner_verified", repoMode, files: [file("src/app.ts")] });
        const res = await s.call();
        expect(parsedDone(res), repoMode).toEqual({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: 1 });
        expect(s.fake.denied).toBe(0);
        expect(finished.at(-1)!.verdict).toEqual({ outcome: "succeeded", failureReason: null, prNumber: 1, branch: s.branch });
      }
    });

    it("a runner_verified run is held to the Spec's file list as a runner_local run is: no readable list is scope_unknown, a path outside it a violation", async () => {
      const unknown = await scene({ runMode: "runner_verified", repoMode: "runner_verified", scope: false });
      expect(parsedDone(await unknown.call())).toMatchObject({ outcome: "failed", failure_reason: "scope_unknown" });
      const outside = await scene({ runMode: "runner_verified", repoMode: "runner_verified", files: [file("docs/readme.md")] });
      expect(parsedDone(await outside.call())).toMatchObject({ outcome: "failed", failure_reason: "scope_violation" });
    });

    it("a run that is not a runner_local runner run is failed internal_error with no GitHub call, whatever its repository says", async () => {
      const s = await scene({ runtime: "production", runMode: "sandbox", repoMode: "runner_local" });
      expect(parsedDone(await s.call())).toEqual({ continue: false, outcome: "failed", failure_reason: "internal_error", pr_number: null });
      expect(s.fake.calls).toEqual([]);
    });

    it("a runner run whose OWN mode is not runner_local gets no GitHub call even while its repository is runner_local", async () => {
      const s = await scene({ runMode: "sandbox", repoMode: "runner_local" });
      expect(parsedDone(await s.call())).toMatchObject({ outcome: "failed", failure_reason: "internal_error" });
      expect(s.fake.calls).toEqual([]);
    });
  });

  describe("a run its owner took over (D#6 R4a-7)", () => {
    /** The `taken_over` event the runner sent, stored the way the events route stores a runner's event. */
    async function storeTakenOver(runId: string): Promise<void> {
      await h.admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 5, 'runner.event', $3::jsonb)", [
        A.accountId,
        runId,
        JSON.stringify({ seq: 3, ts: "2026-10-10T12:00:00.000Z", type: "taken_over" }),
      ]);
    }

    it("an executor with a commit inside the scope still ends failed taken_over: no GitHub call, no pull request, no number", async () => {
      const s = await scene();
      await storeTakenOver(s.runId);
      const res = await s.call();
      expect(parsedDone(res)).toEqual({ continue: false, outcome: "failed", failure_reason: "taken_over", pr_number: null });
      expect(s.fake.calls).toEqual([]);
      expect(s.repo.pulls).toHaveLength(0);
      expect(verdictOf()).toEqual({ outcome: "failed", failureReason: "taken_over", prNumber: null });
    });

    it("a reviewer's run that was taken over fails too, so it can never count toward a merge gate", async () => {
      for (const role of ["code-reviewer", "security-reviewer", "acceptance-tester", "debater"]) {
        finished.length = 0;
        const s = await scene({ role, port: "none", pushed: false });
        await storeTakenOver(s.runId);
        const res = await s.call({ body: { run_id: s.runId, lease_generation: s.gen, agentOutput: { verdict: "pass" } } });
        expect(parsedDone(res), role).toEqual({ continue: false, outcome: "failed", failure_reason: "taken_over", pr_number: null });
        expect(s.fake.calls, role).toEqual([]);
      }
    });

    it("only that run: another run's taken_over event changes nothing here, and a stored event of another kind does not count", async () => {
      const other = await scene({ role: "code-reviewer", port: "none", pushed: false });
      await storeTakenOver(other.runId);
      const s = await scene({ role: "code-reviewer", port: "none", pushed: false });
      await h.admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 5, 'runner.event', $3::jsonb)", [A.accountId, s.runId, JSON.stringify({ seq: 3, type: "tool_use" })]);
      expect(parsedDone(await s.call())).toMatchObject({ outcome: "succeeded", failure_reason: null });
    });
  });

  describe("other roles", () => {
    for (const role of ["code-reviewer", "security-reviewer", "acceptance-tester", "debater", "project-manager"]) {
      it(`${role}: makes no commit, succeeds, and needs neither GitHub nor a configured port`, async () => {
        const s = await scene({ role, port: "none", pushed: false });
        const res = await s.call({ body: { run_id: s.runId, lease_generation: s.gen, agentOutput: { verdict: "pass" } } });
        expect(parsedDone(res)).toEqual({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: null });
        expect(s.fake.calls).toEqual([]);
        expect(finished[0]).toMatchObject({ agentOutput: { verdict: "pass" } });
      });
    }

    describe("a docs-writer goes through the executor's done path (C25 section 3.1)", () => {
      it("a commit inside the scope: a draft pull request on its own branch, marked ready, succeeded with the number and the branch", async () => {
        const s = await scene({ role: "docs-writer", files: [file("src/readme.md")] });
        expect(parsedDone(await s.call())).toEqual({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: 1 });
        expect(labels(s.fake)).toEqual(["A2", "A1 RunBranchState", "A3", "A4", "A1 PullRequestFiles", "A1 MarkReady"]);
        expect(s.repo.pulls[0]).toMatchObject({ head: s.branch, draft: false });
        expect(verdictOf().branch).toBe(s.branch);
      });

      it("a missing branch and a branch with nothing ahead both succeed with no pull request, no pull request call and no branch recorded", async () => {
        for (const o of [{ pushed: false }, { aheadBy: 0 }]) {
          finished.length = 0;
          const s = await scene({ role: "docs-writer", ...o });
          expect(parsedDone(await s.call())).toEqual({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: null });
          expect(labels(s.fake)).toEqual(["A2", "A1 RunBranchState"]);
          expect(verdictOf()).toEqual({ outcome: "succeeded", failureReason: null, prNumber: null });
        }
      });

      it("a no-commit docs-writer whose scope is unreadable still succeeds (no commit is judged before the scope)", async () => {
        const s = await scene({ role: "docs-writer", aheadBy: 0, scope: false });
        expect(parsedDone(await s.call())).toMatchObject({ outcome: "succeeded", pr_number: null });
      });

      it("a comparison that cannot be read (aheadBy null) is internal_error: the cloud is not allowed to call it a success", async () => {
        const s = await scene({ role: "docs-writer" });
        s.fake.inject = { label: /^A1 RunBranchState$/, reply: { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main" }, ref: { name: s.branch, target: { oid: "b".repeat(40) } }, baseRef: null } } } } };
        expect(parsedDone(await s.call())).toEqual({ continue: false, outcome: "failed", failure_reason: "internal_error", pr_number: null });
        expect(s.repo.pulls).toHaveLength(0);
      });

      it("a path outside the scope closes the pull request and ends scope_violation; a rename ends scope_unknown", async () => {
        const out = await scene({ role: "docs-writer", files: [file("secrets/x.pem", "ADDED")] });
        expect(parsedDone(await out.call())).toMatchObject({ failure_reason: "scope_violation", pr_number: 1 });
        expect(out.repo.pulls[0]!.state).toBe("closed");
        const renamed = await scene({ role: "docs-writer", files: [file("src/b.md", "RENAMED")] });
        expect(parsedDone(await renamed.call())).toMatchObject({ failure_reason: "scope_unknown", pr_number: 1 });
        expect(renamed.repo.pulls[0]!.state).toBe("closed");
      });

      it("a commit with an unreadable scope ends scope_unknown with no pull request (a run with no Spec version always does)", async () => {
        const s = await scene({ role: "docs-writer", scope: false });
        expect(parsedDone(await s.call())).toMatchObject({ failure_reason: "scope_unknown", pr_number: null });
        expect(s.repo.pulls).toHaveLength(0);
      });

      it("a commit on a run with no work item cannot be given a pull request text: internal_error, no pull request", async () => {
        const s = await scene({ role: "docs-writer", workItem: false });
        expect(parsedDone(await s.call())).toMatchObject({ failure_reason: "internal_error", pr_number: null });
        expect(s.repo.pulls).toHaveLength(0);
      });

      it("needs a configured GitHub port, like the executor", async () => {
        const s = await scene({ role: "docs-writer", port: "none" });
        expect((await s.call()).status).toBe(503);
      });
    });

    it("an executor with no GitHub access configured is 503 not_configured and writes nothing", async () => {
      const s = await scene({ port: "none" });
      const res = await s.call();
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ error: { code: "not_configured" } });
      expect(finished).toEqual([]);
    });
  });

  describe("the fence and the replay", () => {
    it("a fenced done is 409 { continue:false, reason }, and GitHub is not asked and nothing is finished", async () => {
      for (const reason of ["stale_generation", "lease_expired", "run_terminal", "wall_clock_limit"] as const) {
        const s = await scene();
        begin = { kind: "fenced", reason };
        const res = await s.call();
        expect(res.status).toBe(409);
        expect(StopReply.parse(res.body)).toEqual({ continue: false, reason });
        expect(s.fake.calls).toEqual([]);
      }
      expect(finished).toEqual([]);
    });

    it("a repeat done answers the stored verdict, byte for byte, with no GitHub call and no second write", async () => {
      const s = await scene();
      begin = { kind: "replay", verdict: { outcome: "failed", failureReason: "scope_violation", prNumber: 7 } };
      const res = await s.call();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ continue: false, outcome: "failed", failure_reason: "scope_violation", pr_number: 7 });
      expect(s.fake.calls).toEqual([]);
      expect(finished).toEqual([]);
    });

    it("a lease that ended while GitHub was asked is a stop at the second fence: 409, and the reply is not 200", async () => {
      const s = await scene();
      finish = { kind: "fenced", reason: "lease_expired" };
      const res = await s.call();
      expect(res.status).toBe(409);
      expect(StopReply.parse(res.body)).toEqual({ continue: false, reason: "lease_expired" });
    });

    it("two done attempts that race: the one that finishes second is told the first one's verdict", async () => {
      const s = await scene();
      finish = { kind: "replay", verdict: { outcome: "succeeded", failureReason: null, prNumber: 1 } };
      expect(parsedDone(await s.call())).toEqual({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: 1 });
    });

    it("the worker is told the verified runner's account and id and the body's run and generation, whatever a header says", async () => {
      const s = await scene({ gen: 3 });
      const body = { run_id: s.runId, lease_generation: 3 };
      const req = signed(key, donePath(s.runId), body);
      req.headers = { ...req.headers, "x-fx-account-id": randomUUID() };
      await toResponse(() => doneRun(h.deps({ leases, pullRequests: createRunPullRequestPort({ open: async () => s.fake, appLogin: async () => FAKE_APP_LOGIN }) }), req, s.runId));
      expect(begun[0]).toEqual({ accountId: A.accountId, runnerId, runId: s.runId, leaseGeneration: 3 });
    });
  });

  describe("the request", () => {
    it("is refused 401 when unsigned, signed by another key, or tampered, and reaches nothing", async () => {
      const s = await scene();
      const good = signed(key, donePath(s.runId), { run_id: s.runId, lease_generation: 1 });
      const { signature: _s, "signature-input": _i, ...unsigned } = good.headers;
      const run = (r: RunnerHttpRequest) => toResponse(() => doneRun(h.deps({ leases }), r, s.runId));
      expect((await run({ ...good, headers: unsigned })).status).toBe(401);
      expect((await run(signed(newKey(), donePath(s.runId), { run_id: s.runId, lease_generation: 1 }))).status).toBe(401);
      expect((await run({ ...good, body: Buffer.from(JSON.stringify({ run_id: s.runId, lease_generation: 2 })) })).status).toBe(401);
      expect(begun).toEqual([]);
    });

    it("must name the path's run, be a valid message, and fit the byte cap", async () => {
      const s = await scene();
      expect((await s.call({ body: { run_id: randomUUID(), lease_generation: 1 } })).status).toBe(400);
      expect((await s.call({ body: { run_id: s.runId, lease_generation: 1, extra: true } })).status).toBe(400);
      expect((await s.call({ body: { run_id: s.runId, lease_generation: -1 } })).status).toBe(400);
      expect((await s.call({ body: { run_id: s.runId, lease_generation: 1, session_id: "bad session!" } })).status).toBe(400);
      const huge = signed(key, donePath(s.runId), {}, { rawBody: Buffer.alloc(MAX_BODY_BYTES + 1, 0x20) });
      expect((await toResponse(() => doneRun(h.deps({ leases }), huge, s.runId))).status).toBe(413);
      expect((await toResponse(() => doneRun(h.deps({ leases }), huge, "not-a-uuid"))).status).toBe(404);
      expect(begun).toEqual([]);
    });

    it("answers a worker that is not configured with 503", async () => {
      const s = await scene();
      expect((await s.call({ deps: { leases: null } })).status).toBe(503);
    });
  });
});
