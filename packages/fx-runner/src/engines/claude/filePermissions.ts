import path from "node:path";
import type { ProtectedPaths } from "../../sandbox/sandboxSettings.js";
import { EngineRefusal } from "./refusal.js";

/**
 * Permission rules for the agent's own file tools, in the syntax the CLI documents (checked against the Claude Code
 * permissions page, 2026-10-08): path rules are consulted for `Read(...)` and `Edit(...)` only. A `Read` rule also covers
 * Glob, Grep and LS; an `Edit` rule covers Write, MultiEdit and NotebookEdit. A path rule written for any of those
 * tools by name is accepted and never consulted. `//abs/path` is an absolute path, gitignore globs apply.
 */
const READ_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep", "LS"]);
const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Characters that would be a glob, a negation, an escape or a rule delimiter inside a rule. */
const RULE_META = /[*?[\]{}!\\()\n\r]/;

/** `//abs/path`: the CLI's spelling of an absolute path. A path that cannot be written literally is refused, never guessed at. */
function anchored(abs: string): string {
  if (!path.isAbsolute(abs) || RULE_META.test(abs)) throw new EngineRefusal("bad_start_options", "path cannot be written as a permission rule");
  return `/${abs.length > 1 && abs.endsWith("/") ? abs.slice(0, -1) : abs}`;
}

/**
 * Turns each bare file tool of a role entry into a rule confined to `workspace`. Read tools become `Read` rules, edit
 * tools `Edit` rules (the only two spellings the CLI consults); every other entry passes through. Order is kept and an
 * entry that maps to a rule already present is not repeated.
 */
export function confineFileTools(roleEntry: readonly string[], workspace: string): string[] {
  const root = anchored(workspace);
  const out: string[] = [];
  for (const tool of roleEntry) {
    const rules = READ_TOOLS.has(tool) ? [`Read(${root})`, `Read(${root}/**)`] : EDIT_TOOLS.has(tool) ? [`Edit(${root}/**)`] : [tool];
    for (const rule of rules) if (!out.includes(rule)) out.push(rule);
  }
  return out;
}

/**
 * The deny floor, generated from the one protected list. A path may be a file or a directory, so each gets a rule for
 * itself and one for what is under it. Deny outranks allow, so this holds even if the allow entries are wrong.
 */
export function denyRules(protectedList: ProtectedPaths): string[] {
  const both = (tool: "Read" | "Edit", abs: string): string[] => [`${tool}(${anchored(abs)})`, `${tool}(${anchored(abs)}/**)`];
  return [...protectedList.noAccess.flatMap((abs) => [...both("Read", abs), ...both("Edit", abs)]), ...protectedList.noEdit.flatMap((abs) => both("Edit", abs))];
}
