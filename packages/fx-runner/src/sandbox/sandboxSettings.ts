import { realpathSync } from "node:fs";
import path from "node:path";

/** The one model host every job may reach. */
export const MODEL_HOST = "api.anthropic.com";

/**
 * The credential locations a job can never read, relative to the home directory. This is the floor: no per-job extra
 * (R7) may widen the sandbox to cover one of them, and the home directory itself is denied for reads on top.
 */
export const CREDENTIAL_FLOOR: readonly string[] = Object.freeze([
  ".ssh", ".aws", ".config/gh", ".kube", ".docker", ".gnupg", ".netrc", ".npmrc",
  ".claude", ".claude.json", ".config/fx-runner", ".local/share/keyrings", "Library/Keychains",
]);

/**
 * Where an agent that could write to the home directory would persist a foothold, relative to the home directory:
 * shell start-up files, user services, login items and the version-control config. Edits are denied; reads are not.
 */
export const PERSISTENCE_TARGETS: readonly string[] = Object.freeze([
  ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout",
  ".config/fish", ".config/systemd/user", "Library/LaunchAgents", ".config/autostart", ".gitconfig", ".config/git",
]);

/**
 * The one protected-path list. `noAccess` (read and edit): the credential floor, the runner's state directory and the
 * stored agent binary's directory. `noEdit`: the persistence targets. The sandbox builder refuses grants over both, and
 * the file-tool deny rules are generated from these same two arrays.
 */
export interface ProtectedPaths {
  readonly noAccess: readonly string[];
  readonly noEdit: readonly string[];
}

export function protectedPaths(input: { home: string; stateDir: string; binaryDir: string }): ProtectedPaths {
  if (!path.isAbsolute(input.home) || !path.isAbsolute(input.stateDir) || !path.isAbsolute(input.binaryDir)) throw new TypeError("protectedPaths: home, stateDir and binaryDir must be absolute");
  return {
    noAccess: [...CREDENTIAL_FLOOR.map((entry) => path.join(input.home, entry)), path.normalize(input.stateDir), path.normalize(input.binaryDir)],
    noEdit: PERSISTENCE_TARGETS.map((entry) => path.join(input.home, entry)),
  };
}

/** System-wide places that are never granted, whatever a job asks for. */
const NEVER_GRANTED: readonly string[] = Object.freeze(["/", "/etc", "/Library/Keychains"]);

export interface SandboxInput {
  /** The job's workspace: the only place a command may write, besides `tempDir`. Absolute. */
  workspace: string;
  /** The job's own temp directory. Absolute. */
  tempDir: string;
  /** The user's home directory. Absolute. Reads of it are denied apart from the workspace and the temp directory. */
  home: string;
  /** The runner's own state directory (`~/.fx-runner`: keys, logs, job files, session index). Writes are denied, and no grant may overlap it. Absolute. */
  stateDir: string;
  /** The directory holding the stored agent binary. Writes are denied, and no grant may overlap it. Absolute. */
  binaryDir: string;
  /** The directory every workspace is made under, and the directory every temp directory is made under. Absolute. */
  workspaceRoot: string;
  tempRoot: string;
  /** Named roots (R7) under which extra read or write paths may sit, besides the workspace and the temp directory. */
  extraRoots?: readonly string[];
  /** The repository's declared package registries (hosts), none by default. */
  registries?: readonly string[];
  /** R7's per-job additions, already floor-checked by the caller and checked again here. */
  extraReadPaths?: readonly string[];
  extraWritePaths?: readonly string[];
  extraDomains?: readonly string[];
  /**
   * The directory the repo mirrors live in (D#6 R4a-3, C25 section 2), absolute. It is a runner-owned root that no write may
   * reach (it is in `denyWrite`, and unreadable like the home directory), and the only grant under it is ONE read-only
   * `<mirrors root>/<id>.git/objects` in `extraReadPaths`: what a workspace made with `--reference` needs, and nothing else of any mirror.
   * It may not overlap the state directory, the binary directory, the workspace and temp roots, the credential floor or a persistence target.
   */
  mirrorsRoot?: string;
}

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A plain DNS name: no wildcard, no port, no address literal, no single-label name. */
export function assertPlainHost(host: string): string {
  if (!HOST.test(host) || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new TypeError(`sandboxSettings: not an allowed host name: ${JSON.stringify(host)}`);
  }
  return host;
}

/**
 * A grant the sandbox builder refuses: it reaches a credential location, the home directory, a system directory, the
 * runner's own state or the agent binary's directory. It carries a closed `code` so a caller (the job runner) reports a
 * refusal and not an agent exit. Still a `TypeError`, so a caller that only catches bad input keeps working.
 */
export class SandboxGrantRefused extends TypeError {
  readonly code = "sandbox_grant_refused";
  constructor(message: string) {
    super(message);
    this.name = "SandboxGrantRefused";
  }
}

/**
 * Whether `child` is `parent` or under it. `fold` compares case-insensitively, because the default macOS volume is
 * case-insensitive (`~/.SSH` is `~/.ssh` there). Fold only where a match means "refuse" (the protected-overlap test):
 * folding in an allowlist would let `/Work/x` pass for a root `/work`, which on a case-sensitive volume is another place.
 */
function inside(parent: string, child: string, fold = false): boolean {
  const rel = fold ? path.relative(parent.toLowerCase(), child.toLowerCase()) : path.relative(parent, child);
  // A whole-segment test: a child named `..cache` is inside its parent, a path that climbs out (`..` or `../x`) is not.
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The path with every symlink in its existing part resolved; a part that does not exist yet is kept as written. */
function realOf(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    // fx-swallow-ok: a path that does not exist yet resolves through its nearest existing parent
    const up = path.dirname(value);
    return up === value ? value : path.join(realOf(up), path.basename(value));
  }
}

/** Two paths overlap if either contains the other, as written or once symlinks are followed. */
export function pathsOverlap(a: string, b: string): boolean {
  for (const x of [a, realOf(a)]) for (const y of [b, realOf(b)]) if (inside(x, y, true) || inside(y, x, true)) return true;
  return false;
}

function assertGrantable(label: string, value: string, home: string, guarded: readonly string[], roots: readonly string[], mayEqualRoot = false): string {
  if (!path.isAbsolute(value) || value.split(path.sep).includes("..") || value !== path.normalize(value)) throw new SandboxGrantRefused(`sandboxSettings: ${label} must be a normalised absolute path`);
  const trimmed = value.length > 1 && value.endsWith(path.sep) ? value.slice(0, -1) : value;
  if ((inside(trimmed, home, true) && inside(home, trimmed, true)) || NEVER_GRANTED.includes(trimmed) || /\.sock$/.test(trimmed)) throw new SandboxGrantRefused(`sandboxSettings: ${label} may not be the home directory, a system directory or a socket`);
  for (const protectedPath of guarded) if (pathsOverlap(protectedPath, trimmed)) throw new SandboxGrantRefused(`sandboxSettings: ${label} overlaps a protected location`);
  // An allowlist, compared exactly (no case folding): the grant, and where it really lands once symlinks are followed,
  // must both be strictly under a runner-owned root. A grant equal to a root is the root itself, not a child of it.
  const under = (root: string, grant: string): boolean => inside(root, grant) && (mayEqualRoot || path.relative(root, grant) !== "");
  if (!roots.some((root) => under(root, trimmed) && under(realOf(root), realOf(trimmed)))) throw new SandboxGrantRefused(`sandboxSettings: ${label} is not under a runner-owned root`);
  return trimmed;
}

const MIRROR_OBJECTS = /^[^/\\]+\.git[/\\]objects$/;

/**
 * Under the mirrors root the only grant is one read of one repo's `objects` directory. Refused: any write, the root or a parent of it,
 * a mirror's `config`, `hooks`, `refs` or `packed-refs`, a second mirror, and an `objects` directory that is a link to somewhere else.
 */
function assertMirrorGrants(mirrorsRoot: string, reads: readonly string[], writes: readonly string[]): void {
  if (writes.some((value) => pathsOverlap(mirrorsRoot, value))) throw new SandboxGrantRefused("sandboxSettings: extra write path overlaps the mirrors root");
  const under = reads.filter((value) => pathsOverlap(mirrorsRoot, value));
  if (under.length > 1) throw new SandboxGrantRefused("sandboxSettings: only one mirror may be read");
  for (const value of under) {
    const rel = path.relative(mirrorsRoot, value);
    const real = path.relative(realOf(mirrorsRoot), realOf(value));
    if (!MIRROR_OBJECTS.test(rel) || real !== rel) throw new SandboxGrantRefused("sandboxSettings: the only read allowed in the mirrors root is one mirror's objects directory");
  }
}

/**
 * The `sandbox` block of the settings file a job's agent starts with: the Claude Code shell sandbox, on, with:
 *  - writes only in the workspace and the job's temp directory (plus R7's extra write paths);
 *  - writes to the runner's state directory and to the stored agent binary's directory denied;
 *  - reads of the home directory denied, then the workspace and temp directory re-allowed (a narrower allow wins), and
 *    every credential location in `CREDENTIAL_FLOOR` denied on top;
 *  - an allowlist of exactly the model host, the declared registries and R7's extra domains, with `strictAllowlist` so a
 *    host outside it is refused and never prompted for;
 *  - no local binding;
 *  - no unsandboxed fallback: not for a retried command, not for a command pattern, not when the sandbox cannot start
 *    (the job then fails instead of running unconfined), and not through the weaker nested or network modes.
 *
 * This is the only builder: the engine writes its result into the settings file, and the sandbox probe in `doctor` calls
 * the same function. Every key here is in the sandboxing documentation for Claude Code; the minimum version this runner
 * supports is `MIN_CLAUDE_VERSION` (2.1.294, the oldest build the canary has passed on), and `strictAllowlist` needs
 * 2.1.219 and `credentials` 2.1.246, both below it.
 */
export function sandboxSettings(input: SandboxInput): Record<string, unknown> {
  const { home } = input;
  if (!path.isAbsolute(home)) throw new TypeError("sandboxSettings: home must be absolute");
  if (!path.isAbsolute(input.stateDir) || !path.isAbsolute(input.binaryDir)) throw new TypeError("sandboxSettings: stateDir and binaryDir must be absolute");
  const floor = CREDENTIAL_FLOOR.map((entry) => path.join(home, entry));
  if (!path.isAbsolute(input.workspaceRoot) || !path.isAbsolute(input.tempRoot)) throw new TypeError("sandboxSettings: workspaceRoot and tempRoot must be absolute");
  // The protected list (floor, state, binary directory, persistence targets) is never granted, so a grant cannot reopen a write there.
  const listed = protectedPaths({ home, stateDir: input.stateDir, binaryDir: input.binaryDir });
  const guarded = [...listed.noAccess, ...listed.noEdit];
  const workspace = assertGrantable("workspace", input.workspace, home, guarded, [path.normalize(input.workspaceRoot)]);
  const tempDir = assertGrantable("tempDir", input.tempDir, home, guarded, [path.normalize(input.tempRoot)]);
  const mirrorsRoot = input.mirrorsRoot === undefined ? undefined : assertGrantable("mirrors root", input.mirrorsRoot, home, [...guarded, path.normalize(input.workspaceRoot), path.normalize(input.tempRoot)], [input.mirrorsRoot], true);
  const roots = [workspace, tempDir, ...(input.extraRoots ?? []).map((root) => assertGrantable("extra root", root, home, guarded, [root], true)), ...(mirrorsRoot === undefined ? [] : [mirrorsRoot])];
  const extraRead = (input.extraReadPaths ?? []).map((value) => assertGrantable("extra read path", value, home, guarded, roots));
  const extraWrite = (input.extraWritePaths ?? []).map((value) => assertGrantable("extra write path", value, home, guarded, roots));
  if (mirrorsRoot !== undefined) assertMirrorGrants(mirrorsRoot, extraRead, extraWrite);
  const domains = [...new Set([MODEL_HOST, ...(input.registries ?? []), ...(input.extraDomains ?? [])].map(assertPlainHost))];
  const unique = (values: string[]): string[] => [...new Set(values)];
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    excludedCommands: [] as string[],
    autoAllowBashIfSandboxed: false,
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    filesystem: {
      disabled: false,
      allowWrite: unique([workspace, tempDir, ...extraWrite]),
      denyWrite: unique([path.normalize(input.stateDir), path.normalize(input.binaryDir), ...(mirrorsRoot === undefined ? [] : [mirrorsRoot])]),
      denyRead: unique([home, path.normalize(input.stateDir), path.normalize(input.binaryDir), ...(mirrorsRoot === undefined ? [] : [mirrorsRoot])]),
      allowRead: unique([workspace, tempDir, ...extraRead]),
    },
    credentials: { files: floor.map((file) => ({ path: file, mode: "deny" })), envVars: [] as unknown[] },
    network: { allowedDomains: domains, strictAllowlist: true, allowLocalBinding: false },
  };
}

/**
 * Throws unless `block` is a sandbox block that is switched on and cannot fall back to running unconfined. The tier
 * calls this on what it is about to hand the engine, so an empty or disabled block never reaches a spawn.
 */
export function assertEnabledSandbox(block: unknown): asserts block is Record<string, unknown> {
  const b = block as Record<string, unknown> | null;
  if (b === null || typeof b !== "object" || b.enabled !== true || b.failIfUnavailable !== true || b.allowUnsandboxedCommands !== false || b.autoAllowBashIfSandboxed !== false) throw new TypeError("sandbox block is not an enabled, strict one");
}
