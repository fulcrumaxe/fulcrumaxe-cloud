import type { Pool, PoolClient } from 'pg';
import { NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';
import { PROGRESS_EVENT_KINDS, buildFeed } from '../onboarding/previewProgress.js';
import { commandIsClean } from '@fx/runtime/src/toolActivity.js';
import { redactText } from '@fx/runtime/src/redact.js';
import { BACK_TO_DISCUSSION_REF_PREFIX, closeOnGithub, operatorActionsFor, readOperatorFacts, type OperatorAction } from './operatorActions.js';

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

export interface ActivityLine {
  at: string;
  text: string;
}
export interface ActivityRun {
  id: string;
  role: string;
  status: string;
  usd: number | null;
  created_at: string;
  /** The `summary` of the run's AGENT_OUTPUT envelope when it has one (plain text), else null. */
  summary: string | null;
  lines: ActivityLine[];
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
 */
export interface ActivityNotice {
  kind: 'not_feasible' | 'needs_human' | 'check_failed';
  reason: string;
}
export interface WorkItemActivity {
  stage: string;
  /** A customer halted this item and no person has resumed it since (the halt marker, not the stage: a halted item can sit at any stage). */
  halted: boolean;
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
   * What the CALLER may do to this item now, from the one table in operatorActions.ts (the routes ask the same table): Build
   * again, Back to discussion, Treat as a feature, Close. Empty for a member, an external item, a live run or a stage none applies to.
   * The Pipeline app draws a button only for an action listed here.
   */
  actions: OperatorAction[];
  /** True when the caller could close this item but it has an open pull request: the app says to close the pull request on GitHub instead of offering Close. */
  close_on_github: boolean;
}

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** A shell command line as stored: printable, one line, no control characters. */
const COMMAND_RE = /^[^\u0000-\u001f\u007f]{1,200}$/;

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
  }>(
    `SELECT e.run_id, e.seq, e.kind, e.created_at, e.tool, e.path, e.pattern, e.stage, e."to", e.command
       FROM unnest($1::uuid[]) AS r(id)
      CROSS JOIN LATERAL (
        SELECT run_id, seq, kind, created_at,
               left(payload->>'tool', 32) AS tool, left(payload->>'path', 200) AS path, left(payload->>'pattern', 200) AS pattern,
               left(payload->>'stage', 32) AS stage, left(payload->>'to', 32) AS "to", left(payload->>'command', 201) AS command
          FROM run_events WHERE run_id = r.id AND kind = ANY($2::text[])
         ORDER BY seq DESC LIMIT $3::int
      ) e`,
    [runIds, [...PROGRESS_EVENT_KINDS], ACTIVITY_LIMITS.maxEventsPerRun],
  );
  for (const e of ev.rows) {
    const list = eventsByRun.get(e.run_id) ?? [];
    list.push({ seq: Number(e.seq), kind: e.kind, at: e.created_at, fields: { tool: e.tool, path: e.path, pattern: e.pattern, stage: e.stage, to: e.to } });
    eventsByRun.set(e.run_id, list);
    if (e.command !== null && e.kind === 'agent.activity' && COMMAND_RE.test(e.command) && commandIsClean(e.command)) {
      commandBySeq.set(`${e.run_id}:${Number(e.seq)}`, `${e.tool === 'test' ? 'Ran tests' : 'Ran'}: ${e.command}`);
    }
  }
  for (const id of runIds) {
    const evs = eventsByRun.get(id) ?? [];
    if (evs.length >= ACTIVITY_LIMITS.maxEventsPerRun) capped.add(id);
    linesByRun.set(id, buildFeed(evs, null).map((l) => ({ at: l.at, text: commandBySeq.get(`${id}:${l.seq}`) ?? l.text })));
  }
  return { linesByRun, capped };
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
    }>(
      `SELECT w.stage, w.halted_at IS NOT NULL AS halted, w.discussion_id, w.gh_number, r.gh_owner, r.gh_name,
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
      await client.query<{ version: number; body: string }>(
        `SELECT version, left(body, $2::int) AS body FROM spec_versions
          WHERE work_item_id = $1::uuid AND erased_at IS NULL ORDER BY version DESC LIMIT 1`,
        [workItemId, ACTIVITY_LIMITS.maxSpecChars + 1],
      )
    ).rows[0];

    const runRows = (
      await client.query<{ id: string; role: string; status: string; usd: string | null; created_at: Date; summary: string | null; pr_number: string | null }>(
        `SELECT id, role, status, usd, created_at, left(envelope->>'summary', $2::int) AS summary,
                COALESCE(CASE WHEN role <> 'executor' THEN dispatch_pr_number::text END,
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
    const pm = (
      await client.query<{ reason: string | null }>(
        `SELECT left(envelope->>'reason', $2::int) AS reason FROM agent_runs
          WHERE work_item_id = $1::uuid AND role = 'project-manager' AND (envelope->'feasible') = 'false'::jsonb
            AND NOT EXISTS (SELECT 1 FROM spec_versions s WHERE s.work_item_id = $1::uuid AND s.created_at > agent_runs.created_at)
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [workItemId, ACTIVITY_LIMITS.maxNoticeChars],
      )
    ).rows[0];
    if (pm) {
      notice = { kind: 'not_feasible', reason: safeModelText(pm.reason, ACTIVITY_LIMITS.maxNoticeChars) };
    } else if (item.stage === 'needs_human') {
      // Build again was pressed and the driver stopped before starting anything (an open pull request, or GitHub could not be asked):
      // the newest such stop since the item reached Needs a person, by a fixed code.
      const rebuildStop = (
        await client.query<{ code: string | null }>(
          `SELECT e.code FROM work_item_driver_events e
            WHERE e.work_item_id = $1::uuid AND e.kind = 'stopped' AND e.code = ANY($2::text[])
              AND e.created_at > COALESCE((SELECT max(t.created_at) FROM work_item_transitions t WHERE t.work_item_id = $1::uuid AND t.to_stage = 'needs_human'), '-infinity'::timestamptz)
            ORDER BY e.seq DESC LIMIT 1`,
          [workItemId, ['rebuild_pr_open', 'rebuild_check_unavailable']],
        )
      ).rows[0];
      const rebuildSentence = rebuildStop?.code && Object.hasOwn(CHECK_FAILED_SENTENCES, rebuildStop.code) ? CHECK_FAILED_SENTENCES[rebuildStop.code] : undefined;
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
        : {
            kind: 'needs_human',
            reason: summary ?? (ex ? `The executor run ${ex.status.replace(/_/g, ' ')} without a pull request.` : 'The pipeline stopped and needs a person.'),
          };
    } else if (item.stage === 'in_progress') {
      // "Check the build" could not decide: its newest recorded stop names why, by a fixed code.
      const stop = (
        await client.query<{ code: string | null }>(
          // Only a stop recorded after the item's latest move into In progress counts (an old failed check must not show
          // during a later build), and none while any run of the item is live (a build or a review is going on now).
          `SELECT e.code FROM work_item_driver_events e
            WHERE e.work_item_id = $1::uuid AND e.kind = 'stopped'
              AND e.created_at > COALESCE((SELECT max(t.created_at) FROM work_item_transitions t WHERE t.work_item_id = $1::uuid AND t.to_stage = 'in_progress'), '-infinity'::timestamptz)
              AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.work_item_id = $1::uuid AND r.status NOT IN ('succeeded', 'failed', 'timed_out', 'killed_spend', 'refused_spend', 'cancelled'))
            ORDER BY e.seq DESC LIMIT 1`,
          [workItemId],
        )
      ).rows[0];
      const sentence = stop?.code && Object.hasOwn(CHECK_FAILED_SENTENCES, stop.code) ? CHECK_FAILED_SENTENCES[stop.code] : undefined;
      if (sentence) notice = { kind: 'check_failed', reason: sentence };
    }

    // What this caller may do now: the same table the action routes ask. A caller with no role gets none.
    const facts = ctx.principal.role ? await readOperatorFacts(client, workItemId, ctx.principal.role) : null;

    return {
      stage: item.stage,
      halted: item.halted,
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
      actions: facts ? operatorActionsFor(facts) : [],
      close_on_github: facts ? closeOnGithub(facts) : false,
    };
  });
}
