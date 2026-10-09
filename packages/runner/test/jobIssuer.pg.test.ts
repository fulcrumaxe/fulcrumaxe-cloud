import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { REVIEW_JOB_ROLES, RUNNER_ELIGIBLE_ROLES, canonicalJson, jobDigestMismatches, sha256Text, verifyJob, type Job } from "@fulcrumaxe/runner-protocol";
import type { ExecutionRun } from "../src/executionTarget.js";
import { toolsForRole } from "../src/agentConfig.js";
import { JobIssueError, createJobIssuer, createJobSigner, createPgJobContext, roleToolsDigest, type ContinuationBasePort, type JobContextPort } from "../src/targets/jobIssuer.js";
import { RUNNER_QUEUE_TTL_MS, RunnerTarget } from "../src/targets/runnerTarget.js";
import { RUNNER_DISPATCH_BASE_KIND, insertAgentRun } from "../src/runStatusWriter.js";
import { seedAccount, seedMember, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createFakeRunnerLimits, createFakeVisibility } from "./helpers/runnerTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

/** D#6 R3b: the real JobIssuer, over a real database and the real definer. */
describe("JobIssuer [pg]", () => {
  const db = pgHarness();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signer = createJobSigner({ keyId: "job-key-1", privateKey });
  const NOW = new Date("2026-10-04T12:00:00.000Z");
  const CARD = "You are the code reviewer.\n";
  const PROMPT = "Review the pull request.\n";

  async function world(over: { issue?: number | null; spec?: boolean } = {}) {
    const accountId = randomUUID();
    const userId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, userId);
    await seedRepo(db.admin, accountId, repoId, { executionMode: "runner_local" });
    await db.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [repoId]);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: over.issue === undefined ? 12 : (over.issue as number) });
    let specBody: string | null = null;
    if (over.spec !== false) {
      specBody = "1. The footer shows the year.";
      await db.admin.query("INSERT INTO discussions (account_id, number, repo_id, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, 6, $2, 'feature', 'Footer', $3, 'internal', 'system')", [accountId, repoId, workItemId]);
      await db.admin.query("UPDATE work_items SET discussion_id = (SELECT id FROM discussions WHERE account_id = $1 AND root_work_item_id = $2) WHERE id = $2", [accountId, workItemId]);
      await db.admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, $4, 'system')", [accountId, workItemId, specBody, createHash("sha256").update(specBody).digest("hex")]);
    }
    return { accountId, userId, repoId, workItemId, specBody };
  }

  /** A fresh commit id per run: the database allows one live reviewer run per head and role. */
  const freshHead = (): string => (randomUUID() + randomUUID()).replace(/-/g, "").slice(0, 40);
  /**
   * A review role's run carries the pull request head it reviews (stored on the row, as `advanceStartRun` stores it) and a prompt that names it.
   * `over.headSha` / `over.prompt` replace either; `over.headSha: null` is a run with no stored head.
   */
  async function runnerRun(w: { accountId: string; userId: string; repoId: string; workItemId: string }, role = "code-reviewer", parentRunId: string | null = null, over: { headSha?: string | null; prompt?: string } = {}): Promise<ExecutionRun> {
    const id = randomUUID();
    const reviews = (REVIEW_JOB_ROLES as readonly string[]).includes(role);
    const headSha = over.headSha !== undefined ? over.headSha : reviews ? freshHead() : null;
    const prompt = over.prompt ?? (reviews ? `${PROMPT}Review exactly commit ${headSha}.\n` : PROMPT);
    // D#6 R4d-5c (C36): a run built after the pin carries the Spec version it was built against; a child of it inherits that version, and a runner_local
    // executor child of an unpinned run is refused. The fixture's root runs are pinned the way a new build is.
    const pin = parentRunId ? undefined : (await db.admin.query<{ id: string }>("SELECT id FROM spec_versions WHERE work_item_id = $1 ORDER BY version DESC LIMIT 1", [w.workItemId])).rows[0]?.id;
    await insertAgentRun(db.runWriterPool, { id, accountId: w.accountId, workItemId: w.workItemId, parentRunId, ...(pin ? { specVersionId: pin } : {}), role: role as never, runtime: "runner", executionMode: "runner_local", dispatchRepoId: w.repoId, initiatedBy: w.userId, ...(headSha ? { headSha } : {}) });
    return { id, accountId: w.accountId, workItemId: w.workItemId, parentRunId, role: role as never, product: "team", repoId: w.repoId, headSha, roleCard: CARD, prompt, model: "haiku-4.5", capUsd: 0, spend: { plan: "starter", estimateComputeUsd: 0, trigger: "foreground" } };
  }

  function issuer(over: { visibility?: "private" | "public" | "unknown" | "throw"; context?: JobContextPort; base?: ContinuationBasePort | null } = {}) {
    const visibility = createFakeVisibility(over.visibility ?? "private");
    const base = over.base === undefined ? { headOid: async () => "a".repeat(40) } : over.base;
    return {
      visibility,
      issuer: createJobIssuer({ pool: db.runWriterPool, signer, visibility, context: over.context ?? createPgJobContext(db.runWriterPool), ...(base ? { continuationBase: base } : {}), now: () => NOW, newId: () => "7b9d1c6e-4f0a-4c53-9a58-2f0d5b6c3a11" }),
    };
  }

  const stored = async (id: string) => (await db.admin.query(`SELECT job_signed FROM agent_runs WHERE id = $1`, [id])).rows[0].job_signed;
  const codeOf = async (p: Promise<unknown>) => p.then(() => "returned", (e) => (e instanceof JobIssueError ? e.code : `other:${String(e)}`));

  /** The branch `done` records next to the pull request number (C25 section 1.2): written the way the verdict writer writes it. */
  const FIRST_BRANCH = "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1";
  async function recordDone(w: { accountId: string }, run: ExecutionRun, payload: Record<string, unknown> = { viaRunnerDone: true, prNumber: 7, branch: FIRST_BRANCH }): Promise<void> {
    await db.admin.query(
      `INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, (SELECT COALESCE(max(seq), 0) + 1 FROM run_events WHERE run_id = $2), 'run.status_changed', $3::jsonb)`,
      [w.accountId, run.id, JSON.stringify({ from: "running", to: "succeeded", ...payload })],
    );
  }
  /** A finished executor run with its recorded branch, and a fix round that continues it. */
  async function fixPair(w: Parameters<typeof runnerRun>[0] & { accountId: string }, branch = FIRST_BRANCH) {
    const parent = await runnerRun(w, "executor");
    await recordDone(w, parent, { viaRunnerDone: true, prNumber: 7, branch });
    const run = await runnerRun(w, "executor", parent.id);
    return { parent, run };
  }

  it("builds the job from the run, signs it, and records the signed job: a runner can verify it with the public key", async () => {
    const w = await world();
    const run = await runnerRun(w);
    await issuer().issuer.issue({ run });
    const signed = await stored(run.id);
    const job = verifyJob(signed, { "job-key-1": publicKey }, { now: NOW });
    expect(job).toEqual({
      schema_version: 1,
      job_id: "7b9d1c6e-4f0a-4c53-9a58-2f0d5b6c3a11",
      run_id: run.id,
      repo: { id: w.repoId, owner: "acme", name: "widgets", private: true },
      role: "code-reviewer",
      mode: "local",
      spec: { discussion: 6, version: 1, sha256: createHash("sha256").update(w.specBody!).digest("hex"), text: w.specBody },
      task: { kind: "review", prompt: run.prompt, prompt_sha256: sha256Text(run.prompt) },
      role_card: { text: CARD, sha256: sha256Text(CARD) },
      role_tools_sha256: roleToolsDigest("code-reviewer"),
      continues: null,
      review: { head_sha: run.headSha },
      branch_prefix: "fx/",
      model_hint: "haiku-4.5",
      issued_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + 72 * 3600_000).toISOString(),
      key_id: "job-key-1",
    });
    expect(jobDigestMismatches(job)).toEqual([]);
  });

  describe("a review job names the commit to review (D#6 R4d-4a, C33)", () => {
    const rows = async (id: string) => (await db.admin.query("SELECT head_sha, job_signed FROM agent_runs WHERE id = $1", [id])).rows[0];

    it.each(REVIEW_JOB_ROLES)("G4: a %s run's job has task.kind review and review.head_sha equal to the stored agent_runs.head_sha", async (role) => {
      const w = await world();
      const run = await runnerRun(w, role);
      await issuer().issuer.issue({ run });
      const row = await rows(run.id);
      expect(row.head_sha).toBe(run.headSha);
      const job = verifyJob(row.job_signed, { "job-key-1": publicKey }, { now: NOW });
      expect(job.task.kind).toBe("review");
      expect(job.review).toEqual({ head_sha: row.head_sha });
    });

    it("G4: an executor run's job (a build and a fix round) has no review key, and neither do the advise roles", async () => {
      const w = await world();
      const { parent, run: fix } = await fixPair(w);
      for (const run of [await runnerRun(w, "executor"), fix, await runnerRun(w, "docs-writer"), await runnerRun(w, "project-manager"), await runnerRun(w, "accessibility-reviewer")]) {
        await issuer().issuer.issue({ run, ...(run.id === fix.id ? { continues: { parentRunId: parent.id, sessionId: "sess-1" } } : {}) });
        const signed = (await rows(run.id)).job_signed;
        expect("review" in verifyJob(signed, { "job-key-1": publicKey }, { now: NOW }), run.role).toBe(false);
        expect(canonicalJson(signed.job)).not.toContain('"review"');
      }
    });

    it("G5: a review run with head_sha NULL is refused review_without_head, and no job row is written", async () => {
      const w = await world();
      const run = await runnerRun(w, "code-reviewer", null, { headSha: null });
      expect((await rows(run.id)).head_sha).toBeNull();
      expect(await codeOf(issuer().issuer.issue({ run }))).toBe("review_without_head");
      expect((await rows(run.id)).job_signed).toBeNull();
    });

    it.each(["", "C0FFEE".repeat(6) + "ABCD", "abc123", "g".repeat(40)])("G5: a head the run carries that is not a sha (%j) is refused review_without_head, and no job row is written", async (bad) => {
      const w = await world();
      const run = await runnerRun(w, "security-reviewer");
      expect(await codeOf(issuer().issuer.issue({ run: { ...run, headSha: bad } }))).toBe("review_without_head");
      expect((await rows(run.id)).job_signed).toBeNull();
    });

    it.each(REVIEW_JOB_ROLES)("G5: a %s run whose prompt does not contain its head sha is refused review_sha_prompt_mismatch, and no job row is written", async (role) => {
      const w = await world();
      const run = await runnerRun(w, role, null, { prompt: `Review exactly commit ${"d".repeat(40)}.\n` });
      expect(await codeOf(issuer().issuer.issue({ run }))).toBe("review_sha_prompt_mismatch");
      expect((await rows(run.id)).job_signed).toBeNull();
    });

    it("the sha comes from the run's stored head, never from the prompt: a prompt naming two commits still gets the run's own", async () => {
      const w = await world();
      const head = freshHead();
      const run = await runnerRun(w, "code-reviewer", null, { headSha: head, prompt: `Earlier ${"e".repeat(40)} and now ${head}.\n` });
      await issuer().issuer.issue({ run });
      expect(verifyJob((await rows(run.id)).job_signed, { "job-key-1": publicKey }, { now: NOW }).review).toEqual({ head_sha: head });
    });
  });

  it("expires 72 hours after dispatch, the queue TTL", () => {
    expect(RUNNER_QUEUE_TTL_MS).toBe(72 * 3600_000);
  });

  it("a run with no Spec gets spec: null", async () => {
    const w = await world({ spec: false });
    const run = await runnerRun(w, "project-manager");
    await issuer().issuer.issue({ run });
    const job = verifyJob(await stored(run.id), { "job-key-1": publicKey }, { now: NOW });
    expect(job.spec).toBeNull();
    expect(job.task.kind).toBe("advise");
  });

  it("the task kind follows the role: implement, fix (when it continues), review, advise", async () => {
    const w = await world();
    const parent = await runnerRun(w, "executor");
    const kinds: Record<string, Job["task"]["kind"]> = {};
    for (const role of ["executor", "code-reviewer", "debater", "docs-writer"]) {
      const run = await runnerRun(w, role);
      await issuer().issuer.issue({ run });
      kinds[role] = verifyJob(await stored(run.id), { "job-key-1": publicKey }, { now: NOW }).task.kind;
    }
    await recordDone(w, parent);
    const fixRun = await runnerRun(w, "executor", parent.id);
    await issuer().issuer.issue({ run: fixRun, continues: { parentRunId: parent.id, sessionId: "sess-1" } });
    kinds["executor+continues"] = verifyJob(await stored(fixRun.id), { "job-key-1": publicKey }, { now: NOW }).task.kind;
    expect(kinds).toEqual({ executor: "implement", "code-reviewer": "review", debater: "review", "docs-writer": "advise", "executor+continues": "fix" });
  });

  it("a fix round carries the parent run, the session and the branch recorded for the run it fixes, never one derived from the issue (C25 section 1.2)", async () => {
    const w = await world({ issue: 12 });
    const { parent, run } = await fixPair(w);
    await issuer().issuer.issue({ run, continues: { parentRunId: parent.id, sessionId: "7f0c1d2e-aaaa-bbbb-cccc-0123456789ab" } });
    const job = verifyJob(await stored(run.id), { "job-key-1": publicKey }, { now: NOW });
    expect(job.continues).toEqual({ parent_run_id: parent.id, session_id: "7f0c1d2e-aaaa-bbbb-cccc-0123456789ab", branch: FIRST_BRANCH });
    expect(job.continues?.branch).not.toContain("issue-12");
  });

  it("a two-round chain keeps the first run's branch: the second fix round continues the first fix round, whose done recorded the fresh run's branch", async () => {
    const w = await world();
    const { run: first } = await fixPair(w);
    await recordDone(w, first, { viaRunnerDone: true, prNumber: 7, branch: FIRST_BRANCH });
    const second = await runnerRun(w, "executor", first.id);
    await issuer().issuer.issue({ run: second, continues: { parentRunId: first.id, sessionId: "sess-2" } });
    expect(verifyJob(await stored(second.id), { "job-key-1": publicKey }, { now: NOW }).continues?.branch).toBe(FIRST_BRANCH);
  });

  it("treats a recorded value that is not a run branch as no record", async () => {
    const w = await world();
    const parent = await runnerRun(w, "executor");
    await recordDone(w, parent, { viaRunnerDone: true, prNumber: 7, branch: "fx/issue-12" });
    const run = await runnerRun(w, "executor", parent.id);
    expect(await codeOf(issuer().issuer.issue({ run, continues: { parentRunId: parent.id, sessionId: "sess-1" } }))).toBe("continues_without_branch");
  });

  it("a run with no recorded branch is refused continues_without_branch, and nothing is recorded or asked of GitHub", async () => {
    const w = await world();
    const parent = await runnerRun(w, "executor");
    const noBranch = await runnerRun(w, "executor", parent.id);
    let asked = 0;
    expect(await codeOf(issuer({ base: { headOid: async () => (asked++, "a".repeat(40)) } }).issuer.issue({ run: noBranch, continues: { parentRunId: parent.id, sessionId: "sess-1" } }))).toBe("continues_without_branch");
    // A done that named a pull request-less verdict records no branch either.
    const other = await runnerRun(w, "executor");
    await recordDone(w, other, { viaRunnerDone: true, prNumber: null });
    const run = await runnerRun(w, "executor", other.id);
    expect(await codeOf(issuer().issuer.issue({ run, continues: { parentRunId: other.id, sessionId: "sess-1" } }))).toBe("continues_without_branch");
    expect(await stored(noBranch.id)).toBeNull();
    expect(asked).toBe(0);
  });

  it("a follow-up of a fix round carries the parent job's branch unchanged, and refuses anything that is not a run branch (C22 section 2, C25 section 1.2)", async () => {
    const w = await world({ issue: 12 });
    const parent = await runnerRun(w, "executor");
    const same = await runnerRun(w, "executor", parent.id);
    await issuer().issuer.issue({ run: same, continues: { parentRunId: parent.id, sessionId: "sess-1", branch: FIRST_BRANCH } });
    const job = verifyJob(await stored(same.id), { "job-key-1": publicKey }, { now: NOW });
    expect(job.task.kind).toBe("fix");
    expect(job.continues).toEqual({ parent_run_id: parent.id, session_id: "sess-1", branch: FIRST_BRANCH });
    // The uuid in the branch need not equal the parent's id: a second fix round's parent is the first fix round.
    expect(job.continues?.branch).not.toContain(parent.id);
    for (const bad of ["main", "fx/issue-12", "fx/issue-13", "refs/heads/x", "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g0", "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g01", "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1234567890", "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1/x", "fx/../5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1", "xx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1", "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1\n"]) {
      const parent2 = await runnerRun(w, "executor");
      const other = await runnerRun(w, "executor", parent2.id);
      expect(await codeOf(issuer().issuer.issue({ run: other, continues: { parentRunId: parent2.id, sessionId: "sess-1", branch: bad } })), bad).toBe("continues_branch_mismatch");
      expect(await stored(other.id), bad).toBeNull();
    }
  });

  it("only the executor continues a run: any other role with continues is refused continues_role_not_executor before anything is read, recorded or asked", async () => {
    const w = await world();
    for (const role of ["docs-writer", "code-reviewer", "security-reviewer", "acceptance-tester", "debater"]) {
      const parent = await runnerRun(w, "executor");
      const run = await runnerRun(w, role, parent.id);
      let asked = 0;
      const counting = issuer({ base: { headOid: async () => (asked++, "a".repeat(40)) } });
      expect(await codeOf(counting.issuer.issue({ run, continues: { parentRunId: parent.id, sessionId: "sess-1", branch: FIRST_BRANCH } })), role).toBe("continues_role_not_executor");
      expect(counting.visibility.calls, role).toHaveLength(0);
      expect(asked, role).toBe(0);
      expect(await stored(run.id), role).toBeNull();
      // The same role without continues is issued as before.
      await issuer().issuer.issue({ run: await runnerRun(w, role) });
    }
  });

  it("a continuation with no parent or a bad session id is refused and nothing is recorded", async () => {
    const w = await world();
    const cases: Array<[string, ExecutionRun, { parentRunId: string | null; sessionId: string }, string]> = [];
    const a = await runnerRun(w, "executor");
    cases.push(["no parent", a, { parentRunId: null, sessionId: "s1" }, "continues_without_parent"]);
    const b = await runnerRun(w, "executor");
    cases.push(["bad session", b, { parentRunId: randomUUID(), sessionId: "s 1;rm" }, "continues_session_invalid"]);
    for (const [label, run, continues, code] of cases) {
      expect(await codeOf(issuer().issuer.issue({ run, continues })), label).toBe(code);
      expect(await stored(run.id), label).toBeNull();
    }
  });

  describe("a continuation records the branch head read at its own dispatch (D#6 R2b-3f, C22 section 2)", () => {
    const baseEvents = async (id: string) => (await db.admin.query(`SELECT payload FROM run_events WHERE run_id = $1 AND kind = $2 ORDER BY seq`, [id, RUNNER_DISPATCH_BASE_KIND])).rows.map((r) => r.payload);

    it("reads the head of the recorded branch of this run's repository, records it, then writes the job", async () => {
      const w = await world();
      const { parent, run } = await fixPair(w);
      const asked: unknown[] = [];
      const base: ContinuationBasePort = { headOid: async (input) => (asked.push(input), "d".repeat(40)) };
      await issuer({ base }).issuer.issue({ run, continues: { parentRunId: parent.id, sessionId: "sess-1" } });
      expect(asked).toEqual([{ repo: { id: w.repoId, owner: "acme", name: "widgets" }, branch: FIRST_BRANCH }]);
      expect(await baseEvents(run.id)).toEqual([{ head_oid: "d".repeat(40) }]);
      expect(await stored(run.id)).not.toBeNull();
    });

    it("a branch that does not exist yet is recorded as null: the record exists, the head does not", async () => {
      const w = await world();
      const { parent, run } = await fixPair(w);
      await issuer({ base: { headOid: async () => null } }).issuer.issue({ run, continues: { parentRunId: parent.id, sessionId: "sess-1" } });
      expect(await baseEvents(run.id)).toEqual([{ head_oid: null }]);
    });

    it("each dispatch of the run records its own reading, so a retried dispatch is judged against the newest", async () => {
      const w = await world();
      const { parent, run } = await fixPair(w);
      await issuer({ base: { headOid: async () => "1".repeat(40) } }).issuer.issue({ run, continues: { parentRunId: parent.id, sessionId: "sess-1" } });
      await issuer({ base: { headOid: async () => "2".repeat(40) } }).issuer.issue({ run, continues: { parentRunId: parent.id, sessionId: "sess-1" } }).catch(() => undefined);
      expect((await baseEvents(run.id)).map((p) => p.head_oid)).toEqual(["1".repeat(40), "2".repeat(40)]);
    });

    it("without the port, or when it cannot answer, the continuation is refused and nothing is recorded or queued", async () => {
      const w = await world();
      for (const [label, base] of [
        ["no port", null],
        ["a port that throws", { headOid: async () => Promise.reject(new Error("ECONNRESET api.github.com token=ghs_secret")) }],
      ] as const) {
        const { parent: own, run } = await fixPair(w);
        const error = await issuer({ base }).issuer.issue({ run, continues: { parentRunId: own.id, sessionId: "sess-1" } }).then(() => null, (e: unknown) => e);
        expect(error, label).toBeInstanceOf(JobIssueError);
        expect((error as JobIssueError).code, label).toBe("continues_base_unavailable");
        expect((error as Error).message, label).not.toContain("ghs_secret");
        expect(await baseEvents(run.id), label).toEqual([]);
        expect(await stored(run.id), label).toBeNull();
      }
    });

    it("marks the refusal retryable only when the port says its failure may pass (GitHub unreachable); every other failure is final", async () => {
      const w = await world();
      const cases: Array<[string, unknown, boolean]> = [
        ["unreachable", Object.assign(new Error("unavailable"), { retryable: true }), true],
        ["rejected", Object.assign(new Error("rejected"), { retryable: false }), false],
        ["a plain error", new Error("boom"), false],
        ["a non-boolean flag", Object.assign(new Error("x"), { retryable: "true" }), false],
        ["a thrown string", "ECONNRESET", false],
      ];
      for (const [label, thrown, retryable] of cases) {
        const { parent, run } = await fixPair(w);
        const error = await issuer({ base: { headOid: async () => Promise.reject(thrown) } }).issuer.issue({ run, continues: { parentRunId: parent.id, sessionId: "sess-1" } }).then(() => null, (e: unknown) => e);
        expect((error as JobIssueError).code, label).toBe("continues_base_unavailable");
        expect((error as JobIssueError).retryable, label).toBe(retryable);
        expect(await stored(run.id), label).toBeNull();
      }
      // No port at all is final, not retryable.
      const { parent, run } = await fixPair(w);
      const none = await issuer({ base: null }).issuer.issue({ run, continues: { parentRunId: parent.id, sessionId: "s" } }).then(() => null, (e: unknown) => e);
      expect((none as JobIssueError).retryable).toBe(false);
    });

    it("a run that continues nothing never asks GitHub and records no base", async () => {
      const w = await world();
      const run = await runnerRun(w, "executor");
      let asked = 0;
      await issuer({ base: { headOid: async () => (asked++, "a".repeat(40)) } }).issuer.issue({ run });
      expect(asked).toBe(0);
      expect(await baseEvents(run.id)).toEqual([]);
    });

    it("a job that fails its own checks records no base (the branch mismatch is refused before GitHub is asked)", async () => {
      const w = await world();
      const { parent, run } = await fixPair(w);
      let asked = 0;
      const code = await codeOf(issuer({ base: { headOid: async () => (asked++, "a".repeat(40)) } }).issuer.issue({ run, continues: { parentRunId: parent.id, sessionId: "sess-1", branch: "fx/issue-99" } }));
      expect(code).toBe("continues_branch_mismatch");
      expect(asked).toBe(0);
      expect(await baseEvents(run.id)).toEqual([]);
    });

    it("rejects a head that is not a git object id", async () => {
      const w = await world();
      const { parent, run } = await fixPair(w);
      const error = await issuer({ base: { headOid: async () => "refs/heads/main" } }).issuer.issue({ run, continues: { parentRunId: parent.id, sessionId: "sess-1" } }).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(TypeError);
      expect(await baseEvents(run.id)).toEqual([]);
      expect(await stored(run.id)).toBeNull();
    });
  });

  describe("the repo must be private, asked again at issue time", () => {
    it("a public repo: public_repo, nothing recorded", async () => {
      const w = await world();
      const run = await runnerRun(w);
      expect(await codeOf(issuer({ visibility: "public" }).issuer.issue({ run }))).toBe("public_repo");
      expect(await stored(run.id)).toBeNull();
    });

    it.each(["unknown", "throw"] as const)("a repo the port cannot read (%s): repo_visibility_unknown, nothing recorded", async (answer) => {
      const w = await world();
      const run = await runnerRun(w);
      expect(await codeOf(issuer({ visibility: answer }).issuer.issue({ run }))).toBe("repo_visibility_unknown");
      expect(await stored(run.id)).toBeNull();
    });

    it("asks the port about this run's repo and account", async () => {
      const w = await world();
      const run = await runnerRun(w);
      const i = issuer();
      await i.issuer.issue({ run });
      expect(i.visibility.calls).toEqual([{ accountId: w.accountId, repoId: w.repoId }]);
    });
  });

  it("refuses a role no runner may run, before reading anything", async () => {
    const w = await world();
    const run = { ...(await runnerRun(w)), role: "researcher" as never };
    const i = issuer();
    expect(await codeOf(i.issuer.issue({ run }))).toBe("role_not_runner_eligible");
  });

  it("refuses a run with no repo, and a repo with no GitHub coordinates", async () => {
    const w = await world();
    const run = await runnerRun(w);
    expect(await codeOf(issuer().issuer.issue({ run: { ...run, repoId: undefined } }))).toBe("no_repository");
    await db.admin.query("UPDATE repos SET gh_owner = NULL WHERE id = $1", [w.repoId]);
    expect(await codeOf(issuer().issuer.issue({ run }))).toBe("repository_unreadable");
    expect(await stored(run.id)).toBeNull();
  });

  it("refuses a job the schema refuses (an oversized prompt) and records nothing", async () => {
    const w = await world();
    const made = await runnerRun(w);
    const run = { ...made, prompt: `${made.headSha}${"x".repeat(128 * 1024 + 1)}` };
    expect(await codeOf(issuer().issuer.issue({ run }))).toBe("job_invalid");
    expect(await stored(run.id)).toBeNull();
  });

  it("a signer that throws is a refusal, not a run queued without a job", async () => {
    const w = await world();
    const run = await runnerRun(w);
    const broken = { keyId: "job-key-1", sign: () => { throw new Error("no key"); } };
    const i = createJobIssuer({ pool: db.runWriterPool, signer: broken, visibility: createFakeVisibility("private"), context: createPgJobContext(db.runWriterPool) });
    expect(await codeOf(i.issue({ run }))).toBe("job_invalid");
    expect(await stored(run.id)).toBeNull();
  });

  it("the definer writes once: a second issue for the same run says job_not_recorded and the first job stays", async () => {
    const w = await world();
    const run = await runnerRun(w);
    await issuer().issuer.issue({ run });
    const first = await stored(run.id);
    // A different job (a new id) for the same run. (The same bytes again would be a no-op the guard allows.)
    const second = createJobIssuer({ pool: db.runWriterPool, signer, visibility: createFakeVisibility("private"), context: createPgJobContext(db.runWriterPool), now: () => NOW, newId: () => randomUUID() });
    expect(await codeOf(second.issue({ run }))).toBe("job_not_recorded");
    expect(await stored(run.id)).toEqual(first);
  });

  it("a run that is not a pending runner run takes no job (job_not_recorded)", async () => {
    const w = await world();
    const run = await runnerRun(w);
    await db.admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE id = $1", [run.id]);
    expect(await codeOf(issuer().issuer.issue({ run }))).toBe("job_not_recorded");
  });

  it("another account's data is not read: the context is tenant-scoped", async () => {
    const mine = await world();
    const other = await world();
    const run = { ...(await runnerRun(mine)), repoId: other.repoId };
    // The run's account does not own that repo, so the repo reads as absent and nothing is issued.
    expect(await codeOf(issuer().issuer.issue({ run }))).toBe("repository_unreadable");
  });

  describe("through RunnerTarget.dispatch", () => {
    it("dispatch issues the job and answers queued; a refusing issuer makes dispatch reject", async () => {
      const w = await world();
      const run = await runnerRun(w);
      const i = issuer();
      const target = new RunnerTarget({ limits: createFakeRunnerLimits(), pool: db.runWriterPool, issuer: i.issuer, visibility: i.visibility });
      expect(await target.dispatch(run)).toEqual({ queued: true });
      expect((await stored(run.id)).job.run_id).toBe(run.id);

      const run2 = await runnerRun(w);
      const target2 = new RunnerTarget({ limits: createFakeRunnerLimits(), pool: db.runWriterPool, issuer: issuer({ visibility: "public" }).issuer, visibility: i.visibility });
      await expect(target2.dispatch(run2)).rejects.toBeInstanceOf(JobIssueError);
      expect(await stored(run2.id)).toBeNull();
    });
  });

  describe("sandbox allowances ride in the job only as approved (D#6 R7a, C35)", () => {
    const NPM = { kind: "domain", value: "registry.npmjs.org", access: "connect", reason: "pnpm install fetches the locked packages" };
    const STORE = { kind: "path", value: "/nix/store", access: "read", reason: "the dev shell's tools live in the store" };
    const approve = async (w: { accountId: string; userId: string; repoId: string }, version: number, entries: unknown[], timeout: number | null, setAside = false) =>
      db.admin.query(
        "INSERT INTO repo_runner_sandbox_allowances (account_id, repo_id, version, entries, command_timeout_s, set_sha256, set_aside, approved_by) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)",
        [w.accountId, w.repoId, version, JSON.stringify(entries), timeout, "c".repeat(64), setAside, w.userId],
      );
    const issued = async (w: Awaited<ReturnType<typeof world>>, role = "executor") => {
      const run = await runnerRun(w, role);
      await issuer().issuer.issue({ run });
      return verifyJob(await stored(run.id), { "job-key-1": publicKey }, { now: NOW });
    };

    it("the newest approved set is signed into the job, and a runner can verify it", async () => {
      const w = await world();
      await approve(w, 1, [NPM], 300);
      await approve(w, 2, [NPM, STORE], 900);
      expect((await issued(w)).sandbox_allowances).toEqual({ entries: [NPM, STORE], command_timeout_s: 900 });
      // Every runner role carries it, a review job included.
      expect((await issued(w, "code-reviewer")).sandbox_allowances?.command_timeout_s).toBe(900);
    });

    it("no approval, an empty set and a set set aside leave the key out entirely: the job's canonical JSON has no trace of it", async () => {
      const none = await world();
      const empty = await world();
      await approve(empty, 1, [NPM], 600);
      await approve(empty, 2, [], null);
      const aside = await world();
      await approve(aside, 1, [NPM], 600);
      await approve(aside, 2, [NPM], 600, true);
      for (const w of [none, empty, aside]) {
        const run = await runnerRun(w, "executor");
        await issuer().issuer.issue({ run });
        const signed = await stored(run.id);
        expect("sandbox_allowances" in verifyJob(signed, { "job-key-1": publicKey }, { now: NOW })).toBe(false);
        expect(canonicalJson(signed.job)).not.toContain("sandbox_allowances");
      }
    });

    it("is per repo: another repo's job, in the same account, carries none of it", async () => {
      const a = await world();
      const otherRepo = randomUUID();
      const otherItem = randomUUID();
      await seedRepo(db.admin, a.accountId, otherRepo, { executionMode: "runner_local" });
      await db.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'gadgets' WHERE id = $1", [otherRepo]);
      await seedWorkItem(db.admin, a.accountId, otherItem, otherRepo, { ghNumber: 13 });
      await approve(a, 1, [NPM], 900);
      expect((await issued(a)).sandbox_allowances).toEqual({ entries: [NPM], command_timeout_s: 900 });
      expect((await issued({ ...a, repoId: otherRepo, workItemId: otherItem })).sandbox_allowances).toBeUndefined();
    });

    it("a stored set that no longer clears the floor is refused sandbox_allowances_invalid, and no job is written", async () => {
      const w = await world();
      await approve(w, 1, [{ kind: "path", value: "/home/ian/.ssh", access: "read", reason: "stored before the floor tightened" }], 900);
      const run = await runnerRun(w, "executor");
      expect(await codeOf(issuer().issuer.issue({ run }))).toBe("sandbox_allowances_invalid");
      expect(await stored(run.id)).toBeNull();
    });

    it("a context port that returns a hand-made set is held to the floor too", async () => {
      const w = await world();
      const run = await runnerRun(w, "executor");
      const real = createPgJobContext(db.runWriterPool);
      const context: JobContextPort = { load: async (r, o) => ({ ...(await real.load(r, o)), sandboxAllowances: { entries: [{ kind: "domain", value: "*.example.com", access: "connect", reason: "x" }], command_timeout_s: 60 } }) };
      expect(await codeOf(issuer({ context }).issuer.issue({ run }))).toBe("sandbox_allowances_invalid");
      expect(await stored(run.id)).toBeNull();
    });
  });
});

describe("roleToolsDigest and the signer", () => {
  it("is the SHA-256 of the sorted, canonical tool list for the role, and differs across tool sets", () => {
    expect(roleToolsDigest("executor")).toBe(sha256Text(canonicalJson([...toolsForRole("executor")].sort())));
    expect(roleToolsDigest("code-reviewer")).toBe(roleToolsDigest("debater"));
    expect(roleToolsDigest("executor")).not.toBe(roleToolsDigest("code-reviewer"));
    expect(roleToolsDigest("docs-writer")).not.toBe(roleToolsDigest("executor"));
    expect(roleToolsDigest("executor")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when one tool is added to or removed from the role's list (the runner would refuse the job)", () => {
    const tools = [...toolsForRole("code-reviewer")].sort();
    expect(sha256Text(canonicalJson([...tools, "WebFetch"].sort()))).not.toBe(roleToolsDigest("code-reviewer"));
    expect(sha256Text(canonicalJson(tools.slice(1)))).not.toBe(roleToolsDigest("code-reviewer"));
  });

  it("every runner-eligible role has a digest", () => {
    for (const role of RUNNER_ELIGIBLE_ROLES) expect(roleToolsDigest(role), role).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the signer refuses a key that is not an Ed25519 private key", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => createJobSigner({ keyId: "k", privateKey: rsa.privateKey })).toThrow(/Ed25519/);
    expect(() => createJobSigner({ keyId: "k", privateKey: generateKeyPairSync("ed25519").publicKey })).toThrow(/Ed25519/);
  });

  it("the signer stamps its own key id on the job it signs", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const s = createJobSigner({ keyId: "key-a", privateKey });
    const base = {
      schema_version: 1, job_id: randomUUID(), run_id: randomUUID(), repo: { id: randomUUID(), owner: "a", name: "b", private: true }, role: "executor", mode: "local", spec: null,
      task: { kind: "implement", prompt: "p", prompt_sha256: sha256Text("p") }, role_card: { text: "c", sha256: sha256Text("c") }, role_tools_sha256: "a".repeat(64), continues: null,
      branch_prefix: "fx/", model_hint: null, issued_at: "2026-10-04T12:00:00.000Z", expires_at: "2026-10-04T13:00:00.000Z", key_id: "something-else",
    } as Job;
    expect(s.sign(base).job.key_id).toBe("key-a");
    expect(verifyJob(s.sign(base), { "key-a": publicKey }, { now: new Date("2026-10-04T12:30:00Z") }).key_id).toBe("key-a");
  });
});
