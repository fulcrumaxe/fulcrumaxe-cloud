import { NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';
import type { RunsReadCtx } from './read.js';

/**
 * D#600 CX-8: what one run loaded into its context, read from the run's ledger row (`run_context_ledger`, migration 0792) for the Runs
 * app's context panel. Read only, member, tenant scoped: the app_user policy on the ledger and on `agent_runs` already hides another
 * account's rows, so another account's run is a plain 404 here.
 *
 * Integers and closed enums only (the section hashes are not returned). The ledger stores no prompt text and no path, and this reader adds none: a run that
 * ran on the person's machine reaches the cloud as sizes and counts, and is returned as the same (its recalled memory names, which the
 * cloud holds, are left out for it: "Contents stayed on your machine").
 *
 * A figure the run did not measure is null ("Not recorded" on screen), never 0. A run with no ledger row at all is `recorded: false`
 * with empty lists: a run that predates the ledger, a runner older than the protocol addition, or a run still going.
 */

export interface RunContextSection {
  code: string;
  bytes: number;
  trimmed_bytes: number;
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
   * The memory entries the run recalled, by display name and id@version (D#601). No run records which entries it recalled yet (the
   * recall record arrives with MEM-3), so this is empty until then; the app draws the list when it is not.
   */
  recalled_memory: { id: string; name: string; version: number }[];
  /** The repo map's version the run's prompt held (CX-3a). Null until a map is recorded. */
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
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);

export async function getRunContext(ctx: RunsReadCtx, id: string): Promise<RunContextPanel> {
  if (!UUID_RE.test(id)) throw new NotFoundError(`run ${id} not found`);
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    const r = (
      await client.query<Row>(
        `SELECT r.id, r.runtime, r.status, (l.run_id IS NOT NULL) AS has_ledger, l.basis, l.sections,
                l.first_turn_input_tokens, l.peak_context_tokens, l.cache_read_tokens, l.cache_write_tokens, l.memory_tokens,
                l.tool_output_bytes, l.compactions
           FROM agent_runs r
           LEFT JOIN run_context_ledger l ON l.account_id = r.account_id AND l.run_id = r.id
          WHERE r.id = $1::uuid`,
        [id],
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
      .map((s) => ({ code: s.code as string, bytes: count(s.bytes), trimmed_bytes: count(s.trimmed_bytes) }));
    const tool_output = Object.entries(isRecord(r.tool_output_bytes) ? r.tool_output_bytes : {})
      .map(([tool, bytes]) => ({ tool, bytes: count(bytes) }))
      .sort((a, b) => b.bytes - a.bytes || a.tool.localeCompare(b.tool))
      .slice(0, 32);
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
      recalled_memory: [],
      repo_map_version: null,
    };
  });
}
