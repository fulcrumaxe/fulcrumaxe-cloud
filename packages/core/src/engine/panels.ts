import type { PoolClient } from 'pg';
import { round } from '@fx/stats';
import type { EngineRepoFreshness } from '@fx/db/src/engineBridge.js';
import { haltPending } from '@fx/db/src/engineHalt.js';
import { readEngineAgentStats, type EngineAgentStats } from './read.js';

/**
 * Engine bridge EB-5: the per-repo panel reads behind `GET /api/v1/engine/repos/:id/*`. Every function runs on the caller's tenant client, so row security
 * confines it to the account. Everything returned is an id, an enum, a count, a timestamp or a cloud-side name: no text the engine wrote is stored, so none can
 * be served. Age is derived on every read from stored timestamps, never stored (L2). Agent state comes only from the paired start and stop events (L3).
 */

/** A runner is "live" when it was heard within this many seconds, and an agent that started this long ago with no stop is "unknown" (L2, L3). */
export const LIVE_WITHIN_S = 180;
export const UNKNOWN_AFTER_S = 3 * 3600;

export type Liveness = 'live' | 'stale' | 'runner_removed' | 'never';
export type AgentState = 'running' | 'unknown' | 'stopped';

/** Derived on read, never stored. `heardAgeS` is the age of the runner's newest message from either the engine session or the bridge session. */
export function livenessOf(input: { sessionCount: number; revoked: boolean; heardAgeS: number | null }): Liveness {
  if (input.sessionCount === 0) return 'never';
  if (input.revoked) return 'runner_removed';
  return input.heardAgeS !== null && input.heardAgeS <= LIVE_WITHIN_S ? 'live' : 'stale';
}

/**
 * `stopped` when a stop event exists. Otherwise `running` only while the agent's own session is live and the start is under 3 hours old: a start with no
 * stop after a crash (a session no longer heard) or after 3 hours is `unknown`, never "running".
 */
export function agentStateOf(input: { stopped: boolean; sessionLive: boolean; startAgeS: number | null }): AgentState {
  if (input.stopped) return 'stopped';
  return input.sessionLive && input.startAgeS !== null && input.startAgeS < UNKNOWN_AFTER_S ? 'running' : 'unknown';
}

export interface Freshness {
  /** The newest event or heartbeat of any session of the repo; a repo with no session reads "as of now" (with `heard_age_s` null), never null. */
  as_of: string;
  heard_age_s: number | null;
  source_ages_s: Record<string, number>;
  /** The latest 20 holes in the seq numbers across the repo's sessions, newest first. */
  gaps: Array<{ from_seq: number; to_seq: number; before_ts: string | null }>;
  /** Events missing across every session of the repo (the sum over every hole, not only the 20 listed). */
  missing_events: number;
}

export interface Envelope<T> extends Freshness {
  items: T[];
  next_cursor: string | null;
}

/** Shown where a member has no name on record, the same word the fleet page uses. */
const UNNAMED_MEMBER = 'A team member';
const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());
/** A cursor carries timestamps at the database's own microsecond precision: a millisecond one would skip rows that sit between two milliseconds. */
const us = (col: string): string => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** The repo is ticked for the engine bridge and visible to the account; false otherwise (the route answers 404). */
export async function engineRepoEnabled(client: PoolClient, repoId: string): Promise<boolean> {
  const { rows } = await client.query(`SELECT 1 FROM engine_bridge_repos WHERE repo_id = $1`, [repoId]);
  return rows.length > 0;
}

/**
 * The envelope's age and holes for a repo, from the merged-session read in #1001 (`readEngineRepoFreshness`, Spec v1.6): every panel and the repo list get age and
 * gaps from that one read, so they agree. A repo with no session yet reads "as of now" with `heard_age_s` null, never a null `as_of`.
 */
export function toFreshness(f: EngineRepoFreshness | null): Freshness {
  return {
    as_of: f?.as_of ?? new Date().toISOString(),
    heard_age_s: f?.heard_age_s ?? null,
    source_ages_s: f?.source_ages_s ?? {},
    gaps: f?.gaps ?? [],
    missing_events: f?.missing_events ?? 0,
  };
}

/**
 * The wake route's last-seen stamps (`seen:<rid>` in Runtime Cache, written at most once a minute by every wake check). A quiet runner uploads only every 5 minutes,
 * but checks the wake route every 20 s, so its check is the newer word that it is there. Injected by the app (structurally the runner-cloud `RunnerSeenReader`); a
 * miss, an error or no reader leaves the database's word alone, so a stamp can only make a runner look MORE recently heard.
 */
export type RunnerSeenReader = (runnerIds: readonly string[], now: Date) => Promise<ReadonlyMap<string, Date>>;
export const engineSeen: { reader: (() => RunnerSeenReader | null) | null } = { reader: null };

/**
 * How old the database's own word may be for the wake stamp to still count: one 5-minute status interval plus slack. The wake check comes from the runner's
 * daemon, which can be alive while its bridge is dead (crashed, stopped, refused); a bridge that has not uploaded for longer than its status interval is not
 * kept "live" by the daemon next to it.
 */
export const WAKE_STAMP_MAX_DB_AGE_S = 420;

/**
 * Pure. The smaller of the database's heard age and the age of the wake stamp (seconds), but only while the database's own age is at most
 * `WAKE_STAMP_MAX_DB_AGE_S` (a repo nobody has heard from, or not for longer than that, keeps the database's word). A stamp from the future counts as now.
 */
export function heardAgeWithSeen(dbAgeS: number | null, seenAt: Date | null, now: Date): number | null {
  if (seenAt === null || dbAgeS === null || dbAgeS > WAKE_STAMP_MAX_DB_AGE_S) return dbAgeS;
  return Math.min(dbAgeS, Math.max(0, Math.round((now.getTime() - seenAt.getTime()) / 1000)));
}

/**
 * The wake stamp of each repo's runner, for the account's own repos only. A repo's runner is the one the panels already name: the runner of its newest session
 * (engine sessions first by first event, then newest), and only when that runner belongs to `accountId` and is not removed. The ids asked of the cache come
 * only from this account's sessions, so no other account's runner can be looked up.
 */
export async function readRepoWakeSeen(client: Pick<PoolClient, 'query'>, accountId: string, repoIds: readonly string[], now: Date = new Date()): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  const read = engineSeen.reader?.() ?? null;
  if (read === null || repoIds.length === 0) return out;
  try {
    const { rows } = await client.query(
      `SELECT n.repo_id, rn.id AS runner_id
         FROM (SELECT DISTINCT ON (y.repo_id) y.repo_id, y.runner_id FROM engine_sessions y WHERE y.account_id = $1 AND y.repo_id = ANY($2::uuid[])
                ORDER BY y.repo_id, y.first_event_at DESC NULLS LAST, y.created_at DESC) n
         JOIN runners rn ON rn.id = n.runner_id AND rn.account_id = $1 AND rn.revoked_at IS NULL`,
      [accountId, [...repoIds]],
    );
    if (rows.length === 0) return out;
    const seen = await read(rows.map((r) => r.runner_id as string), now);
    for (const r of rows) {
      const at = seen.get(r.runner_id as string);
      if (at !== undefined) out.set(r.repo_id as string, at);
    }
  } catch {
    // fx-swallow-ok: the wake stamp only ever adds to what the database says; a failed read leaves the database's word, never an error on the panel
  }
  return out;
}

/** The freshness read with the wake stamp folded into `heard_age_s` (the newest word wins). A repo with no session stays null. */
export async function freshnessWithSeen(client: Pick<PoolClient, 'query'>, accountId: string, repoId: string, f: EngineRepoFreshness | null): Promise<EngineRepoFreshness | null> {
  if (f === null) return null;
  const now = new Date();
  const seen = await readRepoWakeSeen(client, accountId, [repoId], now);
  return { ...f, heard_age_s: heardAgeWithSeen(f.heard_age_s, seen.get(repoId) ?? null, now) };
}

export interface RepoRow {
  repo_id: string;
  full_name: string;
  runner_id: string | null;
  runner_name: string | null;
  session_id: string | null;
  last_event_at: string | null;
  last_heard_at: string | null;
  liveness: Liveness;
  watch_enabled: boolean;
  operate_enabled: boolean;
  /** The repo's halt marker (migration 1031), read under row security. A repo with no marker row has never been halted. */
  halted: boolean;
  /** Halted, and the runner has not yet reported `halt_applied` at or above the current epoch. Derived on read, never stored. */
  halt_pending: boolean;
  /** When the current halt was set; null while not halted. */
  halted_at: string | null;
  /** +1 per halt, unchanged by a clear; 0 for a repo never halted. */
  halt_epoch: number;
}

/** Every ticked repo of the account with the runner that serves it and its liveness. The newest session names the runner; liveness uses the newest word from any session. */
export async function readEngineRepos(client: PoolClient, accountId?: string): Promise<RepoRow[]> {
  const { rows } = await client.query(
    `SELECT r.id AS repo_id, CASE WHEN r.gh_owner IS NOT NULL AND r.gh_name IS NOT NULL THEN r.gh_owner || '/' || r.gh_name END AS full_name,
            st.watch_enabled, st.operate_enabled, n.id AS session_id, n.runner_id, n.last_event_at,
            a.heard_at, a.sessions, (rn.revoked_at IS NOT NULL) AS revoked, rs.name AS runner_set_name,
            COALESCE(NULLIF(ru.name, ''), NULLIF(ru.github_login, ''), $1) AS registrant, EXTRACT(EPOCH FROM (now() - a.heard_at))::float8 AS heard,
            (c.halted_at IS NOT NULL) AS halted, c.halted_at, COALESCE(c.halt_epoch, 0) AS halt_epoch, ap.applied_epoch
       FROM engine_bridge_repos b
       JOIN repos r ON r.id = b.repo_id
       LEFT JOIN engine_bridge_settings st ON st.account_id = b.account_id
       LEFT JOIN LATERAL (SELECT count(*)::int AS sessions, max(x.last_heard_at) AS heard_at FROM engine_sessions x WHERE x.repo_id = b.repo_id) a ON true
       LEFT JOIN LATERAL (SELECT y.id, y.runner_id, y.last_event_at FROM engine_sessions y WHERE y.repo_id = b.repo_id ORDER BY y.first_event_at DESC NULLS LAST, y.created_at DESC LIMIT 1) n ON true
       LEFT JOIN runners rn ON rn.id = n.runner_id
       LEFT JOIN runner_settings rs ON rs.runner_id = rn.id AND rs.account_id = rn.account_id
       LEFT JOIN users ru ON ru.id = rn.registered_by
       LEFT JOIN engine_repo_controls c ON c.account_id = b.account_id AND c.repo_id = b.repo_id
       -- The newest epoch the runner reported applying, from the repo's sessions (the bridge session carries it). Only looked up while halted.
       LEFT JOIN LATERAL (SELECT max((ev.body->>'halt_epoch')::int) AS applied_epoch FROM engine_events ev JOIN engine_sessions es ON es.id = ev.session_id
                           WHERE ev.account_id = b.account_id AND es.account_id = b.account_id AND c.halted_at IS NOT NULL AND es.repo_id = b.repo_id AND ev.kind = 'halt_applied') ap ON true
      ORDER BY full_name NULLS LAST, r.id`,
    [UNNAMED_MEMBER],
  );
  const now = new Date();
  const seen = accountId === undefined ? new Map<string, Date>() : await readRepoWakeSeen(client, accountId, rows.map((r) => r.repo_id as string), now);
  return rows.map((r) => {
    const seenAt = seen.get(r.repo_id as string) ?? null;
    const dbAge = r.heard === null ? null : Math.round(r.heard);
    const heardAge = heardAgeWithSeen(dbAge, seenAt, now);
    // The wake stamp can only make the runner look more recently heard: the later of it and the database's `last_heard_at`.
    const heardAt = seenAt !== null && heardAge !== null && dbAge !== null && heardAge < dbAge ? seenAt : r.heard_at;
    return {
    repo_id: r.repo_id,
    full_name: r.full_name ?? `Unnamed repository (${String(r.repo_id).slice(0, 8)})`,
    runner_id: r.runner_id,
    runner_name: r.runner_id === null ? null : (r.runner_set_name ?? `Unnamed runner (${r.registrant})`),
    session_id: r.session_id,
    last_event_at: iso(r.last_event_at),
    last_heard_at: iso(heardAt),
    liveness: livenessOf({ sessionCount: r.sessions, revoked: r.revoked === true, heardAgeS: heardAge }),
    watch_enabled: r.watch_enabled ?? false,
    operate_enabled: r.operate_enabled ?? false,
    halted: r.halted === true,
    halt_pending: haltPending({ halted: r.halted === true, halt_epoch: Number(r.halt_epoch) }, r.applied_epoch === null || r.applied_epoch === undefined ? null : Number(r.applied_epoch)),
    halted_at: iso(r.halted_at),
    halt_epoch: Number(r.halt_epoch),
    };
  });
}

/** A keyset cursor: the sort key of the last row served, as strings. Anything that is not 1 to 3 short strings is refused by the caller as an invalid cursor. */
export const encodeCursor = (key: Array<string | number>): string => Buffer.from(JSON.stringify(key.map(String)), 'utf8').toString('base64url');
export function decodeCursor(raw: string | undefined, width: number): string[] | null {
  if (raw === undefined || raw === '') return null;
  let v: unknown = null;
  try {
    v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    // fx-swallow-ok: a cursor that is not base64url JSON is refused below as an invalid cursor (422), the same answer as any other forged one
  }
  if (Array.isArray(v) && v.length === width && v.every((x) => typeof x === 'string' && x.length > 0 && x.length < 64)) return v as string[];
  throw new CursorError();
}
export class CursorError extends Error {}

function page<T>(rows: T[], limit: number, key: (row: T) => Array<string | number>): { items: T[]; next_cursor: string | null } {
  const items = rows.slice(0, limit);
  return { items, next_cursor: rows.length > limit ? encodeCursor(key(items[items.length - 1]!)) : null };
}

export interface AgentItem {
  agent_id: string;
  role: string;
  discussion: number | null;
  background: boolean | null;
  started_at: string | null;
  stopped_at: string | null;
  verdict: string | null;
  state: AgentState;
  model: string | null;
  credential_mode: string | null;
}

/** `running`: agents with no stop, each running or unknown (never "running" for a session that is not live or a start 3 h old). `recent`: stopped in the last 24 h, newest first. */
export async function readAgents(client: PoolClient, repoId: string, filter: 'running' | 'recent', limit: number, cursor: string | undefined, accountId?: string): Promise<{ items: AgentItem[]; next_cursor: string | null }> {
  const after = decodeCursor(cursor, 2);
  // A running agent's session is live while the repo's runner was heard (an upload, or its wake check inside the bounded window) within `LIVE_WITHIN_S`.
  const now = new Date();
  const seenAt = accountId === undefined ? null : ((await readRepoWakeSeen(client, accountId, [repoId], now)).get(repoId) ?? null);
  const open = filter === 'running';
  const ts = open ? 'a.started_at' : 'a.stopped_at';
  const { rows } = await client.query(
    `SELECT a.id, COALESCE(a.agent_id, a.spawn_id) AS agent_id, a.role, a.discussion, a.background, a.started_at, a.stopped_at, a.verdict, a.model, ${us(ts)} AS k,
            (SELECT u.credential_mode FROM engine_agent_usage u WHERE u.session_id = a.session_id AND u.subject_kind = 'agent' AND u.subject_id = a.agent_id) AS credential_mode,
            EXTRACT(EPOCH FROM (now() - s.last_heard_at))::float8 AS heard_age, EXTRACT(EPOCH FROM (now() - a.started_at))::float8 AS start_age
       FROM engine_agents a JOIN engine_sessions s ON s.id = a.session_id
      WHERE s.repo_id = $1 AND ${open ? 'a.stopped_at IS NULL' : "a.stopped_at >= now() - interval '24 hours'"}
        AND ($2::timestamptz IS NULL OR (${ts}, a.id) < ($2::timestamptz, $3::uuid))
      ORDER BY ${ts} DESC, a.id DESC LIMIT $4`,
    [repoId, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
  );
  const items = rows.map((r): AgentItem & { _k: string[] } => ({
    _k: [r.k, r.id],
    agent_id: r.agent_id,
    role: r.role,
    discussion: r.discussion === null ? null : Number(r.discussion),
    background: r.background,
    started_at: iso(r.started_at),
    stopped_at: iso(r.stopped_at),
    verdict: r.verdict,
    state: agentStateOf({ stopped: r.stopped_at !== null, sessionLive: r.heard_age !== null && (heardAgeWithSeen(Number(r.heard_age), seenAt, now) ?? Infinity) <= LIVE_WITHIN_S, startAgeS: r.start_age }),
    model: r.model,
    credential_mode: r.credential_mode,
  }));
  const p = page(items, limit, (x) => x._k);
  return { items: p.items.map(({ _k: _omit, ...x }) => x), next_cursor: p.next_cursor };
}

export interface LaneItem {
  pr: number;
  discussion: number | null;
  state: string;
  updated_at: string;
}

/** The newest state of each PR across the repo's sessions. */
export async function readLanes(client: PoolClient, repoId: string, limit: number, cursor: string | undefined): Promise<{ items: LaneItem[]; next_cursor: string | null }> {
  const after = decodeCursor(cursor, 2);
  const { rows } = await client.query(
    `SELECT x.*, ${us('x.updated_at')} AS k FROM (SELECT DISTINCT ON (l.pr) l.pr, l.discussion, l.state, l.updated_at
                      FROM engine_lanes l JOIN engine_sessions s ON s.id = l.session_id WHERE s.repo_id = $1 ORDER BY l.pr, l.updated_at DESC) x
      WHERE $2::timestamptz IS NULL OR (x.updated_at, x.pr) < ($2::timestamptz, $3::bigint)
      ORDER BY x.updated_at DESC, x.pr DESC LIMIT $4`,
    [repoId, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
  );
  const items = rows.map((r): LaneItem & { _k: string[] } => ({ _k: [r.k, r.pr], pr: Number(r.pr), discussion: r.discussion === null ? null : Number(r.discussion), state: r.state, updated_at: iso(r.updated_at)! }));
  const p = page(items, limit, (x) => x._k);
  return { items: p.items.map(({ _k: _omit, ...x }) => x), next_cursor: p.next_cursor };
}

export interface GateItem {
  pr: number;
  gate: string;
  result: string;
  head_sha: string;
  at: string;
}

/** `pr` given: the latest result per gate for that PR. Not given: the latest per (PR, gate) for PRs that are in a lane or had a receipt in the last 24 h. */
export async function readGates(client: PoolClient, repoId: string, pr: number | null, limit: number, cursor: string | undefined): Promise<{ items: GateItem[]; next_cursor: string | null }> {
  const after = decodeCursor(cursor, 3);
  const { rows } = await client.query(
    `SELECT x.*, ${us('x.at')} AS k FROM (SELECT DISTINCT ON (g.pr, g.gate) g.pr, g.gate, g.result, g.head_sha, g.at
                      FROM engine_gate_receipts g JOIN engine_sessions s ON s.id = g.session_id
                     WHERE s.repo_id = $1 AND ($2::bigint IS NULL OR g.pr = $2::bigint)
                     ORDER BY g.pr, g.gate, g.at DESC) x
      WHERE ($2::bigint IS NOT NULL OR x.at >= now() - interval '24 hours'
             OR EXISTS (SELECT 1 FROM engine_lanes l JOIN engine_sessions ls ON ls.id = l.session_id WHERE ls.repo_id = $1 AND l.pr = x.pr AND l.state NOT IN ('merged', 'failed', 'dequeued', 'refused')))
        AND ($3::timestamptz IS NULL OR (x.at, x.pr, x.gate) < ($3::timestamptz, $4::bigint, $5::text))
      ORDER BY x.at DESC, x.pr DESC, x.gate DESC LIMIT $6`,
    [repoId, pr, after?.[0] ?? null, after?.[1] ?? null, after?.[2] ?? null, limit + 1],
  );
  const items = rows.map((r): GateItem & { _k: string[] } => ({ _k: [r.k, r.pr, r.gate], pr: Number(r.pr), gate: r.gate, result: r.result, head_sha: r.head_sha, at: iso(r.at)! }));
  const p = page(items, limit, (x) => x._k);
  return { items: p.items.map(({ _k: _omit, ...x }) => x), next_cursor: p.next_cursor };
}

export interface AskItem {
  ask_id: string;
  ask_kind: string;
  source: string;
  discussion: number | null;
  pr: number | null;
  raised_at: string;
  cleared_at: string | null;
  how: string | null;
  /** The receipt id of a decision the engine asked about (answered through the decision answer route); null for a team-log ask. */
  decision_id: string | null;
  decision_type: 'engine_spawn' | 'engine_merge' | 'engine_spec_ready' | null;
}

/** A decision ask has no engine session, so it sorts under this key; the keyset order stays one order across both kinds of ask. */
const NIL_SESSION = '00000000-0000-0000-0000-000000000000';

/**
 * The asks of one repo: the team-log asks the engine reported, and the decisions the cloud's own dial answered `ask`. A decision is cleared by its
 * answer row (read now, never a stamp on the receipt). One keyset order across both: (raised_at, session key, ask_id), newest first.
 */
export async function readAsks(client: PoolClient, repoId: string, which: 'open' | 'all', limit: number, cursor: string | undefined, accountId: string): Promise<{ items: AskItem[]; next_cursor: string | null }> {
  const after = decodeCursor(cursor, 3);
  const { rows } = await client.query(
    `SELECT u.*, ${us('u.raised_at')} AS k FROM (
        SELECT a.ask_id, a.ask_kind, a.source, a.discussion, a.pr, a.raised_at, a.cleared_at, a.how, a.session_id, NULL::uuid AS decision_id, NULL::text AS decision_type
          FROM engine_asks a JOIN engine_sessions s ON s.id = a.session_id
         WHERE a.account_id = $7 AND s.account_id = $7 AND s.repo_id = $1
        UNION ALL
        SELECT d.id::text, 'owner_decision', 'decide', (d.subject ->> 'discussion')::bigint, (d.subject ->> 'pr')::bigint, d.created_at, w.created_at,
               CASE WHEN w.decision_id IS NULL THEN NULL ELSE 'answered_cloud' END, '${NIL_SESSION}'::uuid, d.id, d.decision_type
          FROM engine_decisions d LEFT JOIN engine_decision_answers w ON w.account_id = d.account_id AND w.decision_id = d.id
         WHERE d.account_id = $7 AND d.repo_id = $1 AND d.disposition = 'ask'
      ) u
      WHERE ($2::boolean OR u.cleared_at IS NULL) AND ($3::timestamptz IS NULL OR (u.raised_at, u.session_id, u.ask_id) < ($3::timestamptz, $4::uuid, $5::text))
      ORDER BY u.raised_at DESC, u.session_id DESC, u.ask_id DESC LIMIT $6`,
    [repoId, which === 'all', after?.[0] ?? null, after?.[1] ?? null, after?.[2] ?? null, limit + 1, accountId],
  );
  const items = rows.map((r): AskItem & { _k: string[] } => ({
    _k: [r.k, r.session_id, r.ask_id],
    ask_id: r.ask_id,
    ask_kind: r.ask_kind,
    source: r.source,
    discussion: r.discussion === null ? null : Number(r.discussion),
    pr: r.pr === null ? null : Number(r.pr),
    raised_at: iso(r.raised_at)!,
    cleared_at: iso(r.cleared_at),
    how: r.how,
    decision_id: r.decision_id,
    decision_type: r.decision_type,
  }));
  const p = page(items, limit, (x) => x._k);
  return { items: p.items.map(({ _k: _omit, ...x }) => x), next_cursor: p.next_cursor };
}

export interface LogItem {
  line_id: string;
  actor_role: string;
  category: string;
  discussion: number | null;
  pr: number | null;
  ts: string;
}

/** The team log: only the kind of line and its ids ever reach the cloud. A keyset page over `team_log_line` events, newest first. */
export async function readLog(client: PoolClient, repoId: string, limit: number, cursor: string | undefined): Promise<{ items: LogItem[]; next_cursor: string | null }> {
  const after = decodeCursor(cursor, 3);
  const { rows } = await client.query(
    `SELECT e.session_id, e.seq, e.ts, e.body, ${us('e.ts')} AS k FROM engine_events e JOIN engine_sessions s ON s.id = e.session_id
      WHERE s.repo_id = $2 AND e.kind = 'team_log_line' AND ($3::timestamptz IS NULL OR (e.ts, e.seq, e.session_id) < ($3::timestamptz, $4::bigint, $5::uuid))
      ORDER BY e.ts DESC, e.seq DESC, e.session_id DESC LIMIT $1`,
    [limit + 1, repoId, after?.[0] ?? null, after?.[1] ?? null, after?.[2] ?? null],
  );
  const items = rows.map((r): LogItem & { _k: string[] } => ({
    _k: [r.k, r.seq, r.session_id],
    line_id: r.body.line_id,
    actor_role: r.body.actor_role,
    category: r.body.category,
    discussion: r.body.discussion ?? null,
    pr: r.body.pr ?? null,
    ts: iso(r.ts)!,
  }));
  const p = page(items, limit, (x) => x._k);
  return { items: p.items.map(({ _k: _omit, ...x }) => x), next_cursor: p.next_cursor };
}

/** Where a figure came from: the event kinds it counted, how many events, and the first 200 as (session, seq). Recounting those rows reproduces the figure. */
export interface Provenance {
  kinds: string[];
  count: number;
  seqs: Array<{ session_id: string; seq: number }>;
}

async function provenanceOf(client: PoolClient, kinds: string[], inner: string, params: unknown[]): Promise<Provenance> {
  const n = await client.query(`SELECT count(*)::int AS n FROM (${inner}) p`, params);
  const s = await client.query(`SELECT session_id, seq FROM (${inner}) p ORDER BY session_id, seq LIMIT 200`, params);
  return { kinds, count: n.rows[0].n, seqs: s.rows.map((r) => ({ session_id: r.session_id, seq: Number(r.seq) })) };
}

export interface RepoStats {
  agents_by_role: { value: EngineAgentStats['agents_by_role']; provenance: Provenance };
  duration_s: { n: number; median: number | null; p90: number | null; provenance: Provenance };
  merges: { value: number; provenance: Provenance };
  gate_pass_rate: { value: number | null; numerator: number; denominator: number; provenance: Provenance };
}

/**
 * Per-repo figures for `[from, to)`, each with its provenance. Agents and durations come from `readEngineAgentStats` (percentiles by `percentileCont`); merges
 * count `merged` events; the gate pass rate counts each distinct (PR, gate, result, head sha) `gate_receipt` once and leaves skipped gates out of the rate.
 */
export async function readRepoStats(client: PoolClient, repoId: string, from: Date, to: Date): Promise<RepoStats> {
  const a = await readEngineAgentStats(client, { from, to, repoId });
  const win = `s.repo_id = $1 AND COALESCE(g.started_at, g.stopped_at) >= $2 AND COALESCE(g.started_at, g.stopped_at) < $3`;
  const roleProv = await provenanceOf(
    client,
    ['agent_started', 'agent_stopped'],
    `SELECT e.session_id, e.seq FROM engine_agents g JOIN engine_sessions s ON s.id = g.session_id
       JOIN engine_events e ON e.session_id = g.session_id AND ((g.started_at IS NOT NULL AND e.kind = 'agent_started' AND e.body->>'spawn_id' = g.spawn_id)
                                                              OR (g.started_at IS NULL AND e.kind = 'agent_stopped' AND e.body->>'agent_id' = g.agent_id))
      WHERE ${win}`,
    [repoId, from, to],
  );
  const durProv = await provenanceOf(
    client,
    ['agent_stopped'],
    `SELECT e.session_id, e.seq FROM engine_agents g JOIN engine_sessions s ON s.id = g.session_id
       JOIN engine_events e ON e.session_id = g.session_id AND e.kind = 'agent_stopped' AND e.body->>'agent_id' = g.agent_id AND e.body ? 'duration_s'
      WHERE ${win} AND g.duration_s IS NOT NULL`,
    [repoId, from, to],
  );
  const mergeProv = await provenanceOf(
    client,
    ['merged'],
    `SELECT e.session_id, e.seq FROM engine_events e JOIN engine_sessions s ON s.id = e.session_id WHERE s.repo_id = $1 AND e.kind = 'merged' AND e.ts >= $2 AND e.ts < $3`,
    [repoId, from, to],
  );
  const gateInner = `SELECT DISTINCT ON (e.body->>'pr', e.body->>'gate', e.body->>'result', e.body->>'head_sha') e.session_id, e.seq, e.body->>'result' AS result
       FROM engine_events e JOIN engine_sessions s ON s.id = e.session_id WHERE s.repo_id = $1 AND e.kind = 'gate_receipt' AND e.ts >= $2 AND e.ts < $3
      ORDER BY e.body->>'pr', e.body->>'gate', e.body->>'result', e.body->>'head_sha', e.ts, e.seq`;
  const gateProv = await provenanceOf(client, ['gate_receipt'], gateInner, [repoId, from, to]);
  const gc = await client.query(
    `SELECT count(*) FILTER (WHERE result = 'pass')::int AS pass, count(*) FILTER (WHERE result <> 'skipped')::int AS counted FROM (${gateInner}) p`,
    [repoId, from, to],
  );
  const { pass, counted } = gc.rows[0] as { pass: number; counted: number };
  return {
    agents_by_role: { value: a.agents_by_role, provenance: roleProv },
    duration_s: { ...a.duration_s, provenance: durProv },
    merges: { value: mergeProv.count, provenance: mergeProv },
    gate_pass_rate: { value: counted === 0 ? null : round(pass / counted, 4), numerator: pass, denominator: counted, provenance: gateProv },
  };
}
