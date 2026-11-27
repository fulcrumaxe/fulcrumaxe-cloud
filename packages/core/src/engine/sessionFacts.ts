import type { PoolClient } from 'pg';
import { ENGINE_STOP_REASONS } from '@fulcrumaxe/runner-protocol';

/**
 * D#845 ON-14b: the session and setup facts of each repo of the engine list, and the derived quota state. Everything is derived on every read from the setup row, the sandbox view, the halt marker and the ingest counters;
 * nothing is stamped. Every field is an enum, a count, a timestamp or a machine name a person of the account typed: no text the engine wrote.
 */

/** The ingest definer's day caps (migration 1027 and every later `engine_events_ingest`): 5000 accepted events a session and 20000 a repo per UTC day. A test pins the migration text to these numbers. */
export const SESSION_EVENT_QUOTA = 5000;
export const REPO_EVENT_QUOTA = 20000;

export type StopReasonWord = (typeof ENGINE_STOP_REASONS)[number];
export type StartMode = 'created' | 'resumed' | 'fresh';
export type SessionState = 'never' | 'starting' | 'running' | 'stale' | 'stopped' | 'halted' | 'runner_removed';
export type SetupStatus = 'none' | 'open' | 'done';
export type QuotaState = 'ok' | 'session_full' | 'repo_full';

export interface SetupFacts {
  /** `done` once the install finished, `open` while a setup is under way (or failed and waiting for a retry), `none` for a repo with no setup or a removed one. */
  status: SetupStatus;
  phase: string | null;
  sub_step: string | null;
  state: 'started' | 'ok' | 'failed' | null;
  failure_code: string | null;
}
export interface SessionFacts {
  state: SessionState;
  /** How the newest successful start came up; null while no sandbox of the repo is listed (a deleted session has no row to read it from). */
  last_start_mode: StartMode | null;
  last_start_at: string | null;
  /** The signed reason of the stop that ended the session, only while its sandbox is stopped; null for a reason outside the closed list. */
  stopped_reason: StopReasonWord | null;
  /** When the sandbox last changed state, as the runner's inventory reports it; null with no sandbox. */
  state_at: string | null;
}
export interface QuotaFacts {
  state: QuotaState;
  session_used: number;
  session_limit: number;
  repo_used: number;
  repo_limit: number;
  /** The next 00:00 UTC, when both counters start again. */
  resets_at: string;
}
export interface RepoSessionFacts {
  /** The placed machine's name, or the runner that served the newest session when the repo is not placed; null with neither. */
  machine_name: string | null;
  setup: SetupFacts;
  session: SessionFacts;
  quota: QuotaFacts;
}

/** Pure. The sandbox states a runner reports: `creating`, `running`, `stopped`, `snapshotted` (read as stopped) and `error`, which says nothing about the engine and falls through to liveness. */
export function sessionStateOf(i: { liveness: 'live' | 'stale' | 'runner_removed' | 'never'; halted: boolean; sandbox: string | null }): SessionState {
  if (i.liveness === 'runner_removed') return 'runner_removed';
  if (i.halted) return 'halted';
  if (i.sandbox === 'stopped' || i.sandbox === 'snapshotted') return 'stopped';
  if (i.sandbox === 'creating') return 'starting';
  if (i.liveness === 'live') return 'running';
  if (i.liveness === 'stale') return 'stale';
  return i.sandbox === 'running' ? 'starting' : 'never';
}

/** Pure. A counter from a day other than today's is 0: the ingest resets it on the first event of a new UTC day, and a read must not wait for that event. A repo at its cap shows before a session at its own. */
export function quotaOf(i: { today: string; sessionDay: string | null; sessionCount: number; repoDay: string | null; repoCount: number; resetsAt: Date }): QuotaFacts {
  const session_used = i.sessionDay === i.today ? i.sessionCount : 0;
  const repo_used = i.repoDay === i.today ? i.repoCount : 0;
  const state: QuotaState = repo_used >= REPO_EVENT_QUOTA ? 'repo_full' : session_used >= SESSION_EVENT_QUOTA ? 'session_full' : 'ok';
  return { state, session_used, session_limit: SESSION_EVENT_QUOTA, repo_used, repo_limit: REPO_EVENT_QUOTA, resets_at: i.resetsAt.toISOString() };
}

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

export interface SessionFactKey {
  accountId: string;
  repoId: string;
  liveness: 'live' | 'stale' | 'runner_removed' | 'never';
  halted: boolean;
  /** The name of the runner that served the newest session, the fallback for a repo that is not placed. */
  runnerName: string | null;
}

/**
 * The facts for every listed repo, in one query keyed on (account, repo) pairs: each table is joined on both ids, on top of row security, so a repo id of another account (or a second repo of this one) reads nothing.
 * Returned in the order of `keys`.
 */
export async function readRepoSessionFacts(client: PoolClient, keys: SessionFactKey[], unnamedMember: string): Promise<RepoSessionFacts[]> {
  if (keys.length === 0) return [];
  const { rows } = await client.query(
    `SELECT k.ord, ps.phase AS setup_phase, ps.sub_step AS setup_sub_step, ps.state AS setup_state, ps.failure_code AS setup_failure_code,
            sb.state AS sandbox_state, sb.state_at AS sandbox_state_at, sb.stopped_reason, sb.last_start_mode, sb.last_start_at,
            pl.runner_id AS placed_runner, rs.name AS placed_name, COALESCE(NULLIF(ru.name, ''), NULLIF(ru.github_login, ''), $3) AS placed_registrant,
            es.quota_count AS session_count, eq.quota_day::text AS repo_day, COALESCE(eq.quota_count, 0) AS repo_count,
            (now() AT TIME ZONE 'utc')::date::text AS today, (((now() AT TIME ZONE 'utc')::date + 1)::timestamp AT TIME ZONE 'utc') AS resets_at
       FROM unnest($1::uuid[], $2::uuid[]) WITH ORDINALITY AS k(account_id, repo_id, ord)
       -- The repo's newest setup; a removed one is no setup.
       LEFT JOIN LATERAL (SELECT s.phase, s.sub_step, s.state, s.failure_code FROM project_setups s
                           WHERE s.account_id = k.account_id AND s.repo_id = k.repo_id ORDER BY s.created_at DESC, s.id DESC LIMIT 1) ps ON true
       LEFT JOIN project_placements pl ON pl.account_id = k.account_id AND pl.repo_id = k.repo_id
       -- The repo's sandbox listing: the placed runner's first (a repo moved between machines can list two, and a late change on the old machine's leftover must not win), then the newest.
       LEFT JOIN LATERAL (SELECT e.state, e.state_at, e.stopped_reason, e.last_start_mode, e.last_start_at FROM engine_session_sandboxes e
                           WHERE e.account_id = k.account_id AND e.repo_id = k.repo_id ORDER BY (e.runner_id = pl.runner_id) DESC NULLS LAST, e.state_at DESC, e.sandbox_name LIMIT 1) sb ON true
       LEFT JOIN runners rn ON rn.account_id = pl.account_id AND rn.id = pl.runner_id
       LEFT JOIN runner_settings rs ON rs.account_id = rn.account_id AND rs.runner_id = rn.id
       LEFT JOIN users ru ON ru.id = rn.registered_by
       -- The counters that pause uploads: ingest caps every session kind (engine, bridge, detail) at its own 5000 a day and the runner holds the whole repo on any of them, so the binding count is the highest of the newest session of each kind.
       LEFT JOIN LATERAL (SELECT COALESCE(max(CASE WHEN n.quota_day = (now() AT TIME ZONE 'utc')::date THEN n.quota_count ELSE 0 END), 0) AS quota_count
                            FROM (SELECT DISTINCT ON (x.session_kind) x.quota_day, x.quota_count FROM engine_sessions x
                                   WHERE x.account_id = k.account_id AND x.repo_id = k.repo_id AND x.session_kind IN ('engine', 'bridge', 'detail')
                                   ORDER BY x.session_kind, x.created_at DESC, x.id DESC) n) es ON true
       LEFT JOIN engine_repo_quota eq ON eq.account_id = k.account_id AND eq.repo_id = k.repo_id
      ORDER BY k.ord`,
    [keys.map((k) => k.accountId), keys.map((k) => k.repoId), unnamedMember],
  );
  return rows.map((r, i): RepoSessionFacts => {
    const key = keys[i]!;
    const phase = r.setup_phase as string | null;
    const status: SetupStatus = phase === null || phase === 'removed' ? 'none' : phase === 'done' ? 'done' : 'open';
    const reasons = ENGINE_STOP_REASONS as readonly string[];
    return {
      machine_name: r.placed_runner === null ? key.runnerName : (r.placed_name ?? `Unnamed runner (${r.placed_registrant})`),
      setup: status === 'none' ? { status, phase: null, sub_step: null, state: null, failure_code: null } : { status, phase, sub_step: r.setup_sub_step, state: r.setup_state, failure_code: r.setup_failure_code },
      session: {
        state: sessionStateOf({ liveness: key.liveness, halted: key.halted, sandbox: r.sandbox_state }),
        last_start_mode: r.last_start_mode ?? null,
        last_start_at: iso(r.last_start_at ?? null),
        stopped_reason: r.stopped_reason !== null && r.stopped_reason !== undefined && reasons.includes(r.stopped_reason) ? (r.stopped_reason as StopReasonWord) : null,
        state_at: iso(r.sandbox_state_at ?? null),
      },
      quota: quotaOf({ today: r.today, sessionDay: r.today, sessionCount: Number(r.session_count), repoDay: r.repo_day, repoCount: Number(r.repo_count), resetsAt: new Date(r.resets_at) }),
    };
  });
}
