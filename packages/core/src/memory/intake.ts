import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { CATALOGUE_VERSION, getCatalogueEntry } from '@fx/decisions';
import { getCurrentDialSetting } from '@fx/db/src/decisions.js';
import { withReversalWindow } from '@fx/db/src/receiptWriter.js';
import { NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';
import { MEMORY_ROLE_MAX_ENTRIES } from './evidence.js';
export { MEMORY_ROLE_MAX_ENTRIES };
import {
  MEMORY_KINDS,
  MEMORY_PENDING_MAX_PER_SCOPE,
  MEMORY_PROPOSALS_PER_RUN,
  MemoryInputError,
  mapMemoryDbError,
  prepareMemoryText,
  type LiveSecretsSource,
  type MemoryAuthorKind,
  type MemoryKind,
  type MemoryScope,
} from './index.js';

/**
 * D#601 MEM-2: proposal intake. A run (or the D#597 assistant) may end its AGENT_OUTPUT envelope with a `memory_proposals` array. This module
 * is the only place that array becomes rows, and what it writes is always a `proposed` entry that nothing recalls until a person approves it.
 *
 * Who decides what:
 *   - The agent names a scope, a kind, a body and a reason. It never names a scope reference: the item is the run's work item, the repository
 *     is the run's repository, and a role entry is the run's own role. A proposal for another item, repo or role cannot be expressed.
 *   - Trust follows who wrote the bytes. The author kind is `agent`, `assistant` or `runner_agent`, fixed here, and the database refuses `person`
 *     for a session with no user. Nothing here calls `writeMemory`, and a session with a user never reaches this code: intake runs in the
 *     pipeline's userless tenant session, so the assistant cannot write an approved entry from inside a person's session by this route.
 *   - Every body goes through `prepareMemoryText` with the tenant's live token values, so a credential is a refusal (`secret_detected`), the
 *     same as on the person's write and edit paths.
 *
 * What is kept, in this order, for each of the first three proposals (the rest are refused `over_run_limit`): its shape; the scope rule
 * (account entries are person-written only; role entries from an agent only when `allowRoleScope` is on and the run's item is terminal, MEM-9); the
 * text; whether the scope can be named; whether the same text (case and whitespace aside) is already approved or pending there; whether the
 * scope already holds 20 pending. The run gets ONE `memory.proposals` event listing what was stored and, for every refusal, a fixed reason.
 * The event holds indexes and reasons only, never a byte of a proposal.
 */
export const MEMORY_INTAKE_REASONS = [
  'over_run_limit',
  'invalid_proposal',
  'account_scope_person_only',
  'role_scope_person_only',
  'invalid_message',
  'secret_detected',
  'scope_unresolved',
  'duplicate',
  'pending_full',
  'role_mismatch',
  'item_not_terminal',
  'role_full',
] as const;
export type MemoryIntakeReason = (typeof MEMORY_INTAKE_REASONS)[number];

/** Who wrote the bytes. `runner_agent` is for the runner's consented upload (MEM-6), which runs these same checks. */
export type MemoryProposalSource = Extract<MemoryAuthorKind, 'agent' | 'assistant' | 'runner_agent'>;

export const MEMORY_PROPOSALS_EVENT_KIND = 'memory.proposals';

/**
 * D#601 MEM-10: what the `memory_auto_approve` dial did with a stored proposal that it could have approved. `approved`: approved in the same transaction,
 * one receipt. `memory_full`: the place already holds its cap of approved entries, so it waits for a person. `refused`: the database declined (the dial
 * changed, the entry is not the run's, ...), so it waits for a person. `previously_declined`: a person rejected, retired, deleted or edited away the same text (case and
 * whitespace aside) anywhere in this repository, so the dial leaves it for a person to look at again. A proposal the dial may not touch (another kind or scope, an import, a runner
 * proposal, a repository whose dial is at ask) carries no outcome at all.
 */
export const MEMORY_AUTO_APPROVE_OUTCOMES = ['approved', 'memory_full', 'refused', 'previously_declined'] as const;
export type MemoryAutoApproveOutcome = (typeof MEMORY_AUTO_APPROVE_OUTCOMES)[number];
/** The two kinds and two places the dial may approve; the database holds the same lists (migration 0986) and re-checks them. */
export const MEMORY_AUTO_APPROVE_KINDS: readonly MemoryKind[] = ['fact', 'command'];
export const MEMORY_AUTO_APPROVE_SCOPES: readonly MemoryScope[] = ['item', 'repo'];
/** The in-product agent paths. The imported and runner-sourced ones (`MEMORY_GATED_AUTHOR_KINDS`) are never on this list. */
export const MEMORY_AUTO_APPROVE_SOURCES: readonly MemoryProposalSource[] = ['agent', 'assistant'];

export interface MemoryProposalsEvent {
  source: MemoryProposalSource;
  stored: Array<{ index: number; id: string; scope: MemoryScope; kind: MemoryKind; auto?: MemoryAutoApproveOutcome }>;
  refused: Array<{ index: number; reason: MemoryIntakeReason }>;
}

export interface IngestMemoryProposalsInput {
  pool: Pool;
  accountId: string;
  runId: string;
  /** The run's work item; null for a run with none (item-scope proposals are then `scope_unresolved`). */
  workItemId: string | null;
  /** The run's own role, which is the only role scope a proposal can have. */
  role: string;
  source: MemoryProposalSource;
  /** The run's AGENT_OUTPUT envelope as stored (untrusted model output); only `memory_proposals` is read. */
  envelope: unknown;
  liveSecrets: LiveSecretsSource;
  /** The scope reference of the run's repository (`repoScopeRef`), or null when it cannot be named. Absent counts as null. */
  resolveRepoScopeRef?: (client: PoolClient) => Promise<string | null>;
  /** Writes the one event row, on the same client, so it commits with the entries. The worker passes the run-event writer. */
  recordEvent: (client: PoolClient, event: MemoryProposalsEvent) => Promise<void>;
  /** Agent-proposed role lessons (R-601-2, MEM-9). Off unless the caller turns it on; a role proposal is still only ever `proposed`. */
  allowRoleScope?: boolean;
  /** MEM-9: whether the run's work item has reached a terminal stage. `false` refuses a role proposal `item_not_terminal`; the worker always passes a boolean (left out, the gate is not applied, as before MEM-9). */
  itemTerminal?: boolean | ((client: PoolClient) => Promise<boolean>);
  /** The once-per-run event this call is idempotent on. Default `memory.proposals`; the deferred role pass uses `memory.role_proposals`. */
  eventKind?: string;
  /**
   * D#601 MEM-10: the run's repository, whose `memory_auto_approve` dial is read inside the intake. Left out (or null), nothing is auto-approved. Only the
   * in-product agent paths may get past it: an import or runner source never does, whatever this holds.
   */
  dialRepoId?: string | null;
  backend?: string;
  modelId?: string;
}

export type IngestMemoryProposalsResult = { status: 'none' } | { status: 'already_ingested' } | ({ status: 'ingested' } & MemoryProposalsEvent);

const ROLE_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const LABEL_RE = /^[A-Za-z0-9._:/-]{1,100}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The text the duplicate check compares: case, whitespace and compatibility forms aside, the same words are the same proposal. */
export function normalizedMemoryHash(text: string): string {
  return createHash('sha256').update(text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(), 'utf8').digest('hex');
}

/** How many of a repository's most recent declined entries (rejected, retired, deleted, replaced by an edit) the dial compares a new proposal against. */
const DECLINED_LOOKUP_MAX = 400;

const intakeLockSql = `SELECT pg_advisory_xact_lock(hashtextextended('memory_intake:' || $1::text, 0))`;
/** The per-account intake lock (transaction-scoped, re-entrant within one transaction). */
export async function lockMemoryIntake(client: PoolClient, accountId: string): Promise<void> {
  await client.query(intakeLockSql, [accountId]);
}

/**
 * Reads `memory_proposals` from a run's envelope and stores what passes. Safe to call again for the same run: the second call finds the event
 * and writes nothing. It throws only for a database failure, in which case nothing is written and a later call tries again.
 */
export async function ingestMemoryProposals(input: IngestMemoryProposalsInput): Promise<IngestMemoryProposalsResult> {
  const raw = isRecord(input.envelope) ? input.envelope.memory_proposals : undefined;
  if (raw === undefined) return { status: 'none' };
  const list: unknown[] = Array.isArray(raw) ? raw : [null];
  const secrets = await input.liveSecrets();
  return withTenant(input.pool, input.accountId, (client) => ingestInClient(client, input, list, secrets));
}

/** The intake on a client the caller already holds (a userless tenant session). `input.eventKind` names the once-per-run event. */
export async function ingestInClient(client: PoolClient, input: Omit<IngestMemoryProposalsInput, 'pool'>, list: unknown[], secrets: readonly string[]): Promise<IngestMemoryProposalsResult> {
  {
    // One intake at a time per account: the pending count and the duplicate check below must see each other's rows.
    await lockMemoryIntake(client, input.accountId);
    // MEM-9: a function is asked now, inside the lock, so a merge that commits while this waited is seen (`deferredRole.ts` is the other half).
    if (typeof input.itemTerminal === 'function') input = { ...input, itemTerminal: await input.itemTerminal(client) };
    const done = await client.query('SELECT 1 FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = $3 LIMIT 1', [input.accountId, input.runId, input.eventKind ?? MEMORY_PROPOSALS_EVENT_KIND]);
    if (done.rowCount === 1) return { status: 'already_ingested' } as const;

    const event: MemoryProposalsEvent = { source: input.source, stored: [], refused: [] };
    let repoRef: string | null | undefined;
    let dial: AutoApproveDial | undefined;
    const readDial = async (): Promise<AutoApproveDial> => (dial ??= await currentAutoApproveDial(client, input));
    for (const [index, item] of list.entries()) {
      if (index >= MEMORY_PROPOSALS_PER_RUN) {
        event.refused.push({ index, reason: 'over_run_limit' });
        continue;
      }
      const outcome = await considerOne(client, input, secrets, item, async () => (repoRef === undefined ? (repoRef = (await input.resolveRepoScopeRef?.(client)) ?? null) : repoRef), readDial);
      if ('reason' in outcome) event.refused.push({ index, reason: outcome.reason });
      else event.stored.push({ index, ...outcome });
    }
    await input.recordEvent(client, event);
    return { status: 'ingested', ...event } as const;
  }
}

async function addEvidence(client: PoolClient, input: Omit<IngestMemoryProposalsInput, 'pool'>, entryId: string): Promise<void> {
  await client.query('INSERT INTO memory_entry_evidence (account_id, entry_id, run_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [input.accountId, entryId, input.runId]);
}

async function considerOne(
  client: PoolClient,
  input: Omit<IngestMemoryProposalsInput, 'pool'>,
  secrets: readonly string[],
  item: unknown,
  repoRef: () => Promise<string | null>,
  readDial: () => Promise<AutoApproveDial>,
): Promise<{ reason: MemoryIntakeReason } | { id: string; scope: MemoryScope; kind: MemoryKind; auto?: MemoryAutoApproveOutcome }> {
  if (!isRecord(item)) return { reason: 'invalid_proposal' };
  const { scope, kind, body, why } = item;
  if (typeof scope !== 'string' || typeof kind !== 'string' || !(MEMORY_KINDS as readonly string[]).includes(kind)) return { reason: 'invalid_proposal' };
  if (scope === 'account') return { reason: 'account_scope_person_only' };
  if (scope === 'role' && input.allowRoleScope !== true) return { reason: 'role_scope_person_only' };
  // MEM-9: a role lesson is the run's own role's, and only once its work item is done. A `role` key naming another role cannot be honoured.
  if (scope === 'role' && item.role !== undefined && item.role !== input.role) return { reason: 'role_mismatch' };
  if (scope !== 'item' && scope !== 'repo' && scope !== 'role') return { reason: 'invalid_proposal' };
  if (typeof body !== 'string' || (why !== undefined && why !== null && typeof why !== 'string')) return { reason: 'invalid_proposal' };

  let text: { body: string; why: string | null };
  try {
    text = prepareMemoryText(body, why as string | null | undefined, secrets);
  } catch (err) {
    if (err instanceof MemoryInputError) return { reason: err.code === 'secret_detected' ? 'secret_detected' : 'invalid_message' };
    throw err;
  }

  // MEM-9: the text is checked first (live tokens included), so a deferred role lesson that is taken in later has already passed the scan once.
  if (scope === 'role' && input.itemTerminal === false) return { reason: 'item_not_terminal' };
  const scopeRef = scope === 'item' ? input.workItemId : scope === 'role' ? (ROLE_RE.test(input.role) ? input.role : null) : await repoRef();
  if (scopeRef === null) return { reason: 'scope_unresolved' };

  // Approved entries and unexpired pending ones in the same scope. At most 200 + 20 rows of 1 KiB, so the comparison runs here, where the
  // normalisation is the one the tests pin.
  const { rows } = await client.query<{ id: string; body: string; status: string }>(
    `SELECT id, body, status FROM memory_entries
      WHERE account_id = $1 AND scope = $2 AND scope_ref IS NOT DISTINCT FROM $3 AND (status = 'approved' OR (status = 'proposed' AND expires_at > now()))`,
    [input.accountId, scope, scopeRef],
  );
  const hash = normalizedMemoryHash(text.body);
  const same = rows.find((r) => normalizedMemoryHash(r.body) === hash);
  if (same !== undefined) {
    // MEM-9: the same lesson from another run is evidence for the pending one (its repository may be the second one), not a second card.
    if (scope === 'role' && same.status === 'proposed') await addEvidence(client, input, same.id);
    return { reason: 'duplicate' };
  }
  if (scope === 'role' && rows.length >= MEMORY_ROLE_MAX_ENTRIES) return { reason: 'role_full' };
  if (rows.filter((r) => r.status === 'proposed').length >= MEMORY_PENDING_MAX_PER_SCOPE) return { reason: 'pending_full' };

  const provenance = {
    source_run_id: input.runId,
    ...(input.backend !== undefined && LABEL_RE.test(input.backend) ? { backend: input.backend } : {}),
    ...(input.modelId !== undefined && LABEL_RE.test(input.modelId) ? { model_id: input.modelId } : {}),
    input_trust_classes: ['untrusted'],
  };
  await client.query('SAVEPOINT memory_intake_one');
  let id: string;
  try {
    const res = await client.query<{ id: string }>('SELECT memory_propose($1, $2, $3, $4, $5, $6, $7::jsonb) AS id', [scope, scopeRef, kind, text.body, text.why, input.source, JSON.stringify(provenance)]);
    await client.query('RELEASE SAVEPOINT memory_intake_one');
    id = res.rows[0]!.id;
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT memory_intake_one');
    const mapped = mapMemoryDbError(err);
    if (mapped instanceof NotFoundError) return { reason: 'scope_unresolved' };
    if (mapped instanceof MemoryInputError) return { reason: 'invalid_message' };
    throw err;
  }
  if (scope === 'role') await addEvidence(client, input, id);
  // MEM-10: only now, after the shape, scope, text, duplicate and cap checks above have kept the proposal, may the dial approve it.
  const auto = await maybeAutoApprove(client, input, { id, scope: scope as MemoryScope, kind: kind as MemoryKind, scopeRef, hash }, readDial, repoRef);
  return { id, scope, kind: kind as MemoryKind, ...(auto === undefined ? {} : { auto }) };
}

/** The repository's `memory_auto_approve` dial as the intake sees it: the current version and whether it says `announce`. */
export type AutoApproveDial = { raised: false } | { raised: true; repoId: string; version: number };

async function currentAutoApproveDial(client: PoolClient, input: Omit<IngestMemoryProposalsInput, 'pool'>): Promise<AutoApproveDial> {
  if (typeof input.dialRepoId !== 'string') return { raised: false };
  const entry = getCatalogueEntry('memory_auto_approve');
  const row = await getCurrentDialSetting(client, input.dialRepoId, 'memory_auto_approve');
  const stored = row?.disposition;
  // A value the entry does not allow, or anything but `announce`, is not raised (fail closed).
  if (row === null || stored !== 'announce' || entry === undefined || !entry.allowedDispositions.includes('announce')) return { raised: false };
  return { raised: true, repoId: input.dialRepoId, version: row.version };
}

/**
 * MEM-10: approves a stored proposal by the repository's dial, in the intake's own transaction. The author kind is the ingest path's (`input.source`),
 * never anything in the proposal; an import or runner source, a kind other than fact and command, a place other than an item or a repository, and a run
 * with no work item (the receipt needs one, and so does Undo) are not touched. The database re-checks every one of those, the dial's version included.
 * A refusal leaves the proposal waiting for a person, exactly as before the dial existed, and is recorded on the run's event with a fixed word.
 */
async function maybeAutoApprove(
  client: PoolClient,
  input: Omit<IngestMemoryProposalsInput, 'pool'>,
  stored: { id: string; scope: MemoryScope; kind: MemoryKind; scopeRef: string; hash: string },
  readDial: () => Promise<AutoApproveDial>,
  repoRef: () => Promise<string | null>,
): Promise<MemoryAutoApproveOutcome | undefined> {
  if (!MEMORY_AUTO_APPROVE_SOURCES.includes(input.source)) return undefined;
  if (!MEMORY_AUTO_APPROVE_KINDS.includes(stored.kind) || !MEMORY_AUTO_APPROVE_SCOPES.includes(stored.scope) || input.workItemId === null) return undefined;
  const dial = await readDial();
  if (!dial.raised) return undefined;
  // A person's explicit no is left standing: the same text (case and whitespace aside) that a person rejected, retired, deleted or replaced by an edit
  // anywhere in this repository (its repo-scope entries and the entries of its work items) waits for a person instead of being approved. This is a floor
  // for honest repeats, not a boundary: a reworded text has another hash and is treated as new, and a deleted entry is purged after 30 days, so that no is
  // forgotten then. Looked up only here, for the rare proposal the dial could really approve, and bounded to the most recent entries.
  const ref = stored.scope === 'repo' ? stored.scopeRef : await repoRef();
  const declined = await client.query<{ body: string }>(
    `SELECT body FROM memory_entries
      WHERE account_id = $1 AND status IN ('rejected', 'retired', 'deleted', 'superseded')
        AND ((scope = 'repo' AND scope_ref = $2::text)
          OR (scope = 'item' AND scope_ref IN (SELECT id::text FROM work_items WHERE account_id = $1 AND repo_id = $3::uuid)))
      ORDER BY updated_at DESC LIMIT $4`,
    [input.accountId, ref, dial.repoId, DECLINED_LOOKUP_MAX],
  );
  if (declined.rows.some((r) => normalizedMemoryHash(r.body) === stored.hash)) return 'previously_declined';
  await client.query('SAVEPOINT memory_auto_approve_one');
  try {
    await withReversalWindow(client, 'memory_auto_approve', () =>
      client.query('SELECT memory_auto_approve($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::integer)', [stored.id, dial.repoId, input.runId, dial.version, CATALOGUE_VERSION]),
    );
    await client.query('RELEASE SAVEPOINT memory_auto_approve_one');
    return 'approved';
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT memory_auto_approve_one');
    const code = (err as { code?: string } | null)?.code;
    if (code === '54000') return 'memory_full';
    // The database's fixed refusals: not permitted, nothing eligible, invalid argument. Anything else is a real failure and is not hidden.
    if (code === '42501' || code === 'P0002' || code === '22023') return 'refused';
    throw err;
  }
}
