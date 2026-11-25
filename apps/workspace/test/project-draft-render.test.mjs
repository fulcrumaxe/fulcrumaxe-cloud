// apps/workspace/test/project-draft-render.test.mjs
//
// D#845 ON-10a: a survey's PRD is model text about the person's own repository. It is drawn through the public hardened renderer (apps/_lib/markdown.js) and nothing else: this draws the fixture drafts of the
// protocol package (script tags, script-scheme links, raw HTML, a PRD at exactly the 64 KiB cap) and holds that nothing throws, nothing is cut, and only the renderer's few allowed elements appear.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PRD_BYTES, ProjectDraft } from "@fulcrumaxe/runner-protocol";
import { MAX_MARKDOWN_BYTES, TRUNCATED_NOTE, capText, parseMarkdown, renderMarkdown } from "../apps/_lib/markdown.js";
import { prdView } from "../apps/onboarding/onboarding-engine.js";
import { FIXTURE_DRAFTS, HOSTILE_DRAFT, MAX_DRAFT } from "../../../packages/runner-protocol/test/helpers/projectDrafts.ts";

// A stand-in for the few DOM calls h() makes (the same one markdown.test.mjs uses).
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
for (const k of ["href", "rel", "target"]) {
  Object.defineProperty(FakeEl.prototype, k, { set(v) { this.attrs[k] = v; }, get() { return this.attrs[k]; }, configurable: true });
}
const all = (n, out = []) => (out.push(n), n instanceof FakeEl && n.children.forEach((c) => all(c, out)), out);
const text = (n) => all(n).filter((x) => x instanceof FakeText).map((x) => x.text).join("");
const tags = (n) => all(n).filter((x) => x instanceof FakeEl).map((x) => x.tag);
const ALLOWED = new Set(["div", "p", "pre", "code", "strong", "em", "a", "ul", "ol", "li"]);

beforeEach(() => {
  vi.stubGlobal("Node", FakeNode);
  vi.stubGlobal("document", { createElement: (t) => new FakeEl(t), createTextNode: (t) => new FakeText(t) });
});
afterEach(() => vi.unstubAllGlobals());

describe("a survey's PRD through the public renderer", () => {
  it("the protocol's PRD cap is the renderer's own cap, so a draft always shows uncut", () => {
    expect(MAX_PRD_BYTES).toBe(MAX_MARKDOWN_BYTES);
  });

  it("every fixture draft parses as a ProjectDraft", () => {
    for (const [name, d] of Object.entries(FIXTURE_DRAFTS)) expect(ProjectDraft.safeParse(d).success, name).toBe(true);
  });

  it.each(Object.entries(FIXTURE_DRAFTS))("the %s draft renders: no throw, not truncated, only the renderer's own elements", (_name, draft) => {
    const html = renderMarkdown(draft.prd_md);
    expect(capText(draft.prd_md).truncated).toBe(false);
    expect(text(html)).not.toContain(TRUNCATED_NOTE);
    expect(parseMarkdown(draft.prd_md).some((b) => b.t === "p" && b.c.some((n) => n.v === TRUNCATED_NOTE))).toBe(false);
    for (const tag of tags(html)) expect(ALLOWED.has(tag), tag).toBe(true);
  });

  it("the PRD at the cap shows in full: its last bytes are on the page", () => {
    expect(Buffer.byteLength(MAX_DRAFT.prd_md, "utf8")).toBe(MAX_PRD_BYTES);
    const lastWord = MAX_DRAFT.prd_md.trimEnd().split(/\s+/).pop();
    expect(text(renderMarkdown(MAX_DRAFT.prd_md))).toContain(lastWord);
    // One byte more is cut (and says so), which is why the draft's own cap is the renderer's.
    expect(capText(`${MAX_DRAFT.prd_md}x`).truncated).toBe(true);
  });

  it("the hostile draft makes no script, no image and no link but the one https link, and its markup stays text", () => {
    const html = renderMarkdown(HOSTILE_DRAFT.prd_md);
    const t = text(html);
    expect(tags(html)).not.toContain("script");
    expect(tags(html)).not.toContain("img");
    const links = all(html).filter((x) => x instanceof FakeEl && x.tag === "a");
    expect(links.map((l) => l.attrs.href)).toEqual(["https://example.com/docs"]);
    expect(links.every((l) => l.attrs.rel === "noopener noreferrer")).toBe(true);
    expect(t).toContain("<script>alert(1)</script>");
    expect(t).toContain("[click](javascript:alert(1))");
    expect(t).toContain('<img src=x onerror="alert(1)">');
    expect(Object.keys(all(html).filter((x) => x instanceof FakeEl).reduce((acc, e) => ({ ...acc, ...e.attrs }), {})).every((k) => ["class", "href", "rel", "target"].includes(k))).toBe(true);
  });

  it("the roadmap's titles and summaries are drawn as text through the same renderer, markup inert", () => {
    const row = HOSTILE_DRAFT.roadmap[0];
    for (const field of [row.title, row.summary]) {
      const html = renderMarkdown(field);
      expect(tags(html).every((tag) => ALLOWED.has(tag))).toBe(true);
      expect(tags(html)).not.toContain("script");
      expect(all(html).filter((x) => x instanceof FakeEl && x.tag === "a")).toEqual([]);
    }
  });
});

// D#845 ON-11b: the plan review draws a PRD through prdView, the one function its editor, its read-only view and its member view all use.
describe("the plan review's PRD view (ON-11b)", () => {
  it("script tags, script-scheme links and raw HTML in a PRD stay inert text; only the one https link is a link", () => {
    const html = prdView(HOSTILE_DRAFT.prd_md);
    const t = text(html);
    expect(tags(html)).not.toContain("script");
    expect(tags(html)).not.toContain("img");
    expect(all(html).filter((x) => x instanceof FakeEl && x.tag === "a").map((l) => l.attrs.href)).toEqual(["https://example.com/docs"]);
    expect(t).toContain("<script>alert(1)</script>");
    expect(t).toContain("[click](javascript:alert(1))");
    expect(t).toContain('<img src=x onerror="alert(1)">');
    for (const tag of tags(html)) expect(ALLOWED.has(tag) || tag === "div", tag).toBe(true);
    expect(html.attrs["data-testid"]).toBe("ob-plan-prd-view");
  });

  it("every fixture draft shows with no note; a PRD past the renderer's cap says the preview stops and the text is kept", () => {
    for (const draft of Object.values(FIXTURE_DRAFTS)) expect(tags(prdView(draft.prd_md))).not.toContain("script");
    expect(text(prdView(MAX_DRAFT.prd_md))).not.toContain("The preview stops at 64 KiB");
    const over = text(prdView(`${MAX_DRAFT.prd_md}x`));
    expect(over).toContain("The preview stops at 64 KiB. The whole text is kept.");
    expect(over).toContain(TRUNCATED_NOTE);
  });
});
