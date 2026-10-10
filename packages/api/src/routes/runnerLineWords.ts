import { COPY, jobRefusedText, runnerSetupText } from "@fulcrumaxe/runner-protocol";
import type { ActivityLine } from "@fx/core/src/work-items/activity.js";

/**
 * D#6 C42-3: the words of a runner run's `run_ended` line, written once. @fx/core reads the line with its closed reason, detail and size and
 * the plain form of the sentence; this puts in the runner protocol's own sentence for each reason that has one (the same words the Runs
 * app has always shown), then drops the codes. The Pipeline detail and the Runs detail both call it, so the two cannot word a run's end differently.
 * A reason with no sentence in the protocol (`wall_clock`, `runner_shutdown`, `repo_not_private`) keeps core's plain form.
 */
export function runEndedSentence(why: { reason: string; detail: string | null; size_mb: number | null }): string | null {
  switch (why.reason) {
    case "job_refused":
      return jobRefusedText(why.detail ?? "other");
    case "agent_failed":
      return COPY.agentFailed;
    case "push_rejected":
      return COPY.pushRejected;
    case "runner_setup":
      return runnerSetupText(why.detail ?? "other", why.size_mb ?? undefined);
    default:
      return null;
  }
}

export function withRunnerWords(lines: readonly ActivityLine[]): Array<{ at: string; text: string }> {
  return lines.map(({ at, text, ended }) => ({ at, text: (ended && runEndedSentence(ended)) ?? text }));
}
