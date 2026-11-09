import { cleanVerifyText, JOURNEY_ID_RE, MAX_JOURNEYS } from '@fx/core/src/verify/journeys.js';
import { JOURNEY_RESULTS, type JourneyResult, type JourneyResultWord } from '@fx/core/src/verify/rows.js';

/**
 * D#6 V1: the tester's answer, parsed. The pipeline decides; the model's output is only read (R-597-1). The envelope is strict JSON:
 *
 *   { "journeys": [ { "id": "c1", "result": "pass" | "fail" | "blocked", "steps": [ { "did": "...", "dom_fact": "...", "number": 3 } ],
 *                    "console_errors": 0, "undo_checked": true, "reloaded": true } ] }
 *
 * Every key is required except a step's `number`; any other key, at any depth, rejects the whole envelope. An answer over one megabyte is rejected unread.
 * What a page showed (`did`, `dom_fact`) is data: it is cut, stripped of control and invisible characters and markdown links, and kept as text. It never
 * decides anything and nothing here forwards it to a prompt.
 */
export const MAX_ENVELOPE_BYTES = 1_048_576;
export const MAX_STEPS = 20;
export const MAX_STEP_TEXT = 300;
export const MAX_CONSOLE_ERRORS = 100_000;

export type EnvelopeRejection = 'too_large' | 'not_json' | 'bad_shape' | 'extra_key' | 'duplicate_journey' | 'bad_value';
export type ParsedEnvelope = { ok: true; journeys: JourneyResult[] } | { ok: false; rejection: EnvelopeRejection };

const TOP_KEYS = ['journeys'];
const JOURNEY_KEYS = ['id', 'result', 'steps', 'console_errors', 'undo_checked', 'reloaded'];
const STEP_REQUIRED = ['did', 'dom_fact'];
const STEP_KEYS = ['did', 'dom_fact', 'number'];
/** What the tester may answer. `unverified` is the pipeline's own word for a pass it refused, never the model's. */
const MODEL_RESULTS: readonly JourneyResultWord[] = JOURNEY_RESULTS.filter((r) => r !== 'unverified');

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function keysIn(o: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): 'ok' | 'extra_key' | 'bad_shape' {
  const keys = Object.keys(o);
  if (keys.some((k) => !allowed.includes(k))) return 'extra_key';
  return required.every((k) => Object.hasOwn(o, k)) ? 'ok' : 'bad_shape';
}

/** The raw answer: JSON text, or an already parsed value. */
export function parseEnvelope(raw: unknown): ParsedEnvelope {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > MAX_ENVELOPE_BYTES) return { ok: false, rejection: 'too_large' };
    try {
      value = JSON.parse(raw);
    } catch {
      // fx-swallow-ok: unreadable model output is rejected with a closed word; its text is never stored
      return { ok: false, rejection: 'not_json' };
    }
  } else {
    let size: number;
    try {
      size = Buffer.byteLength(JSON.stringify(raw) ?? '', 'utf8');
    } catch {
      // fx-swallow-ok: unreadable model output is rejected with a closed word; its text is never stored
      return { ok: false, rejection: 'not_json' };
    }
    if (size > MAX_ENVELOPE_BYTES) return { ok: false, rejection: 'too_large' };
  }
  if (!isObject(value)) return { ok: false, rejection: 'bad_shape' };
  const top = keysIn(value, TOP_KEYS, TOP_KEYS);
  if (top !== 'ok') return { ok: false, rejection: top };
  const list = value.journeys;
  if (!Array.isArray(list) || list.length > MAX_JOURNEYS) return { ok: false, rejection: 'bad_shape' };

  const seen = new Set<string>();
  const journeys: JourneyResult[] = [];
  for (const entry of list) {
    if (!isObject(entry)) return { ok: false, rejection: 'bad_shape' };
    const k = keysIn(entry, JOURNEY_KEYS, JOURNEY_KEYS);
    if (k !== 'ok') return { ok: false, rejection: k };
    const { id, result, steps, console_errors: consoleErrors, undo_checked: undoChecked, reloaded } = entry;
    if (typeof id !== 'string' || !JOURNEY_ID_RE.test(id)) return { ok: false, rejection: 'bad_value' };
    if (seen.has(id)) return { ok: false, rejection: 'duplicate_journey' };
    seen.add(id);
    if (typeof result !== 'string' || !MODEL_RESULTS.includes(result as JourneyResultWord)) return { ok: false, rejection: 'bad_value' };
    if (typeof undoChecked !== 'boolean' || typeof reloaded !== 'boolean') return { ok: false, rejection: 'bad_value' };
    if (!Number.isInteger(consoleErrors) || (consoleErrors as number) < 0 || (consoleErrors as number) > MAX_CONSOLE_ERRORS) return { ok: false, rejection: 'bad_value' };
    if (!Array.isArray(steps) || steps.length > MAX_STEPS) return { ok: false, rejection: 'bad_shape' };
    const cleanSteps: JourneyResult['steps'] = [];
    for (const step of steps) {
      if (!isObject(step)) return { ok: false, rejection: 'bad_shape' };
      const sk = keysIn(step, STEP_KEYS, STEP_REQUIRED);
      if (sk !== 'ok') return { ok: false, rejection: sk };
      if (typeof step.did !== 'string' || typeof step.dom_fact !== 'string') return { ok: false, rejection: 'bad_value' };
      const out: JourneyResult['steps'][number] = { did: cleanVerifyText(step.did, MAX_STEP_TEXT), dom_fact: cleanVerifyText(step.dom_fact, MAX_STEP_TEXT) };
      if (Object.hasOwn(step, 'number')) {
        if (typeof step.number !== 'number' || !Number.isFinite(step.number) || Math.abs(step.number) > 1e12) return { ok: false, rejection: 'bad_value' };
        out.number = step.number;
      }
      cleanSteps.push(out);
    }
    journeys.push({ id, result: result as JourneyResultWord, steps: cleanSteps, console_errors: consoleErrors as number, undo_checked: undoChecked, reloaded });
  }
  return { ok: true, journeys };
}
