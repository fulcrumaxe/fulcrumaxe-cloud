import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { run as a11yStructure } from "../../src/extra/a11y-structure.js";
import { run as render } from "../../src/extra/render.js";
import type { BrowserDriver } from "../../src/lib/browser/driver.js";
import type { CheckResult } from "../../src/types.js";
import { createPlaywrightDriver } from "./playwright-driver.js";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures");
type Check = (dir: string, options: { driver: BrowserDriver }) => Promise<CheckResult>;

const inBrowser = (check: Check, dir: string): Promise<CheckResult> => check(dir, { driver: createPlaywrightDriver() });
const kinds = (r: CheckResult): string[] => [...new Set(r.findings.map((f) => f.kind))];

async function failFixtures(check: string): Promise<string[]> {
  return (await fs.readdir(path.join(FIXTURES, check, "fail"))).sort();
}

describe("check-render in real Chromium", () => {
  it("passes the pass fixture and counts pages x 2 renders", async () => {
    const result = await inBrowser(render, path.join(FIXTURES, "check-render/pass"));
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({ pages: 2, renders: 4 });
  });

  it("each fail fixture yields exactly its own kind, with viewport and selector", async () => {
    const names = await failFixtures("check-render");
    expect(names).toEqual(["contrast", "nav_label_wrapped", "overflow", "unpainted"]);
    for (const name of names) {
      const result = await inBrowser(render, path.join(FIXTURES, "check-render/fail", name));
      expect(result.ok, name).toBe(false);
      expect(kinds(result), name).toEqual([name]);
      for (const f of result.findings) {
        expect(f.viewport, name).toBeGreaterThan(0);
        expect(f.hint, name).toBeTruthy();
        if (name !== "unpainted") expect(f.selector, name).toBeTruthy();
      }
    }
  });

  it("applies a theme value as an attribute on <html>", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fx-theme-"));
    try {
      const css = "html{background:#fff}p{color:#111}html[data-theme=dark] p{color:#ccc}";
      const page = `<!doctype html><html lang="en"><head><style>${css}</style></head><body><main><p>Text</p></main></body></html>`;
      await fs.writeFile(path.join(dir, "index.html"), page);
      const themes = [{ attr: "data-theme", values: ["light", "dark"] }];
      const result = await render(dir, { driver: createPlaywrightDriver(), viewports: [1280], themes });
      expect(result.summary?.renders).toBe(2);
      expect(result.findings.map((f) => [f.kind, f.message.includes("data-theme=dark")])).toEqual([["contrast", true]]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a page the server refuses as page_load_failed", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fx-load-"));
    try {
      // A back-slash in a file name is a page on disk that the server will not serve (404).
      await fs.writeFile(path.join(dir, "bad\\name.html"), "<!doctype html><title>x</title>");
      const result = await inBrowser(render, dir);
      expect(result.ok).toBe(false);
      expect(kinds(result)).toEqual(["page_load_failed"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a driver with no fixed origin", () => {
  it("aborts a first goto to a non-loopback URL and counts it", async () => {
    const driver = createPlaywrightDriver();
    try {
      const page = await driver.open();
      await expect(page.goto("http://example.invalid/")).rejects.toThrow();
      expect(page.blockedRequests()).toBeGreaterThan(0);
    } finally {
      await driver.close();
    }
  });
});

describe("check-a11y-structure in real Chromium", () => {
  it("passes a multi-page fixture with main, nav, a working skip link and one h1", async () => {
    const result = await inBrowser(a11yStructure, path.join(FIXTURES, "check-a11y-structure/pass"));
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.summary?.pages).toBe(2);
  });

  it("each fail fixture yields exactly its own kind, with a selector and a hint", async () => {
    const names = await failFixtures("check-a11y-structure");
    expect(names).toHaveLength(8);
    for (const name of names) {
      const result = await inBrowser(a11yStructure, path.join(FIXTURES, "check-a11y-structure/fail", name));
      expect(result.ok, name).toBe(false);
      expect(kinds(result), name).toEqual([name]);
      for (const f of result.findings) {
        expect(f.selector, name).toBeTruthy();
        expect(f.hint, name).toBeTruthy();
        expect(f.message.length, name).toBeLessThanOrEqual(200);
      }
    }
  });
});
