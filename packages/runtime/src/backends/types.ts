/**
 * D#221 R1a: the agent-backend descriptor. A backend is the one place that knows which agent CLI a sandbox runs, how
 * its command line is built, which binary it must be (version AND digest), and which flags keep it from loading the
 * workspace's configuration. Everything here is pure data and pure functions: no SDK, no I/O, no process environment.
 *
 * What it does not own: the egress policy, the prompt delivery, the limits and the metering are the runner's, for
 * every backend alike. A later backend (D#221 R2, R3) adds a descriptor and a line mapper; it changes none of those.
 */

/** A backend's name as it is stored and selected: lower case, short, no punctuation a shell could read. */
export const BACKEND_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** The backend a run uses when none is named. */
export const DEFAULT_BACKEND = "claude-code";

/** What the agent command line is built from. All values are validated by the caller before this is reached. */
export interface BackendArgvInput {
  /** The CLI's own name for the model (not the price-table id). */
  cliModel: string;
  maxTurns: number;
  capUsd: number;
  /** Present on a resume. */
  resumeSessionId?: string;
}

export interface AgentBackend {
  readonly name: string;
  /** The executable's name, resolved on the image's PATH (never a path from the repo). Matches `BACKEND_NAME_RE`. */
  readonly cli: string;
  /** The exact version the image carries; `<cli> --version` must report it before every agent command. */
  readonly cliVersion: string;
  /** The SHA-256 (64 lower-case hex) of the resolved binary; it must match before every agent command. */
  readonly cliSha256: string;
  /** The fixed head of the command line: the executable and the flags that make it load runner-written config only. */
  readonly baseArgv: readonly string[];
  /**
   * The hostile-config contract's registration: flag groups that must appear, contiguous and in order, in every
   * agent argv. A backend with none cannot be registered; the contract test (packages/runner/test/hostileConfig.*) must
   * also run for it before it may be selected.
   */
  readonly hostileConfig: { readonly requiredArgv: readonly (readonly string[])[] };
  /** The full command line for one start or resume. */
  buildArgv(input: BackendArgvInput): string[];
}
