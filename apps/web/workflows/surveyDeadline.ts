import { sleep } from "workflow";
import { getWorker } from "../lib/worker";

/**
 * D#845 ON-10b2: the deadline of a project survey run. Arguments are plain ids.
 *
 * Started once by `startSurvey`, after the run exists. A step is one look: the worker's `endSurveyAtDeadline` ends the run `timed_out` (through the run-writer login, whose status hook writes the setup's `survey_timeout`/`deadline`)
 * once the survey's 22 minutes have passed, or says when to look next. The Workflow sleeps until then, and stops the moment a look is final. The step uses the worker facade only: it holds no pool and runs no SQL.
 * A look that throws is a failed step the Workflow retries; the loop's bound covers a run that never changes (one look to learn a late claim's new time, one more for the end, the rest are slack).
 */
export interface SurveyDeadlineArgs { accountId: string; setupId: string; runId: string }

export async function surveyDeadlineStep(a: SurveyDeadlineArgs): Promise<{ final: true } | { final: false; wakeAt: string }> {
  "use step";
  const worker = await getWorker();
  if (worker === null) throw new Error("no worker configured");
  return worker.endSurveyAtDeadline(a);
}

export async function surveyDeadlineWorkflow(args: SurveyDeadlineArgs): Promise<string> {
  "use workflow";
  for (let i = 0; i < 6; i++) {
    const look = await surveyDeadlineStep(args);
    if (look.final) return "final";
    await sleep(new Date(look.wakeAt));
  }
  return "gave_up";
}
