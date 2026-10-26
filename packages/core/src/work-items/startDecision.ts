import type { PoolClient } from 'pg';

/**
 * D#7 start gate, part (c): what the card says about how an item's start was decided. The facts come from the item's `start_gate` row (one per work item and
 * start decision type, readable by the tenant): the outcome, the preset the repo's dial was on, who decided and when. Nothing is derived from the clock and
 * nothing is stored for the card: the row is the record, and the receipt it points to is the same decision.
 *
 * Every sentence is fixed text around a closed set of values. An outcome, decision type or preset this file does not know reads as a safe generic sentence;
 * a code, an id or a database value never reaches the screen. The only free text is a person's display name, which the caller shows as plain text.
 */
export interface StartDecision {
  /** The gate's outcome as recorded, or `unknown` for a value this build does not know (the sentence is then generic). */
  state: 'asked' | 'started' | 'declined' | 'withdrawn' | 'unknown';
  /** Who decided: a signed-in person, the repo's dial (`policy`), or nobody yet (an open ask, a withdrawn one). */
  by: 'person' | 'dial' | null;
  /** The person's display name when `by` is `person` and the name is known; otherwise null (the sentence then says "a person"). */
  name: string | null;
  /** When it was decided (ISO), null while an ask is open. */
  at: string | null;
  sentence: string;
}

export interface StartGateFacts {
  outcome: string;
  decision_type: string;
  preset: string;
  decided_by: string | null;
  decided_at: Date | null;
  name: string | null;
}

const KIND_WORDS: Readonly<Record<string, string>> = {
  start_work_small: 'a small piece of work',
  start_work_bug: 'a bug fix',
  start_work_doc: 'a documentation change',
  start_parent_item: 'a feature, project or critical item',
  start_after_reclassify: 'an item that was judged larger than first thought',
};
const PRESET_WORDS: Readonly<Record<string, string>> = { cautious: 'Cautious', balanced: 'Balanced', autonomous: 'Autonomous' };
const NAME_MAX = 80;

const kindOf = (t: string): string => KIND_WORDS[t] ?? 'this kind of work';
/** "your Balanced setting", or "your start setting" for a preset this build does not know. */
const settingOf = (p: string): string => (PRESET_WORDS[p] ? `your ${PRESET_WORDS[p]} setting` : 'your start setting');

/** The card's start-decision block for one gate row. Pure: the same row always reads the same. */
export function describeStartDecision(g: StartGateFacts): StartDecision {
  const at = g.decided_at ? g.decided_at.toISOString() : null;
  const name = g.name !== null && g.name.trim() !== '' ? g.name.trim().slice(0, NAME_MAX) : null;
  const person = g.decided_by !== null && g.decided_by !== 'policy';
  const who = name ?? 'a person';
  switch (g.outcome) {
    case 'asked':
      return {
        state: 'asked', by: null, name: null, at: null,
        sentence: g.decision_type === 'start_after_reclassify'
          ? 'Waiting for an owner or admin to answer in Needs you: this item turned out larger than first judged, so it needs an answer before it goes on.'
          : `Waiting for an owner or admin to answer in Needs you: ${settingOf(g.preset)} asks before ${kindOf(g.decision_type)} starts.`,
      };
    case 'started':
      return person
        ? { state: 'started', by: 'person', name, at, sentence: `Started by ${who}.` }
        : { state: 'started', by: 'dial', name: null, at, sentence: `Started automatically under ${settingOf(g.preset)}. No one had to answer.` };
    case 'declined':
      return { state: 'declined', by: person ? 'person' : null, name: person ? name : null, at, sentence: `Held${person ? ` by ${who}` : ''}. It does not start until a person starts it.` };
    case 'withdrawn':
      return { state: 'withdrawn', by: null, name: null, at: null, sentence: 'The question about starting this was withdrawn before anyone answered. It is decided again the next time this item comes up to start.' };
    default:
      return { state: 'unknown', by: null, name: null, at: null, sentence: 'A decision about starting this item is on record.' };
  }
}

/**
 * The item's start decision for its card: the newest gate row (by when it was decided, else when it was made), or null when the item has none. An item that
 * never went through the gate (started before the gate existed) shows nothing rather than a guess.
 */
export async function readStartDecision(client: Pick<PoolClient, 'query'>, workItemId: string): Promise<StartDecision | null> {
  const { rows } = await client.query<StartGateFacts>(
    `SELECT g.outcome, g.decision_type, g.preset, g.decided_by, g.decided_at,
            COALESCE(NULLIF(u.name, ''), NULLIF(u.github_login, '')) AS name
       FROM start_gate g
       LEFT JOIN users u ON u.id::text = g.decided_by
      WHERE g.work_item_id = $1::uuid
      ORDER BY (g.outcome = 'asked') DESC, COALESCE(g.decided_at, g.created_at) DESC, g.id DESC
      LIMIT 1`,
    [workItemId],
  );
  return rows[0] ? describeStartDecision(rows[0]) : null;
}
