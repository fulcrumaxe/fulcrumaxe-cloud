/**
 * Per-role tool sets, computed from four tiers. `toolsetFor(role)` is the one
 * per-role tool list: the runtime, the MCP door and the runner derive from it,
 * and nothing else may keep a second hand-written per-role list.
 *
 * Deny by default: an unknown role throws, and a tool that is not in the
 * returned set is not granted. The tiers:
 *   base      every role: read/search, Bash, gh, git, fx test
 *   write     Write, Edit, NotebookEdit unless the role is read-only
 *   browser   the chrome-devtools MCP namespace, for roles with needsBrowser
 *   web       WebFetch and WebSearch, researcher only
 * `Agent` and `next_role_request` are never granted: spawning belongs to the
 * orchestrator, and next_role_request is an output field, not a callable tool.
 */

import { getRoleEntry } from "./manifest";

/** Roles whose card has `read_only: true` (a test parses the cards to keep this honest). */
export const READ_ONLY_ROLES: readonly string[] = [
  "accessibility-reviewer",
  "code-reviewer",
  "cost-analyst",
  "debater",
  "performance-expert",
  "product-owner",
  "researcher",
  "run-analyst",
  "security-expert",
  "security-reviewer",
  "technical-architect",
];

/** Tools that run through the sandbox shell rather than being SDK tool names. */
export const BASH_MEDIATED_TOOLS: readonly string[] = ["gh", "git", "fx test"];

export class UnknownRoleError extends Error {
  constructor(role: string) {
    super(`unknown role: ${JSON.stringify(role)}`);
    this.name = "UnknownRoleError";
  }
}

const BASE_TIER = ["Read", "Glob", "Grep", "Bash", ...BASH_MEDIATED_TOOLS] as const;
const WRITE_TIER = ["Write", "Edit", "NotebookEdit"] as const;
const BROWSER_TIER = ["mcp__chrome-devtools__*"] as const;
const WEB_TIER = ["WebFetch", "WebSearch"] as const;

export function toolsetFor(role: string): readonly string[] {
  const entry = getRoleEntry(role);
  if (entry === undefined) throw new UnknownRoleError(role);
  const set: string[] = [...BASE_TIER];
  if (!READ_ONLY_ROLES.includes(role)) set.push(...WRITE_TIER);
  if (entry.needsBrowser) set.push(...BROWSER_TIER);
  if (role === "researcher") set.push(...WEB_TIER);
  return Object.freeze(set);
}

/** The tool names the SDK is told about: the set minus the shell-mediated ones. */
export function sdkToolsFor(role: string): readonly string[] {
  return toolsetFor(role).filter((t) => !BASH_MEDIATED_TOOLS.includes(t));
}
