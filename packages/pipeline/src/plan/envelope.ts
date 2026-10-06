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
