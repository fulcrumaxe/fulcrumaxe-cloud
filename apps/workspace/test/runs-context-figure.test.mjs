// apps/workspace/test/runs-context-figure.test.mjs
//
// D#600 CX-9b: how full the run's context window is, state by state: the words (contextNow), the near-limit banner (contextBannerText, contextBanner) and the
// Context section for a run still going. The model half is pure; the banner and section run against a small stand-in for the DOM calls h() makes. The
// real DOM, axe and the phone layout are in e2e/runs-context-figure.spec.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

class FNode {}
class FText extends FNode {
  constructor(t) {
    super();
    this.nodeValue = t;
  }
  get textContent() {
    return this.nodeValue;
  }
}
class FEl extends FNode {
  constructor(tag) {
    super();
    this.tag = tag;
    this.attrs = {};
    this.children = [];
    this.className = "";
    this.listeners = {};
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  get textContent() {
    return this.children.map((c) => c.textContent).join("");
  }
  find(pred, out = []) {
    for (const c of this.children) if (c instanceof FEl) {
      if (pred(c)) out.push(c);
      c.find(pred, out);
    }
    return out;
  }
  byTestId(id) {
    return this.find((e) => e.attrs["data-testid"] === id);
  }
}
const saved = {};
beforeAll(() => {
  saved.document = globalThis.document;
  saved.Node = globalThis.Node;
  globalThis.document = { createElement: (t) => new FEl(t), createTextNode: (t) => new FText(t) };
  globalThis.Node = FNode;
});
afterAll(() => {
  globalThis.document = saved.document;
  globalThis.Node = saved.Node;
});

const { CONTEXT_WORDS, contextBanner, contextBannerText, contextNow, contextSection, readContext } = await import("../apps/runs/runs-detail.js");

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1", "getRunContext");
const fx = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const BAD = /null|undefined|NaN|\[object/;
const read = (name, patch = {}) => readContext({ ...fx(name), ...patch });

describe("contextNow: every state in words, never null, undefined or NaN", () => {
  it("live with a known window: tokens, the window and the whole percent", () => {
    expect(contextNow(read("200-running-figure.json"))).toEqual(["Context now", "150,000 tokens of a 200,000-token window (75%)"]);
  });

  it("ended: the label says the end", () => {
    expect(contextNow(read("200-measured.json"))).toEqual(["Context at the end", "142,000 tokens of a 200,000-token window (71%)"]);
  });

  it("model unknown / window unknown: says so and shows no percent", () => {
    const [, text] = contextNow(read("200-window-unknown.json"));
    expect(text).toBe("54,000 tokens (window not known for this model)");
    expect(text).not.toContain("%");
  });

  it("no figure yet: a sandbox run that has not had a turn says so; a runner run says it is recorded when it ends; an ended run says Not recorded", () => {
    expect(contextNow(read("200-running-not-recorded.json"))).toEqual(["Context now", CONTEXT_WORDS.notYet]);
    expect(contextNow(read("200-running-not-recorded.json", { runtime: "runner" }))).toEqual(["Context now", CONTEXT_WORDS.live]);
    expect(contextNow(read("200-not-recorded.json"))).toEqual(["Context at the end", CONTEXT_WORDS.notRecorded]);
  });

  it("a runner run's ended figure is worded like any other (sizes only)", () => {
    expect(contextNow(read("200-runner.json"))).toEqual(["Context at the end", "88,000 tokens of a 200,000-token window (44%)"]);
  });

  it("junk in the figure fields is not a figure: a negative, fractional, string or zero-window value reads as missing", () => {
    for (const bad of [-1, 1.5, "7", NaN, null]) {
      const c = read("200-running-figure.json", { context_last_tokens: bad });
      expect(c.context_last_tokens).toBeNull();
      expect(contextNow(c)[1]).toBe(CONTEXT_WORDS.notYet);
    }
    expect(read("200-running-figure.json", { context_window_tokens: 0 }).context_window_tokens).toBeNull();
    expect(read("200-running-figure.json", { context_pct: 101 }).context_pct).toBeNull();
    for (const name of ["200-running-figure.json", "200-measured.json", "200-window-unknown.json", "200-not-recorded.json", "200-partial-gateway.json"]) {
      expect(contextNow(read(name)).join(" ")).not.toMatch(BAD);
    }
  });
});

describe("the banner appears from the warning level the server names, and only then", () => {
  it("70 and above shows it (live and ended words differ); 69 does not", () => {
    expect(contextBannerText(read("200-running-figure.json"))).toBe("This run's context is at 75% of the window.");
    expect(contextBannerText(read("200-measured.json"))).toBe("This run's context was at 71% of the window when it ended.");
    expect(contextBannerText(read("200-running-figure.json", { context_pct: 70 }))).toBe("This run's context is at 70% of the window.");
    expect(contextBannerText(read("200-running-figure.json", { context_pct: 69 }))).toBeNull();
  });

  it("the level is the server's, not a number held here", () => {
    expect(contextBannerText(read("200-running-figure.json", { context_pct: 50, context_warn_pct: 50 }))).not.toBeNull();
    expect(contextBannerText(read("200-running-figure.json", { context_pct: 75, context_warn_pct: 80 }))).toBeNull();
    expect(contextBannerText(read("200-running-figure.json", { context_warn_pct: null }))).toBeNull();
  });

  it("no percent (window unknown, no figure, a gateway run) means no banner: nothing is guessed", () => {
    for (const name of ["200-window-unknown.json", "200-running-not-recorded.json", "200-not-recorded.json", "200-partial-gateway.json"]) {
      expect(contextBannerText(read(name)), name).toBeNull();
    }
    expect(contextBannerText(null)).toBeNull();
  });

  it("is a status message with a Dismiss button; dismissed or below the level it is not drawn at all", () => {
    let dismissed = 0;
    const el = contextBanner(read("200-running-figure.json"), false, () => dismissed++);
    expect(el.byTestId("runs-ctx-banner-text")[0].attrs.role).toBe("status");
    expect(el.byTestId("runs-ctx-banner-text")[0].textContent).toBe("This run's context is at 75% of the window.");
    const button = el.byTestId("runs-ctx-banner-dismiss")[0];
    expect(button.textContent).toBe("Dismiss");
    expect(button.attrs.type).toBe("button");
    button.listeners.click();
    expect(dismissed).toBe(1);
    expect(contextBanner(read("200-running-figure.json"), true, () => {})).toBeNull();
    expect(contextBanner(read("200-running-figure.json", { context_pct: 10 }), false, () => {})).toBeNull();
  });

  it("is worked out from the figure on every draw: a lower figure on the next read takes it away with nothing else changed", () => {
    expect(contextBanner(read("200-running-figure.json"), false, () => {})).not.toBeNull();
    expect(contextBanner(read("200-running-figure.json", { context_last_tokens: 40_000, context_pct: 20 }), false, () => {})).toBeNull();
  });
});

describe("the Context section for a run still going", () => {
  it("shows the live figure under the 'recorded when this run ends' line, even with no ledger yet", () => {
    const el = contextSection(read("200-running-figure.json"), () => {});
    expect(el.attrs["data-state"]).toBe("live");
    expect(el.byTestId("runs-ctx-now")[0].textContent).toBe("Context now150,000 tokens of a 200,000-token window (75%)");
    expect(el.textContent).not.toMatch(BAD);
  });

  it("a live run with no figure yet says so; an ended run with no ledger and no figure draws no extra line", () => {
    expect(contextSection(read("200-running-not-recorded.json"), () => {}).byTestId("runs-ctx-now")[0].textContent).toBe("Context now" + CONTEXT_WORDS.notYet);
    expect(contextSection(read("200-not-recorded.json"), () => {}).byTestId("runs-ctx-now")).toEqual([]);
  });

  it("an ended run's facts end with the context at the end", () => {
    const el = contextSection(read("200-measured.json"), () => {});
    expect(el.byTestId("runs-ctx-facts")[0].textContent).toContain("Context at the end142,000 tokens of a 200,000-token window (71%)");
    expect(el.textContent).not.toMatch(BAD);
  });
});
