import type { PoolClient } from 'pg';
import { writeEngineAudit } from './engineAudit.js';

/**
 * Engine bridge EB-4: the account's two switches and ticked repos (migration 1027), and the owner's "Delete engine data". Every function runs on a tenant client
 * from `withTenant` (a session; row security refuses a member and a token principal, so a route's own role check is a second lock, not the only one). Every change
 * writes its audit row in the same transaction, so a failed audit write undoes the change.
 */
export interface EngineBridgeSettings {
  watch_enabled: boolean;
  operate_enabled: boolean;
  repo_ids: string[];
}

export async function readEngineBridgeSettings(client: Pick<PoolClient, 'query'>): Promise<EngineBridgeSettings> {
  const s = await client.query<{ watch_enabled: boolean; operate_enabled: boolean }>(`SELECT watch_enabled, operate_enabled FROM engine_bridge_settings`);
  const r = await client.query<{ repo_id: string }>(`SELECT repo_id FROM engine_bridge_repos ORDER BY repo_id`);
  return { watch_enabled: s.rows[0]?.watch_enabled ?? false, operate_enabled: s.rows[0]?.operate_enabled ?? false, repo_ids: r.rows.map((x) => x.repo_id) };
}

/**
 * Applies a change to the switches and the ticked repos, one audit row per facet that actually changed (`engine_bridge.settings_changed`, payload `kind` of
 * `watch_on`, `watch_off`, `operate_on`, `operate_off`, `repo_added` or `repo_removed`, plus `repo_id` for the repo kinds). Turning watch off while operate is on
 * is refused by the table's own CHECK, so a caller turns operate off first. Whether a repo may be ticked at all (private, `runner_local`) is the route's to check.
 */
export async function setEngineBridgeSettings(
  client: Pick<PoolClient, 'query'>,
  userId: string,
  patch: { watch_enabled?: boolean; operate_enabled?: boolean; repo_ids?: readonly string[] },
): Promise<EngineBridgeSettings> {
  const before = await readEngineBridgeSettings(client);
  const watch = patch.watch_enabled ?? before.watch_enabled;
  const operate = patch.operate_enabled ?? before.operate_enabled;
  await client.query(
    `INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled, updated_by)
     VALUES (NULLIF(current_setting('app.account_id', true), '')::uuid, $1, $2, $3)
     ON CONFLICT (account_id) DO UPDATE SET watch_enabled = EXCLUDED.watch_enabled, operate_enabled = EXCLUDED.operate_enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [watch, operate, userId],
  );
  if (watch !== before.watch_enabled) await writeEngineAudit(client, 'engine_bridge.settings_changed', { kind: watch ? 'watch_on' : 'watch_off' });
  if (operate !== before.operate_enabled) await writeEngineAudit(client, 'engine_bridge.settings_changed', { kind: operate ? 'operate_on' : 'operate_off' });
  if (patch.repo_ids !== undefined) {
    const want = new Set(patch.repo_ids);
    const have = new Set(before.repo_ids);
    for (const id of have) {
      if (want.has(id)) continue;
      await client.query(`DELETE FROM engine_bridge_repos WHERE repo_id = $1`, [id]);
      await writeEngineAudit(client, 'engine_bridge.settings_changed', { kind: 'repo_removed', repo_id: id });
    }
    for (const id of want) {
      if (have.has(id)) continue;
      await client.query(`INSERT INTO engine_bridge_repos (account_id, repo_id, enabled_by) VALUES (NULLIF(current_setting('app.account_id', true), '')::uuid, $1, $2)`, [id, userId]);
      await writeEngineAudit(client, 'engine_bridge.settings_changed', { kind: 'repo_added', repo_id: id });
    }
  }
  return readEngineBridgeSettings(client);
}

export interface EngineSettingsView {
  watch_enabled: boolean;
  operate_enabled: boolean;
  can_edit: boolean;
  repos: Array<{ repo_id: string; full_name: string; enabled: boolean; eligible: boolean; refusal: 'repo_not_runner_local' | 'public_repo' | null; bridged_runner_id: string | null }>;
}

/**
 * The settings screen's read: the switches and every repo of the account with its `owner/name` (never an id or null on screen: a repo whose name is not known yet
 * reads "Unnamed repository (<first 8 of its id>)"), whether it is ticked, and whether it can be: only a private `runner_local` repo can. Whether a repo is public
 * is a GitHub read the route does and passes in as `publicRepoIds` (v1.7): a public one is `eligible: false` with `refusal: 'public_repo'`, and a repo that is not
 * `runner_local` is refused as `repo_not_runner_local` first. `can_edit` is the caller's, given by the route from the session's role.
 */
export async function readEngineSettingsView(client: Pick<PoolClient, 'query'>, canEdit: boolean, publicRepoIds: ReadonlySet<string> = new Set()): Promise<EngineSettingsView> {
  const s = await readEngineBridgeSettings(client);
  // `bridged_runner_id`: the runner whose bridge last reported for the repo (its newest engine session), or null when none ever has. The account's own
  // `account_id` predicate is explicit on both tables, on top of RLS. Nothing else about the session leaves here: no instance id, no version, no path.
  const { rows } = await client.query<{ id: string; full_name: string | null; execution_mode: string; bridged_runner_id: string | null }>(
    `SELECT r.id, CASE WHEN r.gh_owner IS NOT NULL AND r.gh_name IS NOT NULL THEN r.gh_owner || '/' || r.gh_name END AS full_name, r.execution_mode, b.runner_id AS bridged_runner_id
       FROM repos r
       LEFT JOIN LATERAL (SELECT s.runner_id FROM engine_sessions s WHERE s.repo_id = r.id AND s.account_id = r.account_id ORDER BY s.created_at DESC, s.id LIMIT 1) b ON true
      WHERE r.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
      ORDER BY r.gh_owner, r.gh_name, r.id`,
  );
  const on = new Set(s.repo_ids);
  return {
    watch_enabled: s.watch_enabled,
    operate_enabled: s.operate_enabled,
    can_edit: canEdit,
    repos: rows.map((r) => {
      const refusal = r.execution_mode !== 'runner_local' ? ('repo_not_runner_local' as const) : publicRepoIds.has(r.id) ? ('public_repo' as const) : null;
      return { repo_id: r.id, full_name: r.full_name ?? `Unnamed repository (${r.id.slice(0, 8)})`, enabled: on.has(r.id), eligible: refusal === null, refusal, bridged_runner_id: r.bridged_runner_id };
    }),
  };
}

/** Removes every engine session of the account, with its events and read model (an owner on a session only; the switches stay). Returns how many sessions went. */
export async function deleteEngineData(client: Pick<PoolClient, 'query'>): Promise<number> {
  const { rows } = await client.query<{ n: number }>(`SELECT engine_data_delete() AS n`);
  const n = rows[0]!.n;
  await writeEngineAudit(client, 'engine_bridge.data_deleted', {});
  return n;
}

export interface EngineRepoFreshness {
  /** The repo's newest engine session by the server's clock (its newest bridge session when it has no engine session yet). */
  session_id: string;
  engine_instance_id: string;
  /** Which kind of session `session_id` is. */
  session_kind: 'engine' | 'bridge';
  /** The latest event or heartbeat across every session of the repo, engine and bridge. */
  as_of: string | null;
  /** Seconds since the runner was last heard on any session of the repo (derived on read, never stored). */
  heard_age_s: number | null;
  /** The age of each source the engine reads, as the repo's newest engine session last reported them (a bridge session and the engine host's spool session report none, so they never speak for the sources). */
  source_ages_s: Record<string, number>;
  /** The latest 20 holes in the seq numbers across every session of the repo, newest detected first. */
  gaps: Array<{ from_seq: number; to_seq: number; before_ts: string | null }>;
  /** Events missing across every session of the repo (the sum over every hole, not only the 20 listed). */
  missing_events: number;
}

/**
 * What every per-repo screen shows about the data's age and completeness (null when the repo has no session): when the last event or heartbeat was, how long
 * since the runner was last heard (derived on read, never stored), the age of each source the engine reads, and every recorded gap. It merges every session of the
 * repo, the engine's and the runner's bridge sessions (v1.6; a bridge heartbeat keeps the data fresh while the engine is quiet): `as_of` is the newest of them all and
 * `heard_age_s` the smallest, never what only the newest session says. Sessions are ordered by the server's clock (`created_at`, `last_heard_at`), never by an
 * event time the runner chose.
 */
export async function readEngineRepoFreshness(client: Pick<PoolClient, 'query'>, repoId: string): Promise<EngineRepoFreshness | null> {
  const agg = await client.query(
    `SELECT count(*)::int AS n, max(GREATEST(last_event_at, last_heartbeat_at)) AS as_of, EXTRACT(EPOCH FROM (now() - max(last_heard_at)))::float8 AS heard
       FROM engine_sessions WHERE repo_id = $1`,
    [repoId],
  );
  const a = agg.rows[0];
  if (a.n === 0) return null;
  const head = await client.query(
    `SELECT id, engine_instance_id, session_kind FROM engine_sessions WHERE repo_id = $1 ORDER BY (session_kind = 'engine') DESC, created_at DESC, id LIMIT 1`,
    [repoId],
  );
  const ages = await client.query(
    `SELECT source_ages_s FROM engine_sessions WHERE repo_id = $1 AND session_kind = 'engine' AND source_ages_s IS NOT NULL ORDER BY last_heard_at DESC NULLS LAST, created_at DESC, id LIMIT 1`,
    [repoId],
  );
  const g = await client.query(
    `SELECT from_seq, to_seq, before_ts FROM engine_session_gaps WHERE session_id IN (SELECT id FROM engine_sessions WHERE repo_id = $1) ORDER BY detected_at DESC, session_id, from_seq DESC LIMIT 20`,
    [repoId],
  );
  const m = await client.query(`SELECT COALESCE(sum(to_seq - from_seq + 1), 0)::text AS n FROM engine_session_gaps WHERE session_id IN (SELECT id FROM engine_sessions WHERE repo_id = $1)`, [repoId]);
  const row = head.rows[0];
  return {
    session_id: row.id,
    engine_instance_id: row.engine_instance_id,
    session_kind: row.session_kind,
    as_of: a.as_of === null ? null : new Date(a.as_of).toISOString(),
    heard_age_s: a.heard === null ? null : Math.max(0, Math.round(a.heard)),
    source_ages_s: ages.rows[0]?.source_ages_s ?? {},
    gaps: g.rows.map((r) => ({ from_seq: Number(r.from_seq), to_seq: Number(r.to_seq), before_ts: r.before_ts === null ? null : new Date(r.before_ts).toISOString() })),
    missing_events: Number(m.rows[0].n),
  };
}
