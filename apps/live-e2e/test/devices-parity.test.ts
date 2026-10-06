import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// The parity check imports the workspace's own config: that file is the thing the live projects must match.
import workspaceConfig from "../../workspace/playwright.config.js";
import { buildConfig, deviceProjects } from "../pw/config.js";
import { TARGET_ENV_NAME } from "../src/limits.js";
import { diffProjects, playwrightPin } from "../src/parity.js";
import { PACKAGE_ROOT, TARGET_ENV } from "./helpers.js";

const live = () => buildConfig({ ...TARGET_ENV, [TARGET_ENV_NAME]: "staging" }, PACKAGE_ROOT).projects ?? [];
const workspace = () => workspaceConfig.projects ?? [];
const readPkg = (dir: string) => JSON.parse(readFileSync(join(PACKAGE_ROOT, "..", dir, "package.json"), "utf8")) as Parameters<typeof playwrightPin>[0];

describe("device parity with apps/workspace/playwright.config.ts", () => {
  it("the live projects have the workspace's names and `use`", () => {
    expect(workspace().map((p) => p.name)).toEqual(["desktop", "phone", "tablet"]);
    expect(diffProjects(live(), workspace())).toEqual([]);
  });

  it("fails when one viewport differs (mutation, then restored)", () => {
    const mutated = deviceProjects();
    const tablet = mutated.find((p) => p.name === "tablet");
    expect(tablet?.use?.viewport).toEqual({ width: 1024, height: 768 });
    if (tablet) tablet.use = { ...tablet.use, viewport: { width: 1023, height: 768 } };
    expect(diffProjects(mutated, workspace())).toEqual([`project "tablet": "use" differs`]);
    // Restored: a fresh build agrees again.
    expect(diffProjects(deviceProjects(), workspace())).toEqual([]);
  });

  it("fails when a project is renamed or missing", () => {
    const renamed = deviceProjects().map((p) => (p.name === "phone" ? { ...p, name: "mobile" } : p));
    expect(diffProjects(renamed, workspace())[0]).toContain("project names differ");
    expect(diffProjects(deviceProjects().slice(0, 2), workspace())[0]).toContain("project names differ");
  });

  it("pins the same @playwright/test version as the workspace", () => {
    const livePin = playwrightPin(readPkg("live-e2e"));
    expect(livePin).toBeDefined();
    expect(livePin).toBe(playwrightPin(readPkg("workspace")));
    // A one-patch mutation of the pin is a difference the comparison would report.
    expect(`${livePin}.1`).not.toBe(playwrightPin(readPkg("workspace")));
  });
});

describe("no live-e2e file imports from the workspace's e2e folder", () => {
  const FORBIDDEN = new RegExp(`(?:from|import\\s*\\(|require\\s*\\()\\s*["'][^"']*${["workspace", "e2e"].join("/")}`);
  const SKIP = new Set(["node_modules", "test-results"]);

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      if (SKIP.has(name)) return [];
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sources(full);
      return /\.(?:ts|mjs|js)$/.test(name) ? [full] : [];
    });
  }

  it("scans the whole package and finds none", () => {
    const files = sources(PACKAGE_ROOT);
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter((f) => FORBIDDEN.test(readFileSync(f, "utf8")))).toEqual([]);
  });

  it("the pattern does catch an import, a dynamic import and a require", () => {
    const p = ["workspace", "e2e"].join("/");
    for (const line of [`import x from "../../${p}/helpers/boot";`, `await import("../${p}/x")`, `require('../${p}/x')`]) {
      expect(FORBIDDEN.test(line), line).toBe(true);
    }
  });
});
