/**
 * The one registry of event codes. A log line's `event` is never caller-built text: it is one of these
 * constants, so nothing a request, run or customer supplied can reach the line through it. Adopters add
 * their codes here in their own PRs.
 */
export const EVENTS = [
  "telemetry.dropped",
  "telemetry.invalid_event",
  // reportError (reportError.ts): a caught server error, as a coded class.
  "error.reported",
  // Used by this package's own tests.
  "telemetry.selftest",
] as const;

export type EventCode = (typeof EVENTS)[number];

/** Shape of a code: lowercase dotted segments, 2 to 5 of them. */
export const EVENT_CODE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,4}$/;

const REGISTERED: ReadonlySet<string> = new Set(EVENTS);

export function isEventCode(value: unknown): value is EventCode {
  return typeof value === "string" && EVENT_CODE_PATTERN.test(value) && REGISTERED.has(value);
}
