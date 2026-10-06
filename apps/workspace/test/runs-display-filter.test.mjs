// apps/workspace/test/runs-display-filter.test.mjs
//
// D#37 WS-F2a: the display filter rewrites what is drawn and never what is stored.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { crossesBoundary, displayText, hasToolName, nextCarry } from "../apps/runs/runs-display-filter.js";

const GATE = /claude[\s_\-. ]*code/i; // the pattern claude-code-gate.spec.ts asserts
const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");

describe("displayText", () => {
  it.each([
    ["Generated with Claude Code", "Generated with Claude"],
    ["the tool is claude_code here", "the tool is Claude here"],
    ["Claude&nbsp;Code", "Claude"],
    ["CLAUDE-code", "Claude"],
    ["claude.code and Claude   Code", "Claude and Claude"],
    ["Claude Code", "Claude"],
    ["Claude&NBSP;&nbsp;Code", "Claude"],
    ["claudecode", "Claude"],
  ])("%j -> %j, with nothing left that the gate matches", (input, out) => {
    expect(displayText(input)).toBe(out);
    expect(displayText(input)).not.toMatch(GATE);
  });

  it("leaves other text alone, including the product name and unrelated entities", () => {
    expect(displayText("Powered by Claude")).toBe("Powered by Claude");
    expect(displayText("a&nbsp;b <c> code")).toBe("a&nbsp;b <c> code");
    expect(displayText(null)).toBe("");
    expect(displayText(12)).toBe("12");
  });

  it("filters every match, not just the first", () => {
    expect(displayText("claude code, Claude Code, claude_code")).toBe("Claude, Claude, Claude");
  });

  it("does not change the stored fixture text", () => {
    const events = JSON.parse(readFileSync(join(V1, "listRunEvents", "200-page.json"), "utf8")).data;
    const stored = events.filter((e) => e.kind === "agent.output").map((e) => e.payload.text);
    const before = JSON.stringify(events);
    expect(stored.some((t) => GATE.test(t))).toBe(true); // the fixture really holds the name
    for (const t of stored) expect(displayText(t)).not.toMatch(GATE);
    expect(JSON.stringify(events)).toBe(before);
  });
});

describe("hasToolName", () => {
  it("is the gate's pattern", () => {
    expect(hasToolName("Claude Code")).toBe(true);
    expect(hasToolName("Claude")).toBe(false);
  });
});

// WS-F2c: invisible characters cannot hide the name. Each one is tried in three places
// (inside "Claude", between the words, inside "Code"). Look-alike letters from other
// scripts (confusables) are out of scope and are not tested.
describe("invisible characters", () => {
  const INVISIBLE = { ZWSP: "\u200b", ZWNJ: "\u200c", ZWJ: "\u200d", WJ: "\u2060", BOM: "\ufeff", SHY: "\u00ad" };
  for (const [name, ch] of Object.entries(INVISIBLE)) {
    it.each([[`Clau${ch}de Code`], [`Claude${ch}Code`], [`Claude Co${ch}de`]])(`${name}: %j is caught`, (input) => {
      expect(displayText(input)).toBe("Claude");
      expect(hasToolName(input)).toBe(true);
    });
  }

  it("leaves text without the name alone, invisible characters included", () => {
    expect(displayText("a\u200db")).toBe("a\u200db");
  });
});

// WS-F2c: events are drawn as separate items, which the page reads joined by a line break.
describe("event boundaries", () => {
  // Draw event texts the way the app does; return the text the page would read.
  const read = (texts) => {
    let carry = "";
    const out = [];
    for (const t of texts) {
      const gap = crossesBoundary(carry, t);
      carry = nextCarry(gap ? "" : carry, t);
      if (gap) out.push("…");
      out.push(t);
    }
    return out.join("\n");
  };

  it.each([
    [["Claude", "Code"]],
    [["Claude ", " code"]],
    [["Claude_", "-Code"]],
    [["Claude", "-", "Code"]],
    [["Claude\u200b", "\u200bCode"]],
  ])("%j never reads as the name across items", (texts) => {
    expect(texts.join("\n")).toMatch(/claude[\s_\-. \u200b]*code/i); // the plain join is the problem
    expect(read(texts)).not.toMatch(GATE);
    expect(hasToolName(read(texts))).toBe(false);
  });

  it("adds nothing between events that do not join into the name", () => {
    expect(read(["Claude", "Powered", "Code"])).toBe("Claude\nPowered\nCode");
    expect(crossesBoundary("", "Code")).toBe(false);
  });
});
