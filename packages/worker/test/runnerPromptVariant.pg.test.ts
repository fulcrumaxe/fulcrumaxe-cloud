import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RunnerTarget, SandboxTarget, createJobIssuer, createJobSigner, createPgJobContext, type ExecutionTargetRegistry } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount } from "@fx/db/test/helpers/seed.js";
import { loadProductCard } from "@fx/roles/cards";
import { startBuildForItem } from "../../pipeline/src/advance/build.js";
import type { AdvanceRunPorts } from "../../pipeline/src/advance/runPorts.js";
import { createSandboxTargetHarness } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { createFakeRunnerLimits } from "../../runner/test/helpers/runnerTargetFakes.js";
import { createAdvanceModule } from "../src/advance.js";
import { createSeatResolver } from "../src/seat.js";
import { createRunStarter } from "../src/starter.js";

/**
 * D#6 R4d-1 (C32) [pg] A6 and A7: the executor's prompt and role card follow `repos.execution_mode`, end to end. The chain is the
 * real one: the pipeline's `startBuildForItem`, the worker's advance module, the REAL seat resolver (so the role card is
 * chosen from the database), the production starter, `RunnerTarget` and the real job issuer, which signs the job a runner claims.
 * The job's text and its digests are read back from the stored signed job. Only the repository's visibility and the sandbox
 * SDK are stand-ins.
 */
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

describe("the runner prompt and card by execution mode [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  const { privateKey } = generateKeyPairSync("ed25519");

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
  function chain() {
    const harness = createSandboxTargetHarness(writerPool, []);
    const issuer = createJobIssuer({ pool: writerPool, signer: createJobSigner({ keyId: "k1", privateKey }), visibility, context: createPgJobContext(writerPool), continuationBase: { headOid: async () => "a".repeat(40) } });
    const registry: ExecutionTargetRegistry = {
      sandbox: new SandboxTarget(harness.deps),
      runner_local: new RunnerTarget({ limits: createFakeRunnerLimits(), pool: writerPool, issuer, visibility }),
    };
    return registry;
  }

  const SPEC = "1. Add a --version flag.\n2. Test it.";
  let nextNumber = 7100;
  /** An account whose repo runs in `mode`, with an internal work item at spec_ready that has an issue number and a published Spec. */
  async function world(mode: "runner_local" | "sandbox") {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE model_connections SET status = 'ok' WHERE account_id = $1", [a.accountId]);
    await admin.query("UPDATE accounts SET model_budget_usd_month = 500 WHERE id = $1", [a.accountId]);
    await admin.query("UPDATE repos SET execution_mode = $2, gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId, mode]);
    const workItemId = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', 'spec_ready', $4)", [workItemId, a.accountId, a.repoId, nextNumber++]);
    // The job carries the Spec with the number of the Discussion it was published on, so the item has one.
    const d = randomUUID();
    await admin.query("INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, 'feature', 't', $4, 'internal', 'user')", [d, a.accountId, nextNumber + 500, workItemId]);
    await admin.query("UPDATE work_items SET discussion_id = $1 WHERE id = $2", [d, workItemId]);
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, $4, 'system')", [a.accountId, workItemId, SPEC, sha256(SPEC)]);
    return { a, workItemId };
  }

  /** The worker's side of the pipeline's ports over the real chain. `beforeStart` runs between the pipeline's read and the worker's start. */
  function ports(registry: ExecutionTargetRegistry, accountId: string, workItemId: string, beforeStart?: () => Promise<void>): AdvanceRunPorts {
    const starter = createRunStarter({ pool: writerPool, registry, follow: async () => undefined, queued: "accept" });
    const m = createAdvanceModule(writerPool, { starter, resolveRunSeat: createSeatResolver({ pool: writerPool }), startAdvance: async () => undefined, triage: null, registry });
    return {
      startRun: async (req) => {
        await beforeStart?.();
        return m.advanceStartRun({ ...req, accountId, workItemId, haltEpoch: 0 });
      },
      outcome: (runId) => m.advanceRunOutcome(accountId, runId),
      cancel: async () => undefined,
    };
  }

  interface SignedJob {
    job: { task: { prompt: string; prompt_sha256: string }; role_card: { text: string; sha256: string } };
  }
  const issuedJob = async (runId: string): Promise<SignedJob["job"]> => ((await admin.query("SELECT job_signed FROM agent_runs WHERE id = $1", [runId])).rows[0].job_signed as SignedJob).job;
  const FORBIDDEN = ["checkout -b", "checkout -B", "git push", "api.github.com", "/pulls", "--force"];

  it("A6: a runner_local repo's issued job carries the runner prompt and the runner card, and each digest matches its text", async () => {
    const { a, workItemId } = await world("runner_local");
    const out = await startBuildForItem(writerPool, a.accountId, workItemId, randomUUID(), ports(chain(), a.accountId, workItemId));
    if (out.status !== "started") throw new Error(`not started: ${out.reason}`);
    const job = await issuedJob(out.runId);
    expect(job.task.prompt).toContain("do not create, switch");
    expect(job.task.prompt).toContain("Do not push");
    expect(FORBIDDEN.filter((f) => job.task.prompt.includes(f))).toEqual([]);
    expect(job.task.prompt).toContain(SPEC);
    expect(job.role_card.text).toBe(loadProductCard("executor", { runtime: "runner" }));
    expect(job.role_card.text).not.toBe(loadProductCard("executor"));
    expect(job.task.prompt_sha256).toBe(sha256(job.task.prompt));
    expect(job.role_card.sha256).toBe(sha256(job.role_card.text));
  });

  it("A6: a sandbox repo's run carries the sandbox prompt and the sandbox card", async () => {
    const { a, workItemId } = await world("sandbox");
    const harnessRegistry = chain();
    const seen: Array<{ prompt: string; roleCard: string }> = [];
    // The sandbox target would start a real sandbox; the starter's input is what carries the text, so read it at the target.
    const sandbox = harnessRegistry.sandbox!;
    vi.spyOn(sandbox, "dispatch").mockImplementation(async (run) => {
      seen.push({ prompt: run.prompt, roleCard: run.roleCard });
      throw new Error("stop here: the text is what is under test");
    });
    await startBuildForItem(writerPool, a.accountId, workItemId, randomUUID(), ports(harnessRegistry, a.accountId, workItemId)).catch(() => undefined);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.prompt).toContain("git checkout -b fx/issue-");
    expect(seen[0]!.prompt).toContain("git push origin");
    expect(seen[0]!.roleCard).toBe(loadProductCard("executor"));
  });

  it.each([
    ["runner_local", "sandbox"],
    ["sandbox", "runner_local"],
  ] as const)("A7: a repo switched from %s to %s between the pipeline's read and the start is refused execution_mode_changed: no run, no job, no claim, the item stays at spec_ready", async (from, to) => {
    const { a, workItemId } = await world(from);
    const flip = async () => void (await admin.query("UPDATE repos SET execution_mode = $2 WHERE id = $1", [a.repoId, to]));
    // The seeded account already owns rows of its own; the refused start must add none.
    const counts = async () => {
      const n = async (table: string) => Number((await admin.query(`SELECT count(*) FROM ${table} WHERE account_id = $1`, [a.accountId])).rows[0].count);
      return { runs: await n("agent_runs"), keys: await n("agent_run_idempotency_keys"), reservations: await n("spend_reservations"), events: await n("run_events") };
    };
    const before = await counts();
    const out = await startBuildForItem(writerPool, a.accountId, workItemId, randomUUID(), ports(chain(), a.accountId, workItemId, flip));
    expect(out).toEqual({ status: "refused", reason: "start_execution_mode_changed" });
    expect(await counts()).toEqual(before);
    expect((await admin.query("SELECT 1 FROM agent_runs WHERE account_id = $1 AND job_signed IS NOT NULL", [a.accountId])).rowCount).toBe(0);
    expect((await admin.query("SELECT stage FROM work_items WHERE id = $1", [workItemId])).rows[0].stage).toBe("spec_ready");
  });

  it("A7: with no flip the same repo starts (the refusal is the mode check and nothing else)", async () => {
    const { a, workItemId } = await world("runner_local");
    const out = await startBuildForItem(writerPool, a.accountId, workItemId, randomUUID(), ports(chain(), a.accountId, workItemId, async () => undefined));
    expect(out.status).toBe("started");
  });
});
