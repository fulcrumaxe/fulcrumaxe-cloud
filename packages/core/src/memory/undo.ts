import { NotFoundError } from '../tenancy/errors.js';
import { MemoryInputError, assertUuid, editMemory, inSession, readEntries, type MemoryCtx, type MemoryEntry } from './index.js';

/**
 * D#601 MEM-4b2: the undo calls of the review screens that no existing definer call names on its own: step an entry back to where it was
 * (approve, reject, retire, expiry) and restore the version an edit replaced. Every rule stays in the database: the steps are `memory_decide`
 * (who may, which transition is legal, the room check on approval) and the restore is `memory_edit` (a new version, the author kind carried over,
 * the one-successor index). This module only names the step, checks the entry is where the step starts from, and maps the refusals.
 */
export const MEMORY_REVERT_ACTIONS = ['undo_approve', 'reconsider', 'renew', 'restore_retired', 'retire'] as const;
export type MemoryRevertAction = (typeof MEMORY_REVERT_ACTIONS)[number];
/** The most entries one revert call takes: the same as a batch decision, so "a batch has one Undo" is one call. */
export const MEMORY_REVERT_MAX = 20;

const STEPS: Readonly<Record<MemoryRevertAction, { from: string; to: 'proposed' | 'approved' | 'retired' }>> = {
  undo_approve: { from: 'approved', to: 'proposed' },
  reconsider: { from: 'rejected', to: 'proposed' },
  // Renewing an expired proposal gives it a new 14-day expiry (the definer sets it).
  renew: { from: 'expired', to: 'proposed' },
  restore_retired: { from: 'retired', to: 'approved' },
  retire: { from: 'approved', to: 'retired' },
};

type ReadCtx = Pick<MemoryCtx, 'pool' | 'principal'>;

/**
 * Steps up to 20 entries from the state the action starts at to the state it ends at, all or nothing in one transaction. An entry that is not in
 * the starting state is refused (`invalid_transition`) and nothing changes: an Undo that arrives after the entry moved on must not move it again.
 * The database re-derives the caller's rights per entry (owner or admin for repo and account entries).
 */
export async function revertMemory(ctx: ReadCtx, input: { ids: readonly string[]; action: MemoryRevertAction }): Promise<{ changed: number; entries: MemoryEntry[] }> {
  if (!Object.hasOwn(STEPS, input.action)) throw new MemoryInputError('invalid_message', 'unknown action');
  const step = STEPS[input.action];
  if (input.ids.length === 0) throw new MemoryInputError('invalid_message', 'name at least one entry');
  if (input.ids.length > MEMORY_REVERT_MAX) throw new MemoryInputError('invalid_message', `at most ${MEMORY_REVERT_MAX} entries at once`);
  const ids = [...new Set(input.ids.map((i) => i.toLowerCase()))];
  for (const id of ids) assertUuid('memory entry', id);
  return inSession(ctx, async (client) => {
    const found = await readEntries(client, ids);
    if (found.length !== ids.length) throw new NotFoundError('memory entry not found');
    for (const e of found) {
      if (e.status !== step.from) throw new MemoryInputError('invalid_transition', `only ${step.from} entries can be moved by ${input.action}`);
    }
    let changed = 0;
    for (const id of ids) {
      const { rows } = await client.query<{ r: string }>('SELECT memory_decide($1::uuid, $2) AS r', [id, step.to]);
      if (rows[0]!.r === 'decided') changed += 1;
    }
    return { changed, entries: await readEntries(client, ids) };
  });
}

/**
 * "Restore previous": makes the version an edit replaced the current one again, as a NEW version (the chain only grows; nothing is rewritten).
 * The old text, reason, kind and place come back through `editMemory`, so the text runs the same secret scan and cleaning as any edit (text that
 * has since become a live token value is refused), the author kind stays what it was, and the caller needs the same right as for an edit.
 * An entry with no earlier version is refused (`invalid_transition`); a version that was already edited since answers `conflict`.
 */
export async function restorePreviousMemory(ctx: MemoryCtx, id: string): Promise<{ entry: MemoryEntry; previousId: string }> {
  assertUuid('memory entry', id);
  const { cur, prev } = await inSession(ctx, async (client) => {
    const [cur] = await readEntries(client, [id]);
    if (cur === undefined) throw new NotFoundError('memory entry not found');
    if (cur.supersedesId === null) throw new MemoryInputError('invalid_transition', 'this entry has no earlier version');
    const [prev] = await readEntries(client, [cur.supersedesId]);
    if (prev === undefined) throw new MemoryInputError('invalid_transition', 'this entry has no earlier version');
    return { cur, prev };
  });
  const moved = prev.scope !== cur.scope || prev.scopeRef !== cur.scopeRef;
  const entry = await editMemory(ctx, {
    id: cur.id,
    body: prev.body,
    why: prev.why,
    kind: prev.kind,
    ...(moved ? { scope: prev.scope, scopeRef: prev.scopeRef } : {}),
  });
  return { entry, previousId: cur.id };
}
