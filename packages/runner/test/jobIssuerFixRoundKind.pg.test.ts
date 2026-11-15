import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CONTINUES_CROSS_SIDE_MIN_PROTOCOL, FIX_ROUND_KIND_JOB_MIN_PROTOCOL, verifyJob } from "@fulcrumaxe/runner-protocol";
import type { ExecutionRun } from "../src/executionTarget.js";
import { createJobIssuer, createJobSigner, createPgJobContext, type ContinuationBasePort } from "../src/targets/jobIssuer.js";
import { insertAgentRun } from "../src/runStatusWriter.js";
import { seedAccount, seedMember, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createFakeVisibility } from "./helpers/runnerTargetFakes.js";
import { createFakeContinuationBinding, type FakeBindingState } from "./helpers/fakeContinuationBinding.js";
import { pgHarness } from "./helpers/pgHarness.js";

/** A model with no price-table entry, so no window figure: these jobs carry no `context_window` and keep only the floors this file is about (D#600 CX-6b). */
const NO_WINDOW_MODEL = "windowless-model";

/**
 * D#599 PL-2b-1: a continuation on the item's own pull request branch. The issuer binds `fx/issue-<n>` to the item's open pull request in this
 * repository on GitHub, refuses a default or protected branch, records the binding with the job, and gates the job to runners new enough to read it.
 * Real Postgres and the real definers throughout; GitHub is the fake in `helpers/fakeContinuationBinding.ts`.
 */
describe("fix_round_kind: the issuer signs the round kind the cloud start carried [pg] (D#6 RUNNER-CHECK-SKIP-NO-COMMIT)", () => {
  const db = pgHarness();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signer = createJobSigner({ keyId: "job-key-1", privateKey });
  const NOW = new Date("2026-10-15T12:00:00.000Z");
  const ISSUE = 12;
  const OWNER = "acme";
  const REPO_GH_ID = 7001;
  const ITEM_BRANCH = `fx/issue-${ISSUE}`;
  const base: ContinuationBasePort = { headOid: async () => "a".repeat(40) };

  async function world(issue: number | null = ISSUE) {
    const accountId = randomUUID();
    const userId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, userId);
    await seedRepo(db.admin, accountId, repoId, { executionMode: "runner_local" });
    await db.admin.query("UPDATE repos SET gh_owner = $2, gh_name = 'widgets' WHERE id = $1", [repoId, OWNER]);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: issue as number });
    const body = "1. The footer shows the year.";
    await db.admin.query("INSERT INTO discussions (account_id, number, repo_id, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, 6, $2, 'feature', 'Footer', $3, 'internal', 'system')", [accountId, repoId, workItemId]);
    await db.admin.query("UPDATE work_items SET discussion_id = (SELECT id FROM discussions WHERE account_id = $1 AND root_work_item_id = $2) WHERE id = $2", [accountId, workItemId]);
    await db.admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, $4, 'system')", [accountId, workItemId, body, createHash("sha256").update(body).digest("hex")]);
    return { accountId, userId, repoId, workItemId };
  }
  type World = Awaited<ReturnType<typeof world>>;

  async function executor(w: World, parentRunId: string | null = null): Promise<ExecutionRun> {
    const id = randomUUID();
    const pin = parentRunId ? undefined : (await db.admin.query<{ id: string }>("SELECT id FROM spec_versions WHERE work_item_id = $1 ORDER BY version DESC LIMIT 1", [w.workItemId])).rows[0]?.id;
    await insertAgentRun(db.runWriterPool, { id, accountId: w.accountId, workItemId: w.workItemId, parentRunId, ...(pin ? { specVersionId: pin } : {}), role: "executor", runtime: "runner", executionMode: "runner_local", dispatchRepoId: w.repoId, initiatedBy: w.userId });
    return { id, accountId: w.accountId, workItemId: w.workItemId, parentRunId, role: "executor", product: "team", repoId: w.repoId, headSha: null, roleCard: "You are the executor.\n", prompt: "Fix the review findings.\n", model: NO_WINDOW_MODEL, capUsd: 0, spend: { plan: "starter", estimateComputeUsd: 0, trigger: "foreground" } };
  }

  const openPull = (over: Partial<FakeBindingState["pulls"][number]> = {}): FakeBindingState["pulls"][number] => ({ number: 41, state: "open", headRepoId: REPO_GH_ID, baseRepoId: REPO_GH_ID, headRef: ITEM_BRANCH, headOwner: OWNER, ...over });

  function issuerWith(binding: ReturnType<typeof createFakeContinuationBinding> | null) {
    return createJobIssuer({
      pool: db.runWriterPool,
      signer,
      visibility: createFakeVisibility("private"),
      context: createPgJobContext(db.runWriterPool),
      continuationBase: base,
      ...(binding ? { continuationBinding: binding } : {}),
      now: () => NOW,
      newId: () => "7b9d1c6e-4f0a-4c53-9a58-2f0d5b6c3a11",
    });
  }

  const row = async (id: string) => (await db.admin.query<{ job_signed: unknown; min_protocol_version: number | null }>("SELECT job_signed, min_protocol_version FROM agent_runs WHERE id = $1", [id])).rows[0]!;
  /** A finished parent executor run and a fix round on it. */
  async function pair(w: World) {
    const parent = await executor(w);
    const run = await executor(w, parent.id);
    return { parent, run };
  }

  /** The repo's approved sandbox set with a check: only a job that carries a check names its round kind. */
  const approveCheck = (w: World) => db.admin.query("INSERT INTO repo_runner_sandbox_allowances (account_id, repo_id, version, entries, command_timeout_s, set_sha256, set_aside, approved_by, check_argv, check_dev_shell, check_timeout_s) VALUES ($1, $2, 1, $6::jsonb, 900, $3, false, $4, $5, true, 5400)", [w.accountId, w.repoId, "e".repeat(64), w.userId, ["bash", "scripts/check.sh"], JSON.stringify([{ kind: "domain", value: "registry.npmjs.org", access: "connect", reason: "pnpm install fetches the locked packages" }])]);
  const ROUND = { fromSha: "d".repeat(40), baseSha: "e".repeat(40), baseRef: "main" };
  const CONTINUES = (parentRunId: string) => ({ parentRunId, sessionId: null, branch: ITEM_BRANCH, prNumber: 41 });

  it("a round whose job carries no check names no kind and is not gated to protocol 17, even if its start set one", async () => {
    const w = await world();
    const { parent, run } = await pair(w);
    await issuerWith(createFakeContinuationBinding({ pulls: [openPull()] })).issue({ run: { ...run, fixRoundKind: "review_fix" }, continues: CONTINUES(parent.id) });
    const stored = await row(run.id);
    expect(JSON.stringify(stored.job_signed)).not.toContain("fix_round_kind");
    expect(stored.min_protocol_version).toBe(CONTINUES_CROSS_SIDE_MIN_PROTOCOL);
  });

  it.each(["check_fix", "review_fix"] as const)("signs %s into a job that carries a check and gates the job at protocol 17", async (kind) => {
    const w = await world();
    const { parent, run } = await pair(w);
    await approveCheck(w);
    await issuerWith(createFakeContinuationBinding({ pulls: [openPull()] })).issue({ run: { ...run, fixRoundKind: kind }, continues: CONTINUES(parent.id) });
    const stored = await row(run.id);
    expect(verifyJob(stored.job_signed, { "job-key-1": publicKey }, { now: NOW }).fix_round_kind).toBe(kind);
    expect(stored.min_protocol_version).toBe(FIX_ROUND_KIND_JOB_MIN_PROTOCOL);
  });

  it("a fix round whose start named no kind signs no key, with the floor and bytes it had before", async () => {
    const w = await world();
    const { parent, run } = await pair(w);
    await issuerWith(createFakeContinuationBinding({ pulls: [openPull()] })).issue({ run, continues: CONTINUES(parent.id) });
    const stored = await row(run.id);
    expect(JSON.stringify(stored.job_signed)).not.toContain("fix_round_kind");
    expect(stored.min_protocol_version).toBe(CONTINUES_CROSS_SIDE_MIN_PROTOCOL);
  });

  it("a merge-conflict round never carries a kind, even if its start set one", async () => {
    const w = await world();
    const { parent, run } = await pair(w);
    await approveCheck(w);
    await issuerWith(createFakeContinuationBinding({ pulls: [openPull()] })).issue({ run: { ...run, conflictRound: ROUND, fixRoundKind: "review_fix" }, continues: CONTINUES(parent.id) });
    expect(JSON.stringify((await row(run.id)).job_signed)).not.toContain("fix_round_kind");
  });

  it("a build (no continued branch) never carries a kind", async () => {
    const w = await world();
    const run = await executor(w);
    await approveCheck(w);
    await issuerWith(null).issue({ run: { ...run, fixRoundKind: "review_fix" } });
    expect(JSON.stringify((await row(run.id)).job_signed)).not.toContain("fix_round_kind");
  });
});
