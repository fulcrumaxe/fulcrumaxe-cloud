import type { PoolClient } from 'pg';
import { sanitize } from '@fx/trust';
import { cleanText } from '@fx/core/src/plan/roadmapFile.js';

/**
 * D#483 S4-d: an issue from an author without admin or maintain permission becomes a proposal, never a work item.
 *
 * The text is outsiders' text. The title is cleaned of control tokens and cut; the body is never stored raw: it is cut, stripped of
 * control-plane tokens (`<!-- STATUS:... -->`, `SPAWN_REQUEST`, any HTML comment) and wrapped in the untrusted-content fence by
 * the trust package's `sanitize`, then must fit the column. Characters Postgres cannot hold (NUL, a lone surrogate) are dropped first,
 * so a hostile body cannot make the delivery's own write fail.
 */

/** The per-repository cap on webhook proposals in one hour (Spec constant); over it the issue waits for the next discovery. */
export const WEBHOOK_PROPOSALS_PER_HOUR = 30;
const SUMMARY_MAX = 2000;
const TITLE_MAX = 256;

const STORAGE_UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function storable(text: string): string {
  return text.replace(STORAGE_UNSAFE, ' ');
}

/** The proposal title from an issue title: untrusted, one line, at most 256 characters. Never empty. */
export function proposalTitle(raw: unknown, ghNumber: number): string {
  const text = typeof raw === 'string' ? cleanText(storable(raw), TITLE_MAX) : '';
  return text || `Issue #${ghNumber}`;
}

/**
 * The proposal summary from an issue body: the body, sanitised and fenced, within the column's 2000 characters. Null when the body is
 * empty (or only whitespace). The cut is made before the fence is added and shrinks until the fenced text fits.
 */
export function fencedIssueSummary(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const body = storable(raw);
  if (body.trim() === '') return null;
  let n = Math.min(body.length, 1900);
  while (n > 0) {
    const code = body.charCodeAt(n - 1);
    const cut = code >= 0xd800 && code <= 0xdbff ? n - 1 : n;
    const fenced = sanitize(body.slice(0, cut));
    if (fenced.length <= SUMMARY_MAX) return fenced;
    n = Math.floor(n * 0.8);
  }
  return null;
}

export interface IssueProposalInput {
  ghNumber: number;
  title: string;
  summary: string | null;
  owner: 'product' | 'internal_loop';
}

export type ProposeOutcome = { outcome: 'proposed'; created: boolean } | { outcome: 'proposal_rate_limited' };

const CREATE_SQL = `
  INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, gh_number, title, summary, provenance, owner_process, state)
  VALUES ($1::uuid, $2::uuid, $3::text, ARRAY['github_issue'], $4::int, $5::text, $6::text, 'external', $7::text, 'new')
  ON CONFLICT (repo_id, dedupe_key) DO NOTHING`;

/**
 * Turns one signed `issues.opened` of an untrusted author into a proposal, inside the delivery's tenant transaction.
 *
 *   * Never a work item: the proposal is written as `plan_importer` (S3, M0 rule E4), which holds no grant on work_items, agent_runs
 *     or run_action_requests and can create a row only as `new`. Provenance is always `external`; `verification` is the column default,
 *     `pending`, which the claim verifier picks up.
 *   * Idempotent: the proposal has a unique key (repo, `gh:issue:<n>`), so a replay or an issue that already has a proposal (from a
 *     discovery, or an earlier delivery) changes nothing, and the intake event is unique per (repo, issue, outcome), so a replay is
 *     counted once.
 *   * Rate limited per repository: at most WEBHOOK_PROPOSALS_PER_HOUR new `proposed` events in the last hour. Over it, the issue is
 *     recorded as `proposal_rate_limited` and left for the next discovery, which reads the repository's recent open issues itself.
 *     The count and the write sit under one per-repository lock, so two concurrent deliveries cannot both take the last place.
 */
export async function proposeFromIssue(client: PoolClient, accountId: string, repoId: string, input: IssueProposalInput): Promise<ProposeOutcome> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`proposal_intake:${repoId}`]);
  const seen = await client.query(`SELECT 1 FROM proposal_intake_events WHERE repo_id = $1 AND gh_number = $2 AND outcome = 'proposed'`, [repoId, input.ghNumber]);
  const replay = (seen.rowCount ?? 0) > 0;
  if (!replay) {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM proposal_intake_events WHERE repo_id = $1 AND outcome = 'proposed' AND created_at > now() - interval '1 hour'`,
      [repoId],
    );
    if ((rows[0]?.n ?? 0) >= WEBHOOK_PROPOSALS_PER_HOUR) {
      await client.query(
        `INSERT INTO proposal_intake_events (account_id, repo_id, gh_number, outcome) VALUES ($1, $2, $3, 'proposal_rate_limited') ON CONFLICT (repo_id, gh_number, outcome) DO NOTHING`,
        [accountId, repoId, input.ghNumber],
      );
      return { outcome: 'proposal_rate_limited' };
    }
    await client.query(
      `INSERT INTO proposal_intake_events (account_id, repo_id, gh_number, outcome) VALUES ($1, $2, $3, 'proposed') ON CONFLICT (repo_id, gh_number, outcome) DO NOTHING`,
      [accountId, repoId, input.ghNumber],
    );
  }
  await client.query('SET LOCAL ROLE plan_importer');
  const res = await client.query(CREATE_SQL, [accountId, repoId, `gh:issue:${input.ghNumber}`, input.ghNumber, input.title, input.summary, input.owner]);
  await client.query('RESET ROLE');
  return { outcome: 'proposed', created: (res.rowCount ?? 0) > 0 };
}

export type IssueChange =
  | { change: 'closed' | 'reopened'; ghNumber: number }
  | { change: 'edited'; ghNumber: number; title: string; summary: string | null };

/**
 * `closed` and `reopened` move the issue's proposal between `withdrawn` and `new` (derived from the issue, as the importer does); `edited`
 * refreshes a `new` proposal's cleaned title and fenced summary and sends it back to be checked. A decided proposal (approved or
 * rejected) is a person's decision and is never touched, and an issue with no proposal (a trusted author's, which became a work item)
 * changes nothing. Answers how many proposals changed.
 */
export async function applyIssueChange(client: PoolClient, repoId: string, input: IssueChange): Promise<number> {
  const key = `gh:issue:${input.ghNumber}`;
  if (input.change === 'edited') {
    await client.query('SET LOCAL ROLE plan_importer');
    const res = await client.query<{ id: string }>(
      `UPDATE proposals SET title = $3, summary = $4, updated_at = now()
        WHERE repo_id = $1 AND dedupe_key = $2 AND state = 'new' AND 'github_issue' = ANY (sources) RETURNING id`,
      [repoId, key, input.title, input.summary],
    );
    await client.query('RESET ROLE');
    for (const row of res.rows) await client.query('SELECT proposal_requeue_verification($1::uuid)', [row.id]);
    return res.rows.length;
  }
  const [from, to] = input.change === 'closed' ? (['new', 'withdrawn'] as const) : (['withdrawn', 'new'] as const);
  await client.query('SET LOCAL ROLE plan_importer');
  const res = await client.query(`UPDATE proposals SET state = $4, updated_at = now() WHERE repo_id = $1 AND dedupe_key = $2 AND state = $3 AND 'github_issue' = ANY (sources)`, [repoId, key, from, to]);
  await client.query('RESET ROLE');
  return res.rowCount ?? 0;
}
