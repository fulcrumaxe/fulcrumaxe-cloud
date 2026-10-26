/**
 * D#2 H14c-3-3b-2 (C88 section 3): the two fixed stop codes the advance workflow records when a build stopped at a run limit and was not continued, and the
 * fixed sentence each one shows on the card. The text is ours: nothing from the run, the checkpoint or the agent ever reaches it, and a code this table does not
 * know shows "Needs your attention" (never a raw code, never null or undefined). None of the sentences names a button.
 */

/** The stop code of a park by a run limit; the park's `refused_by` is its one reason. */
export const RUN_LIMIT_PARKED_STOP = 'run_limit_parked';
/** The stop code of a park because the account's monthly budget was reached. */
export const MONTHLY_BUDGET_PARKED_STOP = 'monthly_budget_parked';
/** What a stop this table does not know shows. */
export const CONTINUATION_UNKNOWN_SENTENCE = 'Needs your attention';

/** Every `refused_by` a run-limit park can carry (the pipeline's `REFUSED_BY_CODES`; a test holds the two lists equal), with its sentence. */
export const RUN_LIMIT_PARK_SENTENCE: Readonly<Record<string, string>> = Object.freeze({
  auto_resume_off: "The build stopped at a run limit. Automatic continuation is off for this role, so it wasn't continued.",
  max_resumes: "The build stopped at a run limit again. It has used the automatic continuations its run limits allow, so it wasn't continued.",
  work_item_ceiling: "The build stopped at a run limit and can't be continued: this work item has used all its continuations.",
  silence_twice: "The build went quiet twice and was stopped, so it wasn't continued automatically.",
  spend: "The build was stopped by a spending limit, so it wasn't continued automatically.",
  foreign_session: "The build stopped at a run limit and couldn't be continued, because its session belongs to a different run.",
});
export const MONTHLY_BUDGET_PARK_SENTENCE = "The build was stopped because this account reached its monthly budget, so it wasn't continued.";

/** The sentence for a recorded stop, or null when the code is not one of this module's. An unknown reason under a known code is "Needs your attention". */
export function continuationStopSentence(code: string | null | undefined, reasons: readonly string[] | null | undefined): string | null {
  if (code === MONTHLY_BUDGET_PARKED_STOP) return MONTHLY_BUDGET_PARK_SENTENCE;
  if (code !== RUN_LIMIT_PARKED_STOP) return null;
  const key = reasons?.[0] ?? '';
  return Object.hasOwn(RUN_LIMIT_PARK_SENTENCE, key) ? RUN_LIMIT_PARK_SENTENCE[key]! : CONTINUATION_UNKNOWN_SENTENCE;
}
