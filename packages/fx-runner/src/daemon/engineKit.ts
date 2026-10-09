import type { LocalOnlyEvent } from "@fulcrumaxe/runner-protocol";
import type { CleanEnvOptions, CredentialMode } from "../job/cleanEnv.js";
import type { SessionPlan } from "../job/runJob.js";
import type { InterruptibleRuntime } from "../sandbox/hostSandbox.js";
import type { ProtectedPaths } from "../sandbox/sandboxSettings.js";
import type { GitCapture } from "./git.js";

/** What `doctor` shows of the agent CLI: its version against the minimum, the flags it lacks, and whether a login of the right kind exists. */
export interface EngineReport {
  /** Undefined when `--version` did not parse. */
  version: string | undefined;
  minimumVersion: string;
  versionSupported: boolean;
  /** Undefined when not checked: the version is unreadable or too old, or `--help` could not be read. */
  missingFlags: readonly string[] | undefined;
  /** `unknown` when no login mode was given. */
  login: "yes" | "no" | "unknown";
  /** A short plain label such as `claude.ai`; nothing else of the CLI's answer. */
  authMethod?: string;
}

/**
 * What `fx-runner run` is given of the agent runtime, so that the command itself names no engine (D#6 R4a-2b). The program's entry
 * point builds one for the user's installed agent CLI (`createClaudeKit`); another engine would bring its own.
 */
export interface EngineKit {
  /** Setup time: the absolute real path of the installed agent binary, found once along `searchPath`. Throws an `EngineRefusal` if there is none. */
  locate(searchPath: string): string;
  /** `fx-runner doctor`: what the installed agent CLI at `binaryPath` answers about itself. It makes no model request. */
  inspect(input: { binaryPath: string; envOptions: CleanEnvOptions; stateDir: string; loginMode: "subscription" | "api_key" | undefined }): Promise<EngineReport>;
  /** The runtime for one job, from the `sandbox` block the host tier built for it. */
  makeRuntime(input: {
    binaryPath: string;
    credentials: CredentialMode;
    envOptions: CleanEnvOptions;
    sandboxSettings: Record<string, unknown>;
    protectedPaths: ProtectedPaths;
    stateDir: string;
    onLocalEvent: (event: LocalOnlyEvent) => void;
    /** D#6 R7b: the per-job variables of a job that carries sandbox allowances (see `CleanEnvOptions.jobEnv`); absent for a job without any. */
    jobEnv?: Readonly<Record<string, string>>;
  }): InterruptibleRuntime;
  /** Resume or fresh, from the local session index in the state directory. */
  planSession(stateDir: string, continues: { session_id: string; branch: string } | null): SessionPlan;
  recordSession(stateDir: string, sessionId: string, workspace: string): Promise<void>;
  /** The bounded, shell-less capture the daemon runs git through. */
  capture: GitCapture;
  /** Like `capture`, with a large output limit (8 MB), for `nix print-dev-env`. Absent: no dev shell step is wired (D#6 R7c). */
  captureLarge?: GitCapture;
  /**
   * Runs a program in the foreground on the terminal's own streams (no shell, an explicit environment) and gives its exit code (null if it could
   * not start). The tmux client of `attach` goes through it.
   */
  foreground(command: string, args: readonly string[], env: Record<string, string>): Promise<number | null>;
  /** Resumes a taken-over run's agent session interactively, in its workspace, under the job's own settings (D#6 R4a-7). Throws an `EngineRefusal` if the run has no session left to resume. */
  takeOver(input: { binaryPath: string; credentials: CredentialMode; envOptions: CleanEnvOptions; stateDir: string; runId: string; role: string }): Promise<number | null>;
  /** The same capture with a short piece of the error output kept too: what the sandbox probe (`doctor`) reads its reason from. */
  captureWithStderr(command: string, args: readonly string[], env: Record<string, string>, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;
}
