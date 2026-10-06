import { BACKEND_NAME_RE, DEFAULT_BACKEND, type AgentBackend } from "./types.js";

/**
 * D#221 R1a: the backend registry, and the pin check every start and resume runs (C1 §2).
 *
 * A backend is selectable only if it was registered here, and registering demands a hostile-config registration
 * (flag groups that keep the CLI off the workspace's configuration). The contract test in `@fx/runner` runs every
 * registered backend through `runHostileConfigContract` and fails when one is registered here but not there.
 */

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Not registered, or registered without what selection needs. A configuration error, never retried. */
export class BackendNotSelectableError extends Error {
  constructor(public readonly reason: "unknown" | "invalid") {
    super(`backend is not selectable (${reason})`);
    this.name = "BackendNotSelectableError";
  }
}

export interface BackendRegistry {
  /** The registered names, in registration order. */
  names(): readonly string[];
  /** The backend for `name` (the default when `name` is omitted); throws `BackendNotSelectableError` for any other name. */
  select(name?: string): AgentBackend;
}

function assertRegistrable(backend: AgentBackend): void {
  const invalid = (): never => {
    throw new BackendNotSelectableError("invalid");
  };
  if (!BACKEND_NAME_RE.test(backend.name) || !BACKEND_NAME_RE.test(backend.cli)) invalid();
  if (!VERSION_RE.test(backend.cliVersion) || !SHA256_RE.test(backend.cliSha256)) invalid();
  if (backend.baseArgv[0] !== backend.cli) invalid();
  const groups = backend.hostileConfig.requiredArgv;
  if (groups.length === 0 || groups.some((g) => g.length === 0)) invalid();
  // Each registered flag group must really be in the command line this backend builds (start and resume).
  const has = (argv: readonly string[], g: readonly string[]): boolean => argv.some((_, i) => g.every((x, j) => argv[i + j] === x));
  for (const resumeSessionId of [undefined, "sample-session"]) {
    const argv = backend.buildArgv({ cliModel: "sample-model", maxTurns: 1, capUsd: 1, ...(resumeSessionId !== undefined && { resumeSessionId }) });
    if (!groups.every((g) => has(argv, g))) invalid();
  }
}

/** Builds a registry. Throws on a duplicate name or a backend that cannot be registered; the registry is frozen after. */
export function createBackendRegistry(backends: readonly AgentBackend[]): BackendRegistry {
  const byName = new Map<string, AgentBackend>();
  for (const backend of backends) {
    assertRegistrable(backend);
    if (byName.has(backend.name)) throw new BackendNotSelectableError("invalid");
    byName.set(backend.name, backend);
  }
  return Object.freeze({
    names: () => [...byName.keys()],
    select(name: string = DEFAULT_BACKEND): AgentBackend {
      const found = typeof name === "string" && byName.has(name) ? byName.get(name) : undefined;
      if (found === undefined) throw new BackendNotSelectableError("unknown");
      return found;
    },
  });
}


/** The pin check's exit code for "the binary's digest is not the pinned one". The binary has NOT been run. */
export const PIN_EXIT_DIGEST = 4;
/** Any other failure of the check (not found, cannot be read, the version command failed). */
export const PIN_EXIT_OTHER = 5;

/**
 * The one command that checks the pin, as `sh -c SCRIPT NAME CLI SHA256`. Order matters (CWE-345/367):
 *  1. resolve the CLI's name to a file (`command -v`, then `readlink -f`);
 *  2. hash THAT file and compare the hash, in the shell, with the pinned `$2`. A mismatch exits `PIN_EXIT_DIGEST`
 *     and nothing from the file has run, so the digest decision rests on an exit status, never on parsed output;
 *  3. only then run that same resolved path with `--version` (the binary is the pinned one by now).
 * A constant with no data in it. Run with no `cwd`, so nothing in the repo under test is on its path.
 */
export const PIN_CHECK_SCRIPT =
  'p=$(command -v "$1") || exit 5; p=$(readlink -f "$p") || exit 5; h=$(sha256sum "$p") || exit 5; [ "${h%% *}" = "$2" ] || exit 4; "$p" --version || exit 5';
/** `NAME` is how a log or a test double tells this command from the agent's. */
export const PIN_CHECK_NAME = "fx-pin";

/** What the pin check found: "ok", or the SandboxPortError operation to fail with. */
export type PinVerdict = "ok" | "cliVersion" | "cliDigest";

/**
 * Judges the check. The digest verdict comes from the exit status alone (`PIN_EXIT_DIGEST`); stdout is the pinned
 * binary's own `--version` output, read only after the digest matched. Output that overflowed the reader's cap is a
 * failure, never a truncation: the unread tail could hold anything.
 */
export function verifyPin(backend: AgentBackend, exitCode: number | undefined, stdout: string, overflowed = false): PinVerdict {
  if (exitCode === PIN_EXIT_DIGEST) return "cliDigest";
  if (exitCode !== 0 || overflowed) return "cliVersion";
  return stdout.trim().split(/\s+/)[0] === backend.cliVersion ? "ok" : "cliVersion";
}
