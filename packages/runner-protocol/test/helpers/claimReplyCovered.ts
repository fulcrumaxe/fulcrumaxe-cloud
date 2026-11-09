/**
 * D#6 RUNNER-REPLY-CAP: every field path reachable in a claim reply and the way `MAX_CLAIM_REPLY_BYTES` (claimReplyBound.ts) covers it. Shared by the test that
 * pins the list to the schema (runner-protocol) and the test that pins it to the largest job (fx-runner), so the two cannot drift apart.
 */

export const ENVELOPE = "envelope: small and fixed in shape, inside CLAIM_REPLY_ENVELOPE_BYTES";
export const CONTAINER = "a container of fields listed beside it";

/** Each reachable path and how the bound covers it. A text, list or free-form value that can be long names the term in `MAX_CLAIM_REPLY_BYTES` that holds it. */
export const COVERED: Record<string, string> = {
  // the reply itself
  signed_job: CONTAINER,
  run_id: ENVELOPE,
  lease_generation: ENVELOPE,
  wake: CONTAINER,
  "wake.poll_s": ENVELOPE,
  "wake.token": ENVELOPE,
  "wake.transport": ENVELOPE,
  merge_order: ENVELOPE,
  deploy_order: ENVELOPE,
  retry_after: ENVELOPE,
  "signed_job.signature": ENVELOPE,
  "signed_job.job": CONTAINER,
  // the job
  "signed_job.job.schema_version": ENVELOPE,
  "signed_job.job.job_id": ENVELOPE,
  "signed_job.job.run_id": ENVELOPE,
  "signed_job.job.repo": CONTAINER,
  "signed_job.job.repo.id": ENVELOPE,
  "signed_job.job.repo.owner": ENVELOPE,
  "signed_job.job.repo.name": ENVELOPE,
  "signed_job.job.repo.private": ENVELOPE,
  "signed_job.job.role": ENVELOPE,
  "signed_job.job.mode": ENVELOPE,
  "signed_job.job.spec": CONTAINER,
  "signed_job.job.spec.discussion": ENVELOPE,
  "signed_job.job.spec.version": ENVELOPE,
  "signed_job.job.spec.sha256": ENVELOPE,
  "signed_job.job.spec.text": "MAX_SPEC_TEXT_CHARS term",
  "signed_job.job.task": CONTAINER,
  "signed_job.job.task.kind": ENVELOPE,
  "signed_job.job.task.prompt": "MAX_TASK_PROMPT_CHARS term",
  "signed_job.job.task.prompt_sha256": ENVELOPE,
  "signed_job.job.role_card": CONTAINER,
  "signed_job.job.role_card.text": "MAX_ROLE_CARD_CHARS term",
  "signed_job.job.role_card.sha256": ENVELOPE,
  "signed_job.job.role_tools_sha256": ENVELOPE,
  "signed_job.job.continues": CONTAINER,
  "signed_job.job.continues.base_sha": ENVELOPE,
  "signed_job.job.continues.branch": ENVELOPE,
  "signed_job.job.continues.parent_run_id": ENVELOPE,
  "signed_job.job.continues.pr_number": ENVELOPE,
  "signed_job.job.continues.session_id": ENVELOPE,
  "signed_job.job.review": CONTAINER,
  "signed_job.job.review.head_sha": ENVELOPE,
  "signed_job.job.sandbox_allowances": CONTAINER,
  "signed_job.job.sandbox_allowances.entries": "MAX_ALLOWANCE_ENTRIES term",
  "signed_job.job.sandbox_allowances.entries.kind": ENVELOPE,
  "signed_job.job.sandbox_allowances.entries.value": "MAX_ALLOWANCE_ENTRIES term",
  "signed_job.job.sandbox_allowances.entries.access": ENVELOPE,
  "signed_job.job.sandbox_allowances.entries.reason": "MAX_ALLOWANCE_ENTRIES term",
  "signed_job.job.sandbox_allowances.command_timeout_s": ENVELOPE,
  "signed_job.job.check": CONTAINER,
  "signed_job.job.check.argv": "MAX_CHECK_ARGV term",
  "signed_job.job.check.dev_shell": ENVELOPE,
  "signed_job.job.check.timeout_s": ENVELOPE,
  "signed_job.job.scope": "MAX_JOB_SCOPE_ENTRIES term",
  "signed_job.job.requires_engine": ENVELOPE,
  "signed_job.job.memory": CONTAINER,
  "signed_job.job.memory.person": "two MAX_JOB_MEMORY_BYTES terms",
  "signed_job.job.memory.fenced": "two MAX_JOB_MEMORY_BYTES terms",
  "signed_job.job.excludes": "MAX_EXCLUDE_RULES term",
  "signed_job.job.pins": CONTAINER,
  "signed_job.job.pins.paths": "MAX_JOB_PINS term",
  "signed_job.job.pins.budget_bytes": ENVELOPE,
  "signed_job.job.spill": "CONTEXT_SPILL_MAX_TOTAL_BYTES term",
  "signed_job.job.spill.code": ENVELOPE,
  "signed_job.job.spill.text": "CONTEXT_SPILL_MAX_TOTAL_BYTES term",
  "signed_job.job.context_window": ENVELOPE,
  "signed_job.job.conflict_round": CONTAINER,
  "signed_job.job.conflict_round.from_sha": ENVELOPE,
  "signed_job.job.conflict_round.base_sha": ENVELOPE,
  "signed_job.job.conflict_round.base_ref": ENVELOPE,
  "signed_job.job.branch_prefix": ENVELOPE,
  "signed_job.job.model_hint": ENVELOPE,
  "signed_job.job.issued_at": ENVELOPE,
  "signed_job.job.expires_at": ENVELOPE,
  "signed_job.job.key_id": ENVELOPE,
};

/** A path whose coverage is a named term of the bound (a long text, list or free-form value), as opposed to the fixed envelope or a container. */
export function namesBoundTerm(path: string): boolean {
  const how = COVERED[path];
  return how !== undefined && how !== ENVELOPE && how !== CONTAINER;
}
