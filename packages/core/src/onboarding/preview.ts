import { createHash } from 'node:crypto';
import { withTenant } from '../tenancy/withTenant.js';
import { ForbiddenError, NotFoundError } from '../tenancy/errors.js';
import { requireOwnerOrAdmin, type MembershipRole } from '../tenancy/authorize.js';
import { announceNewRunAction, type RunActionCtx, type RunActionDeps } from '../runActions/request.js';
import {
  ACTIVITY_KIND,
  OUTPUT_KIND,
  PROGRESS_EVENT_KINDS,
  PROGRESS_LIMITS,
  STAGE_KIND,
  STATUS_KIND,
  buildFeed,
  deriveProgress,
  type FeedLine,
  type Outcome,
  type ProgressEvent,
  type Stage,
} from './previewProgress.js';

/** D#2 H17c-1: the onboarding preview's request and read services (the definers are in migration 0685). */

/** Most the preview may spend on the customer's model key, and on our sandbox. */
export const PREVIEW_MODEL_CAP_USD = 20;
export const PREVIEW_COMPUTE_CAP_USD = 1;
/** Preview compute reserved across all accounts in one UTC day before new requests are turned away. */
export const PREVIEW_DAILY_COMPUTE_CAP_USD = 10;
/** Free previews per GitHub installation and per GitHub owner in the window, across accounts (the definer's constants, migration 0695). */
export const PREVIEW_INSTALL_LIMIT = 1;
export const PREVIEW_INSTALL_WINDOW_DAYS = 30;

/** The worker cannot run previews yet (no seat source or run starter). API-9: 503 preview_unavailable. */
export class PreviewUnavailableError extends Error {
  constructor() {
    super('preview: unavailable');
    this.name = 'PreviewUnavailableError';
  }
}
/** The caller did not confirm the model cap. API-9: 422. */
export class PreviewCapNotConfirmedError extends Error {
  constructor() {
    super(`preview: the ${PREVIEW_MODEL_CAP_USD} USD model cap was not confirmed`);
    this.name = 'PreviewCapNotConfirmedError';
  }
}
/** The account has no model connection that validated. */
export class PreviewNoModelKeyError extends Error {
  constructor() {
    super('preview: no working model connection');
    this.name = 'PreviewNoModelKeyError';
  }
}
/** Today's platform-wide preview compute allowance is used up. API-9: 409 preview_capacity. */
export class PreviewCapacityError extends Error {
  constructor() {
    super('preview: capacity reached for today');
    this.name = 'PreviewCapacityError';
  }
}
/** This GitHub user or installation already has a preview. API-9: 409 preview_exists. */
export class PreviewExistsError extends Error {
  constructor() {
    super('preview: already requested');
    this.name = 'PreviewExistsError';
  }
}

/** This GitHub installation or owner already used its free preview in the window. API-9: 409 preview_install_limit. */
export class PreviewInstallLimitError extends Error {
  constructor() {
    super('preview: install limit reached');
    this.name = 'PreviewInstallLimitError';
  }
}

export interface PreviewDeps extends RunActionDeps {
  /** False while the worker cannot run a preview; the request is then refused before anything is written. */
  available(): boolean;
  /** True for an account on the operator's own subscription (the app's operator decision); it needs no model connection of its own. Absent: no account is. */
  isOperatorAccount?(accountId: string): boolean;
}

export interface RequestPreviewInput {
  repoId: string;
  /** Must equal PREVIEW_MODEL_CAP_USD: the customer has seen what the preview may spend. */
  confirmModelCapUsd: number;
  /** A replay of the same key and repo returns the first result and signals nothing. */
  idempotencyKey?: string;
}

export interface RequestPreviewResult {
  previewId: string;
  actionId: string;
  state: string;
  replayed: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assertUuid = (id: string): void => {
  if (!UUID_RE.test(id)) throw new NotFoundError('preview: not found');
};

/**
 * Asks for the account's one capped, read-only preview run on a team_readonly
 * repo. A session owner or admin only: a token principal is refused before any
 * SQL, and the definer refuses it again. Every refusal below happens before
 * anything is written. The preview row is bound to the GitHub user recorded
 * when the App was installed (the definer reads it; no caller supplies it), and
 * a request counted against the daily cap or already made is refused.
 * The cap, key and repo checks here are early and kind, not authoritative:
 * the worker checks the cap again under its lock.
 */
export async function requestPreview(
  ctx: RunActionCtx,
  input: RequestPreviewInput,
  deps: PreviewDeps,
): Promise<RequestPreviewResult> {
  const { accountId, userId, tokenId } = ctx.principal;
  if (tokenId !== undefined) throw new ForbiddenError('preview: a session is required');
  if (!deps.available()) throw new PreviewUnavailableError();
  if (input.confirmModelCapUsd !== PREVIEW_MODEL_CAP_USD) throw new PreviewCapNotConfirmedError();

  assertUuid(input.repoId);
  let row: { preview_id: string; action_id: string; state: string; replayed: boolean };
  try {
    row = await withTenant(ctx.pool, accountId, userId, tokenId, async (client) => {
      const role = await client.query<{ role: MembershipRole | null }>('SELECT current_member_role() AS role');
      requireOwnerOrAdmin(role.rows[0]?.role ?? null);
      const replay = input.idempotencyKey
        ? await client.query(
            `SELECT 1 FROM onboarding_previews p JOIN run_action_requests q ON q.id = p.run_action_id
              WHERE q.requested_by = $1 AND q.idempotency_key = $2`,
            [`session:${userId}`, input.idempotencyKey],
          )
        : null;
      if (!replay?.rowCount) {
        const repo = await client.query<{ app_kind: string }>(
          `SELECT i.app_kind FROM repos r JOIN installations i ON i.account_id = r.account_id AND i.id = r.installation_id WHERE r.id = $1`,
          [input.repoId],
        );
        if (repo.rows[0]?.app_kind !== 'team_readonly') throw new NotFoundError('preview: repo not found');
        const key = deps.isOperatorAccount?.(accountId) === true ? { rowCount: 1 } : await client.query(`SELECT 1 FROM model_connections WHERE status = 'ok' LIMIT 1`);
        if (!key.rowCount) throw new PreviewNoModelKeyError();
        const used = await client.query<{ v: string }>('SELECT preview_daily_compute_usd() AS v');
        if (Number(used.rows[0]!.v) >= PREVIEW_DAILY_COMPUTE_CAP_USD) throw new PreviewCapacityError();
      }
      const hash = createHash('sha256').update(`start_preview:${input.repoId}`).digest('hex');
      const { rows } = await client.query(
        'SELECT preview_id, action_id, state, replayed FROM onboarding_preview_request($1, $2, $3)',
        [input.repoId, input.idempotencyKey ?? null, hash],
      );
      return rows[0];
    });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === '23505') throw new PreviewExistsError();
    if (code === 'PX409') throw new PreviewInstallLimitError();
    if (code === 'P0002') throw new NotFoundError('preview: repo not found');
    if (code === '42501') throw new ForbiddenError('preview: requires a session owner or admin');
    throw err;
  }
  const result = { previewId: row.preview_id, actionId: row.action_id, state: row.state, replayed: row.replayed };
  if (!result.replayed) await announceNewRunAction(deps, { actionId: result.actionId, accountId, kind: 'start_preview' });
  return result;
}

export interface PreviewView<R = never> {
  preview_id: string;
  /** The stored state, except that a preview whose run has ended reads as 'finished'. */
  state: 'requested' | 'running' | 'finished' | 'void';
  repo_id: string;
  created_at: string;
  started_at: string | null;
  /** The linked run's end time; never stored on the preview. */
  finished_at: string | null;
  /** The projection of a succeeded run's own output, or null. */
  result: R | null;
  void_reason: string | null;
  /** The linked run's status, once it has a run. */
  run_status: string | null;
}

interface PreviewRow {
  id: string;
  state: PreviewView['state'];
  repo_id: string;
  created_at: Date;
  started_at: Date | null;
  void_reason: string | null;
  run_status: string | null;
  ended_at: Date | null;
  envelope: unknown;
}

/**
 * Reads one preview of the caller's account (another account's id, a missing one
 * and a malformed one are all NotFound). The finish time and the result come from
 * the linked run and nothing is written: `projectResult` turns a succeeded run's
 * envelope into the result and is supplied by the caller, since this package does
 * not know the envelope's shape.
 */
export async function getPreview<R = never>(
  ctx: RunActionCtx,
  previewId: string,
  opts: { projectResult?: (envelope: unknown) => R } = {},
): Promise<PreviewView<R>> {
  assertUuid(previewId);
  const { accountId, userId, tokenId } = ctx.principal;
  if (tokenId !== undefined) throw new ForbiddenError('preview: a session is required');
  const row = await withTenant(ctx.pool, accountId, userId, tokenId, async (client) => {
    const { rows } = await client.query<PreviewRow>(
      `SELECT p.id, p.state, p.repo_id, p.created_at, p.started_at, p.void_reason,
              r.status AS run_status, r.ended_at, r.envelope
         FROM onboarding_previews p LEFT JOIN agent_runs r ON r.account_id = p.account_id AND r.id = p.run_id
        WHERE p.id = $1`,
      [previewId],
    );
    return rows[0];
  });
  if (!row) throw new NotFoundError('preview: not found');
  return {
    preview_id: row.id,
    state: row.ended_at ? 'finished' : row.state,
    repo_id: row.repo_id,
    created_at: row.created_at.toISOString(),
    started_at: row.started_at?.toISOString() ?? null,
    finished_at: row.ended_at?.toISOString() ?? null,
    result: row.run_status === 'succeeded' && opts.projectResult ? opts.projectResult(row.envelope) : null,
    void_reason: row.void_reason,
    run_status: row.run_status,
  };
}

/**
 * The account's newest preview (void ones included, so the caller can say why), or null when it has none.
 * A session only; no role gate here, since the progress read reaches previews for any member. The newest id is
 * chosen under the tenant, then read through getPreview.
 */
export async function getLatestPreview<R = never>(
  ctx: RunActionCtx,
  opts: { projectResult?: (envelope: unknown) => R } = {},
): Promise<PreviewView<R> | null> {
  const { accountId, userId, tokenId } = ctx.principal;
  if (tokenId !== undefined) throw new ForbiddenError('preview: a session is required');
  const id = await withTenant(ctx.pool, accountId, userId, tokenId, async (client) => {
    const { rows } = await client.query<{ id: string }>('SELECT id FROM onboarding_previews ORDER BY created_at DESC, id DESC LIMIT 1');
    return rows[0]?.id;
  });
  return id ? getPreview(ctx, id, opts) : null;
}

export interface PreviewProgressDeps {
  /** True for an account on the operator's own subscription (the same decision requestPreview uses). */
  isOperatorAccount?(accountId: string): boolean;
  /** Our sandbox cost for this many seconds of run time (supplied by the caller; this package does not price compute). */
  estimateComputeUsd(seconds: number): number;
  now?(): Date;
}

export interface PreviewProgress {
  /** The server's clock when this was read: the panel keeps its running timer against this, not its own clock. */
  server_time: string;
  outcome: Outcome;
  /** A closed lower-case code that refines the outcome (a void or failure reason), or null. */
  reason: string | null;
  /** In queued, starting or running for longer than SLOW_AFTER_SECONDS. */
  slow: boolean;
  /** Read from the preview row (void with a freeing reason), never worked out from the failure: this free preview was handed back and can be started again. */
  slot_freed: boolean;
  elapsed_seconds: number | null;
  repo_name: string | null;
  stages: Stage[];
  feed: FeedLine[];
  numbers: {
    files_read: number;
    compute: { usd: number; basis: 'none' | 'estimate' | 'recorded'; cap_usd: number };
    model: { whose: 'operator' | 'ai_gateway' | 'anthropic' | 'customer'; usd: number | null };
  };
}

interface FactsRow {
  state: PreviewView['state'];
  run_id: string | null;
  created_at: Date;
  started_at: Date | null;
  void_reason: string | null;
  gh_owner: string | null;
  gh_name: string | null;
  run_status: string | null;
  ended_at: Date | null;
}

interface EventRow {
  seq: string;
  kind: string;
  created_at: Date;
  tool: string | null;
  path: string | null;
  pattern: string | null;
  stage: string | null;
  to: string | null;
  failureReason: string | null;
}

type StageMarks = Partial<Record<'sandbox_ready' | 'cloned' | 'writing_result', Date>>;

interface ProgressData {
  facts: FactsRow;
  events: ProgressEvent[];
  marks: StageMarks;
  failureReason: string | null;
  activityCount: number;
  filesRead: number;
  outputs: number;
  firstOutput: { seq: number; at: Date } | null;
  ledger: Array<{ kind: string; source: string; usd: string }>;
  provider: string | null;
}

const MODEL_WHOSE = { customer_gateway: 'ai_gateway', customer_anthropic: 'anthropic' } as const;

/**
 * The live view of one preview of the caller's account: stages, an activity feed, and honest numbers. A session
 * owner or admin only (the role is read inside the tenant transaction, like requestPreview); another account's id, a
 * missing one and a malformed one are all NotFound. One read-only transaction with bounded queries: only the event kinds
 * and payload fields named in previewProgress.ts leave the database, `agent.output` is only counted, and nothing is
 * written. The mapping to lines and stages is previewProgress.ts's.
 */
export async function getPreviewProgress(ctx: RunActionCtx, previewId: string, deps: PreviewProgressDeps): Promise<PreviewProgress> {
  assertUuid(previewId);
  const { accountId, userId, tokenId } = ctx.principal;
  if (tokenId !== undefined) throw new ForbiddenError('preview: a session is required');
  const now = deps.now?.() ?? new Date();
  const operator = deps.isOperatorAccount?.(accountId) === true;
  const data = await withTenant(ctx.pool, accountId, userId, tokenId, async (client): Promise<ProgressData> => {
    const role = await client.query<{ role: MembershipRole | null }>('SELECT current_member_role() AS role');
    requireOwnerOrAdmin(role.rows[0]?.role ?? null);
    await client.query(`SET LOCAL statement_timeout = ${PROGRESS_LIMITS.statementTimeoutMs}`); // the read is bounded in time as well as in rows
    const found = await client.query<FactsRow>(
      `SELECT p.state, p.run_id, p.created_at, p.started_at, p.void_reason, rp.gh_owner, rp.gh_name,
              r.status AS run_status, r.ended_at
         FROM onboarding_previews p
         LEFT JOIN repos rp ON rp.account_id = p.account_id AND rp.id = p.repo_id
         LEFT JOIN agent_runs r ON r.account_id = p.account_id AND r.id = p.run_id
        WHERE p.id = $1`,
      [previewId],
    );
    const facts = found.rows[0];
    if (!facts) throw new NotFoundError('preview: not found');
    const out: ProgressData = { facts, events: [], marks: {}, failureReason: null, activityCount: 0, filesRead: 0, outputs: 0, firstOutput: null, ledger: [], provider: null };
    if (!operator) {
      const conn = await client.query<{ provider: string }>(`SELECT provider FROM model_connections WHERE status = 'ok' ORDER BY created_at DESC LIMIT 1`);
      out.provider = conn.rows[0]?.provider ?? null;
    }
    const runId = facts.run_id;
    if (!runId) return out;
    const ev = await client.query<EventRow>(
      `SELECT seq, kind, created_at, left(payload->>'tool', 32) AS tool, left(payload->>'path', 200) AS path, left(payload->>'pattern', 200) AS pattern,
              left(payload->>'stage', 32) AS stage, left(payload->>'to', 32) AS "to", left(payload->>'failureReason', 64) AS "failureReason"
         FROM run_events WHERE run_id = $1 AND kind = ANY($2::text[]) ORDER BY seq DESC LIMIT $3`,
      [runId, [...PROGRESS_EVENT_KINDS], PROGRESS_LIMITS.maxEventsScanned],
    );
    out.events = ev.rows.map((e) => ({
      seq: Number(e.seq),
      kind: e.kind,
      at: e.created_at,
      fields: { tool: e.tool, path: e.path, pattern: e.pattern, stage: e.stage, to: e.to, failureReason: e.failureReason },
    }));
    const marks = await client.query<{ stage: keyof StageMarks; at: Date }>(
      `SELECT payload->>'stage' AS stage, min(created_at) AS at FROM run_events
        WHERE run_id = $1 AND kind = $2 AND payload->>'stage' IN ('sandbox_ready', 'cloned', 'writing_result') GROUP BY 1`,
      [runId, STAGE_KIND],
    );
    for (const m of marks.rows) out.marks[m.stage] = m.at;
    const failure = await client.query<{ reason: string | null }>(
      `SELECT left(payload->>'failureReason', 64) AS reason FROM run_events
        WHERE run_id = $1 AND kind = $2 AND payload->>'failureReason' IS NOT NULL ORDER BY seq DESC LIMIT 1`,
      [runId, STATUS_KIND],
    );
    out.failureReason = failure.rows[0]?.reason ?? null;
    const counts = await client.query<{ activity: number; files_read: number; outputs: number; first_seq: string | null; first_at: Date | null }>(
      `SELECT (count(*) FILTER (WHERE kind = $2))::int AS activity,
              (count(DISTINCT left(path, 200)) FILTER (WHERE kind = $2 AND tool = 'read'))::int AS files_read,
              (count(*) FILTER (WHERE kind = $3))::int AS outputs,
              min(seq) FILTER (WHERE kind = $3) AS first_seq, min(created_at) FILTER (WHERE kind = $3) AS first_at
         FROM (SELECT seq, kind, created_at, payload->>'tool' AS tool, payload->>'path' AS path
                 FROM run_events WHERE run_id = $1 AND kind IN ($2, $3) ORDER BY seq LIMIT $4) s`,
      [runId, ACTIVITY_KIND, OUTPUT_KIND, PROGRESS_LIMITS.maxEventsCounted],
    );
    const c = counts.rows[0];
    out.activityCount = c?.activity ?? 0;
    out.filesRead = Math.min(c?.files_read ?? 0, PROGRESS_LIMITS.maxFilesRead);
    out.outputs = c?.outputs ?? 0;
    out.firstOutput = c?.first_seq && c.first_at ? { seq: Number(c.first_seq), at: c.first_at } : null;
    const ledger = await client.query<{ kind: string; source: string; usd: string }>(
      'SELECT kind, source, sum(usd)::text AS usd FROM ledger WHERE run_id = $1 GROUP BY kind, source',
      [runId],
    );
    out.ledger = ledger.rows;
    return out;
  });

  const f = data.facts;
  const derived = deriveProgress({
    now,
    previewState: f.void_reason !== null ? 'void' : f.ended_at ? 'finished' : f.state,
    voidReason: f.void_reason,
    createdAt: f.created_at,
    startedAt: f.started_at,
    endedAt: f.ended_at,
    runStatus: f.run_status,
    failureReason: data.failureReason,
    marks: data.marks,
    activityCount: data.activityCount,
    agentOutputCount: data.outputs,
  });

  const computeRows = data.ledger.filter((l) => l.kind === 'compute');
  const runSeconds = f.started_at ? Math.max(0, ((f.ended_at ?? now).getTime() - f.started_at.getTime()) / 1000) : 0;
  const compute =
    computeRows.length > 0
      ? { usd: computeRows.reduce((n, l) => n + Number(l.usd), 0), basis: 'recorded' as const }
      : f.started_at
        ? { usd: deps.estimateComputeUsd(runSeconds), basis: 'estimate' as const }
        : { usd: 0, basis: 'none' as const };
  const modelRows = data.ledger.filter((l) => l.kind === 'model');
  const modelSource = modelRows.map((l) => l.source).find((s): s is keyof typeof MODEL_WHOSE => s in MODEL_WHOSE);
  const ledgerOperator = modelRows.some((l) => l.source === 'operator_subscription');
  const operatorWhose = ledgerOperator || (operator && !modelSource);
  const customerWhose = modelSource ? MODEL_WHOSE[modelSource] : data.provider === 'ai_gateway' || data.provider === 'anthropic' ? data.provider : 'customer';
  const model: PreviewProgress['numbers']['model'] = operatorWhose
    ? { whose: 'operator', usd: null }
    : { whose: customerWhose, usd: modelRows.reduce((n, l) => n + Number(l.usd), 0) };

  return {
    server_time: now.toISOString(),
    outcome: derived.outcome,
    reason: derived.reason,
    slow: derived.slow,
    slot_freed: derived.slotFreed,
    elapsed_seconds: derived.elapsedSeconds,
    repo_name: f.gh_owner && f.gh_name ? `${f.gh_owner}/${f.gh_name}` : null,
    stages: derived.stages,
    feed: buildFeed(data.events, data.firstOutput),
    numbers: { files_read: data.filesRead, compute: { ...compute, cap_usd: PREVIEW_COMPUTE_CAP_USD }, model },
  };
}
