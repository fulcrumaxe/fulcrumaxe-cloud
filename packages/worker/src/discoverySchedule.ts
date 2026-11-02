import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { queueSweepDiscovery } from "@fx/db/src/discoveryRuns.js";
import { queueAnalysis } from "@fx/db/src/discoveryAnalyses.js";
import type { DiscoveryRunDeps } from "@fx/core/src/discovery/run.js";
import type { AnalysisSettings } from "@fx/plan-data";
import { reportError } from "@fx/telemetry";

/**
 * D#483 S5-g2: the daily re-discovery sweep, a first pass in the claim verifier's 15-minute tick (no cron of its own). It QUEUES; it runs nothing.
 * `discovery_sweep_list_due` (0952, paged by a keyset cursor from 0955) names the connected product repositories of active accounts, discovery not off, with no sweep run yet
 * for the current period of their frequency (UTC day, or ISO week; cut in SQL, so no time zone is involved). A repository that discovery is off for, or whose account is not active,
 * is never listed (its drain would only record a skip). The pass reads pages from a rotating start (below) until a page is empty or the budget is spent, and tries each repository at most
 * once. For each, under its tenant:
 *  1. A `discovery_runs` row (trigger `sweep`, the period as reference) is queued; its UNIQUE key is the once-per-period rule. The drain (S4-c2) runs it and records why it skipped.
 *  2. If the repository may be analysed now (connected, account active, discovery on, sandbox or Cloud-verified, analysis configured) and its default branch head differs from the newest
 *     analysis row's (none counts as changed), that head's analysis is queued for the analysis pass (S4-f3). An unchanged head queues nothing. A new repository's first
 *     analysis starts here, at its first sweep, never at install (A-S4-1).
 * Spend is the analysis pass's shared `perRepoDailyUsd` counter. Nothing here creates a work item, an action request or a start, or imports the stage driver (R-597-1).
 */

export const SCHEDULE_LIST_LIMIT = 100;
export const SCHEDULE_PASS_BUDGET_MS = 20_000;
const SCHEDULE_LOCK = "fx:discovery_schedule";
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const SLOT_MS = 15 * 60_000;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export interface SweepCursor {
  accountId: string;
  repoId: string;
}
export interface SweepRow {
  account_id: string;
  repo_id: string;
  period_ref: string;
}

/**
 * Where a pass starts in the (repo, account) order (repo ids are random across accounts, so even one account's repositories are spread over the whole order). The pass reads from here to the end, then wraps to the beginning and stops back at here, so every repository is reached once.
 * The start moves by the golden ratio of the keyspace each quarter-hour slot, so no two neighbouring passes start close together: a failing run of repositories cannot sit in front of
 * the same healthy ones pass after pass. Derived from the clock alone (no stored state), so every pass of every instance agrees.
 */
export function passStart(nowMs: number): SweepCursor {
  const frac = (Math.floor(nowMs / SLOT_MS) * 0.6180339887498949) % 1;
  const h = Math.floor(frac * 2 ** 48).toString(16).padStart(12, "0");
  return { accountId: NIL_UUID, repoId: `${h.slice(0, 8)}-${h.slice(8)}-0000-0000-000000000000` };
}
const keyOf = (c: { accountId: string; repoId: string }): string => `${c.repoId}|${c.accountId}`;

export interface DiscoveryScheduleDeps {
  /** The runner login's pool (EXECUTE on the list; tenant sessions as a member of app_user). */
  pool: Pool;
  openSource: DiscoveryRunDeps["openSource"];
  /** plan-data's `analysisSettings`: analysis off queues no analysis (the run is still queued). */
  settings: () => AnalysisSettings;
  /** Tests only: replaces the cross-account list (one page strictly after the cursor, `null` for the first). */
  list?: (after: SweepCursor | null, limit: number) => Promise<SweepRow[]>;
  now?: () => number;
}

export interface DiscoveryScheduleCounts {
  /** Why the pass did nothing: another pass holds the lock (`busy`), or no source is wired (`not_configured`). */
  idle?: string;
  listed: number;
  queued: number;
  analyses: number;
  /** Head already analysed or queued. */
  unchanged: number;
  /** May not be analysed now (not connected, not paying, discovery off, Local-only, analysis off). */
  not_analysed: number;
  errors: number;
  /** The budget ran out before the list ended: more may be waiting. */
  more: boolean;
}

export const emptyScheduleCounts = (idle?: string): DiscoveryScheduleCounts => ({ ...(idle ? { idle } : {}), listed: 0, queued: 0, analyses: 0, unchanged: 0, not_analysed: 0, errors: 0, more: false });

interface RepoRow {
  installation_id: string | null;
  gh_owner: string | null;
  gh_name: string | null;
  execution_mode: string;
  account_status: string;
  frequency: string | null;
  last_head: string | null;
}

export function createDiscoverySchedule(deps: DiscoveryScheduleDeps): () => Promise<DiscoveryScheduleCounts> {
  const now = deps.now ?? Date.now;

  async function scheduleOne(counts: DiscoveryScheduleCounts, accountId: string, repoId: string, ref: string, analyse: boolean): Promise<void> {
    if ((await queueSweepDiscovery(deps.pool, accountId, repoId, ref)) !== null) counts.queued += 1;
    const row = await withTenant(deps.pool, accountId, async (client) => {
      const { rows } = await client.query<RepoRow>(
        `SELECT r.installation_id, r.gh_owner, r.gh_name, r.execution_mode, a.status AS account_status,
                (SELECT s.frequency FROM discovery_settings s WHERE s.account_id = r.account_id AND s.repo_id = r.id ORDER BY s.version DESC LIMIT 1) AS frequency,
                (SELECT x.head_sha FROM discovery_analyses x WHERE x.account_id = r.account_id AND x.repo_id = r.id ORDER BY x.created_at DESC, x.id DESC LIMIT 1) AS last_head
           FROM repos r JOIN accounts a ON a.id = r.account_id WHERE r.account_id = $1 AND r.id = $2`, [accountId, repoId]);
      return rows[0];
    });
    if (!analyse || !row || row.installation_id === null || row.account_status !== "active" || row.frequency === "off" || (row.execution_mode !== "sandbox" && row.execution_mode !== "runner_verified") || !row.gh_owner || !row.gh_name) {
      counts.not_analysed += 1;
      return;
    }
    const head = (await deps.openSource({ repoId, owner: row.gh_owner, name: row.gh_name }).head()).sha;
    if (!SHA_RE.test(head)) throw new Error("discovery schedule: the head is not a full commit sha");
    // The key (repo, head) makes a replay a no-op; comparing first saves the write.
    if (row.last_head !== head && (await queueAnalysis(deps.pool, accountId, repoId, head, "sweep")) !== null) counts.analyses += 1;
    else counts.unchanged += 1;
  }

  return async function sweepDiscoverySchedule(): Promise<DiscoveryScheduleCounts> {
    const counts = emptyScheduleCounts();
    let analyse = false; // fail closed: settings that cannot be read queue no analysis (the runs are still queued)
    try {
      analyse = deps.settings().on;
    } catch (err) {
      reportError(err, { stage: "discovery_schedule.settings" });
    }
    // One pass at a time: a transaction-scoped try-lock on its own connection, held for the whole pass (the pool needs one more free connection).
    const lock = await deps.pool.connect();
    try {
      await lock.query("BEGIN");
      const got = await lock.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [SCHEDULE_LOCK]);
      if (got.rows[0]?.ok !== true) return emptyScheduleCounts("busy");
      const fetchPage = (after: SweepCursor | null): Promise<SweepRow[]> =>
        deps.list
          ? deps.list(after, SCHEDULE_LIST_LIMIT)
          : deps.pool
              .query<SweepRow>("SELECT account_id, repo_id, period_ref FROM discovery_sweep_list_due($1::integer, $2::uuid, $3::uuid)", [SCHEDULE_LIST_LIMIT, after?.accountId ?? null, after?.repoId ?? null])
              .then((res) => res.rows);
      const startedAt = now();
      const start = passStart(startedAt);
      // First the start to the end of the order, then the beginning up to the start: each repository once.
      for (const from of [start, null]) {
        let after: SweepCursor | null = from;
        for (;;) {
          if (now() - startedAt > SCHEDULE_PASS_BUDGET_MS) {
            counts.more = true;
            return counts;
          }
          const rows = await fetchPage(after);
          if (rows.length === 0) break;
          for (const r of rows) {
            if (from === null && keyOf({ accountId: r.account_id, repoId: r.repo_id }) > keyOf(start)) return counts;
            if (now() - startedAt > SCHEDULE_PASS_BUDGET_MS) {
              counts.more = true;
              return counts;
            }
            counts.listed += 1;
            try {
              await scheduleOne(counts, r.account_id, r.repo_id, r.period_ref, analyse);
            } catch (err) {
              // One repository that cannot be scheduled never holds up the rest (the cursor moves on whatever happened here), and is not tried again this pass.
              reportError(err, { stage: "discovery_schedule.repo" });
              counts.errors += 1;
            }
          }
          const last = rows[rows.length - 1]!;
          after = { accountId: last.account_id, repoId: last.repo_id };
        }
      }
      return counts;
    } finally {
      await lock.query("COMMIT").catch((err: unknown) => reportError(err, { stage: "discovery_schedule.unlock" }));
      lock.release();
    }
  };
}
