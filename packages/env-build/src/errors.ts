export type BuildErrorCode =
  | "unknown_preset" | "image_reference" | "preset_required" | "dockerfile_source_not_planned" | "unknown_service"
  | "base_not_pinned" | "base_mismatch" | "layer_too_large" | "invalid_account_id" | "invalid_size_hint"
  | "invalid_layer_file" | "invalid_layer_env" | "nix_not_planned" | "image_not_planned"
  | "invalid_version_pin" | "tool_not_allowed" | "too_many_tools" | "invalid_rust_toolchain" | "rust_toolchain_path"
  | "rust_toolchain_without_rust" | "inputs_digest_required" | "invalid_inputs_digest";

/**
 * A named refusal. The message names the field or the rule and never carries a customer-supplied value,
 * so it is safe to show, log and put in a support ticket.
 */
export class EnvBuildError extends Error {
  constructor(readonly code: BuildErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "EnvBuildError";
  }
}
