import type { PoolClient } from 'pg';
import { percentileCont, round } from '@fx/stats';
import { runnerUsageStateOf, toRunnerUsage, type RunnerUsageState } from '../runs/runnerUsage.js';

/**
 * Engine bridge EB-4: the read side of what a person's engine reported (migration 1027). Every figure here is the cloud's own: dollars come from
 * `engine_agent_usage.api_equivalent_usd` (priced by `priceUsageTotals`, the step runner runs use), counts come from the stored agents, and the median and p90
 * come from `percentileCont` in `@fx/stats`. INFORMATION, NEVER SPEND: no cap, reservation or envelope reads any of it. A figure that is missing is a
 * state with its note (`RUNNER_USAGE_NOTE`), never a zero. Runs on the caller's tenant client, so row security confines it to the account.
 */
export interface EngineUsageRow {
  subject_kind: 'agent' | 'tick';
  subject_id: string;
  model: string | null;
  credential_mode: 'subscription' | 'api_key' | null;
  /** Null for an agent that stopped without reporting its usage. */
  tokens: { input: number; output: number; cache_read: number; cache_write: number } | null;
  api_equivalent_usd: number | null;
  state: RunnerUsageState | null;
  /** The words to show beside a state that has no dollar figure (`RUNNER_USAGE_NOTE`); null when there is a figure. */
  note: string | null;
  provenance: { session_id: string; seqs: number[] };
}

interface Window {
  from: Date;
  to: Date;
  /** One repo, or null for every repo of the account. */
  repoId: string | null;
}

/** The usage of agents and ticks recorded in `[from, to)`, plus every agent that stopped in the window with no usage at all (`not_recorded`), and the total of the figures. */
export async function readEngineUsage(client: PoolClient, w: Window): Promise<{ rows: EngineUsageRow[]; total_api_equivalent_usd: number }> {
  const used = await client.query(
    `SELECT u.subject_kind, u.subject_id, u.session_id, u.model, u.credential_mode, u.source_seqs,
            u.input_tokens::text AS input, u.output_tokens::text AS output, u.cache_read_tokens::text AS cache_read, u.cache_write_tokens::text AS cache_write,
            u.api_equivalent_usd::text AS usd, u.price_table_version
       FROM engine_agent_usage u JOIN engine_sessions s ON s.id = u.session_id
      WHERE u.recorded_at >= $1 AND u.recorded_at < $2 AND ($3::uuid IS NULL OR s.repo_id = $3::uuid)
      ORDER BY u.recorded_at, u.subject_kind, u.subject_id`,
    [w.from, w.to, w.repoId],
  );
  const rows: EngineUsageRow[] = used.rows.map((r) => {
    const usage = toRunnerUsage('runner', {
      credential_mode: r.credential_mode,
      model: r.model,
      tokens_in: Number(r.input),
      tokens_out: Number(r.output),
      cache_read_tokens: Number(r.cache_read),
      cache_write_tokens: Number(r.cache_write),
      api_equivalent_usd: r.usd === null ? null : Number(r.usd),
      price_table_version: r.price_table_version,
    });
    const st = runnerUsageStateOf('runner', 'done', usage);
    return {
      subject_kind: r.subject_kind,
      subject_id: r.subject_id,
      model: r.model,
      credential_mode: r.credential_mode,
      tokens: { input: Number(r.input), output: Number(r.output), cache_read: Number(r.cache_read), cache_write: Number(r.cache_write) },
      api_equivalent_usd: usage?.api_equivalent_usd ?? null,
      state: st?.state ?? null,
      note: st?.note ?? null,
      provenance: { session_id: r.session_id, seqs: r.source_seqs.map(Number) },
    };
  });
  const silent = await client.query(
    `SELECT a.agent_id, a.session_id, a.model FROM engine_agents a JOIN engine_sessions s ON s.id = a.session_id
      WHERE a.agent_id IS NOT NULL AND a.stopped_at >= $1 AND a.stopped_at < $2 AND ($3::uuid IS NULL OR s.repo_id = $3::uuid)
        AND NOT EXISTS (SELECT 1 FROM engine_agent_usage u WHERE u.session_id = a.session_id AND u.subject_kind = 'agent' AND u.subject_id = a.agent_id)
      ORDER BY a.stopped_at, a.agent_id`,
    [w.from, w.to, w.repoId],
  );
  const gone = runnerUsageStateOf('runner', 'done', null);
  for (const r of silent.rows) {
    rows.push({
      subject_kind: 'agent',
      subject_id: r.agent_id,
      model: r.model,
      credential_mode: null,
      tokens: null,
      api_equivalent_usd: null,
      state: gone?.state ?? null,
      note: gone?.note ?? null,
      provenance: { session_id: r.session_id, seqs: [] },
    });
  }
  const total = rows.reduce((n, r) => n + (r.api_equivalent_usd ?? 0), 0);
  return { rows, total_api_equivalent_usd: round(total, 4) };
}

export interface EngineAgentStats {
  /** Agents counted by role, for agents that started (or, with no start seen, stopped) in the window. */
  agents_by_role: Record<string, number>;
  /** Over the agents that reported a duration. Null when none did. */
  duration_s: { n: number; median: number | null; p90: number | null };
}

export async function readEngineAgentStats(client: PoolClient, w: Window): Promise<EngineAgentStats> {
  const { rows } = await client.query<{ role: string; duration_s: string | null }>(
    `SELECT a.role, a.duration_s::text FROM engine_agents a JOIN engine_sessions s ON s.id = a.session_id
      WHERE COALESCE(a.started_at, a.stopped_at) >= $1 AND COALESCE(a.started_at, a.stopped_at) < $2 AND ($3::uuid IS NULL OR s.repo_id = $3::uuid)`,
    [w.from, w.to, w.repoId],
  );
  const agents_by_role: Record<string, number> = {};
  const durations: number[] = [];
  for (const r of rows) {
    agents_by_role[r.role] = (agents_by_role[r.role] ?? 0) + 1;
    if (r.duration_s !== null) durations.push(Number(r.duration_s));
  }
  const p = (q: number): number | null => {
    const v = percentileCont(durations, q);
    return v === null ? null : round(v, 2);
  };
  return { agents_by_role, duration_s: { n: durations.length, median: p(0.5), p90: p(0.9) } };
}
