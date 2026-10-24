import type { PoolClient } from 'pg';
import { NotFoundError } from '../tenancy/errors.js';
import {
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  MemoryInputError,
  assertUuid,
  inSession,
  readEntries,
  type MemoryAuthorKind,
  type MemoryCtx,
  type MemoryEntry,
  type MemoryKind,
  type MemoryProvenance,
  type MemoryScope,
  type MemoryStatus,
} from './index.js';
import { MEMORY_GATED_AUTHOR_KINDS } from './batch.js';
import { MEMORY_RUN_COUNT_MAX_IDS, memoryRunCounts } from './runCounts.js';
import {
  formatItemGroup,
  formatMemoryAge,
  formatMemoryKind,
  formatMemoryProposedBy,
  formatMemoryRuns,
  formatMemorySource,
  formatMemoryStatus,
  formatMemoryTitle,
  formatRepoGroup,
  memoryText,
  type MemoryStatusDisplay,
} from './format.js';

/**
 * D#601 MEM-4a1b: what the Memory screens read: the list grouped by scope (with "Used in N runs"), the review queue (body, provenance, evidence
 * and whether the caller opened each card), and the pending counts for the badges. The rules live in the database; nothing here copies one.
 *
 * "Used in N runs" is `memoryRunCounts` over `run_context_inputs`. A run with no row there (it predates the record, or recalled nothing) is not
 * counted, and an absent row does not prove nothing was recalled. The number is display data, never a gate.
 */

/** The most rows one list or queue read returns: the count read takes 200 ids at most, and a screen pages by scope. */
export const MEMORY_LIST_MAX = MEMORY_RUN_COUNT_MAX_IDS;
/** Statuses a list shows when no status filter is given: history (`superseded`) and the Deleted tab (`deleted`) are asked for by name. */
const DEFAULT_LIST_STATUSES: readonly MemoryStatus[] = MEMORY_STATUSES.filter((s) => s !== 'superseded' && s !== 'deleted');
type ReadCtx = Pick<MemoryCtx, 'pool' | 'principal'>;

/** Which entries to read. `repoId` and `itemId` name the scope by the id the app holds; the repo's memory key is derived here, never taken from the caller. */
export interface MemoryScopeFilter {
  scope?: MemoryScope;
  repoId?: string;
  itemId?: string;
  kinds?: readonly MemoryKind[];
  statuses?: readonly MemoryStatus[];
  limit?: number;
}

export interface MemoryListRow {
  id: string;
  scope: MemoryScope;
  scopeRef: string | null;
  kind: MemoryKind;
  kindLabel: string;
  status: MemoryStatus;
  statusDisplay: MemoryStatusDisplay;
  title: string;
  authorKind: MemoryAuthorKind;
  source: string;
  version: number;
  createdAt: Date;
  age: string;
  /** Runs whose recorded inputs list this entry's lineage. A number, 0 when none, never null. */
  runs: number;
  runsLabel: string;
}

export interface MemoryGroup {
  scope: MemoryScope;
  scopeRef: string | null;
  /** `owner/name` for a repo, `#number title` for an item, the role name, or "Account". Never blank. */
  label: string;
  /** The repo or item id the app holds, for a link; null for the account and role groups. */
  targetId: string | null;
  entries: MemoryListRow[];
}

export interface MemoryList {
  groups: MemoryGroup[];
  /** True when more rows matched than were returned. */
  truncated: boolean;
}

interface ListRow {
  id: string;
  scope: MemoryScope;
  scope_ref: string | null;
  kind: MemoryKind;
  body: string;
  author_kind: MemoryAuthorKind;
  provenance: MemoryProvenance;
  status: MemoryStatus;
  version: number;
  created_at: Date;
  repo_id: string | null;
  gh_owner: string | null;
  gh_name: string | null;
  item_number: string | null;
  item_title: string | null;
  receipt_missing: boolean;
}

const SCOPE_ORDER: Readonly<Record<MemoryScope, number>> = { repo: 0, item: 1, role: 2, account: 3 };
const UUID_LIST_MAX = 200;

/** A repo's memory key: its GitHub node id and its installation's GitHub id. Null when the repo has no node id yet (nothing is recalled for it either). */
export async function repoScopeRefOf(client: PoolClient, repoId: string): Promise<string | null> {
  assertUuid('repo', repoId);
  const { rows } = await client.query<{ gh_node_id: string | null; gh_installation_id: string | null }>(
    `SELECT r.gh_node_id, i.gh_installation_id::text AS gh_installation_id
       FROM repos r LEFT JOIN installations i ON i.account_id = r.account_id AND i.id = r.installation_id
      WHERE r.id = $1::uuid`,
    [repoId],
  );
  if (rows[0] === undefined) throw new NotFoundError(`repo ${repoId} not found`);
  const { gh_node_id: node, gh_installation_id: inst } = rows[0];
  return node === null || inst === null ? null : `${node}@${inst}`;
}

function checkEnumList<T extends string>(label: string, all: readonly T[], list: readonly T[] | undefined): readonly T[] | null {
  if (list === undefined) return null;
  for (const v of list) if (!(all as readonly string[]).includes(v)) throw new MemoryInputError('invalid_message', `unknown ${label}`);
  return list;
}

/** The SQL that gives each entry its repo or item label. The casts sit inside CASE so a row of another scope never reaches them. */
const LABEL_JOINS = `
  LEFT JOIN LATERAL (
    SELECT r.id, r.gh_owner, r.gh_name FROM repos r JOIN installations i ON i.account_id = r.account_id AND i.id = r.installation_id
     WHERE m.scope = 'repo' AND r.account_id = m.account_id AND r.gh_node_id = split_part(m.scope_ref, '@', 1)
       AND i.gh_installation_id::text = split_part(m.scope_ref, '@', 2)
     LIMIT 1
  ) rp ON true
  LEFT JOIN work_items w ON m.scope = 'item' AND w.account_id = m.account_id AND w.id = (CASE WHEN m.scope = 'item' THEN m.scope_ref::uuid END)`;
// D#601 MEM-8b: an entry that names a decision receipt whose row is gone (only the case where the receipt cannot be read; the entry itself is untouched).
const RECEIPT_ID_SQL = `CASE WHEN (m.provenance ->> 'receipt_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (m.provenance ->> 'receipt_id')::uuid END`;
const LABEL_COLUMNS = `rp.id AS repo_id, rp.gh_owner, rp.gh_name, w.gh_number::text AS item_number, w.title AS item_title,
  (m.provenance ? 'receipt_id' AND NOT EXISTS (SELECT 1 FROM decision_receipts dr WHERE dr.account_id = m.account_id AND dr.id = ${RECEIPT_ID_SQL})) AS receipt_missing`;
/** What the Memory tab calls an entry whose receipt can no longer be read. */
export const RECEIPT_MISSING_TITLE = 'Receipt no longer available';

function groupLabel(r: ListRow): { label: string; targetId: string | null } {
  switch (r.scope) {
    case 'repo':
      return { label: formatRepoGroup(r.gh_owner, r.gh_name), targetId: r.repo_id };
    case 'item':
      return { label: formatItemGroup(r.item_number, r.item_title), targetId: r.scope_ref };
    case 'role':
      return { label: memoryText(r.scope_ref, 'Role'), targetId: null };
    default:
      return { label: 'Account', targetId: null };
  }
}

/** Resolves the filter to the SQL conditions, or null when the filter names a repo that has no memory key (nothing can match). */
async function scopeConditions(client: PoolClient, f: MemoryScopeFilter, params: unknown[]): Promise<string[] | null> {
  const where: string[] = [];
  if (f.scope !== undefined) {
    if (!(MEMORY_SCOPES as readonly string[]).includes(f.scope)) throw new MemoryInputError('invalid_message', 'unknown scope');
    params.push(f.scope);
    where.push(`m.scope = $${params.length}`);
  }
  if (f.repoId !== undefined) {
    const ref = await repoScopeRefOf(client, f.repoId);
    if (ref === null) return null;
    params.push(ref);
    where.push(`m.scope = 'repo' AND m.scope_ref = $${params.length}`);
  }
  if (f.itemId !== undefined) {
    assertUuid('item', f.itemId);
    params.push(f.itemId);
    where.push(`m.scope = 'item' AND m.scope_ref = $${params.length}`);
  }
  return where;
}

/**
 * The entries of the caller's account, grouped by scope (repos by owner/name, items by number and title), newest first inside a group. Each row
 * carries title, kind, source, age and `runs`. With no status filter the list leaves out `superseded` (history) and `deleted` (the Deleted tab).
 * A repo with no GitHub node id has no key, so a filter on it returns nothing (it never falls back to another key).
 */
export async function listMemory(ctx: ReadCtx, filter: MemoryScopeFilter = {}, now: Date = new Date()): Promise<MemoryList> {
  const kinds = checkEnumList('kind', MEMORY_KINDS, filter.kinds);
  const statuses = checkEnumList('status', MEMORY_STATUSES, filter.statuses) ?? DEFAULT_LIST_STATUSES;
  const limit = Math.min(Math.max(Math.floor(filter.limit ?? MEMORY_LIST_MAX), 1), MEMORY_LIST_MAX);
  const rows = await inSession(ctx, async (client) => {
    const params: unknown[] = [];
    const where = await scopeConditions(client, filter, params);
    if (where === null) return [];
    params.push([...statuses]);
    where.push(`m.status = ANY($${params.length}::text[])`);
    if (kinds !== null) {
      params.push([...kinds]);
      where.push(`m.kind = ANY($${params.length}::text[])`);
    }
    params.push(limit + 1);
    return (
      await client.query<ListRow>(
        `SELECT m.id, m.scope, m.scope_ref, m.kind, m.body, m.author_kind, m.provenance, m.status, m.version, m.created_at, ${LABEL_COLUMNS}
           FROM memory_entries m ${LABEL_JOINS}
          WHERE ${where.map((w) => `(${w})`).join(' AND ')}
          ORDER BY m.scope, m.scope_ref NULLS FIRST, m.created_at DESC, m.id
          LIMIT $${params.length}::int`,
        params,
      )
    ).rows;
  });
  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  const counts = page.length === 0 ? {} : await memoryRunCounts(ctx, page.map((r) => r.id));
  const groups = new Map<string, MemoryGroup>();
  for (const r of page) {
    const key = `${r.scope}\u0000${r.scope_ref ?? ''}`;
    let g = groups.get(key);
    if (g === undefined) {
      g = { scope: r.scope, scopeRef: r.scope_ref, ...groupLabel(r), entries: [] };
      groups.set(key, g);
    }
    const runs = counts[r.id] ?? 0;
    g.entries.push({
      id: r.id,
      scope: r.scope,
      scopeRef: r.scope_ref,
      kind: r.kind,
      kindLabel: formatMemoryKind(r.kind),
      status: r.status,
      statusDisplay: formatMemoryStatus(r.status),
      title: r.receipt_missing ? RECEIPT_MISSING_TITLE : formatMemoryTitle(r.body, r.scope, r.kind),
      authorKind: r.author_kind,
      source: formatMemorySource(r.author_kind, r.provenance),
      version: Number(r.version),
      createdAt: r.created_at,
      age: formatMemoryAge(r.created_at, now),
      runs,
      runsLabel: formatMemoryRuns(runs),
    });
  }
  const ordered = [...groups.values()].sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || a.label.localeCompare(b.label) || (a.scopeRef ?? '').localeCompare(b.scopeRef ?? ''));
  return { groups: ordered, truncated };
}

/** Whether the caller has opened a card: not asked of this source, asked and done, or asked and not yet done. */
export type MemoryOpenState = 'not_required' | 'opened' | 'unopened';

export interface MemoryQueueCard {
  entry: MemoryEntry;
  title: string;
  kindLabel: string;
  source: string;
  /** "Proposed by agent (run <id>)", fixed wording that an edit does not change. */
  proposedBy: string;
  /** What the proposer cited as evidence; empty text when it cited none. */
  evidence: string;
  age: string;
  /** Opened by THIS caller, for THIS version's text. An edit makes a new version, which is `unopened` again. */
  openState: MemoryOpenState;
  scopeLabel: string;
}

interface QueueRow extends ListRow {
  opened: boolean;
}

/**
 * The proposals waiting for a decision, oldest first, with what a reviewer needs on the card (the body, who proposed it, the evidence) and
 * whether the caller has opened each imported or runner-sourced one. The read itself opens nothing: the card's open request is
 * `markMemoryOpened`.
 */
export async function memoryQueue(ctx: ReadCtx, filter: Omit<MemoryScopeFilter, 'statuses' | 'kinds'> = {}, now: Date = new Date()): Promise<{ cards: MemoryQueueCard[]; truncated: boolean }> {
  const limit = Math.min(Math.max(Math.floor(filter.limit ?? MEMORY_LIST_MAX), 1), MEMORY_LIST_MAX);
  const { rows, entries } = await inSession(ctx, async (client) => {
    const params: unknown[] = [ctx.principal.userId];
    const where = await scopeConditions(client, filter, params);
    if (where === null) return { rows: [] as QueueRow[], entries: [] as MemoryEntry[] };
    where.push(`m.status = 'proposed'`);
    params.push(limit + 1);
    const found = (
      await client.query<QueueRow>(
        `SELECT m.id, m.scope, m.scope_ref, m.kind, m.body, m.author_kind, m.provenance, m.status, m.version, m.created_at, ${LABEL_COLUMNS},
                EXISTS (SELECT 1 FROM memory_entry_opens o WHERE o.entry_id = m.id AND o.user_id = $1::uuid AND o.content_sha256 = m.content_sha256) AS opened
           FROM memory_entries m ${LABEL_JOINS}
          WHERE ${where.map((w) => `(${w})`).join(' AND ')}
          ORDER BY m.created_at, m.id
          LIMIT $${params.length}::int`,
        params,
      )
    ).rows;
    const page = found.slice(0, limit);
    return { rows: found, entries: await readEntries(client, page.map((r) => r.id)) };
  });
  const truncated = rows.length > limit;
  const byId = new Map(entries.map((e) => [e.id, e]));
  const cards = rows.slice(0, limit).flatMap((r): MemoryQueueCard[] => {
    const entry = byId.get(r.id);
    if (entry === undefined) return [];
    const gated = (MEMORY_GATED_AUTHOR_KINDS as readonly string[]).includes(r.author_kind);
    return [
      {
        entry,
        title: formatMemoryTitle(r.body, r.scope, r.kind),
        kindLabel: formatMemoryKind(r.kind),
        source: formatMemorySource(r.author_kind, r.provenance),
        proposedBy: formatMemoryProposedBy(r.author_kind, r.provenance),
        evidence: memoryText(r.provenance.evidence),
        age: formatMemoryAge(r.created_at, now),
        openState: !gated ? 'not_required' : r.opened ? 'opened' : 'unopened',
        scopeLabel: groupLabel(r).label,
      },
    ];
  });
  return { cards, truncated };
}

export interface MemoryPendingCounts {
  /** Proposed entries per requested repo id: a number for each, 0 when none. */
  repos: Record<string, number>;
  items: Record<string, number>;
}

/**
 * The numbers for the badges on a repo header and an item: how many proposals each has waiting (the `proposed` rows, so a decision lowers it). Asks
 * for the ids the screen shows, at most 200 of each, and answers a number for every one of them.
 */
export async function memoryPendingCounts(ctx: ReadCtx, input: { repoIds?: readonly string[]; itemIds?: readonly string[] }): Promise<MemoryPendingCounts> {
  const repoIds = [...new Set((input.repoIds ?? []).map((i) => i.toLowerCase()))];
  const itemIds = [...new Set((input.itemIds ?? []).map((i) => i.toLowerCase()))];
  if (repoIds.length > UUID_LIST_MAX || itemIds.length > UUID_LIST_MAX) throw new MemoryInputError('invalid_message', `at most ${UUID_LIST_MAX} ids can be counted at once`);
  for (const id of repoIds) assertUuid('repo', id);
  for (const id of itemIds) assertUuid('item', id);
  const out: MemoryPendingCounts = { repos: {}, items: {} };
  for (const id of repoIds) out.repos[id] = 0;
  for (const id of itemIds) out.items[id] = 0;
  if (repoIds.length === 0 && itemIds.length === 0) return out;
  return inSession(ctx, async (client) => {
    if (repoIds.length > 0) {
      const { rows } = await client.query<{ id: string; n: number }>(
        `SELECT r.id::text AS id, count(m.id)::int AS n
           FROM repos r JOIN installations i ON i.account_id = r.account_id AND i.id = r.installation_id
           JOIN memory_entries m ON m.account_id = r.account_id AND m.scope = 'repo' AND m.status = 'proposed' AND m.scope_ref = r.gh_node_id || '@' || i.gh_installation_id::text
          WHERE r.id = ANY($1::uuid[]) AND r.gh_node_id IS NOT NULL
          GROUP BY r.id`,
        [repoIds],
      );
      for (const r of rows) out.repos[r.id] = r.n;
    }
    if (itemIds.length > 0) {
      const { rows } = await client.query<{ id: string; n: number }>(
        `SELECT m.scope_ref AS id, count(*)::int AS n FROM memory_entries m
          WHERE m.scope = 'item' AND m.status = 'proposed' AND m.scope_ref = ANY($1::text[]) GROUP BY m.scope_ref`,
        [itemIds],
      );
      for (const r of rows) out.items[r.id] = r.n;
    }
    return out;
  });
}

/** Where "Change scope" moves an entry, named by the ids the app holds. The memory key is derived here, never taken from the caller. */
export interface MemoryMoveTarget {
  scope: MemoryScope;
  repoId?: string;
  itemId?: string;
  role?: string;
}

/**
 * The `scope_ref` for a move: null for the account, the repo's node id plus installation for a repo, the work item id for an item, the name for
 * a role. A repo with no stored node id has no key, so it is refused (`invalid_message`) instead of falling back to another one. Whether the item
 * exists, and whether the caller may write there, is the edit definer's check, not this one's.
 */
export async function memoryMoveRef(ctx: ReadCtx, target: MemoryMoveTarget): Promise<string | null> {
  assertEnumScope(target.scope);
  const named = [target.repoId, target.itemId, target.role].filter((v) => v !== undefined).length;
  const need = target.scope === 'account' ? 0 : 1;
  const right = target.scope === 'repo' ? target.repoId : target.scope === 'item' ? target.itemId : target.scope === 'role' ? target.role : undefined;
  if (named !== need || (need === 1 && right === undefined)) throw new MemoryInputError('invalid_message', 'name exactly the place the entry moves to');
  if (target.scope === 'account') return null;
  if (target.scope === 'role') return target.role!;
  if (target.scope === 'item') {
    assertUuid('item', target.itemId!);
    return target.itemId!.toLowerCase();
  }
  const ref = await inSession(ctx, (client) => repoScopeRefOf(client, target.repoId!));
  if (ref === null) throw new MemoryInputError('invalid_message', 'that repository has no memory key yet');
  return ref;
}

function assertEnumScope(scope: unknown): void {
  if (typeof scope !== 'string' || !(MEMORY_SCOPES as readonly string[]).includes(scope)) throw new MemoryInputError('invalid_message', 'unknown scope');
}
