/**
 * D#2 H09 pass/fail 5 (key failure mid-run) calls "H21's markBroken for
 * 401/403" -- but H21 (`packages/model-connection/**`, currently HOLD per
 * D#31 item on D#2's hold comment) is not built yet. This is the narrow
 * interface H09b's key-failure handling will call; H21 is expected to
 * implement it against a real `model_connections` row update when it
 * ships.
 *
 * Deliberately NOT named `ModelConnectionStatus` -- `@fx/runtime`'s
 * `packages/runtime/src/types.ts` already exports a type with that exact
 * name (the READ-side status union: `"ok" | "unvalidated" | "broken" |
 * "unknown"`). `ConnectionStatusPort` is the WRITE side -- a distinct
 * concern -- and reusing the same name across two packages for two
 * different things would be exactly the kind of name collision a reviewer
 * has to untangle by hand.
 *
 * `code` is narrowed to the two values the Spec actually calls markBroken
 * for (401/403 -- 402/`quota_for_entity_exceeded` is a budget problem, not
 * a broken credential, so it must never call this).
 */
export type BrokenConnectionCode = 401 | 403;

export interface ConnectionStatusPort {
  /** Marks broken the model connection for the tenant account that owns
   * `runId`. Takes a run id, never a bare account id (H09 security
   * review, "should fix" 5): account-status writes run with elevated
   * rights, not under tenant row-level security, so if the caller's
   * account id argument were the only thing choosing which tenant gets
   * marked broken, nothing would tie that write to the run that actually
   * saw the 401/403. The real H21 implementation looks up the owning
   * account server-side from `runId` (e.g. `agent_runs.account_id`) --
   * the caller only ever controls which run failed, never which account
   * gets written. */
  markBroken(runId: string, code: BrokenConnectionCode): Promise<void>;
}

export interface RecordedMarkBrokenCall {
  runId: string;
  code: BrokenConnectionCode;
}

/** Test double for `ConnectionStatusPort`. Records every call instead of
 * writing anywhere -- H09a has no dependency on H21's (not-yet-built)
 * storage, and H09b's own tests (not in this PR) will use this same
 * double until H21 ships a real implementation. */
export function createTestConnectionStatusPort(): ConnectionStatusPort & {
  readonly calls: readonly RecordedMarkBrokenCall[];
} {
  const calls: RecordedMarkBrokenCall[] = [];
  return {
    calls,
    async markBroken(runId, code) {
      calls.push({ runId, code });
    },
  };
}
