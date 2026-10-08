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
  /** The repository's declared package registries (hosts), none by default. */
  registries?: readonly string[];
  /** R7's per-job additions, already floor-checked by the caller and checked again here. */
  extraReadPaths?: readonly string[];
  extraWritePaths?: readonly string[];
  extraDomains?: readonly string[];
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

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  // A whole-segment test: a child named `..cache` is inside its parent, a path that climbs out (`..` or `../x`) is not.
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function assertGrantable(label: string, value: string, home: string, floor: readonly string[]): string {
  if (!path.isAbsolute(value) || value.split(path.sep).includes("..") || value !== path.normalize(value)) throw new SandboxGrantRefused(`sandboxSettings: ${label} must be a normalised absolute path`);
  const trimmed = value.length > 1 && value.endsWith(path.sep) ? value.slice(0, -1) : value;
  if (trimmed === home || NEVER_GRANTED.includes(trimmed) || /\.sock$/.test(trimmed)) throw new SandboxGrantRefused(`sandboxSettings: ${label} may not be the home directory, a system directory or a socket`);
  for (const protectedPath of floor) if (inside(protectedPath, trimmed) || inside(trimmed, protectedPath)) throw new SandboxGrantRefused(`sandboxSettings: ${label} overlaps a credential location`);
  return trimmed;
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
 * the same function. Every key here is in the sandboxing documentation for Claude Code 2.1.259, the minimum version
 * this runner supports (`strictAllowlist` needs 2.1.219, `credentials` 2.1.246).
 */
export function sandboxSettings(input: SandboxInput): Record<string, unknown> {
  const { home } = input;
  if (!path.isAbsolute(home)) throw new TypeError("sandboxSettings: home must be absolute");
  if (!path.isAbsolute(input.stateDir) || !path.isAbsolute(input.binaryDir)) throw new TypeError("sandboxSettings: stateDir and binaryDir must be absolute");
  const floor = CREDENTIAL_FLOOR.map((entry) => path.join(home, entry));
  // The runner's state and the agent binary's directory are never granted either, so a grant cannot reopen a write there.
  const guarded = [...floor, path.normalize(input.stateDir), path.normalize(input.binaryDir)];
  const workspace = assertGrantable("workspace", input.workspace, home, guarded);
  const tempDir = assertGrantable("tempDir", input.tempDir, home, guarded);
  const extraRead = (input.extraReadPaths ?? []).map((value) => assertGrantable("extra read path", value, home, guarded));
  const extraWrite = (input.extraWritePaths ?? []).map((value) => assertGrantable("extra write path", value, home, guarded));
  const domains = [...new Set([MODEL_HOST, ...(input.registries ?? []), ...(input.extraDomains ?? [])].map(assertPlainHost))];
  const unique = (values: string[]): string[] => [...new Set(values)];
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    excludedCommands: [] as string[],
    autoAllowBashIfSandboxed: true,
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    filesystem: {
      disabled: false,
      allowWrite: unique([workspace, tempDir, ...extraWrite]),
      denyWrite: [path.normalize(input.stateDir), path.normalize(input.binaryDir)],
      denyRead: [home],
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
  if (b === null || typeof b !== "object" || b.enabled !== true || b.failIfUnavailable !== true || b.allowUnsandboxedCommands !== false) throw new TypeError("sandbox block is not an enabled, strict one");
}
