import type { PoolClient } from 'pg';

/**
 * D#6 R2b-5a (C32 section 5): the read side of `runner_run_usage` (migration 0768), shared by the run DTO and the run insight.
 *
 * What a run on a person's own machine would have cost at API prices. INFORMATION, NEVER SPEND: it is kept in a table of its own that no
 * metering, billing, budget or refusal query reads, and nothing here adds it to a spend field. `api_equivalent_usd` is the cloud's own
 * recomputation from the token counts, or null for a model with no price row (the app then says "no API price for this model").
 */
export interface RunnerUsage {
  /** `subscription` (the person's Claude plan) or `api_key` (their own API key): the one the runner had when the run ran. */
  credential_mode: 'subscription' | 'api_key';
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  api_equivalent_usd: number | null;
  price_table_version: string | null;
}

/** A SELECT-list item for a query over `agent_runs` (unaliased): the run's usage as one JSON object, or NULL when it has none. */
export const RUNNER_USAGE_COLUMN = `(SELECT jsonb_build_object(
      'credential_mode', u.credential_mode, 'model', u.model,
      'tokens_in', u.input_tokens, 'tokens_out', u.output_tokens,
      'cache_read_tokens', u.cache_read_tokens, 'cache_write_tokens', u.cache_write_tokens,
      'api_equivalent_usd', u.api_equivalent_usd, 'price_table_version', u.price_table_version)
    FROM runner_run_usage u WHERE u.account_id = agent_runs.account_id AND u.run_id = agent_runs.id) AS runner_usage_json`;

/** The object a run of this runtime carries: undefined for any runtime but `runner` (a sandbox run has no such field), else the object or null. */
export function toRunnerUsage(runtime: string, json: unknown): RunnerUsage | null | undefined {
  if (runtime !== 'runner') return undefined;
  if (typeof json !== 'object' || json === null) return null;
  const j = json as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    credential_mode: j.credential_mode === 'api_key' ? 'api_key' : 'subscription',
    model: typeof j.model === 'string' ? j.model : null,
    tokens_in: n(j.tokens_in),
    tokens_out: n(j.tokens_out),
    cache_read_tokens: n(j.cache_read_tokens),
    cache_write_tokens: n(j.cache_write_tokens),
    api_equivalent_usd: typeof j.api_equivalent_usd === 'number' ? j.api_equivalent_usd : null,
    price_table_version: typeof j.price_table_version === 'string' ? j.price_table_version : null,
  };
}

/**
 * The stats endpoint's figure: the API-equivalent of the runner runs recorded in `[from, to)`, for one repo when `repoId` is given (the repo
 * of the run's work item, else the repo it was dispatched on). Runs on the caller's tenant client, so RLS confines it to the account.
 * INFORMATION, NEVER SPEND: the stats KPIs never read this, and it is returned beside `metrics`, not inside it. There is no per-repo
 * endpoint, so this repo filter is the per-repo aggregate. Rounded to the table's four decimals; a run with no price adds nothing.
 */
export async function runnerApiEquivalentUsd(client: PoolClient, input: { from: Date; to: Date; repoId: string | null }): Promise<number> {
  const { rows } = await client.query<{ sum: string }>(
    `SELECT COALESCE(SUM(u.api_equivalent_usd), 0)::text AS sum
       FROM runner_run_usage u
       JOIN agent_runs ar ON ar.account_id = u.account_id AND ar.id = u.run_id
       LEFT JOIN work_items wi ON wi.account_id = ar.account_id AND wi.id = ar.work_item_id
      WHERE u.recorded_at >= $1 AND u.recorded_at < $2
        AND ($3::uuid IS NULL OR COALESCE(wi.repo_id, ar.dispatch_repo_id) = $3::uuid)`,
    [input.from, input.to, input.repoId],
  );
  return Math.round(Number(rows[0]?.sum ?? 0) * 10000) / 10000;
}

/**
 * D#6 C42-3 (the run-level twin of C42-5's item states): what a finished runner run's cost figure is, so a screen never draws a missing figure
 * as $0. `recorded`: tokens and a price. `not_priced`: tokens, but no API price for the run's model. `not_recorded`: the run ended and reported no
 * usage. A run still going has no state yet (null): its usage may still arrive.
 */
export type RunnerUsageState = 'recorded' | 'not_priced' | 'not_recorded';

/** The words every screen shows beside a state that has no dollar figure, written once so the Pipeline and the Runs app cannot differ. */
export const RUNNER_USAGE_NOTE: Readonly<Record<Exclude<RunnerUsageState, 'recorded'>, string>> = Object.freeze({
  not_recorded: 'This run ended without reporting how many tokens it used, so there is no cost estimate. That is not the same as $0.',
  not_priced: "The tokens were recorded, but there is no API price for this run's model, so no dollar estimate is shown. That is not the same as $0.",
});

/** Still going: the same test the work item's own figure applies (`NOT IN ('pending', 'running')` in work-items/read.ts), so a run is never finished here and live there. */
const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set(['pending', 'running']);

/** Pure. The state and note of a runner run from its status and its usage object (`toRunnerUsage`'s answer), or null for a run that is not a runner run. */
export function runnerUsageStateOf(runtime: string, status: string, usage: RunnerUsage | null | undefined): { state: RunnerUsageState | null; note: string | null } | null {
  if (runtime !== 'runner') return null;
  if (usage) return usage.api_equivalent_usd === null ? { state: 'not_priced', note: RUNNER_USAGE_NOTE.not_priced } : { state: 'recorded', note: null };
  return LIVE_RUN_STATUSES.has(status) ? { state: null, note: null } : { state: 'not_recorded', note: RUNNER_USAGE_NOTE.not_recorded };
}
