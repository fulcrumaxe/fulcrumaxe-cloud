/**
 * The `decision_request` field of an AGENT_OUTPUT envelope, written beside `next_role_request`
 * (D#7 DP4a). A role that reaches a choice it should not settle alone emits one; the orchestrator
 * (never the agent) resolves it against the decision policy.
 *
 * Canonical shape: `{ type, options, proposed, rationale } | null`. A role with nothing to ask
 * emits `decision_request: null`.
 *
 * The agent supplies the FACTS of a decision and never its class (D#7 C2). A `class` key, or any
 * other key outside the four, is refused with a named code rather than ignored or honoured, so a
 * hostile or confused envelope cannot pick the tier it will be resolved under. What `type` means,
 * which catalogue entry it names and whether this role may name it at all, is the orchestrator's
 * decision (DP4b) against the role's static declaration; this module only checks shape.
 *
 * This file is agent-side: it must not import `@fx/decisions` (D#7 DP4 criterion 3), and a test
 * keeps `src/` free of that import.
 *
 * The bounds match the `decision_asks` raise path (`packages/db/src/decisionAsks.ts`, DP11a), so
 * a request this module accepts is not later refused by the definer on shape alone.
 */

export interface DecisionOption {
  /** `^[a-z][a-z0-9_]{0,31}$`, and never `deny` (reserved for the customer's refusal). */
  id: string;
  /** What the customer reads, at most 200 characters. */
  label: string;
}

export interface DecisionRequest {
  /** The decision type the role is asking about; the orchestrator resolves it. Never a class. */
  type: string;
  /** Two to six distinct options. */
  options: DecisionOption[];
  /** The id of the option the role recommends; one of `options`. */
  proposed: string;
  /** Why, in the role's own words; at most 4 KiB. Untrusted text everywhere it is quoted. */
  rationale: string;
}

/** The value of the `decision_request` field itself: a request, or none. */
export type DecisionRequestField = DecisionRequest | null;

export const DECISION_REQUEST_LIMITS = {
  optionsMin: 2,
  optionsMax: 6,
  labelMax: 200,
  rationaleMaxBytes: 4096,
  typeMax: 64,
  /** The reserved option id: the customer's refusal, never an agent's option. */
  reservedOptionId: "deny",
  /** `decisions_taken` (D#7 R-7-DP4b-7): at most this many entries per envelope, each rationale at most this many bytes. */
  takenMax: 50,
  takenRationaleMaxBytes: 1024,
} as const;

const OPTION_ID = /^[a-z][a-z0-9_]{0,31}$/;
const TYPE_SHAPE = /^[a-z][a-z0-9_]*$/;

/** Why a `decision_request` was refused. The orchestrator branches on the code, never on `detail`. */
export type DecisionRequestErrorCode =
  | "not_an_object"
  | "class_not_allowed"
  | "unknown_field"
  | "bad_type"
  | "bad_options"
  | "bad_option"
  | "duplicate_option_id"
  | "bad_proposed"
  | "bad_rationale";

export interface DecisionRequestError {
  code: DecisionRequestErrorCode;
  /** For a log line or a test; free text, never read by code. */
  detail: string;
}

export type DecisionRequestParse =
  | { ok: true; value: DecisionRequestField }
  | { ok: false; error: DecisionRequestError };

const fail = (code: DecisionRequestErrorCode, detail: string): DecisionRequestParse => ({ ok: false, error: { code, detail } });
const hasText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isOptionId = (v: unknown): v is string =>
  typeof v === "string" && OPTION_ID.test(v) && v !== DECISION_REQUEST_LIMITS.reservedOptionId;

interface EntryParts {
  type: string;
  options: DecisionOption[];
  selected: string;
  rationale: string;
}

/**
 * The part `decision_request` and a `decisions_taken` entry share: `{ type, options, <selector>, rationale }`, where the selector is `proposed`
 * for a request and `chosen` for a decision taken. `selectorCode` is the code a missing or foreign selector gets.
 */
function parseEntry<S extends string, C extends string>(
  v: Record<string, unknown>,
  selector: S,
  selectorCode: C,
  rationaleMaxBytes: number,
): { ok: true; value: EntryParts } | { ok: false; error: { code: DecisionRequestErrorCode | C; detail: string } } {
  const no = (code: DecisionRequestErrorCode | C, detail: string) => ({ ok: false as const, error: { code, detail } });
  // C2: the class is declared statically, never self-reported. Named, so a caller can tell this from noise.
  if (Object.hasOwn(v, "class")) return no("class_not_allowed", "an agent never supplies a decision class");
  const allowed = new Set(["type", "options", selector, "rationale"]);
  for (const key of Object.keys(v)) if (!allowed.has(key)) return no("unknown_field", `unexpected key "${key}"`);

  if (!hasText(v.type) || v.type.length > DECISION_REQUEST_LIMITS.typeMax || !TYPE_SHAPE.test(v.type)) {
    return no("bad_type", "type must be a lowercase identifier");
  }

  const { options } = v;
  if (!Array.isArray(options) || options.length < DECISION_REQUEST_LIMITS.optionsMin || options.length > DECISION_REQUEST_LIMITS.optionsMax) {
    return no("bad_options", `options must hold ${DECISION_REQUEST_LIMITS.optionsMin} to ${DECISION_REQUEST_LIMITS.optionsMax} entries`);
  }
  const clean: DecisionOption[] = [];
  const ids = new Set<string>();
  for (const o of options as unknown[]) {
    if (o === null || typeof o !== "object" || Array.isArray(o)) return no("bad_option", "each option must be an object");
    const opt = o as Record<string, unknown>;
    if (Object.keys(opt).sort().join(",") !== "id,label") return no("bad_option", "each option has exactly id and label");
    if (!isOptionId(opt.id)) return no("bad_option", "option id must match ^[a-z][a-z0-9_]{0,31}$ and not be deny");
    if (typeof opt.label !== "string" || opt.label.length < 1 || opt.label.length > DECISION_REQUEST_LIMITS.labelMax) {
      return no("bad_option", `option label must be 1 to ${DECISION_REQUEST_LIMITS.labelMax} characters`);
    }
    if (ids.has(opt.id)) return no("duplicate_option_id", "option ids must be distinct");
    ids.add(opt.id);
    clean.push({ id: opt.id, label: opt.label });
  }

  const selected = v[selector];
  if (!isOptionId(selected) || !ids.has(selected)) return no(selectorCode, `${selector} must be one of the option ids`);

  if (!hasText(v.rationale) || new TextEncoder().encode(v.rationale).length > rationaleMaxBytes) {
    return no("bad_rationale", `rationale must be non-empty and at most ${rationaleMaxBytes} bytes`);
  }

  return { ok: true, value: { type: v.type, options: clean, selected, rationale: v.rationale } };
}

/**
 * Parses the `decision_request` field of an envelope. Total: any input gives either the typed value
 * or one named refusal, and it never throws. The returned request is a fresh copy holding only the
 * four known keys.
 */
export function parseDecisionRequestField(value: unknown): DecisionRequestParse {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "object" || Array.isArray(value)) return fail("not_an_object", "decision_request must be an object or null");
  const r = parseEntry(value as Record<string, unknown>, "proposed", "bad_proposed", DECISION_REQUEST_LIMITS.rationaleMaxBytes);
  if (!r.ok) return { ok: false, error: r.error };
  const { type, options, selected, rationale } = r.value;
  return { ok: true, value: { type, options, proposed: selected, rationale } };
}

/** One decision the role took itself and reports (D#7 R-7-DP4b-7): `type` is the per-run key it was offered, never a catalogue id. */
export interface DecisionTaken {
  type: string;
  options: DecisionOption[];
  /** The id of the option the role went with; one of `options`. */
  chosen: string;
  /** Why, in the role's own words; at most 1 KiB. Untrusted text everywhere it is quoted. */
  rationale: string;
}

/** The value of the `decisions_taken` field itself: the decisions taken, or none. */
export type DecisionsTakenField = DecisionTaken[] | null;

export type DecisionsTakenErrorCode = Exclude<DecisionRequestErrorCode, "bad_proposed"> | "bad_chosen" | "too_many_entries";

export type DecisionsTakenParse =
  | { ok: true; value: DecisionsTakenField }
  | { ok: false; error: { code: DecisionsTakenErrorCode; detail: string } };

/**
 * Parses the `decisions_taken` field (D#7 DP4b-2), in the same shape as `parseDecisionRequestField`: total, never throws, a fresh copy, and one named
 * refusal for the first fault. A `class` key in any entry is refused by name (C2). More than `takenMax` entries is refused whole, never truncated.
 */
export function parseDecisionsTakenField(value: unknown): DecisionsTakenParse {
  if (value === null) return { ok: true, value: null };
  if (!Array.isArray(value)) return { ok: false, error: { code: "not_an_object", detail: "decisions_taken must be a list or null" } };
  if (value.length > DECISION_REQUEST_LIMITS.takenMax) {
    return { ok: false, error: { code: "too_many_entries", detail: `at most ${DECISION_REQUEST_LIMITS.takenMax} decisions per envelope` } };
  }
  const out: DecisionTaken[] = [];
  for (const entry of value as unknown[]) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: { code: "not_an_object", detail: "each decision taken must be an object" } };
    }
    const r = parseEntry(entry as Record<string, unknown>, "chosen", "bad_chosen", DECISION_REQUEST_LIMITS.takenRationaleMaxBytes);
    if (!r.ok) return { ok: false, error: r.error as { code: DecisionsTakenErrorCode; detail: string } };
    const { type, options, selected, rationale } = r.value;
    out.push({ type, options, chosen: selected, rationale });
  }
  return { ok: true, value: out };
}

/**
 * True if `value` structurally matches `DecisionRequestField`. The structural validator the
 * card-examples test checks every embedded example against, in the shape of `isNextRoleRequestField`.
 */
export function isDecisionRequestField(value: unknown): value is DecisionRequestField {
  return parseDecisionRequestField(value).ok;
}

/** True if `value` structurally matches `DecisionsTakenField`; the card-examples test checks every embedded example against it. */
export function isDecisionsTakenField(value: unknown): value is DecisionsTakenField {
  return parseDecisionsTakenField(value).ok;
}
