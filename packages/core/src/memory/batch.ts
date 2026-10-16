import { MemoryInputError, assertUuid, inSession, readEntries, type MemoryAuthorKind, type MemoryCtx, type MemoryEntry } from './index.js';

/**
 * D#601 MEM-4a1a: the two calls the review queue acts with, "this card was opened" and "decide this batch". Every rule lives in the database
 * (migration 0835); this module validates the shape of the call, asks the database, and maps its refusals onto the errors a route answers.
 */
/** The sources whose cards must be opened before they can be batched. */
export const MEMORY_GATED_AUTHOR_KINDS: readonly MemoryAuthorKind[] = ['import', 'runner_agent'];
export const MEMORY_BATCH_MAX = 20;
export const MEMORY_BATCH_DECISIONS = ['approved', 'rejected'] as const;
export type MemoryBatchDecision = (typeof MEMORY_BATCH_DECISIONS)[number];

type ReadCtx = Pick<MemoryCtx, 'pool' | 'principal'>;

/**
 * The card for this version of this entry was requested by the caller. True when the database recorded it (a proposed `import` or `runner_agent`
 * entry); false for any other entry, which needs no record. Opening changes no entry. The same right as deciding is required: a member who may
 * not decide on a repo entry gets Forbidden, and another account's id is NotFound.
 */
export async function markMemoryOpened(ctx: ReadCtx, id: string): Promise<{ opened: boolean }> {
  assertUuid('memory entry', id);
  return inSession(ctx, async (client) => {
    const { rows } = await client.query<{ r: boolean }>('SELECT memory_mark_opened($1::uuid) AS r', [id]);
    return { opened: rows[0]!.r };
  });
}

/**
 * Approves or rejects up to 20 entries in one transaction, all or nothing. The database requires one source for the whole batch (`mixed_sources`),
 * and an open record by the caller, for the entry's current text, on every imported or runner-sourced entry (`must_open_first`, whose error carries
 * how many were unopened). A refusal changes nothing.
 */
export async function decideMemoryBatch(ctx: ReadCtx, input: { ids: readonly string[]; to: MemoryBatchDecision }): Promise<{ decided: number; entries: MemoryEntry[] }> {
  if (!(MEMORY_BATCH_DECISIONS as readonly string[]).includes(input.to)) throw new MemoryInputError('invalid_message', 'a batch approves or rejects');
  if (input.ids.length === 0) throw new MemoryInputError('invalid_message', 'a batch needs at least one entry');
  if (input.ids.length > MEMORY_BATCH_MAX) throw new MemoryInputError('invalid_message', `a batch holds at most ${MEMORY_BATCH_MAX} entries`);
  for (const id of input.ids) assertUuid('memory entry', id);
  return inSession(ctx, async (client) => {
    const { rows } = await client.query<{ n: number }>('SELECT memory_decide_batch($1::uuid[], $2) AS n', [[...input.ids], input.to]);
    return { decided: rows[0]!.n, entries: await readEntries(client, input.ids) };
  });
}
