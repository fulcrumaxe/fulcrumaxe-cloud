import type { PoolClient } from "pg";

/**
 * D#598 P5b: persistence for the platform's plan write-backs (migration 0825, `plan_writebacks`). Every function takes a `PoolClient`
 * already inside a tenant transaction (`withTenant`), so the caller decides what commits together with the queue entry. Nothing here
 * calls GitHub.
 *
 * The row is the platform's OWN record: the branch it made, the pull request it opened, the head sha it pushed, and the default-branch
 * commit the content was computed on. GitHub wins on a mismatch; this record is only what lets a later step tell "the head I pushed"
 * from "someone else pushed here".
 */

type Queryable = Pick<PoolClient, "query">;

export type WritebackState = "opening" | "open" | "changed_by_other" | "needs_setup" | "merged" | "closed" | "superseded" | "abandoned";

export interface PlanWritebackRow {
  id: string;
  accountId: string;
  repoId: string;
  state: WritebackState;
  planPath: string;
  branch: string | null;
  prNumber: number | null;
  headSha: string | null;
  baseSha: string | null;
  attempt: number;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface Row {
  id: string;
  account_id: string;
  repo_id: string;
  state: WritebackState;
  plan_path: string;
  branch: string | null;
  pr_number: number | null;
  head_sha: string | null;
  base_sha: string | null;
  attempt: number;
  reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, account_id, repo_id, state, plan_path, branch, pr_number, head_sha, base_sha, attempt, reason, created_at, updated_at`;
const LIVE = `('opening', 'open', 'changed_by_other', 'needs_setup')`;

function toRow(r: Row): PlanWritebackRow {
  return {
    id: r.id,
    accountId: r.account_id,
    repoId: r.repo_id,
    state: r.state,
    planPath: r.plan_path,
    branch: r.branch,
    prNumber: r.pr_number,
    headSha: r.head_sha,
    baseSha: r.base_sha,
    attempt: r.attempt,
    reason: r.reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function one(client: Queryable, sql: string, params: unknown[]): Promise<PlanWritebackRow | null> {
  const { rows } = await client.query<Row>(sql, params);
  return rows[0] ? toRow(rows[0]) : null;
}

/** What the job needs to know about a repo before it touches GitHub. */
export interface WritebackContext {
  /** The repo's GitHub owner and name; null before the first repo sync. */
  gh: { owner: string; name: string } | null;
  /** The plan file's path when the last successful import read a roadmap file, else null (no plan file to write). */
  planPath: string | null;
  /** The pairing's overlay path list when the repo has a pairing, else null (single plane). */
  overlayGlobs: string[] | null;
  /** The repo's live write-back (at most one: the database's partial unique index), or null. */
  live: PlanWritebackRow | null;
}

export async function loadWritebackContext(client: Queryable, accountId: string, repoId: string): Promise<WritebackContext> {
  const repo = await client.query<{ gh_owner: string | null; gh_name: string | null }>(
    `SELECT gh_owner, gh_name FROM repos WHERE account_id = $1 AND id = $2`,
    [accountId, repoId],
  );
  const r = repo.rows[0];
  const imp = await client.query<{ level: string | null; source_path: string | null }>(
    `SELECT level, source_path FROM plan_imports WHERE repo_id = $1 AND state = 'succeeded' ORDER BY created_at DESC, id DESC LIMIT 1`,
    [repoId],
  );
  const pairing = await client.query<{ overlay_globs: string[] }>(`SELECT overlay_globs FROM repo_pairing WHERE repo_id = $1`, [repoId]);
  const live = await one(client, `SELECT ${COLUMNS} FROM plan_writebacks WHERE account_id = $1 AND repo_id = $2 AND state IN ${LIVE}`, [accountId, repoId]);
  const latest = imp.rows[0];
  return {
    gh: r?.gh_owner && r.gh_name ? { owner: r.gh_owner, name: r.gh_name } : null,
    planPath: latest?.level === "roadmap_file" && latest.source_path ? latest.source_path : null,
    overlayGlobs: pairing.rows[0] ? pairing.rows[0].overlay_globs : null,
    live,
  };
}

export async function getWriteback(client: Queryable, accountId: string, id: string): Promise<PlanWritebackRow | null> {
  return one(client, `SELECT ${COLUMNS} FROM plan_writebacks WHERE account_id = $1 AND id = $2`, [accountId, id]);
}

/** A new row for a branch the platform is about to make. The caller chose `id` so the branch name can carry it. */
export async function insertOpening(
  client: Queryable,
  input: { accountId: string; repoId: string; id: string; planPath: string; branch: string; attempt: number },
): Promise<PlanWritebackRow> {
  const row = await one(
    client,
    `INSERT INTO plan_writebacks (id, account_id, repo_id, state, plan_path, branch, attempt)
     VALUES ($1, $2, $3, 'opening', $4, $5, $6) RETURNING ${COLUMNS}`,
    [input.id, input.accountId, input.repoId, input.planPath, input.branch, input.attempt],
  );
  if (!row) throw new Error("plan_writebacks insert returned no row");
  return row;
}

/** One `needs_setup` row per repo while nothing is live; a repeat of the same reason and path changes nothing. */
export async function recordNeedsSetup(
  client: Queryable,
  input: { accountId: string; repoId: string; planPath: string; reason: string },
): Promise<PlanWritebackRow> {
  const row = await one(
    client,
    `INSERT INTO plan_writebacks (account_id, repo_id, state, plan_path, reason) VALUES ($1, $2, 'needs_setup', $3, $4)
     ON CONFLICT (account_id, repo_id) WHERE state IN ${LIVE} DO NOTHING
     RETURNING ${COLUMNS}`,
    [input.accountId, input.repoId, input.planPath, input.reason],
  );
  if (row) return row;
  const live = await one(client, `SELECT ${COLUMNS} FROM plan_writebacks WHERE account_id = $1 AND repo_id = $2 AND state IN ${LIVE}`, [input.accountId, input.repoId]);
  if (!live) throw new Error("plan_writebacks needs_setup vanished");
  return live;
}

/** `opening` -> `open`, or an `open` row's head moving to the commit the platform just pushed. */
export async function recordOpen(
  client: Queryable,
  input: { accountId: string; id: string; prNumber: number; headSha: string; baseSha: string },
): Promise<PlanWritebackRow | null> {
  return one(
    client,
    `UPDATE plan_writebacks SET state = 'open', pr_number = $3, head_sha = $4, base_sha = $5
      WHERE account_id = $1 AND id = $2 AND state IN ('opening', 'open') RETURNING ${COLUMNS}`,
    [input.accountId, input.id, input.prNumber, input.headSha, input.baseSha],
  );
}

/** A state move along the table the database enforces; `reason` is a fixed snake_case code. Null when the row is not in `from`. */
export async function moveState(
  client: Queryable,
  input: { accountId: string; id: string; from: readonly WritebackState[]; to: WritebackState; reason?: string },
): Promise<PlanWritebackRow | null> {
  return one(
    client,
    `UPDATE plan_writebacks SET state = $3, reason = COALESCE($4, reason)
      WHERE account_id = $1 AND id = $2 AND state = ANY($5::text[]) RETURNING ${COLUMNS}`,
    [input.accountId, input.id, input.to, input.reason ?? null, [...input.from]],
  );
}
