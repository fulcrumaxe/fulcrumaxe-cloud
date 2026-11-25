import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { MACHINE_JOB_MAX_LIFE_S, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { RUNNER_ONLINE_SECONDS, runnerLiveSql } from "@fx/runner";
import { pgCode, type RunnerCloudDeps } from "./http.js";

/**
 * D#845 ON-16a1: the machine's part of a project removal (migration 1082). The jobs come from the machine's own claim, so an offline machine gets them on its first claim back.
 * Open (derived, never stamped): not revoked, the final job (the delete when ticked, else the stop) not done, and fewer than 3 of them failed (given up).
 */

/** The view's open rule for one repo on one machine, named by the account on top of row security. */
export async function cleanupOpen(client: Pick<PoolClient, "query">, accountId: string, repoId: string, runnerId: string): Promise<boolean> {
  const { rows } = await client.query("SELECT 1 FROM machine_cleanup_states WHERE account_id = $1 AND repo_id = $2 AND runner_id = $3 AND open", [accountId, repoId, runnerId]);
  return rows.length > 0;
}

interface DueRow { o_cleanup: string; o_repo: string; o_gh_repo_id: string; o_kind: "engine_session_stop" | "engine_session_delete"; o_reason: string; o_epoch: number }

/** One closed log line: an event name and a code, never an id or a message. */
const logLine = (deps: RunnerCloudDeps, event: string, code: string): void => (deps.log ?? console.warn)(JSON.stringify({ event, code }));

/**
 * In the claim's runner session: each due chain (the stop, then the delete 1 ms later so `machine_job_pending` hands the stop over first), one savepoint per chain, rolled back whole on
 * any refusal. It never fails the claim: every failure is one closed log line.
 */
export async function issueDueCleanups(client: PoolClient, deps: RunnerCloudDeps, runner: { runnerId: string }): Promise<number> {
  let issued = 0;
  await client.query("SAVEPOINT mc_cleanup_due");
  let due: DueRow[];
  try {
    due = (await client.query<DueRow>("SELECT o_cleanup, o_repo, o_gh_repo_id, o_kind, o_reason, o_epoch FROM machine_cleanup_due()")).rows;
    await client.query("RELEASE SAVEPOINT mc_cleanup_due");
  } catch (error) {
    // fx-swallow-ok: the cleanup never fails the claim; the refusal is one closed log line, and the next claim asks again.
    await client.query("ROLLBACK TO SAVEPOINT mc_cleanup_due");
    logLine(deps, "machine_cleanup.due_failed", pgCode(error) ?? "error");
    return 0;
  }
  if (due.length === 0) return 0;
  let signer: Awaited<ReturnType<NonNullable<RunnerCloudDeps["engineCommandSigner"]>>> = null;
  try {
    signer = (await deps.engineCommandSigner?.()) ?? null;
  } catch {
    // fx-swallow-ok: a signer that cannot be read is a signer that is not configured, logged just below as one closed line.
    signer = null;
  }
  if (signer?.signMachineJob === undefined) {
    logLine(deps, "machine_cleanup.not_configured", "not_configured");
    return 0;
  }
  const sign = signer.signMachineJob.bind(signer);
  const chains = new Map<string, DueRow[]>();
  for (const row of due) chains.set(row.o_cleanup, [...(chains.get(row.o_cleanup) ?? []), row]);
  // The database's clock, not this server's: a request's `requested_at` is the database's, and a job issued before it by a server clock running behind would not count as its chain.
  // Rounded up to the millisecond the signed time carries, so it is never before a request made in the same millisecond.
  const base = Number((await client.query<{ ms: string }>("SELECT ceil(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms")).rows[0]!.ms);
  for (const [cleanupId, rows] of chains) {
    // The stop first, whatever order the rows came in; at most one stop and one delete per cleanup.
    const chain = [rows.find((r) => r.o_kind === "engine_session_stop"), rows.find((r) => r.o_kind === "engine_session_delete")].filter((r): r is DueRow => r !== undefined);
    await client.query("SAVEPOINT mc_cleanup_issue");
    try {
      for (const [i, row] of chain.entries()) {
        const jobId = randomUUID();
        const issuedAt = new Date(base + i);
        const expiresAt = new Date(issuedAt.getTime() + MACHINE_JOB_MAX_LIFE_S * 1000);
        const args = row.o_kind === "engine_session_stop" ? { reason: row.o_reason, operate_epoch: row.o_epoch } : { operate_epoch: row.o_epoch };
        const job = {
          v: 1, job_id: jobId, runner_id: runner.runnerId, repo_gh_id: Number(row.o_gh_repo_id), requires_engine: "any", issued_at: issuedAt.toISOString(), expires_at: expiresAt.toISOString(), kind: row.o_kind, args,
        } as MachineJob;
        await client.query("SELECT machine_cleanup_issue($1, $2, $3, $4::jsonb, $5, $6)", [cleanupId, jobId, row.o_kind, JSON.stringify(sign(job)), issuedAt, expiresAt]);
      }
      await client.query("RELEASE SAVEPOINT mc_cleanup_issue");
      issued += chain.length;
    } catch (error) {
      // fx-swallow-ok: a refused chain is rolled back whole and logged as one closed line; it never fails the claim, and the next claim tries it again.
      await client.query("ROLLBACK TO SAVEPOINT mc_cleanup_issue");
      logLine(deps, "machine_cleanup.issue_refused", pgCode(error) ?? "error");
    }
  }
  return issued;
}

/** What the Repos read shows for a repo whose machine still has to finish a removal. `null` once the cleanup is closed (or there never was one). */
export interface RepoRemoval { state: "waiting_machine" | "removing" | "failed"; machine_name: string; failure_code: string | null }

/**
 * Each repo's `removal`, from its newest cleanup: `waiting_machine` (open; machine offline by the plain `RUNNER_ONLINE_SECONDS` window, paused or draining), `removing` (open, online),
 * `failed` (given up, with the last failed final job's code), absent once closed. Named by the account on top of row security.
 */
export async function readRepoRemovals(client: Pick<PoolClient, "query">, accountId: string, repoIds: readonly string[], o: { now?: Date } = {}): Promise<Map<string, RepoRemoval>> {
  const out = new Map<string, RepoRemoval>();
  if (repoIds.length === 0) return out;
  const live = runnerLiveSql({ runner: "rn", now: "$3", onlineSeconds: "$4", wakeEnabled: false });
  const { rows } = await client.query<{ repo_id: string; open: boolean; revoked: boolean; final_done: boolean; final_failures: number; last_failure_code: string | null; name: string | null; live: boolean; held: boolean }>(
    `SELECT DISTINCT ON (s.repo_id) s.repo_id, s.open, s.revoked, s.final_done, s.final_failures::int AS final_failures, s.last_failure_code, st.name,
            COALESCE(${live}, false) AS live, COALESCE(st.paused_at IS NOT NULL OR st.draining, false) AS held
       FROM machine_cleanup_states s
       JOIN runners rn ON rn.account_id = s.account_id AND rn.id = s.runner_id
       LEFT JOIN runner_settings st ON st.account_id = s.account_id AND st.runner_id = s.runner_id
      WHERE s.account_id = $1 AND s.repo_id = ANY ($2::uuid[])
      ORDER BY s.repo_id, s.requested_at DESC, s.id DESC`,
    [accountId, repoIds, o.now ?? new Date(), RUNNER_ONLINE_SECONDS],
  );
  for (const r of rows) {
    const machine = r.name ?? "Unnamed machine";
    if (r.open) out.set(r.repo_id, { state: r.live && !r.held ? "removing" : "waiting_machine", machine_name: machine, failure_code: null });
    else if (!r.revoked && !r.final_done && r.final_failures >= 3) out.set(r.repo_id, { state: "failed", machine_name: machine, failure_code: r.last_failure_code });
  }
  return out;
}
