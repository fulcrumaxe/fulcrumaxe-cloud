import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../tenancy/withTenant.js';
import { syncDerivedSetupRequest } from '../setup-requests/store.js';
import { parityReason } from '../setup-requests/copy.js';

/**
 * D#598 P1d-3: the due mark and the result of the plane parity check (migration 0951, `plane_parity_checks`), and the sweep that runs the checks.
 *
 * A push to the default branch of either repo of a pairing marks the pairing due 60 seconds ahead (`markPlaneParityDue`; the webhook makes no GitHub
 * call). The existing setup-request-check sweep lists the rows whose time has come (`plane_parity_list_due`, the run-writer pool, no tenant), takes each
 * one under a five-minute lease, runs the check with no connection held, and writes the result and the derived `parity_drift` request in ONE
 * transaction (`applyParityOutcome`). The check itself is injected (`compute`): this package cannot import the pipeline's `computePlaneParity`.
 */

export const PARITY_DUE_AFTER_SECONDS = 60;
/** A claimed check that never reports is looked at again after this long. */
export const PARITY_LEASE_SECONDS = 300;
export const PARITY_MAX_PER_TICK = 20;
export const PARITY_CONCURRENCY = 4;
export const PARITY_START_BUDGET_MS = 45_000;
/** The longest one check runs (the pipeline's `PARITY_DEADLINE_MS`; this package cannot import it) and the room kept for writing its result. */
export const PARITY_CHECK_MS = 25_000;
export const PARITY_WRITE_MARGIN_MS = 5_000;
const BACKOFF_SECONDS = 300;
const LONG_BACKOFF_SECONDS = 1800;

export type ParityResult = 'in_parity' | 'lag' | 'drift' | 'no_shared_history' | 'too_large' | 'invalid_overlay' | 'unsupported_branch' | 'unavailable';

/** What the check found: the structured fields of the pipeline's `PlaneParityOutcome` (this package takes the shape, not the module). */
export interface ParityOutcome {
  result: ParityResult;
  privateSha: string | null;
  publicSha: string | null;
  syncSha: string | null;
  paths: readonly string[];
  pathCount: number;
  limitSide: 'private' | 'public' | null;
}

export interface ParityJob {
  accountId: string;
  repoId: string;
  privateRepo: { owner: string; name: string };
  publicRepo: { owner: string; name: string };
  /** The account's own repos row for the public repo (it carries the installation); null when the account has none. */
  publicRepoId: string | null;
  overlayGlobs: string[];
}
export type ParityCompute = (job: ParityJob) => Promise<ParityOutcome>;

const UNAVAILABLE: ParityOutcome = { result: 'unavailable', privateSha: null, publicSha: null, syncSha: null, paths: [], pathCount: 0, limitSide: null };

/**
 * The webhook's mark. `fullName` is the pushed repo (compared case-insensitively against the pairing's public repo); `repoId` is the delivery's repos row
 * (the private side). Already due keeps the earlier time; a push also resets the back-off. Returns how many pairings were marked.
 */
export async function markPlaneParityDue(client: PoolClient, input: { accountId: string; repoId: string | null; fullName: string }): Promise<number> {
  const { rowCount } = await client.query(
    `INSERT INTO plane_parity_checks (repo_id, account_id, due_at)
     SELECT p.repo_id, p.account_id, now() + make_interval(secs => $4::integer) FROM repo_pairing p
      WHERE p.account_id = $1::uuid AND (p.repo_id = $2::uuid OR lower(p.code_repo) = lower($3))
     ON CONFLICT (repo_id) DO UPDATE SET due_at = LEAST(plane_parity_checks.due_at, EXCLUDED.due_at), unavailable_streak = 0`,
    [input.accountId, input.repoId || null, input.fullName, PARITY_DUE_AFTER_SECONDS],
  );
  return rowCount ?? 0;
}

export interface DueParity {
  accountId: string;
  repoId: string;
  userId: string;
  dueAtMs: number;
  dueNow: boolean;
}

/** Every pairing with a due time, earliest first. Run-writer pool, no tenant (the definer of migration 0951). */
export async function listPlaneParityDue(pool: Pick<Pool, 'query'>, limit = 50): Promise<DueParity[]> {
  const { rows } = await pool.query<{ account_id: string; repo_id: string; user_id: string; due_ms: string; due_now: boolean }>(
    'SELECT account_id, repo_id, user_id, (extract(epoch FROM due_at) * 1000)::bigint AS due_ms, due_now FROM plane_parity_list_due($1::integer)',
    [limit],
  );
  return rows.map((r) => ({ accountId: r.account_id, repoId: r.repo_id, userId: r.user_id, dueAtMs: Number(r.due_ms), dueNow: r.due_now }));
}

/** Takes the check for this tick (the lease): null when another tick took it, or a push or the clock moved it. Returns the lease as exact text. */
async function claim(client: PoolClient, repoId: string): Promise<string | null> {
  const { rows } = await client.query<{ lease: string }>(
    `UPDATE plane_parity_checks SET due_at = now() + make_interval(secs => $2::integer)
      WHERE repo_id = $1::uuid AND due_at <= now() RETURNING due_at::text AS lease`,
    [repoId, PARITY_LEASE_SECONDS],
  );
  return rows[0]?.lease ?? null;
}

async function readJob(client: PoolClient, accountId: string, repoId: string): Promise<ParityJob | null> {
  const { rows } = await client.query<{ gh_owner: string | null; gh_name: string | null; code_repo: string; overlay_globs: string[]; public_repo_id: string | null }>(
    `SELECT r.gh_owner, r.gh_name, p.code_repo, p.overlay_globs,
            (SELECT x.id FROM repos x WHERE x.account_id = p.account_id AND x.id <> p.repo_id AND lower(x.gh_owner || '/' || x.gh_name) = lower(p.code_repo) ORDER BY x.id LIMIT 1) AS public_repo_id
       FROM repo_pairing p JOIN repos r ON r.id = p.repo_id WHERE p.repo_id = $1::uuid`,
    [repoId],
  );
  const row = rows[0];
  if (!row || !row.gh_owner || !row.gh_name) return null;
  const [owner, name] = row.code_repo.split('/');
  return { accountId, repoId, privateRepo: { owner: row.gh_owner, name: row.gh_name }, publicRepo: { owner: owner!, name: name! }, publicRepoId: row.public_repo_id, overlayGlobs: row.overlay_globs };
}

/** What the result does to the request: a request to hold, null to close it, undefined to leave it alone. Pure. */
export function parityRequestFor(job: Pick<ParityJob, 'privateRepo' | 'publicRepo'>, o: ParityOutcome): { target: string; reason: string } | null | undefined {
  const privateRepo = `${job.privateRepo.owner}/${job.privateRepo.name}`;
  const publicRepo = `${job.publicRepo.owner}/${job.publicRepo.name}`;
  if (o.result === 'unavailable') return undefined;
  if (o.result === 'in_parity' || o.result === 'lag') return null;
  const limitRepo = o.limitSide === 'private' ? privateRepo : publicRepo;
  const sha7 = (o.result === 'drift' ? o.syncSha : o.publicSha) ?? '';
  return { target: publicRepo, reason: parityReason(o.result, { privateRepo, publicRepo, limitRepo, sha7, paths: o.paths, pathCount: o.pathCount }) };
}

/**
 * Writes the result row and the derived request in one transaction, as the account's writer. `lease` is the time the claim set: a push that moved
 * `due_at` meanwhile keeps its own time. "Unavailable" backs off 5 minutes, then 30 minutes from the third in a row, and leaves any request untouched.
 */
export async function applyParityOutcome(client: PoolClient, job: ParityJob, outcome: ParityOutcome, lease: string): Promise<number | null> {
  const unavailable = outcome.result === 'unavailable';
  const { rows } = await client.query<{ due_ms: string | null }>(
    `UPDATE plane_parity_checks
        SET last_result = $2, private_sha = $3, public_sha = $4, sync_sha = $5, checked_at = now(),
            unavailable_streak = CASE WHEN $6 THEN unavailable_streak + 1 ELSE 0 END,
            due_at = CASE WHEN due_at = $7::timestamptz THEN
                       CASE WHEN $6 THEN now() + make_interval(secs => CASE WHEN unavailable_streak + 1 >= 3 THEN $8::integer ELSE $9::integer END) END
                     ELSE due_at END
      WHERE repo_id = $1::uuid RETURNING (extract(epoch FROM due_at) * 1000)::bigint AS due_ms`,
    [job.repoId, outcome.result, outcome.privateSha, outcome.publicSha, outcome.syncSha, unavailable, lease, LONG_BACKOFF_SECONDS, BACKOFF_SECONDS],
  );
  const current = parityRequestFor(job, outcome);
  if (current !== undefined) await syncDerivedSetupRequest(client, { repoId: job.repoId, kind: 'parity_drift', current });
  const due = rows[0]?.due_ms;
  return due === null || due === undefined ? null : Number(due);
}

/**
 * The result could not be written: back the pairing off like "unavailable" (5 minutes, 30 from the third in a row) in a statement of its own, so the
 * bare lease never decides how often the check repeats. Keeps a push's own time like `applyParityOutcome`. Returns the due time now stored, or null.
 */
export async function recordParityFailure(client: PoolClient, repoId: string, lease: string): Promise<number | null> {
  const { rows } = await client.query<{ due_ms: string | null }>(
    `UPDATE plane_parity_checks
        SET unavailable_streak = unavailable_streak + 1,
            due_at = CASE WHEN due_at = $2::timestamptz THEN now() + make_interval(secs => CASE WHEN unavailable_streak + 1 >= 3 THEN $3::integer ELSE $4::integer END) ELSE due_at END
      WHERE repo_id = $1::uuid RETURNING (extract(epoch FROM due_at) * 1000)::bigint AS due_ms`,
    [repoId, lease, LONG_BACKOFF_SECONDS, BACKOFF_SECONDS],
  );
  const due = rows[0]?.due_ms;
  return due === null || due === undefined ? null : Number(due);
}

export interface ParitySweepCounts {
  /** Pairings with a due time (due now or later). */
  listed: number;
  /** Checks that ran and wrote a result. */
  checked: number;
  /** Not run: another tick had taken it, or the pairing is gone. */
  skipped: number;
  failed: number;
  /** Epoch ms of the earliest due time not run this tick (a later mark, a back-off or the remainder), else null. */
  nextDueAt: number | null;
}

export interface ParitySweepDeps {
  /** The run-writer pool. */
  pool: Pool;
  compute: ParityCompute;
  now?: () => number;
  log?: (line: string) => void;
  /**
   * Epoch ms by which the whole tick must be over (the function's own limit, measured from the tick's start, not from the start of this sweep). No check
   * starts unless a check and the write of its result still fit before it. Absent, only the 45 s start budget limits the sweep.
   */
  deadlineAt?: number;
}

export async function sweepPlaneParity(deps: ParitySweepDeps): Promise<ParitySweepCounts> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.info(line));
  const counts: ParitySweepCounts = { listed: 0, checked: 0, skipped: 0, failed: 0, nextDueAt: null };
  const startedAt = now();
  let list: DueParity[];
  try {
    list = await listPlaneParityDue(deps.pool);
  } catch (error) {
    // fx-swallow-ok: counted and logged with a fixed code (never the driver's message); the next tick lists again
    counts.failed += 1;
    log(JSON.stringify({ event: 'plane_parity.list_failed', code: (error as { code?: string } | null)?.code ?? 'error' }));
    counts.nextDueAt = startedAt + 60_000;
    return counts;
  }
  counts.listed = list.length;
  const due = list.filter((d) => d.dueNow);
  const batch = due.slice(0, PARITY_MAX_PER_TICK);
  const later = [...list.filter((d) => !d.dueNow).map((d) => d.dueAtMs), ...(due.length > batch.length ? [startedAt + 1000] : [])];
  let next = 0;
  const one = async (item: DueParity): Promise<void> => {
    let lease: string | null = null;
    try {
      const claimed = await withTenant(deps.pool, item.accountId, item.userId, async (client) => {
        const lease = await claim(client, item.repoId);
        if (lease === null) return null;
        const job = await readJob(client, item.accountId, item.repoId);
        if (job === null) {
          // The pairing can't be read (its repo has no owner or name): nothing to check, and the lease must not bring it back every 5 minutes.
          await client.query('UPDATE plane_parity_checks SET due_at = NULL WHERE repo_id = $1::uuid', [item.repoId]);
          return null;
        }
        return { lease, job };
      });
      if (claimed === null) {
        counts.skipped += 1;
        return;
      }
      lease = claimed.lease;
      let outcome: ParityOutcome;
      try {
        outcome = await deps.compute(claimed.job);
      } catch {
        // fx-swallow-ok: a check that could not run is "unavailable" (its text can carry a URL, so it is dropped)
        outcome = UNAVAILABLE;
      }
      const stored = await withTenant(deps.pool, item.accountId, item.userId, (client) => applyParityOutcome(client, claimed.job, outcome, claimed.lease));
      counts.checked += 1;
      // The time the row now holds (a back-off, or a push that landed during the check): that is when this pairing is next looked at.
      if (stored !== null) later.push(stored);
    } catch (error) {
      // fx-swallow-ok: one pairing's failure is counted and logged by id and a fixed code; its lease runs out and it is listed again
      counts.failed += 1;
      log(JSON.stringify({ event: 'plane_parity.failed', repo_id: item.repoId, code: (error as { code?: string } | null)?.code ?? 'error' }));
      if (lease !== null) {
        const held = lease;
        try {
          const stored = await withTenant(deps.pool, item.accountId, item.userId, (client) => recordParityFailure(client, item.repoId, held));
          if (stored !== null) later.push(stored);
        } catch (backoffError) {
          // fx-swallow-ok: the lease still runs out and the pairing is listed again; logged by id and a fixed code
          log(JSON.stringify({ event: 'plane_parity.backoff_failed', repo_id: item.repoId, code: (backoffError as { code?: string } | null)?.code ?? 'error' }));
        }
      }
    }
  };
  const worker = async (): Promise<void> => {
    while (next < batch.length && now() - startedAt <= PARITY_START_BUDGET_MS && (deps.deadlineAt === undefined || deps.deadlineAt - now() >= PARITY_CHECK_MS + PARITY_WRITE_MARGIN_MS)) await one(batch[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(PARITY_CONCURRENCY, batch.length) }, worker));
  // Whatever was not started goes to the next tick.
  if (next < batch.length) later.push(startedAt + 1000);
  counts.nextDueAt = later.length === 0 ? null : Math.min(...later);
  return counts;
}
