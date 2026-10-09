import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EXECUTION_TARGETS, runtimeFor, type ExecutionTargetRegistry } from "../src/executionTarget.js";
import { buildExecutionRun, startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import { runsInOurSandbox } from "../src/targets/verifiedTarget.js";
import { seedAccount, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { createFakeJobIssuer, createFakeRunnerLimits, createFakeVisibility } from "./helpers/runnerTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

const REVIEWERS = ["code-reviewer", "security-reviewer", "acceptance-tester", "debater"] as const;
const HEAD = "a".repeat(40);

/** D#6 R5b-2a (C38 section 1, acceptance 2): a verified repo's four reviewers run in our sandbox on the customer's key; its runner roles do not touch money. */
describe("cloud-verified reviews: routing and money [pg]", () => {
  const db = pgHarness();

  function world() {
    const h = createSandboxTargetHarness(db.runWriterPool);
    const sandbox = new SandboxTarget(h.deps);
    const issuer = createFakeJobIssuer();
    const registry: ExecutionTargetRegistry = {
      sandbox,
      runner_verified: EXECUTION_TARGETS.runner_verified({
        runner: { limits: createFakeRunnerLimits(), pool: db.runWriterPool, issuer, visibility: createFakeVisibility("private") },
        sandbox,
      }),
    };
    return { h, sandbox, issuer, registry };
  }

  async function seed(mode = "runner_verified") {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId, { executionMode: mode });
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 5 });
    return { accountId, repoId, workItemId };
  }

  const input = (w: { accountId: string; repoId: string; workItemId: string }, role: StartAgentRunInput["role"]): StartAgentRunInput => ({
    accountId: w.accountId,
    repoId: w.repoId,
    workItemId: w.workItemId,
    role,
    product: "team",
    roleCard: "card",
    prompt: "prompt",
    model: "haiku-4.5",
    capUsd: 5,
    spend: { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 1, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 },
    ...(role === "executor" ? { pr: 12 } : { headSha: HEAD }),
  });

  const runRow = async (id: string) => (await db.admin.query("SELECT status, execution_mode, runtime, runner_id, head_sha FROM agent_runs WHERE id = $1", [id])).rows[0];
  const reservations = async (accountId: string) => (await db.admin.query("SELECT run_id, budget, state FROM spend_reservations WHERE account_id = $1 ORDER BY budget", [accountId])).rows;
  const ledgerCount = async (accountId: string) => (await db.admin.query("SELECT count(*)::int AS n FROM ledger WHERE account_id = $1", [accountId])).rows[0].n as number;

  it.each(REVIEWERS)("%s runs in our sandbox: runtime production, mode runner_verified, no runner, the dispatch's head, and its reservations settle", async (role) => {
    const { h, sandbox, issuer, registry } = world();
    const w = await seed();
    const started = await startAgentRun(db.runWriterPool, registry, input(w, role));
    expect(started.status).toBe("running");
    expect(await runRow(started.id)).toMatchObject({ status: "running", execution_mode: "runner_verified", runtime: "production", runner_id: null, head_sha: HEAD });
    expect(issuer.calls).toEqual([]);
    expect(h.fakeSandbox.state.created).toHaveLength(1);
    const opened = await reservations(w.accountId);
    expect(opened.map((r) => r.budget)).toContain("model");
    expect(opened.every((r) => r.run_id === started.id && r.state === "open")).toBe(true);

    await new Promise((r) => setTimeout(r, 30));
    await sandbox.finalize(buildExecutionRun(started.id, input(w, role)), { status: "succeeded", usd: 0.1 });
    const model = (await reservations(w.accountId)).filter((r) => r.budget === "model");
    expect(model).toHaveLength(1);
    expect(model[0]!.state).toBe("settled");
  });

  it("the runner roles of the same repo never reserve, meter or settle: a job is issued and the run waits for a runner", async () => {
    const { h, issuer, registry } = world();
    const w = await seed();
    const started = await startAgentRun(db.runWriterPool, registry, input(w, "executor"));
    expect(started).toMatchObject({ status: "pending" });
    expect(await runRow(started.id)).toMatchObject({ execution_mode: "runner_verified", runtime: "runner", head_sha: null });
    expect(issuer.calls).toHaveLength(1);
    expect(h.fakeSandbox.state.created).toEqual([]);
    expect(await reservations(w.accountId)).toEqual([]);
    expect(await ledgerCount(w.accountId)).toBe(0);
  });

  it("the stamp is the target's answer for the role, and the helper that picks prompts and cards agrees with it", () => {
    const { registry } = world();
    const target = registry.runner_verified!;
    for (const role of REVIEWERS) {
      expect(runtimeFor(target, role), role).toBe("production");
      expect(runsInOurSandbox("runner_verified", role), role).toBe(true);
    }
    for (const role of ["executor", "docs-writer", "project-manager"]) {
      expect(runtimeFor(target, role), role).toBe("runner");
      expect(runsInOurSandbox("runner_verified", role), role).toBe(false);
    }
    // A runner_local repo's reviewers stay on the runner (C12), and a sandbox repo's agents stay in the sandbox.
    expect(runsInOurSandbox("runner_local", "code-reviewer")).toBe(false);
    expect(runsInOurSandbox("sandbox", "executor")).toBe(true);
  });

  it("the database refuses the other shapes: a production run of a non-reviewer role, and a runner run with a sandbox-only role stamp, in a verified repo", async () => {
    const w = await seed();
    const insert = (role: string, runtime: string) =>
      db.admin.query("INSERT INTO agent_runs (id, account_id, role, status, runtime, execution_mode) VALUES ($1, $2, $3, 'pending', $4, 'runner_verified')", [randomUUID(), w.accountId, role, runtime]);
    await expect(insert("executor", "production")).rejects.toThrow(/agent_runs_runner_verified_runtime_check/);
    await expect(insert("code-reviewer", "local")).rejects.toThrow();
    await insert("code-reviewer", "production");
    await insert("executor", "runner");
  });
});
