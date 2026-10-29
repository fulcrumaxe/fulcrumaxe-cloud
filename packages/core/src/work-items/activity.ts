import type { Pool, PoolClient } from 'pg';
import { isItemWaitingOnAnswer } from '@fx/db/src/decisionAsks.js';
import { NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';
import { HANDOFF_KIND, PROGRESS_EVENT_KINDS, RUNNER_EVENT_KIND, RUNNER_STATE_TYPES, RUNNER_WAITING_KIND, buildFeed } from '../onboarding/previewProgress.js';
import { RUNNER_USAGE_COLUMN, runnerUsageStateOf, toRunnerUsage, type RunnerUsage, type RunnerUsageState } from '../runs/runnerUsage.js';
import { commandIsClean } from '@fx/runtime/src/toolActivity.js';
import { redactText } from '@fx/runtime/src/redact.js';
import { setupPauseFor, type SetupHold, type SetupRequest } from '../setup-requests/store.js';
import { parseAcceptanceScope } from '../specs/acceptanceScope.js';
import { readPublicChange, type PublicChange } from '../repos/publicChange.js';
import { readStartDecision, type StartDecision } from './startDecision.js';
import { MONTHLY_BUDGET_PARKED_STOP, RUN_LIMIT_PARKED_STOP, continuationStopSentence } from './continuationStops.js';
import { BASE_SYNC_CONFLICT, BASE_SYNC_UNAVAILABLE, BASE_SYNC_UNAVAILABLE_SENTENCE, FIX_ROUND_STOP_SENTENCE, REPUBLISH_BASE_MISSING, REPUBLISH_BRANCH_MOVED, REPUBLISH_FAILED, REPUBLISH_NO_CHANGE, REPUBLISH_STACKED_UNSUPPORTED } from './baseSync.js';
import { PUBLIC_BRANCH_MOVED, PUBLIC_BRANCH_MOVED_SENTENCE, PUBLIC_HEAD_UNAVAILABLE, PUBLIC_HEAD_UNAVAILABLE_SENTENCE } from '../repos/planePushRecord.js';
import { CHECK_FAILED_OUTSIDE_CHANGE, CHECK_FAILED_OUTSIDE_CHANGE_SENTENCE } from './checkFailure.js';
import { UNVERIFIABLE_ESCALATION_CODE } from './reviewHold.js';
import { readUnverifiable } from './unverifiable.js';
import { BACK_TO_DISCUSSION_REF_PREFIX, REQUEST_CHANGES_NOTE_MAX, REQUEST_CHANGES_REF_PREFIX, closeOnGithub, operatorActionsFor, operatorVerdict, readOperatorFacts, type OperatorAction } from './operatorActions.js';

/**
 * What the pipeline is doing for one work item, read for the Pipeline app's detail panel. Read only: every value here
 * was recorded by something else (the panel's signed comments, the newest Spec, the item's agent runs and the events
 * those runs recorded, the run-action requests aimed at the item). Nothing is derived from the clock, and a step that
 * left no record has no row (the app says nothing about it rather than inventing it).
 *
 * Bounded everywhere: the newest `MAX_RUNS` runs, `MAX_COMMENTS` comments, `MAX_STEPS` run-action rows, at most
 * `MAX_EVENTS_PER_RUN` recorded events per run, and every text is cut to its cap. Model text (comments, Spec, run
 * summaries) is returned as plain text for the caller to show as text only.
 *
 * Activity lines come from the preview's fixed templates (`buildFeed`): a path or search term that passes its checks,
 * never model text, file contents, command output, tokens or URLs. The one addition is a shell command's first line,
 * which the runner stores only when redaction would not change it (`safeCommandLine` in @fx/runner); it is checked
 * again here against the line's shape, so an odd stored value cannot widen what is shown.
 */
export const ACTIVITY_LIMITS = {
  maxRuns: 20,
  maxComments: 50,
  maxSteps: 20,
  maxEventsPerRun: 200,
  maxCommentChars: 4000,
  maxSpecChars: 20000,
  maxSummaryChars: 4000,
  maxNoticeChars: 1200,
  maxCommandChars: 200,
  maxReasons: 10,
} as const;

/** What a `run_ended` line says about why, as the runner sent it (closed codes only). The API route replaces `text` with the runner protocol's sentence and drops this. */
export interface RunEndedWhy {
  reason: string;
  detail: string | null;
  size_mb: number | null;
}
export interface ActivityLine {
  at: string;
  text: string;
  /** Present only on a `run_ended` line of a runner run; never leaves the API. */
  ended?: RunEndedWhy;
}

/**
 * D#6 C42-3: how long a runner's lease lasts, in seconds. This is `RUNNER_LEASE_SECONDS` of the runner protocol, which @fx/core does not depend
 * on; a test in @fx/api pins the two equal. A live runner run's lease is renewed by every request the runner makes, so `lease_expires_at` minus
 * this is when the runner last checked in.
 */
export const RUNNER_LEASE_SECONDS_READ = 90;
export interface ActivityRun {
  id: string;
  role: string;
  status: string;
  usd: number | null;
  created_at: string;
  /** The `summary` of the run's AGENT_OUTPUT envelope when it has one (plain text), else null. */
  summary: string | null;
  lines: ActivityLine[];
  /** D#6 C42-3: where the run ran (`runner` for a run on a person's machine). */
  runtime: string;
  /** A runner run only: what it would have cost at API prices (information, never spend), or null when it reported none. Absent for any other run. */
  runner_usage?: RunnerUsage | null;
  /** A runner run only: `recorded`, `not_priced` or `not_recorded` once it has ended (never a silent 0), null while it is still going. */
  runner_usage_state?: RunnerUsageState | null;
  /** A runner run only: the sentence that explains `not_priced` or `not_recorded`, else null. */
  runner_usage_note?: string | null;
  /** A runner run only: when the runner last checked in while the run is live (its lease expiry less the lease length), else null. */
  runner_checked_in_at?: string | null;
}
export interface ActivityComment {
  role: string | null;
  body: string;
  created_at: string;
}
export interface ActivityStep {
  /** The run-action request's kind, e.g. `continue_work_item`. */
  kind: string;
  /** accepted, claimed, done, refused or failed. */
  state: string;
  /** The request's recorded error code (a fixed code), or null. */
  code: string | null;
  /** A fixed result code the performer recorded in the outcome (`outcome` or `advance`), or null. */
  result: string | null;
  /** Fixed reason codes the performer recorded in the outcome, at most `maxReasons`. */
  reasons: string[];
  at: string;
  finished_at: string | null;
}
/**
 * Why the pipeline stopped and wants a person: `not_feasible` (the project manager's own reason, from the stored envelope
 * of its newest short-Spec run that judged the request not buildable, when no Spec was published after it) or
 * `needs_human` (at Needs human, the newest executor run's summary, or a fixed sentence when it left none). The reason is
 * model text: credential shapes are redacted, and it is plain text for the caller to show as text only. `check_failed` is
 * neither: at In progress, the newest recorded stop of "Check the build" says the check could not decide (GitHub could not be
 * read, or more than one pull request matched), and `reason` is a fixed sentence.
 *
 * D#6 R4d-5b (C34 section 2): `no_file_list` and `respec_failed` are about a newest Spec with no readable file list, at Spec ready or Needs a person.
 * `no_file_list`: a build was refused for it, or the newest executor run ended `scope_unknown` with that detail. `respec_failed`: the newest Re-spec's
 * project-manager list could not be read, so nothing was changed. Their `reason` is the KEY of the sentence in the runner protocol's `COPY`
 * (`specHasNoFileList`, `respecListUnreadable`), not the sentence: @fx/core has no dependency on that package, so the API route puts the words in.
 */
export interface ActivityNotice {
  kind: 'not_feasible' | 'needs_human' | 'check_failed' | 'no_file_list' | 'respec_failed' | 'build_slot_wait' | 'resume_refused' | 'spec_refused';
  reason: string;
  /**
   * `build_slot_wait` only (D#483): `reason` is the fixed wait code (`one_build_per_repo_until_d598`, `waiting_for_build_slot_repo` or `waiting_for_build_slot_account`;
   * the API route puts the sentence in) and `holder` is the item that holds the repository's slot, when the wait is for the repository's slot: its issue number
   * (null when it has none) and its stage. Null when no such item is found, and always null for the account wait.
   */
  holder?: { issue_number: number | null; stage: string } | null;
}

/**
 * D#483: the codes of a wait for a build slot, and how long a waiting fact counts as current. These repeat packages/pipeline buildSlots.ts
 * (BUILD_WAIT_REASONS, BUILD_SLOT_STAGES, WAITER_WINDOW_SECONDS); @fx/core cannot import that package, and a test there holds the copies equal.
 */
export const BUILD_WAIT_NOTICE_CODES: readonly string[] = Object.freeze(['one_build_per_repo_until_d598', 'waiting_for_build_slot_repo', 'waiting_for_build_slot_account']);
export const BUILD_SLOT_HOLDING_STAGES: readonly string[] = Object.freeze(['in_progress', 'pr_opened', 'changes_requested', 'review_passed']);
export const BUILD_WAIT_FRESH_SECONDS = 180;

/** The `COPY` key each Re-spec notice carries as its `reason` until the API route replaces it with the sentence. */
export const FILE_LIST_NOTICE_COPY_KEY = Object.freeze({ no_file_list: 'specHasNoFileList', respec_failed: 'respecListUnreadable' } as const);
/**
 * D#7 DP11c: a `resume_refused` notice is an answered question whose resume did not happen (the answer was saved, the item sat where the question left it). `reason`
 * is the FIXED CODE the resume recorded (`prompt_not_retained`, `principal_not_authorised`, `work_item_not_resumable`, `ask_no_run`, `fix_round_context_missing`,
 * `spec_unavailable`, `execution_mode_changed`, `resume_pause_expired`, `resume_failed`, or the start's own closed code), never a sentence: the words are the owner's
 * to approve (D#7 C22 A6 assigns the per-code sentences to DP8-f1), and the code is all this read carries until they are. Shown only while the item sits at the stage
 * the question parked it at, nothing of it is running, and no executor run is newer than the refusal.
 */
/**
 * The fixed codes the short-Spec step (packages/pipeline/src/advance/lightSpec.ts) refuses with; the worker records one as a `stopped` driver event. A
 * `spec_refused` notice carries the code (never a sentence) and the Pipeline app owns the words; a test fails when lightSpec.ts can refuse with a code missing here,
 * from the app's sentences or from the telemetry allowlist.
 */
export const LIGHT_SPEC_REFUSAL_CODES: readonly string[] = Object.freeze([
  'invalid_spec_output',
  'invalid_file_scope',
  'invalid_planned_prs',
  'planned_prs_too_large',
  'planned_split_missing',
  'planned_split_unflagged',
  'spec_too_large',
  'item_halted',
  'publish_failed',
]);
export const RESUME_REFUSAL_STAGES: readonly string[] = Object.freeze(['in_progress', 'changes_requested']);

export interface WorkItemActivity {
  stage: string;
  /** A customer halted this item and no person has resumed it since (the halt marker, not the stage: a halted item can sit at any stage). */
  halted: boolean;
  /** The item is parked on a question an agent asked (D#7 DP4b-2): an open or overdue ask on its newest executor run. Derived from that ask, never a stamp. */
  waiting_on_answer: boolean;
  repo: { owner: string; name: string } | null;
  issue_number: number | null;
  /**
   * The real pull request number, or null. Read from the newest run that names one: a reviewer's dispatch target, or the
   * `pr_number` a run's envelope reports. An EXECUTOR run's dispatch target is never read: the driver starts the build and
   * its fix rounds with the ISSUE number there (the sandbox is keyed on it), so it names the issue, not the pull request.
   */
  pr_number: number | null;
  /** Whether the merge gate would auto-merge this item: the same rule it applies (the JSON boolean `true`, and for external work the external guard switched off), not a guess from the stage. */
  auto_merge: boolean;
  comments: ActivityComment[];
  comments_truncated: boolean;
  spec: { version: number; body: string } | null;
  /** The item's newest runs, oldest first. */
  runs: ActivityRun[];
  runs_truncated: boolean;
  steps: ActivityStep[];
  /** Why the pipeline stopped and needs a person, or null. */
  notice: ActivityNotice | null;
  /**
   * D#598 P7c: set when the newest review round of the item was a delta re-check (the head is only a merge of the base branch; no reviewer ran for it).
   * The API route puts the approved sentence in; there is never a second full review row for such a head.
   */
  review_recheck: { kind: 'merge_only' } | null;
  /** D#598 P1f-6a: the item's change to its paired public repository, or null for an item with none. */
  public_change: PublicChange | null;
  /** D#7 start gate (c): how the item's start was decided (asked, started by a person or by the dial, held, withdrawn), in fixed sentences. Null for an item that never went through the gate. */
  start_decision: StartDecision | null;
  /** D#598 P8c-3: the setup request the item is paused on, read in this same call (no extra request). Null when no request holds it; the API words it. */
  setup_pause: { hold: SetupHold; request: SetupRequest | null } | null;
  /**
   * What the CALLER may do to this item now, from the one table in operatorActions.ts (the routes ask the same table): Build
   * again, Re-spec, Back to discussion, Treat as a feature, Close. Empty for a member, an external item, a live run or a stage none applies to.
   * The Pipeline app draws a button only for an action listed here.
   */
  actions: OperatorAction[];
  /** True when the caller could close this item but it has an open pull request: the app says to close the pull request on GitHub instead of offering Close. */
  close_on_github: boolean;
  /**
   * Why Request changes is not offered on an open pull request the caller could otherwise ask about: `live` (agents are working on it now) or `rounds` (its fix
   * rounds are used up). Null when it is offered, or when it does not apply at all (no open pull request, a member, an external item).
   */
  request_changes_blocked: 'live' | 'rounds' | null;
  /** The item's Request changes notes, newest last: who asked (`mine` when it was the caller), the note as written, and whether its fix round has taken it. */
  change_requests: ActivityChangeRequest[];
}

/** One Request changes press. `state`: `waiting` (no fix run has taken the note yet), `sent` (the fix run `run_id` carried it), `dropped` (it was withdrawn). */
export interface ActivityChangeRequest {
  mine: boolean;
  /** The asker's name, or null when it is the caller (`mine`) or the member left. */
  name: string | null;
  note: string;
  at: string;
  state: 'waiting' | 'sent' | 'dropped';
  run_id: string | null;
}

/** At most this many Request changes notes are listed (the newest). */
export const MAX_CHANGE_REQUESTS = 10;

export interface ActivityCtx {
  pool: Pool;
  /** `role` is the caller's role; without it no action is offered. */
  principal: { accountId: string; userId: string; role?: string };
}

/** The fixed codes the stage driver records when "Check the build" could not decide, and the sentence the card shows for each. */
const CHECK_FAILED_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  check_build_unavailable: "Couldn't check the build right now. Try again in a moment.",
  check_build_ambiguous: 'More than one open pull request matches this issue\'s branch, so the build could not be checked. Close the extra one and try again.',
  // Build again, at Needs a person: the same sentence family, shown on that stage instead (see below).
  rebuild_pr_open: 'A pull request is still open for this issue\'s branch, so the build was not started again. Close that pull request on GitHub, then press Build again.',
  rebuild_check_unavailable: 'Couldn\'t check for an open pull request just now, so the build was not started again. Try again in a moment.',
});

/**
 * D#6 FU-CHECK-CROSS-SIDE-BRANCH: the driver stops (kind `stopped`) a check fix round could not start because the branch to continue is unknown, and the sentence the
 * card shows at Needs a person. Fixed text: the stop carries a code, never a branch name or an error.
 */
export const CHECK_FIX_BRANCH_STOP_CODE = 'build_check_fix_branch_unknown';
export const CHECK_FIX_BRANCH_SENTENCE =
  "The build's check failed, and its fix round could not start because the cloud could not confirm which branch to continue. Nothing was changed. Close or fix the pull request on GitHub, then press Build again.";

/**
 * The review stops of a cloud-verified pull request (D#6 R5b-2a, R5b-2b-i), shown while the item sits at a pull-request stage. Each carries the KEY of
 * its sentence out of @fx/core (as the file-list notices do); the words are written once, in the runner protocol's copy, and the api route fills them in.
 */
export const REVIEW_STOP_COPY_KEY = Object.freeze({
  review_key_missing: 'reviewKeyMissing',
  review_quiet_period_unsettled: 'reviewQuietUnsettled',
  review_round_cap: 'reviewRoundCap',
  review_compute_cap: 'reviewComputeCap',
} as const);

/** The reviewers by the code a driver event carries for them, as the sentence names them. */
const REVIEWER_NAMES: Readonly<Record<string, string>> = Object.freeze({ code_reviewer: 'code reviewer', acceptance_tester: 'acceptance tester', security_reviewer: 'security reviewer', debater: 'debater' });
/** How a reviewer's last run ended, by its fixed code, as the sentence says it. A code not listed reads as the last entry's words. */
const NO_VERDICT_ENDS: Readonly<Record<string, string>> = Object.freeze({
  resource_limit: 'it was stopped at its memory limit',
  wait_timeout: 'it ran out of time',
  timed_out: 'it ran out of time',
  wall_clock_limit: 'it ran out of time',
  cancelled: 'its run was cancelled',
  runner_lost: 'the runner lost contact with it',
  agent_failed: 'its agent stopped before it finished',
});

/**
 * The notice for an item a reviewer could not finish (`escalated` with code `reviewer_no_verdict`; reasons: role, end, per reviewer). It never says changes were
 * requested: none were. Null when the reasons name no reviewer this sentence knows.
 */
export function reviewerNoVerdictSentence(reasons: readonly string[]): string | null {
  const key = reasons[0] ?? '';
  const name = Object.hasOwn(REVIEWER_NAMES, key) ? REVIEWER_NAMES[key] : undefined;
  if (name === undefined) return null;
  const end = reasons[1] !== undefined && Object.hasOwn(NO_VERDICT_ENDS, reasons[1]) ? NO_VERDICT_ENDS[reasons[1]] : 'its run ended without a verdict';
  return `The ${name} could not finish reviewing this pull request: ${end}, every time it was tried. No verdict was recorded and no changes were requested. Press Approve to have the reviewers look at the pull request again, or review it yourself and merge or close it on GitHub.`;
}

/**
 * The notice for an item a reviewer could not verify here (`escalated` with code `reviewer_unverifiable`; reasons: the roles). It lists each criterion the reviewer
 * could not check and why, from the reviewer's own stored envelope (model text: redacted, bounded, shown as text only), and says no changes were requested.
 * Null when the reasons name no reviewer this sentence knows, or the run holds no usable list.
 */
export function reviewerUnverifiableSentence(reasons: readonly string[], stored: unknown): string | null {
  const key = reasons[0] ?? '';
  const name = Object.hasOwn(REVIEWER_NAMES, key) ? REVIEWER_NAMES[key] : undefined;
  const items = readUnverifiable(stored);
  if (name === undefined || items.length === 0) return null;
  const lines = items.map((item, i) => {
    const criterion = safeModelText(item.criterion, 300);
    const reason = safeModelText(item.reason, 300);
    return `${i + 1}. ${criterion}${reason === '' ? '' : ` (could not verify because: ${reason})`}`;
  });
  return capText([
    `The ${name} could not verify ${items.length === 1 ? 'this criterion' : 'these criteria'} where it ran, so no changes were requested and nothing was sent back to the builder. A person needs to verify ${items.length === 1 ? 'it' : 'them'}, then merge or close the pull request on GitHub:`,
    ...lines,
  ].join('\n'), 3500);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** A shell command line as stored: printable, one line, no control characters. */
const COMMAND_RE = /^[^\u0000-\u001f\u007f]{1,200}$/;

/**
 * D#6 C42-3 (gap G9): the pull request number the cloud's `done` recorded for a runner executor run, on the `run.status_changed` event the verdict move
 * writes (`viaRunnerDone`, `prNumber`). The cloud opened that pull request itself, so it outranks the agent's own envelope. Only a runner run has one;
 * for any other run this is NULL and the old rule stands. A SELECT-list item for a query over `agent_runs` (unaliased).
 */
export const RUNNER_VERDICT_PR_SQL = `(SELECT CASE WHEN e.payload->>'prNumber' ~ '^[0-9]{1,9}$' THEN e.payload->>'prNumber' END
    FROM run_events e WHERE agent_runs.runtime = 'runner' AND agent_runs.role = 'executor' AND e.run_id = agent_runs.id
     AND e.kind = 'run.status_changed' AND e.payload->>'viaRunnerDone' = 'true' AND e.payload ? 'prNumber'
    ORDER BY e.seq DESC LIMIT 1)`;

/** The fields a runner run adds to its row (none for any other run, so a sandbox run reads exactly as before). */
export function runnerFields(r: { runtime: string; status: string; lease_expires_at: Date | null; runner_usage_json: unknown }): Pick<ActivityRun, 'runner_usage' | 'runner_usage_state' | 'runner_usage_note' | 'runner_checked_in_at'> {
  const usage = toRunnerUsage(r.runtime, r.runner_usage_json);
  const state = runnerUsageStateOf(r.runtime, r.status, usage);
  if (usage === undefined || state === null) return {};
  return { runner_usage: usage, runner_usage_state: state.state, runner_usage_note: state.note, runner_checked_in_at: runnerCheckedInAt(r.status, r.lease_expires_at) };
}

/** When the runner last checked in, for a live runner run: its lease expiry less the lease length. Null once the run has ended (or before a runner holds it). */
export function runnerCheckedInAt(status: string, leaseExpiresAt: Date | null): string | null {
  return status === 'running' && leaseExpiresAt !== null ? new Date(leaseExpiresAt.getTime() - RUNNER_LEASE_SECONDS_READ * 1000).toISOString() : null;
}

/** `text` cut to `max` characters, ending in an ellipsis when it was cut. */
/**
 * Model text leaving the API: credential shapes are redacted (CWE-532/200: a run's summary or a PM's reason can quote a
 * token it saw), then the text is cut. Redacting first means a cut can never leave half of a token behind.
 */
export function safeModelText(text: string | null | undefined, max: number): string {
  return capText(redactText(typeof text === 'string' ? text : '', []), max);
}

export function capText(text: string | null | undefined, max: number): string {
  const t = typeof text === 'string' ? text : '';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function codeOrNull(value: unknown): string | null {
  return typeof value === 'string' && CODE_RE.test(value) ? value : null;
}

/** The fixed codes a performer recorded in a run-action outcome. Anything that is not a plain code is dropped. */
export function readOutcomeCodes(outcome: unknown): { result: string | null; reasons: string[] } {
  if (outcome === null || typeof outcome !== 'object' || Array.isArray(outcome)) return { result: null, reasons: [] };
  const o = outcome as Record<string, unknown>;
  const reasons = Array.isArray(o.reasons)
    ? o.reasons.map(codeOrNull).filter((c): c is string => c !== null).slice(0, ACTIVITY_LIMITS.maxReasons)
    : [];
  return { result: codeOrNull(o.outcome) ?? codeOrNull(o.advance), reasons };
}

/**
 * The activity lines of the given runs (at most `maxEventsPerRun` newest recorded events each, oldest first in each
 * list), read in one bounded query. This is the ONE place a stored command line is checked and turned into
 * "Ran: ..." / "Ran tests: ...": the Pipeline detail and the Runs detail both read their lines through here, so what
 * is shown cannot differ between them. `capped` holds the runs that had more events than were read. Must run inside
 * a `withTenant` transaction.
 */
export async function readRunLines(
  client: PoolClient,
  runIds: string[],
): Promise<{ linesByRun: Map<string, ActivityLine[]>; capped: Set<string> }> {
  const linesByRun = new Map<string, ActivityLine[]>();
  const capped = new Set<string>();
  if (runIds.length === 0) return { linesByRun, capped };
  // One bounded query for every run's recorded events (newest per run), only the fields the feed reads.
  const eventsByRun = new Map<string, Array<{ seq: number; kind: string; at: Date; fields: Record<string, string | null> }>>();
  const commandBySeq = new Map<string, string>();
  const endedBySeq = new Map<string, RunEndedWhy>();
  const ev = await client.query<{
    run_id: string;
    seq: string;
    kind: string;
    created_at: Date;
    tool: string | null;
    path: string | null;
    pattern: string | null;
    stage: string | null;
    to: string | null;
    command: string | null;
    type: string | null;
    reason: string | null;
    detail: string | null;
    size_mb: string | null;
    reset_at: string | null;
    handoff_state: string | null;
    handoff_branch: string | null;
  }>(
    // D#6 C42-3: besides the progress kinds, a runner run's own states: the `runner.waiting` notice and the three `runner.event` types that say
    // where the run stands. A `runner.event` of any other type (a tool use can be 2,000 per run) is not selected, so it cannot crowd the newest rows out.
    `SELECT e.run_id, e.seq, e.kind, e.created_at, e.tool, e.path, e.pattern, e.stage, e."to", e.command, e.type, e.reason, e.detail, e.size_mb, e.reset_at, e.handoff_state, e.handoff_branch
       FROM unnest($1::uuid[]) AS r(id)
      CROSS JOIN LATERAL (
        SELECT run_id, seq, kind, created_at,
               left(payload->>'tool', 32) AS tool, left(payload->>'path', 200) AS path, left(payload->>'pattern', 200) AS pattern,
               left(payload->>'stage', 32) AS stage, left(payload->>'to', 32) AS "to", left(payload->>'command', 201) AS command,
               CASE WHEN kind = $5::text THEN left(payload->>'type', 32) END AS type, CASE WHEN kind = $5::text THEN left(payload->>'reason', 64) END AS reason,
               CASE WHEN kind = $5::text THEN left(payload->>'detail', 64) END AS detail, CASE WHEN kind = $5::text THEN left(payload->>'size_mb', 6) END AS size_mb,
               CASE WHEN kind = $5::text THEN left(payload->>'reset_at', 40) END AS reset_at,
               CASE WHEN kind = $7::text THEN left(payload->>'state', 32) END AS handoff_state, CASE WHEN kind = $7::text THEN left(payload->>'branch', 80) END AS handoff_branch
          FROM run_events
         WHERE run_id = r.id
           AND (kind = ANY($2::text[]) OR kind = $4::text OR kind = $7::text OR (kind = $5::text AND payload->>'type' = ANY($6::text[])))
         ORDER BY seq DESC LIMIT $3::int
      ) e`,
    [runIds, [...PROGRESS_EVENT_KINDS], ACTIVITY_LIMITS.maxEventsPerRun, RUNNER_WAITING_KIND, RUNNER_EVENT_KIND, [...RUNNER_STATE_TYPES], HANDOFF_KIND],
  );
  for (const e of ev.rows) {
    const list = eventsByRun.get(e.run_id) ?? [];
    list.push({ seq: Number(e.seq), kind: e.kind, at: e.created_at, fields: { tool: e.tool, path: e.path, pattern: e.pattern, stage: e.stage, to: e.to, type: e.type, reason: e.reason, detail: e.detail, size_mb: e.size_mb, reset_at: e.reset_at, handoff_state: e.handoff_state, handoff_branch: e.handoff_branch } });
    if (e.kind === RUNNER_EVENT_KIND && e.type === 'run_ended' && e.reason !== null && CODE_RE.test(e.reason)) {
      const size = e.size_mb !== null && /^[0-9]{1,6}$/.test(e.size_mb) ? Number(e.size_mb) : null;
      endedBySeq.set(`${e.run_id}:${Number(e.seq)}`, { reason: e.reason, detail: e.detail !== null && CODE_RE.test(e.detail) ? e.detail : null, size_mb: size });
    }
    eventsByRun.set(e.run_id, list);
    if (e.command !== null && e.kind === 'agent.activity' && COMMAND_RE.test(e.command) && commandIsClean(e.command)) {
      commandBySeq.set(`${e.run_id}:${Number(e.seq)}`, `${e.tool === 'test' ? 'Ran tests' : 'Ran'}: ${e.command}`);
    }
  }
  for (const id of runIds) {
    const evs = eventsByRun.get(id) ?? [];
    if (evs.length >= ACTIVITY_LIMITS.maxEventsPerRun) capped.add(id);
    linesByRun.set(
      id,
      buildFeed(evs, null).map((l) => {
        const ended = endedBySeq.get(`${id}:${l.seq}`);
        return { at: l.at, text: commandBySeq.get(`${id}:${l.seq}`) ?? l.text, ...(ended ? { ended } : {}) };
      }),
    );
  }
  return { linesByRun, capped };
}

/**
 * D#7 DP11c: the newest fixed code a refused or failed resume left on the item, while it still counts: no run of the item is live, and no executor run was made
 * after the refusal (a person's Approve or Build again, or a resume that went through, ends it). Null when there is none.
 */
async function readResumeRefusal(client: PoolClient, workItemId: string): Promise<string | null> {
  const row = (
    await client.query<{ code: string | null }>(
      `SELECT e.code FROM work_item_driver_events e
        WHERE e.work_item_id = $1::uuid AND e.kind = 'resume_refused'
          AND e.created_at > COALESCE((SELECT max(r.created_at) FROM agent_runs r WHERE r.work_item_id = $1::uuid AND r.role = 'executor'), '-infinity'::timestamptz)
          AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.work_item_id = $1::uuid AND r.status NOT IN ('succeeded', 'failed', 'timed_out', 'killed_spend', 'refused_spend', 'cancelled'))
        ORDER BY e.seq DESC LIMIT 1`,
      [workItemId],
    )
  ).rows[0];
  return row?.code != null && CODE_RE.test(row.code) ? row.code : null;
}

/**
 * The newest short-Spec refusal code of an item still at Triaged: a `stopped` event recorded after its latest move into Triaged, with no run live. A code outside
 * LIGHT_SPEC_REFUSAL_CODES reads as `refused` (the app then shows its generic sentence). Null when there is none.
 */
async function readSpecRefusal(client: PoolClient, workItemId: string): Promise<string | null> {
  const row = (
    await client.query<{ code: string | null }>(
      `SELECT e.code FROM work_item_driver_events e
        WHERE e.work_item_id = $1::uuid AND e.kind = 'stopped' AND e.code IS NOT NULL AND e.code <> 'not_feasible' AND e.dedupe_key LIKE 'light:%'
          AND e.created_at > COALESCE((SELECT max(t.created_at) FROM work_item_transitions t WHERE t.work_item_id = $1::uuid AND t.to_stage = 'triaged'), '-infinity'::timestamptz)
          AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.work_item_id = $1::uuid AND r.status NOT IN ('succeeded', 'failed', 'timed_out', 'killed_spend', 'refused_spend', 'cancelled'))
        ORDER BY e.seq DESC LIMIT 1`,
      [workItemId],
    )
  ).rows[0];
  if (row?.code == null) return null;
  return LIGHT_SPEC_REFUSAL_CODES.includes(row.code) ? row.code : 'refused';
}

/**
 * D#483: an item at Spec ready or Needs a person whose build is waiting for a slot. The worker leaves one waiting fact (`stage_waiting`, stage `build`; `build_waiting`
 * before D#483 S5-k1b) on every ask of the wait, so the item is waiting while its LATEST such fact names a slot reason and is younger than three polls. A halted item
 * is not waiting. For a repository wait the holder is the oldest other item that holds a slot on the repository. Fixed codes and numbers only.
 */
async function readBuildWaitNotice(client: PoolClient, workItemId: string, stage: string, halted: boolean, repoId: string | null): Promise<ActivityNotice | null> {
  if ((stage !== 'spec_ready' && stage !== 'needs_human') || halted) return null;
  const fact = (
    await client.query<{ code: string | null; fresh: boolean }>(
      `SELECT e.code, (e.created_at > now() - make_interval(secs => $2::int)) AS fresh FROM work_item_driver_events e
        WHERE e.work_item_id = $1::uuid AND e.kind IN ('build_waiting', 'stage_waiting') AND COALESCE(e.stage, 'build') = 'build'
        ORDER BY e.seq DESC LIMIT 1`,
      [workItemId, BUILD_WAIT_FRESH_SECONDS],
    )
  ).rows[0];
  if (!fact || !fact.fresh || fact.code === null || !BUILD_WAIT_NOTICE_CODES.includes(fact.code)) return null;
  if (fact.code === 'waiting_for_build_slot_account' || repoId === null) return { kind: 'build_slot_wait', reason: fact.code, holder: null };
  const holder = (
    await client.query<{ gh_number: string | null; stage: string }>(
      `SELECT h.gh_number, h.stage FROM work_items h
        WHERE h.repo_id = $2::uuid AND h.id <> $1::uuid AND h.stage = ANY($3::text[])
          AND h.account_id = (SELECT account_id FROM work_items WHERE id = $1::uuid)
        ORDER BY h.created_at ASC, h.id ASC LIMIT 1`,
      [workItemId, repoId, [...BUILD_SLOT_HOLDING_STAGES]],
    )
  ).rows[0];
  return { kind: 'build_slot_wait', reason: fact.code, holder: holder ? { issue_number: holder.gh_number === null ? null : Number(holder.gh_number), stage: holder.stage } : null };
}

/**
 * D#6 R4d-5b (C34 section 2): why an item at Spec ready or Needs a person cannot be built (or Re-spec'd) for want of a file list. Only while the newest unerased
 * Spec has no readable list (a Re-spec that succeeds publishes a version that has one, and the notice goes). The newest of two recorded facts since that Spec was
 * written wins: a Re-spec whose list could not be read (`respec_failed`), and a build refused for the missing list (`no_file_list`). A run that ended
 * `scope_unknown` with the detail `no_file_list` counts as the second one. Fixed codes only; nothing here is model text.
 */
async function readFileListNotice(
  client: PoolClient,
  workItemId: string,
  stage: string,
  spec: { created_at: Date; acceptance_files: unknown } | undefined,
): Promise<ActivityNotice | null> {
  if ((stage !== 'spec_ready' && stage !== 'needs_human') || !spec || parseAcceptanceScope(spec.acceptance_files).kind === 'known') return null;
  const ev = (
    await client.query<{ code: string | null }>(
      `SELECT e.code FROM work_item_driver_events e
        WHERE e.work_item_id = $1::uuid AND e.created_at > $2::timestamptz
          AND ((e.kind = 'stopped' AND e.code = 'respec_list_unreadable') OR (e.kind = 'build_refused' AND e.code = 'spec_has_no_file_list'))
        ORDER BY e.seq DESC LIMIT 1`,
      [workItemId, spec.created_at],
    )
  ).rows[0];
  if (ev?.code === 'respec_list_unreadable') return { kind: 'respec_failed', reason: FILE_LIST_NOTICE_COPY_KEY.respec_failed };
  if (ev?.code === 'spec_has_no_file_list') return { kind: 'no_file_list', reason: FILE_LIST_NOTICE_COPY_KEY.no_file_list };
  const run = await client.query(
    `SELECT 1 FROM run_events e
      WHERE e.run_id = (SELECT r.id FROM agent_runs r WHERE r.work_item_id = $1::uuid AND r.role = 'executor' ORDER BY r.created_at DESC, r.id DESC LIMIT 1)
        AND e.kind = 'run.status_changed' AND e.payload->>'to' = 'failed' AND e.payload->>'failureReason' = 'scope_unknown' AND e.payload->>'detail' = 'no_file_list'
      LIMIT 1`,
    [workItemId],
  );
  return run.rowCount === 1 ? { kind: 'no_file_list', reason: FILE_LIST_NOTICE_COPY_KEY.no_file_list } : null;
}

export async function getWorkItemActivity(ctx: ActivityCtx, workItemId: string): Promise<WorkItemActivity> {
  if (!UUID_RE.test(workItemId)) throw new NotFoundError(`work item ${workItemId} not found`);
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    const w = await client.query<{
      stage: string;
      discussion_id: string | null;
      gh_number: string | null;
      gh_owner: string | null;
      gh_name: string | null;
      auto_merge: boolean | null;
      halted: boolean;
      repo_id: string | null;
    }>(
      `SELECT w.stage, w.halted_at IS NOT NULL AS halted, w.repo_id, w.discussion_id, w.gh_number, r.gh_owner, r.gh_name,
              -- The merge gate's own rule (@fx/trust autoMergeAllowed): the JSON boolean true, and for external work also
              -- the JSON boolean false on blockExternalAutoMerge. A string "true" is not true.
              ((r.settings->'autoMerge') = 'true'::jsonb
                AND (w.provenance = 'internal' OR (r.settings->'blockExternalAutoMerge') = 'false'::jsonb)) AS auto_merge
         FROM work_items w
         LEFT JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id
        WHERE w.id = $1::uuid`,
      [workItemId],
    );
    const item = w.rows[0];
    if (!item) throw new NotFoundError(`work item ${workItemId} not found`);

    // The newest comments, then put back in time order.
    const commentRows = item.discussion_id
      ? (
          await client.query<{ role: string | null; body: string; created_at: Date }>(
            `SELECT role, left(body, $2::int) AS body, created_at
               FROM discussion_comments
              WHERE discussion_id = $1::uuid AND system_signed = true AND deleted_at IS NULL AND erased_at IS NULL
                -- The CURRENT panel: after "Back to discussion" a new panel is asked, and the earlier one's comments (which stay in the
                -- record) would otherwise be read as its challenge round.
                AND created_at >= COALESCE((SELECT max(t.created_at) FROM work_item_transitions t WHERE t.work_item_id = $4::uuid AND t.to_stage = 'discussing' AND starts_with(t.source_ref, $5::text)), '-infinity'::timestamptz)
              ORDER BY created_at DESC, id DESC LIMIT $3::int`,
            [item.discussion_id, ACTIVITY_LIMITS.maxCommentChars + 1, ACTIVITY_LIMITS.maxComments + 1, workItemId, BACK_TO_DISCUSSION_REF_PREFIX],
          )
        ).rows
      : [];
    const commentsTruncated = commentRows.length > ACTIVITY_LIMITS.maxComments;
    const comments = commentRows.slice(0, ACTIVITY_LIMITS.maxComments).reverse();

    const specRow = (
      await client.query<{ version: number; body: string; created_at: Date; acceptance_files: unknown }>(
        `SELECT version, left(body, $2::int) AS body, created_at, frontmatter -> 'acceptance_files' AS acceptance_files FROM spec_versions
          WHERE work_item_id = $1::uuid AND erased_at IS NULL ORDER BY version DESC LIMIT 1`,
        [workItemId, ACTIVITY_LIMITS.maxSpecChars + 1],
      )
    ).rows[0];

    const runRows = (
      await client.query<{
        id: string;
        role: string;
        status: string;
        usd: string | null;
        created_at: Date;
        summary: string | null;
        pr_number: string | null;
        runtime: string;
        lease_expires_at: Date | null;
        runner_usage_json: unknown;
      }>(
        `SELECT id, role, status, usd, created_at, left(envelope->>'summary', $2::int) AS summary, runtime, lease_expires_at, ${RUNNER_USAGE_COLUMN},
                COALESCE(CASE WHEN role <> 'executor' THEN dispatch_pr_number::text END,
                         ${RUNNER_VERDICT_PR_SQL},
                         CASE WHEN envelope->>'pr_number' ~ '^[0-9]{1,9}$' THEN envelope->>'pr_number' END) AS pr_number
           FROM agent_runs WHERE work_item_id = $1::uuid ORDER BY created_at DESC, id DESC LIMIT $3::int`,
        [workItemId, ACTIVITY_LIMITS.maxSummaryChars + 1, ACTIVITY_LIMITS.maxRuns + 1],
      )
    ).rows;
    const runsTruncated = runRows.length > ACTIVITY_LIMITS.maxRuns;
    const shown = runRows.slice(0, ACTIVITY_LIMITS.maxRuns);

    const { linesByRun } = await readRunLines(client, shown.map((r) => r.id));

    // Run actions aimed at the item or at one of its runs.
    const stepRows = (
      await client.query<{ kind: string; state: string; error_code: string | null; outcome: unknown; created_at: Date; finished_at: Date | null }>(
        `SELECT kind, state, error_code, outcome, created_at, finished_at
           FROM run_action_requests
          WHERE target_id = $1::uuid OR target_id = ANY($2::uuid[])
          ORDER BY created_at DESC, id DESC LIMIT $3::int`,
        [workItemId, runRows.map((r) => r.id), ACTIVITY_LIMITS.maxSteps],
      )
    ).rows;

    const withPr = runRows.find((r) => r.pr_number !== null && Number(r.pr_number) > 0);
    const prNumber = withPr ? Number(withPr.pr_number) : null;

    // Why the pipeline stopped, read from what the runs stored. The newest short-Spec run that judged the request not
    // buildable counts only while no Spec was published after it (an edited issue approved again supersedes it).
    let notice: ActivityNotice | null = null;
    let resumeCode: string | null = null;
    let refusalCode: string | null = null;
    const pm = (
      await client.query<{ reason: string | null }>(
        `SELECT left(envelope->>'reason', $2::int) AS reason FROM agent_runs
          WHERE work_item_id = $1::uuid AND role = 'project-manager' AND (envelope->'feasible') = 'false'::jsonb
            AND NOT EXISTS (SELECT 1 FROM spec_versions s WHERE s.work_item_id = $1::uuid AND s.created_at > agent_runs.created_at)
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [workItemId, ACTIVITY_LIMITS.maxNoticeChars],
      )
    ).rows[0];
    const fileListNotice = await readFileListNotice(client, workItemId, item.stage, specRow);
    const waitNotice = pm || fileListNotice ? null : await readBuildWaitNotice(client, workItemId, item.stage, item.halted, item.repo_id);
    if (pm) {
      notice = { kind: 'not_feasible', reason: safeModelText(pm.reason, ACTIVITY_LIMITS.maxNoticeChars) };
    } else if (fileListNotice) {
      notice = fileListNotice;
    } else if (waitNotice) {
      notice = waitNotice;
    } else if (RESUME_REFUSAL_STAGES.includes(item.stage) && (resumeCode = await readResumeRefusal(client, workItemId)) !== null) {
      notice = { kind: 'resume_refused', reason: resumeCode };
    } else if (item.stage === 'triaged' && (refusalCode = await readSpecRefusal(client, workItemId)) !== null) {
      notice = { kind: 'spec_refused', reason: refusalCode };
    } else if (item.stage === 'needs_human') {
      // Build again was pressed and the driver stopped before starting anything (an open pull request, or GitHub could not be asked):
      // the newest such stop since the item reached Needs a person, by a fixed code.
      const rebuildStop = (
        await client.query<{ code: string | null; reasons: string[] | null }>(
          `SELECT e.code, e.reasons FROM work_item_driver_events e
            WHERE e.work_item_id = $1::uuid AND e.kind IN ('stopped', 'escalated') AND e.code = ANY($2::text[])
              -- An escalation is written in the same transaction as the move to Needs a person, so its stamp equals the move's: it counts with >=, as the reviewer_no_verdict lookup below does. A stop is written after the move.
              AND CASE WHEN e.kind = 'escalated' THEN e.created_at >= COALESCE((SELECT max(t.created_at) FROM work_item_transitions t WHERE t.work_item_id = $1::uuid AND t.to_stage = 'needs_human'), '-infinity'::timestamptz)
                       ELSE e.created_at > COALESCE((SELECT max(t.created_at) FROM work_item_transitions t WHERE t.work_item_id = $1::uuid AND t.to_stage = 'needs_human'), '-infinity'::timestamptz) END
            ORDER BY e.seq DESC LIMIT 1`,
          [workItemId, ['rebuild_pr_open', 'rebuild_check_unavailable', CHECK_FIX_BRANCH_STOP_CODE, PUBLIC_BRANCH_MOVED, PUBLIC_HEAD_UNAVAILABLE, BASE_SYNC_CONFLICT, BASE_SYNC_UNAVAILABLE, REPUBLISH_BASE_MISSING, REPUBLISH_STACKED_UNSUPPORTED, REPUBLISH_BRANCH_MOVED, REPUBLISH_FAILED, REPUBLISH_NO_CHANGE, CHECK_FAILED_OUTSIDE_CHANGE, RUN_LIMIT_PARKED_STOP, MONTHLY_BUDGET_PARKED_STOP]],
        )
      ).rows[0];
      // C88 section 3: a build parked at a run limit shows the fixed sentence of its refused_by (or "Needs your attention" for one this code does not know).
      const contStopSentence = continuationStopSentence(rebuildStop?.code, rebuildStop?.reasons);
      const rebuildSentence = rebuildStop?.code && Object.hasOwn(CHECK_FAILED_SENTENCES, rebuildStop.code) ? CHECK_FAILED_SENTENCES[rebuildStop.code] : undefined;
      const branchStop = rebuildStop?.code === CHECK_FIX_BRANCH_STOP_CODE || rebuildStop?.code === PUBLIC_BRANCH_MOVED || rebuildStop?.code === PUBLIC_HEAD_UNAVAILABLE || rebuildStop?.code === BASE_SYNC_CONFLICT || rebuildStop?.code === BASE_SYNC_UNAVAILABLE || rebuildStop?.code === REPUBLISH_BASE_MISSING || rebuildStop?.code === REPUBLISH_STACKED_UNSUPPORTED || rebuildStop?.code === REPUBLISH_BRANCH_MOVED || rebuildStop?.code === REPUBLISH_FAILED || rebuildStop?.code === REPUBLISH_NO_CHANGE || rebuildStop?.code === CHECK_FAILED_OUTSIDE_CHANGE || contStopSentence !== null;
      // A reviewer that kept ending without a verdict handed the item over: the notice names it and how it ended, never the executor's summary.
      const noVerdict = rebuildSentence || branchStop
        ? undefined
        : (
            await client.query<{ reasons: string[] }>(
              `SELECT e.reasons FROM work_item_driver_events e
                WHERE e.work_item_id = $1::uuid AND e.kind = 'escalated' AND e.code = 'reviewer_no_verdict'
                  AND e.created_at >= COALESCE((SELECT max(t.created_at) FROM work_item_transitions t WHERE t.work_item_id = $1::uuid AND t.to_stage = 'needs_human'), '-infinity'::timestamptz)
                ORDER BY e.seq DESC LIMIT 1`,
              [workItemId],
            )
          ).rows[0];
      const noVerdictSentence = noVerdict ? reviewerNoVerdictSentence(noVerdict.reasons) : null;
      // A reviewer that could not verify some criteria where it ran handed the item over: the NEWEST escalation since it reached Needs a person decides, and the
      // notice lists the criteria and why from that reviewer's own stored run, never the executor's summary.
      const newestEscalation = rebuildSentence || branchStop
        ? undefined
        : (
            await client.query<{ code: string | null; reasons: string[]; stored: unknown }>(
              `SELECT e.code, e.reasons, r.envelope->'unverifiable' AS stored
                 FROM work_item_driver_events e
                 LEFT JOIN agent_runs r ON r.id = e.run_id AND r.work_item_id = e.work_item_id
                WHERE e.work_item_id = $1::uuid AND e.kind = 'escalated'
                  AND e.created_at >= COALESCE((SELECT max(t.created_at) FROM work_item_transitions t WHERE t.work_item_id = $1::uuid AND t.to_stage = 'needs_human'), '-infinity'::timestamptz)
                ORDER BY e.seq DESC LIMIT 1`,
              [workItemId],
            )
          ).rows[0];
      const unverifiableSentence = newestEscalation?.code === UNVERIFIABLE_ESCALATION_CODE ? reviewerUnverifiableSentence(newestEscalation.reasons, newestEscalation.stored) : null;
      // The newest executor run's own summary says why the build ended without a pull request.
      const ex = (
        await client.query<{ summary: string | null; status: string }>(
          `SELECT left(envelope->>'summary', $2::int) AS summary, status FROM agent_runs
            WHERE work_item_id = $1::uuid AND role = 'executor' ORDER BY created_at DESC, id DESC LIMIT 1`,
          [workItemId, ACTIVITY_LIMITS.maxNoticeChars],
        )
      ).rows[0];
      const summary = ex?.summary?.trim() ? safeModelText(ex.summary, ACTIVITY_LIMITS.maxNoticeChars) : null;
      notice = rebuildSentence
        ? { kind: 'check_failed', reason: rebuildSentence }
        : contStopSentence !== null
          ? { kind: 'needs_human', reason: contStopSentence }
          : branchStop
          ? { kind: 'needs_human', reason: rebuildStop?.code && Object.hasOwn(FIX_ROUND_STOP_SENTENCE, rebuildStop.code) ? FIX_ROUND_STOP_SENTENCE[rebuildStop.code]! : rebuildStop?.code === CHECK_FAILED_OUTSIDE_CHANGE ? CHECK_FAILED_OUTSIDE_CHANGE_SENTENCE : rebuildStop?.code === PUBLIC_BRANCH_MOVED ? PUBLIC_BRANCH_MOVED_SENTENCE : rebuildStop?.code === PUBLIC_HEAD_UNAVAILABLE ? PUBLIC_HEAD_UNAVAILABLE_SENTENCE : CHECK_FIX_BRANCH_SENTENCE }
          : unverifiableSentence
          ? { kind: 'needs_human', reason: unverifiableSentence }
          : noVerdictSentence
          ? { kind: 'needs_human', reason: noVerdictSentence }
          : {
            kind: 'needs_human',
            reason: summary ?? (ex ? `The executor run ${ex.status.replace(/_/g, ' ')} without a pull request.` : 'The pipeline stopped and needs a person.'),
          };
    } else if (item.stage === 'in_progress' || item.stage === 'pr_opened' || item.stage === 'changes_requested' || item.stage === 'review_passed') {
      // "Check the build" could not decide: its newest recorded stop names why, by a fixed code.
      const stop = (
        await client.query<{ code: string | null }>(
          // Only a stop recorded after the item's latest move into this stage (In progress, PR opened or Changes requested) counts (an old failed check must not show
          // during a later build), and none while any run of the item is live (a build or a review is going on now).
          `SELECT e.code FROM work_item_driver_events e
            WHERE e.work_item_id = $1::uuid AND e.kind = 'stopped'
              AND e.created_at > COALESCE((SELECT max(t.created_at) FROM work_item_transitions t WHERE t.work_item_id = $1::uuid AND t.to_stage = $2::text), '-infinity'::timestamptz)
              AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.work_item_id = $1::uuid AND r.status NOT IN ('succeeded', 'failed', 'timed_out', 'killed_spend', 'refused_spend', 'cancelled'))
            ORDER BY e.seq DESC LIMIT 1`,
          [workItemId, item.stage],
        )
      ).rows[0];
      // At a pull-request stage only the review stops speak: a stale "Check the build" stop must not show there.
      const isReviewStop = stop?.code != null && Object.hasOwn(REVIEW_STOP_COPY_KEY, stop.code) && item.stage !== 'review_passed';
      // FIXROUND-REFRESH-HEAD: a fix round refused because the paired public branch was changed outside the cloud says so at any pull-request stage.
      const publicMoved = stop?.code === PUBLIC_BRANCH_MOVED && item.stage !== 'in_progress';
      // The same at any pull-request stage when the branch could not be read on GitHub at all: the round was not started either.
      const publicUnreadable = stop?.code === PUBLIC_HEAD_UNAVAILABLE && item.stage !== 'in_progress';
      // FIXROUND-BASE-SYNC: the same when the branch could not be brought up to date with its base (a conflict moves the item to Needs a person instead).
      const baseUnavailable = stop?.code === BASE_SYNC_UNAVAILABLE && item.stage !== 'in_progress';
      const sentence = baseUnavailable
        ? BASE_SYNC_UNAVAILABLE_SENTENCE
        : publicMoved
        ? PUBLIC_BRANCH_MOVED_SENTENCE
        : publicUnreadable
          ? PUBLIC_HEAD_UNAVAILABLE_SENTENCE
          : isReviewStop
          ? REVIEW_STOP_COPY_KEY[stop!.code as keyof typeof REVIEW_STOP_COPY_KEY]
          : stop?.code && item.stage === 'in_progress' && Object.hasOwn(CHECK_FAILED_SENTENCES, stop.code) ? CHECK_FAILED_SENTENCES[stop.code] : undefined;
      if (sentence) notice = { kind: 'check_failed', reason: sentence };
    }

    // D#598 P7c: the newest review round's record says whether it was a merge-only re-check (the code is written by the platform alone).
    const lastRound = (
      await client.query<{ code: string | null }>(
        `SELECT e.code FROM work_item_driver_events e WHERE e.work_item_id = $1::uuid AND e.kind = 'review_verdicts' ORDER BY e.seq DESC LIMIT 1`,
        [workItemId],
      )
    ).rows[0];
    const reviewRecheck = lastRound?.code === 'merge_only_recheck' ? ({ kind: 'merge_only' } as const) : null;

    // What this caller may do now: the same table the action routes ask. A caller with no role gets none.
    const facts = ctx.principal.role ? await readOperatorFacts(client, workItemId, ctx.principal.role) : null;
    const changeVerdict = facts ? operatorVerdict('request_changes', facts) : null;
    const requestChangesBlocked = facts?.pr_open === true && changeVerdict !== null && !changeVerdict.ok && (changeVerdict.reason === 'live' || changeVerdict.reason === 'rounds') ? changeVerdict.reason : null;
    // The notes a person sent with Request changes: the transitions it recorded name them. The text is the person's own, shown as plain text.
    const changeRows = (
      await client.query<{ body: string; status: string; decided_by: string | null; name: string | null; created_at: Date; applied_run_id: string | null }>(
        `SELECT left(c.body, $3::int) AS body, c.status, c.decided_by, COALESCE(NULLIF(u.name, ''), NULLIF(u.github_login, '')) AS name, c.created_at, c.applied_run_id
           FROM work_item_transitions t
           JOIN work_item_corrections c ON c.work_item_id = t.work_item_id AND t.source_ref = $2::text || c.id::text AND c.kind = 'run_note'
           LEFT JOIN users u ON u.id = c.decided_by
          WHERE t.work_item_id = $1::uuid AND t.to_stage = 'changes_requested'
          ORDER BY c.created_at DESC, c.id DESC LIMIT $4::int`,
        [workItemId, REQUEST_CHANGES_REF_PREFIX, REQUEST_CHANGES_NOTE_MAX, MAX_CHANGE_REQUESTS],
      )
    ).rows;

    return {
      stage: item.stage,
      halted: item.halted,
      waiting_on_answer: await isItemWaitingOnAnswer(client, workItemId),
      repo: item.gh_owner && item.gh_name ? { owner: item.gh_owner, name: item.gh_name } : null,
      issue_number: item.gh_number === null ? null : Number(item.gh_number),
      pr_number: prNumber,
      auto_merge: item.auto_merge === true,
      comments: comments.map((c) => ({ role: c.role, body: capText(c.body, ACTIVITY_LIMITS.maxCommentChars), created_at: c.created_at.toISOString() })),
      comments_truncated: commentsTruncated,
      spec: specRow ? { version: Number(specRow.version), body: capText(specRow.body, ACTIVITY_LIMITS.maxSpecChars) } : null,
      runs: shown
        .slice()
        .reverse()
        .map((r) => ({
          id: r.id,
          role: r.role,
          status: r.status,
          usd: r.usd === null ? null : Number(r.usd),
          created_at: r.created_at.toISOString(),
          summary: r.summary ? safeModelText(r.summary, ACTIVITY_LIMITS.maxSummaryChars) : null,
          lines: linesByRun.get(r.id) ?? [],
          runtime: r.runtime,
          ...runnerFields(r),
        })),
      runs_truncated: runsTruncated,
      steps: stepRows
        .map((s) => ({
          kind: s.kind,
          state: s.state,
          code: codeOrNull(s.error_code),
          ...readOutcomeCodes(s.outcome),
          at: s.created_at.toISOString(),
          finished_at: s.finished_at ? s.finished_at.toISOString() : null,
        }))
        .reverse(),
      notice,
      review_recheck: reviewRecheck,
      public_change: await readPublicChange(client, accountId, workItemId, facts),
      start_decision: await readStartDecision(client, workItemId),
      setup_pause: await setupPauseFor(client, workItemId),
      actions: facts ? operatorActionsFor(facts) : [],
      close_on_github: facts ? closeOnGithub(facts) : false,
      request_changes_blocked: requestChangesBlocked,
      change_requests: changeRows.reverse().map((c) => ({
        mine: c.decided_by === userId,
        name: c.decided_by === userId ? null : c.name,
        note: safeModelText(c.body, REQUEST_CHANGES_NOTE_MAX),
        at: c.created_at.toISOString(),
        state: c.status === 'applied' ? ('sent' as const) : c.status === 'accepted' ? ('waiting' as const) : ('dropped' as const),
        run_id: c.applied_run_id,
      })),
    };
  });
}
