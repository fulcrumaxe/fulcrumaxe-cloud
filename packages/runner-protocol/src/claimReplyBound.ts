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
