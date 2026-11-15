import type { ExtractErrorCode } from "../extract/index.js";

/** Codes the preview adds to the extract pass's own. Fixed: a message never carries repository, agent, adapter or database text. */
export type PreviewOnlyCode = "cap_not_confirmed" | "capacity" | "not_requested" | "render_failed" | "run_failed" | "setup_payment_required";
export type PreviewCode = ExtractErrorCode | PreviewOnlyCode;

/** A refusal before anything started. */
export class PreviewError extends Error {
  constructor(public readonly code: PreviewCode) {
    super(`site preview refused: ${code}`);
    this.name = "PreviewError";
  }
}

/** The extract codes that mean no agent was started and nothing was spent. */
export const NOTHING_SPENT_CODES: ReadonlySet<PreviewCode> = new Set<PreviewCode>([
  "input_invalid",
  "spend_refused",
  "policy_invalid",
  "sandbox_failed",
  "clone_failed",
  "policy_failed",
]);
