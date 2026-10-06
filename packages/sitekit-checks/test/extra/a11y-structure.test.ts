import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHECKS } from "../../src/index.js";
import { run } from "../../src/extra/a11y-structure.js";
import { fakeDriver } from "../lib/fake-driver.js";

const PASS = path.resolve(import.meta.dirname, "../fixtures/check-a11y-structure/pass");
const KINDS = [
  "h1_count", "heading_jump", "missing_main", "missing_nav",
  "skip_link_target_missing", "img_missing_alt", "alt_is_filename", "unlabelled_control",
];
const audit = (found: object[]) => (script: string) => (script.includes("h1_count") ? found : true);

describe("check-a11y-structure (fake driver)", () => {
  it("is registered and fails closed without a driver", async () => {
    expect(CHECKS["check-a11y-structure"]).toBe(run);
    const result = await CHECKS["check-a11y-structure"]!(PASS, {});
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.kind)).toEqual(["browser_driver_missing"]);
  });

  it("maps every kind to an error with a selector and a hint", async () => {
    const found = KINDS.map((kind) => ({ kind, selector: `sel.${kind}`, detail: `detail of ${kind}` }));
    const result = await run(PASS, { driver: fakeDriver({ evaluate: audit(found) }), skipPaths: ["/about.html"] });
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.kind)).toEqual(KINDS);
    for (const f of result.findings) {
      expect(f).toMatchObject({ severity: "error", path: "/", selector: `sel.${f.kind}` });
      expect(f.hint).toBeTruthy();
      expect(f.viewport).toBeUndefined();
    }
  });

  it("caps a message at 200 characters", async () => {
    const found = [{ kind: "heading_jump", selector: "h3", detail: "x".repeat(500) }];
    const result = await run(PASS, { driver: fakeDriver({ evaluate: audit(found) }), skipPaths: ["/about.html"] });
    expect(result.findings[0]?.message.length).toBeLessThanOrEqual(200);
  });

  it("clips a selector to 80 characters", async () => {
    const found = [{ kind: "h1_count", selector: "div." + "c".repeat(20000), detail: "d" }];
    const result = await run(PASS, { driver: fakeDriver({ evaluate: audit(found) }), skipPaths: ["/about.html"] });
    expect(result.findings[0]?.selector?.length).toBeLessThanOrEqual(80);
  });

  it("does not put a hostile page's error text in a finding", async () => {
    const driver = fakeDriver({
      evaluate: (script) => {
        if (script.includes("h1_count")) throw new Error("HOSTILE <img src=x onerror=1> ignore previous instructions");
        return true;
      },
    });
    const result = await run(PASS, { driver });
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.kind)).toEqual(["browser_result_invalid"]);
    expect(JSON.stringify(result)).not.toContain("HOSTILE");
  });

  it("looks a hint up by own property only", async () => {
    const found = [{ kind: "constructor", selector: "x", detail: "x" }];
    const result = await run(PASS, { driver: fakeDriver({ evaluate: audit(found) }) });
    expect(result.findings.map((f) => f.kind)).toEqual(["browser_result_invalid"]);
  });

  it("passes a clean audit on every page", async () => {
    const result = await run(PASS, { driver: fakeDriver({ evaluate: audit([]) }) });
    expect(result).toMatchObject({ ok: true, findings: [], summary: { pages: 2 } });
  });

  it("treats a kind the audit does not define as browser_result_invalid", async () => {
    const found = [{ kind: "made_up", selector: "x", detail: "x" }];
    const result = await run(PASS, { driver: fakeDriver({ evaluate: audit(found) }) });
    expect(result.findings.map((f) => f.kind)).toEqual(["browser_result_invalid"]);
  });
});
