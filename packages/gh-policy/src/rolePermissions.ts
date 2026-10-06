import type { PermissionLevel, PermissionName } from "./types.js";

/**
 * The per-role minimum GitHub App permission table for the `team` product.
 *
 * This is what gets minted into a role's installation token for the whole
 * run (H13 criterion 3: "mints or caches a per-role, one-repo installation
 * token"), not recomputed per call. `decide()` enforces the actual
 * request-by-request restrictions (no merges, pushes scoped to each role's
 * own `fx/*` sub-prefix, reviewer roles can't write contents, ...)
 * independently of this table, so widening a role here never on its own
 * grants a call that the decision rules would otherwise deny — but it IS
 * the ceiling the token carries, so any widening here has to show up in
 * review. Pinned by a snapshot test (H03 criterion 8): do not edit without
 * updating the test.
 *
 * `contents: "write"` is the token ceiling a role needs to push over git —
 * it is never, on its own, a grant to the REST contents API, which
 * `decide.ts` denies universally for every role regardless of this table
 * (fix-round item 3). Four roles carry it: `executor` (pushes to
 * `refs/heads/fx/*`, excluding the three sub-prefixes below), `docs-writer`
 * (`refs/heads/fx/docs/*` only), `release-manager`
 * (`refs/heads/fx/release/*` only), and `runbook-writer`
 * (`refs/heads/fx/runbook/*` only) — see `ROLE_PUSH_PREFIX` below and
 * `canRolePush` in `decide.ts` for the exact per-role prefix each of the
 * four is actually restricted to.
 * Team Lead decision (fix round 2, item a): these three were read-only
 * after the first fix round; they push their own content changes through
 * git now, each confined to a repo-wide-unique branch prefix so none of the
 * four push-capable roles can touch a branch prefix that isn't its own.
 *
 * No role holds `discussions: "write"` (D#2 C20 item 3, D#71 DS-5): Discussion
 * content is written by Workflow steps outside the sandbox through
 * `@fx/discussions/server`, never by an agent through the GitHub API.
 * `feedback-scanner` keeps `discussions: "read"`.
 *
 * Kept as a literal object (not derived) so a diff against it is readable.
 */
export const ROLE_PERMISSIONS: Readonly<
  Record<string, Partial<Record<PermissionName, PermissionLevel>>>
> = Object.freeze({
  executor: { metadata: "read", contents: "write", pull_requests: "write", issues: "read" },
  "code-reviewer": { metadata: "read", contents: "read", pull_requests: "write", issues: "read" },
  "security-reviewer": { metadata: "read", contents: "read", pull_requests: "write", issues: "read" },
  "acceptance-tester": { metadata: "read", contents: "read", pull_requests: "write", issues: "read" },
  debater: { metadata: "read", contents: "read", pull_requests: "write", issues: "read" },
  "accessibility-reviewer": { metadata: "read", contents: "read", pull_requests: "write", issues: "read" },
  "project-manager": { metadata: "read", contents: "read", issues: "write", pull_requests: "read" },
  "technical-architect": { metadata: "read", contents: "read" },
  "product-owner": { metadata: "read", contents: "read" },
  "cost-analyst": { metadata: "read", contents: "read" },
  "performance-expert": { metadata: "read", contents: "read" },
  "security-expert": { metadata: "read", contents: "read" },
  researcher: { metadata: "read", contents: "read" },
  "mission-analyst": { metadata: "read", contents: "read" },
  "run-analyst": { metadata: "read", contents: "read" },
  "feedback-scanner": { metadata: "read", issues: "read", discussions: "read" },
  "quality-sweep": { metadata: "read", contents: "read" },
  "visual-verifier": { metadata: "read", contents: "read" },
  "docs-writer": { metadata: "read", contents: "write" },
  "incident-commander": { metadata: "read", contents: "read", issues: "write" },
  "release-manager": { metadata: "read", contents: "write" },
  "runbook-writer": { metadata: "read", contents: "write" },
  "ux-designer": { metadata: "read", contents: "read" },
  "analytics-engineer": { metadata: "read", contents: "read" },
  "browser-tester": { metadata: "read", contents: "read", pull_requests: "write" },
  "tui-tester": { metadata: "read", contents: "read" },
});

/**
 * Safe lookup for `ROLE_PERMISSIONS` on an attacker-controlled key.
 *
 * `ROLE_PERMISSIONS` is a plain object, so bracket access with a raw string
 * (`ROLE_PERMISSIONS[role]`) resolves through the prototype chain: a role of
 * `"toString"` returns `Object.prototype.toString` (a function — truthy, so
 * a `!rolePerms` guard never catches it) and a role of `"__proto__"` returns
 * `Object.prototype` itself (also truthy, and reads back as `{}`). Both were
 * real bypasses. `Object.hasOwn` only ever answers about the object's own
 * enumerable keys — the ones this file actually wrote — never the prototype
 * chain, so this is the one lookup path `decide()` should use.
 */
export function lookupRolePermissions(
  role: string,
): Partial<Record<PermissionName, PermissionLevel>> | undefined {
  return Object.hasOwn(ROLE_PERMISSIONS, role) ? ROLE_PERMISSIONS[role] : undefined;
}

/** Read-only scope every role gets on the `sitekit` product, regardless of team-role permissions. */
export const SITEKIT_PERMISSIONS: Readonly<Partial<Record<PermissionName, PermissionLevel>>> =
  Object.freeze({ metadata: "read", contents: "read" });

/** Reviewer roles: read, comment, and their own allowlisted-label writes only; never a contents write. */
export const REVIEWER_ROLES: ReadonlySet<string> = new Set([
  "code-reviewer",
  "security-reviewer",
  "acceptance-tester",
  "debater",
  "accessibility-reviewer",
]);

/**
 * The verdict labels each reviewer role may add or remove — its own only,
 * with no label shared between two roles. Fix round 2, item W1: `needs-fix`
 * used to be shared by `code-reviewer` and `security-reviewer`, which meant
 * either one could clear the OTHER's rejection by deleting the shared label
 * — a NACK from security-reviewer disappeared the moment code-reviewer
 * removed its own. Each reviewer now gets its own distinctly-named
 * pass/needs-fix pair, so removing one role's label can never touch
 * another's. `debater` and `accessibility-reviewer` are deliberately absent
 * (empty set via `lookupReviewerVerdictLabels`): both may read and comment
 * (criterion 6), but neither owns a verdict label in the merge-gate
 * protocol, so neither gets label-write rights.
 *
 * A `Map`, not a plain object: same prototype-pollution concern as
 * `ROLE_PERMISSIONS` above, and a `Map` sidesteps it entirely rather than
 * needing a second `hasOwn` guard.
 */
const REVIEWER_VERDICT_LABELS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["code-reviewer", new Set(["code-review-passed", "code-review-needs-fix"])],
  ["security-reviewer", new Set(["security-review-passed", "security-needs-fix"])],
  ["acceptance-tester", new Set(["acceptance-passed", "acceptance-failed"])],
]);

const EMPTY_LABEL_SET: ReadonlySet<string> = new Set();

/** The verdict labels `role` may add or remove. Empty for any role without its own set. */
export function lookupReviewerVerdictLabels(role: string): ReadonlySet<string> {
  return REVIEWER_VERDICT_LABELS.get(role) ?? EMPTY_LABEL_SET;
}

/** Every verdict label recognized by any reviewer role. Used for table-driven tests and docs. */
export const ALLOWLISTED_VERDICT_LABELS: ReadonlySet<string> = new Set(
  Array.from(REVIEWER_VERDICT_LABELS.values()).flatMap((labels) => Array.from(labels)),
);

/**
 * Team Lead decision, fix round 2 item (a): `docs-writer`, `release-manager`
 * and `runbook-writer` push their own content changes via git, each
 * confined to its own `refs/heads/fx/<name>/*` sub-prefix so none of the
 * three (or the executor) can push onto a prefix that isn't its own.
 * Keyed by role, used by `decide.ts`'s `canRolePush`.
 */
export const ROLE_PUSH_PREFIX: ReadonlyMap<string, string> = new Map([
  ["docs-writer", "refs/heads/fx/docs/"],
  ["release-manager", "refs/heads/fx/release/"],
  ["runbook-writer", "refs/heads/fx/runbook/"],
]);
