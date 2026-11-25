import { start } from "workflow/api";
import { surveyDeadlineWorkflow, type SurveyDeadlineArgs } from "../workflows/surveyDeadline";

/** D#845 ON-10b2: the port that starts a survey run's deadline Workflow. A start that is refused rejects; `startSurvey` then ends the run at once. */
export const startSurveyDeadline = async (a: SurveyDeadlineArgs): Promise<void> => {
  await start(surveyDeadlineWorkflow, [a]);
};
