import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { assertActiveMembership } from "@fx/core/src/tenancy/scopedAccess.js";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import type { Pool, PoolClient } from "pg";
import {
  resolveExecutionTarget,
  type CancelResult,
  type ExecutionRun,
  type ExecutionTarget,
  type ExecutionTargetRegistry,
} from "./executionTarget.js";
import { isLegalRunTransition, type RunStatus } from "./statusTransitions.js";
import { reportError } from "@fx/telemetry";
import { writeRunStatus } from "./runStatusWriter.js";
import type { Product, Role } from "./types.js";

/**
 * D#2 H09b, correction C10: "For request handlers, `stop(runId)` is
 * `cancelRun(ctx:{pool, principal}, runId)` (C7 and D#31 API-6). It
 * returns `{status, settled_usd, released_usd}`."
 *
 * D#31 API-1's `Principal` (`{kind, accountId, userId, role, scopes,
 * tokenId?}`) is not on `main` yet, so this package can't import it.
 * `CancelRunPrincipal` is the narrow slice `cancelRun` needs (enough to
 * scope `withTenant` and run `assertActiveMembership`); API-1's real
 * `Principal` is expected to satisfy this shape structurally.
 *
 * `cancelRun` takes a THIRD parameter, `registry`, that C10's own
 * `cancelRun(ctx, runId)` description doesn't mention -- this package
 * builds `ExecutionTarget`s but not the composition root that wires a
 * production registry (D#31 API-6's job, when it wraps this function and
 * closes over a module-level registry). The extra parameter is the seam
 * that makes this testable now, and keeps `cancelRun.ts` outside the
 * import-boundary restriction (only the target-agnostic
 * `ExecutionTargetRegistry` type from `./executionTarget.js`).
 */
export interface CancelRunPrincipal {
  accountId: string;
  userId: string;
  kind?: "session" | "token";
}

export interface CancelRunResult {
  status: RunStatus;
  settled_usd: number;
  released_usd: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RunRow {
  status: RunStatus;
  role: Role;
  product: Product | null;
  /** PR #85 fix round item 4 -- persisted by `startAgentRun` at INSERT
   * time. `null` for a row with no persisted identity (a pre-migration
   * row, or a row not created through `startAgentRun`) -- see the
   * fallback path below. */
  execution_mode: string | null;
  dispatch_repo_id: string | null;
  /** `bigint` comes back from `pg` as a string; cast to `text` in the
   * query below and parsed with `Number()` where used, matching the
   * pre-fix code's own handling of `work_items.gh_number`. */
  dispatch_pr_number: string | null;
}

/**
 * PR #85 fix round item 7 (CWE-203): the malformed, missing,
 * cross-account and removed-member cases all throw this exact SAME
 * message -- distinguishing them by text would let a caller enumerate
 * which case applied ("does the id not even parse?" vs "does it belong
 * to someone else?" vs "am I no longer a member?"), precisely the
 * existence/shape leak `NotFoundError`'s own doc comment (errors.ts)
 * already refuses for the "another account" vs "doesn't exist" pair.
 * Tests assert this literal message, not just the error's class.
 *
 * PR #85 fix round 3, should-fix 4 (CWE-117): `id` must never be the
 * raw, caller-controlled `runId` for the ONE caller below that hasn't
 * validated it yet (the malformed-shape branch, which passes the fixed
 * placeholder `"malformed"` instead) -- an arbitrary-length, arbitrary-
 * content string echoed straight back into an error message is exactly
 * the kind of value a route or log sink that isn't careful about it
 * would reflect unsanitized. Every OTHER caller of this function already
 * validated `id` as `UUID_RE`-shaped before reaching here, so echoing it
 * is fine (and still useful for support/debugging).
 */
function runNotFound(id: string): NotFoundError {
  return new NotFoundError(`agent_runs ${id} not found`);
}

export async function cancelRun(
  ctx: { pool: Pool; principal: CancelRunPrincipal },
  runId: string,
  registry: ExecutionTargetRegistry,
): Promise<CancelRunResult> {
  // Pass/fail 14: "A malformed id gets `NotFoundError`, not a 500-class
  // error." Checked before opening a transaction.
  if (!UUID_RE.test(runId)) {
    throw runNotFound("malformed");
  }

  const { pool, principal } = ctx;

  // PR #85 fix round item 5 (CWE-833/400): this read-only lookup runs in
  // its OWN short-lived transaction, released before ANY of the writes
  // below run. `writeRunStatus` and `target.cancel` each open their OWN
  // connection via their OWN `withTenant`/`withAccount` call against the
  // SAME pool -- holding this connection open across those calls (the
  // pre-fix shape: the whole function body lived inside one outer
  // `withTenant`) was a nested-pool-acquisition deadlock on a small pool.
  // Acquire, use, release here; everything after is its own sequential
  // acquire-release, never overlapping with this one.
  const row = await withTenant(pool, principal.accountId, principal.userId, async (client) => {
    // C10: "For a session principal it also runs H06's
    // assertActiveMembership." A token principal's scope/role is already
    // checked by whatever validated the token (D#31 API-6, not built
    // here); every other shape this package knows is a session.
    if (principal.kind !== "token") {
      try {
        await assertActiveMembership(client, principal.accountId, principal.userId);
      } catch {
        // Re-thrown as the one canonical message (item 7) -- never this
        // function's own accountId/userId-bearing text.
        throw runNotFound(runId);
      }
    }

    // C10: "A run in another account, a missing id and a malformed id
    // all throw the same NotFoundError." RLS already makes "another
    // account" and "doesn't exist" indistinguishable (both zero rows);
    // item 6 (CWE-208) adds an explicit `account_id` filter to the query
    // itself too, rather than relying on RLS alone.
    return fetchRunRow(client, runId, principal.accountId);
  });

  if (!row) {
    throw runNotFound(runId);
  }

  // roleCard/prompt/model/capUsd/spend are dispatch-time inputs
  // `target.cancel` never reads (only id/accountId/role/repoId/pr
  // matter for stopping/releasing an already-admitted run) --
  // placeholders, since `cancelRun` never had the originals.
  //
  // PR #85 fix round item 4: `repoId`/`pr` come from the PERSISTED
  // dispatch-time columns on `agent_runs` itself, never reconstructed
  // via a `work_items`/`repos` join -- that join can come back NULL (a
  // deleted repo) or simply disagree with what dispatch actually used (a
  // `work_items.gh_number` edited afterwards).
  const run: ExecutionRun = {
    id: runId,
    accountId: principal.accountId,
    role: row.role,
    product: row.product ?? "team",
    repoId: row.dispatch_repo_id ?? undefined,
    pr: row.dispatch_pr_number ? Number(row.dispatch_pr_number) : undefined,
    roleCard: "",
    prompt: "",
    model: "",
    capUsd: 0,
    spend: { plan: "starter" },
  };

  // Only attempt the compare-and-set write when `cancelled` is
  // reachable from the row's current status. Any other terminal state
  // -- including a prior `cancelled` -- is left as-is (C10: "On a run
  // that has already finished, it writes nothing and returns the run's
  // actual terminal status"), which is also what makes a repeat call
  // on the SAME run idempotent.
  //
  // PR #85 fix round item 4 (CWE-636/672): this write happens BEFORE any
  // target resolution/cancellation below, and is the run's one durable
  // commit for this call -- nothing after this point may throw without
  // having already committed it. An unresolvable/unregistered mode, or
  // the resolved target's own `cancel` throwing, must never leave the
  // run stuck in a non-terminal state.
  let status: RunStatus = row.status;
  if (isLegalRunTransition(row.status, "cancelled")) {
    const write = await writeRunStatus(pool, { accountId: principal.accountId, runId, from: row.status, to: "cancelled" });
    status = write.updated ? "cancelled" : write.currentStatus ?? row.status;
  }

  // PR #85 fix round item 4 (CWE-636): NO
  // `COALESCE(execution_mode, 'sandbox')`. A NULL or unregistered mode --
  // a legacy row from before this column existed, or a genuinely
  // unresolvable one -- fails closed: never guess a target. `target.cancel`
  // is also wrapped below (never let it throw after the commit above);
  // either way this falls back to a target-agnostic release.
  let target: ExecutionTarget | undefined;
  if (row.execution_mode) {
    try {
      target = resolveExecutionTarget(row.execution_mode, registry);
    } catch {
      // fx-swallow-ok: an unregistered or legacy execution mode is the expected answer here; it falls closed to the target-agnostic release below
      target = undefined;
    }
  }

  const totals: CancelResult = target
    ? await target.cancel(run).catch((err: unknown) => {
        reportError(err, { stage: "run.cancel_target" });
        return fallbackRelease(pool, principal.accountId, runId);
      })
    : await fallbackRelease(pool, principal.accountId, runId);

  return { status, settled_usd: totals.settled_usd, released_usd: totals.released_usd };
}

async function fetchRunRow(client: PoolClient, runId: string, accountId: string): Promise<RunRow | undefined> {
  const { rows } = await client.query<RunRow>(
    `SELECT ar.status,
            ar.role,
            r.product,
            ar.execution_mode,
            ar.dispatch_repo_id,
            ar.dispatch_pr_number::text AS dispatch_pr_number
       FROM agent_runs ar
       LEFT JOIN work_items wi ON wi.account_id = ar.account_id AND wi.id = ar.work_item_id
       LEFT JOIN repos r ON r.account_id = ar.account_id AND r.id = wi.repo_id
      WHERE ar.id = $1 AND ar.account_id = $2`,
    [runId, accountId],
  );
  return rows[0];
}

/**
 * PR #85 fix round item 4 (CWE-636/672): a target-agnostic fallback that
 * closes every open reservation for this run and reports the same
 * `{settled_usd, released_usd}` shape `ExecutionTarget.cancel` would,
 * WITHOUT resolving (or guessing) a target. Used when `execution_mode`
 * is unresolvable (no persisted identity) or the resolved target's own
 * `cancel` throws (e.g. an unresolvable sandbox identity for a legacy
 * executor row -- see targets/sandboxTarget.ts's own defensive fix).
 *
 * D#2 COMPUTE-SETTLE CS-2a: a compute row is SETTLED at its reserved amount
 * (ledger basis 'fallback'), never released -- the sandbox may have run and
 * nothing here can measure it. A model row is still released. It takes the
 * same per-budget advisory locks as the target's settle, in sorted order,
 * so whichever writer gets there first wins and the loser finds no open row.
 *
 * Deliberately not an `@fx/spend` import -- this file's own
 * import-boundary rule (test/importBoundary.test.ts) restricts that to
 * targets/sandboxTarget.ts only. This runs plain SQL against the
 * account-scoped tables every target's reservation lives in today,
 * regardless of which target actually dispatched it.
 */
async function fallbackRelease(pool: Pool, accountId: string, runId: string): Promise<CancelResult> {
  await withTenant(pool, accountId, async (client) => {
    const { rows: budgets } = await client.query<{ budget: string }>(
      `SELECT DISTINCT budget FROM spend_reservations WHERE account_id = $1 AND run_id = $2 AND state = 'open'`,
      [accountId, runId],
    );
    for (const budget of budgets.map((b) => b.budget).sort()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${accountId}:${budget}`]);
    }
    await client.query(
      `INSERT INTO ledger (account_id, kind, source, usd, run_id, budget, compute_basis)
       SELECT account_id, 'compute', 'sandbox', usd_reserved, run_id, budget, 'fallback' FROM spend_reservations
        WHERE account_id = $1 AND run_id = $2 AND state = 'open' AND budget <> 'model'
       ON CONFLICT (account_id, run_id, budget) WHERE reason IS NULL DO NOTHING`,
      [accountId, runId],
    );
    await client.query(
      `UPDATE spend_reservations SET state = CASE WHEN budget = 'model' THEN 'released' ELSE 'settled' END
       WHERE account_id = $1 AND run_id = $2 AND state = 'open'`,
      [accountId, runId],
    );
  });
  return withTenant(pool, accountId, async (client) => {
    const settled = await client.query<{ sum: string }>(
      `SELECT COALESCE(SUM(usd), 0)::text AS sum FROM ledger WHERE account_id = $1 AND run_id = $2`,
      [accountId, runId],
    );
    const released = await client.query<{ sum: string }>(
      `SELECT COALESCE(SUM(usd_reserved), 0)::text AS sum FROM spend_reservations
       WHERE account_id = $1 AND run_id = $2 AND state = 'released'`,
      [accountId, runId],
    );
    return { settled_usd: Number(settled.rows[0]!.sum), released_usd: Number(released.rows[0]!.sum) };
  });
}
