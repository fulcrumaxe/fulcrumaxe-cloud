import { checkNotRunReason, readCheckFailedFiles, CHECK_DURATION_MS_MAX, CHECK_EXIT_CODE_MAX, CHECK_SKIPPED_MAX, CHECK_SUMMARY_MAX_BYTES, type DoneCheck } from "@fulcrumaxe/runner-protocol";

/**
 * D#6 R-CHK-3: what a runner's check result may hold for the cloud to store it. The bounds are the ones `run_checks` (migration 0888) enforces. The protocol schema refuses most of
 * what lies outside them, but the cloud does not rely on that: a result that cannot be stored must never abort the transaction that ends the run, and must never count as a pass.
 * `normaliseCheck` returns the closest storable result and the first field that was outside the contract (null when none was). The caller ends the run `check_failed` whenever a field was.
 */
export const CHECK_BOUNDS = { exitCode: CHECK_EXIT_CODE_MAX, durationMs: CHECK_DURATION_MS_MAX, skipped: CHECK_SKIPPED_MAX, summaryChars: CHECK_SUMMARY_MAX_BYTES } as const;

const clampInt = (value: unknown, min: number, max: number): number => (typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min);
const inRange = (value: unknown, min: number, max: number): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

export function normaliseCheck(check: DoneCheck): { check: DoneCheck; outOfContract: string | null; failedFilesDropped: boolean } {
  let bad: string | null = null;
  const flag = (field: string): void => {
    bad ??= field;
  };
  let exit: number | null = check.exit_code;
  if (exit !== null && !inRange(exit, -CHECK_BOUNDS.exitCode, CHECK_BOUNDS.exitCode)) {
    flag("exit_code");
    exit = clampInt(exit, -CHECK_BOUNDS.exitCode, CHECK_BOUNDS.exitCode);
  }
  // A check killed at its cap has no exit status of its own (the table says the same).
  if (check.timed_out && exit !== null) {
    flag("exit_code");
    exit = null;
  }
  let duration = check.duration_ms;
  if (!inRange(duration, 0, CHECK_BOUNDS.durationMs)) {
    flag("duration_ms");
    duration = clampInt(duration, 0, CHECK_BOUNDS.durationMs);
  }
  let skipped: number | null = check.skipped_tests;
  if (skipped !== null && !inRange(skipped, 0, CHECK_BOUNDS.skipped)) {
    flag("skipped_tests");
    skipped = clampInt(skipped, 0, CHECK_BOUNDS.skipped);
  }
  let summary = typeof check.summary === "string" ? check.summary : "";
  // A NUL cannot be stored in text. Stripped, and the result is out of contract.
  if (summary.includes("\u0000")) {
    flag("summary");
    summary = summary.replaceAll("\u0000", "");
  }
  if (summary.length > CHECK_BOUNDS.summaryChars) {
    flag("summary");
    summary = summary.slice(0, CHECK_BOUNDS.summaryChars);
  }
  if (bad !== null) {
    const note = `check result out of range: ${bad}`;
    summary = `${summary.slice(0, CHECK_BOUNDS.summaryChars - note.length - 1)}\n${note}`;
  }
  // D#6 R-CHK-3d: a reason is stored as one of the closed codes (any other word is `other`); free text never goes further. Absent stays absent (an older runner).
  const reason = check.reason === undefined ? {} : { reason: checkNotRunReason(check.reason) };
  // D#6 CHECK-FAILFILES-TO-CLOUD: the failing test files are advice for the card and the fix round, never part of the verdict. A malformed list, or one on a check that did not fail, is dropped
  // whole (the caller logs the fixed code) and nothing else about the result changes.
  const read = readCheckFailedFiles(check.failed_files, check.failed_files_more);
  const failedFilesDropped = !read.ok || (read.value !== null && (exit === 0 || check.timed_out === true));
  const files = read.ok && !failedFilesDropped && read.value !== null ? { failed_files: read.value.files, ...(read.value.more === 0 ? {} : { failed_files_more: read.value.more }) } : {};
  return { check: { exit_code: exit, duration_ms: duration, timed_out: check.timed_out === true, skipped_tests: skipped, summary, ...reason, ...files }, outOfContract: bad, failedFilesDropped };
}
