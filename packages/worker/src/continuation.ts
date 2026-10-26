import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { PREVIEW_WORKDIR, EXECUTOR_ROLE } from "@fx/runner";
import { assembleSeatPrompt, type ContinueAfterLimitInput } from "@fx/pipeline";
import type { SeatRefusal, SeatRequest, SeatResult } from "./seat.js";

/**
 * D#2 H14c-3-3b-1 (C88 R4) and 3b-3 (C89): the one place a continuation's start input is built. The automatic step (3b-2, 3b-3) and the
 * customer's Continue (3b-4) both call it, so a continued seat is configured the way a check-fix round is: from the seat resolver as it
 * answers NOW (limits, `maxExtensions`, model, role card), never copied from the ended run. The checkpoint's `extensions_used` is never an input (C69 section 5).
 *
 * C89: a continued seat's original task is the start prompt its first run stored (`run.input`), proven unchanged by its stored hash. Nothing is read from
 * GitHub again and no prompt is rebuilt: the text that passed the author check before the first run is the text that runs again.
 */

/** The executor resumes its own session, so it needs no recap: one fixed sentence, never the checkpoint text. */
export const CONTINUE_PROMPT = "Your previous run of this task stopped at a run limit. Continue the same task from where it stopped.";

/** Where a continuation was asked from. The wait site passes one of these fixed words; it never supplies a prompt, a run, or a repository. */
export const CONTINUATION_SITES = ["executor", "classify", "spec", "light_spec", "respec", "reviewer", "panel_workflow", "panel_inprocess"] as const;
export type ContinuationSite = (typeof CONTINUATION_SITES)[number];
const PANEL_SEATS = ["technical-architect", "security-expert", "cost-analyst", "product-owner", "performance-expert", "researcher", "ux-designer"] as const;
/** What a site fixes: the roles of the seats it may continue, whether its start clones the repository, and the stages the item is in while that site's own wait runs. */
export const SITE_RULES: Readonly<Record<ContinuationSite, { roles: readonly string[]; clone: boolean; stages: readonly string[] }>> = Object.freeze({
  executor: { roles: [EXECUTOR_ROLE], clone: false, stages: ["in_progress", "pr_opened", "changes_requested", "review_passed"] },
  classify: { roles: ["project-manager"], clone: false, stages: ["triaged"] },
  spec: { roles: ["project-manager"], clone: true, stages: ["discussing"] },
  light_spec: { roles: ["project-manager"], clone: true, stages: ["triaged"] },
  respec: { roles: ["project-manager"], clone: true, stages: ["spec_ready", "needs_human"] },
  reviewer: { roles: ["code-reviewer", "acceptance-tester", "security-reviewer", "debater"], clone: true, stages: ["pr_opened", "changes_requested", "review_passed"] },
  panel_workflow: { roles: PANEL_SEATS, clone: true, stages: ["discussing"] },
  panel_inprocess: { roles: PANEL_SEATS, clone: false, stages: ["triaged", "discussing"] },
});

export type ContinuationStartInput = ContinueAfterLimitInput["resumeInput"];
/** `prompt_not_retained`: no intact stored prompt to run again. `spec_changed`: the Spec moved on since the run began. Both are refusals that take today's path. */
export type ContinuationRefusal = SeatRefusal | "run_not_found" | "no_repo" | "prompt_not_retained" | "spec_changed";

export interface ContinuationDeps {
  /** The runner login's pool. */
  pool: Pool;
  resolveRunSeat: (request: SeatRequest) => Promise<SeatResult>;
}

interface EndedRow {
  role: string; work_item_id: string | null; repo_id: string | null; gh_number: string | null; spec_version_id: string | null; run_mode: string | null;
  dispatch_repo_id: string | null; dispatch_pr_number: string | null; head_sha: string | null; gh_owner: string | null; gh_name: string | null;
}
interface StoredInput { prompt?: unknown; prompt_sha256?: unknown; meta?: { continuation_base_run_id?: unknown } | null }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFUSE = <R extends ContinuationRefusal>(refused: R): { refused: R } => ({ refused });

/** The stored start prompt, only when it is a string whose hash equals the stored hash. A hash-only row, a missing one and an edited one are all undefined. */
const intactPrompt = (p: StoredInput | undefined): string | undefined =>
  p && typeof p.prompt === "string" && typeof p.prompt_sha256 === "string" && createHash("sha256").update(p.prompt).digest("hex") === p.prompt_sha256 ? p.prompt : undefined;

const storedInput = async (client: PoolClient, accountId: string, runId: string): Promise<StoredInput | undefined> =>
  (await client.query<{ payload: StoredInput }>(`SELECT payload FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = 'run.input' ORDER BY seq LIMIT 1`, [accountId, runId])).rows[0]?.payload;

/**
 * The prompt this run starts again from, with the run it came from. Executor: the nearest run on its own parent chain (at most 32 parents) that stored a start prompt.
 * Any other seat: the chain's first run, named by the ended run's own `continuation_base_run_id` (or the ended run itself), which must be the same item and the same role.
 */
async function basePrompt(client: PoolClient, accountId: string, ended: { id: string; workItemId: string; role: string }): Promise<{ id: string; prompt: string } | undefined> {
  if (ended.role === EXECUTOR_ROLE) {
    const { rows } = await client.query<{ id: string; payload: StoredInput }>(
      `WITH RECURSIVE chain AS (
         SELECT id, parent_run_id, 0 AS depth FROM agent_runs WHERE account_id = $1 AND id = $2 AND work_item_id = $3 AND role = $4
         UNION ALL
         SELECT a.id, a.parent_run_id, c.depth + 1 FROM agent_runs a JOIN chain c ON a.id = c.parent_run_id
          WHERE a.account_id = $1 AND a.work_item_id = $3 AND a.role = $4 AND c.depth < 32)
       SELECT c.id, e.payload FROM chain c JOIN run_events e ON e.account_id = $1 AND e.run_id = c.id AND e.kind = 'run.input' ORDER BY c.depth LIMIT 1`,
      [accountId, ended.id, ended.workItemId, ended.role],
    );
    const prompt = intactPrompt(rows[0]?.payload);
    return rows[0] && prompt !== undefined ? { id: rows[0].id, prompt } : undefined;
  }
  const pointer = (await storedInput(client, accountId, ended.id))?.meta?.continuation_base_run_id;
  const baseId = pointer === undefined ? ended.id : typeof pointer === "string" && UUID_RE.test(pointer) ? pointer : undefined;
  if (baseId === undefined) return undefined;
  const base = (await client.query(`SELECT 1 FROM agent_runs WHERE account_id = $1 AND id = $2 AND work_item_id = $3 AND role = $4`, [accountId, baseId, ended.workItemId, ended.role])).rows[0];
  const prompt = base ? intactPrompt(await storedInput(client, accountId, baseId)) : undefined;
  return prompt === undefined ? undefined : { id: baseId, prompt };
}

/**
 * `resumeInput` for `continueAfterLimit` and `continueWorkItem`, or `{ refused }` with nothing started (a seat refusal keeps its own word).
 * `site` is the fixed word of the wait that asked (the executor by default). The executor resumes its own session and also carries a fresh-session fallback prompt;
 * every other seat starts a new run from its base run's stored prompt plus the checkpoint note, with the run facts taken from the ended run's row.
 */
export async function continuationStartInput(deps: ContinuationDeps, accountId: string, endedRunId: string, site: ContinuationSite = "executor"): Promise<ContinuationStartInput | { refused: ContinuationRefusal }> {
  const rule = SITE_RULES[site];
  if (!rule) return REFUSE("run_not_found");
  const ended = await withTenant(deps.pool, accountId, async (client) => {
    const run = await client.query<EndedRow>(
      `SELECT ar.role, ar.work_item_id, w.repo_id, w.gh_number, ar.spec_version_id, ar.execution_mode AS run_mode,
              ar.dispatch_repo_id, ar.dispatch_pr_number, ar.head_sha, rp.gh_owner, rp.gh_name
         FROM agent_runs ar JOIN work_items w ON w.account_id = ar.account_id AND w.id = ar.work_item_id
         LEFT JOIN repos rp ON rp.account_id = ar.account_id AND rp.id = ar.dispatch_repo_id
        WHERE ar.account_id = $1 AND ar.id = $2`,
      [accountId, endedRunId],
    );
    const row = run.rows[0];
    if (!row?.work_item_id) return undefined;
    const workItemId = row.work_item_id;
    const note = await client.query<{ summary: string | null }>(
      `SELECT payload->>'summary' AS summary FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = 'checkpoint' ORDER BY seq LIMIT 1`,
      [accountId, endedRunId],
    );
    const base = await basePrompt(client, accountId, { id: endedRunId, workItemId, role: row.role });
    // A seat's Spec pin must still be the newest version (the executor's pin is kept as it was, and the library refuses a missing one).
    const newest = row.role === EXECUTOR_ROLE || row.spec_version_id === null ? null
      : (await client.query<{ id: string }>(`SELECT id FROM spec_versions WHERE account_id = $1 AND work_item_id = $2 ORDER BY version DESC LIMIT 1`, [accountId, workItemId])).rows[0]?.id ?? null;
    return { ...row, workItemId, summary: note.rows[0]?.summary ?? undefined, base, specMoved: row.role !== EXECUTOR_ROLE && row.spec_version_id !== null && newest !== row.spec_version_id };
  });
  if (!ended) return REFUSE("run_not_found");
  const isExecutor = ended.role === EXECUTOR_ROLE;
  // The site fixes which seats may be continued from it: a run whose role is not in the site's list is not continued from there.
  if (!rule.roles.includes(ended.role)) return REFUSE("run_not_found");
  if (ended.base === undefined) return REFUSE("prompt_not_retained");
  if (ended.specMoved) return REFUSE("spec_changed");
  const pr = isExecutor ? Number(ended.gh_number) : ended.dispatch_pr_number === null ? undefined : /^[1-9][0-9]*$/.test(ended.dispatch_pr_number) ? Number(ended.dispatch_pr_number) : Number.NaN;
  const repoId = isExecutor ? ended.repo_id : ended.dispatch_repo_id;
  if (repoId === null || (pr !== undefined && !Number.isSafeInteger(pr)) || (isExecutor && (pr as number) < 1)) return REFUSE("no_repo");
  if (rule.clone && (ended.gh_owner === null || ended.gh_name === null)) return REFUSE("no_repo");
  const seat = await deps.resolveRunSeat({ accountId, role: ended.role, workItemId: ended.workItemId, ...(ended.run_mode === null ? {} : { expectedExecutionMode: ended.run_mode }) });
  if (!seat.ok) return REFUSE(seat.reason);
  // The note is the agent's own text: it goes through the one assembler (capped, fenced as data, before the output block). The stored bytes go in unchanged.
  const assembled = assembleSeatPrompt(ended.base.prompt, ended.summary).prompt;
  return {
    ...seat.seat,
    repoId,
    product: "team",
    ...(pr === undefined ? {} : { pr }),
    // The executor resumes its own session and never sees the note; a fresh session (its sandbox is gone) is told the build task with the note.
    prompt: isExecutor ? CONTINUE_PROMPT : assembled,
    ...(isExecutor ? { fallbackPrompt: assembled } : { startMeta: { continuation_base_run_id: ended.base.id, model: seat.seat.model } }),
    ...(!isExecutor && ended.head_sha !== null ? { headSha: ended.head_sha } : {}),
    ...(ended.spec_version_id === null ? {} : { specVersionId: ended.spec_version_id }),
    ...(ended.run_mode === null ? {} : { expectedExecutionMode: ended.run_mode }),
    ...(isExecutor ? { workdir: PREVIEW_WORKDIR } : rule.clone ? { workdir: PREVIEW_WORKDIR, cloneRepo: { owner: ended.gh_owner!, name: ended.gh_name! } } : {}),
  };
}
