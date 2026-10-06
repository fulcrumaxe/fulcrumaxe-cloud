/**
 * The `<!-- AGENT_OUTPUT -->` envelope extractor. It moved, unchanged, to `@fulcrumaxe/runner-protocol` (D#6 R1);
 * this file only re-exports it, so every existing import still resolves.
 */
export { extractAgentOutputEnvelope, MAX_ENVELOPE_INPUT_BYTES } from "@fulcrumaxe/runner-protocol/envelope";
