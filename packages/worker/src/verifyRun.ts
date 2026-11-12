import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { DEPLOY_VERIFIER_ROLE, isBrowserMethod, type BrowserMethod } from "@fulcrumaxe/runner-protocol";
import { overRepoDailyUsd, verifyStageRunKey } from "@fx/core/src/plan/proposalVerifyLimits.js";
import { fileBugItem } from "@fx/core/src/verify/bugItem.js";
import type { Journey } from "@fx/core/src/verify/journeys.js";
import { finishVerifyRow, readVerifyRow, startRunning, type FinishInput, type VerifyMethod, type VerifyReasonCode, type VerifyRow } from "@fx/core/src/verify/rows.js";
import { readVerifySettings } from "@fx/core/src/verify/settings.js";
import { cancelOpenOrders } from "@fx/core/src/verify/orders.js";
import { VERIFIER_WORKDIR, isRunnerMode, readExecutionMode, type StartAgentRunInput } from "@fx/runner";
import { reportError } from "@fx/telemetry";
import type { RunStarter } from "./preview.js";
import type { SeatResult } from "./seat.js";
import type { ReadyOutcome, VerifyStageDeps } from "./verifyStage.js";

/**
 * D#749 V3b: the verify stage's two hand-offs, the pieces `verifyStage.ts` calls once a row is ready and while it is running.
 *
 *  - `ready` (a deployed commit qualified for the row): the browser job needs a runner, so a repository that does not run work on one ends the row
 *    `unverified: no_browser` (never a weaker silent check). Otherwise the repository's daily cap (`overRepoDailyUsd` on its 'tester' side: this stage's runs only, against its own cap) holds the row `deploying` and the next tick asks again. Otherwise the seat is resolved and ONE tester job starts through the runner starter,
 *    role deploy-verifier, the checkout pinned to the merge commit (on the paired public repository for a two-plane repository), keyed `verify-stage:<row_id>` so a replay
 *    starts nothing. The row moves to `running` with the run id and the method the job was SIGNED with (`browser_method`, read back from the run, never from anything the job later reports).
 *  - `settle` (the row is running): the job's end is read. A job that ended without succeeding ends the row `unverified: run_failed`. A succeeded job's envelope goes through
 *    the pipeline's strict rules (injected: this package does not import it), which turn it into the row's outcome; a hollow pass is `unverified`. The outcome, the
 *    `verify_*` fact and, for a failed row, the one bug item are written in ONE transaction. A cannot-verify outcome files no bug item (it is not a product defect). The
 *    streak is derived from the finished rows (`readStreak`), so every outcome moves it by rule: a pass counts, a fail or an unverified row resets it. The neutral exceptions: `unverified: no_visible_journeys`, and a `verified` row that passed on standing journeys alone (no Spec-criterion journey passed), neither count nor reset.
 *
 * The pipeline decides everything here (R-597-1): nothing a page or a model wrote reaches a prompt, a label or a decision. This file writes verify rows, their facts, a
 * cancelled deploy order and the bug item, and imports no merge call site.
 */
const ENDED = new Set(["succeeded", "refused_spend", "failed", "timed_out", "killed_spend", "cancelled"]);

const PLAN_DATA_CODES: ReadonlySet<string> = new Set(["deploy_verify_unconfigured", "deploy_verify_run_over_daily"]);

export interface VerifyRunLimits {
  /** What one tester job may spend: its cap and its reservation. */
  runUsd: number;
  /** What the repository's tester runs may spend in a UTC day: the stage's OWN cap (`deployVerifyPerRepoDailyUsd`), counted over the tester's runs only; the shared cap and the claim verifier's and analyst's spend are not part of it. */
  perRepoDailyUsd: number;
}
/** What the pipeline's rules (`outcomeFromAnswer`) answer. */
export interface VerifyOutcome {
  input: FinishInput;
  failedJourneyIds: string[];
}

export interface VerifyRunDeps {
  /** The runner login's pool. */
  pool: Pool;
  /** A starter that leaves a queued runner run pending for a runner to claim (`queued: "accept"`). */
  starter: RunStarter;
  /** The tester's seat. Refused (no card, no model, no installation): the row waits and the refusal is reported. */
  resolveSeat: (request: { accountId: string; repoId: string; role: string; purpose: "deploy_verify"; capUsd: number }) => Promise<SeatResult>;
  /** The figures, read when needed (plan data in production). A throw fails closed: nothing starts. */
  limits: () => VerifyRunLimits;
  /** pipeline's `buildVerifyPrompt`. */
  prompt: (input: { baseUrl: string; mergeSha: string; deployedCommit: string; journeys: readonly Journey[] }) => string;
  /** The `verify.browser_driver` setting of the repository (and the runner), when one is stored. Not given, or null: the default method. A throw fails closed: nothing starts. */
  browserDriver?: (input: { accountId: string; repoId: string }) => Promise<string | null>;
  /** pipeline's `outcomeFromAnswer`, given the repository's configured test account and the row's signed method (the account is judged from the envelope's `signed_in_as`, written by the verify server on a playwright runner only). */
  outcome: (journeys: readonly Journey[], raw: unknown, context: { testAccountLabel: string | null; method: VerifyMethod | null }) => VerifyOutcome;
}

/**
 * D#749 V2c-1: how the tester drives its browser. The runner's own Playwright browser unless the repository or the runner says `verify.browser_driver = "chrome"` (set only after the owner's smoke run
 * shows the CLI attaches Claude in Chrome with the runner's token). Anything else, an unreadable value included, is the default. The choice is the cloud's: it goes into the job as `browser_method`,
 * and the claim then hands the job only to a runner holding that method's capability.
 */
export const chooseBrowserMethod = (driver: string | null | undefined): BrowserMethod => (driver === "chrome" ? "chrome_runner" : "playwright_runner");

/** The repository's `browser_driver` setting (migration 1007), read under its tenant. Null when the repository has no settings row. */
export async function readBrowserDriver(pool: Pool, q: { accountId: string; repoId: string }): Promise<string | null> {
  return withTenant(pool, q.accountId, async (client) => {
    const { rows } = await client.query<{ browser_driver: string }>("SELECT browser_driver FROM verify_settings WHERE account_id = $1 AND repo_id = $2", [q.accountId, q.repoId]);
    return rows[0]?.browser_driver ?? null;
  });
}

const requestHash = (row: VerifyRow, deployed: string): string => createHash("sha256").update(JSON.stringify(["verify-stage", row.id, row.merge_sha, deployed])).digest("hex");

export function createVerifyRun(deps: VerifyRunDeps): Required<Pick<VerifyStageDeps, "ready" | "settle">> {
  const tenant = <T>(accountId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> => withTenant(deps.pool, accountId, fn);
  /** `<repo>:<UTC day>` keys of today's daily-cap holds already reported. Keys of earlier days are dropped on the next report, so the set stays as small as one day's held repositories. */
  const reportedDailyHold = new Set<string>();

  /** Ends a deploying row `unverified` and calls off its deploy order; true when this call ended it. */
  async function endUnverified(accountId: string, rowId: string, reason: VerifyReasonCode): Promise<boolean> {
    return tenant(accountId, async (client) => {
      const r = await finishVerifyRow(client, accountId, rowId, { status: "unverified", reason });
      if (r.moved) await cancelOpenOrders(client, accountId, [rowId]);
      return r.moved;
    });
  }

  const ready: Required<Pick<VerifyStageDeps, "ready">>["ready"] = async ({ accountId, repoId, row, deployedCommit }): Promise<ReadyOutcome> => {
    const mode = await readExecutionMode(deps.pool, accountId, repoId);
    if (!isRunnerMode(mode)) {
      await endUnverified(accountId, row.id, "no_browser");
      return "ended";
    }
    const key = verifyStageRunKey(row.id);
    let limits: VerifyRunLimits;
    try {
      limits = deps.limits();
    } catch (err) {
      // Fail closed: figures that cannot be read start nothing; the next tick asks again.
        // Only the plan data's named refusals travel as their own code, so the report says which figure is wrong; any other failure keeps the error's own code.
      reportError(err, { stage: "verify_run.limits", code: err instanceof Error && PLAN_DATA_CODES.has(err.message) ? err.message : undefined });
      return "held";
    }
    const state = await tenant(accountId, async (client) => {
      const current = await readVerifyRow(client, accountId, row.id);
      const started = await client.query("SELECT 1 FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2", [accountId, key]);
      // A job that already started is answered, not held back by the cap it was counted in.
      const over = started.rows.length > 0 ? false : await overRepoDailyUsd(client, accountId, repoId, limits.runUsd, limits.perRepoDailyUsd, "tester");
      const settings = await readVerifySettings(client, repoId);
      const repo = await client.query<{ gh_owner: string | null; gh_name: string | null }>("SELECT gh_owner, gh_name FROM repos WHERE id = $1 AND account_id = $2", [repoId, accountId]);
      const pairing = await client.query<{ code_repo: string }>("SELECT code_repo FROM repo_pairing WHERE repo_id = $1 AND account_id = $2", [repoId, accountId]);
      return { current, over, settings, repo: repo.rows[0], codeRepo: pairing.rows[0]?.code_repo ?? null };
    });
    // The row moved on (ended by a switch-off, or started by another pass): nothing to do.
    if (state.current === null || state.current.status !== "deploying") return "held";
    if (state.over) {
      // Held by the stage's own daily cap: say so once per repository per UTC day (the same report channel as the other holds), so a row waiting on it is never silent.
      // The day is the process clock's UTC day (the cap's own day is the database's UTC day; the two differ only by clock skew around midnight, which costs at most one repeated log line).
      const today = new Date().toISOString().slice(0, 10);
      const day = `${repoId}:${today}`;
      if (!reportedDailyHold.has(day)) {
        for (const k of reportedDailyHold) if (!k.endsWith(`:${today}`)) reportedDailyHold.delete(k);
        reportedDailyHold.add(day);
        reportError(new Error("deploy_verify_daily_cap"), { stage: "verify_run.daily_cap", code: "deploy_verify_daily_cap" });
      }
      return "held";
    }
    const [codeOwner, codeName] = state.codeRepo === null ? [] : state.codeRepo.split("/");
    // The merge commit lives on the public repository when the repository is paired with one.
    const clone = codeOwner && codeName ? { owner: codeOwner, name: codeName } : state.repo?.gh_owner && state.repo.gh_name ? { owner: state.repo.gh_owner, name: state.repo.gh_name } : null;
    if (clone === null || state.settings.baseUrl === null) return "held";

    // The prompt refuses a journey whose id or source is not ours. The row's journeys never change, so that refusal never clears: the row ends rather than being tried every tick.
    let prompt: string;
    try {
      prompt = deps.prompt({ baseUrl: state.settings.baseUrl, mergeSha: row.merge_sha, deployedCommit, journeys: row.journeys });
    } catch (err) {
      reportError(err, { stage: "verify_run.prompt" });
      await endUnverified(accountId, row.id, "run_failed");
      return "ended";
    }

    let browserMethod: BrowserMethod;
    try {
      browserMethod = chooseBrowserMethod(deps.browserDriver === undefined ? null : await deps.browserDriver({ accountId, repoId }));
    } catch (err) {
      reportError(err, { stage: "verify_run.browser_driver" });
      return "held";
    }

    const seat = await deps.resolveSeat({ accountId, repoId, role: DEPLOY_VERIFIER_ROLE, purpose: "deploy_verify", capUsd: limits.runUsd });
    if (!seat.ok) {
      reportError(new Error(seat.reason), { stage: "verify_run.seat", code: seat.reason });
      return "held";
    }
    if (seat.seat.capUsd !== limits.runUsd || seat.seat.spend.estimateModelUsd !== limits.runUsd || seat.seat.spend.perSpawnCapUsd !== limits.runUsd) return "held";

    const input: StartAgentRunInput = {
      ...seat.seat,
      accountId,
      repoId,
      role: DEPLOY_VERIFIER_ROLE,
      browserMethod,
      product: "team",
      expectedExecutionMode: mode,
      prompt,
      workdir: VERIFIER_WORKDIR,
      cloneRepo: { owner: clone.owner, name: clone.name, sha: row.merge_sha },
      headSha: row.merge_sha,
      idempotency: { key, requestHash: requestHash(row, deployedCommit) },
    };
    const started = await deps.starter.start(input);
    if (started.refused !== undefined) {
      // Refused at admit: the run row exists and nothing was spent; the row cannot be verified.
      await endUnverified(accountId, row.id, "run_failed");
      return "ended";
    }
    // The row's method is read back from the job the run was signed with: the value the claim gated on and the tool digest covers. Nothing a run reports can reach it. A run without a valid one cannot be
    // checked (the issuer never signs such a job), so the row ends rather than carry a guess.
    const signed = await tenant(accountId, (client) =>
      client.query<{ method: string | null }>("SELECT job_signed #>> '{job,browser_method}' AS method FROM agent_runs WHERE account_id = $1 AND id = $2 AND role = $3 AND head_sha = $4", [accountId, started.runId, DEPLOY_VERIFIER_ROLE, row.merge_sha]),
    );
    const signedMethod = signed.rows[0]?.method;
    if (!isBrowserMethod(signedMethod)) {
      await endUnverified(accountId, row.id, "run_failed");
      return "ended";
    }
    await tenant(accountId, (client) => startRunning(client, accountId, row.id, { method: signedMethod, deployedCommit, runId: started.runId }));
    return "started";
  };

  const settle: Required<Pick<VerifyStageDeps, "settle">>["settle"] = async ({ accountId, row }) => {
    return tenant(accountId, async (client) => {
      const fresh = await readVerifyRow(client, accountId, row.id);
      if (fresh === null || fresh.status !== "running") return fresh === null ? "waiting" : "settled";
      const run = fresh.run_id === null ? undefined : (await client.query<{ status: string; envelope: unknown }>("SELECT status, envelope FROM agent_runs WHERE account_id = $1 AND id = $2 AND role = $3 AND head_sha = $4", [accountId, fresh.run_id, DEPLOY_VERIFIER_ROLE, fresh.merge_sha])).rows[0];
      let input: FinishInput;
      let failed: string[] = [];
      if (run === undefined || (ENDED.has(run.status) && run.status !== "succeeded")) {
        input = { status: "unverified", reason: "run_failed" };
      } else if (run.status !== "succeeded") {
        return "waiting";
      } else {
        const outcome = deps.outcome(fresh.journeys, run.envelope, { testAccountLabel: (await readVerifySettings(client, fresh.repo_id)).testAccountLabel, method: fresh.method });
        input = outcome.input;
        failed = outcome.failedJourneyIds;
      }
      const done = await finishVerifyRow(client, accountId, row.id, input);
      if (!done.moved) return "settled";
      if (input.status === "failed") await fileBugItem(client, accountId, row.id, failed);
      return "settled";
    });
  };

  return { ready, settle };
}
