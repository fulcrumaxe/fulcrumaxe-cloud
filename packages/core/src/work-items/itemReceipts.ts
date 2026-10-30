import type { PoolClient } from 'pg';
import { DECISION_LABELS, decisionLabel } from '@fx/decisions';

/**
 * D#7 DW-R5: the class 2 and class 3 receipts recorded for one work item, for its card. Read only, from `decision_receipts` under the caller's tenant
 * (RLS scopes the account). Class 1 lives in `run_events` and is never listed here. Nothing is stored for the card: the list is derived from the rows on every read,
 * so a reversal adds an entry and never hides the original.
 *
 * Only closed values reach the answer: a catalogue label, a class number, a time, `policy` or `person`, and option ids that match OPTION_ID (anything else is
 * replaced by a fixed word). A user id, a free-text column or a database value never appears. This is the one receipts query for an item: the reverse routes reuse it.
 */
export interface ItemReceipt {
  id: string;
  /** The approved customer-facing name of the decision (a fixed word for a type that is not a plain catalogue-style id). */
  label: string;
  class: 2 | 3;
  at: string;
  by: 'policy' | 'person';
  chosen: string;
  rejected: string;
}
export interface ItemReceipts {
  /** Newest first, at most RECEIPTS_MAX. */
  receipts: ItemReceipt[];
  /** How many receipts the item holds in all (more than `receipts.length` when the list was cut). */
  total: number;
}

export const RECEIPTS_MAX = 50;
/** Copy of the pattern the receipt writer enforces (packages/db/src/receiptWriter.ts): an id that does not match it is never shown. */
const OPTION_ID = /^[a-z0-9_.:-]{1,128}$/;
const TYPE_ID = /^[a-z][a-z0-9_]{0,63}$/;
export const RECEIPT_NOT_SHOWN = '(not shown)';
export const RECEIPT_UNKNOWN_LABEL = 'A decision';

const option = (v: string | null): string => (v !== null && OPTION_ID.test(v) ? v : RECEIPT_NOT_SHOWN);
/** The catalogue name, else a plain id read with spaces; a type that is not a plain id gets a fixed word. */
const labelOf = (t: string): string => (Object.hasOwn(DECISION_LABELS, t) || TYPE_ID.test(t) ? decisionLabel(t) : RECEIPT_UNKNOWN_LABEL);

interface Row {
  id: string;
  decision_type: string;
  class: string;
  chosen: string | null;
  rejected_alternative: string | null;
  actor: string | null;
  created_at: Date;
  total: number;
}

/** The item's class 2 and class 3 receipts, newest first, or null when it has none (the answer then carries no `receipts`). */
export async function readItemReceipts(client: Pick<PoolClient, 'query'>, workItemId: string): Promise<ItemReceipts | null> {
  const { rows } = await client.query<Row>(
    `SELECT id, decision_type, class, chosen, rejected_alternative, actor, created_at, (count(*) OVER ())::int AS total
       FROM decision_receipts
      WHERE work_item_id = $1::uuid AND class IN ('human_over_the_loop', 'human_in_the_loop')
      ORDER BY created_at DESC, id DESC
      LIMIT ${RECEIPTS_MAX}`,
    [workItemId],
  );
  if (rows.length === 0) return null;
  return {
    receipts: rows.map((r) => ({
      id: r.id,
      label: labelOf(r.decision_type),
      class: r.class === 'human_in_the_loop' ? 3 : 2,
      at: r.created_at.toISOString(),
      by: r.actor === 'policy' ? 'policy' : 'person',
      chosen: option(r.chosen),
      rejected: option(r.rejected_alternative),
    })),
    total: rows[0]!.total,
  };
}
