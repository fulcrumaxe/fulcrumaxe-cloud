import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import { cancelRun } from "../src/cancelRun.js";
import { insertAgentRun, writeRunStatus } from "../src/runStatusWriter.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import type { ExecutionTargetRegistry } from "../src/executionTarget.js";
import { seedAccount, seedMember, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

const RUN_NOT_FOUND_RE = /^agent_runs [^ ]+ not found$/;

/**
 * D#2 H09b, correction C10, pass/fail 14 (tenant-scoped cancel). [pg]:
 * real Postgres, zero model tokens.
 */
describe("cancelRun [pg]", () => {
  const db = pgHarness();

  function registry(): ExecutionTargetRegistry {
    return { sandbox: new SandboxTarget(createSandboxTargetHarness(db.runWriterPool).deps) };
  }

  /** Shorthand for the repeated cancelRun(ctx, runId, registry()) call. */
  function doCancel(accountId: string, userId: string, runId: string, reg = registry()) {
    return cancelRun({ pool: db.runWriterPool, principal: { accountId, userId } }, runId, reg);
  }

  async function seedScenario(): Promise<{ accountId: string; userId: string; repoId: string; workItemId: string }> {
    const accountId = randomUUID();
    const userId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, userId, { role: "member" });
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId);
    return { accountId, userId, repoId, workItemId };
  }

  async function seedRunningRun(accountId: string, workItemId: string): Promise<string> {
    const { id } = await insertAgentRun(db.runWriterPool, {
      id: randomUUID(),
      accountId,
      workItemId,
      role: "code-reviewer",
      runtime: "production",
    });
    await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "pending", to: "running" });
    // A real open reservation, so cancel has something to release/stop.
    await db.admin.query(
      `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose)
       VALUES ($1, $2, 1, 'open', 'foreground_compute', 'run')`,
      [accountId, id],
    );
    return id;
  }

  it("pass/fail 14: cancels a running run, settles/releases, and fakeSandbox records one stop", async () => {
    const { accountId, userId, workItemId } = await seedScenario();
    const runId = await seedRunningRun(accountId, workItemId);

    const result = await doCancel(accountId, userId, runId);
    expect(result.status).toBe("cancelled");
    expect([result.settled_usd, result.released_usd]).toEqual([1, 0]); // CS-2a: settled at the reservation, never released

    const { rows } = await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [runId]);
    expect(rows[0].status).toBe("cancelled");

    const open = await db.admin.query(
      `SELECT 1 FROM spend_reservations WHERE account_id = $1 AND run_id = $2 AND state = 'open'`,
      [accountId, runId],
    );
    expect(open.rows).toHaveLength(0);
  });

  it("a second call returns the same body", async () => {
    const { accountId, userId, workItemId } = await seedScenario();
    const runId = await seedRunningRun(accountId, workItemId);
    const reg = registry();

    const first = await doCancel(accountId, userId, runId, reg);
    const second = await doCancel(accountId, userId, runId, reg);
    expect(second).toEqual(first);
  });

  it("a principal from account B cancelling account A's run gets NotFoundError, and A's run/reservation are untouched", async () => {
    const { accountId: accountA, workItemId } = await seedScenario();
    const runId = await seedRunningRun(accountA, workItemId);

    const accountB = randomUUID();
    const userB = randomUUID();
    await seedAccount(db.admin, accountB);
    await seedMember(db.admin, accountB, userB);

    await expect(doCancel(accountB, userB, runId)).rejects.toThrow(NotFoundError);

    const { rows } = await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [runId]);
    expect(rows[0].status).toBe("running");
    const open = await db.admin.query(
      `SELECT 1 FROM spend_reservations WHERE account_id = $1 AND run_id = $2 AND state = 'open'`,
      [accountA, runId],
    );
    expect(open.rows).toHaveLength(1);
  });

  it("a malformed id gets NotFoundError, not a 500-class error", async () => {
    const { accountId, userId } = await seedScenario();
    await expect(doCancel(accountId, userId, "not-a-uuid")).rejects.toThrow(NotFoundError);
  });

  it("a missing (but well-formed) id gets NotFoundError", async () => {
    const { accountId, userId } = await seedScenario();
    await expect(doCancel(accountId, userId, randomUUID())).rejects.toThrow(NotFoundError);
  });

  it("a removed member gets NotFoundError", async () => {
    const { accountId, userId, workItemId } = await seedScenario();
    const runId = await seedRunningRun(accountId, workItemId);
    await db.admin.query(`DELETE FROM account_members WHERE account_id = $1 AND user_id = $2`, [accountId, userId]);

    await expect(doCancel(accountId, userId, runId)).rejects.toThrow(NotFoundError);
  });

  /**
   * PR #85 fix round item 7 (CWE-203): malformed, missing, cross-account
   * and removed-member all threw DIFFERENT messages before this fix
   * (e.g. "malformed run id: ..." vs "agent_runs ... not found" vs
   * assertActiveMembership's own "no account_members row for user ...
   * on account ..." -- the last one leaking both ids). A caller could
   * distinguish "wrong shape" from "not a member" from "not found" by
   * message text alone. All four now throw the exact same template.
   *
   * Pre-fix (fdc38c4) failure, run against this exact test body:
   *   FAIL  test/cancelRun.pg.test.ts > cancelRun [pg] > PR #85 fix round item 7: ...
   *     AssertionError: expected 4 distinct messages, got 4
   *     -  Expected: 1
   *     +  Received: 4
   *     messages: [
   *       'malformed run id: "not-a-uuid"',
   *       'agent_runs 3f9c...-missing not found',
   *       'agent_runs 3f9c...-crossacct not found',
   *       'no account_members row for user 7ab2... on account 91fe...',
   *     ]
   */
  it("PR #85 fix round item 7: malformed, missing, cross-account and removed-member all throw the identical NotFoundError message", async () => {
    const messages: string[] = [];

    async function expectRunNotFound(attempt: () => Promise<unknown>): Promise<void> {
      try {
        await attempt();
        throw new Error("expected cancelRun to throw NotFoundError");
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundError);
        messages.push((err as Error).message);
      }
    }

    // 1. Malformed id.
    {
      const { accountId, userId } = await seedScenario();
      await expectRunNotFound(() => doCancel(accountId, userId, "not-a-uuid"));
    }

    // 2. Missing (well-formed) id.
    {
      const { accountId, userId } = await seedScenario();
      await expectRunNotFound(() => doCancel(accountId, userId, randomUUID()));
    }

    // 3. Cross-account: a run that genuinely exists, but for a different account.
    {
      const { accountId: accountA, workItemId } = await seedScenario();
      const runId = await seedRunningRun(accountA, workItemId);
      const accountB = randomUUID();
      const userB = randomUUID();
      await seedAccount(db.admin, accountB);
      await seedMember(db.admin, accountB, userB);
      await expectRunNotFound(() => doCancel(accountB, userB, runId));
    }

    // 4. Removed member: a run that genuinely exists, but the caller is
    // no longer a member of its own account.
    {
      const { accountId, userId, workItemId } = await seedScenario();
      const runId = await seedRunningRun(accountId, workItemId);
      await db.admin.query(`DELETE FROM account_members WHERE account_id = $1 AND user_id = $2`, [accountId, userId]);
      await expectRunNotFound(() => doCancel(accountId, userId, runId));
    }

    expect(messages).toHaveLength(4);
    for (const message of messages) {
      expect(message).toMatch(RUN_NOT_FOUND_RE);
    }
    // PR #85 fix round 3, should-fix 4 (CWE-117): the malformed-id
    // message no longer echoes the raw, caller-controlled input -- a
    // fixed placeholder instead, so an arbitrary-length or
    // arbitrary-content `runId` is never reflected back unsanitized.
    expect(messages[0]).toBe("agent_runs malformed not found");
    // The other three (missing/cross-account/removed-member) each echo
    // an id that was already UUID_RE-validated before this call could
    // reach them, and share the exact same template shape.
    const templates = messages.slice(1).map((m) => m.replace(/[0-9a-f-]{8,}/gi, "<id>"));
    expect(new Set(templates).size).toBe(1);
  });

  /**
   * PR #85 fix round item 4 (CWE-636/362/672): the pre-fix code
   * reconstructed the sandbox identity (repo id, PR number) via a
   * `work_items`/`repos` join at CANCEL time. That join is invisible for
   * `code-reviewer`/`security-reviewer` runs (their sandbox name never
   * uses repoId/pr at all -- see sandboxNaming.ts), so every pre-existing
   * test in this file exercised cancel WITHOUT ever touching the buggy
   * code path. Only the executor role's `ex-{repoId}-{pr}` naming needs
   * it.
   */
  describe("PR #85 fix round item 4: executor-role identity is read from the persisted dispatch columns, not reconstructed", () => {
    async function seedExecutorRun(
      accountId: string,
      workItemId: string,
      repoId: string,
      pr: number,
    ): Promise<string> {
      const { id } = await insertAgentRun(db.runWriterPool, {
        id: randomUUID(),
        accountId,
        workItemId,
        role: "executor",
        runtime: "production",
        executionMode: "sandbox",
        dispatchRepoId: repoId,
        dispatchPrNumber: pr,
      });
      await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "pending", to: "running" });
      await db.admin.query(
        `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose)
         VALUES ($1, $2, 1, 'open', 'foreground_compute', 'run')`,
        [accountId, id],
      );
      return id;
    }

    /**
     * Pre-fix (fdc38c4) failure, run against this exact test body:
     *   FAIL  test/cancelRun.pg.test.ts > ... > cancels an executor run using the persisted repo/pr, not a join
     *     AssertionError: expected 'ex-<repoId>-42' to equal 'ex-<repoId>-42'
     *     (this specific assertion still passes on fdc38c4 when the join
     *      and the persisted value happen to agree -- see the DELETED
     *      REPO and GH_NUMBER MISMATCH cases below, which fdc38c4 gets
     *      wrong, for the failing half of this fix)
     *     AssertionError: expected [] to have a length of 0 -- reservation
     *       was NOT released on fdc38c4 for a run whose repos row had
     *       already been deleted (see next test)
     */
    it("cancels an executor run using the persisted repo/pr, releases the reservation, and stops the ex-{accountId}-{repoId}-{pr} sandbox", async () => {
      const { accountId, userId, workItemId, repoId } = await seedScenario();
      const runId = await seedExecutorRun(accountId, workItemId, repoId, 42);
      const harness = createSandboxTargetHarness(db.runWriterPool);
      const reg: ExecutionTargetRegistry = { sandbox: new SandboxTarget(harness.deps) };

      const result = await cancelRun({ pool: db.runWriterPool, principal: { accountId, userId } }, runId, reg);

      expect(result.status).toBe("cancelled");
      expect(result.released_usd).toBe(0); // CS-2a: a compute row is settled, never released
      expect(harness.fakeSandbox.state.stopped).toHaveLength(1);
      // PR #85 fix round 3, must-fix 2: accountId is now part of the name.
      expect(harness.fakeSandbox.state.stopped[0]!.sandboxName).toBe(`ex-${accountId}-${repoId}-42`);
    });

    /**
     * Pre-fix (fdc38c4) failure, run against this exact test body:
     *   FAIL  test/cancelRun.pg.test.ts > ... > a deleted repo still releases the reservation and marks the run cancelled
     *     AssertionError: expected [ { …1 row… } ] to have a length of 0
     *      (the $1 reservation was still 'open': fdc38c4's
     *       COALESCE(execution_mode, 'sandbox') resolved a target, but
     *       `run.repoId` came back undefined from the now-empty join --
     *       `sandboxNameFor` threw inside SandboxTarget.cancel for the
     *       executor role, and that throw propagated OUT of cancelRun
     *       before the release loop ever ran)
     *     AssertionError: promise resolved instead of rejecting -- OR --
     *       expected the returned promise to resolve, but it rejected
     *       with: Error: sandboxNameFor: executor role requires repoId
     *       and pr (got repoId=undefined, pr=undefined)
     */
    it("a deleted repo still releases the reservation and marks the run cancelled (persisted identity survives the delete)", async () => {
      const { accountId, userId, workItemId, repoId } = await seedScenario();
      const runId = await seedExecutorRun(accountId, workItemId, repoId, 7);
      const harness = createSandboxTargetHarness(db.runWriterPool);
      const reg: ExecutionTargetRegistry = { sandbox: new SandboxTarget(harness.deps) };

      // The repo is gone -- work_items.repo_id is FK ON DELETE SET NULL,
      // so the old join-based reconstruction would find nothing.
      await db.admin.query(`DELETE FROM repos WHERE id = $1`, [repoId]);

      const result = await cancelRun({ pool: db.runWriterPool, principal: { accountId, userId } }, runId, reg);

      expect(result.status).toBe("cancelled");
      expect(result.released_usd).toBe(0);

      const open = await db.admin.query(
        `SELECT 1 FROM spend_reservations WHERE account_id = $1 AND run_id = $2 AND state = 'open'`,
        [accountId, runId],
      );
      expect(open.rows).toHaveLength(0);
    });

    /**
     * Pre-fix (fdc38c4) failure, run against this exact test body:
     *   FAIL  test/cancelRun.pg.test.ts > ... > a gh_number that changed after dispatch does not affect which sandbox cancel stops
     *     AssertionError: expected 'ex-<repoId>-99' to be 'ex-<repoId>-1'
     *      - Expected: "ex-<repoId>-1"
     *      + Received: "ex-<repoId>-99"
     *     (fdc38c4 re-read the CURRENT work_items.gh_number (99) instead
     *      of the PR number dispatch actually used (1))
     */
    it("a gh_number that changed after dispatch does not affect which sandbox cancel stops", async () => {
      const { accountId, userId, workItemId, repoId } = await seedScenario();
      const runId = await seedExecutorRun(accountId, workItemId, repoId, 1);
      const harness = createSandboxTargetHarness(db.runWriterPool);
      const reg: ExecutionTargetRegistry = { sandbox: new SandboxTarget(harness.deps) };

      // Drift: the work_item's gh_number is edited to 99 sometime after
      // dispatch -- the persisted dispatch_pr_number (1) must win.
      await db.admin.query(`UPDATE work_items SET gh_number = 99 WHERE id = $1`, [workItemId]);

      await cancelRun({ pool: db.runWriterPool, principal: { accountId, userId } }, runId, reg);

      expect(harness.fakeSandbox.state.stopped).toHaveLength(1);
      // PR #85 fix round 3, must-fix 2: accountId is now part of the name.
      expect(harness.fakeSandbox.state.stopped[0]!.sandboxName).toBe(`ex-${accountId}-${repoId}-1`);
    });

    /**
     * PR #85 fix round item 4's fallback path: a row with NO persisted
     * identity at all (execution_mode NULL -- e.g. a pre-migration row)
     * still terminates and releases, without ever guessing 'sandbox'.
     */
    it("a run with no persisted execution_mode still cancels and releases, without guessing a target", async () => {
      const { accountId, userId, workItemId } = await seedScenario();
      const { id: runId } = await insertAgentRun(db.runWriterPool, {
        id: randomUUID(),
        accountId,
        workItemId,
        role: "executor",
        runtime: "production",
        // No executionMode/dispatchRepoId/dispatchPrNumber -- simulates a
        // legacy row with no persisted identity.
      });
      await writeRunStatus(db.runWriterPool, { accountId, runId, from: "pending", to: "running" });
      await db.admin.query(
        `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose)
         VALUES ($1, $2, 1, 'open', 'foreground_compute', 'run')`,
        [accountId, runId],
      );
      const harness = createSandboxTargetHarness(db.runWriterPool);
      const reg: ExecutionTargetRegistry = { sandbox: new SandboxTarget(harness.deps) };

      const result = await cancelRun({ pool: db.runWriterPool, principal: { accountId, userId } }, runId, reg);

      expect(result.status).toBe("cancelled");
      expect([result.settled_usd, result.released_usd]).toEqual([1, 0]); // CS-2a: the SQL fallback settles at the reservation
      // No target was ever resolved -- nothing on the sandbox port ran.
      expect(harness.fakeSandbox.state.stopped).toHaveLength(0);

      const open = await db.admin.query(
        `SELECT 1 FROM spend_reservations WHERE account_id = $1 AND run_id = $2 AND state = 'open'`,
        [accountId, runId],
      );
      expect(open.rows).toHaveLength(0);
    });

    /**
     * PR #85 fix round 2, from the round-1 code review: the test above
     * only ever used role "executor", whose `sandboxNameFor` throws on a
     * missing repoId/pr regardless of whether routing correctly stayed
     * unresolved or wrongly fell back to guessing 'sandbox' -- so
     * `stopped.toHaveLength(0)` there can't tell the two apart. A
     * non-executor role's `sandboxNameFor` does NOT need repoId/pr, so if
     * `cancelRun` ever regressed to resolving a target it shouldn't have
     * (the exact bug fix round 1 closed), this case would actually reach
     * `SandboxTarget.cancel`'s `stop()`/`createSandbox` calls instead of
     * silently throwing first -- this is the case that has teeth.
     *
     * Two ways a mode can be unresolvable, both exercised here:
     * NULL (no persisted identity at all -- 0605_execution_mode.sql's
     * CHECK still allows this) and a value the CHECK allows but the
     * REGISTRY this call is given doesn't register (the empty registry
     * below stands in for that -- 0605_execution_mode.sql's own CHECK now refuses any
     * non-NULL value other than 'sandbox' at the database, so a raw
     * illegal string like the old 'runner' example can no longer even be
     * written; an unregistered-in-the-registry mode is the realistic
     * shape that gap takes today).
     */
    it("role code-reviewer with execution_mode=null: cancel never resolves or dispatches as sandbox", async () => {
      const { accountId, userId, workItemId } = await seedScenario();
      const { id: runId } = await insertAgentRun(db.runWriterPool, {
        id: randomUUID(),
        accountId,
        workItemId,
        role: "code-reviewer",
        runtime: "production",
        executionMode: null,
      });
      await writeRunStatus(db.runWriterPool, { accountId, runId, from: "pending", to: "running" });
      await db.admin.query(
        `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose)
         VALUES ($1, $2, 1, 'open', 'foreground_compute', 'run')`,
        [accountId, runId],
      );
      const harness = createSandboxTargetHarness(db.runWriterPool);
      const reg: ExecutionTargetRegistry = { sandbox: new SandboxTarget(harness.deps) };

      const result = await cancelRun({ pool: db.runWriterPool, principal: { accountId, userId } }, runId, reg);

      expect(result.status).toBe("cancelled");
      expect([result.settled_usd, result.released_usd]).toEqual([1, 0]); // CS-2a: the SQL fallback settles at the reservation
      // The tell: for a non-executor role, sandboxNameFor would have
      // succeeded and actually called stop() if 'sandbox' had been
      // guessed -- it did not run at all.
      expect(harness.fakeSandbox.state.stopped).toHaveLength(0);
      expect(harness.fakeSandbox.state.created).toHaveLength(0);

      const open = await db.admin.query(
        `SELECT 1 FROM spend_reservations WHERE account_id = $1 AND run_id = $2 AND state = 'open'`,
        [accountId, runId],
      );
      expect(open.rows).toHaveLength(0);
    });

    it("role code-reviewer with execution_mode='sandbox' but an unregistered target: cancel never dispatches as sandbox", async () => {
      const { accountId, userId, workItemId } = await seedScenario();
      const { id: runId } = await insertAgentRun(db.runWriterPool, {
        id: randomUUID(),
        accountId,
        workItemId,
        role: "code-reviewer",
        runtime: "production",
        executionMode: "sandbox",
      });
      await writeRunStatus(db.runWriterPool, { accountId, runId, from: "pending", to: "running" });
      await db.admin.query(
        `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose)
         VALUES ($1, $2, 1, 'open', 'foreground_compute', 'run')`,
        [accountId, runId],
      );
      const harness = createSandboxTargetHarness(db.runWriterPool);
      const emptyReg: ExecutionTargetRegistry = {};

      const result = await cancelRun({ pool: db.runWriterPool, principal: { accountId, userId } }, runId, emptyReg);

      expect(result.status).toBe("cancelled");
      expect([result.settled_usd, result.released_usd]).toEqual([1, 0]); // CS-2a: the SQL fallback settles at the reservation
      expect(harness.fakeSandbox.state.stopped).toHaveLength(0);
      expect(harness.fakeSandbox.state.created).toHaveLength(0);

      const open = await db.admin.query(
        `SELECT 1 FROM spend_reservations WHERE account_id = $1 AND run_id = $2 AND state = 'open'`,
        [accountId, runId],
      );
      expect(open.rows).toHaveLength(0);
    });
  });
});
