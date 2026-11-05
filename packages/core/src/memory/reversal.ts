import type { PoolClient } from 'pg';
import { CATALOGUE_VERSION } from '@fx/decisions';
import { withReversalWindow } from '@fx/db/src/receiptWriter.js';
import type { MemoryEntry } from './index.js';

/**
 * D#601 MEM-10: the reversal receipt of an Undo of an auto-approved memory entry (retire, undo approval, delete), attributed to the person whose session
 * this is. Only an entry no person approved (approved_by empty, as read BEFORE the step) from an agent or assistant can be one; the database decides
 * (it answers NULL for every other entry, and a repeat answers the first receipt) and its receipt is part of the caller's transaction, so an Undo and
 * its receipt succeed or fail together. The window is cleared first: a reversal itself has no deadline.
 */
export async function recordAutoApprovalReversal(client: PoolClient, before: Pick<MemoryEntry, 'id' | 'approvedBy' | 'authorKind'>): Promise<void> {
  if (before.approvedBy !== null || (before.authorKind !== 'agent' && before.authorKind !== 'assistant')) return;
  await withReversalWindow(client, 'reversal_recorded', () => client.query('SELECT memory_auto_approve_reversal($1::uuid, $2::integer)', [before.id, CATALOGUE_VERSION]));
}
