/**
 * D#483 P2: the one place a pipeline prompt asks for the runner's AGENT_OUTPUT envelope.
 *
 * The runner reads ONLY the final `<!-- AGENT_OUTPUT -->` block of an agent's last message (the parsed JSON becomes
 * the run's envelope, which is what `PanelSeatResult.agentOutput` carries). A prompt that merely says "reply with a
 * JSON object" gets prose around the JSON, and the runner then finds no envelope at all. So every prompt whose answer
 * is read back from a run ends with this block, built here so the marker lines cannot drift between prompts.
 *
 * The marker lines in the returned text are the pipeline's own. Untrusted text reaches a prompt only through
 * `sanitize`, which defangs any marker it carries, so exactly one genuine block is in a prompt: this one, last.
 */
export function agentOutputBlock(exampleJson: string): string[] {
  return ["End your final message with this block, and nothing after it:", "<!-- AGENT_OUTPUT -->", "```json", exampleJson, "```", "<!-- /AGENT_OUTPUT -->"];
}

/** The line that tells a run with a checkout that the checkout is for reading. A run without one ignores it. */
export const READ_ONLY_CHECKOUT_LINE =
  "If the repository is checked out in your working directory, you may read it to ground your answer. Do not change any file.";

/**
 * D#6 R4d-5a (C34 section 3): the one block that teaches the project manager the file-list forms, for the panel Spec prompt, the short Spec prompt and
 * (R4d-5b) the file-list-mode prompt. It is NOT three copies. Its examples are checked against `parseAcceptanceScope` in a test, so the prompt can never teach
 * a form the matcher refuses.
 */
export const ACCEPTANCE_FILES_RULES = [
  "Also give `acceptance_files`: every file this change may create, change or delete, tests included. The platform refuses the pull request if it touches any file not on this list, so keep it as narrow as the change. Each entry is one of:",
  "- an exact path: `src/app/page.tsx`",
  "- everything below a directory: `src/lib/**` (`**` only as the last segment, with at least one directory before it)",
  "- one or more `*` inside a single segment, matching any characters except `/`: `src/lib/*.test.ts`",
  "",
  "An entry may use brace groups for alternatives, `src/{lib,util}/index.ts`: at least two non-empty alternatives, no nesting, and no `/`, `*`, `?`, brackets or parentheses inside a group. Next.js route folders such as `(marketing)`, `[id]`, `[...slug]` or `[[...slug]]` are written literally as whole segments. Nothing else is understood: no `?`, no `[abc]` classes, no lone `**`, no `**` before the last segment, no leading or trailing `/`, no `.` or `..` segments, no spaces or backslashes. Paths are relative to the repository root. One entry that breaks these rules makes the whole list unusable. List a lockfile or generated file only if the change must update it.",
].join("\n");
