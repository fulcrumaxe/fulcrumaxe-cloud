import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { REVIEW_JOB_ROLES, verifyJob } from "@fulcrumaxe/runner-protocol";
import { RunnerTarget, SandboxTarget, createJobIssuer, createJobSigner, createPgJobContext, type ExecutionTargetRegistry } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount } from "@fx/db/test/helpers/seed.js";
import { promptRuntimeOf } from "../../pipeline/src/advance/build.js";
import { buildReviewPrompt, type ReviewPromptRole } from "../../pipeline/src/review/reviewPrompts.js";
import { createSandboxTargetHarness } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { createFakeRunnerLimits } from "../../runner/test/helpers/runnerTargetFakes.js";
import { createAdvanceModule } from "../src/advance.js";
import { createSeatResolver } from "../src/seat.js";
import { createRunStarter } from "../src/starter.js";

/**
 * D#6 R4d-4a (C33) [pg] G8: a reviewer's prompt follows `repos.execution_mode`, and the job a runner claims carries the reviewed commit. The
 * chain is the real one past the pipeline: the worker's advance module (`advanceStartRun`, called the way `startReviewerBody` calls it), the
 * REAL seat resolver, the production starter, `RunnerTarget` and the real job issuer, which signs the job. Only the repository's visibility
 * and the sandbox SDK are stand-ins.
 */
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const HEAD = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

describe("the review prompt by execution mode, and the job's reviewed commit [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  const visibility = { visibility: async () => "private" as const };
  function chain(): ExecutionTargetRegistry {
    const harness = createSandboxTargetHarness(writerPool, []);
    const issuer = createJobIssuer({ pool: writerPool, signer: createJobSigner({ keyId: "k1", privateKey }), visibility, context: createPgJobContext(writerPool), continuationBase: { headOid: async () => "a".repeat(40) } });
    return {
      sandbox: new SandboxTarget(harness.deps),
      runner_local: new RunnerTarget({ limits: createFakeRunnerLimits(), pool: writerPool, issuer, visibility }),
    };
  }

  const SPEC = "1. Add a --version flag.\n2. Test it.";
  let nextNumber = 7300;
  async function world(mode: "runner_local" | "sandbox") {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE model_connections SET status = 'ok' WHERE account_id = $1", [a.accountId]);
    await admin.query("UPDATE accounts SET model_budget_usd_month = 500 WHERE id = $1", [a.accountId]);
    await admin.query("UPDATE repos SET execution_mode = $2, gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId, mode]);
    const workItemId = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', 'pr_opened', $4)", [workItemId, a.accountId, a.repoId, nextNumber++]);
    const d = randomUUID();
    await admin.query("INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, 'feature', 't', $4, 'internal', 'user')", [d, a.accountId, nextNumber + 500, workItemId]);
    await admin.query("UPDATE work_items SET discussion_id = $1 WHERE id = $2", [d, workItemId]);
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, $4, 'system')", [a.accountId, workItemId, SPEC, sha256(SPEC)]);
    return { a, workItemId };
  }

  const module = (registry: ExecutionTargetRegistry) => {
    const starter = createRunStarter({ pool: writerPool, registry, follow: async () => undefined, queued: "accept" });
    return createAdvanceModule(writerPool, { starter, resolveRunSeat: createSeatResolver({ pool: writerPool }), startAdvance: async () => undefined, triage: null, registry });
  };

  /** The call `startReviewerBody` makes: the prompt is built for `builtFor`, then the run is started with that mode and the head. */
  async function startReviewer(m: ReturnType<typeof module>, w: Awaited<ReturnType<typeof world>>, role: ReviewPromptRole, builtFor: string) {
    const prompt = buildReviewPrompt({ role, owner: "acme", name: "widgets", issue: 7, pr: 41, headSha: HEAD, baseRef: "main", version: 1, spec: SPEC, runtime: promptRuntimeOf(builtFor) });
    const out = await m.advanceStartRun({ accountId: w.a.accountId, workItemId: w.workItemId, haltEpoch: 0, step: `review:${HEAD}:${role}`, role, prompt, clone: true, headSha: HEAD, expectedExecutionMode: builtFor });
    return { prompt, out };
  }

  const storedRow = async (runId: string) => (await admin.query("SELECT head_sha, job_signed FROM agent_runs WHERE id = $1", [runId])).rows[0];

  it.each(REVIEW_JOB_ROLES)("G8/G4: a runner_local repo's %s job carries the runner prompt (digest matching) and review.head_sha equal to the stored head", async (role) => {
    const w = await world("runner_local");
    const { prompt, out } = await startReviewer(module(chain()), w, role, "runner_local");
    if (!out.ok) throw new Error(`not started: ${out.reason}`);
    const row = await storedRow(out.runId);
    const job = verifyJob(row.job_signed, { k1: publicKey }, { now: new Date() });
    expect(job.task.kind).toBe("review");
    expect(job.task.prompt).toBe(prompt);
    expect(job.task.prompt_sha256).toBe(sha256(prompt));
    expect(job.task.prompt).toContain("detached HEAD");
    expect(job.task.prompt).toContain("git diff origin/main...HEAD");
    expect(job.task.prompt).not.toContain("git fetch");
    expect(job.review).toEqual({ head_sha: HEAD });
    expect(row.head_sha).toBe(HEAD);
  });

  it("G8: a sandbox repo's reviewer run carries the sandbox prompt", async () => {
    const w = await world("sandbox");
    const registry = chain();
    const seen: string[] = [];
    vi.spyOn(registry.sandbox!, "dispatch").mockImplementation(async (run) => {
      seen.push(run.prompt);
      throw new Error("stop here: the text is what is under test");
    });
    const { prompt } = await startReviewer(module(registry), w, "code-reviewer", "sandbox").catch(() => ({ prompt: "", out: null }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(`git fetch origin fx/issue-7 && git checkout ${HEAD}`);
    expect(seen[0]).not.toContain("detached HEAD");
    expect(prompt === "" || seen[0] === prompt).toBe(true);
  });

  it.each([
    ["runner_local", "sandbox"],
    ["sandbox", "runner_local"],
  ] as const)("G8: a repo switched from %s to %s between building the review prompt and starting the run is refused execution_mode_changed: no run, no job", async (from, to) => {
    const w = await world(from);
    const before = Number((await admin.query("SELECT count(*) FROM agent_runs WHERE account_id = $1", [w.a.accountId])).rows[0].count);
    const m = module(chain());
    const prompt = buildReviewPrompt({ role: "code-reviewer", owner: "acme", name: "widgets", issue: 7, pr: 41, headSha: HEAD, baseRef: "main", version: 1, spec: SPEC, runtime: promptRuntimeOf(from) });
    await admin.query("UPDATE repos SET execution_mode = $2 WHERE id = $1", [w.a.repoId, to]);
    const out = await m.advanceStartRun({ accountId: w.a.accountId, workItemId: w.workItemId, haltEpoch: 0, step: `review:${HEAD}:code-reviewer`, role: "code-reviewer", prompt, clone: true, headSha: HEAD, expectedExecutionMode: from });
    expect(out).toEqual({ ok: false, reason: "execution_mode_changed" });
    expect(Number((await admin.query("SELECT count(*) FROM agent_runs WHERE account_id = $1", [w.a.accountId])).rows[0].count)).toBe(before);
    expect((await admin.query("SELECT 1 FROM agent_runs WHERE account_id = $1 AND job_signed IS NOT NULL", [w.a.accountId])).rowCount).toBe(0);
  });
});
