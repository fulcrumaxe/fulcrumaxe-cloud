import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHECKS } from "../../src/index.js";
import { run } from "../../src/extra/motion.js";
import type { BrowserDriver } from "../../src/lib/browser/driver.js";
import { fakeDriver } from "../lib/fake-driver.js";

const STATIC = path.resolve(import.meta.dirname, "../fixtures/check-motion/static");
const audit = (result: unknown) => (script: string) => (script.includes("animationName") ? result : true);

/** A fake driver that records the media emulation each page is given. */
function spying(evaluate: (script: string) => unknown) {
  const media: object[] = [];
  const inner = fakeDriver({ evaluate });
  const driver: BrowserDriver = {
    close: () => inner.close(),
    open: async () => ({ ...(await inner.open()), emulateMedia: async (m) => void media.push(m) }),
  };
  return { driver, media };
}

describe("check-motion (fake driver)", () => {
  it("is registered and fails closed without a driver", async () => {
    expect(CHECKS["check-motion"]).toBe(run);
    const result = await CHECKS["check-motion"]!(STATIC, {});
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.kind)).toEqual(["browser_driver_missing"]);
  });

  it("asks for reduced motion and maps each animated element to motion_not_reduced", async () => {
    const items = [{ selector: "div.spin", what: "animation" }, { selector: "a.btn", what: "transition" }];
    const { driver, media } = spying(audit({ total: 2, items }));
    const result = await run(STATIC, { driver });
    expect(media).toEqual([{ reducedMotion: "reduce" }]);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => [f.kind, f.severity, f.selector, f.path])).toEqual([
      ["motion_not_reduced", "error", "div.spin", "/"],
      ["motion_not_reduced", "error", "a.btn", "/"],
    ]);
    expect(result.findings[1]?.message).toContain("transition");
    expect(result.findings.every((f) => f.hint)).toBe(true);
  });

  it("counts the findings past the page cap in the summary", async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ selector: `p.n${i}`, what: "transition" }));
    const result = await run(STATIC, { driver: fakeDriver({ evaluate: audit({ total: 27, items }) }) });
    expect(result.findings).toHaveLength(20);
    expect(result.summary).toMatchObject({ pages: 1, not_reported: 7 });
  });

  it("passes a page with no motion as a real pass", async () => {
    const result = await run(STATIC, { driver: fakeDriver({ evaluate: audit({ total: 0, items: [] }) }) });
    expect(result).toMatchObject({ ok: true, findings: [], summary: { pages: 1, not_reported: 0 } });
  });

  it("skips the pages in skipPaths", async () => {
    const result = await run(STATIC, { driver: fakeDriver(), skipPaths: ["/index.html", "/"] });
    expect(result.findings.map((f) => f.kind)).toEqual(["not_applicable"]);
  });

  it("keeps the page's own text out of every message, and reports at most 20 of a long list", async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ selector: `p.n${i}`, what: "transition" }));
    const result = await run(STATIC, { driver: fakeDriver({ evaluate: audit({ total: 45, items }) }) });
    expect(result.findings).toHaveLength(20);
    expect(new Set(result.findings.map((f) => f.message))).toEqual(new Set(["a transition still runs with reduced motion requested"]));
    expect(result.summary).toMatchObject({ not_reported: 25 });
  });

  it("clips a long selector to 80 characters", async () => {
    const items = [{ selector: "x".repeat(500), what: "animation" }];
    const result = await run(STATIC, { driver: fakeDriver({ evaluate: audit({ total: 1, items }) }) });
    expect(result.findings[0]?.selector?.length).toBeLessThanOrEqual(80);
  });

  it("gives a forged kind or a page that returns hundreds of items one fixed finding", async () => {
    const injected = "PAGE-CONTROLLED TEXT [click](https://evil.example)";
    const hostile = [
      { total: 1, items: [{ selector: "div", what: injected }] },
      { total: 501, items: Array.from({ length: 501 }, () => ({ selector: "div", what: "animation" })) },
      { total: 1, items: [{ selector: 7, what: "animation" }] },
      { total: 1, items: [{ what: "animation" }] },
      { total: 1, items: [Object.create({ selector: "div", what: "animation" })] },
      { total: 1, items: [{ selector: "div", what: "animation" }, { selector: "div", what: "animation" }] },
      { total: 1.5, items: [] },
      { total: -1, items: [] },
      Object.create({ total: 0, items: [] }),
    ];
    for (const bad of hostile) {
      const result = await run(STATIC, { driver: fakeDriver({ evaluate: audit(bad) }) });
      expect(result.findings.map((f) => f.kind)).toEqual(["browser_result_invalid"]);
      expect(JSON.stringify(result)).not.toContain("evil.example");
    }
  });

  it("treats a malformed audit as browser_result_invalid", async () => {
    for (const bad of [{ total: "many", items: [] }, { total: 1, items: "x" }, null]) {
      const result = await run(STATIC, { driver: fakeDriver({ evaluate: audit(bad) }) });
      expect(result.findings.map((f) => f.kind)).toEqual(["browser_result_invalid"]);
    }
  });
});
