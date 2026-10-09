import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  EXECUTION_TARGETS,
  UnknownExecutionModeError,
  resolveExecutionTarget,
  type ExecutionTargetRegistry,
} from "../src/executionTarget.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import { RunnerTarget } from "../src/targets/runnerTarget.js";
import { createFakeJobIssuer, createFakeRunnerLimits, createFakeVisibility } from "./helpers/runnerTargetFakes.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

/** D#2 H09b, correction C10, pass/fail 10, as D#6 R3a amends it: the sandbox and the local runner are the two targets
 * wired, and D#6 R5b-1 (C38) adds `runner_verified` as the third key. */
describe("execution target registry", () => {
  it("Object.keys(EXECUTION_TARGETS) deep-equals ['sandbox', 'runner_local', 'runner_verified']", () => {
    expect(Object.keys(EXECUTION_TARGETS)).toEqual(["sandbox", "runner_local", "runner_verified"]);
  });

  it("the factories build the two targets, each from its own deps", () => {
    const pool = {} as Pool;
    const runner = EXECUTION_TARGETS.runner_local({ limits: createFakeRunnerLimits(), pool, issuer: createFakeJobIssuer(), visibility: createFakeVisibility() });
    expect(runner).toBeInstanceOf(RunnerTarget);
    expect(runner.runtime).toBe("runner");
    const sandbox = EXECUTION_TARGETS.sandbox(createSandboxTargetHarness(pool).deps);
    expect(sandbox).toBeInstanceOf(SandboxTarget);
    expect(sandbox.runtime).toBe("production");
  });

  it("resolves 'runner_local' to a RunnerTarget instance, with and without VERCEL set", () => {
    const pool = {} as Pool;
    const registry: ExecutionTargetRegistry = {
      sandbox: new SandboxTarget(createSandboxTargetHarness(pool).deps),
      runner_local: new RunnerTarget({ limits: createFakeRunnerLimits(), pool, issuer: createFakeJobIssuer(), visibility: createFakeVisibility() }),
    };
    const before = process.env.VERCEL;
    try {
      delete process.env.VERCEL;
      const without = resolveExecutionTarget("runner_local", registry);
      process.env.VERCEL = "1";
      const withVercel = resolveExecutionTarget("runner_local", registry);
      expect(without).toBeInstanceOf(RunnerTarget);
      expect(withVercel).toBe(without);
    } finally {
      if (before === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = before;
    }
  });

  it("a registry that does not hold 'runner_verified' still throws UnknownExecutionModeError for it", () => {
    const pool = {} as Pool;
    const registry: ExecutionTargetRegistry = {
      sandbox: new SandboxTarget(createSandboxTargetHarness(pool).deps),
      runner_local: new RunnerTarget({ limits: createFakeRunnerLimits(), pool, issuer: createFakeJobIssuer(), visibility: createFakeVisibility() }),
    };
    expect(() => resolveExecutionTarget("runner_verified", registry)).toThrow(UnknownExecutionModeError);
    expect(() => resolveExecutionTarget("runner", registry)).toThrow(UnknownExecutionModeError);
  });

  it("resolves 'sandbox' to a SandboxTarget instance, unaffected by VERCEL* env vars", () => {
    const pool = {} as Pool; // never connected to -- resolution itself makes no I/O call.
    const registry: ExecutionTargetRegistry = { sandbox: new SandboxTarget(createSandboxTargetHarness(pool).deps) };

    const withoutVercel = resolveExecutionTarget("sandbox", registry);
    expect(withoutVercel).toBeInstanceOf(SandboxTarget);

    const prevVercel = process.env.VERCEL;
    process.env.VERCEL = "1";
    try {
      const withVercel = resolveExecutionTarget("sandbox", registry);
      expect(withVercel).toBeInstanceOf(SandboxTarget);
      // Same registry, same lookup -- "the two results are identical"
      // (C10): resolution never reads `VERCEL*` at all, so both calls
      // return literally the same instance.
      expect(withVercel).toBe(withoutVercel);
    } finally {
      if (prevVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = prevVercel;
    }
  });

  it("given 'runner', the resolver throws UnknownExecutionModeError", () => {
    const registry: ExecutionTargetRegistry = {};
    expect(() => resolveExecutionTarget("runner", registry)).toThrow(UnknownExecutionModeError);
  });

  describe("[pg] repos_execution_mode_check", () => {
    const db = pgHarness();

    it("UPDATE repos SET execution_mode = 'runner' fails the CHECK constraint", async () => {
      const accountId = randomUUID();
      const repoId = randomUUID();
      await seedAccount(db.admin, accountId);
      await seedRepo(db.admin, accountId, repoId);

      await expect(
        db.admin.query(`UPDATE repos SET execution_mode = 'runner' WHERE id = $1`, [repoId]),
      ).rejects.toThrow(/repos_execution_mode_check/);
    });

    it("defaults to 'sandbox' when not specified", async () => {
      const accountId = randomUUID();
      const repoId = randomUUID();
      await seedAccount(db.admin, accountId);
      await db.admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1, $2, $3, 'team')`, [
        repoId,
        accountId,
        Math.floor(Math.random() * 1_000_000_000),
      ]);
      const { rows } = await db.admin.query(`SELECT execution_mode FROM repos WHERE id = $1`, [repoId]);
      expect(rows[0].execution_mode).toBe("sandbox");
    });
  });
});
