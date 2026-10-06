import { RUNNER_ELIGIBLE_ROLES, canonicalJson, sha256Text } from "@fulcrumaxe/runner-protocol";

/**
 * The tools each runner-eligible role may use on a customer's machine.
 *
 * The entries are the cloud's own role tool lists (`toolsForRole` in the cloud's runner package) with the three kinds
 * of entry a runner never grants removed: the web fetch tool, the web search tool and every platform MCP tool. This
 * file is a literal copy, because the cloud package does not ship to a customer machine; `test/roleTools.test.ts`
 * deep-equals each entry with that derivation, so a change to the cloud's list cannot silently differ here.
 */
const READ_TOOLS = ["Read", "Glob", "Grep", "LS"] as const;
const TEST_TOOLS = ["Bash(git:*)", "Bash(node:*)", "Bash(npm:*)", "Bash(npx:*)", "Bash(pnpm:*)", "Bash(yarn:*)"] as const;
const READ_HELPERS = ["Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(date:*)", "Bash(pwd)", "Bash(echo:*)", "Bash(diff:*)", "Bash(test:*)"] as const;
const LOOK_HELPERS = ["Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(pwd)"] as const;
const FILE_OPS = ["Bash(mkdir:*)", "Bash(rm:*)", "Bash(mv:*)", "Bash(cp:*)", "Bash(touch:*)"] as const;

const EXECUTOR: readonly string[] = [...READ_TOOLS, "Edit", "MultiEdit", "Write", "NotebookEdit", ...TEST_TOOLS, ...READ_HELPERS, "Bash(curl:*)", ...FILE_OPS];
const REVIEWER: readonly string[] = [...READ_TOOLS, ...TEST_TOOLS, "Bash(mkdir:*)", ...READ_HELPERS];
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
