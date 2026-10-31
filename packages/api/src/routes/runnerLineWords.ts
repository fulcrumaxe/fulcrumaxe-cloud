import { COPY, checkFailedText, handedOffText, jobRefusedText, resourceLimitText, runnerSetupText } from "@fulcrumaxe/runner-protocol";
import type { ActivityLine } from "@fx/core/src/work-items/activity.js";

/**
 * D#6 C42-3: the words of a runner run's `run_ended` line, written once. @fx/core reads the line with its closed reason, detail and size and
 * the plain form of the sentence; this puts in the runner protocol's own sentence for each reason that has one (the same words the Runs
 * app has always shown), then drops the codes. The Pipeline detail and the Runs detail both call it, so the two cannot word a run's end differently.
 * A reason with no sentence in the protocol (`wall_clock`, `runner_shutdown`, `repo_not_private`) keeps core's plain form.
 */
export function runEndedSentence(why: { reason: string; detail: string | null; size_mb: number | null; memory_limit_bytes?: number | null }, check?: RunEndedCheck): string | null {
  switch (why.reason) {
    case "job_refused":
      return jobRefusedText(why.detail ?? "other");
    case "agent_failed":
      return COPY.agentFailed;
    case "resource_limit":
      return resourceLimitText(why.memory_limit_bytes ?? undefined);
    case "push_rejected":
      return COPY.pushRejected;
    case "handed_off":
      return handedOffText(why.detail);
    case "runner_setup":
      return runnerSetupText(why.detail ?? "other", why.size_mb ?? undefined);
    case "check_failed":
      // D#6 R-CHK-3d: the run's own approved check, by its command when the caller has it (the run view does; the work item's activity has only the reason).
      return checkFailedText(why.detail, check?.result?.reason != null, check?.argv === undefined ? undefined : commandText(check.argv));
    default:
      return null;
  }
}

/** What a run's end line needs of its check: the approved command (when the caller has it) and, once recorded, whether the runner gave a reason it could not run safely. */
export interface RunEndedCheck {
  argv?: readonly string[];
  result?: { reason?: string | null } | null;
}
const COMMAND_CHARS = 80;
/** The approved command as one plain line: control characters become spaces and a long command is cut. */
function commandText(argv: readonly string[]): string {
  const line = argv.join(" ").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return line.length > COMMAND_CHARS ? `${line.slice(0, COMMAND_CHARS)}...` : line;
}

export function withRunnerWords(lines: readonly ActivityLine[], check?: RunEndedCheck): Array<{ at: string; text: string }> {
  return lines.map(({ at, text, ended }) => ({ at, text: (ended && runEndedSentence(ended, check)) ?? text }));
}
