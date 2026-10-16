import type { Pool, PoolClient } from 'pg';
import {
  getCatalogueEntry,
  isTombstone,
  resolveAskRoute,
  validateRoute,
  type AskRoute,
  type AskRouteRow,
  type MemberRole,
  type RouteErrorCode,
  type RouteLookup,
  type RouteMember,
  type RouteSubject,
} from '@fx/decisions';
import { withTenant } from './withTenant.js';

/**
 * Escalation routes (D#7 AAP-b1), over migrations/0836_ask_routes.sql.
 *
 * Append-only, like the ask settings (0812): every change is a new version row and the audit row naming the previous and the new route is
 * written in the same transaction. Nothing here issues an UPDATE or a DELETE, and app_user holds neither. Removing a route is a new version
 * with no levels (a tombstone), so the history stays complete; restoring an earlier version is a new version with that version's content.
 * The current route for a key is its highest version. The version stamped on an ask at raise is b2's concern, not this module's.
 *
 * The `app.user_id` of the transaction is the actor and `changed_by`, never an input (the insert policy requires them to be equal, and to
 * be an owner or admin of the account).
 */

export type AskRouteErrorCode =
  | RouteErrorCode
  | 'ask_route_subject_invalid'
  | 'ask_route_unknown_decision_type'
  | 'ask_route_class1_never_asks'
  | 'ask_route_action_type_invalid'
  | 'ask_route_repo_invalid'
  | 'ask_route_version_unknown'
  | 'ask_route_version_conflict';

/** Thrown before any write, or on a lost version race. `code` is the named error; branch on it, not on the message. */
export class AskRouteError extends Error {
  constructor(readonly code: AskRouteErrorCode) {
    super(code);
    this.name = 'AskRouteError';
  }
}

export interface AskRouteVersion extends AskRouteRow {
  id: string;
  accountId: string;
  version: number;
  changedBy: string;
  createdAt: Date;
}

interface Row {
  id: string;
  account_id: string;
  repo_id: string | null;
  subject: RouteSubject;
  decision_type: string;
  levels: AskRoute['levels'];
  hours: AskRoute['hours'];
  repeat: number;
  version: number;
  changed_by: string;
  created_at: Date;
}

const map = (r: Row): AskRouteVersion => ({
  id: r.id,
  accountId: r.account_id,
  repoId: r.repo_id,
  subject: r.subject,
  decisionType: r.decision_type,
  levels: r.levels,
  hours: r.hours,
  repeat: r.repeat,
  version: r.version,
  changedBy: r.changed_by,
  createdAt: r.created_at,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The CURRENT (highest-version) row for every key the tenant has written, tombstones included. RLS scopes it to the transaction's account. */
export async function listCurrentAskRoutes(client: PoolClient): Promise<AskRouteVersion[]> {
  const { rows } = await client.query<Row>(
    `SELECT DISTINCT ON (repo_id, subject, decision_type) *
       FROM ask_routes
      ORDER BY repo_id NULLS FIRST, subject, decision_type, version DESC`,
  );
  return rows.map(map);
}

/** Every version ever written for one key, oldest first: the full history, not just current state. */
export async function listAskRouteHistory(
  client: PoolClient,
  repoId: string | null,
  subject: RouteSubject,
  decisionType: string,
): Promise<AskRouteVersion[]> {
  const { rows } = await client.query<Row>(
    `SELECT * FROM ask_routes
      WHERE repo_id IS NOT DISTINCT FROM $1::uuid AND subject = $2 AND decision_type = $3
      ORDER BY version ASC`,
    [repoId, subject, decisionType],
  );
  return rows.map(map);
}

/**
 * The route that applies to one ask or approval, by the four-step lookup (repo + type, repo + '*', account + type, account + '*'), with a
 * tombstone falling to the next step. Null means no route applies and the caller plans the R5 default.
 */
export async function resolveCurrentAskRoute(client: PoolClient, lookup: RouteLookup): Promise<AskRouteRow | null> {
  return resolveAskRoute(await listCurrentAskRoutes(client), lookup);
}

/** The account's members as the validator wants them. Read in the writer's own transaction, so a target is checked at save time. */
async function loadMembers(client: PoolClient, accountId: string): Promise<RouteMember[]> {
  const { rows } = await client.query<{ user_id: string; role: MemberRole }>(
    `SELECT user_id, role FROM account_members WHERE account_id = $1`,
    [accountId],
  );
  return rows.map((r) => ({ memberId: r.user_id, role: r.role }));
}

export interface WriteAskRouteContext {
  pool: Pool;
  /** The AUTHENTICATED caller's user id; never a request field. */
  principal: string;
}

export interface AskRouteKey {
  accountId: string;
  /** Null is the account level. */
  repoId: string | null;
  subject: RouteSubject;
  /** A class 2 or 3 catalogue id for a decision route, or '*'. An action route is always '*'. */
  decisionType: string;
}

function validateKey(key: AskRouteKey): void {
  if (key.subject !== 'decision' && key.subject !== 'action') throw new AskRouteError('ask_route_subject_invalid');
  if (key.repoId !== null && !UUID_RE.test(key.repoId)) throw new AskRouteError('ask_route_repo_invalid');
  if (key.subject === 'action') {
    // Action approvals have no decision type yet; a per-kind key arrives with a catalogue entry of its own.
    if (key.decisionType !== '*') throw new AskRouteError('ask_route_action_type_invalid');
    return;
  }
  if (key.decisionType === '*') return;
  const entry = getCatalogueEntry(key.decisionType);
  if (!entry) throw new AskRouteError('ask_route_unknown_decision_type');
  if (entry.class === 'automated_with_monitoring') throw new AskRouteError('ask_route_class1_never_asks');
}

const content = (r: AskRoute | null) => ({ levels: r?.levels ?? [], hours: r?.hours ?? [], repeat: r?.repeat ?? 0 });

async function insertVersion(
  client: PoolClient,
  key: AskRouteKey,
  route: AskRoute,
  changedBy: string,
  restoredFromVersion: number | null,
): Promise<AskRouteVersion> {
  // No FOR UPDATE: that needs UPDATE, which app_user deliberately lacks. A lost race fails on the UNIQUE key instead (mapped below).
  const { rows: prev } = await client.query<Row>(
    `SELECT * FROM ask_routes
      WHERE account_id = $1 AND repo_id IS NOT DISTINCT FROM $2::uuid AND subject = $3 AND decision_type = $4
      ORDER BY version DESC LIMIT 1`,
    [key.accountId, key.repoId, key.subject, key.decisionType],
  );
  const previous = prev[0] ? map(prev[0]) : null;
  let inserted: AskRouteVersion;
  try {
    const { rows } = await client.query<Row>(
      `INSERT INTO ask_routes (account_id, repo_id, subject, decision_type, levels, hours, repeat, version, changed_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
       RETURNING *`,
      [
        key.accountId,
        key.repoId,
        key.subject,
        key.decisionType,
        JSON.stringify(route.levels),
        JSON.stringify(route.hours),
        route.repeat,
        previous ? previous.version + 1 : 1,
        changedBy,
      ],
    );
    inserted = map(rows[0]!);
  } catch (err) {
    // Two writers racing for one version: the loser fails on the UNIQUE key (23505) or, if the winner had already committed, on the
    // next-version trigger (23514 with its own message). A member demoted between the check and the insert fails on the trigger's own
    // target check. Any other check violation is not a race and passes through.
    const e = err as { code?: string; message?: string } | null;
    if (e?.code === '23505' || (e?.code === '23514' && /^ask_routes\.version must be/.test(e.message ?? ''))) {
      throw new AskRouteError('ask_route_version_conflict');
    }
    if (e?.code === '23514' && e.message === 'ask_routes.target_not_answerer') throw new AskRouteError('target_not_answerer');
    throw err;
  }
  await client.query(`SELECT audit_write('ask_route.changed', $1::jsonb)`, [
    JSON.stringify({
      actor: changedBy,
      repo_id: key.repoId,
      subject: key.subject,
      decision_type: key.decisionType,
      version: inserted.version,
      previous: content(previous),
      new: content(inserted),
      ...(restoredFromVersion === null ? {} : { restored_from_version: restoredFromVersion }),
    }),
  ]);
  return inserted;
}

/**
 * Validates and appends the next version of one key, and writes the audit row, on a client that already holds a `withTenant` transaction
 * opened as `changedBy`. `route` is untrusted input: it is validated whole (shape, limits, time zones, and that a named member is an owner
 * or admin of the account right now) before anything is written. A route with no levels, no hours and repeat 0 is a tombstone.
 */
export async function appendAskRouteVersion(
  client: PoolClient,
  input: AskRouteKey & { route: unknown; changedBy: string },
): Promise<AskRouteVersion> {
  validateKey(input);
  const checked = validateRoute(input.route, await loadMembers(client, input.accountId));
  if (!checked.ok) throw new AskRouteError(checked.code);
  return insertVersion(client, input, checked.route, input.changedBy, null);
}

/** Removes a key's own route by appending a tombstone version. The lookup then falls to the next less specific key, then to the R5 default. */
export async function removeAskRouteVersion(client: PoolClient, input: AskRouteKey & { changedBy: string }): Promise<AskRouteVersion> {
  return appendAskRouteVersion(client, { ...input, route: { levels: [], hours: [], repeat: 0 } });
}

/**
 * Restores an earlier version of a key as a NEW version holding that version's content (the earlier rows are untouched). The content is
 * validated again against the members as they are now, so a version that named someone who has since lost the role is refused with
 * `target_not_answerer` instead of being written.
 */
export async function restoreAskRouteVersion(
  client: PoolClient,
  input: AskRouteKey & { version: number; changedBy: string },
): Promise<AskRouteVersion> {
  validateKey(input);
  const { rows } = await client.query<Row>(
    `SELECT * FROM ask_routes
      WHERE account_id = $1 AND repo_id IS NOT DISTINCT FROM $2::uuid AND subject = $3 AND decision_type = $4 AND version = $5`,
    [input.accountId, input.repoId, input.subject, input.decisionType, input.version],
  );
  const old = rows[0];
  if (!old) throw new AskRouteError('ask_route_version_unknown');
  const checked = validateRoute({ levels: old.levels, hours: old.hours, repeat: old.repeat }, await loadMembers(client, input.accountId));
  if (!checked.ok) throw new AskRouteError(checked.code);
  return insertVersion(client, input, checked.route, input.changedBy, old.version);
}

/** One route change as one transaction: the version row and its audit row commit together, or neither does. */
export async function writeAskRoute(ctx: WriteAskRouteContext, input: AskRouteKey & { route: unknown }): Promise<AskRouteVersion> {
  return withTenant(ctx.pool, input.accountId, ctx.principal, (client) =>
    appendAskRouteVersion(client, { ...input, changedBy: ctx.principal }),
  );
}

export async function removeAskRoute(ctx: WriteAskRouteContext, input: AskRouteKey): Promise<AskRouteVersion> {
  return withTenant(ctx.pool, input.accountId, ctx.principal, (client) =>
    removeAskRouteVersion(client, { ...input, changedBy: ctx.principal }),
  );
}

export async function restoreAskRoute(ctx: WriteAskRouteContext, input: AskRouteKey & { version: number }): Promise<AskRouteVersion> {
  return withTenant(ctx.pool, input.accountId, ctx.principal, (client) =>
    restoreAskRouteVersion(client, { ...input, changedBy: ctx.principal }),
  );
}

export { isTombstone };
