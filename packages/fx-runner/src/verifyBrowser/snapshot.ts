import { sanitize } from "../assistant/fence.js";

/**
 * D#749 V2c-2a: what the model is shown. Page text is data: it is stripped of control and invisible characters and of links (markdown and bare addresses), cut,
 * and wrapped in the untrusted-content fence (the runner's pinned copy of `@fx/trust`'s `sanitize`, the same one the verify prompt uses). Only our own status words sit
 * outside the fence. The snapshot lists visible interactive elements and a few status elements with refs e1..eN; link targets are never listed.
 */
export const MAX_RESULT_CHARS = 8_000;
export const MAX_SNAPSHOT_CHARS = 20_000;
export const MAX_ELEMENTS = 200;
const PAGE_TEXT_CHARS = 2_000;

/** One element as the page reported it. Every string is page text and is treated as hostile. */
export interface RawElement {
  ref: string;
  tag: string;
  role: string;
  type: string;
  name: string;
  value: string;
  disabled: boolean;
  download: boolean;
}

// Control, bidi and zero-width characters, line and paragraph separators, the byte-order mark.
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

/** Page text as shown to the model and kept in the log: no control characters, no link (its label stays), one blank-line limit, cut. */
export function cleanPageText(raw: string, max: number): string {
  const noLinks = raw.replace(/!?\[([^\]\n]{0,400})\]\([^)\n]{0,2000}\)/g, "$1").replace(/\b[a-z][a-z0-9+.-]{1,12}:\/\/\S+/gi, "[link removed]");
  return noLinks.replace(INVISIBLE, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max).trim();
}

/** Our status line, then the page text inside the fence. */
export function fenced(status: string, text: string): string {
  return text === "" ? status : `${status}\n${sanitize(text)}`;
}

/**
 * The snapshot result: one line per element, `eN role "name"` plus its state, then a slice of the page's own text, cut at `MAX_SNAPSHOT_CHARS`. `observed` is the page
 * content that made it into `text` (names, values, page text), without our refs, roles and labels: that is all an answer may quote.
 */
export function snapshotBody(elements: readonly RawElement[], pageText: string): { text: string; observed: string[] } {
  const lines: string[] = [];
  const observed: string[] = [];
  let size = 0;
  for (const e of elements) {
    const kind = e.role !== "" ? e.role : e.tag === "input" ? `input:${e.type === "" ? "text" : e.type}` : e.tag;
    const name = cleanPageText(e.name, 120);
    const value = e.type === "password" ? "" : cleanPageText(e.value, 80);
    const state = [e.disabled ? "disabled" : "", value === "" ? "" : `value=${JSON.stringify(value)}`].filter(Boolean).join(" ");
    const line = `${e.ref} ${kind} ${JSON.stringify(name)}${state === "" ? "" : ` ${state}`}`;
    if (size + line.length + 1 > MAX_SNAPSHOT_CHARS - PAGE_TEXT_CHARS) break;
    size += line.length + 1;
    lines.push(line);
    observed.push(name, ...(value === "" ? [] : [value]));
  }
  const page = cleanPageText(pageText, PAGE_TEXT_CHARS);
  observed.push(page);
  return { text: `${lines.join("\n")}\n--- page text ---\n${page}`, observed };
}

/**
 * The script the driver runs in the page (ours, never the model's). It tags each visible interactive element with a ref and reports its facts. Nothing is
 * returned that the page could use to make a request: no address, no attribute other than those named.
 */
export const SNAPSHOT_SCRIPT = `(() => {
  for (const old of document.querySelectorAll('[data-fx-ref]')) old.removeAttribute('data-fx-ref');
  const sel = 'a[href],button,input,select,textarea,h1,h2,h3,h4,h5,h6,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[role=status],[role=alert],[aria-live],output';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || (box.width === 0 && box.height === 0)) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && type === 'hidden') continue;
    if (out.length >= ${MAX_ELEMENTS}) break;
    const ref = 'e' + (out.length + 1);
    el.setAttribute('data-fx-ref', ref);
    const name = el.getAttribute('aria-label') || (el.labels && el.labels[0] ? el.labels[0].innerText : '') || el.getAttribute('placeholder') || el.innerText || (['button', 'submit', 'reset'].includes(type) ? el.value : '') || '';
    out.push({ ref, tag, role: el.getAttribute('role') || '', type, name: String(name).slice(0, 200), value: (tag === 'input' && type !== 'password' && type !== 'file') || tag === 'textarea' ?String(el.value || '').slice(0, 200) : '', disabled: !!el.disabled, download: el.hasAttribute('download') });
  }
  return { elements: out, text: (document.body ? document.body.innerText : '').slice(0, ${PAGE_TEXT_CHARS * 2}) };
})()`;
