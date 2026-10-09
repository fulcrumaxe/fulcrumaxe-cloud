import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EXECUTION_TARGETS, isAdmitDenyReason, resolveExecutionTarget, type ExecutionTargetRegistry } from "../src/executionTarget.js";
import { RUNNER_MODES, RUNNER_MODES_SQL, isRunnerMode } from "../src/runnerModes.js";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { RunnerTarget } from "../src/targets/runnerTarget.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { createFakeJobIssuer, createFakeRunnerLimits, createFakeVisibility } from "./helpers/runnerTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

/** D#6 R5b-1 (C38): the third execution mode. The registry, the one list of runner modes, and what a verified repo's runs do and do not get. */
describe("runner_verified mode [pg]", () => {
  const db = pgHarness();

  function registry() {
    const issuer = createFakeJobIssuer();
    const deps = { limits: createFakeRunnerLimits(), pool: db.runWriterPool, issuer, visibility: createFakeVisibility("private") };
    const reg: ExecutionTargetRegistry = {
      runner_local: EXECUTION_TARGETS.runner_local(deps),
      runner_verified: EXECUTION_TARGETS.runner_verified(deps),
    };
    return { issuer, reg };
  }

  async function verifiedRepo(mode = "runner_verified"): Promise<{ accountId: string; repoId: string }> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId, { executionMode: mode });
    return { accountId, repoId };
  }

  const input = (w: { accountId: string; repoId: string }, role: StartAgentRunInput["role"]): StartAgentRunInput => ({
    accountId: w.accountId,
    repoId: w.repoId,
    role,
    product: "team",
    roleCard: "card",
    prompt: "prompt",
    model: "haiku-4.5",
    capUsd: 5,
    spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    ...(role === "executor" ? { pr: 12 } : {}),
  });

  const runRow = async (id: string) => (await db.admin.query("SELECT status, execution_mode, runtime, job_signed, (SELECT e.payload ->> 'failureReason' FROM run_events e WHERE e.run_id = agent_runs.id AND e.kind = 'run.status_changed' ORDER BY e.seq DESC LIMIT 1) AS failure_reason FROM agent_runs WHERE id = $1", [id])).rows[0];

  it("the one list: RUNNER_MODES is the two runner modes, and the SQL list is built from it", () => {
    expect([...RUNNER_MODES]).toEqual(["runner_local", "runner_verified"]);
    expect(RUNNER_MODES_SQL).toBe("'runner_local', 'runner_verified'");
    for (const mode of ["runner_local", "runner_verified"]) expect(isRunnerMode(mode), mode).toBe(true);
    for (const other of ["sandbox", "runner", "RUNNER_LOCAL", "", null, undefined, 3]) expect(isRunnerMode(other), String(other)).toBe(false);
  });

  it("a verified executor run is queued through the runner target and its job is asked for with mode verified; a local one is not", async () => {
    const { issuer, reg } = registry();
    const verified = await verifiedRepo();
    const result = await startAgentRun(db.runWriterPool, reg, input(verified, "executor"));
    expect(result).toMatchObject({ status: "pending" });
    expect(await runRow(result.id)).toMatchObject({ status: "pending", execution_mode: "runner_verified", runtime: "runner" });
    expect(issuer.calls).toHaveLength(1);
    expect(issuer.calls[0]).toMatchObject({ run: { id: result.id, role: "executor" }, jobMode: "verified" });

    const local = await verifiedRepo("runner_local");
    const localResult = await startAgentRun(db.runWriterPool, reg, input(local, "executor"));
    expect(await runRow(localResult.id)).toMatchObject({ execution_mode: "runner_local" });
    expect(issuer.calls[1]!.jobMode).toBeUndefined();
  });

  it.each(["code-reviewer", "security-reviewer", "acceptance-tester", "debater"] as const)(
    "%s in a verified repo is refused verified_review_not_wired: no job is issued, none is stored, and the run is refused (not queued)",
    async (role) => {
      const { issuer, reg } = registry();
      const w = await verifiedRepo();
      const result = await startAgentRun(db.runWriterPool, reg, input(w, role));
      expect(result).toMatchObject({ status: "refused_spend", reason: "verified_review_not_wired" });
      expect(issuer.calls).toEqual([]);
      expect(await runRow(result.id)).toMatchObject({ status: "refused_spend", failure_reason: "verified_review_not_wired", job_signed: null });
    },
  );

  it("the same reviewer in a runner_local repo is still queued, and the new reason is a member of the closed set", async () => {
    const { issuer, reg } = registry();
    const w = await verifiedRepo("runner_local");
    const result = await startAgentRun(db.runWriterPool, reg, input(w, "code-reviewer"));
    expect(result).toMatchObject({ status: "pending" });
    expect(issuer.calls).toHaveLength(1);
    expect(isAdmitDenyReason("verified_review_not_wired")).toBe(true);
  });

  it("a registry without the verified target refuses a verified repo's run before anything is written", () => {
    const { reg } = registry();
    const { runner_verified: _dropped, ...withoutVerified } = reg;
    void _dropped;
    expect(() => resolveExecutionTarget("runner_verified", withoutVerified)).toThrow();
    expect(resolveExecutionTarget("runner_verified", reg)).toBeInstanceOf(RunnerTarget);
  });
});
