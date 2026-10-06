import type { Role } from "./types.js";

/**
 * D#2 H09 pass/fail 6: "`persistent: false` for every role except
 * executor, whose sandbox is named `ex-{repoId}-{pr}` with
 * `keepLastSnapshots: 1` and is deleted on the `pr.closed` / `pr.merged`
 * event."
 *
 * Consensus Summary "Resolved disagreements" item 2: "Sandbox persistence
 * is off for every role except the executor's per-PR sandbox, which needs
 * it to resume; a snapshot may hold the repo and session file, never a
 * credential." `buildSandboxEnv` (sandboxEnv.ts) is what keeps a
 * credential out of that snapshot -- this module only decides the
 * name/persistence/retention policy, not what goes in the env.
 */
export const EXECUTOR_ROLE = "executor";
export const EXECUTOR_KEEP_LAST_SNAPSHOTS = 1;

/** True only for the executor role -- every other role's sandbox is
 * ephemeral (Spec pass/fail 6). */
export function isPersistentRole(role: Role): boolean {
  return role === EXECUTOR_ROLE;
}

export interface SandboxNamingParams {
  role: Role;
  runId: string;
  /** Required, and only meaningful, for the executor role. PR #85 fix
   * round 3, must-fix 2 (CWE-639/706/200): the name-uniqueness input,
   * not just a display field -- see the header comment on
   * `EXECUTOR_SANDBOX_PREFIX`'s usage below for why `repoId` alone is
   * not enough. Must be the caller's `accounts.id` UUID. */
  accountId?: string;
  /** Required, and only meaningful, for the executor role. Must be the
   * `repos.id` UUID -- never a GitHub repo id (`repos.gh_repo_id`), which
   * `packages/db/migrations/0001_core.sql` does not constrain UNIQUE, so
   * two tenant accounts can hold the same GitHub repo id (H09 security
   * review, "must fix" 2). */
  repoId?: string;
  pr?: number;
}

/** `repos.id`'s shape: a standard UUID, lower case only -- no `/i` flag.
 * Postgres always returns a `uuid` column's text form in lower case, so
 * that is the only canonical spelling a real `repoId` ever has. Accepting
 * the upper-case form too (H09 security re-review, "should fix" 2) would
 * let the same row map to two different sandbox names (`123E4567-...`
 * and `123e4567-...` build different strings below), and an upper-case
 * name would be missed by the `pr.closed`/`pr.merged` delete path and the
 * fix-round resume lookup, which both look the row up by its canonical
 * lower-case id. Rejecting rather than lower-casing the input keeps
 * `sandboxNameFor` injective without adding a normalization step a caller
 * could forget to also apply on the lookup side. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Every executor sandbox name starts with this prefix; every non-executor
 * name starts with `NON_EXECUTOR_SANDBOX_PREFIX` instead (see below) --
 * the two prefixes are disjoint strings, so no (role, runId) pair can ever
 * collide with an executor name, regardless of what a caller passes for
 * either (H09 security review, "must fix" 2, "role \"ex\"" collision). */
const EXECUTOR_SANDBOX_PREFIX = "ex-";
const NON_EXECUTOR_SANDBOX_PREFIX = "rn-";

function assertValidUuidField(value: string, field: "accountId" | "repoId"): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`sandboxNameFor: ${field} must be a UUID, got ${JSON.stringify(value)}`);
  }
}

function assertValidPr(pr: number): void {
  if (!Number.isSafeInteger(pr) || pr <= 0) {
    // String(), not JSON.stringify(): a bigint `pr` (a hostile caller
    // ignoring the `number` type) makes JSON.stringify throw its own
    // uncaught TypeError before this function's intended error is ever
    // thrown (H09 security re-review, "suggestion" 5). String() renders
    // every primitive without throwing, so the caller always gets the
    // typed, informative error this function means to raise.
    throw new Error(`sandboxNameFor: pr must be a positive safe integer, got ${String(pr)}`);
  }
}

/**
 * The executor's sandbox name is `ex-{accountId}-{repoId}-{pr}` -- stable
 * across a Feature's fix rounds, which is exactly what lets
 * `resumeAgentRun` (H09b) find the same sandbox again by name. `accountId`
 * and `repoId` are each validated as a UUID and `pr` as a positive safe
 * integer, all three with a fixed, unambiguous format, so this name is
 * injective: no two distinct valid (accountId, repoId, pr) triples
 * produce the same string (H09 security review, "must fix" 2's
 * `("x-5-", 6)` / `("x-5", -6)` collision, which relied on both fields
 * accepting arbitrary shapes, is closed by that validation; a fixed
 * 36-character canonical UUID has no internal "-{n}" suffix ambiguity
 * either, so concatenating three fixed-shape fields with "-" between them
 * can never let one field's content be misread as spanning into the
 * next).
 *
 * PR #85 fix round 3, must-fix 2 (CWE-639/706/200): before this,
 * `repoId` alone named the sandbox (`ex-{repoId}-{pr}`). The INSERT-time
 * same-tenant trigger (0605_execution_mode.sql) only checks that
 * `dispatch_repo_id` names a `repos` row in the CALLER's own account AT
 * THE MOMENT OF INSERT -- it says nothing about which account created
 * that `repos.id` UUID in the first place, or whether it's still the
 * same account a moment later. `repos.id` is a plain, caller-choosable
 * UUID with no uniqueness constraint across accounts and no protection
 * against reuse after a delete: tenant B can dispatch an executor run
 * against `repos.id = X`, delete that repo, and tenant A can then insert
 * its OWN `repos` row with `id = X` (accepted -- nothing stops a caller
 * from choosing a UUID that used to belong to someone else). Before this
 * fix, A's later executor run against the SAME `(X, pr)` pair produced
 * the IDENTICAL sandbox name B's still-live persistent sandbox uses --
 * on a provider where the name is the resume identity, A could land in
 * or stop B's sandbox, session and checkout. Putting the account in the
 * name closes this: two different accounts' repo rows, even sharing the
 * exact same (reused) `repos.id` and PR number, now always produce
 * different sandbox names, because `accountId` is itself part of the
 * injective triple above. No provider name-length limit is assumed here
 * (no production `SandboxPort` implementation exists in this package
 * yet -- see sandboxPort.ts's own header); if one is added later and
 * proves too short for two 36-character UUIDs plus the PR digits (up to
 * ~87 characters total), a stable hash of the same triple is the
 * documented fallback, not a length-motivated reason to drop `accountId`
 * again.
 *
 * Every other role gets a runId-scoped name in a prefix disjoint from the
 * executor's -- there is no resume path for a non-executor role in H09's
 * pass/fail items, so a fresh name per run is correct and simpler. The
 * name also length-prefixes `role` (`rn-{role.length}-{role}-{runId}`)
 * so two different (role, runId) pairs can never collide with each other
 * either: the embedded length fixes exactly where `role` ends, regardless
 * of what characters either field contains.
 */
export function sandboxNameFor(params: SandboxNamingParams): string {
  if (isPersistentRole(params.role)) {
    if (!params.accountId || !params.repoId || params.pr === undefined) {
      throw new Error(
        `sandboxNameFor: executor role requires accountId, repoId and pr (got accountId=${String(params.accountId)}, repoId=${String(params.repoId)}, pr=${String(params.pr)})`,
      );
    }
    assertValidUuidField(params.accountId, "accountId");
    assertValidUuidField(params.repoId, "repoId");
    assertValidPr(params.pr);
    return `${EXECUTOR_SANDBOX_PREFIX}${params.accountId}-${params.repoId}-${params.pr}`;
  }
  return `${NON_EXECUTOR_SANDBOX_PREFIX}${params.role.length}-${params.role}-${params.runId}`;
}

export interface SandboxRetentionPolicy {
  persistent: boolean;
  /** Only set (to `EXECUTOR_KEEP_LAST_SNAPSHOTS`) when `persistent` is
   * true -- a non-persistent sandbox keeps no snapshot at all. */
  keepLastSnapshots?: number;
}

export function retentionPolicyFor(role: Role): SandboxRetentionPolicy {
  if (isPersistentRole(role)) {
    return { persistent: true, keepLastSnapshots: EXECUTOR_KEEP_LAST_SNAPSHOTS };
  }
  return { persistent: false };
}

/** The two GitHub events that must delete an executor's persistent
 * sandbox (Spec pass/fail 6). Exported as a literal union so a caller
 * (H09b's webhook route, not built yet) gets a compile-time check that it
 * handles exactly these two events, not a free-form string. */
export type PrLifecycleEvent = "pr.closed" | "pr.merged";

export const PR_EVENTS_THAT_DELETE_SANDBOX: readonly PrLifecycleEvent[] = Object.freeze([
  "pr.closed",
  "pr.merged",
]);
