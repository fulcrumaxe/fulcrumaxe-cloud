/**
 * The roles whose finished run can carry a verdict that asks for a fix round. One list for the stage driver (which reads their verdicts) and for the
 * sub-item approval (which anchors a fix round's receipt on one of their runs), so the two cannot disagree. Advisory roles are not on it.
 */
export const VERDICT_ROLES: readonly string[] = ["code-reviewer", "acceptance-tester", "security-reviewer", "debater"];
