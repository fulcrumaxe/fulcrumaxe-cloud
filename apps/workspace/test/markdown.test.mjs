// apps/workspace/test/markdown.test.mjs
//
// D#37 WS-F2a: the hardened markdown renderer (apps/_lib/markdown.js). The
// parser is pure and tested on its tree; renderMarkdown() is tested against a
// tiny stand-in for the DOM (vitest runs in node here), and runs.spec.ts checks
// the same cases in a real browser under the production CSP.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MARKDOWN_BYTES, TRUNCATED_NOTE, capText, parseMarkdown, renderMarkdown, safeHttpsUrl } from "../apps/_lib/markdown.js";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const EVENTS = JSON.parse(readFileSync(join(V1, "listRunEvents", "200-page.json"), "utf8")).data;
const HOSTILE = EVENTS.filter((e) => e.kind === "agent.output").slice(0, 4).map((e) => e.payload.text);

// A stand-in for the few DOM calls h() makes. Enough to walk the result.
class FakeNode {}
class FakeText extends FakeNode {
  constructor(t) { super(); this.text = t; }
}
class FakeEl extends FakeNode {
  constructor(tag) { super(); this.tag = tag; this.children = []; this.attrs = {}; }
  set className(v) { this.attrs.class = v; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  appendChild(c) { this.children.push(c); }
}
// Properties h() assigns directly when `key in el` is true for a real element.
for (const k of ["href", "rel", "target"]) {
  Object.defineProperty(FakeEl.prototype, k, { set(v) { this.attrs[k] = v; }, get() { return this.attrs[k]; }, configurable: true });
}
const all = (n, out = []) => (out.push(n), n instanceof FakeEl && n.children.forEach((c) => all(c, out)), out);
const text = (n) => all(n).filter((x) => x instanceof FakeText).map((x) => x.text).join("");
const tags = (n) => all(n).filter((x) => x instanceof FakeEl).map((x) => x.tag);

beforeEach(() => {
  vi.stubGlobal("Node", FakeNode);
  vi.stubGlobal("document", { createElement: (t) => new FakeEl(t), createTextNode: (t) => new FakeText(t) });
});
afterEach(() => vi.unstubAllGlobals());

describe("hostile input renders inert", () => {
  it("the fixture carries the three hostile cases", () => {
    expect(HOSTILE).toHaveLength(4);
  });

  it("a script-scheme link makes no <a> and keeps its text", () => {
    const el = renderMarkdown(HOSTILE[0]);
    expect(tags(el)).not.toContain("a");
    expect(text(el)).toContain("[x](javascript:alert(1))");
  });

  it("a link whose URL smuggles an attribute makes no <a>", () => {
    const el = renderMarkdown(HOSTILE[1]);
    expect(tags(el)).not.toContain("a");
    expect(text(el)).toContain('onmouseover="x');
  });

  it("an <img> is text, not an element", () => {
    const el = renderMarkdown(HOSTILE[2]);
    expect(tags(el)).not.toContain("img");
    expect(text(el)).toContain("<img src=x onerror=x>");
  });

  it("a script-scheme link without parentheses makes no <a>", () => {
    const el = renderMarkdown(HOSTILE[3]);
    expect(tags(el)).not.toContain("a");
    expect(text(el)).toContain("[x](javascript:alert)");
  });

  it("no element carries an event-handler attribute", () => {
    for (const src of HOSTILE) {
      for (const n of all(renderMarkdown(src))) {
        if (n instanceof FakeEl) expect(Object.keys(n.attrs).filter((k) => /^on/i.test(k))).toEqual([]);
      }
    }
  });

  it.each(["javascript:alert(1)", "javascript:void", "JaVaScRiPt:void", "data:text/html,x", "http://example.com/", "//example.com/", "/relative", "https://", "https://a b", "https://a\"b", "HTTPS://x.test/\u0000", "https://trusted.test@other.test/", "https://u:p@other.test/", "https://@other.test/"])(
    "%s is not a link target",
    (u) => {
      expect(safeHttpsUrl(u)).toBeNull();
      expect(tags(renderMarkdown("[t](" + u + ")"))).not.toContain("a");
    }
  );
});

describe("links", () => {
  it("an absolute https link is an <a> with rel and target, and the filter reaches its text", () => {
    const el = renderMarkdown("go [docs page](https://example.com/docs?a=1) now", (s) => s.replace("docs page", "DOCS"));
    const a = all(el).find((n) => n instanceof FakeEl && n.tag === "a");
    expect(a.attrs.href).toBe("https://example.com/docs?a=1");
    expect(a.attrs.rel).toBe("noopener noreferrer");
    expect(a.attrs.target).toBe("_blank");
    expect(text(a)).toBe("DOCS");
  });
});

describe("what it reads", () => {
  const kinds = (md) => parseMarkdown(md).map((b) => b.t);

  it("paragraphs, fenced code, lists and inline marks", () => {
    const md = "first *one* and **two** and `three`\n\n```\nlet x = <b>;\n```\n\n- a\n- b\n\n1. c\n2. d";
    expect(kinds(md)).toEqual(["p", "pre", "list", "list"]);
    const el = renderMarkdown(md);
    expect(tags(el)).toEqual(expect.arrayContaining(["p", "em", "strong", "code", "pre", "ul", "ol", "li"]));
    expect(text(el)).toContain("let x = <b>;");
    expect(tags(el)).not.toContain("b");
  });

  it("an unclosed fence runs to the end and an unclosed mark stays text", () => {
    expect(parseMarkdown("```\nabc")).toEqual([{ t: "pre", v: "abc" }]);
    expect(text(renderMarkdown("a *b and **c"))).toBe("a *b and **c");
  });

  it("snake_case words are not emphasis", () => {
    expect(tags(renderMarkdown("a_b_c and claude_code"))).not.toContain("em");
  });

  it("many unclosed openers stay linear", () => {
    const t0 = Date.now();
    renderMarkdown("[".repeat(30000) + "*".repeat(30000) + "`".repeat(3000));
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("no quadratic backtracking", () => {
  const timed = (md) => {
    const t0 = performance.now();
    renderMarkdown(md);
    return performance.now() - t0;
  };

  it("a list line with spaces and U+2028/U+2029 near the cap renders fast", () => {
    for (const sep of ["\u2028", "\u2029"]) {
      expect(timed("- " + " ".repeat(32000) + sep + "x y")).toBeLessThan(50);
      expect(timed("1. " + " ".repeat(32000) + sep + sep + "x y" + sep.repeat(1000))).toBeLessThan(50);
    }
  });

  it("other long single-line shapes stay fast", () => {
    for (const md of [" ".repeat(60000) + "x", "- " + "a ".repeat(30000), "**a ".repeat(15000), "_a ".repeat(20000), "[a](" + "b".repeat(60000)]) {
      expect(timed(md)).toBeLessThan(200);
    }
  });
});

describe("the size cap", () => {
  it("a 70 KiB input is cut to 64 KiB and says so", () => {
    const big = "a".repeat(70 * 1024);
    const cut = capText(big);
    expect(cut.truncated).toBe(true);
    expect(new TextEncoder().encode(cut.text).length).toBeLessThanOrEqual(MAX_MARKDOWN_BYTES);
    const el = renderMarkdown(big);
    expect(text(el).length).toBeLessThanOrEqual(MAX_MARKDOWN_BYTES + TRUNCATED_NOTE.length);
    expect(text(el).endsWith(TRUNCATED_NOTE)).toBe(true);
  });

  it("the cap counts bytes, not characters, and never leaves half a character", () => {
    const cut = capText("é".repeat(40000)); // 80,000 bytes
    expect(cut.truncated).toBe(true);
    expect(cut.text).not.toContain("�");
    expect(new TextEncoder().encode(cut.text).length).toBeLessThanOrEqual(MAX_MARKDOWN_BYTES);
  });

  it("an input under the cap is untouched", () => {
    expect(capText("hello")).toEqual({ text: "hello", truncated: false });
  });
});
