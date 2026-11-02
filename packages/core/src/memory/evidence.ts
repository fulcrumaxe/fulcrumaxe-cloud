import type { PoolClient } from 'pg';
import { MemoryInputError } from './index.js';

/**
 * D#601 MEM-9: the evidence behind an agent-proposed role lesson. A role entry that an agent (or the assistant, or a runner) wrote can be approved
 * only when the runs it cites ran in at least two repositories ("transfers poorly"). The repository of a run is read from the run each time (its
 * work item's repository, else its dispatch repository), never stored, and an edit's new version keeps the evidence of the versions it replaced.
 * A role entry a person wrote needs none. The count is display data for the card and the gate for `assertRoleEvidence`; the database does not repeat it.
 */
export const MEMORY_ROLE_EVIDENCE_MIN_REPOS = 2;
/** The exact words the disabled Approve control and the refusal use. */
export const NEEDS_SECOND_REPO_WORDS = 'Needs evidence from a second repo';
/** Role lessons are approved one at a time. */
export const ROLE_BATCH_REFUSED_WORDS = 'Role lessons are approved one at a time';

/** Distinct repositories behind each entry's runs, over the entry's whole version chain. An entry with no evidence is 0. */
export async function evidenceRepoCounts(client: PoolClient, ids: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  if (ids.length === 0) return out;
  const { rows } = await client.query<{ id: string; repos: number }>(
    `WITH RECURSIVE chain AS (
       SELECT id AS root, id, supersedes_id FROM memory_entries WHERE id = ANY($1::uuid[])
       UNION ALL
       SELECT c.root, m.id, m.supersedes_id FROM memory_entries m JOIN chain c ON m.id = c.supersedes_id
     )
     SELECT c.root::text AS id, count(DISTINCT COALESCE(w.repo_id, ar.dispatch_repo_id))::int AS repos
       FROM chain c
       JOIN memory_entry_evidence ev ON ev.entry_id = c.id
       JOIN agent_runs ar ON ar.account_id = ev.account_id AND ar.id = ev.run_id
       LEFT JOIN work_items w ON w.account_id = ar.account_id AND w.id = ar.work_item_id
      GROUP BY c.root`,
    [ids],
  );
  for (const r of rows) out[r.id] = r.repos;
  return out;
}

/** Refuses (`needs_second_repo`) an approval of an agent-written role entry with fewer than two repositories of evidence. Other entries pass. */
export async function assertRoleEvidence(client: PoolClient, ids: readonly string[]): Promise<void> {
  const { rows } = await client.query<{ id: string }>(`SELECT id FROM memory_entries WHERE id = ANY($1::uuid[]) AND scope = 'role' AND author_kind <> 'person'`, [ids]);
  const counts = await evidenceRepoCounts(client, rows.map((r) => r.id));
  if (Object.values(counts).some((n) => n < MEMORY_ROLE_EVIDENCE_MIN_REPOS)) throw new MemoryInputError('needs_second_repo', NEEDS_SECOND_REPO_WORDS);
}

/** The most live entries one role may hold (MEM-9). The intake, approve, renew and a move into role scope all use `assertRoleRoom`. */
export const MEMORY_ROLE_MAX_ENTRIES = 16;
export const ROLE_FULL_WORDS = `A role holds at most ${MEMORY_ROLE_MAX_ENTRIES} lessons. Retire one first`;

/**
 * Refuses (`memory_full`) when `adding` more entries would take the role `ref` past 16. "Live" is approved, plus (for a step that makes an entry pending)
 * the unexpired pending ones; `except` are the entries being moved, so they never count against themselves.
 */
export async function assertRoleRoom(client: PoolClient, ref: string, adding: number, to: 'approved' | 'proposed', except: readonly string[] = []): Promise<void> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM memory_entries
      WHERE scope = 'role' AND scope_ref = $1 AND id <> ALL($2::uuid[]) AND (status = 'approved' OR ($3 = 'proposed' AND status = 'proposed' AND expires_at > now()))`,
    [ref, [...except], to],
  );
  if (rows[0]!.n + adding > MEMORY_ROLE_MAX_ENTRIES) throw new MemoryInputError('memory_full', ROLE_FULL_WORDS);
}

/** The room check for a status step on these entries (an agent-written role entry only; a person's own write keeps its own cap). */
export async function assertRoleRoomForStep(client: PoolClient, ids: readonly string[], to: string): Promise<void> {
  if (to !== 'approved' && to !== 'proposed') return;
  const { rows } = await client.query<{ scope_ref: string; n: number }>(
    `SELECT scope_ref, count(*)::int AS n FROM memory_entries WHERE id = ANY($1::uuid[]) AND scope = 'role' AND author_kind <> 'person' GROUP BY scope_ref`,
    [ids],
  );
  for (const r of rows) await assertRoleRoom(client, r.scope_ref, r.n, to, ids);
}

/** A move INTO role scope, or from one role to another, of an approved agent-written entry passes the same evidence and room checks as an approval. */
export async function assertRoleMove(client: PoolClient, id: string, ref: string | null): Promise<void> {
  const { rows } = await client.query<{ scope: string; scope_ref: string | null; author_kind: string; status: string }>(`SELECT scope, scope_ref, author_kind, status FROM memory_entries WHERE id = $1::uuid`, [id]);
  const e = rows[0];
  // A pending entry that moves is still gated at its approval (the chain keeps its evidence); an approved one would skip that gate, so it is checked here.
  if (e === undefined || (e.scope === 'role' && e.scope_ref === ref) || e.author_kind === 'person' || e.status !== 'approved') return;
  if ((await evidenceRepoCounts(client, [id]))[id]! < MEMORY_ROLE_EVIDENCE_MIN_REPOS) throw new MemoryInputError('needs_second_repo', NEEDS_SECOND_REPO_WORDS);
  if (ref !== null) await assertRoleRoom(client, ref, 1, 'approved');
}

/** Refuses (`role_batch_refused`) a batch that holds a role entry. */
export async function assertNoRoleInBatch(client: PoolClient, ids: readonly string[]): Promise<void> {
  const { rowCount } = await client.query(`SELECT 1 FROM memory_entries WHERE id = ANY($1::uuid[]) AND scope = 'role' LIMIT 1`, [ids]);
  if (rowCount !== 0) throw new MemoryInputError('role_batch_refused', ROLE_BATCH_REFUSED_WORDS);
}
