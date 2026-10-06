import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHECKS } from "../../src/index.js";
import { run } from "../../src/extra/degrade.js";
import type { BrowserDriver } from "../../src/lib/browser/driver.js";
import { fakeDriver } from "../lib/fake-driver.js";

const FIXTURE = path.resolve(import.meta.dirname, "../fixtures/check-motion/static");
const main = (text: string, hasMain = true) => (script: string) => (script.includes("hasMain") ? { hasMain, text } : true);

/** A fake driver that records the block patterns each page is given and the settle time asked for. */
function spying(evaluate: (script: string) => unknown) {
  const blocked: string[][] = [];
  const settles: unknown[] = [];
  const inner = fakeDriver({ evaluate });
  const driver: BrowserDriver = {
    close: () => inner.close(),
    open: async () => {
      const page = await inner.open();
      return {
        ...page,
        blockUrls: async (p) => void blocked.push(p),
        evaluate: async (script, arg) => {
          if (script.includes("setTimeout")) settles.push(arg);
          return page.evaluate(script, arg);
        },
      };
    },
  };
  return { driver, blocked, settles };
}

describe("check-degrade (fake driver)", () => {
  it("is registered and fails closed without a driver", async () => {
    expect(CHECKS["check-degrade"]).toBe(run);
    const result = await CHECKS["check-degrade"]!(FIXTURE, {});
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.kind)).toEqual(["browser_driver_missing"]);
  });

  it("blocks /api/* and settles 3 s by default; both are options", async () => {
    const first = spying(main("A perfectly useful sentence."));
    await run(FIXTURE, { driver: first.driver });
    expect(first.blocked).toEqual([["/api/*"]]);
    expect(first.settles).toEqual([3000]);
    const second = spying(main("A perfectly useful sentence."));
    await run(FIXTURE, { driver: second.driver, blockPaths: [], settleMs: 50 });
    expect(second.blocked).toEqual([[]]);
    expect(second.settles).toEqual([50]);
  });

  it("passes main text over 15 characters", async () => {
    const result = await run(FIXTURE, { driver: fakeDriver({ evaluate: main("1234567890123456") }) });
    expect(result).toMatchObject({ ok: true, findings: [], summary: { pages: 1 } });
  });

  it.each([
    ["nothing", ""],
    ["exactly 15 characters", "123456789012345"],
    ["a spinner word", "Loading…"],
    ["loading with a long tail", "Loading the latest numbers for you"],
    ["reading with a long tail", "Reading the session log, one moment"],
    ["dots", "..."],
  ])("fails %s as degrade_no_useful_text", async (_name, text) => {
    const result = await run(FIXTURE, { driver: fakeDriver({ evaluate: main(text) }) });
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => [f.kind, f.severity, f.selector])).toEqual([["degrade_no_useful_text", "error", "main"]]);
  });

  it("quotes at most 80 characters of the page text", async () => {
    const result = await run(FIXTURE, { driver: fakeDriver({ evaluate: main("Loading " + "x".repeat(300)) }) });
    const quoted = /"(.*)"/s.exec(result.findings[0]?.message ?? "")?.[1] ?? "";
    expect(quoted.length).toBeLessThanOrEqual(80);
    expect(quoted.length).toBeGreaterThan(10);
  });

  it("reports a page with no <main> as degrade_no_main", async () => {
    const result = await run(FIXTURE, { driver: fakeDriver({ evaluate: main("", false) }) });
    expect(result.findings.map((f) => f.kind)).toEqual(["degrade_no_main"]);
  });

  it("treats a malformed audit as browser_result_invalid", async () => {
    const result = await run(FIXTURE, { driver: fakeDriver({ evaluate: (s) => (s.includes("hasMain") ? { text: 5 } : true) }) });
    expect(result.findings.map((f) => f.kind)).toEqual(["browser_result_invalid"]);
  });
});
