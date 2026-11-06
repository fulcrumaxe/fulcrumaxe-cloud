import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../tenancy/withTenant.js';
import { importRepoFile, REPO_INSTRUCTION_FILES, type RepoInstructionFile } from './repoFileImport.js';
import { NotFoundError } from '../tenancy/errors.js';
import { MEMORY_IMPORT_MAX_BYTES, MemoryInputError, type LiveSecretsSource } from './index.js';

/**
 * D#601 MEM-5b: when a repository's CLAUDE.md or AGENTS.md is read, and what became of the last read (migration 0998, `repo_instruction_files`).
 *
 * A connect, or a push to the default branch whose changed paths name one of the two files, only marks the file due (`markRepoFilesDue`: the webhook makes
 * no GitHub call). The existing setup-request-check sweep lists the files whose time has come (`repo_instruction_list_due`, run-writer pool, no tenant),
 * takes each under a five-minute lease, reads it with no connection held (injected: this package cannot reach GitHub), imports it as proposals
 * (`importRepoFile`, the only place file text turns into rows) and writes the outcome in one statement. A failure records a closed code and never retries
 * in a loop: one that will not pass (too large, no access) waits for the next push or connect; one that may pass backs off 5 minutes, 30 from the third in a
 * row, and stops after eight.
 */
export const REPO_FILE_DUE_AFTER_SECONDS = 60;
export const REPO_FILE_LEASE_SECONDS = 300;
export const REPO_FILE_MAX_PER_TICK = 10;
export const REPO_FILE_START_BUDGET_MS = 45_000;
/** Room kept after the deadline for one file's read (three GitHub calls at 15 s) and its import. */
export const REPO_FILE_ONE_MS = 50_000;
const BACKOFF_SECONDS = 300;
const LONG_BACKOFF_SECONDS = 1800;
export const REPO_FILE_MAX_STREAK = 8;
/** The sentence the Memory screens show for a file read only up to its first 32 KiB. */
export const REPO_FILE_TRUNCATED_NOTICE = `File truncated at ${MEMORY_IMPORT_MAX_BYTES / 1024} KiB`;

export const REPO_FILE_ERRORS = [
  'repo_not_connected', 'app_permission_missing', 'token_not_read_only', 'github_unavailable', 'rate_limited_by_github', 'plan_file_too_large',
  'request_refused', 'request_budget_exceeded', 'repo_unready', 'import_failed',
] as const;
export type RepoFileError = (typeof REPO_FILE_ERRORS)[number];
/** Failures a repeat cannot fix: only a push or a connect (which marks the file due again) tries once more. */
export const REPO_FILE_FINAL_ERRORS: readonly RepoFileError[] = ['repo_not_connected', 'app_permission_missing', 'token_not_read_only', 'plan_file_too_large', 'request_refused'];

/** The closed code of a failed read: the error's own `code` when it is on the list, else `github_unavailable`. Never the message (it can carry a URL). */
export function repoFileErrorCode(err: unknown): RepoFileError {
  const code = (err as { code?: unknown } | null)?.code;
  return (REPO_FILE_ERRORS as readonly unknown[]).includes(code) ? (code as RepoFileError) : 'github_unavailable';
}

/**
 * The webhook's and the connect path's mark: these files of these repositories (of this account) are due 60 seconds ahead. Returns how many rows were marked.
 * One filter for both callers, the connect path's own (queueDiscoveries): a product 'team' repository that has an installation. A push for any other repository marks nothing.
 */
export async function markRepoFilesDue(client: PoolClient, input: { accountId: string; repoIds: readonly string[]; paths: readonly RepoInstructionFile[] }): Promise<number> {
  const paths = input.paths.filter((p) => (REPO_INSTRUCTION_FILES as readonly string[]).includes(p));
  if (input.repoIds.length === 0 || paths.length === 0) return 0;
  const { rowCount } = await client.query(
    `INSERT INTO repo_instruction_files (repo_id, path, account_id, due_at)
     SELECT r.id, p, r.account_id, now() + make_interval(secs => $4::integer) FROM repos r, unnest($3::text[]) p
      WHERE r.account_id = $1::uuid AND r.id = ANY($2::uuid[]) AND r.product = 'team' AND r.installation_id IS NOT NULL
     ON CONFLICT (repo_id, path) DO UPDATE SET due_at = LEAST(repo_instruction_files.due_at, EXCLUDED.due_at), error_streak = 0`,
    [input.accountId, [...input.repoIds], paths, REPO_FILE_DUE_AFTER_SECONDS],
  );
  return rowCount ?? 0;
}

export interface RepoFileJob {
  accountId: string;
  repoId: string;
  owner: string;
  name: string;
  path: RepoInstructionFile;
}
/** What the read found: the default branch's head commit, and the file at it (null when it is not there). A failure throws an error carrying a `code`. */
export type RepoFileRead = (job: RepoFileJob) => Promise<{ commit: string; file: { sha: string; text: string } | null }>;

export interface RepoFileSweepCounts {
  listed: number;
  imported: number;
  skipped: number;
  failed: number;
  nextDueAt: number | null;
}

export interface RepoFileSweepDeps {
  /** The run-writer pool. */
  pool: Pool;
  read: RepoFileRead;
  liveSecrets: LiveSecretsSource;
  now?: () => number;
  log?: (line: string) => void;
  /** Epoch ms by which the whole tick must be over; no file starts unless one still fits before it. */
  deadlineAt?: number;
}

interface Due {
  account_id: string;
  repo_id: string;
  path: RepoInstructionFile;
  due_ms: string;
  due_now: boolean;
}

/** Takes the file for this tick (the lease): null when another tick took it or a push moved it. Returns the lease as exact text and the repository's coordinates. */
async function claim(client: PoolClient, accountId: string, repoId: string, path: string): Promise<{ lease: string; owner: string; name: string } | null> {
  const { rows } = await client.query<{ lease: string }>(
    `UPDATE repo_instruction_files SET due_at = now() + make_interval(secs => $3::integer) WHERE repo_id = $1::uuid AND path = $2 AND due_at <= now() RETURNING due_at::text AS lease`,
    [repoId, path, REPO_FILE_LEASE_SECONDS],
  );
  if (!rows[0]) return null;
  const repo = await client.query<{ gh_owner: string | null; gh_name: string | null }>('SELECT gh_owner, gh_name FROM repos WHERE id = $1::uuid AND account_id = $2::uuid', [repoId, accountId]);
  const { gh_owner: owner, gh_name: name } = repo.rows[0] ?? { gh_owner: null, gh_name: null };
  if (!owner || !name) {
    // Nothing to read, and the lease must not bring it back every 5 minutes.
    await client.query('UPDATE repo_instruction_files SET due_at = NULL WHERE repo_id = $1::uuid AND path = $2', [repoId, path]);
    return null;
  }
  return { lease: rows[0].lease, owner, name };
}

/** Writes the outcome. `ok` replaces the state; a failure keeps the last good sha, commit and truncated flag and records its code. A push that moved `due_at` meanwhile keeps its own time. */
export async function recordRepoFile(
  client: PoolClient,
  input: { repoId: string; path: string; lease: string; ok: { sha: string | null; commit: string; truncated: boolean } | { error: RepoFileError } },
): Promise<number | null> {
  const ok = 'sha' in input.ok ? input.ok : null;
  const error = 'error' in input.ok ? input.ok.error : null;
  const { rows } = await client.query<{ due_ms: string | null }>(
    `UPDATE repo_instruction_files
        SET file_sha = CASE WHEN $4::text IS NULL THEN $5 ELSE file_sha END,
            source_commit = CASE WHEN $4::text IS NULL THEN $6 ELSE source_commit END,
            truncated = CASE WHEN $4::text IS NULL THEN $7::boolean ELSE truncated END,
            last_error = $4::text, checked_at = now(),
            error_streak = CASE WHEN $4::text IS NULL THEN 0 ELSE error_streak + 1 END,
            due_at = CASE WHEN due_at = $3::timestamptz THEN
                       CASE WHEN $4::text IS NULL OR $8::boolean OR error_streak + 1 >= $9::integer THEN NULL
                            ELSE now() + make_interval(secs => CASE WHEN error_streak + 1 >= 3 THEN $10::integer ELSE $11::integer END) END
                     ELSE due_at END
      WHERE repo_id = $1::uuid AND path = $2 RETURNING (extract(epoch FROM due_at) * 1000)::bigint AS due_ms`,
    [
      input.repoId, input.path, input.lease, error, ok?.sha ?? null, ok?.commit ?? null, ok?.truncated ?? false,
      error !== null && REPO_FILE_FINAL_ERRORS.includes(error), REPO_FILE_MAX_STREAK, LONG_BACKOFF_SECONDS, BACKOFF_SECONDS,
    ],
  );
  const due = rows[0]?.due_ms;
  return due === null || due === undefined ? null : Number(due);
}

export async function sweepRepoInstructionFiles(deps: RepoFileSweepDeps): Promise<RepoFileSweepCounts> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.info(line));
  const counts: RepoFileSweepCounts = { listed: 0, imported: 0, skipped: 0, failed: 0, nextDueAt: null };
  const startedAt = now();
  let list: Due[];
  try {
    list = (await deps.pool.query<Due>('SELECT account_id, repo_id, path, (extract(epoch FROM due_at) * 1000)::bigint AS due_ms, due_now FROM repo_instruction_list_due($1::integer)', [50])).rows;
  } catch (error) {
    // fx-swallow-ok: counted and logged with a fixed code (never the driver's message); the next tick lists again
    counts.failed += 1;
    log(JSON.stringify({ event: 'repo_instruction_files.list_failed', code: (error as { code?: string } | null)?.code ?? 'error' }));
    counts.nextDueAt = startedAt + 60_000;
    return counts;
  }
  counts.listed = list.length;
  const later = list.filter((d) => !d.due_now).map((d) => Number(d.due_ms));
  const batch = list.filter((d) => d.due_now);
  let started = 0;
  for (const item of batch) {
    if (started >= REPO_FILE_MAX_PER_TICK || now() - startedAt > REPO_FILE_START_BUDGET_MS || (deps.deadlineAt !== undefined && deps.deadlineAt - now() < REPO_FILE_ONE_MS)) break;
    started += 1;
    try {
      const claimed = await withTenant(deps.pool, item.account_id, (client) => claim(client, item.account_id, item.repo_id, item.path));
      if (claimed === null) {
        counts.skipped += 1;
        continue;
      }
      const lease = claimed.lease;
      let outcome: Parameters<typeof recordRepoFile>[1]['ok'];
      try {
        const read = await deps.read({ accountId: item.account_id, repoId: item.repo_id, owner: claimed.owner, name: claimed.name, path: item.path });
        if (read.file === null) outcome = { sha: null, commit: read.commit, truncated: false };
        else {
          const res = await importRepoFile({ pool: deps.pool, accountId: item.account_id, repoId: item.repo_id, path: item.path, fileSha: read.file.sha, sourceCommit: read.commit, text: read.file.text, liveSecrets: deps.liveSecrets });
          outcome = { sha: read.file.sha, commit: read.commit, truncated: res.truncated };
        }
      } catch (err) {
        // fx-swallow-ok: recorded as a closed code below (the message can carry a URL or text of the file)
        outcome = { error: err instanceof NotFoundError ? 'repo_unready' : err instanceof MemoryInputError ? 'import_failed' : repoFileErrorCode(err) };
      }
      const stored = await withTenant(deps.pool, item.account_id, (client) => recordRepoFile(client, { repoId: item.repo_id, path: item.path, lease, ok: outcome }));
      if ('error' in outcome) counts.failed += 1;
      else counts.imported += 1;
      if (stored !== null) later.push(stored);
    } catch (error) {
      // fx-swallow-ok: one file's failure is counted and logged by id and a fixed code; its lease runs out and it is listed again
      counts.failed += 1;
      log(JSON.stringify({ event: 'repo_instruction_files.failed', repo_id: item.repo_id, code: (error as { code?: string } | null)?.code ?? 'error' }));
      later.push(now() + REPO_FILE_LEASE_SECONDS * 1000);
    }
  }
  if (started < batch.length) later.push(startedAt + 1000);
  counts.nextDueAt = later.length === 0 ? null : Math.min(...later);
  return counts;
}

export interface RepoFileNotice {
  repoId: string;
  repo: string;
  path: RepoInstructionFile;
  text: string;
}

/** The files whose last import was cut at 32 KiB, for the Memory screens (tenant session). The sentence is fixed; the repository and the file are named beside it. */
export async function truncatedRepoFiles(client: PoolClient, repoIds?: readonly string[]): Promise<RepoFileNotice[]> {
  const { rows } = await client.query<{ repo_id: string; path: RepoInstructionFile; gh_owner: string | null; gh_name: string | null }>(
    `SELECT f.repo_id, f.path, r.gh_owner, r.gh_name FROM repo_instruction_files f JOIN repos r ON r.account_id = f.account_id AND r.id = f.repo_id
      WHERE f.truncated AND f.file_sha IS NOT NULL AND ($1::uuid[] IS NULL OR f.repo_id = ANY($1::uuid[])) ORDER BY r.gh_owner, r.gh_name, f.path`,
    [repoIds === undefined ? null : [...repoIds]],
  );
  return rows.map((r) => ({ repoId: r.repo_id, repo: r.gh_owner && r.gh_name ? `${r.gh_owner}/${r.gh_name}` : '', path: r.path, text: REPO_FILE_TRUNCATED_NOTICE }));
}
