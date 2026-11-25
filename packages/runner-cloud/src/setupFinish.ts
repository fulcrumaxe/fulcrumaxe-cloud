import type { Pool } from "pg";
import { LocalOnlyGithubError } from "./localOnlyGithub.js";
import { RunPullRequestError, type PullRequestRepo, type SetupFinishPort } from "./runPullRequest.js";

/**
 * D#845 ON-13a4 (Rulings 43.6, 64, 93): the finish phase, after the install pull request merged. A level-triggered reconcile job (`setup_finish`, migration 1085) takes the setups at phase `finish` one at a time
 * (`setup_finish_claim`, under a ten minute lease) and does, in order:
 *
 *   1. one Discussion per kept row of the approved plan, through the App, in the category the engine's `seed-backlog.py` picks (the row's own category, else `Ideas`, else the first). A row already recorded in
 *      `project_seeded_rows` is skipped; one whose Discussion exists on GitHub but was never recorded (a crash between the create and the record) is found by the hidden marker its body ends with, and recorded;
 *   2. the team-log issue (an open `team-log` issue is reused, as the engine's bootstrap does);
 *   3. `setup_finish_complete`: records the issue, records `start_pending` when the repo is operated (item 9), and moves the setup to `done`.
 *
 * It issues no engine start (Ruling 93.2: ON-13c issues it from `start_pending`) and borrows no person. A refusal that no retry fixes (Discussions off, no category, the App refused) is the setup's `seed_failed`
 * (the §4 copy: turn on Discussions, then try again): the job looks again fifteen minutes later, at most 96 times, and a success clears it. A GitHub that cannot be asked leaves the lease to lapse and is counted:
 * the 24th retry in a row is the same `seed_failed`, so a failure that never ends shows.
 */

export interface SetupFinishRow {
  rowKey: string;
  title: string;
  summary: string;
  size: "S" | "M" | "L";
  dependsOn: string[];
}

/** What `setup_finish_claim` hands over: ids from our own rows and the approved plan's kept rows. */
export interface SetupFinishClaim {
  accountId: string;
  setupId: string;
  repoId: string;
  attempt: number;
  owner: string;
  name: string;
  roadmap: SetupFinishRow[];
  /** Row key to the number of the Discussion already recorded for it. */
  seeded: Map<string, number>;
}

export type SetupFinishOutcome = "done" | "failed" | "retry" | "skipped";

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const ROW_KEY = /^[A-Z][A-Z0-9-]{0,15}$/;

/** The category the engine's `seed-backlog.py` (`get_category_id`) takes: the seed's own category when it exists, else `Ideas`, else the first one; none when the repository has none. */
export const SEED_DEFAULT_CATEGORY = "Ideas";
export function pickSeedCategory(categories: ReadonlyArray<{ id: string; name: string }>, wanted?: string | null): { id: string; name: string } | null {
  const by = (name: string) => categories.find((c) => c.name === name);
  return (wanted !== undefined && wanted !== null ? by(wanted) : undefined) ?? by(SEED_DEFAULT_CATEGORY) ?? categories[0] ?? null;
}

const text = (v: unknown, min: number, max: number): string | null => (typeof v === "string" && v.length >= min && v.length <= max ? v : null);

function parseRoadmap(raw: unknown): SetupFinishRow[] | null {
  if (!Array.isArray(raw) || raw.length > 200) return null;
  const out: SetupFinishRow[] = [];
  for (const r of raw as unknown[]) {
    if (typeof r !== "object" || r === null) return null;
    const o = r as Record<string, unknown>;
    const rowKey = text(o.row_key, 1, 16);
    const title = text(o.title, 1, 120);
    const summary = text(o.summary, 0, 500);
    const size = o.size;
    const deps = o.depends_on;
    if (rowKey === null || !ROW_KEY.test(rowKey) || title === null || summary === null || (size !== "S" && size !== "M" && size !== "L") || !Array.isArray(deps) || deps.length > 10) return null;
    if (!deps.every((d) => typeof d === "string" && ROW_KEY.test(d))) return null;
    out.push({ rowKey, title, summary, size, dependsOn: deps as string[] });
  }
  return out;
}

/** Takes the oldest due setup, or null when none is due. A row of a shape a setup cannot have is left to its lease (`malformed`), never acted on. */
export async function claimSetupFinish(pool: Pick<Pool, "query">): Promise<SetupFinishClaim | null | "malformed"> {
  const { rows } = await pool.query<{ o_account: string; o_setup: string; o_repo: string; o_attempt: number; o_owner: string | null; o_name: string | null; o_roadmap: unknown; o_seeded: unknown }>(
    "SELECT o_account, o_setup, o_repo, o_attempt, o_owner, o_name, o_roadmap, o_seeded FROM setup_finish_claim()",
  );
  const r = rows[0];
  if (r === undefined) return null;
  const roadmap = parseRoadmap(r.o_roadmap);
  const seeded = new Map<string, number>();
  if (!Array.isArray(r.o_seeded)) return "malformed";
  for (const s of r.o_seeded as unknown[]) {
    const o = s as { row_key?: unknown; discussion_number?: unknown };
    if (typeof o?.row_key !== "string" || !ROW_KEY.test(o.row_key) || typeof o.discussion_number !== "number" || !Number.isSafeInteger(o.discussion_number) || o.discussion_number < 1) return "malformed";
    seeded.set(o.row_key, o.discussion_number);
  }
  if (roadmap === null || r.o_owner === null || r.o_name === null || !NAME.test(r.o_owner) || !NAME.test(r.o_name)) return "malformed";
  return { accountId: r.o_account, setupId: r.o_setup, repoId: r.o_repo, attempt: r.o_attempt, owner: r.o_owner, name: r.o_name, roadmap, seeded };
}

/** A person wrote the plan's words, so they are cleaned before they reach GitHub: no control character, and no HTML comment (the one comment a body holds is our marker). */
const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/<!--/g, "&lt;!--").trim();

/** The Discussion for one kept row: its title, its summary, its size and what it waits on, and the hidden marker (setup id and row key, ids of our own rows) that ends the body. */
export function seedDiscussionText(setupId: string, row: SetupFinishRow): { title: string; body: string } {
  const lines = [clean(row.summary), `Size: ${row.size}`, ...(row.dependsOn.length > 0 ? [`Depends on: ${row.dependsOn.join(", ")}`] : [])].filter((l) => l.length > 0);
  return { title: clean(row.title), body: `${lines.join("\n\n")}\n\n<!-- fx-seed:${setupId}:${row.rowKey} -->` };
}

/** The team-log issue's text, as the engine's `rotate-team-log.sh` writes it, with our marker. */
export function teamLogText(setupId: string, now: Date): { title: string; body: string } {
  return { title: `Team Activity Log ${now.toISOString().slice(0, 10)}`, body: `Team activity log. Created ${now.toISOString().slice(0, 19)}Z.\n\n<!-- fx-team-log:${setupId} -->` };
}

export interface SetupFinishDeps {
  /** The platform_ops pool: the claim and the recording definers are its alone. */
  pool: Pick<Pool, "query">;
  port: SetupFinishPort;
  now?: () => Date;
}

/** The step for one claimed setup. Never throws for a GitHub failure: those are `retry` or a recorded `seed_failed`. A database failure throws. */
export async function completeSetupFinish(deps: SetupFinishDeps, claim: SetupFinishClaim): Promise<SetupFinishOutcome> {
  const repo: PullRequestRepo = { id: claim.repoId, owner: claim.owner, name: claim.name };
  const fail = async (): Promise<SetupFinishOutcome> => {
    const { rows } = await deps.pool.query<{ ok: boolean }>("SELECT setup_finish_fail($1::uuid, $2::int, 'seed_failed') AS ok", [claim.setupId, claim.attempt]);
    return rows[0]?.ok === true ? "failed" : "skipped";
  };
  // a GitHub that cannot be asked is a retry, but the 24th in a row is the setup's `seed_failed` (counted by the definer), so a mint that always fails shows
  const retried = async (): Promise<SetupFinishOutcome> => {
    const { rows } = await deps.pool.query<{ r: string }>("SELECT setup_finish_retry($1::uuid, $2::int) AS r", [claim.setupId, claim.attempt]);
    return rows[0]?.r === "failed" ? "failed" : rows[0]?.r === "retry" ? "retry" : "skipped";
  };
  const record = async (rowKey: string, number: number): Promise<boolean> => (await deps.pool.query<{ ok: boolean }>("SELECT setup_finish_seed_record($1::uuid, $2::int, $3, $4::int) AS ok", [claim.setupId, claim.attempt, rowKey, number])).rows[0]?.ok === true;
  try {
    const todo = claim.roadmap.filter((row) => !claim.seeded.has(row.rowKey));
    if (todo.length > 0) {
      const target = await deps.port.discussionTarget(repo);
      const category = pickSeedCategory(target.categories);
      // Discussions off, or none to put them in: the App can neither turn them on nor make a category, so the person does (the §4 copy)
      if (!target.discussionsEnabled || category === null) return await fail();
      const existing = await deps.port.findSeeded({ repo, setupId: claim.setupId });
      for (const row of todo) {
        const number = existing.get(row.rowKey) ?? (await deps.port.createDiscussion({ repo, repositoryId: target.repositoryId, categoryId: category.id, ...seedDiscussionText(claim.setupId, row) }));
        if (!(await record(row.rowKey, number))) return "skipped";
      }
    }
    const teamLog = (await deps.port.findTeamLog(repo)) ?? (await deps.port.createTeamLog({ repo, ...teamLogText(claim.setupId, (deps.now ?? (() => new Date()))()) }));
    const { rows } = await deps.pool.query<{ r: string }>("SELECT setup_finish_complete($1::uuid, $2::int, $3::int) AS r", [claim.setupId, claim.attempt, teamLog]);
    return rows[0]?.r === "done" ? "done" : "skipped";
  } catch (error) {
    if (error instanceof RunPullRequestError) return error.retryable ? retried() : fail();
    // a call the fence refused is a bug in this step, not a GitHub failure, and no retry fixes it: it is recorded, so the setup does not sit leased and unseen
    if (error instanceof LocalOnlyGithubError) return fail();
    throw error;
  }
}
