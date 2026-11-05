import { WORK_ITEM_PRIORITIES } from '../work-items/read.js';
import { removeHiddenMemoryChars } from '@fulcrumaxe/runner-protocol';
import { stripControlTokens } from '@fx/trust';
import { sanitizeMemoryText } from '../memory/index.js';
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
  if (typeof o.title !== 'string') throw new CorrectionInputError('title must be 1 to 256 characters');
  // Cleaned after the parse: what the item is created from is the decoded text, never the JSON text it was escaped in. A person's row keeps its text as confirmed (only
  // what cannot be seen goes, and a control token is stripped); an agent's row was cleaned in full when stored, so this leaves it as it is. Idempotent either way.
  const title = defang(hiddenOnly(o.title));
  if (title.trim() === '' || title.length > 256) throw new CorrectionInputError('title must be 1 to 256 characters');
  if (typeof o.kind !== 'string' || !kinds.includes(o.kind)) throw new CorrectionInputError('unknown item kind');
  if (typeof o.body !== 'string') throw new CorrectionInputError('body must be text');
  return { title, kind: o.kind, body: defang(hiddenOnly(o.body)) };
}

/** Throws CorrectionInputError when a correction of this kind and body could never be applied. */
export function checkBody(kind: string, body: string, itemKinds: readonly string[]): void {
  if (kind === 'priority') parsePriorityBody(body);
  if (kind === 'new_item') parseNewItemBody(body, itemKinds);
}

/** Removes what a person cannot see (hidden characters, line and paragraph separators, control characters other than tab, line feed and carriage return), nothing else. */
function hiddenOnly(text: string): string {
  return removeHiddenMemoryChars(text.replace(/[\u2028\u2029]/g, ' ')).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
}

/** What `stripControlTokens` changes besides the tokens: NFKC and no format characters. If that is all it changed, the text is returned as it came (so H2O written with a subscript stays). */
const FORMAT_CHARS = /[\p{Cf}͏᠎]/gu;
function defang(text: string): string {
  // Judged on the trimmed text: a leading space or line break must not hide a token at the start of a line.
  const trimmed = text.trim();
  const stripped = stripControlTokens(trimmed);
  return stripped === trimmed.normalize('NFKC').replace(FORMAT_CHARS, '') ? text : stripped;
}

/**
 * The one place a correction's text is cleaned, on the cloud side, before it is stored (the runner proxy forwards a model's body unchanged and is not trusted; the
 * assistant tool and the POST route both end here). A JSON body (`new_item`, `priority`) is parsed first and cleaned field by field after, then written back as
 * JSON, so an escaped token (`<!--`, `\u0000`, a token split by an escape) is judged as the text it decodes to. What a field gets depends on who wrote it:
 * an agent's (the assistant, or a token) gets the full memory-text cleaning (`sanitizeMemoryText`: NFKC, hidden characters, control tokens, fences; the joiners real
 * text needs are kept) in JSON fields and in prose; a person's gets only the removal of what cannot be seen, in JSON fields and in prose, so the text they confirm (and
 * its hash) is the text they typed. A person's token stays as typed in what is stored; `parseNewItemBody` and the delivery step strip it where it is used. A JSON body
 * that does not parse, or repeats a key, is cleaned as prose and left for `checkBody` to refuse.
 */
export function cleanCorrectionBody(kind: string, body: string, origin: 'person' | 'agent'): string {
  const clean = origin === 'agent' ? sanitizeMemoryText : hiddenOnly;
  if (kind === 'new_item' || kind === 'priority') {
    try {
      const v: unknown = JSON.parse(body);
      if (typeof v === 'object' && v !== null && !Array.isArray(v) && !hasRepeatedKey(body)) {
        return JSON.stringify(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' ? clean(x) : x])));
      }
    } catch {
      // fx-swallow-ok: not JSON; cleaned as prose below and refused by checkBody
    }
  }
  return clean(body);
}
