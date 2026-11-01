import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../tenancy/withTenant.js';
import { cleanText } from '../plan/roadmapFile.js';
import { markWorkPending } from '../pendingWork.js';

/**
 * D#483 S4-f2: the one writer of the docs-and-code analyst's candidates into the inbox (the proposals table), the join point of R-C25-1.
 *
 * It writes as `plan_importer` in ONE transaction, with the same discipline as `runDiscovery`'s upsert: a new row is `new` and
 * `pending`, an existing row keeps its decision, and nothing creates a work item, an agent run or an action request (the role holds no
 * grant on them). The model decides nothing about what is written: the matching is four fixed rules, run in SQL, once, with the one
 * normaliser (`proposal_title_norm`; no TypeScript copy exists, so two copies cannot drift):
 *   1. a candidate naming an issue or Discussion merges into that item's proposal in THIS repo; with no such proposal it writes nothing
 *      and is counted `named_item_not_in_inbox` (the import and its cap own those rows);
 *   2. a `duplicate_of` naming a proposal of this repo merges into it (another repo's id is ignored);
 *   3. the same normalised title merges, whatever the existing row's state;
 *   4. otherwise a new row keyed `src:` + the first 16 hex of sha256 of the normalised title.
 * Candidates of one call that land on the same row are one write. A merge adds `docs` or `code` to `sources`. On an approved or
 * rejected row it changes nothing else (a "Never" row absorbs the candidate); a withdrawn row returns to `new`; a `new` row the
 * analyst created follows the newest summary and refs, and a checked one goes back to `pending` through the requeue definer. Title,
 * provenance and owner are fixed when a row is created. The `internal` provenance is OD-C25-1 (provisional).
 */
export interface AnalysisCandidate {
  kind: 'docs' | 'code';
  title: string;
  summary: string;
  refs: Array<{ path: string; start_line: number; end_line: number }>;
  names_issue?: number;
  names_discussion?: number;
  duplicate_of?: string;
}

export interface MergeInput {
  repoId: string;
  analysisId: string;
  /** Who owns a row this call creates (decided by the caller from the repo's engine loop, as discovery does). */
  ownerProcess: 'product' | 'internal_loop';
  candidates: readonly AnalysisCandidate[];
}

export interface MergeCounts {
  merged_issue: number;
  merged_duplicate: number;
  merged_title: number;
  created: number;
  named_item_not_in_inbox: number;
}

export type MergeOutcome = { state: 'merged'; counts: MergeCounts } | { state: 'skipped'; reason: 'repo_not_connected' | 'analysis_not_visible' };

const MAX_CANDIDATES = 10;
const MAX_INT = 2147483647;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One statement: resolve, group, then update and insert. `$1` account, `$2` repo, `$3` owner, `$4` the candidates. */
const MERGE_SQL = `
WITH c AS (
  SELECT t.ord, t.kind, t.title, t.summary, t.refs, t.names_issue, t.names_discussion, t.duplicate_of, proposal_title_norm(t.title) AS norm
    FROM jsonb_to_recordset($4::jsonb) AS t(ord int, kind text, title text, summary text, refs text[], names_issue int, names_discussion int, duplicate_of uuid)
   WHERE proposal_title_norm(t.title) <> ''
),
r AS (
  SELECT c.*,
         COALESCE((SELECT p.id FROM proposals p WHERE p.repo_id = $2::uuid AND p.dedupe_key = 'gh:issue:' || c.names_issue),
                  (SELECT p.id FROM proposals p WHERE p.repo_id = $2::uuid AND p.dedupe_key = 'gh:discussion:' || c.names_discussion)) AS item_id,
         (SELECT p.id FROM proposals p WHERE p.repo_id = $2::uuid AND p.id = c.duplicate_of) AS dup_id,
         (SELECT p.id FROM proposals p WHERE p.repo_id = $2::uuid AND proposal_title_norm(p.title) = c.norm ORDER BY p.created_at, p.id LIMIT 1) AS title_id
    FROM c
),
k AS (
  SELECT r.*,
         CASE WHEN r.names_issue IS NOT NULL OR r.names_discussion IS NOT NULL THEN CASE WHEN r.item_id IS NULL THEN 'skip' ELSE 'issue' END
              WHEN r.dup_id IS NOT NULL THEN 'duplicate' WHEN r.title_id IS NOT NULL THEN 'title' ELSE 'new' END AS how,
         'src:' || left(encode(sha256(convert_to(r.norm, 'UTF8')), 'hex'), 16) AS new_key
    FROM r
),
t AS (SELECT k.*, COALESCE(k.item_id, k.dup_id, k.title_id)::text AS gkey FROM k),
g AS (
  SELECT DISTINCT ON (COALESCE(t.gkey, t.new_key)) COALESCE(t.gkey, t.new_key) AS gkey, t.how, t.item_id, t.dup_id, t.title_id, t.new_key, t.title, t.summary, t.refs,
         (SELECT array_agg(DISTINCT t2.kind ORDER BY t2.kind) FROM t t2 WHERE COALESCE(t2.gkey, t2.new_key) = COALESCE(t.gkey, t.new_key)) AS kinds
    FROM t WHERE t.how <> 'skip' ORDER BY COALESCE(t.gkey, t.new_key), t.ord
),
tgt AS (SELECT g.*, COALESCE(g.item_id, g.dup_id, g.title_id) AS target_id FROM g WHERE g.how <> 'new'),
-- Read before the update (one snapshot): a checked row of the analyst's own whose summary or refs would change goes back to be checked.
changed AS (
  SELECT p.id FROM tgt JOIN proposals p ON p.id = tgt.target_id
   WHERE p.dedupe_key LIKE 'src:%' AND NOT 'interview' = ANY (p.sources) AND p.state IN ('new', 'withdrawn') AND p.verification <> 'pending'
     AND (p.summary IS DISTINCT FROM tgt.summary OR p.analysis_refs IS DISTINCT FROM tgt.refs)
),
upd AS (
  UPDATE proposals p SET
    sources = p.sources || ARRAY(SELECT x FROM unnest(tgt.kinds) x WHERE NOT x = ANY (p.sources)),
    state = CASE WHEN p.state = 'withdrawn' THEN 'new' ELSE p.state END,
    summary = CASE WHEN own.is_own THEN tgt.summary ELSE p.summary END,
    analysis_refs = CASE WHEN own.is_own THEN tgt.refs ELSE p.analysis_refs END,
    updated_at = CASE WHEN p.state IN ('approved', 'rejected') THEN p.updated_at ELSE now() END
  FROM tgt, LATERAL (SELECT p2.dedupe_key LIKE 'src:%' AND NOT 'interview' = ANY (p2.sources) AND p2.state IN ('new', 'withdrawn') AS is_own FROM proposals p2 WHERE p2.id = tgt.target_id) own
  WHERE p.id = tgt.target_id AND p.repo_id = $2::uuid
  RETURNING p.id
),
ins AS (
  INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, title, summary, analysis_refs, provenance, owner_process, state)
  SELECT $1::uuid, $2::uuid, g.new_key, g.kinds, g.title, g.summary, g.refs, 'internal', $3::text, 'new' FROM g WHERE g.how = 'new'
  ON CONFLICT (repo_id, dedupe_key) DO NOTHING
  RETURNING id
)
SELECT (SELECT count(*) FROM g WHERE how = 'issue')::int AS merged_issue, (SELECT count(*) FROM g WHERE how = 'duplicate')::int AS merged_duplicate,
       (SELECT count(*) FROM g WHERE how = 'title')::int AS merged_title, (SELECT count(*) FROM ins)::int AS created,
       (SELECT count(*) FROM k WHERE how = 'skip')::int AS named_item_not_in_inbox,
       (SELECT count(*) FROM upd)::int AS touched, COALESCE((SELECT array_agg(id) FROM changed), '{}') AS requeue`;

const intOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= MAX_INT ? v : null);

// eslint-disable-next-line no-control-regex
const C0_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/** Outsiders' text with C0 controls removed (a NUL fails the whole jsonb parameter), then cleaned and cut. */
const cleanCandidateText = (text: string, max: number): string => cleanText(String(text ?? '').replace(C0_CONTROLS, ''), max);

/** The rows the SQL takes: texts cleaned and cut (outsiders' text), refs as `path:start-end`, ids that are not numbers or uuids dropped. */
function payload(candidates: readonly AnalysisCandidate[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const c of candidates) {
    const title = cleanCandidateText(c.title, 256);
    if (!title || (c.kind !== 'docs' && c.kind !== 'code')) continue;
    out.push({
      kind: c.kind,
      title,
      summary: cleanCandidateText(c.summary, 2000),
      refs: c.refs.length > 0 ? c.refs.slice(0, 5).map((r) => `${r.path}:${r.start_line}-${r.end_line}`) : null,
      names_issue: intOrNull(c.names_issue),
      names_discussion: intOrNull(c.names_discussion),
      duplicate_of: typeof c.duplicate_of === 'string' && UUID_RE.test(c.duplicate_of) ? c.duplicate_of.toLowerCase() : null,
    });
  }
  return out;
}

/**
 * The writer's body, for a client that is ALREADY `plan_importer` inside a tenant session. It refuses with any other role in force, so a
 * caller that forgot the role switch gets an error, not a write the database would have refused anyway.
 */
export async function mergeCandidatesAsImporter(client: PoolClient, accountId: string, input: MergeInput): Promise<{ counts: MergeCounts; touched: number; requeue: string[] }> {
  const who = await client.query<{ u: string }>('SELECT current_user AS u');
  if (who.rows[0]?.u !== 'plan_importer') throw new Error('mergeCandidates: the plan_importer role must be in force');
  const rows = payload(input.candidates);
  const { rows: out } = await client.query(MERGE_SQL, [accountId, input.repoId, input.ownerProcess, JSON.stringify(rows.map((r, i) => ({ ...r, ord: i + 1 })))]);
  const o = out[0] as MergeCounts & { touched: number; requeue: string[] };
  return {
    counts: { merged_issue: o.merged_issue, merged_duplicate: o.merged_duplicate, merged_title: o.merged_title, created: o.created, named_item_not_in_inbox: o.named_item_not_in_inbox },
    touched: o.touched,
    requeue: o.requeue,
  };
}

/** Writes one analysis's candidates (see the file comment). A repo that is not connected any more gets nothing written. */
export async function mergeCandidates(pool: Pool, accountId: string, input: MergeInput): Promise<MergeOutcome> {
  if (input.candidates.length > MAX_CANDIDATES) throw new Error('mergeCandidates: at most 10 candidates');
  const result = await withTenant(pool, accountId, async (client): Promise<MergeOutcome & { touched?: number }> => {
    const known = await client.query<{ connected: boolean }>(
      `SELECT r.installation_id IS NOT NULL AS connected FROM repos r JOIN discovery_analyses a ON a.account_id = r.account_id AND a.repo_id = r.id
        WHERE r.account_id = $1 AND r.id = $2 AND a.id = $3`,
      [accountId, input.repoId, input.analysisId],
    );
    if (known.rows.length === 0) {
      // Not visible to this tenant session (the account is not active, say) is a skip; an analysis row that EXISTS for another repo is a real mismatch.
      const other = await client.query<{ repo_id: string }>('SELECT repo_id FROM discovery_analyses WHERE id = $1', [input.analysisId]);
      if (other.rows.length === 0) return { state: 'skipped', reason: 'analysis_not_visible' };
      throw new Error('mergeCandidates: that analysis does not belong to this repository');
    }
    if (!known.rows[0]!.connected) return { state: 'skipped', reason: 'repo_not_connected' };
    await client.query('SET LOCAL ROLE plan_importer');
    const done = await mergeCandidatesAsImporter(client, accountId, input);
    // The requeue definer needs the tenant session, not the import role: step out, requeue, done (as the import's own requeue does).
    await client.query('RESET ROLE');
    for (const id of done.requeue) await client.query('SELECT proposal_requeue_verification($1::uuid)', [id]);
    return { state: 'merged', counts: done.counts, touched: done.touched };
  });
  // The transaction has committed: new and changed proposals start `pending` for the claim verifier. Void and best-effort (a hint).
  if (result.state === 'merged' && (result.touched ?? 0) + result.counts.created > 0) void markWorkPending('proposal-verify-sweep');
  return result.state === 'merged' ? { state: 'merged', counts: result.counts } : result;
}
