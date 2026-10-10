import { RUNNER_ELIGIBLE_ROLES, canonicalJson, sha256Text } from "@fulcrumaxe/runner-protocol";

/**
 * The tools each runner-eligible role may use on a customer's machine.
 *
 * The entries are the cloud's own role tool lists (`toolsForRole` in the cloud's runner package) with the three kinds
 * of entry a runner never grants removed: the web fetch tool, the web search tool and every platform MCP tool. This
 * file is a literal copy, because the cloud package does not ship to a customer machine; `test/roleTools.test.ts`
 * deep-equals each entry with that derivation, so a change to the cloud's list cannot silently differ here.
 *
 * OWNER RULING R-C44-1 (2026-10-10; amends D#483 P3 for these roles): the executor and the four review roles hold plain
 * `Bash`, so a job can run a test harness (`bash -c`, `$VAR`, redirects, `mktemp`). The boundary is the OS sandbox, which
 * `assertEnabledSandbox` still requires (enabled, no unsandboxed fallback, home denied, allowlisted network), plus the
 * protected-path deny rules. Reviewers still hold no Edit, MultiEdit, Write or NotebookEdit tool, and a reviewer's
 * changes are never published (`PUBLISHING_ROLES` in prompt.ts, `PUSHING_ROLES` in gitPath.ts).
 */
const READ_TOOLS = ["Read", "Glob", "Grep", "LS"] as const;
const LOOK_HELPERS = ["Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(pwd)"] as const;

const EXECUTOR: readonly string[] = [...READ_TOOLS, "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"];
const REVIEWER: readonly string[] = [...READ_TOOLS, "Bash"];
const LOOK_ONLY: readonly string[] = [...READ_TOOLS, "Bash(curl:*)", "Bash(git:*)", ...LOOK_HELPERS];

const ENTRY_FOR_ROLE: Readonly<Record<(typeof RUNNER_ELIGIBLE_ROLES)[number], readonly string[]>> = {
  executor: EXECUTOR,
  "project-manager": LOOK_ONLY,
  "technical-architect": LOOK_ONLY,
  "product-owner": LOOK_ONLY,
  "cost-analyst": LOOK_ONLY,
  "performance-expert": LOOK_ONLY,
  "security-expert": LOOK_ONLY,
  "docs-writer": LOOK_ONLY,
  "accessibility-reviewer": LOOK_ONLY,
  "code-reviewer": REVIEWER,
  "security-reviewer": REVIEWER,
  "acceptance-tester": REVIEWER,
  debater: REVIEWER,
};

/** The role table. Its keys are exactly the runner-eligible roles; each entry is frozen. */
export const ROLE_TOOLS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(Object.entries(ENTRY_FOR_ROLE).map(([role, tools]) => [role, Object.freeze([...tools])])),
);

/** Thrown for a role this runner has no entry for. A job with such a role is refused before anything is spawned. */
export class UnknownRoleError extends Error {
  readonly code = "unknown_role";
  constructor(role: string) {
    super(`no tool entry for role ${JSON.stringify(role).slice(0, 80)}`);
    this.name = "UnknownRoleError";
  }
}

/**
 * The tools of a role. Fails closed: an unknown role throws, where the cloud's own `toolsForRole` would hand back a
 * look-only list. Own-property lookup only, so names like `constructor` and `__proto__` are unknown too.
 */
export function roleToolsFor(role: string): readonly string[] {
  if (typeof role !== "string" || !Object.hasOwn(ROLE_TOOLS, role)) throw new UnknownRoleError(String(role));
  return ROLE_TOOLS[role]!;
}

/** The SHA-256 of the role's tool list as the job carries it: the sorted list as canonical JSON. */
export function roleToolsDigest(role: string): string {
  return sha256Text(canonicalJson([...roleToolsFor(role)].sort()));
}
