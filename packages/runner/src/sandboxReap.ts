import type { Pool } from "pg";
import type { ExecutionRun } from "./executionTarget.js";
import { parseSandboxName, sandboxNameFor } from "./sandboxNaming.js";
import type { SandboxHandle, SandboxPort } from "./sandboxPort.js";
import { DEFAULT_SDK_CALL_TIMEOUT_MS } from "./vercelSandboxPort.js";

/**
 * D#2 SANDBOX-REAPER-1a (C81, amended by C82): the end-of-item pass. An executor sandbox (`ex-<account>-<repo>-<issue>`) is
 * persistent and keeps a snapshot; this pass deletes it, snapshot included, once EVERY work item that shares the name has ended.
 * Names come only from the database: `sandbox_reap_candidates_terminal` (0731) returns names that run rows recorded and whose
 * guards hold (no live run, no queued or leased run action, every sharing work item terminal, no unexpired claim; compute settled
 * for a delete). The provider's list only counts orphans, never picks a target. Before any provider call the name is re-derived
 * from the run row and a mismatch refused. A delete is claim (database) -> provider delete (no transaction open) -> done, and
 * the claim re-checks every guard. Called only by the worker facade `sweepSandboxReap`.
 *
 * REAPER-1b adds the 1-day safety net (`pass: "ephemeral"`): an `rn-` sandbox whose run ended at least a day ago and whose compute is
 * SETTLED (`sandbox_reap_candidates_ephemeral`, 0760). One whose settle is still owed is never deleted, because the settle needs the
 * stopped sandbox to measure it; it is reported (`sandbox_unsettled_stale`). It also adds the inventory (`sandboxInventory`): the
 * provider's list joined to run rows, written per account by a definer, with the alerts of C81 criterion 15. The kill switch
 * (`off`) lives in the cron handler; this module has no `off` mode and is never called when the switch is off.
 */

/** Provider calls a candidate takes: a state read, then a delete (2 in all) or a stop (the stop path makes up to 3). */
const CALLS_STATE_AND_DELETE = 2;
const CALLS_STOP = 3;
/** The longest one candidate can take: a state read and the slowest action, each bounded by one SDK call timeout. */
export const REAP_CANDIDATE_WORST_CASE_MS = 5 * DEFAULT_SDK_CALL_TIMEOUT_MS;
const BATCH = 50;
const MAX_BATCHES = 20;
const ORPHAN_SCAN_MAX_PAGES = 10;
/** A run that ended less than this long ago may still be winding its sandbox down: a still-running sandbox is left alone. */
export const STRAY_RUNNING_GRACE_MS = 10 * 60_000;

export type SandboxReapPass = "terminal" | "ephemeral" | "idle";
export type SandboxReapMode = "dry_run" | "on";

export interface SweepSandboxReapInput {
  pass: SandboxReapPass;
  mode: SandboxReapMode;
  /** Epoch milliseconds; the clock the stray-running grace is measured against. */
  now: number;
  /** The name the previous pass stopped after, or null to start over. */
  cursor: string | null;
  maxCalls: number;
  timeBudgetMs: number;
}

export interface SweepSandboxReapResult {
  cursor: string | null;
  /** True when the pass reached the end of the list (the cursor is then null). */
  wrapped: boolean;
  callsUsed: number;
  deleted: number;
  stopped: number;
  skipped: number;
  candidates: { accountId: string; sandboxName: string; reason: string }[];
  /** Fixed codes, each at most once. */
  alerts: string[];
  /** Listed `ex-` sandboxes that no run row of this database mentions: counted, never touched. */
  orphans: number;
}

/** A pass this build does not run yet (idle: REAPER-2). */
export class SandboxReapNotSupportedError extends Error {
  readonly code = "not_supported";
  constructor(public readonly pass: string) {
    super(`sandbox reap pass "${pass}" is not supported`);
    this.name = "SandboxReapNotSupportedError";
  }
}

export interface SandboxReapDeps {
  /** The runner login's pool. */
  pool: Pool;
  port: SandboxPort;
  /** `SandboxTarget.stopStraySandbox`: false when a newer live run owns the name. */
  stopStray: (run: ExecutionRun) => Promise<boolean>;
  clock?: () => number;
  log?: (line: string) => void;
}

interface CandidateRow {
  account_id: string;
  run_id: string;
  sandbox_name: string;
  reason: string;
}

interface RunRow {
  id: string;
  account_id: string;
  role: string;
  sandbox_name: string | null;
  dispatch_repo_id: string | null;
  dispatch_pr_number: string | null;
  ended_at: Date | null;
}

export async function sweepSandboxReap(deps: SandboxReapDeps, input: SweepSandboxReapInput): Promise<SweepSandboxReapResult> {
  validate(input);
  if (input.pass === "idle") throw new SandboxReapNotSupportedError(input.pass);
  const listCandidates = input.pass === "terminal" ? "sandbox_reap_candidates_terminal" : "sandbox_reap_candidates_ephemeral";
  const clock = deps.clock ?? (() => performance.now());
  const log = deps.log ?? ((line: string) => console.log(line));
  const started = clock();
  const result: SweepSandboxReapResult = { cursor: input.cursor, wrapped: false, callsUsed: 0, deleted: 0, stopped: 0, skipped: 0, candidates: [], alerts: [], orphans: 0 };
  const alert = (code: string): void => {
    if (!result.alerts.includes(code)) result.alerts.push(code);
  };
  const left = (): number => input.maxCalls - result.callsUsed;
  // Stop starting a candidate once the time that is left may not cover one. The reserve is the worst case (a state read and an action,
  // each at its SDK timeout) but never more than half the budget: the reconcile job budget (60 s) is under that worst case, and
  // a reserve above the whole budget would stop the pass before its first candidate. A candidate cut off by the job's own deadline
  // loses nothing: its claim expires and the next pass finishes it.
  const reserveMs = Math.min(REAP_CANDIDATE_WORST_CASE_MS, input.timeBudgetMs / 2);
  const outOfTime = (): boolean => clock() - started + reserveMs > input.timeBudgetMs;

  let stop = false;
  for (let batch = 0; batch < MAX_BATCHES && !stop; batch++) {
    if (batch > 0 && outOfTime()) break;
    const { rows } = await deps.pool.query<CandidateRow>(`SELECT account_id, run_id, sandbox_name, reason FROM ${listCandidates}($1, $2)`, [BATCH, result.cursor]);
    for (const row of rows) {
      if (input.mode === "dry_run") {
        // Computes and reports; no provider call, no claim.
        log(JSON.stringify({ event: "sandbox_reap.candidate", name: row.sandbox_name, reason: row.reason, account_id: row.account_id }));
        result.candidates.push({ accountId: row.account_id, sandboxName: row.sandbox_name, reason: row.reason });
        result.cursor = row.sandbox_name;
        continue;
      }
      if (left() < CALLS_STATE_AND_DELETE || outOfTime()) {
        stop = true;
        break;
      }
      if (!(await reapOne(deps, input, row, result, alert, left))) {
        stop = true;
        break;
      }
      result.candidates.push({ accountId: row.account_id, sandboxName: row.sandbox_name, reason: row.reason });
      result.cursor = row.sandbox_name;
    }
    if (!stop && rows.length < BATCH) {
      result.wrapped = true;
      result.cursor = null;
      break;
    }
  }

  // What is left of the budget counts orphans (read only). A pass that used it all counts none.
  await countOrphans(deps, input.pass === "ephemeral" ? "rn-" : "ex-", result, alert, left);
  return result;
}

/** Handles one candidate; false when the budget cannot cover its next step (the candidate stays for the next pass). */
async function reapOne(deps: SandboxReapDeps, input: SweepSandboxReapInput, row: CandidateRow, result: SweepSandboxReapResult, alert: (code: string) => void, left: () => number): Promise<boolean> {
  const sql = (text: string, ...params: unknown[]) => deps.pool.query<{ v: string }>(text, params);
  const skip = (): true => {
    result.skipped++;
    return true;
  };
  const run = await readRun(deps.pool, row.account_id, row.run_id);
  // Tenant binding: the recorded name must be exactly what this run row derives, and the row must be the candidate's own.
  if (run === null || run.id !== row.run_id || run.accountId !== row.account_id || run.sandboxName !== row.sandbox_name || nameOf(run) !== row.sandbox_name) {
    if (run !== null) {
      alert("sandbox_name_mismatch");
      (deps.log ?? console.log)(JSON.stringify({ event: "sandbox_reap.name_mismatch", account_id: row.account_id, run_id: row.run_id }));
    }
    return skip();
  }
  const handle: SandboxHandle = { runId: run.id, sandboxName: row.sandbox_name };
  const state = deps.port.sandboxState ? await deps.port.sandboxState(handle) : "unknown";
  result.callsUsed++;
  if (state === "unknown") return skip();
  if (state === "running") {
    // Ended, yet the provider shows it running: stop it (the target's ownership test applies), delete it on a later pass.
    if (run.endedAt === null || input.now - run.endedAt.getTime() < STRAY_RUNNING_GRACE_MS) return skip();
    if (left() < CALLS_STOP) return false;
    result.callsUsed += CALLS_STOP;
    if (await deps.stopStray(run.run).catch(() => false)) result.stopped++;
    else result.skipped++;
    return true;
  }
  // A name whose compute settle is still owed (`terminal_unsettled`, `ephemeral_unsettled`) is never deleted: the settle needs the
  // stopped sandbox. An ephemeral one that is still at the provider a day after its run ended is reported; one the provider no
  // longer has is nothing to report.
  if (row.reason !== "terminal" && row.reason !== "ephemeral") {
    if (row.reason === "ephemeral_unsettled" && state === "stopped") alert("sandbox_unsettled_stale");
    return skip();
  }
  // "stopped" or "gone": claim (database), then the provider delete with no transaction open, then done.
  const claim = row.reason === "terminal" ? await sql("SELECT sandbox_reap_claim($1, 'terminal') AS v", row.sandbox_name) : await sql("SELECT sandbox_reap_claim_ephemeral($1) AS v", row.sandbox_name);
  if (claim.rows[0]?.v !== "claimed") return skip();
  if (state === "stopped") {
    result.callsUsed++;
    try {
      await deps.port.deleteSandbox(handle, { deleteSnapshots: true });
    } catch (err) {
      // fx-swallow-ok: the failure is classified by its status below (done, left to expire, or closed as skipped); none is dropped unseen
      const status = (err as { status?: unknown } | null)?.status;
      if (typeof status === "number" && (status === 429 || status >= 500)) return skip(); // the claim is left to expire; the next pass tries again
      if (status !== 404 && status !== 410) {
        await sql("SELECT sandbox_reap_done($1, 'skipped')", row.sandbox_name);
        return skip();
      }
    }
  }
  await sql("SELECT sandbox_reap_done($1, 'deleted')", row.sandbox_name);
  result.deleted++;
  return true;
}

/** Counts listed sandboxes under `prefix` (the pass's own) that no run row mentions. Reads at most the pages the remaining budget allows. */
async function countOrphans(deps: SandboxReapDeps, prefix: "ex-" | "rn-", result: SweepSandboxReapResult, alert: (code: string) => void, left: () => number): Promise<void> {
  if (!deps.port.listSandboxes) return;
  let cursor: string | undefined;
  for (let page = 0; page < ORPHAN_SCAN_MAX_PAGES && left() >= 1; page++) {
    let listed;
    try {
      listed = await deps.port.listSandboxes({ prefix, ...(cursor !== undefined && { cursor }) });
    } catch {
      // fx-swallow-ok: the orphan count is a report; a failed list changes no decision and the next pass counts again
      result.callsUsed++;
      return;
    }
    result.callsUsed++;
    // Ours by shape only: a listed name that is not of this pass's kind is neither counted nor sent to the database.
    const kind = prefix === "ex-" ? "executor" : "ephemeral";
    const names = listed.sandboxes.map((s) => s.name).filter((n) => parseSandboxName(n)?.kind === kind);
    for (let i = 0; i < names.length; i += 200) {
      const unknown = (await deps.pool.query<{ v: string[] }>("SELECT sandbox_reap_unknown_names($1::text[]) AS v", [names.slice(i, i + 200)])).rows[0]?.v ?? [];
      result.orphans += unknown.length;
    }
    if (listed.next === null) break;
    cursor = listed.next;
  }
  if (result.orphans > 0) alert("sandbox_orphan_found");
}

function validate(input: SweepSandboxReapInput): void {
  const problem =
    !["terminal", "ephemeral", "idle"].includes(input.pass) ? "pass must be terminal, ephemeral or idle"
    : !["dry_run", "on"].includes(input.mode) ? "mode must be dry_run or on"
    : !Number.isFinite(input.now) ? "now must be a number"
    : input.cursor !== null && !(typeof input.cursor === "string" && (input.pass === "ephemeral" ? /^rn-[A-Za-z0-9._-]{1,200}$/ : /^ex-[A-Za-z0-9._-]{1,200}$/).test(input.cursor)) ? "cursor must be null or a sandbox name of the pass's own kind"
    : !Number.isSafeInteger(input.maxCalls) || input.maxCalls < 0 || input.maxCalls > 10_000 ? "maxCalls must be an integer from 0 to 10000"
    : !Number.isFinite(input.timeBudgetMs) || input.timeBudgetMs <= 0 ? "timeBudgetMs must be positive"
    : undefined;
  if (problem !== undefined) throw new TypeError(`sweepSandboxReap: ${problem}`);
}

/** The name `sandboxNameFor` builds from the run row's own fields, or null when the row cannot name a sandbox. */
function nameOf(r: RunRead): string | null {
  try {
    return sandboxNameFor({ role: r.run.role, runId: r.run.id, accountId: r.run.accountId, repoId: r.run.repoId, pr: r.run.pr });
  } catch {
    // fx-swallow-ok: a row that cannot name a sandbox has no derived name; the caller skips it and reports the mismatch
    return null;
  }
}

interface RunRead {
  id: string;
  accountId: string;
  sandboxName: string | null;
  endedAt: Date | null;
  run: ExecutionRun;
}

/** Reads the candidate's run row under its own tenant context. */
async function readRun(pool: Pool, accountId: string, runId: string): Promise<RunRead | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config($1, $2, true)", ["app.account_id", accountId]);
    const { rows } = await client.query<RunRow>(
      `SELECT id, account_id, role, sandbox_name, dispatch_repo_id, dispatch_pr_number::text AS dispatch_pr_number, ended_at
         FROM agent_runs WHERE account_id = $1 AND id = $2`,
      [accountId, runId],
    );
    await client.query("COMMIT");
    const r = rows[0];
    if (!r) return null;
    const pr = r.dispatch_pr_number === null ? undefined : Number(r.dispatch_pr_number);
    const run: ExecutionRun = { id: r.id, accountId: r.account_id, role: r.role as ExecutionRun["role"], product: "team", repoId: r.dispatch_repo_id ?? undefined, pr, roleCard: "", prompt: "", model: "", capUsd: 0, spend: { plan: "starter" } };
    return { id: r.id, accountId: r.account_id, sandboxName: r.sandbox_name, endedAt: r.ended_at, run };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.query("RESET app.account_id").catch(() => {});
    client.release();
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// The inventory (C81 criterion 14, C82 section 2): the provider's list joined to run rows, one row per account, derived afresh.
// ---------------------------------------------------------------------------------------------------------------------------

/** C81 section 3.3: an account may hold this many idle executor sandboxes; the inventory alerts past it. A constant, not a setting. */
export const SANDBOX_IDLE_CAP_PER_ACCOUNT = 20;
/** C81 criterion 15: more named `ex-` plus `rn-` sandboxes than this in the project raises `sandbox_total_high`. */
export const SANDBOX_TOTAL_HIGH = 1000;
/** Pages read per prefix. A list that is longer than this is incomplete and writes no inventory (the previous rows stand). */
export const INVENTORY_MAX_PAGES_PER_PREFIX = 100;
/** The most names the writer definer takes in one call (it refuses more). */
const INVENTORY_MAX_NAMES = 20_000;

export interface SandboxInventoryDeps {
  /** The runner login's pool. */
  pool: Pool;
  port: SandboxPort;
  log?: (line: string) => void;
}

export interface SandboxInventoryInput {
  /** Epoch milliseconds; the facade takes it as a clock input and does not use it to decide anything. */
  now: number;
}

export interface SandboxInventoryResult {
  /** Account rows written (0 when the list was incomplete and nothing was written). */
  accounts: number;
  /** Project-wide counts of the named sandboxes the provider listed, orphans included. */
  live: number;
  stoppedExecutor: number;
  stoppedEphemeral: number;
  /** Listed sandboxes whose name no run row of exactly one account owns: counted, never written, never touched. */
  orphans: number;
  /** Fixed codes, each at most once. */
  alerts: string[];
}

/** The provider's statuses folded to the two the inventory counts: a stopped, failed or aborted sandbox is stopped, any other is live. */
function inventoryStateOf(status: string): "live" | "stopped" {
  return status === "stopped" || status === "failed" || status === "aborted" ? "stopped" : "live";
}

export async function sandboxInventory(deps: SandboxInventoryDeps, input: SandboxInventoryInput): Promise<SandboxInventoryResult> {
  if (!Number.isFinite(input.now)) throw new TypeError("sandboxInventory: now must be a number");
  if (!deps.port.listSandboxes) throw new Error("sandboxInventory: the sandbox port cannot list");
  const log = deps.log ?? ((line: string) => console.log(line));
  const alerts: string[] = [];
  const listed = new Map<string, "live" | "stopped">();
  let complete = true;
  for (const prefix of ["ex-", "rn-"] as const) {
    const kind = prefix === "ex-" ? "executor" : "ephemeral";
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      if (pages++ >= INVENTORY_MAX_PAGES_PER_PREFIX) {
        complete = false;
        break;
      }
      // A provider failure throws (SandboxPortError): the job reports it and the previous inventory stands.
      const page = await deps.port.listSandboxes({ prefix, ...(cursor !== undefined && { cursor }) });
      // Ours by shape only: a listed name that is not exactly what `sandboxNameFor` builds is neither counted nor sent to the database.
      for (const s of page.sandboxes) if (parseSandboxName(s.name)?.kind === kind) listed.set(s.name, inventoryStateOf(s.status));
      if (page.next === null) break;
      cursor = page.next;
    }
  }
  if (listed.size > INVENTORY_MAX_NAMES) complete = false;
  const states = [...listed.values()];
  const live = states.filter((x) => x === "live").length;
  const stoppedExecutor = [...listed].filter(([name, x]) => x === "stopped" && name.startsWith("ex-")).length;
  const stoppedEphemeral = [...listed].filter(([name, x]) => x === "stopped" && name.startsWith("rn-")).length;
  if (listed.size > SANDBOX_TOTAL_HIGH) alerts.push("sandbox_total_high");
  let accounts = 0;
  let orphans = 0;
  if (!complete) {
    log(JSON.stringify({ event: "sandbox_inventory.incomplete", listed: listed.size }));
  } else {
    const { rows } = await deps.pool.query<{ accounts: number; orphans: number; over_cap: number }>("SELECT accounts, orphans, over_cap FROM sandbox_inventory_write($1::text[], $2::text[], $3)", [[...listed.keys()], states, SANDBOX_IDLE_CAP_PER_ACCOUNT]);
    accounts = rows[0]?.accounts ?? 0;
    orphans = rows[0]?.orphans ?? 0;
    if (orphans > 0) alerts.push("sandbox_orphan_found");
    if ((rows[0]?.over_cap ?? 0) > 0) alerts.push("sandbox_cap_exceeded");
  }
  log(JSON.stringify({ event: "sandbox_inventory", accounts, live, stopped_executor: stoppedExecutor, stopped_ephemeral: stoppedEphemeral, total: listed.size, orphans, complete }));
  return { accounts, live, stoppedExecutor, stoppedEphemeral, orphans, alerts };
}
