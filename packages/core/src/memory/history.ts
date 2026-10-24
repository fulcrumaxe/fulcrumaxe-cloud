import { NotFoundError } from '../tenancy/errors.js';
import { inSession, MEMORY_STATUSES, type MemoryCtx, type MemoryStatus } from './index.js';

/**
 * D#601 MEM-4b1: the permanent history of one memory entry, read from the audit rows its definers and sweeps write (migrations 0793, 0880
 * and 0900), through the database's read seam for them (memory_history_read). The audit rows carry fixed keys only, never the entry's text,
 * so the history says what happened, when and by whom, and the text of each version is read from the entry's own rows (listMemoryVersions).
 *
 * An entry on screen is its whole version chain: the history covers every row connected to the asked id through `supersedes_id`, in both
 * directions, so an edit does not start a new history. The asked id is always included, so the history of an entry the 30 day purge removed
 * is still readable (its audit rows outlive it). Runs in the caller's session: another account's id answers NotFound, the same as an unknown one.
 */
export const MEMORY_HISTORY_ACTIONS = [
  'memory.proposed',
  'memory.written',
  'memory.approved',
  'memory.rejected',
  'memory.retired',
  'memory.reverted',
  'memory.edited',
  'memory.deleted',
  'memory.restored',
  'memory.receipt_promoted',
  'memory.expired',
  'memory.purged',
] as const;
export type MemoryHistoryAction = (typeof MEMORY_HISTORY_ACTIONS)[number];

/** The most events one read returns (oldest first). An entry's chain has far fewer in practice. */
export const MEMORY_HISTORY_MAX_EVENTS = 500;

/** Who did it. A person is a user id (render the name, or "a former member" once the user is gone); the rest are fixed system sources. */
export type MemoryHistoryActor =
  | { kind: 'person'; userId: string }
  | { kind: 'system'; source: 'pipeline' | 'memory_sweep' }
  /** An actor text this reader does not know. Never shown as raw text. */
  | { kind: 'unknown' };

export interface MemoryHistoryEvent {
  at: Date;
  action: MemoryHistoryAction;
  /** The version row the event happened to (an edit names the new version). */
  entryId: string;
  version: number | null;
  fromStatus: MemoryStatus | null;
  /** Null for a purge: the row no longer has a status. */
  toStatus: MemoryStatus | null;
  actor: MemoryHistoryActor;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toStatus(v: unknown): MemoryStatus | null {
  return typeof v === 'string' && (MEMORY_STATUSES as readonly string[]).includes(v) ? (v as MemoryStatus) : null;
}

export function memoryHistoryActor(actor: string | null): MemoryHistoryActor {
  if (actor !== null && UUID_RE.test(actor)) return { kind: 'person', userId: actor.toLowerCase() };
  if (actor === 'system:pipeline') return { kind: 'system', source: 'pipeline' };
  if (actor === 'system:memory_sweep') return { kind: 'system', source: 'memory_sweep' };
  return { kind: 'unknown' };
}

export async function memoryHistory(ctx: Pick<MemoryCtx, 'pool' | 'principal'>, entryId: string): Promise<MemoryHistoryEvent[]> {
  if (typeof entryId !== 'string' || !UUID_RE.test(entryId)) throw new NotFoundError('memory entry not found');
  const id = entryId.toLowerCase();
  // The read goes through memory_history_read (migration 0900, in 0653's shape): it walks the version chain and reads the audit rows as the
  // caller, under their tenant row policies, with the memory actions fixed in the database.
  const rows = await inSession(ctx, async (client) => {
    return (
      await client.query<{ created_at: Date; action: MemoryHistoryAction; actor: string | null; payload: Record<string, unknown> | null }>(
        'SELECT created_at, action, actor, payload FROM memory_history_read($1::uuid, $2::int)',
        [id, MEMORY_HISTORY_MAX_EVENTS],
      )
    ).rows;
  });
  if (rows.length === 0) throw new NotFoundError('memory entry not found');
  const known = new Set<string>(MEMORY_HISTORY_ACTIONS);
  return rows.filter((r) => known.has(r.action)).map((r) => {
    const p = r.payload ?? {};
    return {
      at: r.created_at,
      action: r.action,
      entryId: typeof p.entry_id === 'string' ? p.entry_id : id,
      version: typeof p.version === 'number' ? p.version : null,
      fromStatus: toStatus(p.from_status),
      toStatus: toStatus(p.to_status),
      actor: memoryHistoryActor(r.actor),
    };
  });
}
