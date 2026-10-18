import type { PoolClient } from 'pg';
import { NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';
import { CONTEXT_TRIMMED_REASONS, type ContextTrimmedReason } from '@fulcrumaxe/runner-protocol';
import type { RunsReadCtx } from './read.js';

/**
 * D#600 CX-8: what one run loaded into its context, read from the run's ledger row (`run_context_ledger`, migration 0792) for the Runs
 * app's context panel. Read only, member, tenant scoped: the app_user policy on the ledger and on `agent_runs` already hides another
 * account's rows, so another account's run is a plain 404 here.
 *
 * Integers and closed enums only (the section hashes are not returned). The ledger stores no prompt text and no path, and this reader adds none: a run that
 * ran on the person's machine reaches the cloud as sizes and counts, and is returned as the same ("Contents stayed on your machine"). The one
 * addition is the memory the CLOUD handed that run in its job (D#601 MEM-3b): its entries are the cloud's own rows, so they are listed by name
 * and id@version like any run's. Nothing the machine holds (a path, the repo map's identity) is returned for it.
 *
 * A figure the run did not measure is null ("Not recorded" on screen), never 0. A run with no ledger row at all is `recorded: false`
 * with empty lists: a run that predates the ledger, a runner older than the protocol addition, or a run still going.
 */

export interface RunContextSection {
  code: string;
  bytes: number;
  trimmed_bytes: number;
  /** Why the section was cut (D#600 CX-4a); absent on a section that was not. The panel shows words, never null. */
  trimmed_reason?: ContextTrimmedReason;
}

export interface RunContextPanel {
  run_id: string;
  runtime: string;
  status: string;
  /** False when the run has no ledger row (every figure below is then absent). */
  recorded: boolean;
  /** `measured`: per-turn usage was seen. `partial`: anything less (a gateway run, an older runner, a stream with no usage). Null when not recorded. */
  basis: 'measured' | 'partial' | null;
  sections: RunContextSection[];
  first_turn_input_tokens: number | null;
  peak_context_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  memory_tokens: number | null;
  tool_output: { tool: string; bytes: number }[];
  compactions: number | null;
  /**
   * The memory entries the run's prompt held, in prompt order, by display name and id@version (D#601; recorded when the build starts, migration
   * 0833). The name is derived from the entry's row now, never stored: a deleted entry reads "Deleted entry". Empty for a run that recalled nothing,
   * for a run that predates the record. A run on the person's machine lists the memory its job carried, the same way (D#601 MEM-3b).
   */
  recalled_memory: { id: string; name: string; version: number }[];
  /**
   * The repo map the run's prompt held (CX-3a), as `v<format version> · <first 12 of the sha256 of the raw map text>` (R-600-CX3b-1: the raw-text
   * hash is the map's identity). Null when the run carried no map or predates the record, and always for a run on the person's machine.
   */
  repo_map_version: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Row {
  id: string;
  runtime: string;
  status: string;
  has_ledger: boolean;
  basis: string | null;
  sections: unknown;
  first_turn_input_tokens: string | null;
  peak_context_tokens: string | null;
  cache_read_tokens: string | null;
  cache_write_tokens: string | null;
  memory_tokens: string | null;
  tool_output_bytes: unknown;
  compactions: number | null;
  recalled_ids: string[] | null;
  recalled_versions: number[] | null;
  map_version: string | null;
  map_sha256: string | null;
}

interface EntryRow {
  id: string;
  status: string | null;
  scope: string | null;
  kind: string | null;
  body: string | null;
}

/** The longest display name of a recalled entry, as the prompt's own label cuts it. */
const NAME_MAX = 60;
const DELETED_NAME = 'Deleted entry';

/** An entry's display name: the first line of its text with spaces folded, as the prompt names it; its scope and kind when the text has no first line. */
function entryName(e: EntryRow): string {
  // A deleted entry, a purged one and an id this account cannot see are ONE label: the panel is no oracle for another tenant's ids.
  if (e.status === 'deleted' || e.body === null) return DELETED_NAME;
  const first = e.body.split('\n', 1)[0]!.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return first !== '' ? first : `${e.scope ?? 'memory'}/${e.kind ?? 'entry'}`;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);

export async function getRunContext(ctx: RunsReadCtx, id: string): Promise<RunContextPanel> {
  if (!UUID_RE.test(id)) throw new NotFoundError(`run ${id} not found`);
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    // The account filter is explicit on every table read here, as defence in depth on top of the forced row security.
    const r = (
      await client.query<Row>(
        `SELECT r.id, r.runtime, r.status, (l.run_id IS NOT NULL) AS has_ledger, l.basis, l.sections,
                l.first_turn_input_tokens, l.peak_context_tokens, l.cache_read_tokens, l.cache_write_tokens, l.memory_tokens,
                l.tool_output_bytes, l.compactions,
                i.recalled_entry_ids AS recalled_ids, i.recalled_entry_versions AS recalled_versions, i.map_version, i.map_sha256
           FROM agent_runs r
           LEFT JOIN run_context_ledger l ON l.account_id = r.account_id AND l.run_id = r.id
           LEFT JOIN run_context_inputs i ON i.account_id = r.account_id AND i.run_id = r.id
          WHERE r.id = $1::uuid AND r.account_id = $2::uuid`,
        [id, accountId],
      )
    ).rows[0];
    if (!r) throw new NotFoundError(`run ${id} not found`);

    const base = { run_id: r.id, runtime: r.runtime, status: r.status };
    if (!r.has_ledger || (r.basis !== 'measured' && r.basis !== 'partial')) {
      return {
        ...base,
        recorded: false,
        basis: null,
        sections: [],
        first_turn_input_tokens: null,
        peak_context_tokens: null,
        cache_read_tokens: null,
        cache_write_tokens: null,
        memory_tokens: null,
        tool_output: [],
        compactions: null,
        recalled_memory: [],
        repo_map_version: null,
      };
    }

    // The definer wrote these through a closed enum and range check; they are re-shaped here so a hand-edited row cannot reach the screen.
    const sections: RunContextSection[] = (Array.isArray(r.sections) ? r.sections : [])
      .filter(isRecord)
      .filter((s) => typeof s.code === 'string')
      .slice(0, 64)
      .map((s): RunContextSection => ({
        code: s.code as string,
        bytes: count(s.bytes),
        trimmed_bytes: count(s.trimmed_bytes),
        ...(CONTEXT_TRIMMED_REASONS.includes(s.trimmed_reason as ContextTrimmedReason) ? { trimmed_reason: s.trimmed_reason as ContextTrimmedReason } : {}),
      }));
    const tool_output = Object.entries(isRecord(r.tool_output_bytes) ? r.tool_output_bytes : {})
      .map(([tool, bytes]) => ({ tool, bytes: count(bytes) }))
      .sort((a, b) => b.bytes - a.bytes || a.tool.localeCompare(b.tool))
      .slice(0, 32);
    // A run on the person's machine is sizes and counts only, with one exception that is the cloud's own data: the memory entries its job carried (D#601 MEM-3b),
    // named from the cloud's rows. Its map identity is not returned, whatever the tables hold: the runner reads the map on the machine.
    const hosted = r.runtime !== 'runner';
    const recalled_memory = await recalledMemoryOf(client, accountId, r.recalled_ids, r.recalled_versions);
    const repo_map_version = hosted && r.map_version !== null && r.map_sha256 !== null ? `v${r.map_version} · ${r.map_sha256.slice(0, 12)}` : null;
    return {
      ...base,
      recorded: true,
      basis: r.basis,
      sections,
      first_turn_input_tokens: num(r.first_turn_input_tokens),
      peak_context_tokens: num(r.peak_context_tokens),
      cache_read_tokens: num(r.cache_read_tokens),
      cache_write_tokens: num(r.cache_write_tokens),
      memory_tokens: num(r.memory_tokens),
      tool_output,
      compactions: r.compactions,
      recalled_memory,
      repo_map_version,
    };
  });
}

/** The recorded entries in prompt order, each named from its row as it stands now (see `entryName`). */
async function recalledMemoryOf(client: PoolClient, accountId: string, ids: string[] | null, versions: number[] | null): Promise<RunContextPanel['recalled_memory']> {
  if (!ids || !versions || ids.length === 0 || ids.length !== versions.length) return [];
  const capped = ids.slice(0, 50);
  const rows = (
    await client.query<EntryRow>(`SELECT id, status, scope, kind, body FROM memory_entries WHERE account_id = $1::uuid AND id = ANY($2::uuid[])`, [accountId, capped])
  ).rows;
  const byId = new Map(rows.map((e) => [e.id, e]));
  return capped.map((id, i) => ({ id, name: entryName(byId.get(id) ?? { id, status: null, scope: null, kind: null, body: null }), version: Math.max(1, Math.trunc(versions[i] ?? 1)) }));
}
