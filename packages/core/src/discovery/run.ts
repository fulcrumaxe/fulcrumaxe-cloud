import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../tenancy/withTenant.js';
import { ENGINE_LOOP_MARKER } from '../plan/executeImport.js';
import { decideOwnerProcess } from '../plan/ownerProcess.js';
import { cleanText } from '../plan/roadmapFile.js';
import { markWorkPending } from '../pendingWork.js';

/**
 * D#483 S4-c: one install or payment discovery, and the sweep that withdraws what a removed repository leaves behind.
 *
 * A run is a `discovery_runs` row (queued by the webhook or the subscription path, once per repo and trigger). `runDiscovery` takes
 * the queued row and either skips it with a reason or reads the repository's 50 most recently updated open issues and Discussions
 * (pull requests already excluded by the reader) and writes each as a proposal.
 *
 *   * Never a work item. The write runs as `plan_importer`, the import's own database role (S3, M0 rule E4): it holds no grant on
 *     work_items, agent_runs or run_action_requests, and the proposals guard lets it create a row only as `new`.
 *   * Never on the free preview. The run reads the account's current status when it starts; an account with no subscription skips with
 *     `free_preview`, any other status but `active` with `account_not_active`. Nothing about the preview is stored on the run, so a later activation simply queues a new one.
 *   * Every new row is `verification = pending` (the column default, written by nobody here), which is what S4-b picks up.
 *   * An `internal_loop` repo (its default branch holds the engine loop's project file) still gets its rows, owned `internal_loop`,
 *     which the Inbox shows and cannot approve. The owner is fixed when the row is created and never rewritten.
 *   * The preview's classified issues add the `preview` source, a category hint and an estimate to the rows already in the 50. A
 *     previewed issue outside the 50 is not imported (the cap is exact).
 *   * Issue and Discussion text is outsiders' text: titles and summaries are cleaned of control tokens and cut before they are stored.
 */

export interface DiscoveryItem {
  kind: 'issue' | 'discussion';
  number: number;
  title: string;
  body: string | null;
  updatedAt: string;
}

/** What the run reads from GitHub: reads only. Structurally the github package's plan source. */
export interface DiscoverySource {
  head(): Promise<{ defaultBranch: string; sha: string }>;
  file(path: string, ref: string, maxBytes: number): Promise<string | null>;
  recentOpen(): Promise<{ items: DiscoveryItem[] }>;
}

export interface PreviewHint {
  number: number;
  category: string;
  expectedUsd: number;
}

export interface DiscoveryRunDeps {
  pool: Pool;
  accountId: string;
  openSource(target: { repoId: string; owner: string; name: string }): DiscoverySource;
  /** The classified issues of the repo's finished preview, if it has one. Read inside a tenant session by the caller's wiring. */
  previewHints?(repoId: string): Promise<PreviewHint[]>;
}

export type DiscoverySkipReason = 'repo_not_connected' | 'repo_name_unknown' | 'free_preview' | 'account_not_active' | 'discovery_off';

export type DiscoveryOutcome =
  | { state: 'succeeded'; imported: number; withPreview: number; owner: 'product' | 'internal_loop' }
  | { state: 'skipped'; reason: DiscoverySkipReason }
  | { state: 'failed'; code: string }
  | { state: 'not_queued' };

const MARKER_MAX_BYTES = 1024 * 1024;
const MAX_INT = 2147483647;

/** The importer-role upsert. An existing row keeps its owner, provenance and decision; withdrawn comes back to new. */
const UPSERT_SQL = `
  INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, gh_number, discussion_number, title, summary, category_hint, estimate_usd,
                         provenance, owner_process, state)
  SELECT $1::uuid, $2::uuid, p.dedupe_key,
         CASE WHEN p.category_hint IS NULL THEN ARRAY[p.source] ELSE ARRAY[p.source, 'preview'] END,
         p.gh_number, p.discussion_number, left(p.title, 256), left(p.summary, 2000), p.category_hint, p.estimate_usd,
         'external', $3::text, 'new'
    FROM jsonb_to_recordset($4::jsonb) AS p(dedupe_key text, source text, gh_number int, discussion_number int, title text, summary text,
                                             category_hint text, estimate_usd numeric)
  ON CONFLICT (repo_id, dedupe_key) DO UPDATE
    SET title = EXCLUDED.title, summary = EXCLUDED.summary,
        sources = CASE WHEN EXCLUDED.category_hint IS NOT NULL AND NOT ('preview' = ANY (proposals.sources))
                       THEN array_append(proposals.sources, 'preview') ELSE proposals.sources END,
        category_hint = COALESCE(EXCLUDED.category_hint, proposals.category_hint),
        estimate_usd = COALESCE(EXCLUDED.estimate_usd, proposals.estimate_usd),
        state = CASE WHEN proposals.state = 'withdrawn' THEN 'new' ELSE proposals.state END,
        updated_at = now()`;

interface RunRow {
  state: string;
  repo_id: string;
  installation_id: string | null;
  gh_owner: string | null;
  gh_name: string | null;
  account_status: string;
  frequency: string | null;
}

async function skip(client: PoolClient, runId: string, reason: DiscoverySkipReason): Promise<DiscoveryOutcome> {
  await client.query(`UPDATE discovery_runs SET state = 'skipped', skip_reason = $2, finished_at = now() WHERE id = $1`, [runId, reason]);
  return { state: 'skipped', reason };
}

export async function runDiscovery(deps: DiscoveryRunDeps, runId: string): Promise<DiscoveryOutcome> {
  const { pool, accountId } = deps;

  // 1. Claim the queued row and decide, from the CURRENT rows, whether it may read anything.
  const claimed = await withTenant(pool, accountId, async (client): Promise<DiscoveryOutcome | { go: RunRow }> => {
    const { rows } = await client.query<RunRow>(
      `SELECT d.state, d.repo_id, r.installation_id, r.gh_owner, r.gh_name, a.status AS account_status,
              (SELECT s.frequency FROM discovery_settings s WHERE s.account_id = d.account_id AND s.repo_id = d.repo_id ORDER BY s.version DESC LIMIT 1) AS frequency
         FROM discovery_runs d
         JOIN repos r ON r.account_id = d.account_id AND r.id = d.repo_id
         JOIN accounts a ON a.id = d.account_id
        WHERE d.id = $1 AND d.account_id = $2
        FOR UPDATE OF d`,
      [runId, accountId],
    );
    const row = rows[0];
    if (!row || row.state !== 'queued') return { state: 'not_queued' };
    if (row.installation_id === null) return skip(client, runId, 'repo_not_connected');
    // No subscription is the free preview; every other non-active standing (past due, paused, model key broken, cancelled) is its own reason.
    if (row.account_status !== 'active') return skip(client, runId, row.account_status === 'unsubscribed' ? 'free_preview' : 'account_not_active');
    if (row.frequency === 'off') return skip(client, runId, 'discovery_off');
    if (!row.gh_owner || !row.gh_name) return skip(client, runId, 'repo_name_unknown');
    await client.query(`UPDATE discovery_runs SET state = 'running', started_at = now() WHERE id = $1`, [runId]);
    return { go: row };
  });
  if (!('go' in claimed)) return claimed;
  const row = claimed.go;

  // 2. Read. Nothing is held open while GitHub is asked.
  try {
    const source = deps.openSource({ repoId: row.repo_id, owner: row.gh_owner!, name: row.gh_name! });
    const head = await source.head();
    const hasLoop = (await source.file(ENGINE_LOOP_MARKER, head.sha, MARKER_MAX_BYTES)) !== null;
    const { items } = await source.recentOpen();
    const hints = new Map<number, PreviewHint>();
    for (const h of (await deps.previewHints?.(row.repo_id)) ?? []) hints.set(h.number, h);

    const rowsOut = new Map<string, Record<string, unknown>>();
    for (const i of items) {
      if (!Number.isSafeInteger(i.number) || i.number < 1 || i.number > MAX_INT) continue;
      const hint = i.kind === 'issue' ? hints.get(i.number) : undefined;
      const key = i.kind === 'issue' ? `gh:issue:${i.number}` : `gh:discussion:${i.number}`;
      rowsOut.set(key, {
        dedupe_key: key,
        source: i.kind === 'issue' ? 'github_issue' : 'github_discussion',
        gh_number: i.kind === 'issue' ? i.number : null,
        discussion_number: i.kind === 'discussion' ? i.number : null,
        title: cleanText(i.title, 256) || (i.kind === 'issue' ? `Issue #${i.number}` : `Discussion #${i.number}`),
        summary: i.kind === 'discussion' ? cleanText(i.body ?? '', 2000) || null : null,
        category_hint: hint ? hint.category.slice(0, 60) : null,
        estimate_usd: hint ? hint.expectedUsd : null,
      });
    }
    const payload = [...rowsOut.values()];
    const owner = decideOwnerProcess({ repoHasEngineLoop: hasLoop, kind: 'task' });
    const withPreview = payload.filter((p) => p.category_hint !== null).length;

    // 3. Write, in one transaction, as the import's own role.
    await withTenant(pool, accountId, async (client) => {
      await client.query('SET LOCAL ROLE plan_importer');
      if (payload.length > 0) await client.query(UPSERT_SQL, [accountId, row.repo_id, owner, JSON.stringify(payload)]);
      await client.query('RESET ROLE');
      await client.query(`UPDATE discovery_runs SET state = 'succeeded', counts = $2::jsonb, finished_at = now() WHERE id = $1`, [
        runId,
        JSON.stringify({ imported: payload.length, with_preview: withPreview, owner_process: owner }),
      ]);
    });
    // The transaction has committed: new proposals start `pending` for the claim verifier. Void and best-effort (a hint; the backstop is the floor).
    if (payload.length > 0) void markWorkPending('proposal-verify-sweep');
    return { state: 'succeeded', imported: payload.length, withPreview, owner };
  } catch (err) {
    // fx-swallow-ok: the failure is recorded on the run row as a closed code (never the error's text, which can carry a host or a token)
    const raw =(err as { code?: unknown } | null)?.code;
    const code = typeof raw === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(raw) ? raw : 'internal_error';
    await withTenant(pool, accountId, async (client) => {
      await client.query(`UPDATE discovery_runs SET state = 'failed', skip_reason = $2, finished_at = now() WHERE id = $1 AND state = 'running'`, [runId, code]);
    });
    return { state: 'failed', code };
  }
}

/**
 * Runs the account's queued discoveries (oldest first) and then withdraws the proposals of repositories that are no longer
 * connected. Answers each outcome. A run that is already taken by another worker is `not_queued`.
 */
export async function runQueuedDiscoveries(deps: DiscoveryRunDeps): Promise<DiscoveryOutcome[]> {
  const ids = await withTenant(deps.pool, deps.accountId, async (client) => {
    const { rows } = await client.query<{ id: string }>(`SELECT id FROM discovery_runs WHERE account_id = $1 AND state = 'queued' ORDER BY created_at, id LIMIT 200`, [deps.accountId]);
    return rows.map((r) => r.id);
  });
  const out: DiscoveryOutcome[] = [];
  for (const id of ids) out.push(await runDiscovery(deps, id));
  await withdrawDisconnectedProposals(deps.pool, deps.accountId);
  return out;
}

/**
 * A repository removed from its installation (or whose installation was uninstalled) has no installation on its row. Its `new`
 * proposals become `withdrawn`: derived from the connection, never a delete. Approved and rejected rows are a person's decisions
 * and are not touched (the importer role cannot touch them). Reconnecting brings `withdrawn` rows back at the next discovery.
 */
export async function withdrawDisconnectedProposals(pool: Pool, accountId: string): Promise<number> {
  return withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT r.id FROM repos r WHERE r.account_id = $1 AND r.installation_id IS NULL AND EXISTS (SELECT 1 FROM proposals p WHERE p.repo_id = r.id AND p.state = 'new')`,
      [accountId],
    );
    if (rows.length === 0) return 0;
    await client.query('SET LOCAL ROLE plan_importer');
    const res = await client.query(`UPDATE proposals SET state = 'withdrawn', updated_at = now() WHERE repo_id = ANY($1::uuid[]) AND state = 'new'`, [rows.map((r) => r.id)]);
    await client.query('RESET ROLE');
    return res.rowCount ?? 0;
  });
}
