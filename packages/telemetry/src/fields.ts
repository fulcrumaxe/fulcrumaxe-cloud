import { redactDeep } from "@fx/runtime/src/redact.js";
import { LABEL_PATTERN, isAllowedErrorCode } from "./errorCodes.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRACE_ID = /^[0-9a-f]{32}$/i;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** The literal path segments of the route table; any other segment is replaced by `:id`. Adopters add theirs. */
export const ROUTE_LITERALS: ReadonlySet<string> = new Set(["api", "v1", "runs", "events"]);

const MAX_ROUTE_SEGMENTS = 16;

/** A path reduced to a template: query and fragment removed, every segment that is not a literal of the
 * route table replaced by `:id`. A value that is not a path is dropped. */
export function routeTemplate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/")) return undefined;
  const path = value.split(/[?#]/, 1)[0]!;
  const segments = path.split("/").slice(1, MAX_ROUTE_SEGMENTS + 1);
  return "/" + segments.map((s) => (s === "" || ROUTE_LITERALS.has(s) ? s : ":id")).join("/");
}

const ID_FIELDS = ["account_id", "run_id", "wf_run_id", "request_id"] as const;
const NUMBER_FIELDS = ["status", "duration_ms", "count"] as const;

/** The fields a telemetry line may carry besides ts/level/service/event. `error_name` and `error_message`
 * are emitted keys sourced ONLY from an Error passed as `error` (the constructor name, or a class's own
 * fixedMessage literal; see `errorFields`), never from caller input: a caller-supplied `error_name` or
 * `error_message` is dropped. */
export const ALLOWED_FIELDS: readonly string[] = [
  ...ID_FIELDS,
  "trace_id",
  "route",
  "stage",
  "error_code",
  "error_name",
  "error_message",
  ...NUMBER_FIELDS,
];

export const MAX_STRING_LENGTH = 2048;

/** Redact the whole string first, truncate the output second: a cut before the scan could leave a token's
 * head too short to match (the scan is chunked and linear, so a long input is safe to scan whole). */
export function sanitizeString(value: string): string {
  return redactDeep(value, []).slice(0, MAX_STRING_LENGTH);
}

function matching(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

/** The value when it is on the shared error-code allowlist (errorCodes.ts), else undefined (dropped). */
function allowedCode(value: unknown): string | undefined {
  return isAllowedErrorCode(value) ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** An Error contributes its class name and `code`, never its message or stack: those are strings the
 * caller (or a library) built and can embed any input. A class may instead declare its own
 * `static fixedMessage = "<literal>"`; that literal is emitted in place of the error's message. */
function errorFields(error: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!(error instanceof Error)) return out;
  const ctor = error.constructor as { name?: unknown; fixedMessage?: unknown };
  // Each is read in its own try, so a throwing getter costs that one field.
  try {
    const name = matching(ctor.name, ERROR_NAME);
    if (name) out.error_name = name;
  } catch {
    // fx-swallow-ok: a field whose getter throws is dropped; the logger cannot report through itself
  }
  try {
    const code = allowedCode((error as { code?: unknown }).code);
    if (code) out.error_code = code;
  } catch {
    // fx-swallow-ok: a field whose getter throws is dropped; the logger cannot report through itself
  }
  try {
    // Own static of the direct constructor only, so a subclass never inherits a parent's text; and the
    // static itself is emitted, never `error.message`, which can be interpolated input.
    if (Object.hasOwn(ctor, "fixedMessage") && typeof ctor.fixedMessage === "string") {
      out.error_message = sanitizeString(ctor.fixedMessage);
    }
  } catch {
    // fx-swallow-ok: a throwing getter costs the message only; the logger cannot report through itself
  }
  return out;
}

/** Keep only allowlisted fields that pass their validator; the rest is dropped, never coerced. `error` is
 * read as input only. Each field is read inside its own try/catch, so a throwing getter costs that field,
 * never the log call. */
export function pickFields(input: Readonly<Record<string, unknown>> | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!input) return out;
  const take = (key: string, read: (value: unknown) => string | number | undefined): void => {
    try {
      if (!Object.hasOwn(input, key)) return;
      const value = read(input[key]);
      if (value !== undefined) out[key] = value;
    } catch {
      // fx-swallow-ok: a field whose getter throws is dropped; the logger cannot report through itself
    }
  };
  for (const key of ID_FIELDS) take(key, (v) => matching(v, UUID));
  take("trace_id", (v) => matching(v, UUID) ?? matching(v, TRACE_ID));
  take("route", routeTemplate);
  take("stage", (v) => matching(v, LABEL_PATTERN));
  for (const key of NUMBER_FIELDS) take(key, numberValue);
  try {
    if (Object.hasOwn(input, "error")) Object.assign(out, errorFields(input.error));
  } catch {
    // fx-swallow-ok: a field whose getter throws is dropped; the logger cannot report through itself
  }
  take("error_code", allowedCode);
  return out;
}
