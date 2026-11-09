import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HOSTED_CLAIM_REPLY_BUDGET_BYTES, HOSTED_RESPONSE_LIMIT_BYTES, MAX_CLAIM_REPLY_BYTES, claimReplyBytes, worstCaseClaimReplyBytes } from "@fulcrumaxe/runner-protocol";
import type { ExecutionRun } from "../src/executionTarget.js";
import { JobIssueError, createJobIssuer, createJobSigner, createPgJobContext } from "../src/targets/jobIssuer.js";
import { insertAgentRun } from "../src/runStatusWriter.js";
import { seedAccount, seedMember, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createFakeVisibility } from "./helpers/runnerTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

/** The hosted reply budget: a job whose claim reply would not fit a hosted function's response is not issued. */
describe("JobIssuer reply budget [pg]", () => {
  const db = pgHarness();
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = createJobSigner({ keyId: "job-key-1", privateKey });
  const NOW = new Date("2026-10-04T12:00:00.000Z");

  async function world() {
    const accountId = randomUUID();
    const userId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, userId);
    await seedRepo(db.admin, accountId, repoId, { executionMode: "runner_local" });
    await db.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [repoId]);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 12 });
    const specBody = "1. The footer shows the year.";
    await db.admin.query("INSERT INTO discussions (account_id, number, repo_id, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, 6, $2, 'feature', 'Footer', $3, 'internal', 'system')", [accountId, repoId, workItemId]);
    await db.admin.query("UPDATE work_items SET discussion_id = (SELECT id FROM discussions WHERE account_id = $1 AND root_work_item_id = $2) WHERE id = $2", [accountId, workItemId]);
    await db.admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, $4, 'system')", [accountId, workItemId, specBody, createHash("sha256").update(specBody).digest("hex")]);
    return { accountId, userId, repoId, workItemId };
  }

  async function executorRun(w: Awaited<ReturnType<typeof world>>, over: Partial<ExecutionRun> = {}): Promise<ExecutionRun> {
    const id = randomUUID();
    const pin = (await db.admin.query<{ id: string }>("SELECT id FROM spec_versions WHERE work_item_id = $1 ORDER BY version DESC LIMIT 1", [w.workItemId])).rows[0]!.id;
    await insertAgentRun(db.runWriterPool, { id, accountId: w.accountId, workItemId: w.workItemId, parentRunId: null, specVersionId: pin, role: "executor", runtime: "runner", executionMode: "runner_local", dispatchRepoId: w.repoId, initiatedBy: w.userId });
    return { id, accountId: w.accountId, workItemId: w.workItemId, parentRunId: null, role: "executor", product: "team", repoId: w.repoId, headSha: null, roleCard: "You are the executor.\n", prompt: "Build it.\n", model: "windowless-model", capUsd: 0, spend: { plan: "starter", estimateComputeUsd: 0, trigger: "foreground" }, ...over } as ExecutionRun;
  }

  const issuerWith = (claimReplyBudgetBytes?: number) =>
    createJobIssuer({ pool: db.runWriterPool, signer, visibility: createFakeVisibility("private"), context: createPgJobContext(db.runWriterPool), ...(claimReplyBudgetBytes === undefined ? {} : { claimReplyBudgetBytes }), now: () => NOW });
  const stored = async (id: string) => (await db.admin.query<{ job_signed: unknown }>("SELECT job_signed FROM agent_runs WHERE id = $1", [id])).rows[0]!.job_signed;
  const codeOf = (p: Promise<unknown>) => p.then(() => "issued", (e) => (e instanceof JobIssueError ? e.code : `other:${String(e)}`));

  it("the budget leaves headroom under a hosted response and sits under what the runner reads", () => {
    expect(HOSTED_CLAIM_REPLY_BUDGET_BYTES).toBe(4_000_000);
    expect(HOSTED_CLAIM_REPLY_BUDGET_BYTES).toBeLessThan(HOSTED_RESPONSE_LIMIT_BYTES);
    expect(HOSTED_CLAIM_REPLY_BUDGET_BYTES).toBeLessThan(MAX_CLAIM_REPLY_BYTES);
  });

  it("a job whose reply is exactly the budget is issued; one byte over is refused with job_too_large and records nothing", async () => {
    const w = await world();
    const probe = await executorRun(w);
    await issuerWith().issue({ run: probe });
    const signed = (await stored(probe.id)) as { job: { run_id: string } };
    const size = worstCaseClaimReplyBytes(signed, probe.id);
    expect(size).toBeGreaterThan(0);

    const exact = await executorRun(w);
    // run ids differ in nothing that changes the length (all uuids), so the same job shape measures the same
    const exactSize = size;
    expect(await codeOf(issuerWith(exactSize).issue({ run: exact }))).toBe("issued");
    expect(await stored(exact.id)).not.toBeNull();

    const over = await executorRun(w);
    expect(await codeOf(issuerWith(exactSize - 1).issue({ run: over }))).toBe("job_too_large");
    expect(await stored(over.id)).toBeNull();
    expect(signed.job.run_id).toBe(probe.id);
  });

  it("the measure is the bytes of the reply as serialized: the same figure an actual reply object gives", async () => {
    const w = await world();
    const run = await executorRun(w);
    await issuerWith().issue({ run });
    const signed = await stored(run.id);
    const reply = { signed_job: signed, run_id: run.id, lease_generation: Number.MAX_SAFE_INTEGER, wake: { token: "a".repeat(1024), poll_s: Number.MAX_SAFE_INTEGER, transport: "a".repeat(32) }, merge_order: true, deploy_order: true };
    expect(worstCaseClaimReplyBytes(signed, run.id)).toBe(claimReplyBytes(reply));
    expect(claimReplyBytes(reply)).toBe(Buffer.byteLength(JSON.stringify(reply), "utf8"));
  });
});
