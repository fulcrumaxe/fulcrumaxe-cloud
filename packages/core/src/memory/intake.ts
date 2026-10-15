import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';
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
 * (account entries are person-written only; role entries from an agent are off until the owner rules otherwise, see `allowRoleScope`); the
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
] as const;
export type MemoryIntakeReason = (typeof MEMORY_INTAKE_REASONS)[number];

/** Who wrote the bytes. `runner_agent` is for the runner's consented upload (MEM-6), which runs these same checks. */
export type MemoryProposalSource = Extract<MemoryAuthorKind, 'agent' | 'assistant' | 'runner_agent'>;

export const MEMORY_PROPOSALS_EVENT_KIND = 'memory.proposals';

export interface MemoryProposalsEvent {
  source: MemoryProposalSource;
  stored: Array<{ index: number; id: string; scope: MemoryScope; kind: MemoryKind }>;
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
  /** Agent-proposed role lessons (R-601-2). Off here; MEM-9 turns it on. */
  allowRoleScope?: boolean;
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

const intakeLockSql = `SELECT pg_advisory_xact_lock(hashtextextended('memory_intake:' || $1::text, 0))`;

/**
 * Reads `memory_proposals` from a run's envelope and stores what passes. Safe to call again for the same run: the second call finds the event
 * and writes nothing. It throws only for a database failure, in which case nothing is written and a later call tries again.
 */
export async function ingestMemoryProposals(input: IngestMemoryProposalsInput): Promise<IngestMemoryProposalsResult> {
  const raw = isRecord(input.envelope) ? input.envelope.memory_proposals : undefined;
  if (raw === undefined) return { status: 'none' };
  const list: unknown[] = Array.isArray(raw) ? raw : [null];
  const secrets = await input.liveSecrets();

  return withTenant(input.pool, input.accountId, async (client) => {
    // One intake at a time per account: the pending count and the duplicate check below must see each other's rows.
    await client.query(intakeLockSql, [input.accountId]);
    const done = await client.query('SELECT 1 FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = $3 LIMIT 1', [input.accountId, input.runId, MEMORY_PROPOSALS_EVENT_KIND]);
    if (done.rowCount === 1) return { status: 'already_ingested' } as const;

    const event: MemoryProposalsEvent = { source: input.source, stored: [], refused: [] };
    let repoRef: string | null | undefined;
    for (const [index, item] of list.entries()) {
      if (index >= MEMORY_PROPOSALS_PER_RUN) {
        event.refused.push({ index, reason: 'over_run_limit' });
        continue;
      }
      const outcome = await considerOne(client, input, secrets, item, async () => (repoRef === undefined ? (repoRef = (await input.resolveRepoScopeRef?.(client)) ?? null) : repoRef));
      if ('reason' in outcome) event.refused.push({ index, reason: outcome.reason });
      else event.stored.push({ index, ...outcome });
    }
    await input.recordEvent(client, event);
    return { status: 'ingested', ...event } as const;
  });
}

async function considerOne(
  client: PoolClient,
  input: IngestMemoryProposalsInput,
  secrets: readonly string[],
  item: unknown,
  repoRef: () => Promise<string | null>,
): Promise<{ reason: MemoryIntakeReason } | { id: string; scope: MemoryScope; kind: MemoryKind }> {
  if (!isRecord(item)) return { reason: 'invalid_proposal' };
  const { scope, kind, body, why } = item;
  if (typeof scope !== 'string' || typeof kind !== 'string' || !(MEMORY_KINDS as readonly string[]).includes(kind)) return { reason: 'invalid_proposal' };
  if (scope === 'account') return { reason: 'account_scope_person_only' };
  if (scope === 'role' && input.allowRoleScope !== true) return { reason: 'role_scope_person_only' };
  if (scope !== 'item' && scope !== 'repo' && scope !== 'role') return { reason: 'invalid_proposal' };
  if (typeof body !== 'string' || (why !== undefined && why !== null && typeof why !== 'string')) return { reason: 'invalid_proposal' };

  let text: { body: string; why: string | null };
  try {
    text = prepareMemoryText(body, why as string | null | undefined, secrets);
  } catch (err) {
    if (err instanceof MemoryInputError) return { reason: err.code === 'secret_detected' ? 'secret_detected' : 'invalid_message' };
    throw err;
  }

  const scopeRef = scope === 'item' ? input.workItemId : scope === 'role' ? (ROLE_RE.test(input.role) ? input.role : null) : await repoRef();
  if (scopeRef === null) return { reason: 'scope_unresolved' };

  // Approved entries and unexpired pending ones in the same scope. At most 200 + 20 rows of 1 KiB, so the comparison runs here, where the
  // normalisation is the one the tests pin.
  const { rows } = await client.query<{ body: string; status: string }>(
    `SELECT body, status FROM memory_entries
      WHERE account_id = $1 AND scope = $2 AND scope_ref IS NOT DISTINCT FROM $3 AND (status = 'approved' OR (status = 'proposed' AND expires_at > now()))`,
    [input.accountId, scope, scopeRef],
  );
  const hash = normalizedMemoryHash(text.body);
  if (rows.some((r) => normalizedMemoryHash(r.body) === hash)) return { reason: 'duplicate' };
  if (rows.filter((r) => r.status === 'proposed').length >= MEMORY_PENDING_MAX_PER_SCOPE) return { reason: 'pending_full' };

  const provenance = {
    source_run_id: input.runId,
    ...(input.backend !== undefined && LABEL_RE.test(input.backend) ? { backend: input.backend } : {}),
    ...(input.modelId !== undefined && LABEL_RE.test(input.modelId) ? { model_id: input.modelId } : {}),
    input_trust_classes: ['untrusted'],
  };
  await client.query('SAVEPOINT memory_intake_one');
  try {
    const res = await client.query<{ id: string }>('SELECT memory_propose($1, $2, $3, $4, $5, $6, $7::jsonb) AS id', [scope, scopeRef, kind, text.body, text.why, input.source, JSON.stringify(provenance)]);
    await client.query('RELEASE SAVEPOINT memory_intake_one');
    return { id: res.rows[0]!.id, scope, kind: kind as MemoryKind };
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT memory_intake_one');
    const mapped = mapMemoryDbError(err);
    if (mapped instanceof NotFoundError) return { reason: 'scope_unresolved' };
    if (mapped instanceof MemoryInputError) return { reason: 'invalid_message' };
    throw err;
  }
}
