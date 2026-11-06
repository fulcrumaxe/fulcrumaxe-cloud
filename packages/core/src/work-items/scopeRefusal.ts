import type { PoolClient } from 'pg';

/**
 * D#6 CHECKFIX-SUCCESS-AS-FAILED: a runner run whose pull request the cloud's scope check refused.
 *
 * `done` judges the files a run changed against the Spec's file list. A run that changed a file outside the list ends `failed` (`scope_violation`, or
 * `scope_unknown` for a rename or a change type the cloud cannot judge), and the cloud closes the pull request it opened on the private repository.
 * That close is the cloud's own verdict, not a person's decision, so the item must end at Needs a person with the scope result named, never at
 * `closed_unmerged` (which is what a pull request closed on GitHub reads as).
 *
 * The cloud records this event on the run BEFORE it closes the pull request. The webhook and the stale pull-request sweep read it
 * (`scopeRefusalHoldsClose`) and leave the item alone; a recorded fact, not a timing window. A person who closes (or reopens and closes) a pull request
 * the cloud did not refuse has no such event, so that close still reads as `closed_unmerged`.
 *
 * The event names BOTH pull requests the cloud closes, each with the repository it lives in: the private one (`repo` + `prNumber`) and, on a paired
 * repository, the public copy (`publicPr`). A hold applies to the repository the close was delivered for plus that repository's own number, so a same-numbered
 * pull request of another repository never matches. Both names are written by the cloud from its own rows, never from runner input.
 */
export const SCOPE_REFUSAL_EVENT = 'run.scope_refused';

/** The most out-of-scope paths the event keeps (the rest are counted in `total`). */
export const SCOPE_REFUSAL_MAX_PATHS = 10;
const MAX_PATH_CHARS = 200;
// C0/C1 controls, the line and paragraph separators, and the bidirectional controls (U+202A-202E, U+2066-2069), which could reorder the text a file name is shown in.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const REPO_FULL_NAME = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

export type ScopeRefusalReason = 'scope_violation' | 'scope_unknown';

export interface ScopeRefusal {
  reason: ScopeRefusalReason;
  /** The pull request on the private repository the cloud closed. */
  prNumber: number;
  /** The full name (`owner/name`) of the repository `prNumber` lives in: the run's dispatch repository. Written by the cloud from its own rows. */
  repo?: string;
  /** The run's public copy on the paired repository, when the cloud closes it too: that repository's full name and the pull request number there. */
  publicPr?: { codeRepo: string; number: number };
  /** How many changed files were outside the list; null when GitHub's file list was incomplete (the count is not known). */
  total: number | null;
  /** At most `SCOPE_REFUSAL_MAX_PATHS` of them, each a plain repository path. */
  paths: string[];
  /** Why a `scope_unknown` was reached, when that matters to the words. */
  detail?: 'renamed' | 'unknown_change_type';
}

/** The event payload, cleaned: a path that is not plain text is dropped, the list is cut, and nothing else is kept. */
export function scopeRefusalPayload(r: ScopeRefusal): Record<string, unknown> {
  const paths = r.paths.filter((p) => typeof p === 'string' && p.length > 0 && p.length <= MAX_PATH_CHARS && !CONTROL.test(p)).slice(0, SCOPE_REFUSAL_MAX_PATHS);
  return {
    reason: r.reason,
    prNumber: r.prNumber,
    ...(typeof r.repo === 'string' && REPO_FULL_NAME.test(r.repo) ? { repo: r.repo } : {}),
    ...(r.publicPr !== undefined && REPO_FULL_NAME.test(r.publicPr.codeRepo) && Number.isSafeInteger(r.publicPr.number) && r.publicPr.number > 0 ? { publicPr: { codeRepo: r.publicPr.codeRepo, number: r.publicPr.number } } : {}),
    total: r.total === null ? null : Math.max(0, Math.floor(r.total)),
    paths,
    ...(r.detail === undefined ? {} : { detail: r.detail }),
  };
}

/** Reads a stored payload back; null when it is not one this module wrote. */
export function parseScopeRefusal(payload: unknown): ScopeRefusal | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (p.reason !== 'scope_violation' && p.reason !== 'scope_unknown') return null;
  if (typeof p.prNumber !== 'number' || !Number.isSafeInteger(p.prNumber) || p.prNumber <= 0) return null;
  const total = p.total === null ? null : typeof p.total === 'number' && Number.isSafeInteger(p.total) && p.total >= 0 ? p.total : undefined;
  if (total === undefined) return null;
  const paths = Array.isArray(p.paths) ? p.paths.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= MAX_PATH_CHARS && !CONTROL.test(x)).slice(0, SCOPE_REFUSAL_MAX_PATHS) : [];
  const detail = p.detail === 'renamed' || p.detail === 'unknown_change_type' ? p.detail : undefined;
  const repo = typeof p.repo === 'string' && REPO_FULL_NAME.test(p.repo) ? p.repo : undefined;
  const pub = p.publicPr !== null && typeof p.publicPr === 'object' && !Array.isArray(p.publicPr) ? (p.publicPr as Record<string, unknown>) : undefined;
  const publicPr =
    pub !== undefined && typeof pub.codeRepo === 'string' && REPO_FULL_NAME.test(pub.codeRepo) && typeof pub.number === 'number' && Number.isSafeInteger(pub.number) && pub.number > 0
      ? { codeRepo: pub.codeRepo, number: pub.number }
      : undefined;
  return { reason: p.reason, prNumber: p.prNumber, ...(repo === undefined ? {} : { repo }), ...(publicPr === undefined ? {} : { publicPr }), total, paths, ...(detail === undefined ? {} : { detail }) };
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** The files, as the card names them: the count, then each path, then how many more there were. */
function filesPhrase(r: ScopeRefusal): string {
  const total = r.total ?? r.paths.length;
  const more = Math.max(0, total - r.paths.length);
  const list = r.paths.join(', ');
  return list === '' ? `${total} ${plural(total, 'file', 'files')}` : `${total} ${plural(total, 'file', 'files')}: ${list}${more > 0 ? ` (and ${more} more)` : ''}`;
}

/** The sentence the card shows at Needs a person. Fixed words around the counts and paths; no model text and no text from GitHub. */
export function scopeRefusalSentence(r: ScopeRefusal): string {
  // A public copy the cloud closed too is what "Build again" would stop at (it asks for the pull request to be reopened first), so the card says that in the same words.
  const tail =
    r.publicPr === undefined
      ? " The pull request was closed and its branch was kept; nothing was merged. Add the files to the Spec's file list, or build again without touching them."
      : " The pull request was closed and its branch was kept; nothing was merged. The public copy was closed too. To build again, reopen it on GitHub first, then add the files to the Spec's list or build without them.";
  if (r.reason === 'scope_unknown') {
    if (r.detail === 'renamed') return `The change renames a file${r.paths.length > 0 ? ` (${r.paths.join(', ')})` : ''}, which the Spec's file list check cannot judge.${tail}`;
    return `The change contains a kind of file change the Spec's file list check cannot judge${r.paths.length > 0 ? ` (${r.paths.join(', ')})` : ''}.${tail}`;
  }
  if (r.total === null && r.paths.length === 0) return `The pull request changed more files than GitHub would list, so the Spec's file list check could not pass it.${tail}`;
  return `The change touched ${filesPhrase(r)} outside the Spec's file list.${tail}`;
}

/**
 * True when the close of pull request `prNumber` of the repository `repoFullName` is one the cloud made itself for a refused run of this item: a run of the item recorded
 * the refusal event naming exactly this repository and this number, either as the private pull request (`repo` + `prNumber`) or as its public copy (`publicPr`). The webhook
 * and the stale pull-request sweep must not record `closed_unmerged` for it. `repoFullName` is the repository the close was delivered for (compared without case);
 * a same-numbered pull request of any other repository is not held. `client` is a `withTenant` client.
 */
export async function scopeRefusalHoldsClose(client: Pick<PoolClient, 'query'>, workItemId: string, repoFullName: string, prNumber: number): Promise<boolean> {
  const { rows } = await client.query<{ held: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM run_events e JOIN agent_runs r ON r.account_id = e.account_id AND r.id = e.run_id
                     WHERE r.work_item_id = $1::uuid AND e.kind = $4
                       AND ((lower(e.payload->>'repo') = lower($3::text) AND e.payload->>'prNumber' = $2::text)
                         OR (lower(e.payload #>> '{publicPr,codeRepo}') = lower($3::text) AND e.payload #>> '{publicPr,number}' = $2::text))) AS held`,
    [workItemId, String(prNumber), repoFullName, SCOPE_REFUSAL_EVENT],
  );
  return rows[0]?.held === true;
}
