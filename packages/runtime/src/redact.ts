/**
 * Credential redaction. The implementation moved to `@fulcrumaxe/runner-protocol` (D#6 R1) so the public runner
 * redacts with the same code; this file only re-exports it, so every existing import still resolves.
 */
export {
  redactDeep,
  redactError,
  redactSecrets,
  redactShapes,
  redactText,
  matchesShape,
  SCAN_CHUNK_CHARS,
  SCAN_OVERLAP_CHARS,
  SK_ANT_ADMIN_PATTERN_SOURCE,
  SK_ANT_API_PATTERN_SOURCE,
  SK_ANT_OAT_PATTERN_SOURCE,
  TELEMETRY_SHAPES,
  TELEMETRY_SHAPE_PATTERN_SOURCES,
  TOKEN_SHAPE_PATTERN_SOURCES,
  VCK_PATTERN_SOURCE,
  type TelemetryShape,
} from "@fulcrumaxe/runner-protocol/redact";
