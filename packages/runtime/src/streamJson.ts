/**
 * The stream-json mapper. It moved, unchanged, to `@fulcrumaxe/runner-protocol` (D#6 R4b1-2) so the local runner
 * maps the same lines; this file only re-exports it, so every existing import still resolves.
 */
export { isKnownStreamJsonType, isMalformedAssistant, normalizeMessage } from "@fulcrumaxe/runner-protocol/streamJson";
