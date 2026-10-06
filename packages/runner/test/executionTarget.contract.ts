import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import type { DispatchResult, ExecutionRun, ExecutionTarget } from "../src/executionTarget.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * D#2 H09b, correction C10, pass/fail 8: reusable contract suite for
 * `ExecutionTarget`, run against `SandboxTarget` by
 * test/sandboxTarget.test.ts and against `RunnerTarget` by
 * test/runnerTarget.contract.test.ts. No sandbox-specific assertion.
 *
 * `makeTarget` takes the app_user `Pool` this suite seeds fixtures
 * against, since `SandboxTarget`'s `admit`/`cancel` genuinely touch
 * Postgres via `@fx/spend`. `RunnerTarget` holds no money and ignores it.
 *
 * D#6 R3a (correction C12 section 2.1) adds the queued variant. `dispatch` and `resume` return either `{ hookToken }`
 * or `{ queued: true }`; `options.dispatch` says which one the target under test must return, and each test checks
 * exactly that shape (never both). Everything else the suite asserts holds for both.
 */
export interface ContractOptions {
  /** What `dispatch` and `resume` answer: a Workflow hook token, or "queued for a runner". Default `hook`. */
  dispatch?: "hook" | "queued";
  /** The `agent_runs.runtime` the target stamps; the suite seeds its fixture runs with it. Default `production`. */
  runtime?: "production" | "runner";
  /** Returns a run that `admit` of the target under test refuses. Default: pause the account (a sandbox spend refusal). */
  refusableRun?: (run: ExecutionRun, admin: PoolClient) => Promise<ExecutionRun>;
}

export function describeExecutionTargetContract(
  name: string,
  makeTarget: (pool: Pool) => ExecutionTarget,
  options: ContractOptions = {},
): void {
  const mode = options.dispatch ?? "hook";
  const runtime = options.runtime ?? "production";

  /** The one place the two shapes are told apart: a hook token for a hook target, `{ queued: true }` for a queued one. */
  function expectDispatchShape(result: DispatchResult): void {
    if (mode === "queued") {
      expect(result).toEqual({ queued: true });
      return;
    }
    expect("hookToken" in result).toBe(true);
    const hookToken = (result as { hookToken: string }).hookToken;
    expect(typeof hookToken).toBe("string");
    expect(hookToken.length).toBeGreaterThan(0);
  }

  describe(`ExecutionTarget contract: ${name}`, () => {
    const db = pgHarness();

    async function seedRun(): Promise<ExecutionRun> {
      const accountId = randomUUID();
      const repoId = randomUUID();
      const runId = randomUUID();
      await seedAccount(db.admin, accountId);
      await seedRepo(db.admin, accountId, repoId);
      await db.admin.query(
        `INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'code-reviewer', $3, 'pending')`,
        [runId, accountId, runtime],
      );
      return {
        id: runId,
        accountId,
        role: "code-reviewer",
        product: "team",
        repoId,
        roleCard: "fake role card",
        prompt: "fake prompt",
        model: "haiku-4.5",
        capUsd: 5,
        spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
      };
    }

    it(mode === "queued" ? "dispatch returns { queued: true } and no hook token" : "dispatch returns a non-empty hookToken before the work finishes", async () => {
      const target = makeTarget(db.runWriterPool);
      const run = await seedRun();
      const admitted = await target.admit(run, db.admin);
      expect(admitted).toEqual({ admitted: true });

      expectDispatchShape(await target.dispatch(run));
    });

    it("the target names the runtime its runs are stamped with", () => {
      expect(makeTarget(db.runWriterPool).runtime).toBe(runtime);
    });

    it("after admit refuses, cancel has nothing to close", async () => {
      const target = makeTarget(db.runWriterPool);
      const run = await seedRun();
      // A denied purpose. By default a paused account -- reserve()'s accounts.status
      // gate refuses before any reservation is ever created. D#69
      // (migration 0606): status is derived -- set the owner_paused_at
      // marker instead of the (now rejected) status literal. A target with no
      // money (the runner) supplies its own refusable run.
      const refusable = options.refusableRun
        ? await options.refusableRun(run, db.admin)
        : (await db.admin.query(`UPDATE accounts SET owner_paused_at = now() WHERE id = $1`, [run.accountId]), run);

      const admitted = await target.admit(refusable, db.admin);
      expect(admitted.admitted).toBe(false);

      const result = await target.cancel(refusable);
      expect(result).toEqual({ settled_usd: 0, released_usd: 0 });
    });

    it("calling cancel twice returns the same {settled_usd, released_usd} and stops the work only once", async () => {
      const target = makeTarget(db.runWriterPool);
      const run = await seedRun();
      await target.admit(run, db.admin);
      await target.dispatch(run);

      const first = await target.cancel(run);
      const second = await target.cancel(run);
      expect(second).toEqual(first);
    });

    it("cancel does not throw when called before dispatch", async () => {
      const target = makeTarget(db.runWriterPool);
      const run = await seedRun();
      await target.admit(run, db.admin);

      await expect(target.cancel(run)).resolves.not.toThrow();
    });

    it("cancel does not throw when called after the work has completed", async () => {
      const target = makeTarget(db.runWriterPool);
      const run = await seedRun();
      await target.admit(run, db.admin);
      await target.dispatch(run);
      // Let any microtask-queued hook resumption settle.
      await new Promise((resolve) => setTimeout(resolve, 10));

      await expect(target.cancel(run)).resolves.not.toThrow();
    });

    it("after cancel, nothing admit opened is still open", async () => {
      const target = makeTarget(db.runWriterPool);
      const run = await seedRun();
      await target.admit(run, db.admin);
      await target.dispatch(run);
      await target.cancel(run);

      const { rows } = await db.admin.query(
        `SELECT 1 FROM spend_reservations WHERE account_id = $1 AND run_id = $2 AND state = 'open'`,
        [run.accountId, run.id],
      );
      expect(rows).toHaveLength(0);
    });

    // "the terminal report resumes the hook exactly once" is NOT asserted
    // here: hook resumption is wired through each target's own injected
    // port, which `ExecutionTarget` never exposes. See
    // test/sandboxTarget.test.ts's own assertion of this, against the
    // concrete `SandboxTarget` and its recorded `HookResumePort` double.

    // D#2 H09b2 additions -- generic over any ExecutionTarget, no
    // sandbox-specific assertion, so D#6 can run these unchanged too.

    it("finalize settles/releases whatever admit opened, and reports a CancelResult", async () => {
      const target = makeTarget(db.runWriterPool);
      const run = await seedRun();
      await target.admit(run, db.admin);
      await target.dispatch(run);

      const result = await target.finalize(run, { status: "succeeded", usd: 0.5 });
      expect(typeof result.settled_usd).toBe("number");
      expect(typeof result.released_usd).toBe("number");

      const { rows } = await db.admin.query(
        `SELECT 1 FROM spend_reservations WHERE account_id = $1 AND run_id = $2 AND state = 'open'`,
        [run.accountId, run.id],
      );
      expect(rows).toHaveLength(0);
    });

    it("resume never leaves the run's admitted spend still open, even when it falls back to a fresh dispatch", async () => {
      const target = makeTarget(db.runWriterPool);
      const run = await seedRun();
      await target.admit(run, db.admin);

      expectDispatchShape(await target.resume(run, "no-such-session-id"));

      await target.cancel(run);
      const { rows } = await db.admin.query(
        `SELECT 1 FROM spend_reservations WHERE account_id = $1 AND run_id = $2 AND state = 'open'`,
        [run.accountId, run.id],
      );
      expect(rows).toHaveLength(0);
    });
  });
}
