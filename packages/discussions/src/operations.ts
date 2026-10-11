import { ForbiddenError, NotFoundError } from "@fx/core/src/tenancy/errors.js";
import { ownField, type Principal } from "./principals.js";

/**
 * Conventions, "Operation table" -- every operation the epic defines, in
 * the Conventions' own order. `stage.set` is split into two rows here
 * (`stage.set` / `stage.set.human_only`) because the Conventions give it
 * two different rows depending on whether the target transition is one of
 * HT-1 to HT-5 -- the caller (stages.ts, DS-2 PR-b) picks which key to
 * check per transition. `mirror.configure` is declared for completeness
 * (the table must match cell for cell) though nothing in this PR or PR-b
 * calls it; DS-6 owns its business logic.
 */
export type Operation =
  | "read"
  | "discussion.create"
  | "discussion.revise"
  | "comment.post"
  | "comment.post_agent"
  | "comment.edit_own"
  | "comment.tombstone_any"
  | "spec.publish"
  | "spec.correct"
  | "stage.set"
  | "stage.set.human_only"
  | "deps.add"
  | "deps.remove"
  | "visibility.set"
  | "security.set"
  | "security.clear"
  | "mirror.configure";

/**
 * A cell's meaning: 'allow' -- any row in the tenant. 'own' -- only a row
 * the principal authored/owns (the calling function, which alone has the
 * row, checks this). 'thread_only' (run) -- the run's own work item's
 * thread (and, for `read`, its parent chain and deps). 'internal_only'
 * (system, spec.publish and spec.correct) -- refused for a work item whose
 * effective provenance is external. 'creation_default_only' (system, visibility.set) -- only a
 * repo's creation-time default, never an arbitrary change (checked by
 * DS-6). 'deny' -- `assertAllowed` throws `ForbiddenError`, no row written.
 */
export type Access = "allow" | "own" | "thread_only" | "internal_only" | "creation_default_only" | "deny";

/** [sessionOwnerAdmin, sessionMember, token, tokenScope, run, system].
 * `tokenScope` is the scope a token must hold for `token` to apply at all
 * (`null` when `token` is already 'deny' regardless of scope). */
export type OperationRule = readonly [Access, Access, Access, "read" | "write" | null, Access, Access];

export const OPERATION_TABLE: Readonly<Record<Operation, OperationRule>> = Object.freeze({
  read: ["allow", "allow", "allow", "read", "thread_only", "allow"],
  "discussion.create": ["allow", "allow", "allow", "write", "deny", "allow"],
  "discussion.revise": ["allow", "own", "own", "write", "deny", "allow"],
  "comment.post": ["allow", "allow", "allow", "write", "thread_only", "allow"],
  "comment.post_agent": ["deny", "deny", "deny", null, "deny", "allow"],
  "comment.edit_own": ["own", "own", "own", "write", "deny", "deny"],
  "comment.tombstone_any": ["allow", "deny", "deny", null, "deny", "deny"],
  "spec.publish": ["allow", "deny", "deny", null, "deny", "internal_only"],
  "spec.correct": ["allow", "deny", "deny", null, "deny", "internal_only"],
  "stage.set": ["allow", "deny", "deny", null, "deny", "allow"],
  "stage.set.human_only": ["allow", "deny", "deny", null, "deny", "deny"],
  "deps.add": ["allow", "deny", "deny", null, "deny", "allow"],
  "deps.remove": ["allow", "deny", "deny", null, "deny", "allow"],
  "visibility.set": ["allow", "deny", "deny", null, "deny", "creation_default_only"],
  "security.set": ["allow", "allow", "allow", "write", "deny", "allow"],
  "security.clear": ["allow", "deny", "deny", null, "deny", "deny"],
  "mirror.configure": ["allow", "deny", "deny", null, "deny", "deny"],
});

/** The table cell for `principal`'s kind/role on `operation`, folding in
 * the token scope check. Never touches the database -- this is the pure,
 * table-driven gate criterion 1 tests independently. */
export function authorize(principal: Principal, operation: Operation): Access {
  const [ownerAdmin, member, token, tokenScope, run, system] = OPERATION_TABLE[operation];
  // Every discriminating field is read as an OWN property only, so an
  // inherited (prototype-polluted) kind/role/scopes falls to deny.
  switch (ownField(principal, "kind")) {
    case "session": {
      // Strict === against the three real roles: no case folding, trimming
      // or coercion. Any other value (a typo, "viewer", undefined, a boxed
      // string) gets no access, the same fail-closed rule as the kind below.
      const role = ownField(principal, "role");
      if (role === "owner" || role === "admin") return ownerAdmin;
      if (role === "member") return member;
      return "deny";
    }
    case "token":
      if (token === "deny") return "deny";
      if (tokenScope !== null) {
        const scopes = ownField(principal, "scopes");
        if (!Array.isArray(scopes) || !scopes.includes(tokenScope)) return "deny";
      }
      return token;
    case "run":
      return run;
    case "system":
      return system;
    default:
      // Fail closed: a kind this table does not know (a typo, a wrong case,
      // a missing or non-string field) gets no access at all.
      return "deny";
  }
}

const ACCESS_VALUES: readonly string[] = ["allow", "own", "thread_only", "internal_only", "creation_default_only"];

/** Throws `ForbiddenError` (route/tool layers map this to HTTP 403) when
 * the table denies `operation` outright. Returns the (non-'deny') access
 * qualifier otherwise, so the caller applies its own row-level check for
 * 'own' / 'thread_only' / 'internal_only' / 'creation_default_only'. */
export function assertAllowed(principal: Principal, operation: Operation): Exclude<Access, "deny"> {
  const access = authorize(principal, operation);
  // Fail closed: anything other than an explicit non-deny access value
  // (including undefined) is a refusal.
  if (typeof access !== "string" || !ACCESS_VALUES.includes(access)) {
    throw new ForbiddenError(`principal kind "${String(ownField(principal, "kind"))}" may not perform "${operation}"`);
  }
  return access as Exclude<Access, "deny">;
}

/** DS-2's own refusal codes, beyond @fx/core's `NotFoundError` ("Not
 * found is uniform") and `ForbiddenError` (the gate above). A route/tool
 * layer (DS-3, DS-4) maps each to the HTTP status the Spec gives it. */
export type DiscussionsErrorCode =
  | "invalid_input" // 400/422
  | "payload_too_large" // 413
  | "quota_exceeded" // 429
  | "storage_quota_exceeded" // 413
  | "spec_frozen" // 409 (DS-2 PR-b)
  | "external_requires_human" // 403 (DS-2 PR-b)
  | "no_spec_version" // 404-ish, DS-2 PR-b
  | "dependency_cycle" // 409 (DS-2 PR-b)
  | "invalid_file_scope" // 422 (D#6 R4d-5a, C34): a Spec was offered without a readable list of the files it allows
  | "spec_has_file_list" // 409 (D#6 R4d-5b, C34): a Re-spec of a Spec whose newest version already has a readable file list
  | "spec_changed" // 409 (D#6 R4d-5b): the Spec's newest version is not the one a Re-spec was made from
  | "correction_not_accepted" // 409 (D#597 CC-2b): an amendment's correction was rejected or already delivered before the version was written
  | "kind_not_buildable" // 409 (D#2 H27a): a question or project never starts a build
  | "illegal_transition"; // 409 (DS-2 PR-b): not one of D#45 S1's legal stage edges

export class DiscussionsError extends Error {
  constructor(
    public readonly code: DiscussionsErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "DiscussionsError";
  }
}

/** Criterion 3: an input carrying `account_id`/`accountId` is refused
 * with `invalid_input` before any query -- called first by every
 * exported write function. */
export function rejectAccountIdInInput(input: Record<string, unknown>): void {
  if (Object.hasOwn(input, "account_id") || Object.hasOwn(input, "accountId")) {
    throw new DiscussionsError("invalid_input", "input must not carry account_id or accountId");
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Not found is uniform": a malformed id reads as a missing row (404),
 * never as a database error that would tell the caller which shape was
 * wrong. Called before any query that takes the id. */
export function assertUuidOrNotFound(id: unknown, what: string): string {
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    throw new NotFoundError(`${what} not found: ${String(id)}`);
  }
  return id;
}
