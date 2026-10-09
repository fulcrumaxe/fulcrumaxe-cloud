/**
 * The minimum toolchain a job's agent needs to run a project's own tests (D#6 R4d-3, correction C32 section 4): `node`, `npm`, `npx`,
 * `pnpm`, `yarn` and `git`, found once at setup on the daemon's own search path, with the directories they live in put on the agent's PATH
 * and, where an install sits under the home directory (which the sandbox hides), one read-only grant for that tool's install prefix.
 *
 * Nothing here starts a process. A tool that is not found is skipped (a repository may not need node); a tool whose install prefix may not
 * be granted (it reaches a credential location, the runner's own state, the agent binary's directory, or is the home directory or a broad
 * directory like `~/.local`) is refused: it is neither granted nor put on the PATH, and `doctor` says so. There is no write grant.
 */
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { cacheRootsFor } from "../daemon/mirror.js";
import { canGrantRead, pathsOverlap, protectedPaths } from "./sandboxSettings.js";

/** The commands looked for, in the order `doctor` lists them. */
export const TOOLCHAIN_TOOLS: readonly string[] = Object.freeze(["node", "npm", "npx", "pnpm", "yarn", "git"]);

/**
 * Directories under the home directory that hold many unrelated things, so a tool found directly in one (for example `~/.local/bin/node`) is
 * never granted by its prefix: a read of `~/.local` would open every user-installed program and its data. Relative to the home directory.
 */
const BROAD_UNDER_HOME: readonly string[] = Object.freeze([".local", ".local/share", ".local/lib", ".local/state", ".config", ".cache", "bin", ".nix-profile", ".local/state/nix"]);

export interface ToolchainTool {
  name: string;
  /** Where the command was found on the search path. */
  found: string;
  /** The real directory that holds the command (symlinks followed): what goes on the agent's PATH. Never `~/.nix-profile`. */
  binDir: string;
  /** The install prefix to read-grant, or undefined when the install is outside the home directory and needs none. */
  readPrefix?: string;
}

export interface ToolchainRefusal {
  name: string;
  found: string;
  /** `grant_refused`: its install location may not be opened to jobs. `job_area`: it resolves under the workspaces, the job temp directories or the mirrors, where a job can write or a repository decides the content. */
  reason: "grant_refused" | "job_area";
}

export interface Toolchain {
  tools: ToolchainTool[];
  /** Tools found but not usable inside the sandbox, with the reason. */
  refused: ToolchainRefusal[];
  /** Commands not found on the search path. */
  missing: string[];
}

export interface ToolchainFacts {
  home: string;
  stateDir: string;
  binaryDir: string;
  /** The directories jobs work in or mirror into (workspaces, job temp directories, mirrors). A tool that resolves under one is never put on the PATH. */
  jobAreas?: readonly string[];
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    // fx-swallow-ok: not an executable file here; the next directory may hold it
    return false;
  }
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The install prefix of a directory that holds a binary: its parent when it is called `bin`, else itself. */
function prefixOf(dir: string): string {
  return path.basename(dir) === "bin" ? path.dirname(dir) : dir;
}

function realOr(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    // fx-swallow-ok: a path that cannot be resolved is kept as written; the caller's checks run on it
    return value;
  }
}

/**
 * Resolves each of `TOOLCHAIN_TOOLS` on `searchPath` (absolute entries only). The PATH directory is the real directory of the command (so
 * `~/.nix-profile/bin/node` becomes the store directory it points into). When that directory, or where the command itself really lives, is
 * under the home directory, its install prefix is the one read-only grant.
 */
export function resolveToolchain(searchPath: string, facts: ToolchainFacts): Toolchain {
  const result: Toolchain = { tools: [], refused: [], missing: [] };
  const home = path.normalize(facts.home);
  const realHome = realOr(home);
  const protectedList = protectedPaths({ home, stateDir: facts.stateDir, binaryDir: facts.binaryDir });
  const guarded = [...protectedList.noAccess, ...protectedList.noEdit];
  for (const name of TOOLCHAIN_TOOLS) {
    let found: string | undefined;
    for (const dir of searchPath.split(path.delimiter)) {
      if (dir === "" || !path.isAbsolute(dir)) continue;
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) {
        found = candidate;
        break;
      }
    }
    if (found === undefined) {
      result.missing.push(name);
      continue;
    }
    const binDir = realOr(path.dirname(found));
    const realBinary = realOr(found);
    // A bin directory inside a job's own area would put a program a job (or a cloned repository) wrote on every later job's PATH.
    if ((facts.jobAreas ?? []).some((area) => [area, realOr(area)].some((root) => [binDir, realBinary, found].some((place) => inside(root, place))))) {
      result.refused.push({ name, found, reason: "job_area" });
      continue;
    }
    const places = [...new Set([prefixOf(binDir), prefixOf(path.dirname(realBinary))])];
    const underHome = places.filter((place) => inside(home, place) || inside(realHome, place));
    // The directories a grant would have to cover must all be fine, or the tool is refused outright.
    let refused = [binDir, realBinary].some((place) => guarded.some((guard) => pathsOverlap(guard, place)));
    const grants: string[] = [];
    for (const place of underHome) {
      const rel = path.relative(inside(home, place) ? home : realHome, place);
      if (rel === "" || BROAD_UNDER_HOME.includes(rel)) refused = true;
      else if (!canGrantRead(place, facts)) refused = true;
      else grants.push(place);
    }
    if (refused) {
      result.refused.push({ name, found, reason: "grant_refused" });
      continue;
    }
    // One prefix covers the tool; the shortest grant that contains the others is the install prefix.
    const readPrefix = grants.sort((a, b) => a.length - b.length)[0];
    result.tools.push({ name, found, binDir, ...(readPrefix === undefined ? {} : { readPrefix }) });
  }
  return result;
}

/** The distinct directories to put on the agent's PATH, in tool order. */
export function toolchainPathDirs(toolchain: Toolchain | undefined): string[] {
  return toolchain === undefined ? [] : [...new Set(toolchain.tools.map((tool) => tool.binDir))];
}

/** The distinct read-only grants: the install prefixes under the home directory, and nothing else. */
export function toolchainReadPaths(toolchain: Toolchain | undefined): string[] {
  return toolchain === undefined ? [] : [...new Set(toolchain.tools.flatMap((tool) => (tool.readPrefix === undefined ? [] : [tool.readPrefix])))];
}

/** The `toolchain:` line for `doctor`, and the warning when node is missing. Paths are shown as directories, never contents. */
export function describeToolchain(toolchain: Toolchain): { line: string; warnings: string[] } {
  const found = toolchain.tools.map((tool) => tool.name);
  const granted = toolchainReadPaths(toolchain);
  const parts = [found.length === 0 ? "none found" : `found ${found.join(", ")}`];
  if (granted.length > 0) parts.push(`read-only access to ${granted.join(", ")}`);
  if (toolchain.refused.length > 0) parts.push(`not usable in the sandbox: ${toolchain.refused.map((r) => r.name).join(", ")}`);
  const warnings: string[] = [];
  if (toolchain.missing.includes("node")) warnings.push("node not found: projects that need it cannot run their tests");
  for (const tool of toolchain.refused) {
    warnings.push(tool.reason === "job_area"
      ? `${tool.name} was found at ${tool.found}, inside the directories jobs work in, so it is left out`
      : `${tool.name} was found at ${tool.found} but its install location may not be opened to jobs, so it is left out`);
  }
  return { line: parts.join("; "), warnings };
}

/**
 * What `doctor` prints: the level, the `toolchain:` line and its warnings, or undefined when the home directory is not known (the sandbox check
 * already fails for that). Missing node, or a tool left out for safety, is a warning and never a failure: not every repository needs node.
 */
export function toolchainReport(searchPath: string, input: { home: string | undefined; stateDir: string; binaryPath: string | undefined; platform: NodeJS.Platform; xdgCacheHome?: string | undefined }): { level: "INFO" | "WARN"; line: string; warnings: string[] } | undefined {
  if (input.home === undefined || !path.isAbsolute(input.home)) return undefined;
  const binaryDir = input.binaryPath === undefined ? path.join(input.stateDir, "engine") : path.dirname(input.binaryPath);
  const { mirrorsRoot, workspaceRoot, tempRoot } = cacheRootsFor({ home: input.home, platform: input.platform, xdgCacheHome: input.xdgCacheHome });
  const toolchain = resolveToolchain(searchPath, { home: input.home, stateDir: input.stateDir, binaryDir, jobAreas: [mirrorsRoot, workspaceRoot, tempRoot] });
  const described = describeToolchain(toolchain);
  return { level: toolchain.missing.includes("node") || toolchain.refused.length > 0 ? "WARN" : "INFO", ...described };
}
