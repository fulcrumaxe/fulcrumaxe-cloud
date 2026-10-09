import { parseAcceptanceScope, type AcceptanceScope } from "@fx/core/src/specs/acceptanceScope.js";

// The pure parser and matcher live in @fx/core (D#6 R4d-5a, C34 section 1.4): one copy, shared with the Spec store and the Spec writer.
export { MAX_ENTRY_PATTERNS, MAX_SCOPE_ENTRIES, MAX_SCOPE_PATTERNS, parseAcceptanceScope, pathInScope, pathsOutsideScope, type AcceptanceScope } from "@fx/core/src/specs/acceptanceScope.js";

const UNREADABLE: AcceptanceScope = Object.freeze({ kind: "unknown", reason: "unreadable" });
const ABSENT: AcceptanceScope = Object.freeze({ kind: "unknown", reason: "absent" });

/** The query a loader needs, run under the run's tenant (a `pg` client or pool client fits). */
export interface TenantQueryable {
  query<R extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * Reads the scope for a run. `client` must be under the run's tenant (row-level security does the rest); the account is also in
 * the WHERE clause. A run with no spec version, a spec version that was erased, a missing row, and a value that does not parse
 * answer `unknown` (reason `unreadable`, except an absent or empty list: `absent`).
 */
export async function loadAcceptanceScope(client: TenantQueryable, run: { accountId: string; runId: string }): Promise<AcceptanceScope> {
  const { rows } = await client.query<{ acceptance_files: unknown }>(
    `SELECT sv.frontmatter -> 'acceptance_files' AS acceptance_files
       FROM agent_runs ar
       JOIN spec_versions sv ON sv.account_id = ar.account_id AND sv.id = ar.spec_version_id AND sv.erased_at IS NULL
      WHERE ar.account_id = $1 AND ar.id = $2`,
    [run.accountId, run.runId],
  );
  if (rows.length !== 1) return UNREADABLE;
  const value = rows[0]!.acceptance_files;
  // C34 section 2.2: no list at all, or an empty one, is "absent" (a Spec published before the list existed). Anything else that does not parse is "unreadable".
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return ABSENT;
  const scope = parseAcceptanceScope(value);
  return scope.kind === "known" ? scope : UNREADABLE;
}
