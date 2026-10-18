import type { SetupRequestCheckKind, SetupRequestState } from './kinds.js';

/**
 * D#598 P8b: the words a person reads about a setup request's check. One constant per sentence, filled only from structured fields (the
 * interval, the variable's name, the project's name, the environment, a reason CODE). Nothing here is built from an agent's text, and a
 * check's reason is always one code from {@link CHECK_REASON_CODES}, never free text. The API exposes these strings and the screens render
 * them as plain text (P8c).
 */

/** How often a request with an automatic check is looked at: the cron runs once a minute. The sentence below states this number. */
export const CHECK_INTERVAL_SECONDS = 60;

/** The reasons an env-var check can give for "not yet", in the order a person is most likely to meet them. */
export const CHECK_REASON_CODES = ['env_var_missing', 'env_var_wrong_target', 'check_unavailable'] as const;
export type CheckReasonCode = (typeof CHECK_REASON_CODES)[number];
export function isCheckReasonCode(value: unknown): value is CheckReasonCode {
  return typeof value === 'string' && (CHECK_REASON_CODES as readonly string[]).includes(value);
}

/** The provider named in `check_unavailable`, and the environment the env-var check requires. */
export const CHECK_PROVIDER_NAME = 'Vercel';
export const ENV_VAR_CHECK_ENVIRONMENT = 'production';

export const COPY_WAITING_CHECKED = "We check for this every {interval}. The item continues by itself once it's done, or press Mark done.";
export const COPY_WAITING_UNCHECKED = "We can't check this one for you. Press Mark done when it's finished.";
export const COPY_CHECKING_NOW = 'Checking now.';
export const COPY_REPAUSED = "We checked and it isn't done yet: {reason}. The item is paused again.";
export const COPY_REASON: Readonly<Record<CheckReasonCode, string>> = {
  env_var_missing: "{name} isn't set on {project} yet.",
  env_var_wrong_target: '{name} is set on {project}, but not for {environment}.',
  check_unavailable: "We couldn't reach {provider} to check.",
};

function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-z]+)\}/g, (whole, key: string) => values[key] ?? whole);
}

const secondsText = (n: number): string => `${n} ${n === 1 ? 'second' : 'seconds'}`;

/** What the check found, as a sentence. `name` and `project` are the request's own structured fields. */
export function checkReasonSentence(code: CheckReasonCode, fields: { name: string; project: string }): string {
  return fill(COPY_REASON[code], { name: fields.name, project: fields.project, environment: ENV_VAR_CHECK_ENVIRONMENT, provider: CHECK_PROVIDER_NAME });
}

/** Sentence 4: "Mark done" was pressed and the check says it is not done. The reason's own full stop is dropped so the sentence does not end ".." before "The item". */
export function repausedSentence(code: CheckReasonCode, fields: { name: string; project: string }): string {
  return fill(COPY_REPAUSED, { reason: checkReasonSentence(code, fields).replace(/\.$/, '') });
}

/** How long "Checking now." is believed after Mark done: a check that has not answered by then is not still running (its caller died). */
export const CHECKING_NOW_WINDOW_MS = 120_000;

export interface StatusSentenceInput {
  state: SetupRequestState;
  checkKind: SetupRequestCheckKind | null;
  /** The code the last check left on an open request, if any. */
  checkReason: string | null;
  resolution?: 'marked_done' | 'check_passed' | 'condition_cleared' | 'withdrawn' | null;
  resolvedAt?: Date | null;
  checkRanAt?: Date | null;
  /** Set when the check after Mark done put the request back (or folded into the newer open request for the same step). */
  repausedAt?: Date | null;
  /** The project's name and the variable's name: the fields sentence 4 is filled from. */
  target?: string;
  envName?: string | null;
}

export interface StatusSentenceOptions {
  /** False while no credential source is bound to the provider. */
  checksAvailable: boolean;
  intervalSeconds?: number;
  /** Epoch ms; default now. Only sentence 3 reads the clock. */
  now?: number;
}

/**
 * The line a request shows, derived from its row on every read (nothing is stamped for it):
 *  - open and never put back: sentence 1 (a check runs) or 2 (it cannot be checked). A request with a check gets sentence 1 only while checks
 *    can really run: `checksAvailable` is false while no credential source is bound to the provider, and a request whose last check could not
 *    reach the provider reads as unchecked, so the page never promises a check that is not happening.
 *  - open and put back by the check after Mark done: sentence 4, with the check's reason.
 *  - marked done with its check not yet answered: sentence 3, for {@link CHECKING_NOW_WINDOW_MS} at most.
 *  - anything else (done and answered, withdrawn): null.
 */
export function statusSentence(request: StatusSentenceInput, opts: StatusSentenceOptions): string | null {
  if (request.state === 'done') {
    const resolvedAt = request.resolvedAt ?? null;
    const ranAt = request.checkRanAt ?? null;
    const pending =
      request.resolution === 'marked_done' && request.checkKind !== null && opts.checksAvailable && resolvedAt !== null &&
      (ranAt === null || ranAt.getTime() <= resolvedAt.getTime()) &&
      (opts.now ?? Date.now()) - resolvedAt.getTime() <= CHECKING_NOW_WINDOW_MS;
    return pending ? COPY_CHECKING_NOW : null;
  }
  if (request.state !== 'open') return null;
  if (request.checkKind === null || !opts.checksAvailable || request.checkReason === 'check_unavailable') return COPY_WAITING_UNCHECKED;
  if ((request.repausedAt ?? null) !== null && isCheckReasonCode(request.checkReason) && request.target !== undefined) {
    return repausedSentence(request.checkReason, { name: request.envName ?? request.target, project: request.target });
  }
  return fill(COPY_WAITING_CHECKED, { interval: secondsText(opts.intervalSeconds ?? CHECK_INTERVAL_SECONDS) });
}

/** The interval the API states for a request: the constant while it waits on an automatic check that can run, else null. */
export function checkIntervalFor(request: Pick<StatusSentenceInput, 'state' | 'checkKind'>, opts: { checksAvailable: boolean }): number | null {
  return request.state === 'open' && request.checkKind !== null && opts.checksAvailable ? CHECK_INTERVAL_SECONDS : null;
}
