import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RUNNER_ELIGIBLE_ROLES, canonicalJson, jobDigestMismatches, sha256Text, verifyJob, type Job } from "@fulcrumaxe/runner-protocol";
import type { ExecutionRun } from "../src/executionTarget.js";
import { toolsForRole } from "../src/agentConfig.js";
import { JobIssueError, RUNNER_BRANCH_PREFIX, createJobIssuer, createJobSigner, createPgJobContext, roleToolsDigest, runnerBranchFor, type JobContextPort } from "../src/targets/jobIssuer.js";
import { RUNNER_QUEUE_TTL_MS, RunnerTarget } from "../src/targets/runnerTarget.js";
import { insertAgentRun } from "../src/runStatusWriter.js";
import { seedAccount, seedMember, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createFakeVisibility } from "./helpers/runnerTargetFakes.js";
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

  async function runnerRun(w: { accountId: string; userId: string; repoId: string; workItemId: string }, role = "code-reviewer", parentRunId: string | null = null): Promise<ExecutionRun> {
    const id = randomUUID();
    await insertAgentRun(db.runWriterPool, { id, accountId: w.accountId, workItemId: w.workItemId, parentRunId, role: role as never, runtime: "runner", executionMode: "runner_local", dispatchRepoId: w.repoId, initiatedBy: w.userId });
    return { id, accountId: w.accountId, workItemId: w.workItemId, parentRunId, role: role as never, product: "team", repoId: w.repoId, roleCard: CARD, prompt: PROMPT, model: "haiku-4.5", capUsd: 0, spend: { plan: "starter", estimateComputeUsd: 0, trigger: "foreground" } };
  }

  function issuer(over: { visibility?: "private" | "public" | "unknown" | "throw"; context?: JobContextPort } = {}) {
    const visibility = createFakeVisibility(over.visibility ?? "private");
    return { visibility, issuer: createJobIssuer({ pool: db.runWriterPool, signer, visibility, context: over.context ?? createPgJobContext(db.runWriterPool), now: () => NOW, newId: () => "7b9d1c6e-4f0a-4c53-9a58-2f0d5b6c3a11" }) };
  }

  const stored = async (id: string) => (await db.admin.query(`SELECT job_signed FROM agent_runs WHERE id = $1`, [id])).rows[0].job_signed;
  const codeOf = async (p: Promise<unknown>) => p.then(() => "returned", (e) => (e instanceof JobIssueError ? e.code : `other:${String(e)}`));

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
      task: { kind: "review", prompt: PROMPT, prompt_sha256: sha256Text(PROMPT) },
      role_card: { text: CARD, sha256: sha256Text(CARD) },
      role_tools_sha256: roleToolsDigest("code-reviewer"),
      continues: null,
      branch_prefix: "fx/",
      model_hint: "haiku-4.5",
      issued_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + 72 * 3600_000).toISOString(),
      key_id: "job-key-1",
    });
    expect(jobDigestMismatches(job)).toEqual([]);
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
    const fixRun = await runnerRun(w, "executor", parent.id);
    await issuer().issuer.issue({ run: fixRun, continues: { parentRunId: parent.id, sessionId: "sess-1" } });
    kinds["executor+continues"] = verifyJob(await stored(fixRun.id), { "job-key-1": publicKey }, { now: NOW }).task.kind;
    expect(kinds).toEqual({ executor: "implement", "code-reviewer": "review", debater: "review", "docs-writer": "advise", "executor+continues": "fix" });
  });

  it("a fix round carries the parent run, the session and the issue's branch (C12 section 2.8)", async () => {
    const w = await world({ issue: 12 });
    const parent = await runnerRun(w, "executor");
    const run = await runnerRun(w, "executor", parent.id);
    await issuer().issuer.issue({ run, continues: { parentRunId: parent.id, sessionId: "7f0c1d2e-aaaa-bbbb-cccc-0123456789ab" } });
    const job = verifyJob(await stored(run.id), { "job-key-1": publicKey }, { now: NOW });
    expect(job.continues).toEqual({ parent_run_id: parent.id, session_id: "7f0c1d2e-aaaa-bbbb-cccc-0123456789ab", branch: "fx/issue-12" });
    expect(runnerBranchFor(12)).toBe(`${RUNNER_BRANCH_PREFIX}issue-12`);
  });

  it("a follow-up of a fix round is issued only for the branch the lost round was on (C22 section 2)", async () => {
    const w = await world({ issue: 12 });
    const parent = await runnerRun(w, "executor");
    const same = await runnerRun(w, "executor", parent.id);
    await issuer().issuer.issue({ run: same, continues: { parentRunId: parent.id, sessionId: "sess-1", branch: "fx/issue-12" } });
    const job = verifyJob(await stored(same.id), { "job-key-1": publicKey }, { now: NOW });
    expect(job.task.kind).toBe("fix");
    expect(job.continues).toEqual({ parent_run_id: parent.id, session_id: "sess-1", branch: "fx/issue-12" });
    // The issue's number changed or the parent was on another branch: refused, nothing recorded.
    const parent2 = await runnerRun(w, "executor");
    const other = await runnerRun(w, "executor", parent2.id);
    expect(await codeOf(issuer().issuer.issue({ run: other, continues: { parentRunId: parent2.id, sessionId: "sess-1", branch: "fx/issue-13" } }))).toBe("continues_branch_mismatch");
    expect(await stored(other.id)).toBeNull();
  });

  it("a continuation with no parent, a bad session id or no issue number is refused and nothing is recorded", async () => {
    const w = await world();
    const noIssue = await world({ issue: null });
    const cases: Array<[string, ExecutionRun, { parentRunId: string | null; sessionId: string }, string]> = [];
    const a = await runnerRun(w, "executor");
    cases.push(["no parent", a, { parentRunId: null, sessionId: "s1" }, "continues_without_parent"]);
    const b = await runnerRun(w, "executor");
    cases.push(["bad session", b, { parentRunId: randomUUID(), sessionId: "s 1;rm" }, "continues_session_invalid"]);
    const c = await runnerRun(noIssue, "executor");
    cases.push(["no issue", c, { parentRunId: randomUUID(), sessionId: "s1" }, "continues_without_branch"]);
    for (const [label, run, continues, code] of cases) {
      expect(await codeOf(issuer().issuer.issue({ run, continues })), label).toBe(code);
      expect(await stored(run.id), label).toBeNull();
    }
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
    expect(i.visibility.calls).toHaveLength(0);
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
    const run = { ...(await runnerRun(w)), prompt: "x".repeat(128 * 1024 + 1) };
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
      const target = new RunnerTarget({ pool: db.runWriterPool, issuer: i.issuer, visibility: i.visibility });
      expect(await target.dispatch(run)).toEqual({ queued: true });
      expect((await stored(run.id)).job.run_id).toBe(run.id);

      const run2 = await runnerRun(w);
      const target2 = new RunnerTarget({ pool: db.runWriterPool, issuer: issuer({ visibility: "public" }).issuer, visibility: i.visibility });
      await expect(target2.dispatch(run2)).rejects.toBeInstanceOf(JobIssueError);
      expect(await stored(run2.id)).toBeNull();
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
