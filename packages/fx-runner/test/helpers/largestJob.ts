import { randomUUID } from "node:crypto";
import {
  CONTEXT_SPILL_MAX_TOTAL_BYTES,
  MAX_ALLOWANCE_ENTRIES,
  MAX_ALLOWANCE_REASON_CHARS,
  MAX_ALLOWANCE_VALUE_CHARS,
  MAX_CHECK_ARGV,
  MAX_CHECK_ARG_CHARS,
  MAX_EXCLUDE_PATH_CHARS,
  MAX_EXCLUDE_RULES,
  MAX_JOB_MEMORY_BYTES,
  MAX_JOB_PINS,
  MAX_JOB_SCOPE_ENTRIES,
  MAX_JOB_SCOPE_ENTRY_CHARS,
  MAX_ROLE_CARD_CHARS,
  MAX_SPEC_TEXT_CHARS,
  MAX_TASK_PROMPT_CHARS,
  sha256Text,
  type Job,
  type SignedJob,
} from "@fulcrumaxe/runner-protocol";
import { signedJob } from "./signedJob.js";

/** The characters that grow most once written as JSON: a control character and a lone surrogate both become six bytes. */
const CONTROL = "\u0001";
const LONE_SURROGATE = String.fromCharCode(0xd800);

/** A path of exactly `MAX_EXCLUDE_PATH_CHARS` code points, distinct per `index`, built of lone surrogates (six bytes each in JSON) after a short number. */
function longPath(prefix: string, index: number): string {
  const head = `${prefix}${index}`;
  return head + LONE_SURROGATE.repeat(MAX_EXCLUDE_PATH_CHARS - [...head].length);
}

/**
 * The largest job the schema allows and the issuer may sign: every text at its cap and made of characters that take six bytes in JSON, every list full.
 * `spec` / `task` / `role_card` digests match their texts, so `signJob` accepts it.
 */
export function largestSignedJob(): SignedJob {
  const prompt = CONTROL.repeat(MAX_TASK_PROMPT_CHARS);
  const card = CONTROL.repeat(MAX_ROLE_CARD_CHARS);
  const specText = CONTROL.repeat(MAX_SPEC_TEXT_CHARS);
  const over: Partial<Job> = {
    role: "executor",
    mode: "verified",
    spec: { discussion: 2_147_483_647, version: 2_147_483_647, sha256: sha256Text(specText), text: specText },
    task: { kind: "implement", prompt, prompt_sha256: sha256Text(prompt) },
    role_card: { text: card, sha256: sha256Text(card) },
    memory: { person: CONTROL.repeat(MAX_JOB_MEMORY_BYTES), fenced: CONTROL.repeat(MAX_JOB_MEMORY_BYTES) },
    spill: [{ code: "findings", text: CONTROL.repeat(CONTEXT_SPILL_MAX_TOTAL_BYTES) }],
    excludes: Array.from({ length: MAX_EXCLUDE_RULES }, (_, i) => longPath("x", i)),
    pins: { paths: Array.from({ length: MAX_JOB_PINS }, (_, i) => longPath("p", i)), budget_bytes: 2_097_152 },
    // Entries at the cap, distinct per index. The Spec's charset holds no character JSON escapes, so these are the largest the schema accepts.
    scope: Array.from({ length: MAX_JOB_SCOPE_ENTRIES }, (_, i) => `${i}/`.padEnd(MAX_JOB_SCOPE_ENTRY_CHARS, "a")),
    sandbox_allowances: {
      entries: Array.from({ length: MAX_ALLOWANCE_ENTRIES }, (_, i) => ({
        kind: "path" as const,
        value: `/${i}`.padEnd(MAX_ALLOWANCE_VALUE_CHARS, "\\"),
        access: "read" as const,
        reason: LONE_SURROGATE.repeat(MAX_ALLOWANCE_REASON_CHARS),
      })),
      command_timeout_s: 1800,
    },
    check: { argv: Array.from({ length: MAX_CHECK_ARGV }, () => '"'.repeat(MAX_CHECK_ARG_CHARS)), dev_shell: true, timeout_s: 10800 },
    requires_engine: "microvm",
    context_window: 1_000_000,
    model_hint: "m".repeat(100),
    branch_prefix: `${"b".repeat(99)}/`,
    run_id: randomUUID(),
  };
  return signedJob(over);
}
