import { WORK_ITEM_PRIORITIES } from '../work-items/read.js';
import { CorrectionInputError } from './index.js';


/** The two bodies that are data rather than prose (D#597 CC-2a). Both are one JSON object with fixed keys, checked when the correction is made and again when it is accepted. */
export interface PriorityBody {
  priority: (typeof WORK_ITEM_PRIORITIES)[number];
}
export interface NewItemBody {
  title: string;
  kind: string;
  body: string;
}

/** True when a top-level key appears twice in this (already valid) JSON text: JSON.parse keeps the last one, so what a person reads is not what is applied. Keys are compared decoded, so an escaped spelling counts. */
function hasRepeatedKey(text: string): boolean {
  const seen = new Set<string>();
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      let k = j + 1;
      while (k < text.length && ' \t\r\n'.includes(text[k]!)) k++;
      if (depth === 1 && text[k] === ':') {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (seen.has(key)) return true;
        seen.add(key);
      }
      i = j;
    }
  }
  return false;
}

function parseObject(body: string, keys: readonly string[]): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    // fx-swallow-ok: unparseable text is a refused correction body, not a crash
    throw new CorrectionInputError('this kind of correction needs a JSON body');
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new CorrectionInputError('this kind of correction needs a JSON object');
  if (hasRepeatedKey(body)) throw new CorrectionInputError('a field is repeated in the correction body');
  const got = Object.keys(v);
  if (got.length !== keys.length || !keys.every((k) => got.includes(k))) throw new CorrectionInputError('unexpected fields in the correction body');
  return v as Record<string, unknown>;
}

export function parsePriorityBody(body: string): PriorityBody {
  const o = parseObject(body, ['priority']);
  if (!(WORK_ITEM_PRIORITIES as readonly unknown[]).includes(o.priority)) throw new CorrectionInputError('unknown priority');
  return { priority: o.priority as PriorityBody['priority'] };
}

export function parseNewItemBody(body: string, kinds: readonly string[]): NewItemBody {
  const o = parseObject(body, ['title', 'kind', 'body']);
  if (typeof o.title !== 'string' || o.title.length < 1 || o.title.length > 256) throw new CorrectionInputError('title must be 1 to 256 characters');
  if (typeof o.kind !== 'string' || !kinds.includes(o.kind)) throw new CorrectionInputError('unknown item kind');
  if (typeof o.body !== 'string') throw new CorrectionInputError('body must be text');
  return { title: o.title, kind: o.kind, body: o.body };
}

/** Throws CorrectionInputError when a correction of this kind and body could never be applied. */
export function checkBody(kind: string, body: string, itemKinds: readonly string[]): void {
  if (kind === 'priority') parsePriorityBody(body);
  if (kind === 'new_item') parseNewItemBody(body, itemKinds);
}
