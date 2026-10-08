/** Why the engine refused to start, or ended a run. Closed set: each is a reason the runner can report. */
export type EngineRefusalCode = "claude_binary_missing" | "claude_version_unsupported" | "claude_flags_unsupported" | "auth_missing" | "credential_mismatch" | "unknown_role" | "bad_start_options";

/** Thrown by the engine before anything is spawned. `code` is the reason; the message never carries a value from a job or a credential. */
export class EngineRefusal extends Error {
  constructor(readonly code: EngineRefusalCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = "EngineRefusal";
  }
}
