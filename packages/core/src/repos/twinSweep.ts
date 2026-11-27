import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../tenancy/withTenant.js';
import { PARITY_CHECK_MS, PARITY_CONCURRENCY, PARITY_LEASE_SECONDS, PARITY_MAX_PER_TICK, PARITY_START_BUDGET_MS, PARITY_WRITE_MARGIN_MS } from './planeParityChecks.js';
import { claimTwinWork, listTwinParityDue, listTwinWork, recordTwinParity, type DueTwinParity, type TwinParityRecord, type TwinWorkItem } from './twinWork.js';

/**
 * D#845 ON-27d4b: the twin sweep, beside `sweepPlaneParity` in the setup-request-check tick (twin parity mirrors plane parity: the same two-installation compute, the same due list). It runs two passes, each over a cross-tenant list
 * (run-writer pool, no tenant) and each twin under its own tenant with no person:
 *
 *   parity   the twins whose due time has come. `claimTwinWork(.., 'parity')` takes the check (it moves the due time five minutes on), the check runs with no connection held, and `recordTwinParity` stores the result with the claim's
 *            `markSeq` and `anchor`. A check that could not know (unavailable, an invalid overlay, too large, a branch we do not follow) stores nothing: the claim's own five minutes are its back-off.
 *   work     the twins whose next step is a job. The twin's work is claimed (a five-minute lease), then the step for its kind runs: a seed is only checked (issuing one is a person's, `twin_seed_issue` refuses a tick), a publish or a sync is
 *            checked once its job is done and issued otherwise, and a verified sync gets its pull request.
 *
 * The check and the steps are injected: this package cannot import the pipeline's `computeTwinParity` or the runner-cloud issuers. A step that throws is counted and logged by twin id and a fixed code, never by its message.
 */
export interface TwinParityJob {
  accountId: string;
  twinId: string;
  privateRepoId: string;
  publicRepoId: string;
  privateRepo: { owner: string; name: string };
  publicRepo: { owner: string; name: string };
  publishedPrivateSha: string | null;
  syncedPublicSha: string | null;
  overlayGlobs: string[];
  installPaths: string[];
}
export type TwinParityOutcome = Omit<TwinParityRecord, 'result'> & { result: TwinParityRecord['result'] | 'unavailable' | 'invalid_overlay' | 'too_large' | 'unsupported_branch' };
export type TwinParityCompute = (job: TwinParityJob) => Promise<TwinParityOutcome>;

type Principal = { accountId: string; userId: null };
/**
 * The steps of one twin's work; each answers with a short fixed word. `not_ready` is "no finished job to check". */
export interface TwinWorkPorts {
  /** FU-311: the twin's two repositories' visibility, read live (a push grant does not read it again). Run on every pass for every twin the sweep touches; anything but `ok` skips the twin this tick. */
  guard(p: Principal, twinId: string): Promise<'ok' | 'refused' | 'unavailable'>;
  seed: { check(p: Principal, twinId: string): Promise<string> };
  publish: { check(p: Principal, twinId: string): Promise<string>; issue(p: Principal, twinId: string): Promise<unknown> };
  sync: { check(p: Principal, twinId: string): Promise<string>; open(p: Principal, twinId: string): Promise<string>; issue(p: Principal, twinId: string, paths: string[]): Promise<unknown> };
}

export interface TwinSweepCounts {
  /** Twins listed for a parity check or for work. */
  listed: number;
  /** Parity results stored. */
  checked: number;
  /** Work steps that ran. */
  worked: number;
  /** Not run: another tick holds it, it is not due, or its state moved. */
  skipped: number;
  failed: number;
  nextDueAt: number | null;
}
export interface TwinSweepDeps {
  /** The run-writer pool. */
  pool: Pool;
  compute: TwinParityCompute;
  ports: TwinWorkPorts;
  now?: () => number;
  log?: (line: string) => void;
  /** As for the plane parity pass: no step starts unless one more check and the write of its result still fit before it. */
  deadlineAt?: number;
}

const codeOf = (error: unknown): string => {
  const e = error as { code?: unknown } | null;
  return typeof e?.code === 'string' ? e.code : 'error';
};
const RECORDABLE = new Set(['in_parity', 'publish_pending', 'sync_pending', 'conflict']);

async function readJob(client: PoolClient, accountId: string, twinId: string): Promise<TwinParityJob | null> {
  const { rows } = await client.query<{ private_repo_id: string; public_repo_id: string; published_private_sha: string | null; synced_public_sha: string | null; overlay_globs: string[]; install_paths: string[]; po: string | null; pn: string | null; uo: string | null; un: string | null }>(
    `SELECT t.private_repo_id, t.public_repo_id, t.published_private_sha, t.synced_public_sha, t.overlay_globs, t.install_paths, prv.gh_owner AS po, prv.gh_name AS pn, pub.gh_owner AS uo, pub.gh_name AS un
       FROM repo_twins t JOIN repos prv ON prv.account_id = t.account_id AND prv.id = t.private_repo_id JOIN repos pub ON pub.account_id = t.account_id AND pub.id = t.public_repo_id
      WHERE t.account_id = $1::uuid AND t.id = $2::uuid`,
    [accountId, twinId],
  );
  const r = rows[0];
  if (!r || !r.po || !r.pn || !r.uo || !r.un) return null;
  return {
    accountId, twinId, privateRepoId: r.private_repo_id, publicRepoId: r.public_repo_id, privateRepo: { owner: r.po, name: r.pn }, publicRepo: { owner: r.uo, name: r.un },
    publishedPrivateSha: r.published_private_sha, syncedPublicSha: r.synced_public_sha, overlayGlobs: r.overlay_globs, installPaths: r.install_paths,
  };
}

const dueMs = async (client: PoolClient, accountId: string, twinId: string): Promise<number | null> => {
  const { rows } = await client.query<{ due_ms: string | null }>('SELECT (extract(epoch FROM due_at) * 1000)::bigint AS due_ms FROM twin_parity_checks WHERE account_id = $1::uuid AND twin_id = $2::uuid', [accountId, twinId]);
  const v = rows[0]?.due_ms;
  return v === null || v === undefined ? null : Number(v);
};

export async function sweepTwins(deps: TwinSweepDeps): Promise<TwinSweepCounts> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.info(line));
  const counts: TwinSweepCounts = { listed: 0, checked: 0, worked: 0, skipped: 0, failed: 0, nextDueAt: null };
  const startedAt = now();
  const later: number[] = [];
  const fits = (): boolean => now() - startedAt <= PARITY_START_BUDGET_MS && (deps.deadlineAt === undefined || deps.deadlineAt - now() >= PARITY_CHECK_MS + PARITY_WRITE_MARGIN_MS);
  const leaseEnd = (): number => startedAt + (PARITY_LEASE_SECONDS + 1) * 1000;
  const fail = (event: string, id: string, error: unknown): void => {
    counts.failed += 1;
    log(JSON.stringify({ event, twin_id: id, code: codeOf(error) }));
  };
  const pass = async <T extends { twinId: string }>(items: T[], one: (item: T) => Promise<void>): Promise<void> => {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < items.length && fits()) await one(items[next++]!);
    };
    await Promise.all(Array.from({ length: Math.min(PARITY_CONCURRENCY, items.length) }, worker));
    if (next < items.length) later.push(startedAt + 1000);
  };

  // ---- parity ----
  let due: DueTwinParity[] = [];
  try {
    due = await listTwinParityDue(deps.pool);
  } catch (error) {
    // fx-swallow-ok: counted and logged by a fixed code; the next tick lists again
    fail('twin_sweep.list_failed', 'parity', error);
    later.push(startedAt + 60_000);
  }
  counts.listed += due.length;
  const ready = due.filter((d) => d.dueNow);
  const batch = ready.slice(0, PARITY_MAX_PER_TICK);
  later.push(...due.filter((d) => !d.dueNow).map((d) => d.dueAtMs));
  if (ready.length > batch.length) later.push(startedAt + 1000);
  await pass(batch, async (item) => {
    try {
      const tenant = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(deps.pool, item.accountId, fn);
      const claimed = await tenant(async (client) => {
        const claim = await claimTwinWork(client, item.twinId, 'parity');
        if (claim.result !== 'ok') return null;
        const job = await readJob(client, item.accountId, item.twinId);
        return job === null ? null : { claim, job };
      });
      if (claimed === null) {
        counts.skipped += 1;
        return;
      }
      const seen = await deps.ports.guard({ accountId: item.accountId, userId: null }, item.twinId);
      if (seen !== 'ok') {
        counts.skipped += 1;
        later.push(leaseEnd());
        log(JSON.stringify({ event: 'twin_sweep.visibility_skip', twin_id: item.twinId, code: seen }));
        return;
      }
      let outcome: TwinParityOutcome | null = null;
      try {
        outcome = claimed.claim.anchor === null ? null : await deps.compute(claimed.job);
      } catch {
        // fx-swallow-ok: a check that could not run is "could not know" (its text can carry a URL, so it is dropped)
        outcome = null;
      }
      if (outcome === null || !RECORDABLE.has(outcome.result) || claimed.claim.anchor === null) {
        // Nothing is stored; the claim's own five minutes are the back-off.
        counts.skipped += 1;
        later.push(leaseEnd());
        return;
      }
      const record = outcome as TwinParityRecord;
      const anchor = claimed.claim.anchor;
      const stored = await tenant(async (client) => {
        const result = await recordTwinParity(client, item.twinId, { markSeq: claimed.claim.markSeq, anchor }, record);
        return { result, due: await dueMs(client, item.accountId, item.twinId) };
      });
      if (stored.result === 'ok') counts.checked += 1;
      else {
        // A result whose anchor moved (stale) or a twin whose state moved is not a fault: skip this tick, logged by a fixed code.
        counts.skipped += 1;
        log(JSON.stringify({ event: 'twin_sweep.parity_skip', twin_id: item.twinId, code: stored.result }));
      }
      later.push(stored.due ?? (stored.result === 'stale' ? startedAt + 1000 : leaseEnd()));
    } catch (error) {
      // fx-swallow-ok: counted and logged by id and a fixed code; the claim's five minutes are the back-off
      fail('twin_sweep.parity_failed', item.twinId, error);
      later.push(leaseEnd());
    }
  });

  // ---- work ----
  let work: TwinWorkItem[] = [];
  try {
    work = await listTwinWork(deps.pool, PARITY_MAX_PER_TICK);
  } catch (error) {
    // fx-swallow-ok: counted and logged by a fixed code; the next tick lists again
    fail('twin_sweep.work_list_failed', 'work', error);
    later.push(startedAt + 60_000);
  }
  counts.listed += work.length;
  await pass(work, async (item) => {
    const principal: Principal = { accountId: item.accountId, userId: null };
    try {
      const claim = await withTenant(deps.pool, item.accountId, (client) => claimTwinWork(client, item.twinId, item.kind));
      if (claim.result !== 'ok') {
        counts.skipped += 1;
        if (claim.result === 'leased') later.push(leaseEnd());
        log(JSON.stringify({ event: 'twin_sweep.work_skip', twin_id: item.twinId, code: claim.result }));
        return;
      }
      later.push(leaseEnd());
      const seen = await deps.ports.guard(principal, item.twinId);
      if (seen !== 'ok') {
        counts.skipped += 1;
        log(JSON.stringify({ event: 'twin_sweep.visibility_skip', twin_id: item.twinId, code: seen }));
        return;
      }
      const { ports } = deps;
      if (item.kind === 'seed') await ports.seed.check(principal, item.twinId);
      else if (item.kind === 'publish') {
        if ((await ports.publish.check(principal, item.twinId)) === 'not_ready') await ports.publish.issue(principal, item.twinId);
      } else {
        const checked = await ports.sync.check(principal, item.twinId);
        if (checked === 'verified') await ports.sync.open(principal, item.twinId);
        else if (checked === 'not_ready') {
          const paths = await withTenant(deps.pool, item.accountId, async (client) => (await client.query<{ paths: string[] }>("SELECT paths FROM twin_parity_checks WHERE account_id = $1::uuid AND twin_id = $2::uuid AND last_result = 'sync_pending'", [item.accountId, item.twinId])).rows[0]?.paths ?? []);
          if (paths.length > 0) await ports.sync.issue(principal, item.twinId, paths);
        }
      }
      counts.worked += 1;
    } catch (error) {
      // fx-swallow-ok: logged by id and a fixed code, never the message. A refusal (a 4xx the issuer or the check threw: a job already under way, a repository no longer private) is an answer, not a fault: it is logged by code and the lease keeps the twin quiet.
      const status = (error as { status?: unknown } | null)?.status;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        counts.skipped += 1;
        log(JSON.stringify({ event: 'twin_sweep.work_refused', twin_id: item.twinId, code: codeOf(error) }));
      } else fail('twin_sweep.work_failed', item.twinId, error);
    }
  });
  counts.nextDueAt = later.length === 0 ? null : Math.min(...later);
  return counts;
}
