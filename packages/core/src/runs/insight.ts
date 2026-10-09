import { NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';
import { resolveRunLimits } from '../run-limits/resolve.js';
import type { RunLimits } from '../run-limits/types.js';
import { ACTIVITY_LIMITS, capText, readRunLines, type ActivityLine } from '../work-items/activity.js';
import type { RunsReadCtx } from './read.js';
import { RUNNER_USAGE_COLUMN, toRunnerUsage, type RunnerUsage } from './runnerUsage.js';

/**
 * D#483 P5: everything the Runs app's detail shows about ONE run that `GET /api/v1/runs/{id}` does not carry: the agent's
 * outcome (read from the run's AGENT_OUTPUT envelope: only `summary`, `verdict`, `findings`, `branch` and the PR number),
 * the cost split by who pays, the activity lines, and the run's facts. Read only; nothing is derived from the clock, and a
 * value that was not recorded is null (the app says nothing rather than guessing).
 *
 * Model text (the summary, a finding) is returned as plain text, cut to its cap, for the caller to show as text only.
 * Activity lines come from `readRunLines`, the same reader the Pipeline detail uses, so a command line is checked in
 * one place.
 */
export const INSIGHT_LIMITS = {
  maxFindings: 20,
  maxFindingChars: 1000,
  maxLinked: 10,
} as const;

export type CostSource = 'operator_subscription' | 'customer_gateway' | 'customer_anthropic' | 'sandbox' | 'workflow';
const COST_SOURCES: readonly string[] = ['operator_subscription', 'customer_gateway', 'customer_anthropic', 'sandbox', 'workflow'];

export interface LinkedRun {
  id: string;
  role: string;
  status: string;
  created_at: string;
}
export interface RunInsight {
  /** The server's clock when this was read: a running run's duration is measured to it, never to the viewer's clock. */
  server_time: string;
  run: {
    id: string;
    role: string;
    status: string;
    runtime: string;
    execution_mode: string | null;
    model: string | null;
    head_sha: string | null;
    created_at: string;
    started_at: string | null;
    ended_at: string | null;
  };
  work_item: { id: string; stage: string; issue_number: number | null; repo: { owner: string; name: string } | null } | null;
  pr_number: number | null;
  /**
   * The fixed code the run's last failing status change recorded (`run.status_changed` payload `failureReason`), or null
   * when the run did not fail or recorded none. A code, never free text: the app maps it to a sentence.
   */
  failure_reason: string | null;
  /** Null when the run recorded no envelope. */
  outcome: {
    summary: string | null;
    verdict: string | null;
    findings: string[];
    findings_truncated: boolean;
    branch: string | null;
  } | null;
  cost: {
    model: { usd: number | null; source: CostSource | null; tokens_in: number | null; tokens_out: number | null };
    compute: { usd: number | null; source: CostSource | null };
  };
  lines: ActivityLine[];
  lines_truncated: boolean;
  /** The limits now in effect for this role: the run itself does not record the limits it started with. */
  limits: RunLimits;
  parent: LinkedRun | null;
  escalated_from: LinkedRun | null;
  children: LinkedRun[];
  /**
   * D#221 OM-2c: the outside meter's verdict for this run, one of five states, never null. `off` is a run that was never
   * tagged (the setting was off, or it is not on the AI Gateway). `added_usd` is the true-up posted, when one was. The sentence is
   * made from these by the API (it holds the wording); the tag itself is never read here.
   */
  outside_meter: { state: 'pending' | 'matches' | 'higher' | 'unavailable' | 'off'; reason: string | null; added_usd: number | null };
  /** D#6 R2b-5a: a runner run only (absent on any other): what it would have cost at API prices. Information; never part of `cost`, which stays spend. */
  runner_usage?: RunnerUsage | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERDICT_RE = /^[a-z][a-z_-]{0,23}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const FAILURE_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SHA_RE = /^[0-9a-f]{7,64}$/i;

interface RunRow {
  id: string;
  work_item_id: string | null;
  parent_run_id: string | null;
  escalated_from_run_id: string | null;
  role: string;
  status: string;
  runtime: string;
  execution_mode: string | null;
  model: string | null;
  head_sha: string | null;
  usd: string | null;
  tokens_in: string | null;
  tokens_out: string | null;
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  dispatch_pr_number: string | null;
  has_envelope: boolean;
  summary: string | null;
  verdict: string | null;
  branch: string | null;
  env_pr: string | null;
  findings: unknown;
  om_state: string | null;
  om_reason: string | null;
  om_true_up_usd: string | null;
  runner_usage_json: unknown;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const num = (v: string | null): number | null => (v === null ? null : Number(v));
const OM_STATES = ['pending', 'matches', 'higher', 'unavailable'] as const;
function outsideMeterOf(r: Pick<RunRow, 'om_state' | 'om_reason' | 'om_true_up_usd'>): RunInsight['outside_meter'] {
  const state = OM_STATES.find((s) => s === r.om_state);
  if (state === undefined) return { state: 'off', reason: null, added_usd: null };
  const added = num(r.om_true_up_usd);
  return {
    state,
    reason: state === 'unavailable' ? (r.om_reason ?? 'unknown') : null,
    added_usd: (state === 'higher' || state === 'unavailable') && added !== null && added > 0 ? added : null,
  };
}
const costSource = (s: string): CostSource | null => (COST_SOURCES.includes(s) ? (s as CostSource) : null);

export async function getRunInsight(ctx: RunsReadCtx, id: string): Promise<RunInsight> {
  if (!UUID_RE.test(id)) throw new NotFoundError(`run ${id} not found`);
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    const r = (
      await client.query<RunRow>(
        `SELECT id, work_item_id, parent_run_id, escalated_from_run_id, role, status, runtime, execution_mode, model, head_sha,
                usd, tokens_in, tokens_out, created_at, started_at, ended_at, dispatch_pr_number::text AS dispatch_pr_number,
                (envelope IS NOT NULL AND jsonb_typeof(envelope) = 'object') AS has_envelope,
                left(envelope->>'summary', $2::int) AS summary,
                left(envelope->>'verdict', 25) AS verdict,
                left(envelope->>'branch', 201) AS branch,
                CASE WHEN envelope->>'pr_number' ~ '^[0-9]{1,9}$' THEN envelope->>'pr_number'
                     WHEN envelope->>'pr' ~ '^[0-9]{1,9}$' THEN envelope->>'pr' END AS env_pr,
                -- Only the first findings, each one a string or the text of an object, cut here so a huge envelope costs nothing.
                CASE WHEN jsonb_typeof(envelope->'findings') = 'array' THEN (
                  SELECT jsonb_agg(CASE WHEN jsonb_typeof(f) = 'string' THEN left(f #>> '{}', $3::int)
                                        WHEN jsonb_typeof(f) = 'object' THEN left(COALESCE(f->>'text', f->>'message', f->>'title', f->>'description'), $3::int)
                                   END)
                    FROM (SELECT f FROM jsonb_array_elements(envelope->'findings') AS f LIMIT $4::int) s
                ) END AS findings,
                om_state, om_reason, om_true_up_usd, ${RUNNER_USAGE_COLUMN}
           FROM agent_runs WHERE id = $1::uuid`,
        [id, ACTIVITY_LIMITS.maxSummaryChars + 1, INSIGHT_LIMITS.maxFindingChars + 1, INSIGHT_LIMITS.maxFindings + 1],
      )
    ).rows[0];
    if (!r) throw new NotFoundError(`run ${id} not found`);

    const w = r.work_item_id
      ? (
          await client.query<{ stage: string; gh_number: string | null; gh_owner: string | null; gh_name: string | null }>(
            `SELECT w.stage, w.gh_number, rp.gh_owner, rp.gh_name
               FROM work_items w LEFT JOIN repos rp ON rp.account_id = w.account_id AND rp.id = w.repo_id
              WHERE w.id = $1::uuid`,
            [r.work_item_id],
          )
        ).rows[0]
      : undefined;

    const ledger = (
      await client.query<{ kind: string; source: string; usd: string }>(
        `SELECT kind, source, sum(usd) AS usd FROM ledger WHERE run_id = $1::uuid GROUP BY kind, source`,
        [id],
      )
    ).rows;
    const modelRows = ledger.filter((l) => l.kind === 'model');
    const computeRows = ledger.filter((l) => l.kind === 'compute');
    const modelSource = costSource(modelRows.find((l) => l.source === 'operator_subscription')?.source ?? modelRows[0]?.source ?? '');
    // A run on the operator's subscription is not billed per token: its model cost is not a number, so none is shown.
    const modelUsd = modelSource === 'operator_subscription' ? null : modelRows.length > 0 ? modelRows.reduce((n, l) => n + Number(l.usd), 0) : num(r.usd);

    const { linesByRun, capped } = await readRunLines(client, [id]);

    const linked = async (where: string, param: string): Promise<LinkedRun[]> =>
      (
        await client.query<{ id: string; role: string; status: string; created_at: Date }>(
          `SELECT id, role, status, created_at FROM agent_runs WHERE ${where} ORDER BY created_at, id LIMIT ${INSIGHT_LIMITS.maxLinked}`,
          [param],
        )
      ).rows.map((x) => ({ id: x.id, role: x.role, status: x.status, created_at: x.created_at.toISOString() }));
    const parent = r.parent_run_id ? (await linked('id = $1::uuid', r.parent_run_id))[0] ?? null : null;
    const escalatedFrom = r.escalated_from_run_id ? (await linked('id = $1::uuid', r.escalated_from_run_id))[0] ?? null : null;
    const children = await linked('parent_run_id = $1::uuid', id);

    const limits = await resolveRunLimits(client, { accountId, role: r.role });
    const now = (await client.query<{ now: Date }>('SELECT now() AS now')).rows[0]!.now;

    const findingList = Array.isArray(r.findings) ? (r.findings as unknown[]).filter((f): f is string => typeof f === 'string' && f.trim() !== '') : [];
    // An executor's dispatch target is the ISSUE number (the build and its fix rounds record it), never a pull request:
    // its PR number can only come from its own envelope. Every other role's dispatch target is a real PR.
    const prText = r.role === 'executor' ? r.env_pr : (r.dispatch_pr_number ?? r.env_pr);

    const failureCode = (
      await client.query<{ code: string | null }>(
        `SELECT left(payload->>'failureReason', 65) AS code FROM run_events
          WHERE run_id = $1::uuid AND kind = 'run.status_changed' AND payload ? 'failureReason'
          ORDER BY seq DESC LIMIT 1`,
        [id],
      )
    ).rows[0]?.code;

    const runnerUsage = toRunnerUsage(r.runtime, r.runner_usage_json);
    return {
      server_time: now.toISOString(),
      run: {
        id: r.id,
        role: r.role,
        status: r.status,
        runtime: r.runtime,
        execution_mode: r.execution_mode,
        model: r.model,
        head_sha: r.head_sha !== null && SHA_RE.test(r.head_sha) ? r.head_sha : null,
        created_at: r.created_at.toISOString(),
        started_at: iso(r.started_at),
        ended_at: iso(r.ended_at),
      },
      work_item: r.work_item_id && w
        ? {
            id: r.work_item_id,
            stage: w.stage,
            issue_number: w.gh_number === null ? null : Number(w.gh_number),
            repo: w.gh_owner && w.gh_name ? { owner: w.gh_owner, name: w.gh_name } : null,
          }
        : null,
      pr_number: prText === null ? null : Number(prText),
      failure_reason: failureCode != null && FAILURE_CODE_RE.test(failureCode) ? failureCode : null,
      outcome: r.has_envelope
        ? {
            summary: r.summary && r.summary.trim() !== '' ? capText(r.summary, ACTIVITY_LIMITS.maxSummaryChars) : null,
            verdict: r.verdict !== null && VERDICT_RE.test(r.verdict) ? r.verdict : null,
            findings: findingList.slice(0, INSIGHT_LIMITS.maxFindings).map((f) => capText(f, INSIGHT_LIMITS.maxFindingChars)),
            findings_truncated: findingList.length > INSIGHT_LIMITS.maxFindings,
            branch: r.branch !== null && BRANCH_RE.test(r.branch) ? r.branch : null,
          }
        : null,
      cost: {
        model: { usd: modelUsd, source: modelSource, tokens_in: num(r.tokens_in), tokens_out: num(r.tokens_out) },
        compute: {
          usd: computeRows.length > 0 ? computeRows.reduce((n, l) => n + Number(l.usd), 0) : null,
          source: costSource(computeRows[0]?.source ?? ''),
        },
      },
      lines: linesByRun.get(id) ?? [],
      lines_truncated: capped.has(id),
      limits,
      parent,
      escalated_from: escalatedFrom,
      children,
      outside_meter: outsideMeterOf(r),
      ...(runnerUsage === undefined ? {} : { runner_usage: runnerUsage }),
    };
  });
}
