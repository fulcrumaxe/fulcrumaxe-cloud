/**
 * D#2 PREVIEW-LIVE-PROGRESS: what the free preview's progress view is made of, as pure functions.
 *
 * Nothing here reads the database or the clock on its own. The service in preview.ts gathers a run's recorded
 * facts and events (bounded, and only the few fields named in `PROGRESS_EVENT_FIELDS`), and this module turns them into
 *
 *   - activity lines: every line is one of a few FIXED templates with at most one safe value filled in (a relative
 *     path inside the repository, or a short search term with anything secret-looking left out). Model text, file
 *     contents, command output, tokens and URLs have no template and so cannot reach a line, whatever an event says;
 *   - a stage timeline: each stage is marked from evidence the run recorded, never from elapsed time;
 *   - one outcome name per screen the panel can show.
 *
 * New runner events this reads (the runner does not write them yet; until it does the feed and the first stages
 * simply have less to show, and nothing is invented):
 *   - `agent.activity`  payload { tool: 'read'|'list'|'search'|'test'|'command', path?: string, pattern?: string }
 *   - `run.stage`       payload { stage: 'sandbox_ready'|'cloned'|'writing_result' }
 * and, already written today: `run.status_changed` (from/to/failureReason) and `agent.output` (counted only; its text is never read).
 */

export const PROGRESS_LIMITS = {
  /** Newest feed lines returned. */
  maxLines: 30,
  /** Characters in one line, template included. */
  maxLineChars: 100,
  /** Characters in a path or a search term that may be shown. */
  maxPathChars: 90,
  maxTermChars: 40,
  /** Newest recorded events scanned for the feed and the stage marks. */
  maxEventsScanned: 200,
  /** Rows of one run counted for the files-read figure and the stage evidence; the count stops here. */
  maxEventsCounted: 5000,
  /** The progress transaction is cut off after this long. */
  statementTimeoutMs: 3000,
  /** The files-read figure stops here. */
  maxFilesRead: 9999,
} as const;

/** Past this many seconds in queued, starting or running, the panel says so honestly. */
export const SLOW_AFTER_SECONDS = 300;

export const ACTIVITY_KIND = 'agent.activity';
export const STAGE_KIND = 'run.stage';
export const STATUS_KIND = 'run.status_changed';
export const OUTPUT_KIND = 'agent.output';
/** The kinds whose payload is read at all, and the only payload fields that leave the database for them. */
export const PROGRESS_EVENT_KINDS = [ACTIVITY_KIND, STAGE_KIND, STATUS_KIND] as const;
export const PROGRESS_EVENT_FIELDS = ['tool', 'path', 'pattern', 'stage', 'to', 'failureReason'] as const;

/**
 * D#6 C42-3: the runner's own states, read by `readRunLines` for a run on a person's machine. `runner.waiting` is a row of its own; the other
 * three are `runner.event` rows told apart by their payload `type`. Only the fields in `RUNNER_STATE_FIELDS` leave the database for them.
 */
export const RUNNER_WAITING_KIND = 'runner.waiting';
export const RUNNER_EVENT_KIND = 'runner.event';
export const RUNNER_STATE_TYPES = ['run_ended', 'taken_over', 'usage_limit_reached'] as const;
export const RUNNER_STATE_FIELDS = ['type', 'reason', 'detail', 'size_mb', 'reset_at'] as const;

export type EventFields = Partial<Record<(typeof PROGRESS_EVENT_FIELDS)[number] | (typeof RUNNER_STATE_FIELDS)[number], string | null>>;
export interface ProgressEvent {
  seq: number;
  kind: string;
  at: Date;
  fields: EventFields;
}
export interface FeedLine {
  seq: number;
  at: string;
  text: string;
}

const PATH_RE = /^[A-Za-z0-9._@+\-/]+$/;
/** Whole segments that name credentials or git internals: a line naming one is dropped, not softened. */
const SECRET_SEGMENT_RE = /^(\.env.*|\.git|\.netrc|\.npmrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519).*|.*\.(pem|key|p12|pfx|jks|keystore)|credentials.*|.*secrets?.*)$/i;
const LONG_RUN_RE = /[A-Za-z0-9_-]{32,}/;
/** A credential's well-known prefix at the start of a path segment or after punctuation. */
const TOKEN_PREFIX_RE = /(^|[^A-Za-z0-9])(sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[a-z]-|AKIA[0-9A-Z]{8}|eyJ)/;
const TERM_RE = /^[A-Za-z0-9_ .\-/()]+$/;
const TERM_SECRET_RE = /(^|[^A-Za-z])(sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[a-z]-|AKIA|eyJ|Bearer |Basic )|[A-Za-z0-9_-]{20,}/;

/** A path relative to the repository root that is safe to show, or null (absolute, climbing out, odd characters, credential-named, token-like). */
export function safeRepoPath(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.length > PROGRESS_LIMITS.maxPathChars) return null;
  if (!PATH_RE.test(value) || value.startsWith('/') || value.endsWith('/') || value.includes('//') || value.includes('://')) return null;
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return null;
    if (SECRET_SEGMENT_RE.test(segment) || LONG_RUN_RE.test(segment) || TOKEN_PREFIX_RE.test(segment)) return null;
  }
  return value;
}

/** A short search term that is safe to show, or null (empty, too long, odd characters, a URL, or anything that looks like a credential). */
export function safeSearchTerm(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const term = value.trim();
  if (term === '' || term.length > PROGRESS_LIMITS.maxTermChars || !TERM_RE.test(term) || term.includes('://') || TERM_SECRET_RE.test(term)) return null;
  return term;
}

const clip = (text: string): string => (text.length > PROGRESS_LIMITS.maxLineChars ? `${text.slice(0, PROGRESS_LIMITS.maxLineChars - 1)}…` : text);

/**
 * The one line an event becomes, or null when it has none (an unknown kind or tool, or an unsafe value in a slot that
 * must be filled). The only places an event's own text can enter a line are `path` and `pattern`, after the checks above.
 */
export function lineFor(kind: string, f: EventFields): string | null {
  if (kind === ACTIVITY_KIND) {
    switch (f.tool) {
      case 'read': {
        const p = safeRepoPath(f.path);
        return p ? clip(`Reading ${p}`) : null;
      }
      case 'list': {
        if (f.path === undefined || f.path === null || f.path === '') return 'Looking through the repository';
        const p = safeRepoPath(f.path);
        return p ? clip(`Looking through ${p}`) : null;
      }
      case 'search': {
        const t = safeSearchTerm(f.pattern);
        return t ? clip(`Searching for '${t}'`) : 'Searching the code';
      }
      case 'test':
        return 'Running the tests';
      case 'command':
        return 'Running a command';
      default:
        return null;
    }
  }
  if (kind === STAGE_KIND) {
    if (f.stage === 'sandbox_ready') return 'The secure sandbox is ready';
    if (f.stage === 'cloned') return 'Repository cloned';
    if (f.stage === 'writing_result') return 'Writing up the result';
    return null;
  }
  if (kind === STATUS_KIND) return f.to === 'running' ? 'The run started' : null;
  if (kind === RUNNER_WAITING_KIND) return 'Waiting for your runner to come online';
  if (kind === RUNNER_EVENT_KIND) {
    if (f.type === 'taken_over') return 'Taken over on the runner machine';
    if (f.type === 'usage_limit_reached') {
      const at = resetClock(f.reset_at);
      return at ? `Plan usage limit reached; resumes at ${at} UTC` : 'Plan usage limit reached';
    }
    // The words of a run's end come from the runner protocol's COPY (the API route puts them in); this is the plain form for a reason that has none.
    if (f.type === 'run_ended') return f.reason && REASON_RE.test(f.reason) ? `The run ended (${f.reason.replace(/_/g, ' ')})` : 'The run ended';
  }
  return null;
}

/** HH:MM (UTC) of a reset time the runner sent, or null when it is not an ISO time. */
function resetClock(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value)) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(11, 16) : null;
}

/** The newest `maxLines` lines, oldest first. `firstOutput` is the first recorded agent message (counted, never read). */
export function buildFeed(events: readonly ProgressEvent[], firstOutput: { seq: number; at: Date } | null): FeedLine[] {
  const lines: FeedLine[] = [];
  for (const e of events) {
    const text = lineFor(e.kind, e.fields);
    if (text) lines.push({ seq: e.seq, at: e.at.toISOString(), text });
  }
  if (firstOutput) lines.push({ seq: firstOutput.seq, at: firstOutput.at.toISOString(), text: 'The agent sent its first message' });
  lines.sort((a, b) => a.seq - b.seq);
  return lines.slice(-PROGRESS_LIMITS.maxLines);
}

export const STAGE_IDS = ['queued', 'sandbox', 'clone', 'read', 'plan', 'write', 'done'] as const;
export type StageId = (typeof STAGE_IDS)[number];
export type StageStatus = 'done' | 'active' | 'pending' | 'failed';
export interface Stage {
  id: StageId;
  status: StageStatus;
  at: string | null;
}

/** One name per screen the panel can show. */
export const OUTCOMES = ['queued', 'starting', 'running', 'finished', 'failed', 'cancelled', 'sandbox_stopped', 'agent_never_started', 'void'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface ProgressFacts {
  now: Date;
  previewState: 'requested' | 'running' | 'finished' | 'void';
  voidReason: string | null;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  /** The linked run's status, or null before it has a run. */
  runStatus: string | null;
  /** The newest recorded failure reason of the run (from run.status_changed). */
  failureReason: string | null;
  /** When each `run.stage` mark was recorded. */
  marks: Partial<Record<'sandbox_ready' | 'cloned' | 'writing_result', Date>>;
  activityCount: number;
  agentOutputCount: number;
}

export interface Derived {
  outcome: Outcome;
  reason: string | null;
  slow: boolean;
  /** Seconds since the request, to the run's end for a finished one; null when the preview was voided before it had a run. */
  elapsedSeconds: number | null;
  stages: Stage[];
  /** The preview row is void with a freeing reason: the free preview was handed back and can be started again. */
  slotFreed: boolean;
}

const FAILED_STATUSES = new Set(['failed', 'timed_out', 'killed_spend', 'refused_spend']);
const SANDBOX_LOST_REASONS = new Set(['runner_lost', 'sandbox_error', 'sandbox_stopped']);
const REASON_RE = /^[a-z][a-z0-9_]{0,63}$/;
const token = (v: string | null): string | null => (v !== null && REASON_RE.test(v) ? v : null);
const LIVE_RUN_STATUSES = new Set(['pending', 'running', 'paused']);

/**
 * The void reasons that mean "the free preview was handed back" (migration 0705 sets them, within a bound of 3 per
 * GitHub installation and owner per day). Whether a slot was freed is READ from the preview row (void plus one of these),
 * never worked out from the run's failure: a failure of this kind that the trigger could not or would not void
 * (over the bound, a skipped write) leaves the preview used up, and the panel must say so.
 */
export const FREEING_REASONS: ReadonlySet<string> = new Set(['agent_start_timeout', 'clone_failed']);

export function deriveProgress(f: ProgressFacts): Derived {
  const terminalRun = f.endedAt !== null || (f.runStatus !== null && !LIVE_RUN_STATUSES.has(f.runStatus));
  let outcome: Outcome;
  let reason: string | null = null;
  const rank = highestReached(f);
  const slotFreed = f.previewState === 'void' && f.voidReason !== null && FREEING_REASONS.has(f.voidReason);
  if (terminalRun) {
    if (f.runStatus === 'succeeded') outcome = 'finished';
    else if (f.runStatus === 'cancelled') outcome = 'cancelled';
    else {
      reason = token(f.failureReason) ?? (f.runStatus !== null && FAILED_STATUSES.has(f.runStatus) ? f.runStatus : null);
      outcome =
        f.failureReason === 'agent_start_timeout'
          ? 'agent_never_started'
          : f.failureReason !== null && SANDBOX_LOST_REASONS.has(f.failureReason)
            ? 'sandbox_stopped'
            : 'failed';
    }
  } else if (f.previewState === 'void') {
    reason = token(f.voidReason);
    outcome = 'void';
  } else if (f.previewState === 'requested' || f.runStatus === null) {
    outcome = 'queued';
  } else {
    outcome = rank <= 1 ? 'starting' : 'running';
  }

  const live = outcome === 'queued' || outcome === 'starting' || outcome === 'running';
  const elapsedFrom = f.endedAt ?? f.now;
  const elapsedSeconds = outcome === 'void' ? null : Math.max(0, Math.round((elapsedFrom.getTime() - f.createdAt.getTime()) / 1000));
  const slow = live && elapsedSeconds !== null && elapsedSeconds > SLOW_AFTER_SECONDS;

  const failedOutcome = outcome === 'failed' || outcome === 'cancelled' || outcome === 'sandbox_stopped' || outcome === 'agent_never_started' || outcome === 'void';
  const stageRank = outcome === 'finished' ? 6 : failedOutcome ? (f.runStatus === null ? 0 : rank) : rank;
  const at = (i: number): string | null => {
    const d = i === 0 ? f.createdAt : i === 1 ? f.startedAt : i === 2 ? f.marks.sandbox_ready : i === 3 ? f.marks.cloned : i === 5 ? f.marks.writing_result : i === 6 ? f.endedAt : null;
    return d ? d.toISOString() : null;
  };
  const stages: Stage[] = STAGE_IDS.map((id, i) => ({
    id,
    status: i < stageRank ? 'done' : i === stageRank ? (outcome === 'finished' ? 'done' : failedOutcome ? 'failed' : 'active') : 'pending',
    at: i <= stageRank ? at(i) : null,
  }));
  return { outcome, reason, slow, elapsedSeconds, stages, slotFreed };
}

/** Index in STAGE_IDS of the furthest stage the recorded evidence reaches (the one in progress). */
function highestReached(f: ProgressFacts): number {
  let r = 0;
  if (f.runStatus !== null) r = 1;
  if (f.marks.sandbox_ready) r = Math.max(r, 2);
  if (f.marks.cloned || f.activityCount > 0) r = Math.max(r, 3);
  if (f.agentOutputCount > 0) r = Math.max(r, 4);
  if (f.marks.writing_result) r = Math.max(r, 5);
  return r;
}
