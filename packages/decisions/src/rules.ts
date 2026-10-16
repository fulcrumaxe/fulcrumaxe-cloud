/**
 * Action rules: the pure grammar, validator and evaluator (D#7 AAP-a1, R-7-AAP-5 and R-7-AAP-6).
 *
 * A rule set is a person's ordered list of `{ id, outcome, when }`. The first rule whose condition matches decides; no match leaves the
 * request asking a person. A rule reads only the request's tool, server and arguments, the instance's name and platform-computed facts. It
 * never reads the agent's reasoning or context (C2): the validator refuses such a path, and the evaluator builds its own document from the
 * allowed fields, so even an unvalidated set has nothing else to read. There is no regular expression: strings match by the bounded glob in
 * `ruleGlob.ts`. Everything here is bounded and counted (nodes visited, characters compared) rather than timed, and an evaluation past
 * either budget answers `ask`. No I/O, no clock, no randomness (C1).
 */
import { globMatch } from "./ruleGlob.js";
import { parsePointer, resolvePointer } from "./rulePointer.js";
import type { Disposition } from "./types.js";

export type RuleOutcome = "approve" | "deny" | "ask";
export type RuleValue = string | number | boolean | null;

export type Condition =
  | { readonly op: "all" | "any"; readonly of: readonly Condition[] }
  | { readonly op: "not"; readonly of: Condition }
  | { readonly op: "exists" | "is_empty"; readonly field: string }
  | { readonly op: "equals" | "not_equals"; readonly field: string; readonly value: RuleValue }
  | { readonly op: "in" | "not_in"; readonly field: string; readonly value: readonly RuleValue[] }
  | { readonly op: "lt" | "lte" | "gt" | "gte"; readonly field: string; readonly value: number }
  | { readonly op: "contains" | "starts_with" | "ends_with"; readonly field: string; readonly value: string };

export interface Rule {
  readonly id: string;
  readonly outcome: RuleOutcome;
  readonly when: Condition;
}
export interface RuleSet {
  readonly rules: readonly Rule[];
}

export const RULE_LIMITS = {
  maxDepth: 8,
  maxNodesPerRule: 64,
  maxRules: 200,
  maxListValues: 64,
  maxPatternLength: 256,
  maxPointerLength: 512,
  maxPointerTokens: 16,
  maxRuleIdLength: 64,
  /** A string longer than this is never compared: the evaluation answers `ask`. It is the size of the largest argument document. */
  maxComparedString: 65_536,
} as const;
export const DEFAULT_NODE_BUDGET = 20_000;
export const DEFAULT_WORK_BUDGET = 4_000_000;

export type RuleErrorCode =
  | "not_an_object" | "unknown_key" | "too_many_rules" | "rule_invalid" | "duplicate_rule_id" | "bad_outcome"
  | "depth_exceeded" | "too_many_nodes" | "unknown_operator" | "regex_operator" | "empty_combinator"
  | "field_invalid" | "field_too_long" | "field_not_allowed" | "field_forbidden"
  | "value_invalid" | "list_too_long" | "pattern_too_long";
export interface RuleError {
  readonly code: RuleErrorCode;
  readonly path: string;
}
export type ValidationResult = { readonly ok: true; readonly set: RuleSet } | { readonly ok: false; readonly errors: readonly RuleError[] };

const COMBINATORS = new Set(["all", "any", "not"]);
const NO_VALUE_OPS = new Set(["exists", "is_empty"]);
const SCALAR_OPS = new Set(["equals", "not_equals"]);
const LIST_OPS = new Set(["in", "not_in"]);
const NUMBER_OPS = new Set(["lt", "lte", "gt", "gte"]);
const STRING_OPS = new Set(["contains", "starts_with", "ends_with"]);
/** Operators that look like pattern matching by regular expression. They get their own error so a person is told why, not just "unknown". */
const REGEX_OPS = /^(regex|regexp|re|rlike|match|matches|not_match|not_matches|matches_regex|regex_match|pattern)$/i;
const MAX_ERRORS = 20;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isScalar = (v: unknown): v is RuleValue => v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));

/** Why a field path is not allowed, or `null` when a rule may read it. Roots: request tool, server, arguments (and below), instance name, facts (below). */
export function checkFieldPath(field: unknown): RuleErrorCode | null {
  if (typeof field !== "string") return "field_invalid";
  if (field.length > RULE_LIMITS.maxPointerLength) return "field_too_long";
  const tokens = parsePointer(field);
  if (tokens === null || tokens.length === 0) return "field_invalid";
  if (tokens.length > RULE_LIMITS.maxPointerTokens) return "field_too_long";
  const [root, second] = tokens;
  if (root === "request" && (second === "agent_reasoning" || second === "context")) return "field_forbidden";
  const ok =
    (root === "request" && ((tokens.length === 2 && (second === "tool" || second === "server")) || second === "arguments")) ||
    (root === "instance" && second === "name" && tokens.length === 2) ||
    (root === "facts" && tokens.length >= 2);
  return ok ? null : "field_not_allowed";
}

interface Ctx {
  nodes: number;
  readonly errors: RuleError[];
}

function checkCondition(c: unknown, depth: number, path: string, ctx: Ctx): void {
  const fail = (code: RuleErrorCode, at = path): void => {
    if (ctx.errors.length < MAX_ERRORS) ctx.errors.push({ code, path: at });
  };
  if (depth > RULE_LIMITS.maxDepth) return fail("depth_exceeded");
  if (++ctx.nodes > RULE_LIMITS.maxNodesPerRule) {
    if (ctx.nodes === RULE_LIMITS.maxNodesPerRule + 1) fail("too_many_nodes");
    return;
  }
  if (!isRecord(c) || typeof c.op !== "string") return fail("rule_invalid");
  const op = c.op;
  if (REGEX_OPS.test(op)) return fail("regex_operator", `${path}/op`);
  const known = COMBINATORS.has(op) || NO_VALUE_OPS.has(op) || SCALAR_OPS.has(op) || LIST_OPS.has(op) || NUMBER_OPS.has(op) || STRING_OPS.has(op);
  if (!known) return fail("unknown_operator", `${path}/op`);
  const combinator = COMBINATORS.has(op);
  const allowedKeys = combinator ? ["op", "of"] : NO_VALUE_OPS.has(op) ? ["op", "field"] : ["op", "field", "value"];
  for (const key of Object.keys(c)) if (!allowedKeys.includes(key)) fail("unknown_key", `${path}/${key}`);
  if (combinator) {
    const children = op === "not" ? [c.of] : c.of;
    if (!Array.isArray(children) || children.length === 0) return fail("empty_combinator", `${path}/of`);
    children.forEach((child, i) => checkCondition(child, depth + 1, op === "not" ? `${path}/of` : `${path}/of/${i}`, ctx));
    return;
  }
  const fieldProblem = checkFieldPath(c.field);
  if (fieldProblem) fail(fieldProblem, `${path}/field`);
  if (NO_VALUE_OPS.has(op)) return;
  const v = c.value;
  if (SCALAR_OPS.has(op) && !isScalar(v)) fail("value_invalid", `${path}/value`);
  if (NUMBER_OPS.has(op) && !(typeof v === "number" && Number.isFinite(v))) fail("value_invalid", `${path}/value`);
  if (STRING_OPS.has(op) && typeof v !== "string") fail("value_invalid", `${path}/value`);
  if (LIST_OPS.has(op)) {
    if (!Array.isArray(v) || !v.every(isScalar)) fail("value_invalid", `${path}/value`);
    else if (v.length > RULE_LIMITS.maxListValues) fail("list_too_long", `${path}/value`);
  }
  const patterns = Array.isArray(v) ? v : [v];
  if ((SCALAR_OPS.has(op) || LIST_OPS.has(op)) && patterns.some((p) => typeof p === "string" && p.length > RULE_LIMITS.maxPatternLength)) fail("pattern_too_long", `${path}/value`);
  if (STRING_OPS.has(op) && typeof v === "string" && v.length > RULE_LIMITS.maxPatternLength) fail("pattern_too_long", `${path}/value`);
}

/** Accepts a rule set within the limits, or lists what is wrong with it (at most 20 errors, each with a code and the path it was found at). */
export function validateRuleSet(input: unknown): ValidationResult {
  const errors: RuleError[] = [];
  const fail = (code: RuleErrorCode, path: string): void => {
    if (errors.length < MAX_ERRORS) errors.push({ code, path });
  };
  if (!isRecord(input)) return { ok: false, errors: [{ code: "not_an_object", path: "" }] };
  for (const key of Object.keys(input)) if (key !== "rules") fail("unknown_key", `/${key}`);
  const rules = input.rules;
  if (!Array.isArray(rules)) return { ok: false, errors: [...errors, { code: "rule_invalid", path: "/rules" }] };
  if (rules.length > RULE_LIMITS.maxRules) fail("too_many_rules", "/rules");
  const ids = new Set<string>();
  rules.slice(0, RULE_LIMITS.maxRules).forEach((rule, i) => {
    const path = `/rules/${i}`;
    if (!isRecord(rule)) return fail("rule_invalid", path);
    for (const key of Object.keys(rule)) if (!["id", "outcome", "when"].includes(key)) fail("unknown_key", `${path}/${key}`);
    if (typeof rule.id !== "string" || !/^[A-Za-z0-9_.-]+$/.test(rule.id) || rule.id.length > RULE_LIMITS.maxRuleIdLength) fail("rule_invalid", `${path}/id`);
    else if (ids.has(rule.id)) fail("duplicate_rule_id", `${path}/id`);
    else ids.add(rule.id);
    if (rule.outcome !== "approve" && rule.outcome !== "deny" && rule.outcome !== "ask") fail("bad_outcome", `${path}/outcome`);
    checkCondition(rule.when, 1, `${path}/when`, { nodes: 0, errors });
  });
  return errors.length === 0 ? { ok: true, set: input as unknown as RuleSet } : { ok: false, errors };
}

export interface RuleRequest {
  readonly tool: string;
  readonly server: string;
  readonly arguments: unknown;
  readonly instanceName: string;
}
export type RuleFacts = Readonly<Record<string, unknown>>;
export interface RuleDecision {
  readonly outcome: RuleOutcome;
  readonly ruleId: string | null;
  /** Present only when the answer is `ask` because the evaluation could not be trusted, not because no rule matched. */
  readonly reason?: "rule_budget_exceeded" | "rule_set_invalid" | "rule_value_shape";
}
export interface EvaluateOptions {
  readonly nodeBudget?: number;
  readonly workBudget?: number;
  /** Receives the counters when the evaluation ends, whichever way. Tests assert on these instead of on wall-clock time. */
  readonly onMeter?: (meter: { readonly nodes: number; readonly work: number }) => void;
}

class BudgetExceeded extends Error {}
/** A leaf met a value its operator cannot compare (an array or an object). It ends the whole evaluation in `ask`, before any negation can flip it. */
class ValueShape extends Error {}

/** A condition is false, true, or unknown. Unknown is a missing value seen under a negation: it never matches an approve rule, and it does match deny and ask. */
const F = 0;
const T = 1;
const U = 2;
type Tri = typeof F | typeof T | typeof U;
interface Meter {
  nodes: number;
  work: number;
  readonly nodeBudget: number;
  readonly workBudget: number;
}
/** Charges `work`, refusing a charge that would cross the cap and leaving the running total unchanged, so the meter never reads above the budget. */
function spend(m: Meter, work: number): void {
  if (m.work + work > m.workBudget) throw new BudgetExceeded();
  m.work += work;
}

function sameScalar(actual: unknown, wanted: RuleValue, m: Meter): boolean {
  if (typeof actual === "string") {
    if (actual.length > RULE_LIMITS.maxComparedString) throw new BudgetExceeded();
    if (typeof wanted !== "string") return false;
    const result = globMatch(wanted, actual, m.workBudget - m.work);
    spend(m, result.steps);
    if (result.exhausted) throw new BudgetExceeded();
    return result.matched;
  }
  return actual === wanted;
}

const jsonType = (v: unknown): string => (v === null ? "null" : typeof v);
const isIncomparable = (v: unknown): boolean => typeof v === "object" && v !== null;

function leaf(c: Exclude<Condition, { op: "all" | "any" | "not" }>, document: unknown, m: Meter, negated: boolean): Tri {
  const tokens = parsePointer(c.field);
  if (tokens === null) return F;
  spend(m, tokens.length);
  let found: ReturnType<typeof resolvePointer>;
  try {
    found = resolvePointer(document, tokens);
  } catch {
    // fx-swallow-ok: a read that throws is unreadable, and unreadable evaluates to unknown, never to a match
    return c.op === "exists" ? F : U; // a read that throws is unreadable, which is unknown
  }
  if (c.op === "exists") return found.found ? T : F;
  if (!found.found) return negated || c.op === "not_equals" || c.op === "not_in" ? U : F;
  const v = found.value;
  const shaped = (b: boolean): Tri => (b ? T : F);
  switch (c.op) {
    case "is_empty":
      return shaped(v === "" || (Array.isArray(v) && v.length === 0) || (isRecord(v) && !Object.keys(v).some(() => true)));
    case "equals":
    case "not_equals": {
      if (isIncomparable(v)) throw new ValueShape();
      if (jsonType(v) !== jsonType(c.value)) return U; // a scalar of another type is unreadable: a tool that coerces would read it
      return shaped(sameScalar(v, c.value, m) === (c.op === "equals"));
    }
    case "in":
    case "not_in": {
      if (isIncomparable(v)) throw new ValueShape();
      if (c.value.length > 0 && !c.value.some((entry) => jsonType(entry) === jsonType(v))) return U;
      spend(m, c.value.length);
      const hit = c.value.some((candidate) => sameScalar(v, candidate, m));
      return shaped(hit === (c.op === "in"));
    }
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      if (typeof v !== "number" || !Number.isFinite(v)) return U; // no coercion: the string "10" is unreadable, so unknown
      return shaped(c.op === "lt" ? v < c.value : c.op === "lte" ? v <= c.value : c.op === "gt" ? v > c.value : v >= c.value);
    }
    default: {
      // contains, starts_with, ends_with: literal text (no glob), on a string, or `contains` on an array of strings
      const wanted = (c as { readonly value: string }).value;
      if (Array.isArray(v) && c.op === "contains") {
        spend(m, v.length);
        if (v.some((item) => typeof item !== "string")) return U; // one unreadable element makes the whole leaf unknown
        return shaped(v.some((item) => item === wanted));
      }
      if (isIncomparable(v)) throw new ValueShape();
      if (typeof v !== "string") return U;
      if (v.length > RULE_LIMITS.maxComparedString) throw new BudgetExceeded();
      spend(m, v.length);
      return shaped(c.op === "contains" ? v.includes(wanted) : c.op === "starts_with" ? v.startsWith(wanted) : v.endsWith(wanted));
    }
  }
}

function holds(c: Condition, document: unknown, m: Meter, negated = false): Tri {
  if (++m.nodes > m.nodeBudget) throw new BudgetExceeded();
  switch (c.op) {
    case "all": {
      let result: Tri = T;
      for (const child of c.of) {
        const r = holds(child, document, m, negated);
        if (r === F) return F;
        if (r === U) result = U;
      }
      return result;
    }
    case "any": {
      let result: Tri = F;
      for (const child of c.of) {
        const r = holds(child, document, m, negated);
        if (r === T) return T;
        if (r === U) result = U;
      }
      return result;
    }
    case "not": {
      const r = holds(c.of, document, m, true);
      return r === U ? U : r === T ? F : T;
    }
    default:
      return leaf(c, document, m, negated);
  }
}

/**
 * The first matching rule decides. The set is validated first (an invalid one asks), and the document the rules read is built here from the
 * allowed fields only, so a request that carries `agent_reasoning` or `context` has no way to reach a rule.
 */
export function evaluateRules(set: unknown, request: RuleRequest, facts: RuleFacts, options: EvaluateOptions = {}): RuleDecision {
  const meter: Meter = { nodes: 0, work: 0, nodeBudget: options.nodeBudget ?? DEFAULT_NODE_BUDGET, workBudget: options.workBudget ?? DEFAULT_WORK_BUDGET };
  try {
    const checked = validateRuleSet(set);
    if (!checked.ok) return { outcome: "ask", ruleId: null, reason: "rule_set_invalid" };
    const document = { request: { tool: request.tool, server: request.server, arguments: request.arguments }, instance: { name: request.instanceName }, facts };
    for (const rule of checked.set.rules) {
      const r = holds(rule.when, document, meter);
      // unknown matches only where matching is stricter: never an approve rule
      if (r === T || (r === U && rule.outcome !== "approve")) return { outcome: rule.outcome, ruleId: rule.id };
    }
    return { outcome: "ask", ruleId: null };
  } catch (error) {
    if (error instanceof BudgetExceeded) return { outcome: "ask", ruleId: null, reason: "rule_budget_exceeded" };
    if (error instanceof ValueShape) return { outcome: "ask", ruleId: null, reason: "rule_value_shape" };
    throw error;
  } finally {
    options.onMeter?.({ nodes: meter.nodes, work: meter.work });
  }
}

/** The ceiling the `tool_call` dial puts on a rule: under `ask` an approve rule only asks. Deny and ask are never changed (being stricter is always allowed). */
export function clampRuleOutcome(outcome: RuleOutcome, toolCallDisposition: Disposition): RuleOutcome {
  return outcome === "approve" && toolCallDisposition === "ask" ? "ask" : outcome;
}

const TIGHTENABLE_ASK_TYPES: ReadonlySet<string> = new Set(["spend_past_envelope", "run_extension"]);

/**
 * What a rule may do to a platform-raised ask: make it stricter, never looser, and only for the two types whose facts the platform computes.
 * An `ask` rule asks, a `deny` rule denies, and an `approve` rule changes nothing. Any other type comes back exactly as it was given.
 */
export function tightenAskDisposition(type: string, disposition: Disposition, ruleOutcome: RuleOutcome): Disposition | "deny" {
  if (!TIGHTENABLE_ASK_TYPES.has(type)) return disposition;
  // act < announce < ask < deny: `ask` is already the strictest disposition, so these three answers can never be looser than what was given
  return ruleOutcome === "deny" ? "deny" : ruleOutcome === "ask" ? "ask" : disposition;
}
