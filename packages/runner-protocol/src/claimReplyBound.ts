/**
 * The most bytes a claim reply can hold, worked out from the caps the job schema enforces. The runner reads a claim reply up to this bound and no further,
 * so a job the cloud was allowed to sign is never cut short, while a reply bigger than any valid job can still never be read whole.
 *
 * A reply is JSON, so the worst text is the one that grows most when written: a control character, or a lone surrogate, becomes six bytes (`\u0001`). A
 * character that needs no escape is at most three bytes per UTF-16 unit, so six per unit (or per byte, for the caps counted in bytes) covers every string.
 * The caps are imported, never copied: a cap raised in the schema raises this bound with it.
 */
import { CONTEXT_SPILL_CODES, CONTEXT_SPILL_MAX_TOTAL_BYTES } from "./contextSpill.js";
import { MAX_EXCLUDE_PATH_CHARS, MAX_EXCLUDE_RULES } from "./excludeRules.js";
import { MAX_JOB_MEMORY_BYTES, MAX_JOB_SCOPE_ENTRIES, MAX_JOB_SCOPE_ENTRY_CHARS, MAX_ROLE_CARD_CHARS, MAX_SPEC_TEXT_CHARS, MAX_TASK_PROMPT_CHARS } from "./job.js";
import { MAX_JOB_PINS } from "./pinRules.js";
import { MAX_ALLOWANCE_ENTRIES, MAX_ALLOWANCE_REASON_CHARS, MAX_ALLOWANCE_VALUE_CHARS, MAX_CHECK_ARGV, MAX_CHECK_ARG_CHARS } from "./sandboxAllowances.js";
import { WAKE_TOKEN_MAX_LENGTH } from "./wake.js";

/** The claim route's path. The runner reads a reply from this path up to `MAX_CLAIM_REPLY_BYTES` and every other reply up to a smaller cap, so both sides of that rule name the one constant. */
export const CLAIM_PATH = "/api/runner/claim";

/** The most bytes one string unit takes once written as JSON. */
export const MAX_JSON_BYTES_PER_UNIT = 6;
/**
 * Room for everything with a small fixed shape: key names, the uuids, digests and timestamps, the run branch, the wake grant, the model hint, a few numbers, the
 * quotes and commas around each list item. Those fields together come to a few KiB; a test builds the largest job and checks the margin.
 */
export const CLAIM_REPLY_ENVELOPE_BYTES = 64 * 1024;
/** Per list item: the quotes, the comma and a key name or two. */
const ITEM_OVERHEAD_BYTES = 64;

const json = (units: number): number => units * MAX_JSON_BYTES_PER_UNIT;

export const MAX_CLAIM_REPLY_BYTES =
  json(MAX_SPEC_TEXT_CHARS) +
  json(MAX_TASK_PROMPT_CHARS) +
  json(MAX_ROLE_CARD_CHARS) +
  // the two memory strings
  2 * json(MAX_JOB_MEMORY_BYTES) +
  // the spill texts, together at most this many bytes, and one entry per closed code
  json(CONTEXT_SPILL_MAX_TOTAL_BYTES) +
  CONTEXT_SPILL_CODES.length * ITEM_OVERHEAD_BYTES +
  // excluded and pinned paths
  (MAX_EXCLUDE_RULES + MAX_JOB_PINS) * (json(MAX_EXCLUDE_PATH_CHARS) + ITEM_OVERHEAD_BYTES) +
  // the Spec's file patterns
  MAX_JOB_SCOPE_ENTRIES * (json(MAX_JOB_SCOPE_ENTRY_CHARS) + ITEM_OVERHEAD_BYTES) +
  // sandbox allowance entries and the approved check
  MAX_ALLOWANCE_ENTRIES * (json(MAX_ALLOWANCE_VALUE_CHARS + MAX_ALLOWANCE_REASON_CHARS) + ITEM_OVERHEAD_BYTES) +
  MAX_CHECK_ARGV * (json(MAX_CHECK_ARG_CHARS) + ITEM_OVERHEAD_BYTES) +
  CLAIM_REPLY_ENVELOPE_BYTES;

/**
 * The most bytes of claim reply the hosted cloud will send. A hosted function's response is limited to about 4.5 MB, so a reply over that could never reach
 * the runner at all; this leaves headroom under it. The runner may keep reading up to `MAX_CLAIM_REPLY_BYTES` (a cloud with no such limit could send more),
 * but this cloud never sends more than this: a job whose reply would exceed it is not issued (`job_too_large`).
 */
export const HOSTED_CLAIM_REPLY_BUDGET_BYTES = 4_000_000;

/** The size a hosted function's response cannot pass; the tests hold the budget under it. */
export const HOSTED_RESPONSE_LIMIT_BYTES = 4_500_000;

/**
 * The one way a claim reply is turned into the bytes that are sent. The claim route answers with `NextResponse.json(body)`, which is `JSON.stringify(body)`
 * in UTF-8; the measure below and the route both mean exactly that, and a test holds the two together.
 */
export function serializeClaimReply(reply: unknown): string {
  return JSON.stringify(reply);
}

/** The bytes `reply` takes on the wire. */
export function claimReplyBytes(reply: unknown): number {
  return Buffer.byteLength(serializeClaimReply(reply), "utf8");
}

/**
 * The size of the claim reply a signed job would travel in, with the fields the job does not fix taken at their largest: the lease generation (a safe
 * integer), a wake grant (its longest token and transport) and the merge-order and deploy-order flags. A job whose reply is over the budget even so is not issued.
 */
export function worstCaseClaimReplyBytes(signedJob: unknown, runId: string): number {
  return claimReplyBytes({
    signed_job: signedJob,
    run_id: runId,
    lease_generation: Number.MAX_SAFE_INTEGER,
    wake: { token: "a".repeat(WAKE_TOKEN_MAX_LENGTH), poll_s: Number.MAX_SAFE_INTEGER, transport: "a".repeat(32) },
    merge_order: true,
    deploy_order: true,
  });
}
