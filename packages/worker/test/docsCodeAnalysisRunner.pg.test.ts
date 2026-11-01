import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, sha256Text, verifyJob } from "@fulcrumaxe/runner-protocol";
import { CLOUD_VERIFIED_COPY_SHA256, DISCOVERY_ANALYST_ROLE, RunnerTarget, SandboxTarget, VerifiedTarget, createJobIssuer, createJobSigner, createPgJobContext, type ExecutionTargetRegistry, type RepoVisibility } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { queueAnalysis } from "@fx/db/src/discoveryAnalyses.js";
import type { AnalysisSettings } from "@fx/plan-data";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { buildAnalystPrompt } from "../../pipeline/src/discovery/analystPrompt.js";
import { parseAnalystOutput } from "../../pipeline/src/discovery/analystOutput.js";
import { createSandboxTargetHarness } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { createFakeRunnerLimits } from "../../runner/test/helpers/runnerTargetFakes.js";
import { createDocsCodeAnalysisSweep, MAX_ANALYSIS_ATTEMPTS, type DocsCodeAnalysisCounts } from "../src/docsCodeAnalysis.js";
import { createSeatResolver } from "../src/seat.js";
import { createRunStarter } from "../src/starter.js";
import { seedPreviewTarget } from "./support/previewTarget.js";

/**
 * D#483 S4-f4 [pg]: the docs-and-code analyst as a light runner job for a Cloud-verified repository, through the production pieces past the pipeline: the real
 * seat resolver (purpose "analyse"), the production starters, the real VerifiedTarget over the real RunnerTarget and the real job issuer, which signs the job.
 * The runner's `done` is played by writing the run's end the way the done route stores it. The claim side (which runner is offered the job) is
 * runnerClaims.pg.test.ts, over the real claim route.
 */
const SHA = "c".repeat(40);
const PER_RUN = 1.3;
const CANDIDATES = {
  candidates: [
    { kind: "docs", title: "Existing issue seven", summary: "The docs promise it.", refs: [], names_issue: 7 },
    { kind: "docs", title: "New idea one", summary: "Document the flag.", refs: [{ path: "docs/a.md", start_line: 3, end_line: 9 }] },
    { kind: "code", title: "New idea two", summary: "Handle the empty case.", refs: [{ path: "src/a.ts", start_line: 1, end_line: 2 }] },
  ],
};

describe("the docs-and-code analysis pass on a runner [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seen = new Map<string, RepoVisibility>();
  const visibility = { visibility: async ({ repoId }: { repoId: string }) => seen.get(repoId) ?? "private" };
  const headReads: string[] = [];
  let only: string[] = [];
  let sweepWith: (o: { runner: boolean; visibility: boolean }) => () => Promise<DocsCodeAnalysisCounts>;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    const harness = createSandboxTargetHarness(writerPool, []);
    const issuer = createJobIssuer({ pool: writerPool, signer: createJobSigner({ keyId: "k1", privateKey }), visibility, context: createPgJobContext(writerPool) });
    const sandbox = new SandboxTarget(harness.deps);
    const registry: ExecutionTargetRegistry = {
      sandbox,
      runner_local: new RunnerTarget({ limits: createFakeRunnerLimits(), pool: writerPool, issuer, visibility }, "runner_local"),
      runner_verified: new VerifiedTarget(new RunnerTarget({ limits: createFakeRunnerLimits(), pool: writerPool, issuer, visibility }, "runner_verified"), sandbox),
    };
    const settings = (): AnalysisSettings => ({ on: true, perRepoDailyUsd: 50, analysisPerRunUsd: PER_RUN });
    sweepWith = (o) =>
      createDocsCodeAnalysisSweep({
        pool: writerPool,
        resolveSeat: createSeatResolver({ pool: writerPool }),
        starter: createRunStarter({ pool: writerPool, registry, follow: async () => undefined, queued: "refuse" }),
        ...(o.runner ? { runnerStarter: createRunStarter({ pool: writerPool, registry, follow: async () => undefined, queued: "accept" }) } : {}),
        ...(o.visibility ? { visibility } : {}),
        github: (repo) => ({
          headSha: async () => {
            headReads.push(repo.repoId);
            return SHA;
          },
          readFile: async () => null,
        }),
        settings,
        prompt: buildAnalystPrompt,
        parse: parseAnalystOutput,
        list: async () => (await writerPool.query<{ account_id: string; analysis_id: string }>("SELECT account_id, analysis_id FROM discovery_analysis_list_due(200)")).rows.filter((r) => only.includes(r.analysis_id)),
      });
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  const pass = (id: string, o: { runner?: boolean; visibility?: boolean } = {}): Promise<DocsCodeAnalysisCounts> => {
    only = [id];
    return sweepWith({ runner: o.runner ?? true, visibility: o.visibility ?? true })();
  };

  async function target(mode: "runner_verified" | "runner_local" = "runner_verified"): Promise<{ a: SeedRefs; repoId: string; id: string }> {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE model_connections SET status = 'ok' WHERE account_id = $1", [a.accountId]);
    await admin.query("UPDATE accounts SET model_budget_usd_month = 500 WHERE id = $1", [a.accountId]);
    const { repoId } = await seedPreviewTarget(admin, a);
    await admin.query("UPDATE repos SET execution_mode = $2, verified_copy_sha256 = $3 WHERE id = $1", [repoId, mode, mode === "runner_verified" ? CLOUD_VERIFIED_COPY_SHA256 : null]);
    const id = (await queueAnalysis(writerPool, a.accountId, repoId, SHA))!.id;
    return { a, repoId, id };
  }
  /** A runner of the account whose latest hello listed `capabilities` (what the hello's definer stores), scoped to the repository unless said otherwise. */
  async function runnerWith(a: SeedRefs, repoId: string, capabilities: string[], o: { repos?: string[]; roles?: string[] } = {}): Promise<string> {
    const runnerId = await insertRunner(admin, a.accountId, a.userId);
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = $3::text[] WHERE id = $1", [runnerId, o.repos ?? [repoId], o.roles ?? []]);
    await admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, $3::text[])", [runnerId, a.accountId, capabilities]);
    return runnerId;
  }
  const row = async (id: string) => (await admin.query("SELECT state, skip_reason, attempts, run_id FROM discovery_analyses WHERE id = $1", [id])).rows[0] as { state: string; skip_reason: string | null; attempts: number; run_id: string | null };
  const runsOf = async (id: string) =>
    (await admin.query<{ id: string; role: string; status: string; runtime: string; execution_mode: string; head_sha: string | null; work_item_id: string | null; job_signed: unknown }>(
      `SELECT r.id, r.role, r.status, r.runtime, r.execution_mode, r.head_sha, r.work_item_id, r.job_signed FROM agent_run_idempotency_keys k JOIN agent_runs r ON r.id = k.run_id
        WHERE k.idempotency_key LIKE $1 ORDER BY r.created_at`,
      [`docs-code-analysis:${id}:%`],
    )).rows;
  const reservations = async (accountId: string): Promise<number> => (await admin.query("SELECT count(*)::int AS n FROM spend_reservations WHERE account_id = $1", [accountId])).rows[0].n;
  const proposalTitles = async (repoId: string): Promise<string[]> => (await admin.query("SELECT title FROM proposals WHERE repo_id = $1 ORDER BY title", [repoId])).rows.map((r) => r.title as string);

  it("C25-f4-1: a Cloud-verified private repository's analysis is a pending light runner job carrying the pinned commit, and the runner's result is merged exactly as a sandbox run's", async () => {
    const { a, repoId, id } = await target();
    await admin.query(`INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, gh_number, title, provenance, owner_process) VALUES ($1, $2, 'gh:issue:7', '{github_issue}', 7, 'Issue seven', 'external', 'product')`, [a.accountId, repoId]);
    await runnerWith(a, repoId, ["discovery_analyst"]);
    const workBefore = Number((await admin.query("SELECT count(*) FROM work_items WHERE account_id = $1", [a.accountId])).rows[0].count);
    expect((await pass(id)).started).toBe(1);
    const [run] = await runsOf(id);
    expect(run).toMatchObject({ role: DISCOVERY_ANALYST_ROLE, status: "pending", runtime: "runner", execution_mode: "runner_verified", head_sha: SHA, work_item_id: null });
    expect(await row(id)).toMatchObject({ state: "running", attempts: 1, run_id: run!.id, skip_reason: null });
    // The signed job: the analyst's role, the pinned commit as review.head_sha, verified mode, the confined three tools (C25-f4-4), light.
    const job = verifyJob(run!.job_signed, { k1: publicKey }, { now: new Date() });
    expect(job).toMatchObject({ role: DISCOVERY_ANALYST_ROLE, mode: "verified", review: { head_sha: SHA }, continues: null, repo: { id: repoId, private: true } });
    expect(job.role_tools_sha256).toBe(sha256Text(canonicalJson(["Glob", "Grep", "Read"])));
    expect(job.task.prompt).toContain(SHA);
    expect(job).not.toHaveProperty("sandbox_allowances");
    // A runner run spends the person's own model access, so (as for the verifier's runner job) no platform reservation is made; the seat the sweep
    // resolved was held to the analysis figure before the start (docsCodeAnalysis.ts checks capUsd and the spend estimate equal it).
    expect((await admin.query("SELECT 1 FROM spend_reservations WHERE run_id = $1", [run!.id])).rows).toEqual([]);

    // Still waiting for a runner: the next pass starts nothing new and merges nothing.
    await pass(id);
    expect(await runsOf(id)).toHaveLength(1);
    expect(await proposalTitles(repoId)).toEqual(["Issue seven"]);

    // The runner's `done`: the run ended and its envelope stored.
    await admin.query("UPDATE agent_runs SET status = 'succeeded', envelope = $2::jsonb WHERE id = $1", [run!.id, JSON.stringify(CANDIDATES)]);
    expect((await pass(id)).recorded).toBe(1);
    expect(await row(id)).toMatchObject({ state: "succeeded", attempts: 1 });
    expect(await proposalTitles(repoId)).toEqual(["Issue seven", "New idea one", "New idea two"]);
    const created = (await admin.query("SELECT title, state, verification, analysis_refs FROM proposals WHERE repo_id = $1 AND title LIKE 'New idea%' ORDER BY title", [repoId])).rows;
    expect(created).toEqual([
      { title: "New idea one", state: "new", verification: "pending", analysis_refs: ["docs/a.md:3-9"] },
      { title: "New idea two", state: "new", verification: "pending", analysis_refs: ["src/a.ts:1-2"] },
    ]);
    // R-597-1: the analyst only proposed.
    expect(Number((await admin.query("SELECT count(*) FROM work_items WHERE account_id = $1", [a.accountId])).rows[0].count)).toBe(workBefore);
  });

  it("a runner run that failed uses an attempt and the next starts on a new key; the third failure is the last", async () => {
    const { a, repoId, id } = await target();
    await runnerWith(a, repoId, ["discovery_analyst"]);
    for (let n = 1; n <= MAX_ANALYSIS_ATTEMPTS; n++) {
      await pass(id);
      const runs = await runsOf(id);
      expect(runs).toHaveLength(n);
      await admin.query("UPDATE agent_runs SET status = 'failed' WHERE id = $1", [runs[n - 1]!.id]);
      await pass(id);
    }
    expect(await row(id)).toMatchObject({ state: "failed", skip_reason: "run_failed", attempts: MAX_ANALYSIS_ATTEMPTS });
    expect(await proposalTitles(repoId)).toEqual([]);
  });

  it("C25-f4-2: a repository GitHub says is public, or whose visibility cannot be read, starts nothing, reserves nothing and uses no attempt; made private again it starts", async () => {
    for (const answer of ["public", "unknown"] as const) {
      const { a, repoId, id } = await target();
      await runnerWith(a, repoId, ["discovery_analyst"]);
      seen.set(repoId, answer);
      const before = await reservations(a.accountId);
      headReads.length = 0;
      await pass(id);
      expect(await runsOf(id), answer).toEqual([]);
      // Refused before anything is asked of the repository.
      expect(headReads, answer).not.toContain(repoId);
      expect(await row(id), answer).toMatchObject({ state: "queued", attempts: 0, skip_reason: null });
      expect(await reservations(a.accountId), answer).toBe(before);
      seen.set(repoId, "private");
      await pass(id);
      expect(await runsOf(id), answer).toHaveLength(1);
    }
  });

  it("C25-f4-3 (issue step): with no runner that listed discovery_analyst for this repository and role, the analysis is held queued (no_capable_runner) with no run, no reservation and no attempt, however many passes look, and a capable runner resumes it", async () => {
    const { a, repoId, id } = await target();
    const other = (await seedPreviewTarget(admin, await seedAccount(admin, randomUUID()))).repoId;
    // Each of these is a runner that would be offered the job if it were capable; none is.
    await runnerWith(a, repoId, []); // listed nothing
    await runnerWith(a, repoId, ["proposal_verifier"]); // the verifier's capability does not stand in
    await runnerWith(a, repoId, ["discovery_analyst"], { repos: [other] }); // not allowed this repository
    await runnerWith(a, repoId, ["discovery_analyst"], { roles: ["executor"] }); // not allowed this role
    const revoked = await runnerWith(a, repoId, ["discovery_analyst"]);
    await admin.query("UPDATE runners SET revoked_at = now(), revoked_reason = 'test' WHERE id = $1", [revoked]);
    const before = await reservations(a.accountId);
    for (let i = 0; i < MAX_ANALYSIS_ATTEMPTS + 2; i++) {
      expect((await pass(id)).waiting).toBe(1);
      expect(await row(id)).toMatchObject({ state: "queued", skip_reason: "no_capable_runner", attempts: 0, run_id: null });
    }
    expect(await runsOf(id)).toEqual([]);
    expect(await reservations(a.accountId)).toBe(before);
    // A runner that lists the capability and covers the repository and the role: the next pass starts the analysis, and the hold is cleared.
    await runnerWith(a, repoId, ["discovery_analyst"], { roles: [DISCOVERY_ANALYST_ROLE] });
    expect((await pass(id)).started).toBe(1);
    expect(await row(id)).toMatchObject({ state: "running", skip_reason: null, attempts: 1 });
    expect(await runsOf(id)).toHaveLength(1);
  });

  it("C25-f4-3: the capability withdrawn (a later hello listing none) holds the next analysis queued again", async () => {
    const { a, repoId, id } = await target();
    const runnerId = await runnerWith(a, repoId, ["discovery_analyst"]);
    await admin.query("UPDATE runner_capabilities SET capabilities = '{}' WHERE runner_id = $1", [runnerId]);
    await pass(id);
    expect(await row(id)).toMatchObject({ state: "queued", skip_reason: "no_capable_runner", attempts: 0 });
    await admin.query("UPDATE runner_capabilities SET capabilities = '{discovery_analyst}' WHERE runner_id = $1", [runnerId]);
    expect((await pass(id)).started).toBe(1);
  });

  it("C25-f4-5: a Local-only repository is not listed, and a pass handed its analysis anyway starts nothing and reads nothing of it", async () => {
    const { a, repoId, id } = await target("runner_local");
    await runnerWith(a, repoId, ["discovery_analyst"]);
    expect((await writerPool.query("SELECT analysis_id FROM discovery_analysis_list_due(200)")).rows.map((r) => r.analysis_id)).not.toContain(id);
    headReads.length = 0;
    only = [id];
    const forced = createDocsCodeAnalysisSweep({
      pool: writerPool,
      resolveSeat: createSeatResolver({ pool: writerPool }),
      starter: createRunStarter({ pool: writerPool, registry: {} as ExecutionTargetRegistry, follow: async () => undefined, queued: "refuse" }),
      runnerStarter: createRunStarter({ pool: writerPool, registry: {} as ExecutionTargetRegistry, follow: async () => undefined, queued: "accept" }),
      visibility,
      github: (repo) => ({ headSha: async () => (headReads.push(repo.repoId), SHA), readFile: async () => null }),
      settings: () => ({ on: true, perRepoDailyUsd: 50, analysisPerRunUsd: PER_RUN }),
      prompt: buildAnalystPrompt,
      parse: parseAnalystOutput,
      list: async () => [{ account_id: a.accountId, analysis_id: id }],
    });
    await forced();
    expect(await runsOf(id)).toEqual([]);
    expect(headReads).not.toContain(repoId);
    expect(await row(id)).toMatchObject({ state: "queued", attempts: 0 });
  });

  it("without a runner starter or a visibility port wired, a Cloud-verified analysis starts nothing and stays queued", async () => {
    const { a, repoId, id } = await target();
    await runnerWith(a, repoId, ["discovery_analyst"]);
    await pass(id, { runner: false });
    await pass(id, { visibility: false });
    expect(await runsOf(id)).toEqual([]);
    expect(await row(id)).toMatchObject({ state: "queued", attempts: 0 });
  });
});
