import type { SetupRequestCheckKind, SetupRequestState, TargetEnvironment } from './kinds.js';

/**
 * D#598 P8b: the words a person reads about a setup request's check. One constant per sentence, filled only from structured fields (the
 * interval, the variable's name, the project's name, the environment, a reason CODE). Nothing here is built from an agent's text, and a
 * check's reason is always one code from {@link CHECK_REASON_CODES}, never free text. The API exposes these strings and the screens render
 * them as plain text (P8c).
 */

/** How often a request with an automatic check is looked at: the cron runs once a minute. The sentence below states this number. */
export const CHECK_INTERVAL_SECONDS = 60;

/** The reasons an env-var check can give for "not yet", in the order a person is most likely to meet them. */
export const CHECK_REASON_CODES = ['env_var_missing', 'env_var_wrong_target', 'check_unavailable', 'token_rejected', 'token_cannot_read'] as const;
/** Reasons that say the check could not read the project at all (so nothing is known about the variable): never a "not yet" about the variable. */
export const UNREADABLE_REASONS: readonly CheckReasonCode[] = ['check_unavailable', 'token_rejected', 'token_cannot_read'];
export type CheckReasonCode = (typeof CHECK_REASON_CODES)[number];
export function isCheckReasonCode(value: unknown): value is CheckReasonCode {
  return typeof value === 'string' && (CHECK_REASON_CODES as readonly string[]).includes(value);
}

/** The provider named in `check_unavailable`. */
export const CHECK_PROVIDER_NAME = 'Vercel';

export const COPY_WAITING_CHECKED = "We check for this every {interval}. The item continues by itself once it's done, or press Mark done.";
export const COPY_WAITING_UNCHECKED = "We can't check this one for you. Press Mark done when it's finished.";
export const COPY_CHECKING_NOW = 'Checking now.';
export const COPY_REPAUSED = "We checked and it isn't done yet: {reason}. The item is paused again.";
export const COPY_REASON: Readonly<Record<CheckReasonCode, string>> = {
  env_var_missing: "{name} isn't set on {project} yet.",
  env_var_wrong_target: '{name} is set on {project}, but not for {environment}.',
  check_unavailable: "We couldn't reach {provider} to check.",
  token_rejected: '{provider} did not accept the connected token, so {project} could not be checked.',
  token_cannot_read: 'The connected {provider} token cannot read {project}.',
};

function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-z0-9]+)\}/g, (whole, key: string) => values[key] ?? whole);
}

const secondsText = (n: number): string => `${n} ${n === 1 ? 'second' : 'seconds'}`;

/** What the check found, as a sentence. `name`, `project` and `environment` are the request's own structured fields (the environment is the one the check used). */
export function checkReasonSentence(code: CheckReasonCode, fields: { name: string; project: string; environment: TargetEnvironment }): string {
  return fill(COPY_REASON[code], { name: fields.name, project: fields.project, environment: fields.environment, provider: CHECK_PROVIDER_NAME });
}

/** Sentence 4: "Mark done" was pressed and the check says it is not done. The reason's own full stop is dropped so the sentence does not end ".." before "The item". */
export function repausedSentence(code: CheckReasonCode, fields: { name: string; project: string; environment: TargetEnvironment }): string {
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
  /** The environment the check used; sentence 4 names it. */
  targetEnvironment?: TargetEnvironment;
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
  if (request.checkKind === null || !opts.checksAvailable || request.checkReason === 'check_unavailable' || request.checkReason === 'token_rejected') return COPY_WAITING_UNCHECKED;
  if ((request.repausedAt ?? null) !== null && isCheckReasonCode(request.checkReason) && request.target !== undefined && request.targetEnvironment !== undefined) {
    return repausedSentence(request.checkReason, { name: request.envName ?? request.target, project: request.target, environment: request.targetEnvironment });
  }
  return fill(COPY_WAITING_CHECKED, { interval: secondsText(opts.intervalSeconds ?? CHECK_INTERVAL_SECONDS) });
}

/** The interval the API states for a request: the constant while it waits on an automatic check that can run, else null. */
export function checkIntervalFor(request: Pick<StatusSentenceInput, 'state' | 'checkKind'>, opts: { checksAvailable: boolean }): number | null {
  return request.state === 'open' && request.checkKind !== null && opts.checksAvailable ? CHECK_INTERVAL_SECONDS : null;
}

/**
 * D#598 P1d-3: the parity request. The target is the public repo's full name; the reason is one of these, filled only from structured fields (full names,
 * a 7-character commit prefix, a count and the sorted paths). A reason is at most 1,000 characters: it lists the first paths that fit, each cut to 120
 * characters, then "and {k} more". It holds paths and never file content.
 */
export const COPY_PARITY_DRIFT =
  'Private main of {private} differs from public main of {public} outside the overlay paths, compared at public commit {sha7}. {n} paths differ: {paths}. Port the change to a public pull request, or undo it on private main.';
export const COPY_PARITY_NO_SHARED_HISTORY =
  'Private main of {private} contains none of the last 30 commits on public main of {public}, so it was compared with public commit {sha7}. {n} paths differ: {paths}. Bring private main up to date with public main.';
export const COPY_PARITY_TOO_LARGE = "We can't check {repo}: GitHub won't list all of its files in one answer. Parity between {private} and {public} isn't being checked.";
export const COPY_PARITY_INVALID_OVERLAY = "The overlay paths of the pairing between {private} and {public} can't be read, so parity isn't being checked. Fix the overlay paths in the pairing settings.";
/** A paired repo whose default branch is not `main`: parity is only checked on main, so the sentence names the repo that has the other branch (the side the check reported) and says why. Filled from full names, as text. */
export const COPY_PARITY_UNSUPPORTED_BRANCH = "{repo} uses a default branch other than main, so parity between {private} and {public} isn't being checked.";

const PARITY_REASON_MAX = 1000;
const PARITY_PATH_MAX = 120;
const PARITY_PATH_CONTROL_RE = /[\u0000-\u001F\u007F]/g;

export interface ParityReasonInput {
  privateRepo: string;
  publicRepo: string;
  /** The repo the result is about: the one GitHub would not list in full (`too_large`), or the one whose default branch is not `main` (`unsupported_branch`). Default: the public repo. */
  limitRepo?: string;
  sha7?: string;
  paths?: readonly string[];
  pathCount?: number;
}

/** The sentence for a drift-like result, or null for a result that raises nothing. `paths` must already be sorted. */
export function parityReason(result: 'drift' | 'no_shared_history' | 'too_large' | 'invalid_overlay' | 'unsupported_branch', f: ParityReasonInput): string {
  const base = { private: f.privateRepo, public: f.publicRepo, repo: f.limitRepo ?? f.publicRepo };
  if (result === 'too_large') return fill(COPY_PARITY_TOO_LARGE, base);
  if (result === 'invalid_overlay') return fill(COPY_PARITY_INVALID_OVERLAY, base);
  if (result === 'unsupported_branch') return fill(COPY_PARITY_UNSUPPORTED_BRANCH, base);
  const template = result === 'drift' ? COPY_PARITY_DRIFT : COPY_PARITY_NO_SHARED_HISTORY;
  const total = f.pathCount ?? f.paths?.length ?? 0;
  const values = { ...base, sha7: (f.sha7 ?? '').slice(0, 7), n: String(total) };
  const room = PARITY_REASON_MAX - fill(template, { ...values, paths: '' }).length;
  // A path is a file name from the public repo and can hold any character; a control character would make the whole reason invalid (and the result unwritable), so it is replaced first.
  const cut = (f.paths ?? []).map((raw) => {
    const p = raw.replace(PARITY_PATH_CONTROL_RE, '\uFFFD');
    return p.length > PARITY_PATH_MAX ? `${p.slice(0, PARITY_PATH_MAX - 1)}…` : p;
  });
  let list = '';
  let shown = 0;
  for (const p of cut) {
    const more = total - shown - 1;
    const next = `${list}${shown === 0 ? '' : ', '}${p}`;
    if ((more > 0 ? `${next}, and ${more} more` : next).length > room) break;
    list = next;
    shown++;
  }
  const rest = total - shown;
  return fill(template, { ...values, paths: shown === 0 ? `${rest} in all` : rest > 0 ? `${list}, and ${rest} more` : list });
}
