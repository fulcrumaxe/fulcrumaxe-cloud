import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, sha256Text, verifyJob } from "@fulcrumaxe/runner-protocol";
import { CLOUD_VERIFIED_COPY_SHA256, PROPOSAL_VERIFIER_ROLE, RunnerTarget, SandboxTarget, VerifiedTarget, createJobIssuer, createJobSigner, createPgJobContext, type ExecutionTargetRegistry, type RepoVisibility } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { fileReaderFromContents, type ContentsRequester } from "../../pipeline/src/discovery/verifierCites.js";
import { buildVerifierPrompt } from "../../pipeline/src/discovery/verifierPrompt.js";
import { recordFromOutput } from "../../pipeline/src/discovery/verifierResult.js";
import { createSandboxTargetHarness } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { createFakeRunnerLimits } from "../../runner/test/helpers/runnerTargetFakes.js";
import { createProposalVerifySweep, type ProposalVerifyCounts, type VerifySettings } from "../src/proposalVerify.js";
import { createSeatResolver } from "../src/seat.js";
import { createRunStarter } from "../src/starter.js";
import { seedPreviewTarget } from "./support/previewTarget.js";

/**
 * D#483 S4-b2c [pg]: the claim verifier as a light runner job for a Cloud-verified repository, through the production pieces past the pipeline:
 * the real seat resolver (purpose "verify"), the production starters (refuse for the sandbox, accept for a runner), the real VerifiedTarget over
 * the real RunnerTarget and the real job issuer, which signs the job. A runner's `done` is played by writing the run's end the way the done
 * route stores it (status and the runner's envelope); the cites are re-read through a GitHub contents fake that answers like the real API.
 */
const SHA = "b".repeat(40);
const FILE = ["export function add(a: number, b: number) {", "  return a + b;", "}", ""].join("\n");
const GOOD = { category: "bug", claims: [{ text: "add returns the sum", verdict: "supported", cites: [{ path: "src/a.ts", start_line: 1, end_line: 2 }] }] };

const contents: ContentsRequester = async (req) => {
  if (req.method !== "GET" || req.accept !== "application/vnd.github.object+json" || !/^[0-9a-f]{40}$/.test(req.query.ref)) return { status: 422, text: '{"message":"Validation Failed"}' };
  if (!req.path.endsWith("/contents/src/a.ts") || req.query.ref !== SHA) return { status: 404, text: '{"message":"Not Found","status":"404"}' };
  return { status: 200, text: JSON.stringify({ type: "file", encoding: "base64", size: FILE.length, name: "a.ts", path: "src/a.ts", content: Buffer.from(FILE).toString("base64") }) };
};

describe("the proposal verifier sweep on a runner [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  /** GitHub's answer for the repository's visibility, per repo id (default private). */
  const seen = new Map<string, RepoVisibility>();
  const visibility = { visibility: async ({ repoId }: { repoId: string }) => seen.get(repoId) ?? "private" };
  const headReads: string[] = [];
  const settings = (): VerifySettings => ({ on: true, perRepoDailyUsd: 50, verifyPerProposalUsd: 0.4, externalVerifiesPerRepoPerDay: 7 });
  let sweep: (o?: { runner?: boolean }) => Promise<ProposalVerifyCounts>;

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
    const make = (runner: boolean) =>
      createProposalVerifySweep({
        pool: writerPool,
        resolveSeat: createSeatResolver({ pool: writerPool }),
        starter: createRunStarter({ pool: writerPool, registry, follow: async () => undefined, queued: "refuse" }),
        ...(runner ? { runnerStarter: createRunStarter({ pool: writerPool, registry, follow: async () => undefined, queued: "accept" }) } : {}),
        visibility,
        github: (repo) => ({
          headSha: async () => {
            headReads.push(repo.repoId);
            return SHA;
          },
          readFile: (path, sha) => fileReaderFromContents(contents, repo).readFile(path, sha),
        }),
        settings,
        prompt: buildVerifierPrompt,
        record: recordFromOutput,
      });
    const withRunner = make(true);
    const withoutRunner = make(false);
    sweep = (o = {}) => (o.runner === false ? withoutRunner() : withRunner());
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  async function target(mode: "runner_verified" | "runner_local"): Promise<{ a: SeedRefs; repoId: string }> {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE model_connections SET status = 'ok' WHERE account_id = $1", [a.accountId]);
    await admin.query("UPDATE accounts SET model_budget_usd_month = 500 WHERE id = $1", [a.accountId]);
    const { repoId } = await seedPreviewTarget(admin, a);
    await admin.query("UPDATE repos SET execution_mode = $2, verified_copy_sha256 = $3 WHERE id = $1", [repoId, mode, mode === "runner_verified" ? CLOUD_VERIFIED_COPY_SHA256 : null]);
    return { a, repoId };
  }
  let n = 90_000;
  async function proposal(a: SeedRefs, repoId: string): Promise<string> {
    const num = ++n;
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, gh_number, title, summary, provenance, owner_process) VALUES ($1, $2, $3, '{github_issue}', $4, 'Add is wrong', 'It subtracts', 'external', 'product') RETURNING id`,
      [a.accountId, repoId, `gh:issue:${num}`, num],
    );
    return rows[0]!.id;
  }
  const row = async (id: string) => (await admin.query("SELECT verification, verify_attempts, verified_sha, verified_run_id FROM proposals WHERE id = $1", [id])).rows[0];
  const runsOf = async (id: string) =>
    (await admin.query<{ id: string; role: string; status: string; runtime: string; execution_mode: string; head_sha: string | null; job_signed: unknown }>(
      `SELECT r.id, r.role, r.status, r.runtime, r.execution_mode, r.head_sha, r.job_signed FROM agent_run_idempotency_keys k JOIN agent_runs r ON r.id = k.run_id
        WHERE k.idempotency_key LIKE $1 ORDER BY r.created_at`,
      [`proposal-verify:${id}:%`],
    )).rows;

  it("a Cloud-verified repository: the run is a pending runner job pinned to the commit, a second pass waits, and the runner's result is recorded through the same recorder", async () => {
    const { a, repoId } = await target("runner_verified");
    const id = await proposal(a, repoId);
    expect((await sweep()).started).toBeGreaterThanOrEqual(1);
    const [run] = await runsOf(id);
    expect(run).toMatchObject({ role: PROPOSAL_VERIFIER_ROLE, status: "pending", runtime: "runner", execution_mode: "runner_verified", head_sha: SHA });
    const job = verifyJob(run!.job_signed, { k1: publicKey }, { now: new Date() });
    expect(job).toMatchObject({ role: PROPOSAL_VERIFIER_ROLE, mode: "verified", review: { head_sha: SHA }, continues: null, repo: { id: repoId, private: true } });
    expect(job.role_tools_sha256).toBe(sha256Text(canonicalJson(["Glob", "Grep", "Read"])));
    expect(job.task.prompt).toContain(SHA);

    // Still queued for a runner: the next pass starts nothing new.
    await sweep();
    expect(await runsOf(id)).toHaveLength(1);
    expect(await row(id)).toMatchObject({ verification: "pending", verify_attempts: 0 });

    // The runner's `done`: the run ended and its envelope stored (the done route stores the agent's output after redaction).
    await admin.query("UPDATE agent_runs SET status = 'succeeded', envelope = $2::jsonb WHERE id = $1", [run!.id, JSON.stringify(GOOD)]);
    await sweep();
    expect(await row(id)).toMatchObject({ verification: "verified", verified_sha: SHA, verified_run_id: run!.id });
    const evidence = (await admin.query("SELECT ref, excerpt, commit_sha FROM proposal_evidence WHERE proposal_id = $1", [id])).rows;
    expect(evidence).toEqual([{ ref: "src/a.ts:1-2", excerpt: FILE.split("\n").slice(0, 2).join("\n"), commit_sha: SHA }]);
  });

  it("a runner run that failed records check_failed (attempts +1), never a verdict", async () => {
    const { a, repoId } = await target("runner_verified");
    const id = await proposal(a, repoId);
    await sweep();
    const [run] = await runsOf(id);
    await admin.query("UPDATE agent_runs SET status = 'failed', envelope = $2::jsonb WHERE id = $1", [run!.id, JSON.stringify(GOOD)]);
    await sweep();
    expect(await row(id)).toMatchObject({ verification: "check_failed", verify_attempts: 1, verified_run_id: null });
  });

  it("never for a repository GitHub says is public, or whose visibility cannot be read: nothing starts, nothing is reserved, no attempt is used", async () => {
    for (const answer of ["public", "unknown"] as const) {
      const { a, repoId } = await target("runner_verified");
      seen.set(repoId, answer);
      const id = await proposal(a, repoId);
      const reservations = async () => (await admin.query("SELECT count(*)::int AS n FROM spend_reservations WHERE account_id = $1", [a.accountId])).rows[0].n as number;
      const before = await reservations();
      headReads.length = 0;
      await sweep();
      expect(await runsOf(id), answer).toEqual([]);
      // Refused before anything is asked of the repository (the target's own privacy check is the second lock, after the head read).
      expect(headReads, answer).not.toContain(repoId);
      expect(await row(id), answer).toMatchObject({ verification: "pending", verify_attempts: 0 });
      expect(await reservations(), answer).toBe(before);
      // Made private again: the next pass starts it.
      seen.set(repoId, "private");
      await sweep();
      expect(await runsOf(id), answer).toHaveLength(1);
    }
  });

  it("a Local-only repository is not verified: not listed, no run, and our cloud reads nothing of it", async () => {
    const { a, repoId } = await target("runner_local");
    const id = await proposal(a, repoId);
    const listed = (await writerPool.query("SELECT proposal_id FROM proposal_verify_list_due(200)")).rows.map((r) => r.proposal_id);
    expect(listed).not.toContain(id);
    headReads.length = 0;
    await sweep();
    expect(await runsOf(id)).toEqual([]);
    expect(headReads).not.toContain(repoId);
    expect(await row(id)).toMatchObject({ verification: "pending", verify_attempts: 0 });
  });

  it("without a runner starter wired, a Cloud-verified proposal starts nothing and stays pending", async () => {
    const { a, repoId } = await target("runner_verified");
    const id = await proposal(a, repoId);
    await sweep({ runner: false });
    expect(await runsOf(id)).toEqual([]);
    expect(await row(id)).toMatchObject({ verification: "pending", verify_attempts: 0 });
  });
});
