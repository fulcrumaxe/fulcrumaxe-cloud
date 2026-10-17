// apps/workspace/test/pipeline-review-recheck.test.mjs
//
// D#598 P7c (customer-visible): a head that is only a merge of the base branch gets a delta re-check, and the review section says so with the
// approved line. It never shows a second full review row: the re-check starts no reviewer run, so the run list is the one the first review left.
//
// The page is the BUILT one: the workspace is built into a scratch directory (the shipped file, comments stripped, TypeScript compiled)
// and the panel is imported from there, not from the source tree. The DOM stand-in is the one pipeline-insight.test.mjs uses.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { build } from "../build/build.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_PROFILE_PATH = join(HERE, "..", "profiles", "cloud.json");
const LINE = "Re-checked after a merge from main (no code changes)";

class FakeNode {}
class FakeEl extends FakeNode {
  constructor(tag) { super(); this.tag = tag; this.attrs = {}; this.kids = []; this.on = {}; this.className = ""; this.open = false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { this.on[t] = f; }
  appendChild(c) { this.kids.push(c); return c; }
  replaceChildren(...c) { this.kids = c; }
  get textContent() { return this.kids.map((k) => (k instanceof FakeEl ? k.textContent : k.text)).join(""); }
}
const findAll = (el, test, out = []) => (test(el) && out.push(el), el.kids.forEach((k) => k instanceof FakeEl && findAll(k, test, out)), out);
const byId = (root, id) => findAll(root, (e) => e.getAttribute("data-testid") === id);
const flush = () => vi.advanceTimersByTimeAsync(0);

const run = (role, id) => ({ id, role, status: "succeeded", usd: 0.4, created_at: "2026-10-16T10:00:00Z", summary: "ok", lines: [] });
const activity = (extra) => ({
  stage: "review_passed", halted: false, repo: { owner: "acme", name: "app" }, issue_number: 7, pr_number: 12, auto_merge: false,
  comments: [], comments_truncated: false, spec: null,
  runs: [run("code-reviewer", "11111111-1111-4111-8111-111111111111"), run("acceptance-tester", "22222222-2222-4222-8222-222222222222")],
  runs_truncated: false, steps: [], notice: null, actions: [], close_on_github: false, ...extra,
});

let outDir;
let built;
beforeAll(async () => {
  outDir = join(mkdtempSync(join(tmpdir(), "p7c-built-")), "dist");
  const result = build({ profilePath: REAL_PROFILE_PATH, outDir });
  // The build puts the files under a content-hash directory (dist/s/<hash>/); the shipped path is the one the page loads.
  const shipped = readdirSync(join(result.outDir, "s")).map((h) => join(result.outDir, "s", h, "apps", "pipeline", "pipeline-insight.js"));
  expect(shipped).toHaveLength(1);
  built = await import(pathToFileURL(shipped[0]).href);
}, 120_000);
afterAll(() => rmSync(dirname(outDir), { recursive: true, force: true }));

describe("D#598 P7c: the review section after a merge from main (built output)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("Node", FakeNode);
    vi.stubGlobal("document", { hidden: false, createElement: (t) => new FakeEl(t), createTextNode: (text) => ({ text }) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function show(reply) {
    const panel = built.createInsightPanel({ call: async () => structuredClone(reply), setInterval: () => 1, clearInterval() {} });
    panel.start("item-1");
    await flush();
    return panel;
  }

  it("shows the approved line once, and no second full review row", async () => {
    const panel = await show(activity({ review_recheck: { kind: "merge_only", sentence: LINE } }));
    const lines = byId(panel.el, "pl-review-recheck");
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toBe(LINE);
    // Still the two review rows the first review left: the re-check started no reviewer run.
    expect(byId(panel.el, "pl-ins-run").filter((e) => e.getAttribute("data-phase") === "Review")).toHaveLength(2);
    expect(panel.el.textContent).not.toMatch(/null|undefined|NaN/);
  });

  it("shows nothing when the newest review round was a full review (or the server sent no field)", async () => {
    for (const extra of [{ review_recheck: null }, {}]) {
      const panel = await show(activity(extra));
      expect(byId(panel.el, "pl-review-recheck")).toHaveLength(0);
      expect(panel.el.textContent).not.toContain("Re-checked");
    }
  });

  it("ignores a field that is not the merge-only shape (no words of its own)", async () => {
    const panel = await show(activity({ review_recheck: { kind: "something_else", sentence: "x" } }));
    expect(byId(panel.el, "pl-review-recheck")).toHaveLength(0);
  });
});
