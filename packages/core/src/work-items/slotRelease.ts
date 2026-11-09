/**
 * An item whose pull request is stopped for a person holds no build slot.
 *
 * A slot is for work that is moving. At the review stages (`pr_opened`, `changes_requested`, `review_passed`) the item normally waits on reviewers or on the merge
 * check; when the driver has stopped there and only a person can restart it, the slot would sit idle (on a runner repository held to one build, that stops every other
 * build on the repository). So such an item stops counting toward the repository and account limits while its stop is the newest thing on its record.
 *
 * Nothing is stored for this. The item is released while the facts below hold and counts again the moment any later driver fact is written (a review started, a head
 * pushed, a fix round, a merge check ...): the person pressing "continue the review" on the card, or a push of theirs, does that. It does not wait for a slot to
 * restart: like a lowered limit, the count may then be over the limit and the next claim waits until it is back under. The stage never changes.
 *
 * The pipeline's slot code imports this module (@fx/core cannot import that package); a test there pins the stage lists equal.
 */

/** The stages at which a stop can release a slot. `in_progress` is a live build: its stops move the item to Needs a person, which holds none. */
export const SLOT_RELEASE_STAGES: readonly string[] = Object.freeze(['pr_opened', 'changes_requested', 'review_passed']);

/** `stopped` codes that really end in Needs a person at a review stage (stalled.ts STOP_WORDS words each). Any `not_started_*` code is also one. A code that nothing writes as `stopped`, or that a later step can clear on its own, must not be added: it would free the slot of an item about to merge. */
export const SLOT_RELEASING_STOP_CODES: readonly string[] = Object.freeze([
  'reviewer_environment',
  'review_quiet_period_unsettled',
  'review_key_missing',
]);

/** True for a driver fact that only a person can restart (the facts `slotReleasedSql` looks for). */
export function isPersonOnlyStop(kind: string, code: string | null): boolean {
  return kind === 'escalated' || (kind === 'stopped' && code !== null && (SLOT_RELEASING_STOP_CODES.includes(code) || code.startsWith('not_started_')));
}

/** Written only by the platform sweep: never a sign the item moved, so it is skipped when finding the newest fact. */
const SWEEP_ONLY_KINDS: readonly string[] = Object.freeze(['platform_check']);

const quoted = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(', ');

/**
 * SQL (a boolean expression) that is true when the work item row `alias` is released: at a release stage and its newest driver fact (not a sweep note) is either an
 * `escalated` fact (handed to a person) or a `stopped` fact with one of the codes above. `alias` is a trusted identifier from the caller's own query, never input.
 * The expression takes no parameters.
 */
export function slotReleasedSql(alias: string): string {
  return `(${alias}.stage IN (${quoted(SLOT_RELEASE_STAGES)}) AND EXISTS (
    SELECT 1 FROM (
      SELECT x.kind, x.code FROM work_item_driver_events x
       WHERE x.account_id = ${alias}.account_id AND x.work_item_id = ${alias}.id AND x.kind NOT IN (${quoted(SWEEP_ONLY_KINDS)})
       ORDER BY x.seq DESC LIMIT 1
    ) nf
     WHERE nf.kind = 'escalated' OR (nf.kind = 'stopped' AND (nf.code IN (${quoted(SLOT_RELEASING_STOP_CODES)}) OR nf.code LIKE 'not\\_started\\_%'))
  ))`;
}

/** SQL: the item holds a slot: it sits at one of `stagesParam` (a `text[]` parameter, e.g. `$3::text[]`) and is not released. */
export function holdsSlotSql(alias: string, stagesParam: string): string {
  return `(${alias}.stage = ANY(${stagesParam}) AND NOT ${slotReleasedSql(alias)})`;
}
