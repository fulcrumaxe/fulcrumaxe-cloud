import type { AgentRuntime, LocalOnlyEvent } from "@fulcrumaxe/runner-protocol";
import type { CleanEnvOptions, CredentialMode } from "../job/cleanEnv.js";
import type { SessionPlan } from "../job/runJob.js";
import type { ProtectedPaths } from "../sandbox/sandboxSettings.js";
import type { GitCapture } from "./git.js";

/**
 * What `fx-runner run` is given of the agent runtime, so that the command itself names no engine (D#6 R4a-2b). The program's entry
 * point builds one for the user's installed agent CLI (`createClaudeKit`); another engine would bring its own.
 */
export interface EngineKit {
  /** Setup time: the absolute real path of the installed agent binary, found once along `searchPath`. Throws an `EngineRefusal` if there is none. */
  locate(searchPath: string): string;
  /** The runtime for one job, from the `sandbox` block the host tier built for it. */
  makeRuntime(input: {
    binaryPath: string;
    credentials: CredentialMode;
    envOptions: CleanEnvOptions;
    sandboxSettings: Record<string, unknown>;
    protectedPaths: ProtectedPaths;
    stateDir: string;
    onLocalEvent: (event: LocalOnlyEvent) => void;
  }): AgentRuntime;
  /** Resume or fresh, from the local session index in the state directory. */
  planSession(stateDir: string, continues: { session_id: string; branch: string } | null): SessionPlan;
  recordSession(stateDir: string, sessionId: string, workspace: string): Promise<void>;
  /** The bounded, shell-less capture the daemon runs git through. */
  capture: GitCapture;
}
