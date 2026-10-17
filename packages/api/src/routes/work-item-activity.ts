import { z } from "zod";
import { COPY } from "@fulcrumaxe/runner-protocol";
import { FILE_LIST_NOTICE_COPY_KEY, REVIEW_STOP_COPY_KEY, getWorkItemActivity } from "@fx/core/src/work-items/activity.js";
import { OPERATOR_ACTIONS } from "@fx/core/src/work-items/operatorActions.js";
import type { RouteEntry } from "../registry.js";
import { runnerUsageSchema } from "./runs.js";
import { withRunnerWords } from "./runnerLineWords.js";
import { readRunWait, runWaitSchema } from "./runnerWait.js";

/**
 * D#483 P4: `GET /api/v1/work-items/{id}/activity`, what the pipeline is doing for one work item. Read only, session
 * only (the Pipeline app's detail panel), member. Every list is bounded and every text is capped by the reader in
 * @fx/core; model text (comments, the Spec, run summaries) is plain text for the caller to show as text only.
 */
export const activityResponseSchema = z.object({
  stage: z.string(),
  halted: z.boolean(),
  waiting_on_answer: z.boolean(),
  repo: z.object({ owner: z.string(), name: z.string() }).nullable(),
  issue_number: z.number().int().nullable(),
  pr_number: z.number().int().nullable(),
  auto_merge: z.boolean(),
  comments: z.array(z.object({ role: z.string().nullable(), body: z.string(), created_at: z.string() })),
  comments_truncated: z.boolean(),
  spec: z.object({ version: z.number().int(), body: z.string() }).nullable(),
  runs: z.array(
    z.object({
      id: z.string().uuid(),
      role: z.string(),
      status: z.string(),
      usd: z.number().nullable(),
      created_at: z.string(),
      summary: z.string().nullable(),
      lines: z.array(z.object({ at: z.string(), text: z.string() })),
      // D#6 C42-3: where the run ran, and for a run on the person's machine its cost as a state (never a silent 0), a sentence for the states with no figure, and when the runner last checked in.
      runtime: z.string().optional(),
      runner_usage: runnerUsageSchema.nullable().optional(),
      runner_usage_state: z.enum(["recorded", "not_priced", "not_recorded"]).nullable().optional(),
      runner_usage_note: z.string().nullable().optional(),
      runner_checked_in_at: z.string().nullable().optional(),
      // D#6 C42-3b: a runner run only: why it is not running yet (present only while it is pending), with the sentence to show.
      wait: runWaitSchema.nullable().optional(),
    }),
  ),
  runs_truncated: z.boolean(),
  steps: z.array(
    z.object({
      kind: z.string(),
      state: z.string(),
      code: z.string().nullable(),
      result: z.string().nullable(),
      reasons: z.array(z.string()),
      at: z.string(),
      finished_at: z.string().nullable(),
    }),
  ),
  notice: z.object({ kind: z.enum(["not_feasible", "needs_human", "check_failed", "no_file_list", "respec_failed", "build_slot_wait"]), reason: z.string() }).nullable(),
  // D#598 P7c: present only while the newest review round was a merge-only re-check; `sentence` is the approved line.
  review_recheck: z.object({ kind: z.literal("merge_only"), sentence: z.string() }).nullable().optional(),
  actions: z.array(z.enum(OPERATOR_ACTIONS)),
  close_on_github: z.boolean(),
});

/** D#483: the sentence for a build that waits for a slot. Fixed words around a wait code and an issue number; nothing from the item's own text. */
export function buildWaitSentence(code: string, holder: { issue_number: number | null; stage: string } | null): string {
  if (code === "waiting_for_build_slot_account") return "Waiting for a build slot. Your account is already building as many items at once as its limit allows. This build starts by itself when one of them is done.";
  const who = holder !== null && holder.issue_number !== null ? `Issue #${holder.issue_number}` : "Another item in this repository";
  return `Waiting for a build slot. ${who} is holding this repository's only build slot, and keeps it until its pull request is merged or closed. This build starts by itself after that.`;
}

export const workItemActivityRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/work-items/{id}/activity",
    operationId: "getWorkItemActivity",
    summary: "What the pipeline is doing for one work item",
    description:
      "Session only, member. The stage, `halted` (true while a customer halt stands: set by a halt at any stage, cleared only by a person's Approve, Build again, Back to discussion or Treat as a feature that came after it), `waiting_on_answer` (true while an agent's question about this item is open or overdue and was asked by the item's newest executor run: derived from that question, so it is false once the question is answered, withdrawn, or the item has a newer run), the panel's signed comments, the newest Spec, the item's newest agent runs (oldest first, each with its summary and activity lines) and the run actions aimed at it, plus the repo, the issue number, the pull request number when a reviewer or a run's own report names one, the repo's real auto-merge setting, and a `notice` ({ kind, reason }, or null) when the pipeline stopped and needs a person: `not_feasible` (the project manager's reason the request cannot be built as written) or `needs_human` (the executor's own account of a build that ended without a pull request) or `check_failed` (the Check the build button could not decide; a fixed sentence) or, for an item at `spec_ready` or `needs_human` whose newest Spec has no readable file list, `no_file_list` (a build was refused for it, or a run ended without a pull request for it: the fixed sentence says to Re-spec, then Build again) or `respec_failed` (the last Re-spec's file list could not be read, so nothing was changed; a fixed sentence) or `build_slot_wait` (not a stop: an item at `spec_ready` or `needs_human` whose build is waiting for a build slot; the fixed sentence says why and, for the repository's slot, which item holds it). `actions` lists what the caller may do to the item right now, from the same table the action routes use (`build_again`, `respec`, `back_to_discussion`, `treat_as_feature`, `close`, `reopen`): empty for a member, an external item, an item with a live run, or a stage none applies to. `close_on_github` is true when the caller could close the item but it has an open pull request, which is closed on GitHub instead. Credential-shaped text in a summary or a reason is redacted. Model text is plain text: show it as text only.",
    principals: ["session"],
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: z.object({ id: z.string() }),
    responseSchema: activityResponseSchema,
    async handler(ctx, input) {
      const read = await getWorkItemActivity({ pool: ctx.pool, principal: ctx.principal }, input.params.id!);
      // A runner run's end is worded here, from the protocol's copy, the same words the Runs detail shows.
      const runs = await Promise.all(read.runs.map(async (r) => {
        const wait = r.runtime === "runner" ? await readRunWait(ctx.pool, ctx.principal.accountId, r) : undefined;
        return { ...r, lines: withRunnerWords(r.lines), ...(wait === undefined ? {} : { wait }) };
      }));
      // The review section's line for a merge-only re-check is written once, in the runner protocol's copy.
      // The field is present only when there is a line to show, so every other answer keeps the shape it had.
      const { review_recheck: recheck, ...rest } = read;
      const activity = { ...rest, runs, ...(recheck === null ? {} : { review_recheck: { kind: recheck.kind, sentence: COPY.reviewMergeOnlyRecheck } }) };
      // The Re-spec notices carry the KEY of their sentence out of @fx/core; the words are written once, in the runner protocol's copy.
      const n = activity.notice;
      if (n !== null && n.kind === "build_slot_wait") return { ...activity, notice: { kind: n.kind, reason: buildWaitSentence(n.reason, n.holder ?? null) } };
      if (n !== null && (n.kind === "no_file_list" || n.kind === "respec_failed")) return { ...activity, notice: { kind: n.kind, reason: COPY[FILE_LIST_NOTICE_COPY_KEY[n.kind]] } };
      // The review stops of a cloud-verified item do the same (D#6 R5b-2b-i).
      const key = (Object.values(REVIEW_STOP_COPY_KEY) as string[]).find((k) => n !== null && n.kind === "check_failed" && n.reason === k);
      if (n !== null && key !== undefined) return { ...activity, notice: { kind: n.kind, reason: COPY[key as (typeof REVIEW_STOP_COPY_KEY)[keyof typeof REVIEW_STOP_COPY_KEY]] } };
      return activity;
    },
  },
];
