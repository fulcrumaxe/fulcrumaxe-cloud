import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bundleRunner } from "../../scripts/build-sea.mjs";
import { loadPlaywright, playwrightAvailable, setPlaywrightLoader, sidecarFor } from "../../src/verifyBrowser/loadPlaywright.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

/** D#749 V2c-2b: the Playwright library stays OUT of the single executable and is found in a sidecar folder next to it. */
const root = mkdtempSync(path.join(tmpRoot(), "pw-sidecar-"));
afterAll(() => {
  setPlaywrightLoader(undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("the release bundle", () => {
  it("still passes the single-file rules with the verify browser in it, and carries none of the library", async () => {
    const text = await bundleRunner(1780000000);
    expect(text).toContain('"load.cjs"');
    expect(text).not.toMatch(/\bimport\s*\(/);
    expect(text).not.toMatch(/chromium-bidi|playwright-core\/lib/);
    expect(text).toContain("verify-browser-server");
  }, 60_000);
});

describe("the sidecar and the loader", () => {
  it("the sidecar is the folder fx-runner-playwright next to the binary", () => {
    expect(sidecarFor(path.join(root, "bin", "fx-runner"))).toBe(path.join(root, "bin", "fx-runner-playwright"));
  });

  it("a program with no loader has no library: not available, and loading says playwright_missing", async () => {
    setPlaywrightLoader(undefined);
    expect(playwrightAvailable()).toBe(false);
    await expect(loadPlaywright()).rejects.toThrow("playwright_missing");
  });

  it("the capability follows the installed loader's lookup", async () => {
    let there = false;
    setPlaywrightLoader({ available: () => there, load: async () => ({}) as never });
    expect(playwrightAvailable()).toBe(false);
    there = true;
    expect(playwrightAvailable()).toBe(true);
    await expect(loadPlaywright()).resolves.toEqual({});
  });
});
