import type { Pool } from "pg";
import { cleanText } from "@fx/core/src/plan/roadmapFile.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";

/**
 * D#483 S5-b2d-1: the follow-ups a reviewer or an executor raised in its envelope (`follow_ups`), read and handed to the database's one writer.
 *
 * A follow-up is non-blocking by definition: a blocking problem is a finding with `needs-fix`. It is model text, so it is read only from a run that
 * SUCCEEDED, as plain strings, with control characters stripped and white space folded (the shared `cleanText`). The bounds (a title of 1 to 120
 * characters, a why of at most 600, 3 per run, 10 per parent) and the run's role are decided by `follow_ups_record` (migration 0960) alone, so the
 * reader keeps one character past each bound: an over-long item reaches the definer over-long and is dropped and counted there, never cut and kept.
 * The text is stored and shown as text; nothing in this PR puts it back into a prompt.
 */

export const MAX_FOLLOW_UP_TITLE = 120;
export const MAX_FOLLOW_UP_WHY = 600;
/** How many the reader hands on; the definer keeps at most 3 of them and counts the rest as dropped. */
export const MAX_FOLLOW_UPS_READ = 10;

/** The one sentence the code reviewer, security reviewer and acceptance tester prompts gain. */
export const REVIEWER_FOLLOW_UPS_LINE =
  'If you see something worth doing later that does not block this change, you may add it to an optional `follow_ups` array next to the verdict, at most 3 items of {"title":"<at most 120 characters>","why":"<at most 600 characters>"}; a problem that blocks the change is never a follow-up, it stays a finding and the verdict is "needs-fix".';
/** The one sentence the executor prompt gains. */
export const EXECUTOR_FOLLOW_UPS_LINE =
  'If you noticed work worth doing later that this change does not need, you may add it to an optional `follow_ups` array in your final block, at most 3 items of {"title":"<at most 120 characters>","why":"<at most 600 characters>"}; anything that blocks this change is not a follow-up, it belongs in the change itself (a reviewer would report it as a finding with "needs-fix").';

export interface FollowUp {
  title: string;
  why: string;
}

const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A surrogate with no partner. JSON.stringify writes one as `\ud800`, which a jsonb cast refuses (22P02) and that would lose every item of the run. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Cleaned text cut to `max` characters as the definer counts them (`char_length`: code points, not UTF-16 units), so an emoji counts once and a cut never
 * splits a pair. `cleanText` cuts by units, so it is asked for twice as many, enough for `max` code points of any width.
 */
function boundedText(text: string, max: number): string {
  return Array.from(cleanText(text, 2 * max).replace(LONE_SURROGATE, "")).slice(0, max).join("");
}

/** The run's follow-ups, or `[]`: a run that did not succeed, no envelope, and a `follow_ups` that is absent, null, a string or an object all read as none. */
export function readFollowUps(status: string, envelope: unknown): FollowUp[] {
  if (status !== "succeeded" || !plain(envelope) || !Object.hasOwn(envelope, "follow_ups")) return [];
  const raw = envelope.follow_ups;
  if (!Array.isArray(raw)) return [];
  const out: FollowUp[] = [];
  for (const item of raw.slice(0, MAX_FOLLOW_UPS_READ)) {
    if (!plain(item) || typeof item.title !== "string" || (item.why !== undefined && typeof item.why !== "string")) continue;
    out.push({ title: boundedText(item.title, MAX_FOLLOW_UP_TITLE + 1), why: boundedText(item.why ?? "", MAX_FOLLOW_UP_WHY + 1) });
  }
  return out;
}

/**
 * Records one run's follow-ups, in a transaction of its own. Never throws: a failure is one fixed log line with the run id and nothing else (no model
 * text, no error text), and the review or the build that called it carries on exactly as it would have.
 */
export async function recordRunFollowUps(pool: Pool, accountId: string, runId: string): Promise<void> {
  try {
    await withTenant(pool, accountId, async (client) => {
      const run = (await client.query<{ status: string; envelope: unknown }>("SELECT status, envelope FROM agent_runs WHERE id = $1 AND account_id = $2", [runId, accountId])).rows[0];
      const items = run ? readFollowUps(run.status, run.envelope) : [];
      if (items.length === 0) return;
      await client.query("SELECT follow_ups_record($1, $2::jsonb)", [runId, JSON.stringify(items)]);
    });
  } catch {
    // fx-swallow-ok: a follow-up is never worth failing a review or a build over; the fixed line is the trace, and it carries no model or error text
    console.warn(JSON.stringify({ event: "follow_ups.record_failed", run_id: runId }));
  }
}
