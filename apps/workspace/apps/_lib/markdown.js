// D#37 WS-F2a: a hardened markdown renderer for untrusted agent output.
// Shared by the Runs app and any later app that shows model text (it lives in
// apps/_lib so no app imports another app's files).
//
// It builds DOM nodes with h() (text nodes and createElement only), so nothing
// the input says can become markup. It reads paragraphs, emphasis, inline code,
// fenced code, lists and links. A link becomes an <a> ONLY for an absolute
// https: URL; every other link, and every other piece of markup-looking text
// (raw tags, script-scheme links, quotes and handlers), is shown as its text.
import { h } from "./dom.js";

export const MAX_MARKDOWN_BYTES = 64 * 1024;
export const TRUNCATED_NOTE = "… (truncated)";
const MAX_DEPTH = 4;

/** Cut to at most MAX_MARKDOWN_BYTES of UTF-8, on a character boundary. */
export function capText(text) {
  const s = String(text);
  if (s.length <= MAX_MARKDOWN_BYTES / 4) return { text: s, truncated: false };
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= MAX_MARKDOWN_BYTES) return { text: s, truncated: false };
  let cut = new TextDecoder().decode(bytes.subarray(0, MAX_MARKDOWN_BYTES));
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return { text: cut, truncated: true };
}

/** An absolute https: URL, or null. Whitespace, quotes and angle brackets are refused outright. */
export function safeHttpsUrl(raw) {
  if (typeof raw === "string" && /^https:\/\/[^/?#]*@/i.test(raw)) return null; // userinfo: "https://trusted@other/" reads as the wrong host
  if (typeof raw !== "string" || !/^https:\/\/[^\s"'<>\\\u0000-\u001f\u007f]+$/i.test(raw)) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

// Every class below stops at the next delimiter, so an unclosed opener costs one
// short scan, never a scan to the end of the text per opener.
const INLINE = /`([^`\n]+)`|\[([^[\]\n]*)\]\(([^()\s]*)\)|\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*|\*(?!\s)([^*\n]+?)(?<!\s)\*|(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])/g;

function inlineNodes(text, depth) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push({ t: "text", v: text.slice(last, m.index) });
    last = m.index + m[0].length;
    if (m[1] !== undefined) out.push({ t: "code", v: m[1] });
    else if (m[2] !== undefined) {
      const href = safeHttpsUrl(m[3]);
      out.push(href ? { t: "link", href, v: m[2] } : { t: "text", v: m[0] });
    } else {
      const inner = m[4] ?? m[5] ?? m[6];
      const kind = m[4] !== undefined ? "strong" : "em";
      out.push(depth < MAX_DEPTH ? { t: kind, c: inlineNodes(inner, depth + 1) } : { t: "text", v: inner });
    }
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

// [\s\S], not ".": \s matches U+2028/2029 and "." does not, so ".*$" after \s+ backtracked quadratically.
const ITEM = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+([\s\S]*)$/;
const FENCE = /^\s{0,3}(```|~~~)/;

/** Text to a plain tree of blocks and inline nodes. No DOM here, so it is unit-tested directly. */
export function parseMarkdown(input) {
  const { text, truncated } = capText(input);
  const lines = text.split(/\r\n|\r|\n/);
  const blocks = [];
  let para = [];
  let list = null;
  const flush = () => {
    if (para.length) blocks.push({ t: "p", c: inlineNodes(para.join("\n"), 0) });
    para = [];
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      flush();
      const code = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ t: "pre", v: code.join("\n") });
    } else if (line.trim() === "") {
      flush();
    } else {
      const item = ITEM.exec(line);
      if (item) {
        const ordered = /\d/.test(item[1]);
        if (!list || list.ordered !== ordered) {
          flush();
          list = { t: "list", ordered, items: [] };
          blocks.push(list);
        }
        list.items.push(inlineNodes(item[2], 0));
      } else {
        list = null;
        para.push(line);
      }
    }
  }
  flush();
  if (truncated) blocks.push({ t: "p", c: [{ t: "text", v: TRUNCATED_NOTE }] });
  return blocks;
}

/**
 * Render to a <div class="md">. `filter` (optional) rewrites every string that
 * is drawn (text, code, link text) before it becomes a text node.
 */
export function renderMarkdown(input, filter = (s) => s) {
  const node = (n) => {
    switch (n.t) {
      case "text": return filter(n.v);
      case "code": return h("code", null, filter(n.v));
      case "strong": return h("strong", null, n.c.map(node));
      case "em": return h("em", null, n.c.map(node));
      case "link": return h("a", { href: n.href, rel: "noopener noreferrer", target: "_blank" }, filter(n.v));
      default: return null;
    }
  };
  const block = (b) => {
    if (b.t === "p") return h("p", null, b.c.map(node));
    if (b.t === "pre") return h("pre", null, h("code", null, filter(b.v)));
    return h(b.ordered ? "ol" : "ul", null, b.items.map((it) => h("li", null, it.map(node))));
  };
  return h("div", { class: "md" }, parseMarkdown(input).map(block));
}
