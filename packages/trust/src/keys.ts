import { sanitize } from "./sanitize.js";

/**
 * D#597 CC-6a-1 (CC6A-SHARED-KEY-RULE, RUNNER-RECORD-KEYS-FENCE): the one rule for what a reply may show a model unfenced.
 * A key or a code-like value is raw only when it is a plain identifier; anything else is renamed or fenced. The runner ships on its own and
 * cannot import this package, so `packages/fx-runner/src/assistant/fence.ts` carries a copy and a test pins the copy to this file on
 * the same inputs (the same arrangement as `sanitize`).
 */

/**
 * A value of a structural field (a stage, a role, a state): at most 64 characters, and not shaped like one of the control tokens `sanitize` removes
 * (`SPAWN_REQUEST`, `TERMINATE_REQUEST`, `STATUS:<TOKEN>`): those are fenced like any other text.
 */
export const IDENTIFIER = /^(?!status:)(?!.*(?:spawn_request|terminate_request))[A-Za-z0-9_.:+-]{1,64}$/i;
/** The only keys that reach the model: a key can be repo text (a milestone key, a permission name), so anything else is renamed. */
export const PLAIN_KEY = /^(?!.*(?:spawn_request|terminate_request))[A-Za-z][A-Za-z0-9_]{0,63}$/i;
/**
 * Record-typed fields: their keys are data (names a repo or GitHub chose), so every key under one is fenced outright, plain or not.
 * Add a field here when a route returns a map from repo text to a value.
 */
export const RECORD_FIELDS: ReadonlySet<string> = new Set(["per_milestone", "token_permissions"]);

/** A key as the model may see it: itself when plain, else `field_<n>` (n is its position among its siblings). */
export function plainKey(key: string, position: number): string {
  return PLAIN_KEY.test(key) ? key : `field_${position}`;
}

const words = (list: string): ReadonlySet<string> => new Set(list.split(" "));
/**
 * What a structural key may carry raw. A key with a closed vocabulary (a stage, a role, a status) shows a value raw only when it is one of its words, so a
 * 64-character identifier from outside the list is fenced and a snake_case sentence cannot ride a structural key. An id is raw only as a UUID and a time only
 * as an ISO date. `kind` is the one open vocabulary (run events add dotted kinds as the pipeline grows), so it is held to the shape of those names and the
 * control-token rule; text in that shape can only come from server code. A word the list lacks shows fenced, which is still readable: add it here and in the
 * runner's copy (a test pins the two).
 */
export const STRUCTURAL_VOCAB: Readonly<Record<string, ReadonlySet<string>>> = {
  stage: words("triaged discussing spec_ready in_progress pr_opened changes_requested review_passed needs_human merged closed_unmerged closed"),
  provenance: words("internal external"),
  credential_mode: words("subscription api_key"),
  origin: words("person agent"),
  state: words("pending awaiting_confirm running done failed queued succeeded"),
  status: words("pending refused_spend running succeeded failed timed_out killed_spend paused cancelled done partial open not_started pending_spec proposed accepted rejected applied superseded"),
  role: words("executor code-reviewer security-reviewer acceptance-tester debater project-manager technical-architect product-owner cost-analyst performance-expert security-expert researcher feedback-scanner incident-commander browser-tester tui-tester docs-writer release-manager runbook-writer accessibility-reviewer ux-designer mission-analyst run-analyst analytics-engineer visual-verifier quality-sweep fix plane_publish proposal-verifier discovery-analyst"),
  runtime: words("local production runner sandbox hosted"),
  approval: words("auto manual pending approved denied expired cancelled"),
  decision_type: words("start_work_small start_work_bug start_work_doc start_parent_item start_after_reclassify"),
};
const UUID_KEYS = words("id work_item_id parent_run_id repo_id run_id");
const TIME_KEYS = words("created_at updated_at started_at finished_at at");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const KIND = /^(?!.*(?:spawn_request|terminate_request))[a-z][a-z_]{0,31}(?:\.[a-z_]{1,31}){0,3}$/;

/** True when a value under a structural key may reach the model unfenced. */
export function structuralRaw(key: string, value: string): boolean {
  const vocab = Object.hasOwn(STRUCTURAL_VOCAB, key) ? STRUCTURAL_VOCAB[key] : undefined;
  if (vocab !== undefined) return vocab.has(value);
  if (UUID_KEYS.has(key)) return UUID.test(value);
  if (TIME_KEYS.has(key)) return ISO.test(value);
  return key === "kind" ? KIND.test(value) : IDENTIFIER.test(value);
}

/** A code-like value (stage, role, state, result): itself when a plain identifier, else fenced as data. With a key, that key's own rule (above) decides. */
export function structuralValue(value: string, key?: string): string {
  return (key === undefined ? IDENTIFIER.test(value) : structuralRaw(key, value)) ? value : sanitize(Array.from(value).slice(0, 3000).join(""));
}
