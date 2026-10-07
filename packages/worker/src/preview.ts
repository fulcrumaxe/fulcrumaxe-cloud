import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { reportError } from "@fx/telemetry";
import { PREVIEW_WORKDIR, type StartAgentRunInput } from "@fx/runner";
import { RunActionInputError, RunActionRefusedError, RunActionUnavailableError, type PerformResult } from "./runActions.js";

/**
 * D#2 H17c-2b: the worker side of the onboarding preview. `performStartPreview`
 * turns a claimed `start_preview` action into one capped, read-only run on the
 * customer's model key.
 *
 * It needs three pieces that are not on main yet, all injected and all null in
 * the production composition root until their owners land (TL ruling 09-30):
 *   - `seats`     (S1): H14c-3-2d-2's resolveRunSeat, for a preview seat;
 *   - `starter`   (S2): H14c-3-3's production run start, idempotent on a key;
 *   - `promptFor`: pipeline's buildPreviewPrompt (this package does not depend on
 *     @fx/pipeline and this change takes no new dependency).
 * While any is missing `previewReady()` is false, a request is refused before
 * anything is written, and a `start_preview` claimed anyway settles `refused`
 * with its preview voided, so the customer's one preview is not used up.
 *
 * Authority: the action id is the only input; who it runs as comes from
 * `run_action_perform_principal` (a live lease, a session principal). Every check
 * that matters is made again here: the request service's are only early and kind.
 *
 * LOCK ORDER (R-ATOMIC). The preview row is linked to its run by an UPDATE that
 * runs INSIDE the run's create transaction (the runner's `inCreateTransaction`
 * seam), on another connection. So this module must never hold a row lock on the
 * preview while the run starts: that UPDATE would wait on us and we on the start
 * (a deadlock). Performers are instead serialised by one advisory lock (a transaction
 * lock on its own connection), taken first and held until the start has ADMITTED
 * the run (its compute reservation is committed: `afterAdmit`) or has failed. That
 * is the same lock the platform-wide day cap is read and spent under, so two starts
 * cannot both pass the cap, and a slow launch after admit holds nobody. The preview row is read without FOR UPDATE; the link
 * UPDATE's `WHERE state = 'requested' AND run_id IS NULL` is the guard (a row
 * moved by anyone else is not linked, and the create rolls back with it).
 * Order: advisory lock, read and validate, then start (run row, claim and link in
 * one transaction on the start's own connection).
 */

/** The role card the preview runs as (Q-17c-1: the PM's card triages and writes Specs). */
export const PREVIEW_ROLE = "project-manager";
/** Most the preview may spend on the customer's model key. Pinned to core's PREVIEW_MODEL_CAP_USD by test. */
export const PREVIEW_MODEL_CAP_USD = 20;
/**
 * Longest an agent may run in a preview. A run's stream is read by the invocation that started it (kept alive by
 * waitUntil, at most the workflow routes' 800 s), so a preview must end by its own limit inside that window, with room
 * for the sandbox create and the start window (3 minutes) before the clock starts. 9 minutes plus the launch fits;
 * a longer preview would outlive its stream reader. A preview takes no extensions. Ordinary runs are unchanged until
 * the follower owns the stream (PREVIEW-STREAM-REATTACH).
 */
export const PREVIEW_MAX_RUN_MS = 9 * 60_000;
/** Most sandbox compute one preview may reserve. Pinned to core's PREVIEW_COMPUTE_CAP_USD by test. */
export const PREVIEW_COMPUTE_CAP_USD = 1;
/** Preview compute reserved across all accounts in a UTC day before new starts are refused. Pinned to core's by test. */
export const PREVIEW_DAILY_COMPUTE_CAP_USD = 10;

/** The seat refusals (H14c-3-2d's fixed SeatRefusal enum): a seat source answers with one of these and never free text. */
export const PREVIEW_SEAT_REFUSALS = [
  "unknown_role",
  "no_card",
  "no_repo",
  "no_installation",
  "installation_not_writable",
  "no_model",
  "model_budget_unset",
  "limits_exceed_sandbox",
  "account_not_found",
] as const;
/**
 * Every value this module ever writes to `onboarding_previews.void_reason`. The column only checks a
 * code shape, so this closed list is the real set; a test pins it. A seat reason outside
 * PREVIEW_SEAT_REFUSALS is recorded as `seat_refused`.
 */
export const PREVIEW_VOID_REASONS = ["preview_unavailable", "preview_capacity", "seat_over_cap", "seat_refused", "start_failed", "precheck_failed", "spend_refused", ...PREVIEW_SEAT_REFUSALS] as const;
export type PreviewVoidReason = (typeof PREVIEW_VOID_REASONS)[number];

const SEAT_REFUSALS: readonly string[] = PREVIEW_SEAT_REFUSALS;
/** A seat source's reason as the closed value we record: its own enum member, else `seat_refused`. */
const seatVoidReason = (reason: string): PreviewVoidReason => (SEAT_REFUSALS.includes(reason) ? (reason as PreviewVoidReason) : "seat_refused");

/** What a preview seat is: the run configuration minus what the performer supplies itself. */
export type PreviewSeatConfig = Omit<StartAgentRunInput, "accountId" | "role" | "workItemId" | "prompt" | "idempotency" | "inCreateTransaction"> & {
  /** Per-run limits (C56); opaque here, passed through to the run. */
  limits: Readonly<Record<string, number>>;
  /** The sandbox's own timeout, above every limit the run can reach. */
  timeoutMs: number;
};
/** The seat refusal is a fixed lower-case enum (it becomes the action's error code and the preview's void reason). */
export type PreviewSeatResult = { ok: true; seat: PreviewSeatConfig } | { ok: false; reason: string };

/** S1. Real piece: resolveRunSeat with `{ accountId, role: PREVIEW_ROLE, repoId, purpose: "preview" }`. */
export interface PreviewSeatSource {
  previewSeat(accountId: string, repoId: string): Promise<PreviewSeatResult>;
}
/**
 * S2. Real piece: the production run start. Must be idempotent on `input.idempotency.key`, and MUST
 * pass `input.inCreateTransaction` to `startAgentRun` unchanged: that is how the preview is linked to
 * its run in the run's own create transaction (a starter that drops it leaves the run unlinked, and
 * the performer fails loudly rather than report a started preview).
 */
export interface RunStarter {
  start(input: StartAgentRunInput): Promise<{
    runId: string;
    /** Set when the run was refused at admit (startAgentRun's `refused_spend`): the run row exists and is linked, but nothing was spent. It holds the target's own closed reason code (D#6 C12 A4). */
    refused?: string;
  }>;
}

export interface PreviewModuleDeps {
  seats: PreviewSeatSource | null;
  starter: RunStarter | null;
  /** pipeline's buildPreviewPrompt; it throws on a name that is not a GitHub name. */
  promptFor: ((repo: { owner: string; name: string; workdir?: string }) => string) | null;
  /** The operator decision for an account (operatorMode(env, id).active), recorded in the audit row of a started preview. Absent: customer key. */
  isOperatorAccount?: (accountId: string) => boolean;
}

export interface PreviewFacade {
  /** True once a seat source, a run starter and the prompt builder are all wired. A plain answer; no pool is reachable from it. */
  previewReady(): boolean;
  /**
   * Performs a CLAIMED `start_preview` action. Takes the action id and nothing else. Outcome
   * `{ preview_id, run_id }`; a replay after the run started returns the same and starts nothing.
   * A refusal, a start that throws before any run exists, a seat or cap read that throws, and a run
   * refused at admit all VOID the preview (they spent nothing, so the customer's one preview is not used). Refusals: principal_not_authorised, kind_mismatch,
   * target_not_found, preview_not_requested, or any PREVIEW_VOID_REASONS value.
   */
  performStartPreview(actionId: string): Promise<PerformResult>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refused = (errorCode: string): PerformResult => ({ result: "refused", errorCode });

/** The link UPDATE found the preview no longer `requested` (or already linked): the run's create rolls back with it. */
export class PreviewLinkLostError extends Error {
  constructor() {
    super("onboarding preview is no longer requested");
    this.name = "PreviewLinkLostError";
  }
}

function isConnectionFailure(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, syscall } = err as { code?: unknown; syscall?: unknown };
  if (typeof syscall === "string") return true;
  return typeof code === "string" && (/^(08|28|53|57P|3D)/.test(code) || /^E[A-Z]+$/.test(code));
}

/** Fixed errors only: a driver message can carry a host, a user or statement values. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof RunActionInputError) throw err;
    const code = (err as { code?: unknown } | null)?.code;
    if (isConnectionFailure(err)) throw new RunActionUnavailableError();
    if (typeof code === "string" && ["42501", "P0002", "22023", "55000", "23514"].includes(code)) throw new RunActionRefusedError(code);
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) throw new RunActionUnavailableError();
    throw err;
  }
}

/**
 * One performer at a time inside this process: the critical section below holds a pooled
 * connection while the run starts (which takes others), so waiters must not hold one too.
 * Across processes the database's advisory lock does the same job.
 */
let tail: Promise<unknown> = Promise.resolve();
/**
 * `fn` gets a `release`: the next performer in this process may start once `fn` calls it, or once `fn` settles,
 * whichever is first. A performer calls it when the shared cap is spent (the run's reservation exists), so a slow
 * launch after that does not hold the queue.
 */
function exclusive<T>(fn: (release: () => void) => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = tail.then(() => fn(release), () => fn(release));
  tail = gate;
  void run.then(release, release);
  return run;
}

/** The platform-wide day cap's lock key (see LOCK ORDER). */
const DAILY_COMPUTE_LOCK = "fx:preview_daily_compute";

/**
 * Takes the day-cap lock as a TRANSACTION-scoped advisory lock on its own connection, so it is not tied to the
 * performer's transaction (which stays open for the whole start). The runner login goes through a transaction-mode
 * pooler, where a session lock would stick to one server backend and its unlock could land on another: so the lock is
 * taken inside BEGIN and ends with COMMIT (or ROLLBACK), which the pooler keeps on one backend. `release` ends it and
 * returns the connection; safe to call twice.
 */
export async function takeDailyLock(pool: Pick<Pool, "connect">): Promise<{ release: () => Promise<void> }> {
  const lockClient = await pool.connect();
  try {
    await lockClient.query("BEGIN");
    await lockClient.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [DAILY_COMPUTE_LOCK]);
  } catch (err) {
    await lockClient.query("ROLLBACK").catch((rollbackErr: unknown) => reportError(rollbackErr, { stage: "preview.lock_rollback" }));
    lockClient.release(err instanceof Error ? err : new Error("lock failed"));
    throw err;
  }
  let released: Promise<void> | undefined;
  return {
    release: () =>
      (released ??= (async () => {
        try {
          await lockClient.query("COMMIT");
          lockClient.release();
        } catch (err) {
          // A transaction that cannot end cleanly goes with its connection: destroy it rather than return it to the pool.
          reportError(err, { stage: "preview.unlock" });
          lockClient.release(err instanceof Error ? err : new Error("unlock failed"));
        }
      })()),
  };
}

interface PrincipalRow {
  allowed: boolean;
  account_id: string;
  kind: string;
  target_id: string;
  principal_kind: string;
  user_id: string | null;
}
interface PreviewRow {
  id: string;
  state: string;
  run_id: string | null;
  repo_id: string;
  void_reason: string | null;
}

/** The inside of the critical section: a result to settle, or the start's own error to throw once the transaction has committed the void. */
type Attempt = { perform: PerformResult } | { thrown: unknown };

/** Package-internal: `runnerPool` is the runner login's pool and is captured here, never exposed. */
export function createPreviewModule(runnerPool: Pool, deps: PreviewModuleDeps): PreviewFacade {
  const ready = (): boolean => deps.seats !== null && deps.starter !== null && deps.promptFor !== null;

  /**
   * Moves a still-requested preview to void; a row that moved on (started) is left alone. With `runId` it
   * instead voids the preview linked to that run (a run refused at admit), keeping the link.
   */
  async function voidPreview(client: PoolClient, previewId: string, reason: PreviewVoidReason, runId: string | null = null): Promise<void> {
    await client.query(
      "UPDATE onboarding_previews SET state = 'void', void_reason = $2 WHERE id = $1 AND ((state = 'requested' AND run_id IS NULL AND $3::uuid IS NULL) OR (state = 'running' AND run_id = $3::uuid))",
      [previewId, reason, runId],
    );
  }

  async function perform(actionId: string): Promise<PerformResult> {
    if (typeof actionId !== "string" || !UUID_RE.test(actionId)) throw new RunActionInputError();
    const attempt = await exclusive(async (release): Promise<Attempt> => {
      // Inside the queue, so the lease and the principal are checked when this actually runs.
      const { rows } = await runnerPool.query<PrincipalRow>("SELECT * FROM run_action_perform_principal($1::uuid)", [actionId]);
      const who = rows[0];
      if (!who || !who.allowed || who.user_id === null || who.principal_kind !== "session") return { perform: refused("principal_not_authorised") };
      if (who.kind !== "start_preview") return { perform: refused("kind_mismatch") };
      const { account_id: accountId, user_id: userId, target_id: previewId } = who;

      return withTenant(runnerPool, accountId, userId, async (client): Promise<Attempt> => {
        // See LOCK ORDER above: the one lock held across the cap read and the reservation, and it is not on the preview
        // row. It is a session lock on its own connection, let go as soon as the start has admitted (or failed), so a
        // slow launch afterwards blocks nobody; this transaction stays open for the start as it always did.
        const daily = await takeDailyLock(runnerPool);
        try {
          return await startUnderLock();
        } finally {
          release();
          await daily.release();
        }

        async function startUnderLock(): Promise<Attempt> {

        const found = await client.query<PreviewRow>("SELECT id, state, run_id, repo_id, void_reason FROM onboarding_previews WHERE id = $1 AND account_id = $2", [previewId, accountId]);
        const preview = found.rows[0];
        if (!preview) return { perform: refused("target_not_found") };
        // A preview voided after its run was refused at admit: repeat that refusal, never report a started preview.
        if (preview.state === "void" && preview.run_id !== null) return { perform: refused(preview.void_reason ?? "spend_refused") };
        if (preview.run_id !== null) return { perform: { result: "done", outcome: { preview_id: preview.id, run_id: preview.run_id } } };
        if (preview.state !== "requested") return { perform: refused("preview_not_requested") };

        /** Voids the preview (it never started a run, so the customer's one preview is not used) and refuses. */
        const voidAndRefuse = async (reason: PreviewVoidReason): Promise<Attempt> => {
          await voidPreview(client, preview.id, reason);
          return { perform: refused(reason) };
        };

        if (!ready()) return voidAndRefuse("preview_unavailable");

        // The platform-wide day cap is read here and spent by the start below; the lock above is held until this
        // commits (the run, and so its compute reservation, exists by then), so two starts cannot both pass.
        // A read that throws (not a refusal) spent nothing either, and would otherwise leave the preview
        // 'requested' and block a new request: void it and rethrow. The cap read is inside a savepoint so a
        // database error does not leave this transaction aborted before the void.
        const failedBeforeStart = async (thrown: unknown, savepoint = false): Promise<Attempt> => {
          if (savepoint) await client.query("ROLLBACK TO SAVEPOINT cap_read").catch(() => undefined);
          await voidPreview(client, preview.id, "precheck_failed").catch(() => undefined);
          return { thrown };
        };
        let used: { rows: { v: string }[] };
        try {
          await client.query("SAVEPOINT cap_read");
          used = await client.query<{ v: string }>("SELECT preview_daily_compute_usd() AS v");
          await client.query("RELEASE SAVEPOINT cap_read");
        } catch (thrown) {
          // Reported here: guarded() collapses the rethrown value to a fixed action error, so this is the only place its class is seen.
          reportError(thrown, { stage: "preview.cap_read" });
          return failedBeforeStart(thrown, true);
        }
        if (!(Number(used.rows[0]?.v) < PREVIEW_DAILY_COMPUTE_CAP_USD)) return voidAndRefuse("preview_capacity");

        let seat: PreviewSeatResult;
        try {
          seat = await deps.seats!.previewSeat(accountId, preview.repo_id);
        } catch (thrown) {
          // Reported here: guarded() collapses the rethrown value to a fixed action error, so this is the only place its class is seen.
          reportError(thrown, { stage: "preview.seat" });
          return failedBeforeStart(thrown);
        }
        if (!seat.ok) return voidAndRefuse(seatVoidReason(seat.reason));
        const spend = seat.seat.spend;
        const compute = spend.estimateComputeUsd ?? 0;
        const model = spend.estimateModelUsd ?? 0;
        if (!(compute >= 0 && compute <= PREVIEW_COMPUTE_CAP_USD) || !(model >= 0 && model <= PREVIEW_MODEL_CAP_USD) || spend.purpose !== "preview") {
          return voidAndRefuse("seat_over_cap");
        }

        const repo = await client.query<{ gh_owner: string | null; gh_name: string | null }>("SELECT gh_owner, gh_name FROM repos WHERE id = $1 AND account_id = $2", [
          preview.repo_id,
          accountId,
        ]);
        const names = repo.rows[0];
        if (!names?.gh_owner || !names.gh_name) return voidAndRefuse("no_repo");
        // Only the prompt builder is guarded: a database error in the void must surface, not be retried on an aborted transaction.
        let prompt: string | null;
        try {
          prompt = deps.promptFor!({ owner: names.gh_owner, name: names.gh_name, workdir: PREVIEW_WORKDIR });
        } catch (err) {
          reportError(err, { stage: "preview.prompt" });
          prompt = null;
        }
        if (prompt === null) return voidAndRefuse("no_repo");

        const input: StartAgentRunInput = {
          ...seat.seat,
          accountId,
          repoId: preview.repo_id,
          role: PREVIEW_ROLE,
          product: "team",
          prompt,
          // The runner clones this repository (shallow, default branch) into the workdir before the agent starts.
          workdir: PREVIEW_WORKDIR,
          cloneRepo: { owner: names.gh_owner, name: names.gh_name },
          capUsd: PREVIEW_MODEL_CAP_USD,
          spend: { ...spend, purpose: "preview" },
          // The cap is spent once `admit` has committed the reservation: from there on a slow launch holds nobody.
          afterAdmit: () => {
            release();
            void daily.release();
          },
          idempotency: { key: `run-action:${actionId}`, requestHash: createHash("sha256").update(`start_preview:${preview.id}`).digest("hex") },
          // R-ATOMIC: the run row, its idempotency claim and this link commit together, before any sandbox exists.
          // The shape CHECK ties run_id to state 'running' and started_at, so they move together too.
          inCreateTransaction: async (create, runId) => {
            const linked = await create.query(
              "UPDATE onboarding_previews SET state = 'running', run_id = $2, started_at = now() WHERE id = $1 AND account_id = $3 AND state = 'requested' AND run_id IS NULL",
              [preview.id, runId, accountId],
            );
            if (linked.rowCount !== 1) throw new PreviewLinkLostError();
          },
        };

        let runId: string;
        let refusedAtAdmit = false;
        try {
          const started = await deps.starter!.start(input);
          runId = started.runId;
          refusedAtAdmit = started.refused !== undefined;
        } catch (thrown) {
          // A start that threw before its create committed left no run and no link: the preview is still
          // requested, and it spent nothing, so void it. One that threw after the create (the run exists
          // and is linked) cannot be voided; the run's own outcome is what the customer sees.
          // Reported here: guarded() collapses the rethrown value to a fixed action error, so this is the only place its class is seen.
          reportError(thrown, { stage: "preview.start" });
          await voidPreview(client, preview.id, "start_failed").catch(() => undefined);
          return { thrown };
        }

        const after = await client.query<{ state: string; run_id: string | null }>("SELECT state, run_id FROM onboarding_previews WHERE id = $1 AND account_id = $2", [
          preview.id,
          accountId,
        ]);
        if (after.rows[0]?.state !== "running" || after.rows[0].run_id !== runId) {
          // The starter returned without linking the preview (it dropped inCreateTransaction): never report a started preview.
          return { thrown: new PreviewLinkLostError() };
        }
        if (refusedAtAdmit) {
          // Admit refused the spend: nothing was spent, so free the customer's one live slot. The run stays linked.
          await voidPreview(client, preview.id, "spend_refused", runId);
          return { perform: refused("spend_refused") };
        }
        // Which model path this preview ran on, as one audit row (ids and the enum only). The definer reads the
        // account from the started preview row, so the mode is the only thing this call supplies.
        await client.query("SELECT onboarding_preview_record_mode($1::uuid, $2::text)", [
          preview.id,
          deps.isOperatorAccount?.(accountId) === true ? "operator_subscription" : "customer_key",
        ]);
        return { perform: { result: "done", outcome: { preview_id: preview.id, run_id: runId } } };
        }
      });
    });
    if ("thrown" in attempt) throw attempt.thrown;
    return attempt.perform;
  }

  return {
    previewReady: ready,
    performStartPreview: (actionId) => guarded(() => perform(actionId)),
  };
}
