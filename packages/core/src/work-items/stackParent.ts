import type { PoolClient } from 'pg';
import { NotFoundError } from '../tenancy/errors.js';

/**
 * D#598 P3a: the one write path for `work_items.stack_parent_id`, the link from an item to the item whose open pull request its work
 * builds on. It is not `parent_id` (provenance). Callers are the Spec split and the task-dependency import; both hand it an item id
 * and a parent id, and nothing here looks at which repo, which account plan or which pairing the item has: the same rules hold for
 * every connected repo.
 *
 * Run it on a tenant-scoped client (`withTenant`). Row security hides another account's rows, so a foreign id is `NotFoundError`,
 * the same answer as a missing one. The database is the enforcement (migration 0821: self, cross-repo and cycle are refused by a
 * constraint and a trigger, for any writer); this function turns those refusals into a typed error a caller can show in words.
 * Nothing about the parent's pull request is stored on the child: that state is read from the parent when it is needed.
 */
export type StackLinkErrorCode = 'invalid_input' | 'self' | 'cross_repo' | 'cycle';

/** Maps to 422. `code` says which rule refused. */
export class StackLinkError extends Error {
  constructor(
    public readonly code: StackLinkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StackLinkError';
  }
}

export interface SetStackParentInput {
  workItemId: string;
  /** The item to stack on, or null to clear the link (the item's next run starts from the repo's main). */
  stackParentId: string | null;
}

export interface SetStackParentResult {
  workItemId: string;
  stackParentId: string | null;
  /** False when the link already had this value: no write was made. */
  changed: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PgError {
  code?: string;
  constraint?: string;
}

export async function setStackParent(client: PoolClient, input: SetStackParentInput): Promise<SetStackParentResult> {
  const { workItemId, stackParentId } = input;
  if (typeof workItemId !== 'string' || !UUID_RE.test(workItemId)) {
    throw new StackLinkError('invalid_input', 'workItemId must be a work item id');
  }
  if (stackParentId !== null && (typeof stackParentId !== 'string' || !UUID_RE.test(stackParentId))) {
    throw new StackLinkError('invalid_input', 'stackParentId must be a work item id or null');
  }
  if (stackParentId !== null && stackParentId.toLowerCase() === workItemId.toLowerCase()) {
    throw new StackLinkError('self', 'an item cannot be stacked on itself');
  }

  const { rows } = await client.query<{ stack_parent_id: string | null }>(
    `SELECT stack_parent_id FROM work_items WHERE id = $1 FOR UPDATE`,
    [workItemId],
  );
  if (rows.length === 0) throw new NotFoundError('work item not found');
  const current = rows[0]!.stack_parent_id;
  if (current === null && stackParentId === null) {
    return { workItemId, stackParentId: null, changed: false };
  }
  if (current !== null && stackParentId !== null && current.toLowerCase() === stackParentId.toLowerCase()) {
    return { workItemId, stackParentId: current, changed: false };
  }

  try {
    await client.query(`UPDATE work_items SET stack_parent_id = $2 WHERE id = $1`, [workItemId, stackParentId]);
  } catch (err) {
    const e = err as PgError;
    if (e.code === '23514' && e.constraint === 'work_items_stack_cycle') {
      throw new StackLinkError('cycle', 'this stack link would create a cycle');
    }
    if (e.code === '23514' && e.constraint === 'work_items_stack_cross_repo') {
      throw new StackLinkError('cross_repo', 'an item can only be stacked on an item of the same repo');
    }
    if (e.code === '23514' && e.constraint === 'work_items_stack_not_self') {
      throw new StackLinkError('self', 'an item cannot be stacked on itself');
    }
    if (e.code === '23503') throw new NotFoundError('stack parent not found');
    throw err;
  }
  return { workItemId, stackParentId, changed: true };
}

/** The item's stack parent id, or null for no link. A missing or foreign item is `NotFoundError`. */
export async function readStackParent(client: PoolClient, workItemId: string): Promise<string | null> {
  if (!UUID_RE.test(workItemId)) throw new NotFoundError('work item not found');
  const { rows } = await client.query<{ stack_parent_id: string | null }>(
    `SELECT stack_parent_id FROM work_items WHERE id = $1`,
    [workItemId],
  );
  if (rows.length === 0) throw new NotFoundError('work item not found');
  return rows[0]!.stack_parent_id;
}
