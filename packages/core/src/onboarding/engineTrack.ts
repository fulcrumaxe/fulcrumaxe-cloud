import type { PoolClient } from 'pg';
import { ForbiddenError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';
import type { RunActionCtx } from '../runActions/request.js';
import { emitDomainEvent } from '../domain-events/emit.js';

/**
 * D#845 ON-5: the engine track of onboarding. The seven steps are DERIVED from current rows on every read, so a step reopens when what it stands for goes away.
 * The only thing stored is a failure (`project_setups.failure_code` and `failure_at`), and it is shown only while its own step's source is still false, so it
 * clears by itself when that source turns true. The person's track choice is the one stamp that is the person's own decision (`onboarding_tracks`).
 */

export const ENGINE_STEPS = ['machine', 'claude', 'github_app', 'project', 'plan', 'install', 'live'] as const;
export type EngineStepKey = (typeof ENGINE_STEPS)[number];
export const TRACKS = ['engine', 'pipeline'] as const;
export type Track = (typeof TRACKS)[number];

/** `done`: the source is true. `failed`: a stored failure for this step while the source is false. `active`: the first step not done. `pending`: the rest. */
export type EngineStepState = 'done' | 'active' | 'pending' | 'failed';
export interface EngineStep {
  step: EngineStepKey;
  state: EngineStepState;
  completed_at: string | null;
  /** The machine step's isolation tier; null on every other step, and on a machine that has not reported one. */
  tier: 'microvm' | 'standard' | null;
  /** The stored failure for this step; null unless `state` is `failed`. */
  failure: { code: string; at: string } | null;
}

/** What each step's source says: its time when true, null when false. */
export interface EngineSources {
  done: Record<EngineStepKey, string | null>;
  tier: EngineStep['tier'];
  failures: Partial<Record<EngineStepKey, { code: string; at: string }>>;
}

/** The step a stored failure belongs to, by the setup's phase. Survey failures (a mirror or a survey run) surface on the plan the survey was to produce. */
export const FAILURE_STEP_BY_PHASE: Record<string, EngineStepKey | undefined> = {
  survey: 'plan',
  plan: 'plan',
  install: 'install',
  await_merge: 'install',
  finish: 'live',
  done: 'live',
  removed: undefined,
};

/** The steps from their sources. Pure. A failure is shown only on a step whose source is false. */
export function buildEngineSteps(src: EngineSources): EngineStep[] {
  let activeTaken = false;
  return ENGINE_STEPS.map((step) => {
    const completed_at = src.done[step];
    const failure = completed_at === null ? (src.failures[step] ?? null) : null;
    let state: EngineStepState = 'pending';
    if (completed_at !== null) state = 'done';
    else if (failure) state = 'failed';
    else if (!activeTaken) state = 'active';
    if (state !== 'done' && state !== 'pending') activeTaken = true;
    return { step, state, completed_at, tier: step === 'machine' ? src.tier : null, failure };
  });
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** The per-machine facts the caller supplies (ON-1b's `readMachineFacts` lives in a package that depends on this one, so it is injected). */
export type MachineFactsReader = (accountId: string, userId: string) => Promise<Map<string, { model_auth_present: boolean | null }>>;

/**
 * Reads the engine sources inside the caller's tenant transaction. Every query names the account itself, on top of row security.
 * `machine`: a live (not revoked) runner whose hello is recorded (it holds a protocol version and a time heard); the tier is the one the most recently heard machine reports.
 * `github_app`: `githubAppAt`, the same team installation the pipeline track's write step reads. `project`: a placement. `plan`: an approved draft.
 * `install`: a setup in phase finish or done. `live`: an engine session (not the bridge's own) that has heard a heartbeat.
 */
export async function readEngineSources(
  client: PoolClient,
  accountId: string,
  githubAppAt: string | null,
): Promise<{ sources: EngineSources; runners: { id: string; heardAt: string }[] }> {
  const rn = (
    await client.query<{ id: string; last_seen_at: Date; sandbox_engine: string | null }>(
      `SELECT rn.id, rn.last_seen_at, f.sandbox_engine FROM runners rn LEFT JOIN runner_facts f ON f.account_id = rn.account_id AND f.runner_id = rn.id
        WHERE rn.account_id = $1 AND rn.revoked_at IS NULL AND rn.protocol_version IS NOT NULL AND rn.last_seen_at IS NOT NULL ORDER BY rn.last_seen_at DESC, rn.id`,
      [accountId],
    )
  ).rows;
  const one = async (sql: string): Promise<string | null> => iso((await client.query<{ t: Date | null }>(sql, [accountId])).rows[0]?.t);
  const project = await one(`SELECT min(placed_at) AS t FROM project_placements WHERE account_id = $1`);
  const plan = await one(`SELECT min(approved_at) AS t FROM project_drafts WHERE account_id = $1 AND status = 'approved'`);
  const install = await one(`SELECT min(updated_at) AS t FROM project_setups WHERE account_id = $1 AND phase IN ('finish', 'done')`);
  const live = await one(`SELECT min(last_heartbeat_at) AS t FROM engine_sessions WHERE account_id = $1 AND session_kind = 'engine' AND last_heartbeat_at IS NOT NULL`);
  const setups = (
    await client.query<{ phase: string; failure_code: string; failure_at: Date }>(
      `SELECT phase, failure_code, failure_at FROM project_setups WHERE account_id = $1 AND failure_code IS NOT NULL ORDER BY failure_at DESC`,
      [accountId],
    )
  ).rows;
  const failures: EngineSources['failures'] = {};
  for (const s of setups) {
    const step = FAILURE_STEP_BY_PHASE[s.phase];
    if (step && !failures[step]) failures[step] = { code: s.failure_code, at: s.failure_at.toISOString() };
  }
  const tier = rn[0]?.sandbox_engine === 'microvm' ? 'microvm' : rn[0]?.sandbox_engine === 'os_sandbox' ? 'standard' : null;
  const runners = rn.map((r) => ({ id: r.id, heardAt: r.last_seen_at.toISOString() }));
  return {
    sources: { done: { machine: iso(rn[0]?.last_seen_at), claude: null, github_app: githubAppAt, project, plan, install, live }, tier, failures },
    runners,
  };
}

/** The `claude` step: done while a live machine's latest hello says it holds model credentials. A machine that never said (null) does not count: fail closed. */
export async function claudeDoneAt(
  runners: { id: string; heardAt: string }[],
  accountId: string,
  userId: string,
  readFacts: MachineFactsReader | undefined,
): Promise<string | null> {
  if (!readFacts || runners.length === 0) return null;
  const facts = await readFacts(accountId, userId);
  return runners.find((r) => facts.get(r.id)?.model_auth_present === true)?.heardAt ?? null;
}

/** Which tracks the account chose, with when. A track never chosen is absent. */
export async function readChosenTracks(client: PoolClient, accountId: string): Promise<Map<Track, string>> {
  const { rows } = await client.query<{ track: Track; chosen_at: Date }>(`SELECT track, chosen_at FROM onboarding_tracks WHERE account_id = $1`, [accountId]);
  return new Map(rows.map((r) => [r.track, r.chosen_at.toISOString()]));
}

/**
 * The person picks a track (owner or admin, session only; the route enforces the role). The row is the person's own decision, so it is stored; choosing a
 * track again changes nothing and writes no second audit row. Both tracks may be chosen ("Add the other track").
 */
export async function chooseTrack(ctx: RunActionCtx, track: Track): Promise<{ track: Track; chosen_at: string; created: boolean }> {
  const { accountId, userId, tokenId } = ctx.principal;
  if (tokenId) throw new ForbiddenError('onboarding: a token cannot choose a track');
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    const ins = await client.query<{ chosen_at: Date }>(
      `INSERT INTO onboarding_tracks (account_id, track, chosen_by) VALUES ($1, $2, $3) ON CONFLICT (account_id, track) DO NOTHING RETURNING chosen_at`,
      [accountId, track, userId],
    );
    if (ins.rows[0]) {
      await client.query(`SELECT audit_write('onboarding.track_chosen', $1::jsonb)`, [JSON.stringify({ track })]);
      return { track, chosen_at: ins.rows[0].chosen_at.toISOString(), created: true };
    }
    const cur = await client.query<{ chosen_at: Date }>(`SELECT chosen_at FROM onboarding_tracks WHERE account_id = $1 AND track = $2`, [accountId, track]);
    return { track, chosen_at: cur.rows[0]!.chosen_at.toISOString(), created: false };
  });
}

/** Two seconds: one notice per setup in this window is enough for a screen that re-reads on it. */
export const SETUP_CHANGED_WINDOW_S = 2;

/**
 * D#845 ON-5: tells open screens that a setup moved, so they re-read. Ids only. It runs on the writer's own client, so the notice and the change commit or roll
 * back together. At most one per setup per window: a read against the real clock (clock_timestamp, not the transaction start; after a per-setup advisory lock, so two writers cannot both pass it) skips a notice
 * the window already holds. Returns whether it wrote one. Stream-only: it is not a webhook type, and it rides the stream's tick, not the nudge trigger.
 */
export async function emitSetupChanged(client: PoolClient, args: { accountId: string; setupId: string; repoId: string }): Promise<boolean> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('setup.changed'), hashtext($1))`, [args.setupId]);
  const recent = await client.query(
    `SELECT 1 FROM domain_events WHERE account_id = $1 AND type = 'setup.changed' AND subject_id = $2 AND created_at > clock_timestamp() - make_interval(secs => $3) LIMIT 1`,
    [args.accountId, args.setupId, SETUP_CHANGED_WINDOW_S],
  );
  if (recent.rows.length > 0) return false;
  // Stamped from the real clock, not the transaction start: now() freezes at BEGIN, so a writer that held its transaction open for a while would be
  // stamped in the past and a later writer could pass the guard right after it.
  const stamp = await client.query<{ at: Date }>(`SELECT clock_timestamp() AS at`);
  await emitDomainEvent(client, {
    type: 'setup.changed',
    accountId: args.accountId,
    subjectId: args.setupId,
    payload: { setup_id: args.setupId, repo_id: args.repoId },
    createdAt: stamp.rows[0]!.at,
  });
  return true;
}
