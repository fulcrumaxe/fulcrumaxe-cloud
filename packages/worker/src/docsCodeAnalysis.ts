import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { endAnalysis, holdAnalysis, noteAnalysisAttempt, startAnalysis } from "@fx/db/src/discoveryAnalyses.js";
import { analysisRunKey, overRepoDailyUsd } from "@fx/core/src/plan/proposalVerifyLimits.js";
import { mergeCandidates, type AnalysisCandidate } from "@fx/core/src/discovery/candidates.js";
import { ENGINE_LOOP_MARKER } from "@fx/core/src/plan/executeImport.js";
import { decideOwnerProcess } from "@fx/core/src/plan/ownerProcess.js";
import type { AnalysisSettings } from "@fx/plan-data";
import { reportError } from "@fx/telemetry";
import { DISCOVERY_ANALYST_ROLE, VERIFIER_WORKDIR, readExecutionMode, type StartAgentRunInput } from "@fx/runner";
import type { RunStarter } from "./preview.js";
import type { SeatRequest, SeatResult } from "./seat.js";
import type { VerifyRepoReader } from "./proposalVerify.js";

/**
 * D#483 S4-f3: the docs-and-code analysis pass, a second pass in the claim verifier's 15-minute tick (no cron of its own). It has the shape of
 * `createProposalVerifySweep`, under its own advisory lock. The pipeline decides everything here (R-597-1): the model's output is only parsed,
 * and the one thing written from it is `mergeCandidates` (new `pending` inbox rows). Nothing here creates a work item, an action request or a
 * start, changes a proposal's decision, or imports the stage driver. Nothing in production queues an analysis yet (OD-C25-4); tests do.
 *
 *  1. `discovery_analysis_list_due` (0950) names the analyses waiting (sandbox repositories only; ids).
 *  2. Per analysis, under its tenant, with `attempts` the attempts used so far (a run started, or a seat that refused):
 *     - The current attempt's run (`docs-code-analysis:<id>:<attempts>`) still going: wait.
 *     - It ended: the repository is looked at again (connected, discovery on, account active; else the analysis ends `skipped` and NOTHING is
 *       merged). A run that succeeded at the row's pinned sha is parsed; a rejected envelope ends the analysis `failed` / `output_rejected` with
 *       nothing written, otherwise `mergeCandidates` writes and the analysis ends `succeeded` with its counts. A run that failed, timed out, was
 *       killed at its cap, was cancelled or was refused at admit has used its attempt: the third is the last (`run_*` code), else the next starts.
 *     - No run to answer: the repository is looked at; the default branch's head is read and must still be the row's (`head_moved`); the shared
 *       daily rule holds it (`daily_cap`, still queued, nothing reserved); the seat is resolved (purpose "analyse": `analysisPerRunUsd` is the
 *       run's cap and its reservation; a refusal uses an attempt) and the run starts on the pinned commit, read-only.
 *  3. Only `sandbox` repositories run here: the lister leaves the others out and `readExecutionMode` is the second lock.
 * Analysis is off without `analysisPerRunUsd` (`analysis_unconfigured`); the verifier pass does not read that figure.
 */

export const ANALYSIS_LIST_LIMIT = 50;
/** A pass stops starting analyses after this long, leaving the rest to the next tick. */
export const ANALYSIS_PASS_BUDGET_MS = 40_000;
export const MAX_ANALYSIS_ATTEMPTS = 3;
const MAX_EXISTING_SHOWN = 50;
const SWEEP_LOCK = "fx:docs_code_analysis_sweep";
const ENDED = new Set(["succeeded", "refused_spend", "failed", "timed_out", "killed_spend", "cancelled"]);
const SHA_RE = /^[0-9a-f]{40}$/;

/** What pipeline's `parseAnalystOutput` answers (this package does not import @fx/pipeline). */
export type AnalystParse = { ok: true; candidates: AnalysisCandidate[] } | { ok: false; reason: "output_rejected" };

export interface DocsCodeAnalysisDeps {
  /** The runner login's pool (it holds EXECUTE on the list and, as a member of app_user, the importer's SET ROLE). */
  pool: Pool;
  resolveSeat: (request: SeatRequest) => Promise<SeatResult>;
  /** The production run starter, idempotent on the key; sandbox-only (`queued: "refuse"`). */
  starter: RunStarter;
  github: (target: { repoId: string; owner: string; name: string }) => VerifyRepoReader;
  /** plan-data's `analysisSettings`. */
  settings: () => AnalysisSettings;
  /** pipeline's `buildAnalystPrompt`. */
  prompt: (input: { owner: string; name: string; sha: string; existing: ReadonlyArray<{ id: string; title: string }> }) => string;
  /** pipeline's `parseAnalystOutput`. */
  parse: (envelope: unknown) => AnalystParse;
  /** Tests only: replaces the cross-account list. */
  list?: () => Promise<Array<{ account_id: string; analysis_id: string }>>;
  now?: () => number;
}

export interface DocsCodeAnalysisCounts {
  /** Why the pass did nothing: analysis is off (`analysis_unconfigured`) or another pass holds the lock (`busy`). */
  idle?: string;
  listed: number;
  started: number;
  waiting: number;
  recorded: number;
  /** Held by the shared `perRepoDailyUsd` rule: the repository's spend today leaves no room for one more reservation. */
  daily_cap: number;
  skipped: number;
  failed: number;
}
type Outcome = "started" | "waiting" | "recorded" | "daily_cap" | "skipped" | "failed";

interface AnalysisRow {
  id: string;
  repo_id: string;
  head_sha: string;
  state: string;
  attempts: number;
  gh_owner: string | null;
  gh_name: string | null;
  installation_id: string | null;
  account_status: string;
  frequency: string | null;
}
interface RunRow {
  id: string;
  status: string;
  head_sha: string | null;
  envelope: unknown;
}

const emptyCounts = (): DocsCodeAnalysisCounts => ({ listed: 0, started: 0, waiting: 0, recorded: 0, daily_cap: 0, skipped: 0, failed: 0 });
const keyOf = (r: Pick<AnalysisRow, "id">, attempt: number): string => analysisRunKey(r.id, attempt);
const requestHash = (r: AnalysisRow, attempt: number): string => createHash("sha256").update(JSON.stringify(["docs-code-analysis", r.id, attempt, r.head_sha])).digest("hex");

async function readAnalysis(client: PoolClient, accountId: string, id: string): Promise<AnalysisRow | undefined> {
  const { rows } = await client.query<AnalysisRow>(
    `SELECT d.id, d.repo_id, d.head_sha, d.state, d.attempts, r.gh_owner, r.gh_name, r.installation_id, a.status AS account_status,
            (SELECT s.frequency FROM discovery_settings s WHERE s.account_id = d.account_id AND s.repo_id = d.repo_id ORDER BY s.version DESC LIMIT 1) AS frequency
       FROM discovery_analyses d JOIN repos r ON r.account_id = d.account_id AND r.id = d.repo_id JOIN accounts a ON a.id = d.account_id
      WHERE d.account_id = $1 AND d.id = $2 AND d.state IN ('queued', 'running')`,
    [accountId, id],
  );
  return rows[0];
}

async function readRun(client: PoolClient, accountId: string, key: string): Promise<RunRow | undefined> {
  const { rows } = await client.query<RunRow>(
    `SELECT r.id, r.status, r.head_sha, r.envelope FROM agent_run_idempotency_keys k JOIN agent_runs r ON r.account_id = k.account_id AND r.id = k.run_id
      WHERE k.account_id = $1 AND k.idempotency_key = $2`,
    [accountId, key],
  );
  return rows[0];
}

/** The closed reason the repository may not be read now, or null. The same four reasons `runDiscovery` records. */
function skipReasonOf(r: AnalysisRow): string | null {
  if (r.installation_id === null) return "repo_not_connected";
  if (r.account_status !== "active") return r.account_status === "unsubscribed" ? "free_preview" : "account_not_active";
  if (r.frequency === "off") return "discovery_off";
  if (!r.gh_owner || !r.gh_name) return "repo_name_unknown";
  return null;
}

const failCodeOf = (status: string): string => (status === "refused_spend" ? "run_refused" : `run_${status}`);

export function createDocsCodeAnalysisSweep(deps: DocsCodeAnalysisDeps): () => Promise<DocsCodeAnalysisCounts> {
  const now = deps.now ?? Date.now;
  const readHead = (r: AnalysisRow): VerifyRepoReader => deps.github({ repoId: r.repo_id, owner: r.gh_owner ?? "", name: r.gh_name ?? "" });

  /** An ended run is answered: merge its candidates, or count the failed attempt. */
  async function settle(settings: Extract<AnalysisSettings, { on: true }>, accountId: string, r: AnalysisRow, run: RunRow): Promise<Outcome> {
    if (!ENDED.has(run.status)) return "waiting";
    // The repository is looked at again before anything is written: one disconnected or switched off while its run went gets nothing.
    const skip = skipReasonOf(r);
    if (skip !== null) {
      await endAnalysis(deps.pool, accountId, r.id, "skipped", skip);
      return "skipped";
    }
    if (run.status === "succeeded" && run.head_sha === r.head_sha) {
      const parsed = deps.parse(run.envelope);
      if (!parsed.ok) {
        await endAnalysis(deps.pool, accountId, r.id, "failed", parsed.reason);
        return "failed";
      }
      let hasLoop: boolean;
      try {
        hasLoop = (await readHead(r).readFile(ENGINE_LOOP_MARKER, r.head_sha)) !== null;
      } catch (err) {
        // GitHub could not be asked: nothing is written; the next pass asks again.
        reportError(err, { stage: "docs_code_analysis.owner" });
        return "waiting";
      }
      const merged = await mergeCandidates(deps.pool, accountId, { repoId: r.repo_id, analysisId: r.id, ownerProcess: decideOwnerProcess({ repoHasEngineLoop: hasLoop, kind: "task" }), candidates: parsed.candidates });
      if (merged.state === "skipped") {
        await endAnalysis(deps.pool, accountId, r.id, "skipped", merged.reason);
        return "skipped";
      }
      await endAnalysis(deps.pool, accountId, r.id, "succeeded", null, { ...merged.counts, candidates: parsed.candidates.length });
      return "recorded";
    }
    // Failed, timed out, killed at its cap, cancelled, refused at admit, or a run at another commit: the attempt is used.
    if (r.attempts >= MAX_ANALYSIS_ATTEMPTS) {
      await endAnalysis(deps.pool, accountId, r.id, "failed", run.status === "succeeded" ? "run_head_mismatch" : failCodeOf(run.status));
      return "failed";
    }
    return begin(settings, accountId, r);
  }

  /** Starts the next attempt's run (see the header). */
  async function begin(settings: Extract<AnalysisSettings, { on: true }>, accountId: string, r: AnalysisRow): Promise<Outcome> {
    if (r.attempts >= MAX_ANALYSIS_ATTEMPTS) {
      await endAnalysis(deps.pool, accountId, r.id, "failed", "attempts_exhausted");
      return "failed";
    }
    const skip = skipReasonOf(r);
    if (skip !== null) {
      await endAnalysis(deps.pool, accountId, r.id, "skipped", skip);
      return "skipped";
    }
    // Only our sandbox runs here. The lister already leaves the others out; this is the second lock, and such an analysis stays queued.
    if ((await readExecutionMode(deps.pool, accountId, r.repo_id)) !== "sandbox") return "skipped";
    const repo = { repoId: r.repo_id, owner: r.gh_owner!, name: r.gh_name! };
    const attempt = r.attempts + 1;
    const key = keyOf(r, attempt);
    // A run already made for this attempt (a pass that died between the start and the note) is adopted, not paid for twice.
    const made = await withTenant(deps.pool, accountId, (client) => readRun(client, accountId, key));
    let runId = made?.id;
    if (runId === undefined) {
      let sha: string;
      try {
        sha = await deps.github(repo).headSha();
      } catch (err) {
        // GitHub could not be asked: nothing was spent and no attempt is used; the next pass asks again.
        reportError(err, { stage: "docs_code_analysis.head" });
        return "skipped";
      }
      if (!SHA_RE.test(sha) || !SHA_RE.test(r.head_sha)) return "skipped";
      if (sha !== r.head_sha) {
        await endAnalysis(deps.pool, accountId, r.id, "skipped", "head_moved");
        return "skipped";
      }
      // The shared daily rule (verifier and analyst spend, one counter) is read before anything is reserved.
      const over = await withTenant(deps.pool, accountId, (client) => overRepoDailyUsd(client, accountId, r.repo_id, settings.analysisPerRunUsd, settings.perRepoDailyUsd));
      if (over) {
        await holdAnalysis(deps.pool, accountId, r.id, "daily_cap");
        return "daily_cap";
      }
      const cap = settings.analysisPerRunUsd;
      const seat = await deps.resolveSeat({ accountId, role: DISCOVERY_ANALYST_ROLE, repoId: r.repo_id, purpose: "analyse", capUsd: cap });
      if (!seat.ok) return useAttempt(accountId, r, seat.reason);
      if (seat.seat.capUsd !== cap || seat.seat.spend.estimateModelUsd !== cap || seat.seat.spend.perSpawnCapUsd !== cap) return "skipped";
      const existing = await withTenant(deps.pool, accountId, async (client) =>
        (await client.query<{ id: string; title: string }>("SELECT id, title FROM proposals WHERE account_id = $1 AND repo_id = $2 ORDER BY created_at DESC, id LIMIT $3", [accountId, r.repo_id, MAX_EXISTING_SHOWN])).rows,
      );
      const input: StartAgentRunInput = {
        ...seat.seat,
        accountId,
        repoId: r.repo_id,
        role: DISCOVERY_ANALYST_ROLE,
        product: "team",
        expectedExecutionMode: "sandbox",
        prompt: deps.prompt({ owner: repo.owner, name: repo.name, sha, existing }),
        workdir: VERIFIER_WORKDIR,
        // The pinned commit, not the default branch: the agent reads exactly the tree the row names, or the launch fails.
        cloneRepo: { owner: repo.owner, name: repo.name, sha },
        headSha: sha,
        idempotency: { key, requestHash: requestHash(r, attempt) },
      };
      try {
        runId = (await deps.starter.start(input)).runId;
      } catch (err) {
        // A launch that failed (the commit could not be fetched, say) has still made its run row, which has ended: that attempt is used and answered below.
        const failed = await withTenant(deps.pool, accountId, (client) => readRun(client, accountId, key));
        if (failed === undefined) throw err;
        reportError(err, { stage: "docs_code_analysis.launch" });
        runId = failed.id;
      }
    }
    const noted = r.state === "queued" ? await startAnalysis(deps.pool, accountId, r.id, runId) : await noteAnalysisAttempt(deps.pool, accountId, r.id, runId, null);
    if (!noted) return "skipped";
    // A run refused at admit has already ended: answer it now rather than on the next pass.
    const after = await withTenant(deps.pool, accountId, (client) => readRun(client, accountId, key));
    if (after === undefined || !ENDED.has(after.status)) return "started";
    const fresh = await withTenant(deps.pool, accountId, (client) => readAnalysis(client, accountId, r.id));
    return fresh === undefined ? "skipped" : settle(settings, accountId, fresh, after);
  }

  /** A seat that refused counts an attempt; the third is the last and the analysis ends with the seat's code. */
  async function useAttempt(accountId: string, r: AnalysisRow, code: string): Promise<Outcome> {
    await noteAnalysisAttempt(deps.pool, accountId, r.id, null, code);
    if (r.attempts + 1 >= MAX_ANALYSIS_ATTEMPTS) await endAnalysis(deps.pool, accountId, r.id, "failed", code);
    return "failed";
  }

  async function analyseOne(settings: Extract<AnalysisSettings, { on: true }>, accountId: string, analysisId: string): Promise<Outcome> {
    const found = await withTenant(deps.pool, accountId, async (client) => {
      const r = await readAnalysis(client, accountId, analysisId);
      if (!r) return null;
      return { r, run: r.attempts > 0 ? await readRun(client, accountId, keyOf(r, r.attempts)) : undefined };
    });
    if (found === null) return "skipped";
    return found.run !== undefined ? settle(settings, accountId, found.r, found.run) : begin(settings, accountId, found.r);
  }

  return async function sweepDocsCodeAnalysis(): Promise<DocsCodeAnalysisCounts> {
    const counts = emptyCounts();
    let settings: AnalysisSettings;
    try {
      settings = deps.settings();
    } catch (err) {
      // Fail closed: settings that cannot be read analyse nothing. The next tick asks again.
      reportError(err, { stage: "docs_code_analysis.settings" });
      return { ...counts, idle: "analysis_settings_failed" };
    }
    if (!settings.on) return { ...counts, idle: settings.code };
    // One pass at a time: a transaction-scoped try-lock on its own connection, held for the whole pass (the pool needs one more free connection).
    const lock = await deps.pool.connect();
    try {
      await lock.query("BEGIN");
      const got = await lock.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [SWEEP_LOCK]);
      if (got.rows[0]?.ok !== true) return { ...counts, idle: "busy" };
      const rows = deps.list ? await deps.list() : (await deps.pool.query<{ account_id: string; analysis_id: string }>("SELECT account_id, analysis_id FROM discovery_analysis_list_due($1::integer)", [ANALYSIS_LIST_LIMIT])).rows;
      counts.listed = rows.length;
      const startedAt = now();
      for (const r of rows) {
        if (now() - startedAt > ANALYSIS_PASS_BUDGET_MS) break;
        try {
          counts[await analyseOne(settings, r.account_id, r.analysis_id)] += 1;
        } catch (err) {
          // One analysis that cannot be run never holds up the rest; it is listed again next pass.
          reportError(err, { stage: "docs_code_analysis.item" });
          counts.failed += 1;
        }
      }
      return counts;
    } finally {
      await lock.query("COMMIT").catch((err: unknown) => reportError(err, { stage: "docs_code_analysis.unlock" }));
      lock.release();
    }
  };
}
