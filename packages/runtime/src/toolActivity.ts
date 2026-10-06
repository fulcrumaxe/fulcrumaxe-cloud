/**
 * D#2 PREVIEW-RUNNER-EVENTS: what a `stream-json` line's tool-use blocks may tell the rest of the system.
 *
 * Pure, imports no SDK. A tool-use block carries the agent's raw tool input (file contents to write, whole
 * shell commands with their environment, URLs, tokens). NONE of that leaves this module. For each block it keeps
 * only: an id (to pair the later result), one of five coarse kinds, and at most
 *   - a path relative to the repository root (anything absolute-outside, climbing, URL-like or odd is dropped), or
 *   - a short search term.
 * Shell commands are classified (test run, repository clone, anything else). A command's text is kept only as its first
 * line, capped and cleaned of control characters (`shellCommandLine`) and only when redaction would leave the whole command unchanged,
 * so a token, a credentialed URL or an env secret never leaves this module; the recorder in `@fx/runner` checks it again.
 * Tool results are reduced to `{ id, ok }`; their content is never read.
 */

import { posix } from "node:path";
import { redactText } from "./redact.js";

// The three types are declared in `@fulcrumaxe/runner-protocol` (D#6 R1, next to `NormalizedEvent`, which carries
// them). They are re-exported so this module's export list does not change; the functions below stay private.
import type { ActivityTool, ToolResult, ToolUse } from "@fulcrumaxe/runner-protocol/agentRuntime";
export type { ActivityTool, ToolResult, ToolUse };

export const TOOL_ACTIVITY_LIMITS = {
  /** Blocks looked at per line; the rest are ignored. */
  maxBlocks: 32,
  maxIdChars: 200,
  /** Raw input strings longer than this are not looked at at all. */
  maxRawChars: 4096,
  maxPathChars: 90,
  maxPatternChars: 40,
  /** Characters of a shell command's first line that may travel on a tool use. */
  maxCommandChars: 200,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const CONTROL_RE = /[\u0000-\u001f\u007f\\]/;

/**
 * A path relative to the repository root, or undefined when it has none worth showing. The path is resolved against
 * `repoRoot` (the agent's working directory, so a relative path is read relative to it); what resolves outside the
 * root (`../`, an absolute path elsewhere, a sibling that merely shares the root's prefix) is dropped, and so is
 * every path when no usable root is known. Only the clean form is returned: no `..`, no `.`, no leading or doubled
 * slash. `""` is the root itself. URL-like, home-relative, backslash, control-character, over-long and
 * credential-shaped values are dropped. A name that is a link to somewhere else cannot be seen from outside the
 * sandbox; the read side's credential-name check is the only guard there.
 */
export function normalizeRepoPath(raw: unknown, repoRoot?: string): string | undefined {
  if (typeof raw !== "string" || raw === "" || raw.length > TOOL_ACTIVITY_LIMITS.maxRawChars) return undefined;
  if (CONTROL_RE.test(raw) || raw.includes("://") || raw.startsWith("~")) return undefined;
  if (typeof repoRoot !== "string" || !repoRoot.startsWith("/") || repoRoot.length > TOOL_ACTIVITY_LIMITS.maxRawChars || CONTROL_RE.test(repoRoot)) return undefined;
  const root = posix.resolve(repoRoot);
  if (root === "/") return undefined;
  const resolved = posix.resolve(root, raw);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) return undefined;
  const out = resolved === root ? "" : resolved.slice(root.length + 1);
  // A credential-shaped value is not a path: drop it rather than store the redacted form.
  if (out.length > TOOL_ACTIVITY_LIMITS.maxPathChars || redactText(out, []) !== out) return undefined;
  return out;
}

/** A short search term, or undefined (not a string, empty after trimming, too long, control characters, a URL). */
export function normalizePattern(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > TOOL_ACTIVITY_LIMITS.maxRawChars) return undefined;
  const term = raw.trim();
  if (term === "" || term.length > TOOL_ACTIVITY_LIMITS.maxPatternChars || CONTROL_RE.test(term) || term.includes("://")) return undefined;
  return redactText(term, []) === term ? term : undefined;
}

/** A URL with a user or password in it (`scheme://user:secret@host`): redaction does not always know this shape. */
export const CREDENTIALED_URL_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]*@/i;

/**
 * Command-line arguments that carry a secret in a shape `redactText` does not know. Deliberately broad: a match is
 * dropped even when the value is harmless, because a command line cannot tell.
 *   - a flag named for a credential followed by its value (`--password x`, `--token=x`, `--api-key x`);
 *   - curl's user:password in every spelling (`-u a:b`, `-ua:b`, `--user a:b`, `--user=a:b`);
 *   - a Basic header value;
 *   - a plain word holding a credential part, then whitespace and a value (`aws configure set aws_secret_access_key X`,
 *     `npm config set //registry.npmjs.org/:_authToken X`).
 * `--no-token` style flags with no value do not match.
 */
const SECRET_ARGUMENT_RE = new RegExp(
  [
    String.raw`(^|\s)-{1,2}[A-Za-z0-9_-]*(pass(word|wd)?|pwd|token|secret|credential|api-?key|auth)[A-Za-z0-9_-]*(=|\s+)\S`,
    String.raw`(^|\s)(-u|--user)(=|\s*)\S+:\S`,
    String.raw`\bBasic\s+[A-Za-z0-9+/=]{8,}`,
    String.raw`(^|\s)(?!-)[^\s=]*(secret|token|passw(or)?d|credential|api[_-]?key|access[_-]?key|private[_-]?key|_auth)[^\s=]*\s+[^\s-]`,
  ].join("|"),
  "i",
);

/**
 * Tools whose password goes on the command line under a short flag, decided per tool: `-p` is a password for mysql
 * and sshpass but not for `mkdir -p`, `cp -p`, `ssh -p 22` or `git add -p`.
 */
const PASSWORD_TOOLS: ReadonlyArray<{ tools: readonly string[]; needs?: readonly string[]; flags: RegExp }> = [
  { tools: ["mysql", "mariadb", "mysqldump", "mysqladmin"], flags: /^(-p|--password)/ },
  { tools: ["docker", "podman", "nerdctl", "buildah"], needs: ["login"], flags: /^(-p|--password)/ },
  { tools: ["helm"], needs: ["registry", "login"], flags: /^(-p|--password)/ },
  { tools: ["sshpass"], flags: /^(-p|--password)/ },
  { tools: ["redis-cli"], flags: /^(-a|--pass)/ },
  { tools: ["htpasswd"], flags: /^-[A-Za-z]*b|^--password/ },
  // zip/unzip take the password after a capital -P; lowercase `unzip -p` only pipes a file to stdout.
  { tools: ["zip", "unzip", "zipcloak"], flags: /^-[A-Za-z0-9]*P|^--password/ },
  // 7-Zip switches are case-insensitive; it glues the password to the switch (-psecret) and accepts it as the next word.
  { tools: ["7z", "7za", "7zr", "7zz"], flags: /^-p/i },
  // openssl: -k and -K carry a key; -pass/-passin/-passout take `pass:secret` (env:/file: references are dropped too).
  { tools: ["openssl"], flags: /^-(k|K|pass|passin|passout|password)$/ },
  // `gh auth login --with-token` reads the token from stdin, the same shape as `docker login --password-stdin`.
  { tools: ["gh"], needs: ["auth", "login"], flags: /^--with-token(\W|$)/ },
];

/** True when some simple command in the line runs a listed credential tool with that tool's password flag. */
function usesPasswordFlag(command: string): boolean {
  for (const segment of command.split(/[;&|\n(){}`]+/)) {
    const words = segment
      .split(/\s+/)
      .map((w) => w.replace(/^['"]+|['"]+$/g, ""))
      .filter((w) => w !== "");
    const names = words.map((w) => w.slice(w.lastIndexOf("/") + 1));
    for (const t of PASSWORD_TOOLS) {
      if (!t.tools.some((tool) => names.includes(tool))) continue;
      if (t.needs && !t.needs.every((n) => words.includes(n))) continue;
      if (words.some((w) => t.flags.test(w) || w === "--password-stdin")) return true;
    }
  }
  return false;
}

/**
 * True when a shell command (all of it, every line) carries nothing redaction would change: no token shape, no
 * `NAME=secret` assignment, no credentialed URL, no secret-bearing argument (`SECRET_ARGUMENT_RE`), no password flag
 * on a credential tool (`usesPasswordFlag`), no redaction placeholder from an earlier pass.
 */
export function commandIsClean(command: string): boolean {
  return (
    !command.includes("[redacted]") &&
    !CREDENTIALED_URL_RE.test(command) &&
    !SECRET_ARGUMENT_RE.test(command) &&
    !usesPasswordFlag(command) &&
    redactText(command, []) === command
  );
}

/**
 * A shell command's first line for display, or undefined. Undefined when nothing is left of the line, or when ANY part
 * of the command is not clean (`commandIsClean`: a secret on a later line of a quoted string or a heredoc drops the
 * first line too). Control characters become spaces and the line is trimmed; one longer than the cap is cut at a word
 * boundary (a token cut mid-way would show its first characters and no longer match any credential shape) and ends
 * with an ellipsis. Pure.
 */
export function shellCommandLine(command: string): string | undefined {
  if (!commandIsClean(command)) return undefined;
  const line = (command.split("\n")[0] ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (line === "") return undefined;
  const max = TOOL_ACTIVITY_LIMITS.maxCommandChars;
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1).replace(/\S*$/, "").trimEnd();
  return cut === "" ? undefined : `${cut}…`;
}

const TEST_COMMAND_RE =
  /(^|[\s;&|(])(vitest|jest|pytest|mocha|phpunit|rspec|(npm|pnpm|yarn|bun)(\s+-{1,2}[\w-]+)*(\s+run)?\s+(test|e2e)|(cargo|go|dotnet)\s+test|playwright\s+test)(\s|$)/;
const CLONE_COMMAND_RE = /(^|[\s;&|(])(git\s+clone|gh\s+repo\s+clone)(\s|$)/;

const WRITE_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** The reduced form of one tool-use block, or undefined when the tool is not one we report. Never reads anything but the fields named here. */
function reduceToolUse(block: Record<string, unknown>, repoRoot: string | undefined): ToolUse | undefined {
  const id = block.id;
  if (typeof id !== "string" || id === "" || id.length > TOOL_ACTIVITY_LIMITS.maxIdChars) return undefined;
  const name = block.name;
  const input = isRecord(block.input) ? block.input : {};
  if (typeof name !== "string") return undefined;
  if (WRITE_TOOLS.has(name)) return { id, writes: true };
  switch (name) {
    case "Read": {
      const path = normalizeRepoPath(input.file_path, repoRoot);
      return path ? { id, tool: "read", path } : undefined;
    }
    case "LS":
    case "Glob": {
      if (input.path === undefined) return { id, tool: "list" };
      const path = normalizeRepoPath(input.path, repoRoot);
      if (path === undefined) return undefined;
      return path === "" ? { id, tool: "list" } : { id, tool: "list", path };
    }
    case "Grep": {
      const pattern = normalizePattern(input.pattern);
      return pattern ? { id, tool: "search", pattern } : { id, tool: "search" };
    }
    case "Bash": {
      const command = typeof input.command === "string" && input.command.length <= TOOL_ACTIVITY_LIMITS.maxRawChars ? input.command : "";
      if (CLONE_COMMAND_RE.test(command)) return { id, tool: "command", clone: true };
      const shown = shellCommandLine(command);
      return { id, tool: TEST_COMMAND_RE.test(command) ? "test" : "command", ...(shown !== undefined && { command: shown }) };
    }
    default:
      return undefined;
  }
}

/** The reduced tool-use blocks of an `assistant` message's content array. */
export function extractToolUses(content: readonly unknown[] | undefined, repoRoot?: string): ToolUse[] {
  const out: ToolUse[] = [];
  for (const block of (content ?? []).slice(0, TOOL_ACTIVITY_LIMITS.maxBlocks)) {
    if (!isRecord(block) || block.type !== "tool_use") continue;
    const use = reduceToolUse(block, repoRoot);
    if (use) out.push(use);
  }
  return out;
}

/** The reduced tool-result blocks of a `user` message's content array: only the id and whether it errored. */
export function extractToolResults(content: unknown): ToolResult[] {
  if (!Array.isArray(content)) return [];
  const out: ToolResult[] = [];
  for (const block of content.slice(0, TOOL_ACTIVITY_LIMITS.maxBlocks)) {
    if (!isRecord(block) || block.type !== "tool_result") continue;
    const id = block.tool_use_id;
    if (typeof id !== "string" || id === "" || id.length > TOOL_ACTIVITY_LIMITS.maxIdChars) continue;
    out.push({ id, ok: block.is_error !== true });
  }
  return out;
}
