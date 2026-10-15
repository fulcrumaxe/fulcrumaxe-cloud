// apps/workspace/test/runs-context.test.mjs
//
// D#600 CX-8: the Runs app's context panel. The model half (readContext, contextModel) is pure and runs on the contract fixtures of
// GET /api/v1/runs/{id}/context for every state; the view half (contextSection) runs against a small stand-in for the few DOM calls
// h() makes (no jsdom here). The real DOM, the axe check and the phone layout are in e2e/runs-context.spec.ts.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ── a stand-in for the DOM calls h() makes ───────────────────────────────────
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

const { bytesText, contextModel, contextSection, readContext, CONTEXT_WORDS } = await import("../apps/runs/runs-detail.js");
const { runView } = await import("../apps/pipeline/pipeline-insight.js");

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1", "getRunContext");
const fx = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const MEASURED = fx("200-measured.json");
const PARTIAL = fx("200-partial-gateway.json");
const RUNNER = fx("200-runner.json");
const NONE = fx("200-not-recorded.json");
const LIVE = fx("200-running-not-recorded.json");

const BAD = /null|undefined|NaN|\[object/;
const drawn = (body, retry = () => {}) => contextSection(readContext(body), retry);
const panelText = (el) => el.textContent;

describe("sizes and shares", () => {
  it("words a byte count and refuses a non-count", () => {
    expect(bytesText(0)).toBe("0 B");
    expect(bytesText(912)).toBe("912 B");
    expect(bytesText(5320)).toBe("5.2 KiB");
    expect(bytesText(1048576)).toBe("1 MiB");
    for (const bad of [null, undefined, NaN, -1, "7"]) expect(bytesText(bad)).toBeNull();
  });
});

describe("the model, per state", () => {
  it("a measured run: sections in the order recorded with sizes, shares that add up, and the trimmed bytes", () => {
    const m = contextModel(readContext(MEASURED));
    expect(m.state).toBe("ready");
    expect(m.sections.map((r) => r.label)).toEqual(["Boundary", "Role card", "Repo map", "Memory (account, repo, role)", "Spec", "Memory (this item)", "Notes", "Findings", "Output block"]);
    const spec = m.sections.find((r) => r.key === "section-spec");
    expect(spec).toMatchObject({ size: "12.2 KiB", pctText: "36%", pct: 36, trimmed: null });
    expect(m.sections.find((r) => r.key === "section-findings").trimmed).toBe("Trimmed: 3.1 KiB cut");
    expect(m.sections.find((r) => r.key === "section-memory_item").trimmed).toBe("Trimmed: 512 B cut");
    expect(m.sections.every((r) => /^(<1|\d+)%$/.test(r.pctText))).toBe(true);
  });

  it("the cache line reads N of M tokens from cache, and the first turn, the largest context and compactions are worded", () => {
    const m = contextModel(readContext(MEASURED));
    expect(m.cache).toBe("4,200,000 of 4,510,000 tokens from cache");
    expect(m.facts).toEqual([
      ["First turn", "9,800 tokens"],
      ["Largest context", "148,000 tokens"],
      ["Compacted", "Once"],
    ]);
  });

  it("tools returned are listed by name, largest first as the server sends them", () => {
    const m = contextModel(readContext(MEASURED));
    expect(m.tools.map((r) => [r.label, r.pctText])).toEqual([
      ["Files read", "79%"],
      ["Commands run", "18%"],
      ["Searches (Grep)", "3%"],
    ]);
  });

  it("recalled memory is listed by display name and id@version, and the map version is shown", () => {
    const m = contextModel(readContext(MEASURED));
    expect(m.memory.tokens).toBe("930 tokens");
    expect(m.memory.items[0]).toEqual({ name: "Run the pg tests with the local harness", ref: "0d2a41c7@3", title: "0d2a41c7-7a0e-4a63-8d6b-4f4c0a1b2c33@3" });
    expect(m.mapVersion).toBe("v1");
    const el = drawn(MEASURED);
    expect(el.byTestId("runs-ctx-memory")[0].textContent).toContain("Migrations are numbered in order");
    expect(el.byTestId("runs-ctx-map")[0].textContent).toBe("Repo map version: v1");
  });

  it("a partial run: every share is marked estimated and every figure the run did not measure says Not recorded, never 0", () => {
    const m = contextModel(readContext(PARTIAL));
    expect(m.state).toBe("partial");
    expect(m.sections.every((r) => r.pctText.endsWith("(estimated)"))).toBe(true);
    expect(m.facts).toEqual([
      ["First turn", CONTEXT_WORDS.notRecorded],
      ["Largest context", CONTEXT_WORDS.notRecorded],
      ["Compacted", "Not compacted"],
    ]);
    expect(m.cache).toBe("Cache use: Not recorded");
    const el = drawn(PARTIAL);
    expect(el.byTestId("runs-ctx-estimated")[0].attrs.role).toBe("status");
  });

  it("a measured zero is shown as a zero, not as Not recorded", () => {
    const m = contextModel(readContext({ ...MEASURED, first_turn_input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, compactions: 0 }));
    expect(m.facts[0]).toEqual(["First turn", "0 tokens"]);
    expect(m.cache).toBe("0 of 0 tokens from cache");
    expect(m.facts[2]).toEqual(["Compacted", "Not compacted"]);
  });

  it("a run with no ledger says so: Not recorded once it ended, and that it is recorded at the end while it is live", () => {
    expect(contextModel(readContext(NONE))).toEqual({ state: "none", text: CONTEXT_WORDS.none });
    expect(contextModel(readContext(LIVE))).toEqual({ state: "live", text: CONTEXT_WORDS.live });
    expect(contextModel(readContext(NONE)).text).toMatch(/^Not recorded/);
  });

  it("a runner run is labelled and shows sizes and counts only: no memory names and no map version, even if the body held them", () => {
    const hostile = { ...RUNNER, recalled_memory: [{ id: "0d2a41c7-7a0e-4a63-8d6b-4f4c0a1b2c33", name: "/home/someone/secret.txt", version: 2 }], repo_map_version: "v9" };
    const m = contextModel(readContext(hostile));
    expect(m.runner.title).toBe("Contents stayed on your machine");
    expect(m.memory).toBeNull();
    expect(m.mapVersion).toBeNull();
    const text = panelText(drawn(hostile));
    expect(text).toContain("Contents stayed on your machine");
    expect(text).not.toContain("secret.txt");
    expect(text).not.toContain("v9");
  });
});

describe("the view, one test per state: no cell shows null, undefined or NaN", () => {
  const stateOf = (el) => el.attrs["data-state"];

  it("loading", () => {
    const el = contextSection(undefined, () => {});
    expect(stateOf(el)).toBe("loading");
    expect(el.byTestId("runs-ctx-loading")[0].attrs.role).toBe("status");
    expect(panelText(el)).not.toMatch(BAD);
  });

  it("error, with a Retry that calls back", () => {
    let retried = 0;
    const el = contextSection(null, () => retried++);
    expect(stateOf(el)).toBe("error");
    expect(panelText(el)).toContain("isn't available right now");
    const retry = el.byTestId("runs-ctx-retry")[0];
    expect(retry.children[0].nodeValue).toBe("Retry");
    retry.listeners.click();
    expect(retried).toBe(1);
    expect(panelText(el)).not.toMatch(BAD);
  });

  it("a body that is not the contract's shape is the error state, not a half-drawn panel", () => {
    for (const junk of [null, 5, "x", [], {}, { run_id: "r", status: "succeeded" }, { ...MEASURED, recorded: "yes" }]) expect(readContext(junk)).toBeNull();
    expect(stateOf(contextSection(readContext({}), () => {}))).toBe("error");
  });

  it("not recorded", () => {
    const el = drawn(NONE);
    expect(stateOf(el)).toBe("none");
    expect(panelText(el)).toContain("Not recorded for this run.");
    expect(panelText(el)).not.toMatch(BAD);
  });

  it("live and not yet recorded", () => {
    const el = drawn(LIVE);
    expect(stateOf(el)).toBe("live");
    expect(panelText(el)).toContain("Recorded when this run ends.");
    expect(panelText(el)).not.toMatch(BAD);
  });

  it("partial", () => {
    const el = drawn(PARTIAL);
    expect(stateOf(el)).toBe("partial");
    expect(panelText(el)).not.toMatch(BAD);
  });

  it("ready", () => {
    const el = drawn(MEASURED);
    expect(stateOf(el)).toBe("ready");
    expect(panelText(el)).not.toMatch(BAD);
    expect(panelText(el)).toContain("4,200,000 of 4,510,000 tokens from cache");
  });

  it("ready, a runner run", () => {
    const el = drawn(RUNNER);
    expect(stateOf(el)).toBe("ready");
    expect(panelText(el)).not.toMatch(BAD);
    expect(el.byTestId("runs-ctx-runner")[0].textContent).toContain("Contents stayed on your machine");
  });

  it("holes everywhere: a measured run whose every figure is missing still draws words, never null", () => {
    const holes = { ...MEASURED, first_turn_input_tokens: null, peak_context_tokens: null, cache_read_tokens: null, cache_write_tokens: null, memory_tokens: null, compactions: null, sections: [], tool_output: [], recalled_memory: [], repo_map_version: null };
    const el = drawn(holes);
    expect(panelText(el)).not.toMatch(BAD);
    expect(panelText(el)).toContain("Not recorded");
  });

  it("a section with a zero total (nothing to share) says Not recorded for its share and draws no bar", () => {
    const el = drawn({ ...MEASURED, sections: [{ code: "card", bytes: 0, trimmed_bytes: 0 }], tool_output: [] });
    const row = el.byTestId("runs-ctx-row")[0];
    expect(row.find((e) => e.tag === "meter")).toHaveLength(0);
    expect(row.textContent).toContain("Not recorded");
    expect(row.textContent).not.toMatch(BAD);
  });
});

describe("bars never carry a state by colour alone", () => {
  it("every bar is a named meter with its share written next to it", () => {
    for (const body of [MEASURED, PARTIAL, RUNNER]) {
      const el = drawn(body);
      for (const row of el.byTestId("runs-ctx-row")) {
        const meters = row.find((e) => e.tag === "meter");
        if (meters.length === 0) continue;
        expect(meters).toHaveLength(1);
        expect(meters[0].attrs["aria-label"]).toMatch(/ share$/);
        expect(row.byTestId("runs-ctx-pct")[0].textContent).toMatch(/^(<1|\d+)%/);
      }
    }
    const rows = drawn(MEASURED).byTestId("runs-ctx-row");
    expect(rows.every((r) => r.find((e) => e.tag === "meter").length === 1)).toBe(true);
  });

  it("the share under one percent reads <1%, and the bar keeps its rounded value", () => {
    const m = contextModel(readContext({ ...MEASURED, sections: [{ code: "card", bytes: 1, trimmed_bytes: 0 }, { code: "spec", bytes: 10000, trimmed_bytes: 0 }] }));
    expect(m.sections[0]).toMatchObject({ pctText: "<1%", pct: 0 });
  });
});

describe("a runner run's panel holds no path or text field", () => {
  it("its fixture has only ids, fixed names and numbers", () => {
    const strings = [];
    const walk = (v) => {
      if (typeof v === "string") strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(RUNNER);
    expect(strings.filter((s) => /[\\/]/.test(s) || s.includes(" "))).toEqual([]);
  });

  it("everything its panel says is sizes, counts and the fixed words", () => {
    const text = panelText(drawn(RUNNER));
    expect(text).not.toMatch(/[\\/]/);
    expect(text).toMatch(/Contents stayed on your machine/);
  });
});

describe("the contract fixtures all read, and the readers refuse what the contract does not allow", () => {
  it("every fixture reads and draws", () => {
    for (const f of readdirSync(FIXTURES)) {
      const ctx = readContext(fx(f));
      expect(ctx, f).not.toBeNull();
      expect(panelText(contextSection(ctx, () => {})), f).not.toMatch(BAD);
    }
  });

  it("junk entries are dropped and a negative or fractional count is not a figure", () => {
    const ctx = readContext({ ...MEASURED, sections: [{ code: "card", bytes: -4, trimmed_bytes: 0 }, "x", { code: "spec", bytes: 1.5 }, { code: "map", bytes: 8, trimmed_bytes: "7" }], peak_context_tokens: -1, compactions: 1.5, recalled_memory: [{ id: "i", name: "  ", version: 1 }, { id: "i", name: "ok", version: 0 }] });
    expect(ctx.sections).toEqual([{ code: "map", bytes: 8, trimmed_bytes: 0 }]);
    expect(ctx.peak_context_tokens).toBeNull();
    expect(ctx.compactions).toBeNull();
    expect(ctx.recalled_memory).toEqual([]);
  });

  it("the tool's two-word name is never drawn from the body", () => {
    const ctx = readContext({ ...MEASURED, recalled_memory: [{ id: "0d2a41c7-7a0e-4a63-8d6b-4f4c0a1b2c33", name: "Ask Claude Code first", version: 1 }] });
    expect(ctx.recalled_memory[0].name).not.toMatch(/claude[\s_\-. ]*code/i);
  });
});

describe("the Pipeline item links to the run", () => {
  it("a run in the item's list carries its id so the link can open it", () => {
    const id = "6f0f3c52-3f0a-4a3e-9d52-2d5a7c1b9e01";
    expect(runView({ id, role: "executor", status: "succeeded", lines: [] }).id).toBe(id);
    expect(runView({ role: "executor", status: "succeeded", lines: [] }).id).toBe("");
  });
});
