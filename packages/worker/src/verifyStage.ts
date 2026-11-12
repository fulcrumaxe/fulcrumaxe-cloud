import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { expireOrder, placeDeployOrder, readOrderOfRow, type DeployOrder } from "@fx/core/src/verify/orders.js";
import { genuineSyncCommit, qualifyDeployedCommit, type CommitFacts, type CommitRelation } from "@fx/core/src/verify/qualify.js";
import { finishVerifyRow, openVerifyRow, readVerifyRow, startDeploying, type VerifyReasonCode, type VerifyRow } from "@fx/core/src/verify/rows.js";
import { readVerifySettings } from "@fx/core/src/verify/settings.js";
import { reportError } from "@fx/telemetry";

/**
 * D#749 V3a: the post-merge verify stage's sweep, a THIRD pass in the claim verifier's 15-minute tick (no cron and no sweep name of its own; a merge in a repository that
 * has verification on sets the tick's existing hint). Verification is off by default, so the list below names only the repositories that turned it on and the pass costs a
 * quiet deployment nothing. The pipeline decides everything here (R-597-1): nothing a page or a model wrote is read, and the pass imports no merge call site.
 *
 *  1. `verify_stage_list_enabled` (migration 1005) names the enabled repositories (account and repository ids, nothing else). Everything after runs under that account's tenant.
 *  2. Per repository, serially (one deploy and check at a time):
 *     - Intake: a merged item the product merged (a `merged_by_gate` or `merged_via_queue` fact names its pull request) that merged after verification was last switched on
 *       (`verify_settings.enabled_since`, stamped on the off -> on move alone, never by another save) and within the lookback, and has no row, gets its row (`openVerifyRow`: V1's rules,
 *       replay-safe). The merge commit is read from the host. A merge whose commit the host does not name after INTAKE_HOST_TRIES asks is passed over for this pass (counted in
 *       `no_merge_commit`) and tried again next tick, and the pass goes on to the merges behind it, so one such merge never holds the others up.
 *     - The oldest unfinished row moves one step. `pending`: it starts deploying and ONE deploy order for its merge commit is placed, in one transaction (a runner on the
 *       repository's machine claims it and runs the command only that machine holds). `deploying`: the order's outcome decides. A failed, lapsed or called-off order ends the row
 *       `unverified: deploy_failed`; an order that lapsed unclaimed is first let go by the cloud. A succeeded order starts the readiness poll of the app's /api/health, and the
 *       reported commit must qualify for the merge commit (equal, or a genuine sync commit that names the merge commit or a descendant). After READINESS_CAP_MINUTES without
 *       it, the row ends `unverified` with `deployment_unreachable` (the app never answered) or `commit_not_deployed` (it answered with another commit). A qualified row is handed to
 *       `ready` (verifyRun.ts starts the tester job; with none, the row stays `deploying` and is read again next tick). A `running` row is the tester's: the pass only asks `settle` whether its job has ended (verifyRun.ts, D#749 V3b).
 *  3. The pass is one at a time (a try-lock held for the pass), and bounded in time. A repository that fails never holds up the rest.
 */

export const VERIFY_LIST_PAGE = 100;
export const VERIFY_PASS_BUDGET_MS = 40_000;
/** The longest the app may take to report a qualifying commit after the deploy command succeeded. */
export const READINESS_CAP_MINUTES = 15;
/** Merges taken into rows per repository and pass. */
export const INTAKE_PER_PASS = 5;
/** Candidates looked at per repository and pass, oldest first: more than INTAKE_PER_PASS so a merge the host never names cannot hold the ones behind it. */
export const INTAKE_SCAN_MAX = 25;
/** Times the host is asked for one merge's commit in a pass before the merge is passed over until the next tick. */
export const INTAKE_HOST_TRIES = 2;
/** A merge older than this when verification is on is not verified late. */
export const INTAKE_LOOKBACK_HOURS = 24;
const SWEEP_LOCK = "fx:verify_stage_sweep";

export interface VerifyTarget {
  repoId: string;
  owner: string;
  name: string;
  /**
   * The paired public code repository (the repository's `repo_pairing.code_repo`), or absent/null for a single-plane repository. With one, the pull request, its merge
   * commit and the comparison of code-plane commits live there and the deployed sync commit lives in `owner`/`name` (the host adapter reads each from its plane).
   */
  codeRepo?: { owner: string; name: string } | null;
}
/** What the host (GitHub) says. Each call is one read; none writes. */
export interface VerifyHostPort {
  /** The merge commit of a merged pull request, or null when the host does not name one yet. */
  mergeCommit(target: VerifyTarget, prNumber: number): Promise<string | null>;
  /** A commit's parents and message, or null when the host has no such commit. */
  commit(target: VerifyTarget, sha: string): Promise<CommitFacts | null>;
  /** How `head` relates to `base`, read from the host (`ahead`: head descends from base). */
  relation(target: VerifyTarget, base: string, head: string): Promise<CommitRelation>;
}
export type ReadyOutcome = "started" | "held" | "ended";
export type HealthRead = { kind: "ok"; commit: string | null } | { kind: "unreachable" };

export interface VerifyStageDeps {
  /** The runner login's pool (it holds EXECUTE on the list and, as a member of app_user, works under a tenant). */
  pool: Pool;
  host: VerifyHostPort;
  /** One read of the app's /api/health at the base URL the settings name (the production reader pins the host and caps the body). */
  health: (baseUrl: string, who: { accountId: string }) => Promise<HealthRead>;
  /**
   * The next stage's entry: called once a deployed commit qualifies for a row (verifyRun.ts). Absent: the row stays `deploying`. It answers what it did:
   * `started` (the tester job is running and the row is `running`), `held` (the repository's daily cap, or no seat yet: read again next tick), `ended` (it ended the row `unverified`).
   */
  ready?: (input: { accountId: string; repoId: string; row: VerifyRow; deployedCommit: string }) => Promise<ReadyOutcome | void>;
  /** Reads a `running` row's tester job and, when it ended, writes the row's outcome (verifyRun.ts). Absent: a running row is left alone. `settled`: the row is finished. */
  settle?: (input: { accountId: string; repoId: string; row: VerifyRow }) => Promise<"settled" | "waiting">;
  /** Tests only: replaces the cross-account list. */
  list?: () => Promise<Array<{ account_id: string; repo_id: string }>>;
  now?: () => number;
}

export interface VerifyStageCounts {
  /** Why the pass did nothing: another pass holds the lock (`busy`). */
  idle?: string;
  listed: number;
  opened: number;
  ordered: number;
  /** Rows waiting on a runner, on the app, or on the tester. */
  waiting: number;
  ready: number;
  /** Tester jobs started by this pass. */
  started: number;
  /** Rows held back by the repository's daily cap or a missing seat (tried again next tick). */
  held: number;
  /** Running rows whose tester job had ended and whose outcome this pass wrote. */
  settled: number;
  /** Rows ended `unverified` by this pass. */
  unverified: number;
  /** Merges the host could not name a commit for (tried again next tick). */
  no_merge_commit: number;
  failed: number;
  /** Rows still unfinished after the pass: the tick keeps coming while this is above zero. */
  active: number;
}
const emptyCounts = (): VerifyStageCounts => ({ listed: 0, opened: 0, ordered: 0, waiting: 0, ready: 0, started: 0, held: 0, settled: 0, unverified: 0, no_merge_commit: 0, failed: 0, active: 0 });

interface RepoInfo {
  owner: string;
  name: string;
}

export function createVerifyStageSweep(deps: VerifyStageDeps): () => Promise<VerifyStageCounts> {
  const tenant = <T>(accountId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> => withTenant(deps.pool, accountId, fn);

  /** Ends a row `unverified`; true when this call did. */
  async function endRow(accountId: string, rowId: string, reason: VerifyReasonCode, counts: VerifyStageCounts): Promise<boolean> {
    const r = await tenant(accountId, (client) => finishVerifyRow(client, accountId, rowId, { status: "unverified", reason }));
    if (r.moved) counts.unverified += 1;
    return r.moved;
  }

  /** The merged, product-merged items of the repository that have no row yet, oldest first, merged since verification was switched on (and within the lookback). */
  async function intake(accountId: string, repoId: string, target: VerifyTarget, counts: VerifyStageCounts): Promise<void> {
    const due = await tenant(accountId, async (client) =>
      (await client.query<{ work_item_id: string; pr_number: number }>(
        `SELECT w.id AS work_item_id, e.pr_number
           FROM verify_settings s
           JOIN work_items w ON w.account_id = s.account_id AND w.repo_id = s.repo_id AND w.stage = 'merged'
           JOIN LATERAL (SELECT t.created_at FROM work_item_transitions t WHERE t.account_id = w.account_id AND t.work_item_id = w.id AND t.to_stage = 'merged' ORDER BY t.created_at DESC LIMIT 1) m ON true
           JOIN LATERAL (SELECT d.pr_number FROM work_item_driver_events d WHERE d.account_id = w.account_id AND d.work_item_id = w.id AND d.kind IN ('merged_by_gate', 'merged_via_queue') AND d.pr_number IS NOT NULL ORDER BY d.created_at DESC, d.seq DESC LIMIT 1) e ON true
          WHERE s.account_id = $1 AND s.repo_id = $2 AND s.enabled AND m.created_at >= GREATEST(s.enabled_since, now() - make_interval(hours => $3::int))
            AND NOT EXISTS (SELECT 1 FROM verify_rows r WHERE r.account_id = w.account_id AND r.work_item_id = w.id)
          ORDER BY m.created_at, w.id LIMIT $4::int`,
        [accountId, repoId, INTAKE_LOOKBACK_HOURS, INTAKE_SCAN_MAX],
      )).rows,
    );
    let taken = 0;
    for (const item of due) {
      if (taken >= INTAKE_PER_PASS) break;
      let sha: string | null = null;
      for (let tries = 0; tries < INTAKE_HOST_TRIES && sha === null; tries++) sha = await deps.host.mergeCommit(target, item.pr_number);
      if (sha === null || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
        counts.no_merge_commit += 1;
        continue;
      }
      const opened = await tenant(accountId, (client) => openVerifyRow(client, accountId, { workItemId: item.work_item_id, prNumber: item.pr_number, mergeSha: sha }));
      if (opened.opened) counts.opened += 1;
      taken += 1;
    }
  }

  /** Does the commit the app reports qualify for the row's merge commit? The host's answers only: a message alone is never trusted. */
  async function qualifies(target: VerifyTarget, row: VerifyRow, deployed: string): Promise<boolean> {
    if (deployed === row.merge_sha) return qualifyDeployedCommit({ deployed, mergeSha: row.merge_sha, twoPlane: false }).qualifies;
    const facts = await deps.host.commit(target, deployed);
    const sync = genuineSyncCommit(facts);
    if (facts === null || sync === null) return false;
    // The host's second parent equal to the merge commit IN FULL is the answer, and costs no second call. Only when the ids differ (a descendant, or a colliding 12-hex prefix)
    // is the host asked how they relate: never accepted on the prefix the message names.
    const input = { deployed, mergeSha: row.merge_sha, twoPlane: true, deployedMessage: facts.message, namedCommit: sync.named };
    if (sync.named === row.merge_sha) return qualifyDeployedCommit(input).qualifies;
    return qualifyDeployedCommit({ ...input, namedRelation: await deps.host.relation(target, row.merge_sha, sync.named) }).qualifies;
  }

  async function readiness(accountId: string, repoId: string, target: VerifyTarget, baseUrl: string, row: VerifyRow, order: DeployOrder, counts: VerifyStageCounts): Promise<boolean> {
    const capped = order.finished_at !== null && order.db_now.getTime() - order.finished_at.getTime() > READINESS_CAP_MINUTES * 60_000;
    const health = await deps.health(baseUrl, { accountId });
    const deployed = health.kind === "ok" ? health.commit : null;
    if (deployed !== null) {
      let ok = false;
      try {
        ok = await qualifies(target, row, deployed.toLowerCase());
      } catch (err) {
        // The host could not answer: the app may well be right, so this tick learns nothing and the poll goes on until the cap.
        reportError(err, { stage: "verify_stage.qualify" });
      }
      if (ok) {
        counts.ready += 1;
        const outcome = await deps.ready?.({ accountId, repoId, row, deployedCommit: deployed.toLowerCase() });
        if (outcome === "started") counts.started += 1;
        if (outcome === "held") counts.held += 1;
        if (outcome === "ended") {
          counts.unverified += 1;
          return true;
        }
        return false;
      }
    }
    if (!capped) {
      counts.waiting += 1;
      return false;
    }
    return endRow(accountId, row.id, health.kind === "unreachable" ? "deployment_unreachable" : "commit_not_deployed", counts);
  }

  async function advance(accountId: string, repoId: string, target: VerifyTarget, baseUrl: string, counts: VerifyStageCounts): Promise<boolean> {
    const row = await tenant(accountId, async (client) => {
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM verify_rows WHERE account_id = $1 AND repo_id = $2 AND status IN ('pending', 'deploying', 'running') ORDER BY created_at, id LIMIT 1`, [accountId, repoId]);
      return rows[0] === undefined ? null : readVerifyRow(client, accountId, rows[0].id);
    });
    if (row === null) return false;
    counts.active += 1;
    if (row.status === "running") {
      if (deps.settle !== undefined && (await deps.settle({ accountId, repoId, row })) === "settled") {
        counts.settled += 1;
        return true;
      }
      counts.waiting += 1;
      return false;
    }
    if (row.status === "pending") {
      // The move and the order are one transaction: a row never deploys without its order, and a replay of the pass places no second one.
      const placed = await tenant(accountId, async (client) => {
        const moved = await startDeploying(client, accountId, row.id, true);
        if (!moved.moved) return false;
        return (await placeDeployOrder(client, accountId, { rowId: row.id, repoId, mergeSha: row.merge_sha })).placed;
      });
      if (placed) counts.ordered += 1;
      return false;
    }
    const order = await tenant(accountId, async (client) => {
      const found = await readOrderOfRow(client, accountId, row.id);
      if (found !== null && (found.state === "pending" || found.state === "claimed") && found.deadline_at.getTime() <= found.db_now.getTime() && (await expireOrder(client, accountId, found.id))) return readOrderOfRow(client, accountId, row.id);
      return found;
    });
    if (order === null || order.state === "failed" || order.state === "expired" || order.state === "cancelled") {
      return endRow(accountId, row.id, "deploy_failed", counts);
    }
    if (order.state !== "succeeded") {
      counts.waiting += 1;
      return false;
    }
    return readiness(accountId, repoId, target, baseUrl, row, order, counts);
  }

  async function repoPass(accountId: string, repoId: string, counts: VerifyStageCounts): Promise<void> {
    const state = await tenant(accountId, async (client) => {
      const settings = await readVerifySettings(client, repoId);
      const repo = await client.query<{ gh_owner: string | null; gh_name: string | null }>(`SELECT gh_owner, gh_name FROM repos WHERE id = $1 AND account_id = $2`, [repoId, accountId]);
      // No pairing row means a single-plane repository (the pairing is derived from the current row, never stamped).
      const pairing = await client.query<{ code_repo: string }>(`SELECT code_repo FROM repo_pairing WHERE repo_id = $1 AND account_id = $2`, [repoId, accountId]);
      return { settings, repo: repo.rows[0], codeRepo: pairing.rows[0]?.code_repo ?? null };
    });
    const info: RepoInfo | null = state.repo?.gh_owner && state.repo.gh_name ? { owner: state.repo.gh_owner, name: state.repo.gh_name } : null;
    // Switched off (or never given an address) since the list was read: nothing to do. Its unstarted rows were ended, with their orders, by the switch itself.
    if (!state.settings.enabled || state.settings.baseUrl === null || info === null) return;
    const [codeOwner, codeName] = state.codeRepo === null ? [] : state.codeRepo.split("/");
    const target: VerifyTarget = { repoId, ...info, ...(codeOwner && codeName ? { codeRepo: { owner: codeOwner, name: codeName } } : {}) };
    await intake(accountId, repoId, target, counts);
    // A row that ended frees the repository for the next one in this same pass (each still takes one step per pass otherwise).
    for (let i = 0; i <= INTAKE_PER_PASS; i++) {
      if (!(await advance(accountId, repoId, target, state.settings.baseUrl, counts))) break;
      counts.active -= 1;
    }
  }

  return async function sweepVerifyStage(): Promise<VerifyStageCounts> {
    const counts = emptyCounts();
    const lock = await deps.pool.connect();
    try {
      await lock.query("BEGIN");
      const got = await lock.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [SWEEP_LOCK]);
      if (got.rows[0]?.ok !== true) return { ...counts, idle: "busy" };
      const now = deps.now ?? Date.now;
      const startedAt = now();
      let after: string | null = null;
      for (;;) {
        const page: Array<{ account_id: string; repo_id: string }> = deps.list
          ? await deps.list()
          : (await deps.pool.query<{ account_id: string; repo_id: string }>("SELECT account_id, repo_id FROM verify_stage_list_enabled($1::integer, $2::uuid)", [VERIFY_LIST_PAGE, after])).rows;
        counts.listed += page.length;
        for (const r of page) {
          if (now() - startedAt > VERIFY_PASS_BUDGET_MS) return counts;
          try {
            await repoPass(r.account_id, r.repo_id, counts);
          } catch (err) {
            // One repository that cannot be advanced never holds up the rest; it is listed again next pass.
            reportError(err, { stage: "verify_stage.repo" });
            counts.failed += 1;
          }
        }
        if (deps.list || page.length < VERIFY_LIST_PAGE) return counts;
        after = page[page.length - 1]!.repo_id;
      }
    } finally {
      await lock.query("COMMIT").catch((err: unknown) => reportError(err, { stage: "verify_stage.unlock" }));
      lock.release();
    }
  };
}
